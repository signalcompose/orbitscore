//! offline 決定論サンドボックスドライバ + A/B parity primitive。
//!
//! γ M1 の検証は 3 分割される(設計 doc §5)。本モジュールはそのうち **(a) audio 正しさ** を担う:
//! cpal を介さず、共有メモリ越しに block を **同期**(submit → spin 待ち → read)で流して child の
//! 出力を集める。同期なので stale は発生しない(repeat-previous の検証は host.rs の mock-child
//! 状態機械 unit test が担当 = (b))。この offline 経路は audio device 不要で **CI 実行可**であり、
//! in-process 参照との **A/B parity** を sample-exact で突き合わせられる。

#![allow(unsafe_code)]

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};
use std::time::{Duration, Instant};

use crate::child::SandboxChildGuard;
use crate::transport::{
    create_shared, region_ptr, slot_index, slot_offset, BUF_LEN, CHANNELS, CONTROL_RUN,
};

/// 1 block の child 完了を待つ上限(これを超えたら child 死亡とみなしエラー)。
const BLOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// 同一プロセス内で複数 driver を回した時に共有メモリファイル名が衝突しないための連番。
static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_shm_path() -> PathBuf {
    let seq = SHM_SEQ.fetch_add(1, Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("orbit-sandbox-{pid}-{seq}.shm"))
}

/// `input`(interleaved stereo f32)を、隔離 child プロセス越しに `block_frames` 単位で **同期**処理し、
/// 集めた出力を返す。`child_exe` は [`sandbox-effect-child`] 相当の実行ファイル、`child_args` はその
/// 追加引数(例: gain child なら `&["--gain", "0.5"]`・PR-B の CLAP child なら `&["--plugin", ...]`)。
/// `--shm <path>` はドライバが自動で付与する。
///
/// 同期 1-outstanding(各 block で `seq_done >= seq` を待ってから次へ)なので stale は起きない。
/// child が `BLOCK_TIMEOUT` 内に応答しなければ(= 死亡)エラーを返す。
pub fn render_through_child_sync(
    child_exe: &Path,
    input: &[f32],
    block_frames: usize,
    child_args: &[&str],
) -> io::Result<Vec<f32>> {
    assert!(block_frames >= 1 && block_frames * CHANNELS <= BUF_LEN);
    let shm_path = unique_shm_path();
    let mmap = create_shared(&shm_path)?;
    let region = region_ptr(&mmap);
    // SAFETY: region の backing は本関数 scope の `mmap`(create_shared が返す生存 mapping)が生かす。
    // truncate 直後で全 atomic は 0 だが、RUN 状態を明示するため CONTROL_RUN を store する。
    unsafe {
        (*region).control.store(CONTROL_RUN, Release);
    }

    let child = Command::new(child_exe)
        .arg("--shm")
        .arg(&shm_path)
        .args(child_args)
        .spawn()?;
    let guard = SandboxChildGuard::new(child, region, shm_path);

    let block_len = block_frames * CHANNELS;
    let mut out = Vec::with_capacity(input.len());
    let mut seq: u64 = 0;
    for chunk in input.chunks(block_len) {
        seq += 1;
        let n_frames = chunk.len() / CHANNELS;
        let count = n_frames * CHANNELS;
        let off = slot_offset(seq);
        // SAFETY: region の backing は本関数 scope の `mmap`(create_shared が返す)が生かす(guard は
        // 制御専用で mapping を生かす責務は負わない)。同期 1-outstanding なので各 seq の slot は時間的に排他。
        unsafe {
            let in_base = std::ptr::addr_of_mut!((*region).input) as *mut f32;
            std::ptr::copy_nonoverlapping(chunk.as_ptr(), in_base.add(off), count);
            (*region).n_frames[slot_index(seq)].store(n_frames as u32, Relaxed);
            (*region).seq_request.store(seq, Release);
        }
        // child 完了を待つ(bounded・offline は非 RT なので spin でなく yield で CPU を譲る)。
        let deadline = Instant::now() + BLOCK_TIMEOUT;
        loop {
            if unsafe { (*region).seq_done.load(Acquire) } >= seq {
                break;
            }
            if Instant::now() >= deadline {
                // TODO(PR-C): child の crash(死亡)と単なる処理遅延の区別(ExitStatus 診断)は
                // supervisor 層で行う。offline は timeout を一様に Err として扱う。
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "sandbox child が block を時間内に処理しなかった(死亡の可能性)",
                ));
            }
            std::thread::yield_now();
        }
        // 出力を回収。
        // SAFETY: region の backing は本関数 scope の `mmap` が生かす。seq_done の Acquire が child の
        // output 書き込みを可視化する(同期 1-outstanding なので seq_done==seq は slot(seq) を意味する)。
        unsafe {
            let out_base = std::ptr::addr_of!((*region).output) as *const f32;
            let src = out_base.add(off);
            out.extend_from_slice(std::slice::from_raw_parts(src, count));
        }
    }
    drop(guard);
    Ok(out)
}

/// 2 つのバッファの要素ごと最大絶対差。長さが違えば `f32::INFINITY`。
pub fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return f32::INFINITY;
    }
    a.iter()
        .zip(b.iter())
        .fold(0.0f32, |m, (&x, &y)| m.max((x - y).abs()))
}

/// in-process で `gain` を掛けた参照(A/B parity の side A)。
pub fn render_in_process_gain(input: &[f32], gain: f32) -> Vec<f32> {
    input.iter().map(|&x| x * gain).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_abs_diff_basic() {
        assert_eq!(max_abs_diff(&[0.0, 1.0], &[0.0, 1.0]), 0.0);
        assert!((max_abs_diff(&[0.0, 1.0], &[0.0, 0.5]) - 0.5).abs() < 1e-9);
        assert_eq!(max_abs_diff(&[1.0], &[1.0, 2.0]), f32::INFINITY);
    }

    #[test]
    fn in_process_gain_is_exact_multiply() {
        let out = render_in_process_gain(&[2.0, -4.0, 0.5], 0.5);
        assert_eq!(out, vec![1.0, -2.0, 0.25]);
    }
}
