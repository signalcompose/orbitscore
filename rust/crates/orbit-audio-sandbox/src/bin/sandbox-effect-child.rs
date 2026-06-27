//! sandbox-effect-child — γ M1(PR-A)の gain effect child。
//!
//! host(daemon)が起動する隔離プロセス。共有メモリ([`orbit_audio_sandbox::SharedRegion`])を map し、
//! input block を読んで gain を掛け output へ書き、`seq_done` を進める。**clack 非依存**(実 CLAP
//! effect を自プロセスで host する child は PR-B の別 crate)。本 child は transport + supervision を
//! end-to-end に検証するための parity 相手であり、gain は effect plugin の load-time param の stand-in。
//!
//! 起動引数: `--shm <path>`(host が作成済みの共有メモリファイル) `--gain <f32>`(既定 1.0)。
//! 正常終了: host が `control` に [`orbit_audio_sandbox::CONTROL_QUIT`] を store する。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, CHANNELS, CONTROL_QUIT, MAX_FRAMES,
};

struct Args {
    shm: PathBuf,
    gain: f32,
}

fn parse_args() -> Result<Args> {
    let mut shm: Option<PathBuf> = None;
    let mut gain: f32 = 1.0;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--shm" => shm = Some(PathBuf::from(it.next().context("--shm に値が必要")?)),
            "--gain" => {
                gain = it
                    .next()
                    .context("--gain に値が必要")?
                    .parse()
                    .context("--gain の parse")?
            }
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        gain,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);
    let gain = args.gain;

    let mut last: u64 = 0;
    loop {
        // host からの正常終了要求。control は audio data の順序づけに関与しない一回限りの flag
        // なので Relaxed で十分(可視性の遅れは spin が 1 周多く回るだけ・audio 順序は
        // seq_request/seq_done の Acquire/Release が担う)。
        // SAFETY: region は host が REGION_BYTES に truncate 済みの共有ファイルを指す。
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        let cur = unsafe { (*region).seq_request.load(Acquire) };
        if cur > last {
            // SAFETY: seq_request の Acquire が host の input/n_frames[slot] 書き込みを可視化する。
            // slot 不変条件(host が seq-SLOTS 完了を待って submit)で当該 slot は時間的に排他。
            unsafe {
                let n =
                    ((*region).n_frames[slot_index(cur)].load(Relaxed) as usize).min(MAX_FRAMES);
                let count = n * CHANNELS;
                let off = slot_offset(cur);
                let in_base = std::ptr::addr_of!((*region).input) as *const f32;
                let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                for i in 0..count {
                    *out_base.add(off + i) = *in_base.add(off + i) * gain;
                }
                (*region).child_processed.fetch_add(1, Relaxed);
                // この slot の出力を publish(host READ の seq_tag[slot]==target Acquire と synchronize-with)。
                (*region).seq_tag[slot_index(cur)].store(cur, Release);
                // submit guard 用の最新処理 seq(host SUBMIT の Acquire と synchronize-with)。
                (*region).seq_done.store(cur, Release);
            }
            last = cur;
        } else {
            std::hint::spin_loop();
        }
    }
    Ok(())
}
