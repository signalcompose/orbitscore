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
    open_shared, region_ptr, save_state_command, service_command_mailbox, slot_index, slot_offset,
    ParentWatch, BUF_LEN, CHANNELS, CMD_CLOSE_UI, CMD_OPEN_UI, CMD_SAVE_STATE, CONTROL_QUIT,
    MAX_FRAMES,
};
use orbit_child_runtime::{child_should_quit, run_child, UiCallbacks, UiService};
use orbit_clap_host::ClapEffectProcessor;

struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
    state: Option<PathBuf>,
}

fn parse_args() -> Result<Args> {
    let mut shm: Option<PathBuf> = None;
    let mut plugin: Option<PathBuf> = None;
    let mut plugin_id: Option<String> = None;
    let mut sample_rate: u32 = 48_000;
    let mut state = None;
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
            "--state" => state = Some(PathBuf::from(it.next().context("--state に値が必要")?)),
            other => bail!("未知の引数: {other}"),
        }
    }
    Ok(Args {
        shm: shm.context("--shm は必須")?,
        plugin: plugin.context("--plugin は必須")?,
        plugin_id,
        sample_rate,
        state,
    })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);

    // 実 CLAP effect を 1 スレッドで host（load → 以降 process_block / drop も同一スレッド）。
    let state_bytes = match args.state.as_deref() {
        Some(path) => Some(std::fs::read(path).with_context(|| format!("read state {path:?}"))?),
        None => None,
    };
    let (effect, _info) = ClapEffectProcessor::load(
        &args.plugin,
        args.plugin_id.as_deref(),
        args.sample_rate,
        CHANNELS,
        MAX_FRAMES as u32,
        state_bytes.as_deref(),
    )
    .with_context(|| format!("load CLAP effect {:?}", args.plugin))?;

    // SAFETY: region は host が REGION_BYTES に truncate 済みの共有ファイルを指す。
    unsafe {
        orbit_audio_sandbox::transport::publish_child_ready(region, effect.has_audio_input());
    }
    let (mut effect_audio, effect_main) = effect.split();
    let (ui, main) = UiService::new(region, effect_main, |main| UiCallbacks {
        closed: main.take_closed(),
        requested_size: main.take_requested_size(),
    });

    // orphan 対策（#448）: host（daemon）が CONTROL_QUIT を書かずに死ぬ経路（プロセス exit・
    // SIGKILL・crash）でも main runloop を止められるよう、親死活をタイマーで監視する。
    let parent_watch = ParentWatch::new();
    let region_addr = region as usize;
    let process_errors = run_child(
        "orbit-clap-effect-child",
        || unsafe { child_should_quit(region, &parent_watch) },
        || {
            // Mailbox servicing is main-thread-only after #474 P1. In particular,
            // SAVE_STATE may block on plugin serialization/fsync without stalling audio.
            unsafe {
                service_command_mailbox(region, |kind, arg| match kind {
                    CMD_SAVE_STATE => Some(save_state_command(arg, || {
                        main.with_mut(|main| main.capture_state())
                    })),
                    CMD_OPEN_UI | CMD_CLOSE_UI => Some(ui.handle_command(kind, arg)),
                    _ => None,
                });
            }
            ui.tick(ui.now());
            false
        },
        move |stop_audio| {
            let region = region_addr as *mut orbit_audio_sandbox::SharedRegion;
            // in-place process_block 用の作業バッファ（audio loop 前に確保 = RT 安全）。
            let mut scratch = vec![0.0f32; BUF_LEN];
            let mut process_errors = 0u64;
            let mut last = 0u64;
            loop {
                // Audio thread observes only the runtime stop flag and CONTROL_QUIT.
                // Mailbox and ParentWatch remain exclusively on the main runloop.
                if stop_audio.load(Relaxed)
                    || unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT
                {
                    break;
                }
                let cur = unsafe { (*region).seq_request.load(Acquire) };
                if cur <= last {
                    std::hint::spin_loop();
                    continue;
                }
                let idx = slot_index(cur);
                let off = slot_offset(cur);
                let count = unsafe {
                    let n = ((*region).n_frames[idx].load(Relaxed) as usize).min(MAX_FRAMES);
                    let count = n * CHANNELS;
                    let in_base = std::ptr::addr_of!((*region).input) as *const f32;
                    std::ptr::copy_nonoverlapping(in_base.add(off), scratch.as_mut_ptr(), count);
                    count
                };

                if !effect_audio.process_block(&mut scratch[..count]) {
                    process_errors += 1;
                    unsafe {
                        (*region).child_process_error_count.fetch_add(1, Relaxed);
                    }
                }

                unsafe {
                    let out_base = std::ptr::addr_of_mut!((*region).output) as *mut f32;
                    std::ptr::copy_nonoverlapping(scratch.as_ptr(), out_base.add(off), count);
                    (*region).child_processed.fetch_add(1, Relaxed);
                    (*region).seq_tag[idx].store(cur, Release);
                    (*region).seq_done.store(cur, Release);
                }
                last = cur;
            }
            // ClapEffectAudio::drop runs stop_processing on this audio thread.
            process_errors
        },
    )?;

    if process_errors > 0 {
        eprintln!(
            "[orbit-clap-effect-child] plugin.process() が {process_errors} ブロックで失敗 \
             （該当ブロックは dry 素通し）"
        );
    }
    Ok(())
}
