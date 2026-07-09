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

/// 1 block の child 完了を待つ既定上限(これを超えたら child 死亡とみなしエラー)。
const BLOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// [`render_through_child_sync_with_options`] のタイムアウト設定。
///
/// **初回ブロックは plugin の load を含む**(child は shm を map 後・spin loop 前に plugin を
/// load する)。重い商用プラグイン(サンプラ・認証チェックする effect)は load が数秒かかりうるので、
/// 初回だけ長い deadline を許して「crash でないのに TimedOut で false-fail」を避ける。
#[derive(Clone, Copy, Debug)]
pub struct RenderOptions {
    /// 最初のブロック(= plugin load を含む)の完了待ち上限。
    pub first_block_timeout: Duration,
    /// 2 ブロック目以降の完了待ち上限。
    pub block_timeout: Duration,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            first_block_timeout: BLOCK_TIMEOUT,
            block_timeout: BLOCK_TIMEOUT,
        }
    }
}

/// child が回収した処理統計([`render_through_child_sync_with_options`] が返す)。
///
/// `process_errors == 0` かつ `processed == 期待ブロック数` を突き合わせることで、child が
/// `process()` 失敗時に dry 素通しするだけ(出力=入力で有限値になり従来の出力検査を誤 PASS させる)
/// のを検出できる。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChildStats {
    /// child が `process()` を通したブロック総数(成功・失敗いずれもカウント)。
    pub processed: u64,
    /// うち `process()` が非 OK を返し dry 素通しになったブロック数。
    pub process_errors: u64,
}

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
    let (out, _stats) = render_through_child_sync_with_options(
        child_exe,
        input,
        block_frames,
        child_args,
        RenderOptions::default(),
    )?;
    Ok(out)
}

/// [`render_through_child_sync`] の変種で、per-block timeout を可変にし child の処理統計
/// ([`ChildStats`])も返す。gated 実機検証で「重い商用プラグインの load が既定 5s を超えて false-fail」
/// と「`process()` 失敗の dry 素通しによる誤 PASS」の両方を扱うために使う。既定 `opts` では
/// [`render_through_child_sync`] と挙動が一致する(初回・以降とも 5s)。
pub fn render_through_child_sync_with_options(
    child_exe: &Path,
    input: &[f32],
    block_frames: usize,
    child_args: &[&str],
    opts: RenderOptions,
) -> io::Result<(Vec<f32>, ChildStats)> {
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
        // 初回ブロックは plugin load を含むため first_block_timeout を使う。
        let timeout = if seq == 1 {
            opts.first_block_timeout
        } else {
            opts.block_timeout
        };
        let deadline = Instant::now() + timeout;
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
    // 統計を回収してから teardown する。
    // happens-before: child は `child_processed` / `child_process_error_count` の fetch_add を
    // `seq_done.store(Release)` より前に行う(main.rs)。上のループは最終ブロックの
    // `seq_done.load(Acquire)` を観測して抜けるので、その Acquire がこれら counter の全 increment を
    // 可視化する。ゆえにここでの Relaxed load は最終ブロックまでの確定値を読む。CONTROL_QUIT を送る
    // `drop(guard)` の **前** に読むこと(QUIT 後は child が終了へ向かい観測が競合しうる)。
    let stats = unsafe {
        ChildStats {
            processed: (*region).child_processed.load(Relaxed),
            process_errors: (*region).child_process_error_count.load(Relaxed),
        }
    };
    drop(guard);
    Ok((out, stats))
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
