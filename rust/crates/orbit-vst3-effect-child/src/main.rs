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
    open_shared, region_ptr, slot_index, slot_offset, ParentWatch, BUF_LEN, CHANNELS, CONTROL_QUIT,
    MAX_FRAMES,
};
#[cfg(target_os = "macos")]
use orbit_child_runtime::{
    child_should_quit, run_child, service_child_main, UiCallbacks, UiService,
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
/// `--plugin-id` が Phase 1 の VST3 effect で使われないことを伝える通知。
///
/// level トークン規約の理由と TS 側の受理条件は `orbit_child_runtime::notice` に集約してある
/// （#618 / #625: 手書きの前置が 2 回同じ障害を起こしたため）。
fn unused_plugin_id_notice(plugin_id: &str) -> String {
    orbit_child_runtime::notice::child_info(
        "orbit-vst3-effect-child",
        format_args!("--plugin-id={plugin_id} は Phase 1 VST3 effect では未使用"),
    )
}

#[cfg(target_os = "macos")]
fn main() -> Result<()> {
    let args = parse_args()?;
    let mmap = open_shared(&args.shm).with_context(|| format!("open_shared({:?})", args.shm))?;
    let region = region_ptr(&mmap);

    if let Some(plugin_id) = &args.plugin_id {
        eprintln!("{}", unused_plugin_id_notice(plugin_id));
    }

    let state_bytes = match args.state.as_deref() {
        Some(path) => Some(std::fs::read(path).with_context(|| format!("read state {path:?}"))?),
        None => None,
    };
    let (effect, info) = Vst3EffectProcessor::load(
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
    let (mut effect_audio, effect_main) = effect.split();
    let (ui, main) = UiService::new(region, effect_main, |main| UiCallbacks {
        closed: None,
        requested_size: main.take_requested_size(),
    });

    // orphan 対策(#448): host(daemon)が CONTROL_QUIT を書かずに死ぬ経路(プロセス exit・
    // SIGKILL・crash)でも main runloop を止められるよう、親死活をタイマーで監視する。
    let parent_watch = ParentWatch::new();
    let region_addr = region as usize;
    let process_errors = run_child(
        "orbit-vst3-effect-child",
        || unsafe { child_should_quit(region, &parent_watch) },
        || unsafe {
            service_child_main(region, &ui, || main.with_mut(|main| main.capture_state()))
        },
        move |stop_audio| {
            let region = region_addr as *mut orbit_audio_sandbox::SharedRegion;
            let mut scratch = vec![0.0f32; BUF_LEN];
            let mut process_errors = 0u64;
            let mut last = 0u64;

            loop {
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
            // Vst3EffectAudio::drop runs setProcessing(0) on this audio thread.
            process_errors
        },
    )?;

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

// 対象の `unused_plugin_id_notice` は macOS 限定なので、テストも同じ cfg に揃える
// （揃えないと Linux の `--all-targets` で unresolved import になる・CI が Linux で回る）。
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::unused_plugin_id_notice;

    /// この通知は失敗ではないので、daemon の stderr router が非エラーと判定できる形で
    /// なければならない。router は `^\s*(TRACE|DEBUG|INFO)\s+\[orbit-[a-z0-9-]+\]\s`
    /// にマッチする行だけを非エラーとして認める（`daemon-client.ts`）。
    #[test]
    fn unused_plugin_id_notice_declares_a_non_error_level_token() {
        let line = unused_plugin_id_notice("6E33225254224A00AA69301AF318797D");
        assert!(
            line.starts_with("INFO [orbit-vst3-effect-child] "),
            "notice must declare a non-error level token and the child tag: {line}"
        );
        assert!(
            line.contains("6E33225254224A00AA69301AF318797D"),
            "notice must name the ignored plugin id: {line}"
        );
    }
}
