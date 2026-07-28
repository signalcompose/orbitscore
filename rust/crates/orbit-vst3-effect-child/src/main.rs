//! orbit-vst3-effect-child — Phase 1 VST3 effect child process.
//!
//! This is intentionally transport-identical to `orbit-clap-effect-child`: map
//! [`orbit_audio_sandbox::SharedRegion`], copy each input slot into scratch, run the effect
//! in-place, copy scratch to the output slot, and publish `seq_tag` / `seq_done`.
//! The only functional difference is the processor: [`orbit_vst3_host::Vst3EffectProcessor`].
//!
//! CLI:
//!   --shm <path>
//!   --plugin <path>
//!   --plugin-id <id>      accepted for CLI symmetry; unused by Phase 1 VST3 host
//!   --sample-rate <u32>

#![allow(unsafe_code)]

#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering::{Acquire, Relaxed, Release};

#[cfg(target_os = "macos")]
use anyhow::{bail, Context, Result};
#[cfg(target_os = "macos")]
use orbit_audio_sandbox::{
    open_shared, region_ptr, service_command_mailbox, slot_index, slot_offset, write_sidecar,
    CommandOutcome, ParentWatch, BUF_LEN, CHANNELS, CMD_RESULT_BAD_ARG, CMD_RESULT_IO_ERROR,
    CMD_RESULT_PLUGIN_ERROR, CMD_SAVE_STATE, CONTROL_QUIT, MAX_FRAMES,
};
#[cfg(target_os = "macos")]
use orbit_vst3_host::Vst3EffectProcessor;

#[cfg(target_os = "macos")]
struct Args {
    shm: PathBuf,
    plugin: PathBuf,
    plugin_id: Option<String>,
    sample_rate: u32,
    state: Option<PathBuf>,
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn handle_save_state(path_arg: Option<&str>, effect: &Vst3EffectProcessor) -> CommandOutcome {
    let Some(path) = path_arg.filter(|candidate| !candidate.is_empty()) else {
        return CommandOutcome::failed(
            CMD_RESULT_BAD_ARG,
            "cmd_arg is empty or not NUL-terminated UTF-8",
        );
    };
    let bytes = match effect.capture_state() {
        Ok(bytes) => bytes,
        Err(error) => return CommandOutcome::failed(CMD_RESULT_PLUGIN_ERROR, format!("{error}")),
    };
    match write_sidecar(path, &bytes) {
        Ok(()) => CommandOutcome::ok(bytes.len() as u64),
        Err(error) => CommandOutcome::failed(CMD_RESULT_IO_ERROR, format!("write {path}: {error}")),
    }
}

#[cfg(target_os = "macos")]
fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);

    if let Some(plugin_id) = &args.plugin_id {
        eprintln!(
            "[orbit-vst3-effect-child] --plugin-id={plugin_id} は Phase 1 VST3 effect では未使用"
        );
    }

    let state_bytes = match args.state.as_deref() {
        Some(path) => Some(std::fs::read(path).with_context(|| format!("read state {path:?}"))?),
        None => None,
    };
    let (mut effect, info) = Vst3EffectProcessor::load(
        &args.plugin,
        args.sample_rate as f64,
        MAX_FRAMES as i32,
        state_bytes.as_deref(),
    )
    .with_context(|| format!("load VST3 effect {:?}", args.plugin))?;

    // load 成功を host へ handshake する（PR-1a の child readiness 契約・#445）。
    // host の ready-ack ループ（PR-1b）はこれを待つため、publish しないと attach が
    // CHILD_READY_TIMEOUT で必ず失敗する（CLAP effect child と同じ配置・同じ意味論）。
    // SAFETY: region は host が REGION_BYTES に truncate 済みの共有ファイルを指す。
    unsafe {
        orbit_audio_sandbox::transport::publish_child_ready(region, info.audio_inputs > 0);
    }

    let mut scratch = vec![0.0f32; BUF_LEN];
    let mut process_errors: u64 = 0;

    let mut last: u64 = 0;
    // orphan 対策(#448): host(daemon)が CONTROL_QUIT を書かずに死ぬ経路(プロセス exit・
    // SIGKILL・crash)でも spin loop を抜けられるよう、親死活を低頻度で監視する。
    let mut parent_watch = ParentWatch::new();
    loop {
        if unsafe { (*region).control.load(Relaxed) } == CONTROL_QUIT {
            break;
        }
        if parent_watch.should_exit() {
            eprintln!("[orbit-vst3-effect-child] 親プロセス死亡を検知、終了する");
            break;
        }
        unsafe {
            service_command_mailbox(region, |kind, arg| match kind {
                CMD_SAVE_STATE => Some(handle_save_state(arg, &effect)),
                _ => None,
            });
        }
        let cur = unsafe { (*region).seq_request.load(Acquire) };
        if cur > last {
            let idx = slot_index(cur);
            let off = slot_offset(cur);
            let count = unsafe {
                let n = ((*region).n_frames[idx].load(Relaxed) as usize).min(MAX_FRAMES);
                let count = n * CHANNELS;
                let in_base = std::ptr::addr_of!((*region).input) as *const f32;
                std::ptr::copy_nonoverlapping(in_base.add(off), scratch.as_mut_ptr(), count);
                count
            };

            if !effect.process_block(&mut scratch[..count]) {
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
        } else {
            std::hint::spin_loop();
        }
    }
    if process_errors > 0 {
        eprintln!(
            "[orbit-vst3-effect-child] plugin.process() failed for {process_errors} block(s); \
             affected blocks were passed through dry"
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("orbit-vst3-effect-child is macOS-only (VST3/CoreFoundation)");
    std::process::ExitCode::FAILURE
}
