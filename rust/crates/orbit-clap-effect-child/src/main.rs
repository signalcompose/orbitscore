//! orbit-clap-effect-child — γ M1 (PR-B) の実 CLAP effect child プロセス。
//!
//! host（daemon / offline driver）が起動する隔離プロセス。共有メモリ
//! ([`orbit_audio_sandbox::SharedRegion`]) を map し、input block を [`ClapEffectProcessor`] で加工して
//! output へ書き、`seq_done` / `seq_tag` を進める。PR-A の gain child（`sandbox-effect-child`）の
//! gain 乗算を **実 CLAP plugin の 1-block process** に差し替えたもの。
//!
//! transport protocol は gain child と同一（per-slot `seq_tag` で fresh 判定・`seq_done` は submit guard）。
//! 差分は処理部のみ: input slot → scratch にコピー → `process_block`（in-place effect）→ output slot。
//! scratch を介すのは、`process_block` が `data` を入力読み取り→出力上書きの両方に使う（in-place）ため、
//! 共有メモリの input/output 別領域を跨ぐ橋渡しが要るから。scratch はループ前に確保し RT 安全を保つ。
//!
//! 起動引数:
//!   --shm <path>          host が作成済みの共有メモリファイル（必須）
//!   --plugin <path>       .clap バンドルのパス（必須）
//!   --plugin-id <id>      CLAP plugin id（省略時は単一プラグインの場合のみ OK）
//!   --sample-rate <u32>   サンプリングレート（既定 48000）
//!
//! 正常終了: host が `control` に [`orbit_audio_sandbox::CONTROL_QUIT`] を store する。

#![allow(unsafe_code)]

use std::path::PathBuf;
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

use anyhow::{bail, Context, Result};
use orbit_audio_sandbox::{
    open_shared, region_ptr, slot_index, slot_offset, BUF_LEN, CHANNELS, CONTROL_QUIT, MAX_FRAMES,
};
use orbit_clap_host::ClapEffectProcessor;

struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
}

fn parse_args() -> Result<Args> {
    let mut shm: Option<PathBuf> = None;
    let mut plugin: Option<PathBuf> = None;
    let mut plugin_id: Option<String> = None;
    let mut sample_rate: u32 = 48_000;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--shm" => shm = Some(PathBuf::from(it.next().context("--shm に値が必要")?)),
            "--plugin" => plugin = Some(PathBuf::from(it.next().context("--plugin に値が必要")?)),
            "--plugin-id" => plugin_id = Some(it.next().context("--plugin-id に値が必要")?),
            "--sample-rate" => {
                sample_rate = it
                    .next()
                    .context("--sample-rate に値が必要")?
                    .parse()
                    .context("--sample-rate の parse")?
            }
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        plugin: plugin.context("--plugin は必須")?,
        plugin_id,
        sample_rate,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);

    // 実 CLAP effect を 1 スレッドで host（load → 以降 process_block / drop も同一スレッド）。
    let (mut effect, _info) = ClapEffectProcessor::load(
        &args.plugin,
        args.plugin_id.as_deref(),
        args.sample_rate,
        CHANNELS,
        MAX_FRAMES as u32,
    )
    .with_context(|| format!("load CLAP effect {:?}", args.plugin))?;

    // in-place process_block 用の作業バッファ（ループ前に確保 = RT 安全）。
    let mut scratch = vec![0.0f32; BUF_LEN];

    // plugin.process() が失敗したブロック数（ループ外で報告するため累積する単純カウント）。
    // PR-B では child→host の health signal は SharedRegion に持たせない（PR-A の frozen transport を
    // 触らない）。child の health 可観測性は PR-C で §4.5 の supervision signal 群と一緒に設計する。
    // それまでは終了時に stderr へ集計を出すことで silent-failure を回避する（loop 内では出力しない）。
    let mut process_errors: u64 = 0;

    let mut last: u64 = 0;
    loop {
        // host からの正常終了要求。一回限りの flag なので Relaxed で十分（PR-A gain child と同様）。
        // SAFETY: region は host が REGION_BYTES に truncate 済みの共有ファイルを指す（map 後不変）。
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        // SAFETY: 同上（region は有効）。seq_request の Acquire は host SUBMIT の Release と
        // synchronize-with し、続く input/n_frames[slot] 読み出しの可視性を確立する。
        let cur = unsafe { (*region).seq_request.load(Acquire) };
        if cur > last {
            // slot index / offset は当該 seq で不変なのでループ本体先頭で 1 回だけ算出する。
            let idx = slot_index(cur);
            let off = slot_offset(cur);
            // SAFETY: seq_request の Acquire が host の input/n_frames[slot] 書き込みを可視化する。
            // slot 不変条件（host が seq-SLOTS 完了を待って submit）で当該 slot は時間的に排他。
            let count = unsafe {
                let n = ((*region).n_frames[idx].load(Relaxed) as usize).min(MAX_FRAMES);
                let count = n * CHANNELS;
                let in_base = std::ptr::addr_of!((*region).input) as *const f32;
                std::ptr::copy_nonoverlapping(in_base.add(off), scratch.as_mut_ptr(), count);
                count
            };

            // 実 CLAP effect で 1 block を in-place 加工（共有メモリ外の scratch 上で）。
            // 失敗時 process_block は scratch を dry のまま素通しする。ここでは集計のみ（終了時に報告）。
            if !effect.process_block(&mut scratch[..count]) {
                process_errors += 1;
            }

            // SAFETY: 上と同じ slot 排他。scratch（加工済み出力）を output slot へ書き戻す。
            unsafe {
                let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                std::ptr::copy_nonoverlapping(scratch.as_ptr(), out_base.add(off), count);
                (*region).child_processed.fetch_add(1, Relaxed);
                // この slot の出力を publish（host READ の seq_tag[slot]==target Acquire と synchronize-with）。
                (*region).seq_tag[idx].store(cur, Release);
                // submit guard 用の最新処理 seq（host SUBMIT の Acquire と synchronize-with）。
                (*region).seq_done.store(cur, Release);
            }
            last = cur;
        } else {
            std::hint::spin_loop();
        }
    }
    if process_errors > 0 {
        eprintln!(
            "[orbit-clap-effect-child] plugin.process() が {process_errors} ブロックで失敗 \
             （該当ブロックは dry 素通し）"
        );
    }
    Ok(())
}
