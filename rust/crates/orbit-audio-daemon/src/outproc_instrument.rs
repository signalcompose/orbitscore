//! Out-of-process CLAP instrument integration for the daemon.
//!
//! The daemon remains clack-free: the CLAP implementation lives in the spawned
//! `orbit-clap-instrument-child`, while this module owns the shared-memory host, note ring, and
//! child supervisor.

#![allow(unsafe_code)]

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use orbit_audio_native::PostProcessor;
use orbit_audio_sandbox::transport::reset_child_starting;
use orbit_audio_sandbox::{
    open_shared, region_ptr, NeutralEvent, PipelinedInstrumentHost, TransportContext, VoiceKey,
    BUF_LEN, CONTROL_QUIT,
};

const WATCHDOG_POLL: Duration = Duration::from_millis(20);
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const TEARDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const TRY_WAIT_ERROR_LIMIT: u32 = 50;
pub const NOTE_RING_CAPACITY: usize = 1024;
/// Fixed probe voice (A4 / port 0 / channel 0 / key 69) used by the gated cross-process
/// NOTE_END test. `pub` so the gated test references this instead of re-hardcoding the triple.
pub const PROBE_KEY: VoiceKey = VoiceKey {
    port_index: 0,
    channel: 0,
    key: 69,
};
/// Placeholder transport passed to every audio block: issue #420 wires DSL/CLI note-on/off
/// through to a real instrument, but does not yet plumb live tempo/transport state (tracked in
/// #408). Fixed at 120 BPM / 4-4 / playing until #408 lands.
const STUB_TRANSPORT: TransportContext = TransportContext {
    tempo_bpm: 120.0,
    time_sig_numerator: 4,
    time_sig_denominator: 4,
    is_playing: 1,
    is_looping: 0,
    song_position_beats: 0.0,
};

static SHM_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn unique_shm_path() -> PathBuf {
    let seq = SHM_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "orbit-outproc-instrument-{}-{seq}.shm",
        std::process::id()
    ))
}

pub struct OutProcInstrumentConfig {
    pub child_exe: PathBuf,
    pub plugin: PathBuf,
    pub plugin_id: Option<String>,
    pub buffer_frames: Option<u32>,
}

impl OutProcInstrumentConfig {
    pub fn from_env() -> Result<Self, String> {
        let child_exe = match std::env::var_os("ORBIT_INSTRUMENT_CHILD_BIN") {
            Some(value) => PathBuf::from(value),
            None => default_child_exe()?,
        };
        let plugin = std::env::var_os("ORBIT_INSTRUMENT_PLUGIN")
            .map(PathBuf::from)
            .ok_or_else(|| {
                "ORBIT_INSTRUMENT_PLUGIN not set (out-of-process instrument needs a .clap bundle path)"
                    .to_string()
            })?;
        let plugin_id = std::env::var("ORBIT_INSTRUMENT_PLUGIN_ID").ok();
        let buffer_frames = parse_buffer_frames(
            std::env::var("ORBIT_INSTRUMENT_BUFFER_FRAMES")
                .ok()
                .as_deref(),
        );
        Ok(Self {
            child_exe,
            plugin,
            plugin_id,
            buffer_frames,
        })
    }
}

/// Parses `ORBIT_INSTRUMENT_BUFFER_FRAMES`'s raw string value (`None` if the env var was unset)
/// into the buffer-frame override: `None` means "use the device default" (unset, malformed, or
/// non-positive), `Some(frames)` is a valid positive override. Extracted from `from_env` so the
/// parsing boundaries (missing / malformed / zero / positive) are unit-testable without mutating
/// process-global env state (mirrors `outproc_effect::PluginFormat::from_env_value`).
fn parse_buffer_frames(value: Option<&str>) -> Option<u32> {
    let value = value?;
    match value.parse::<u32>() {
        Ok(frames) if frames > 0 => Some(frames),
        _ => {
            tracing::warn!(
                "ORBIT_INSTRUMENT_BUFFER_FRAMES='{value}' is invalid; using device default"
            );
            None
        }
    }
}

fn default_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join("orbit-clap-instrument-child"))
}

#[derive(Default)]
pub struct OutProcInstrumentStats {
    pub initial_attach_pending: AtomicBool,
    pub child_early_exit: AtomicBool,
    pub fresh: AtomicU64,
    pub callback_count: AtomicU64,
    pub respawn_count: AtomicU64,
    pub measurement_invalid: AtomicBool,
    pub child_process_error_count: AtomicU64,
    /// child-local spill FIFO(§4.2 output 方向)自体が尽きた場合のみ増分(真の drop)。child の
    /// `SharedRegion::output_event_dropped_count` を watchdog がミラーした値（`child_process_error_count`
    /// と同じ mirror パターン）。
    pub output_event_dropped_count: AtomicU64,
    /// child-local spill FIFO 経由の無損失な1ブロック超遅延(情報用)。`SharedRegion::output_event_spilled_count`
    /// のミラー。
    pub output_event_spilled_count: AtomicU64,
    /// 上記 output 方向 drop に `NoteEnd` が含まれた回数。`SharedRegion::output_note_end_dropped_count`
    /// のミラー(host の簿記リセット判断トリガと同じ counter だが、こちらは daemon health 可視化用)。
    pub output_note_end_dropped_count: AtomicU64,
    /// Gated cross-process probe: A4 (port 0 / channel 0 / key 69) の host-side live voice 数。
    pub probe_live_count: AtomicU16,
    /// Instrument 加算後の master bus の abs peak を f32 bits で累積する。非負 f32 の bits は
    /// u32 として単調なので、audio thread から `fetch_max` で lock-free に更新できる。
    pub post_peak_bits: AtomicU32,
    pub current_child_pid: AtomicU32,
}

impl OutProcInstrumentStats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn reset_post_peak(&self) {
        self.post_peak_bits.store(0, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> OutProcInstrumentSnapshot {
        OutProcInstrumentSnapshot {
            fresh: self.fresh.load(Ordering::Relaxed),
            callback_count: self.callback_count.load(Ordering::Relaxed),
            respawn_count: self.respawn_count.load(Ordering::Relaxed),
            measurement_invalid: self.measurement_invalid.load(Ordering::Relaxed),
            child_process_error_count: self.child_process_error_count.load(Ordering::Relaxed),
            output_event_dropped_count: self.output_event_dropped_count.load(Ordering::Relaxed),
            output_event_spilled_count: self.output_event_spilled_count.load(Ordering::Relaxed),
            output_note_end_dropped_count: self
                .output_note_end_dropped_count
                .load(Ordering::Relaxed),
            probe_live_count: self.probe_live_count.load(Ordering::Relaxed),
            post_peak: f32::from_bits(self.post_peak_bits.load(Ordering::Relaxed)),
            current_child_pid: self.current_child_pid.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OutProcInstrumentSnapshot {
    pub fresh: u64,
    pub callback_count: u64,
    pub respawn_count: u64,
    pub measurement_invalid: bool,
    pub child_process_error_count: u64,
    pub output_event_dropped_count: u64,
    pub output_event_spilled_count: u64,
    pub output_note_end_dropped_count: u64,
    pub probe_live_count: u16,
    pub post_peak: f32,
    pub current_child_pid: u32,
}

pub struct OutProcInstrumentPostProcessor {
    host: PipelinedInstrumentHost,
    event_rx: rtrb::Consumer<NeutralEvent>,
    event_scratch: Vec<NeutralEvent>,
    audio_scratch: Vec<f32>,
    /// PR-431: child が未 attach（post-boot attach 待ち）の間は音を素通しする安全弁。
    /// **本 PR では常に true で構築される**（既存起動経路は eager attach のまま無変更）。
    /// PR-1b で post-boot attach 実装時に false スタートさせる想定（詳細は Issue #431 参照）。
    engaged: Arc<AtomicBool>,
    teardown_requested: Arc<AtomicBool>,
    teardown_done: Arc<AtomicBool>,
    stats: Arc<OutProcInstrumentStats>,
    /// Last supervisor generation observed by the audio thread. This field has exactly one reader
    /// and writer (`process`) and therefore needs no atomic synchronization of its own.
    last_respawn_count: u64,
}

impl OutProcInstrumentPostProcessor {
    /// `host` = mmap を所有する production 構築子（`PipelinedInstrumentHost::from_mmap`）で作った
    /// host、`event_rx` = note event の受け側（`event_capacity` はその scratch buffer 分の容量）、
    /// `engaged` = child の post-boot attach 完了までの安全弁（本 PR では常に `true` で渡される）、
    /// `teardown_requested` / `teardown_done` = supervisor と共有する協調フラグ、`stats` = 観測ミラー。
    pub fn new(
        host: PipelinedInstrumentHost,
        event_rx: rtrb::Consumer<NeutralEvent>,
        event_capacity: usize,
        engaged: Arc<AtomicBool>,
        teardown_requested: Arc<AtomicBool>,
        teardown_done: Arc<AtomicBool>,
        stats: Arc<OutProcInstrumentStats>,
    ) -> Self {
        Self {
            host,
            event_rx,
            event_scratch: Vec::with_capacity(event_capacity),
            audio_scratch: vec![0.0; BUF_LEN],
            engaged,
            teardown_requested,
            teardown_done,
            stats,
            last_respawn_count: 0,
        }
    }
}

impl PostProcessor for OutProcInstrumentPostProcessor {
    fn process(&mut self, data: &mut [f32]) {
        if self.teardown_requested.load(Ordering::Acquire) {
            self.teardown_done.store(true, Ordering::Release);
            return;
        }
        if !self.engaged.load(Ordering::Acquire) {
            return;
        }

        let respawn_count = self.stats.respawn_count.load(Ordering::Relaxed);
        if respawn_count != self.last_respawn_count {
            self.host.on_child_respawned();
            self.last_respawn_count = respawn_count;
        }

        self.event_scratch.clear();
        while let Ok(event) = self.event_rx.pop() {
            self.event_scratch.push(event);
        }

        let process_len = data.len().min(self.audio_scratch.len());
        let scratch = &mut self.audio_scratch[..process_len];
        // No zero-fill needed here: `process_block` unconditionally overwrites every sample of
        // `scratch` (fresh copy, stale repeat, or silence), so any prior content is fully
        // clobbered regardless of branch taken.
        self.host
            .process_block(scratch, &self.event_scratch, STUB_TRANSPORT);
        // `process_block` drains child output events before returning. Publish the resulting
        // host bookkeeping state for the fixed gated-test probe voice.
        self.stats
            .probe_live_count
            .store(self.host.live_count(PROBE_KEY), Ordering::Relaxed);

        // `data` already contains the engine-rendered master. The instrument is parallel audio,
        // so preserve that master and add the child output from scratch, tracking the abs peak
        // of the summed result in the same pass instead of re-scanning `data` afterward.
        let mut peak_bits_value = 0u32;
        for (master, instrument) in data[..process_len].iter_mut().zip(scratch.iter()) {
            *master += *instrument;
            peak_bits_value = peak_bits_value.max(master.to_bits() & 0x7FFF_FFFF);
        }
        self.stats
            .post_peak_bits
            .fetch_max(peak_bits_value, Ordering::Relaxed);

        self.stats.fresh.store(self.host.fresh, Ordering::Relaxed);
        self.stats.callback_count.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn spawn_instrument_child(
    child_exe: &Path,
    shm_path: &Path,
    plugin: &Path,
    plugin_id: Option<&str>,
    sample_rate: u32,
) -> io::Result<Child> {
    let mut command = Command::new(child_exe);
    command
        .arg("--shm")
        .arg(shm_path)
        .arg("--plugin")
        .arg(plugin)
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .stderr(Stdio::inherit());
    if let Some(id) = plugin_id {
        command.arg("--plugin-id").arg(id);
    }
    command.spawn()
}

fn reap(child: &mut Child) {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
            Ok(None) => {
                tracing::warn!(
                    "orbit-clap-instrument-child did not exit within {REAP_TIMEOUT:?}; killing"
                );
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Err(error) => {
                tracing::error!("instrument child try_wait failed; killing: {error}");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

pub struct InstrumentChildSupervisor {
    shutdown: Arc<AtomicBool>,
    watchdog: Option<JoinHandle<()>>,
    shm_path: PathBuf,
    unlink_shm: bool,
}

impl InstrumentChildSupervisor {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        mut first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcInstrumentStats>,
        child_exe: PathBuf,
        plugin: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
    ) -> io::Result<Self> {
        let ctl_mmap = match open_shared(&shm_path) {
            Ok(mmap) => mmap,
            Err(error) => {
                if let Err(kill_error) = first_child.kill() {
                    tracing::warn!(
                        "instrument child kill during startup-failure cleanup failed: {kill_error}"
                    );
                }
                if let Err(wait_error) = first_child.wait() {
                    tracing::warn!(
                        "instrument child reap (wait) during startup-failure cleanup failed: {wait_error}"
                    );
                }
                if let Err(remove_error) = std::fs::remove_file(&shm_path) {
                    tracing::warn!(
                        "OOP instrument shm removal failed {shm_path:?}: {remove_error}"
                    );
                }
                return Err(error);
            }
        };
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_thread = shutdown.clone();
        let watchdog_shm_path = shm_path.clone();
        let (child_tx, child_rx) = std::sync::mpsc::channel::<Child>();

        let watchdog = match std::thread::Builder::new()
            .name("orbit-outproc-instrument-watchdog".into())
            .spawn(move || {
                let region = region_ptr(&ctl_mmap);
                let mut child = match child_rx.recv() {
                    Ok(child) => child,
                    Err(_) => return,
                };
                let mut try_wait_errors = 0u32;
                loop {
                    if shutdown_thread.load(Ordering::Acquire) {
                        break;
                    }
                    let errors =
                        unsafe { (*region).child_process_error_count.load(Ordering::Relaxed) };
                    stats
                        .child_process_error_count
                        .store(errors, Ordering::Relaxed);
                    // Mirror the child's output-event overflow/spill/drop health counters (M2
                    // wire, §4.2 output direction) the same way as `child_process_error_count`
                    // above, so daemon health reporting can observe output-event overflow instead
                    // of only voice-bookkeeping symptoms downstream of it.
                    let output_dropped =
                        unsafe { (*region).output_event_dropped_count.load(Ordering::Relaxed) };
                    stats
                        .output_event_dropped_count
                        .store(output_dropped, Ordering::Relaxed);
                    let output_spilled =
                        unsafe { (*region).output_event_spilled_count.load(Ordering::Relaxed) };
                    stats
                        .output_event_spilled_count
                        .store(output_spilled, Ordering::Relaxed);
                    let note_end_dropped = unsafe {
                        (*region)
                            .output_note_end_dropped_count
                            .load(Ordering::Relaxed)
                    };
                    stats
                        .output_note_end_dropped_count
                        .store(note_end_dropped, Ordering::Relaxed);

                    match child.try_wait() {
                        Ok(Some(_)) if shutdown_thread.load(Ordering::Acquire) => break,
                        Ok(Some(status)) => {
                            try_wait_errors = 0;
                            // READY publication races with the host clearing initial_attach_pending:
                            // a child can publish READY and then crash in that window.  Only a
                            // pre-READY exit is an attach fast-fail; a post-READY exit must reach
                            // the normal respawn path or the host could install a dead Active slot.
                            if stats.initial_attach_pending.load(Ordering::Acquire)
                                && unsafe {
                                    (*region).child_status.load(Ordering::Acquire)
                                        != orbit_audio_sandbox::transport::CHILD_STATUS_READY
                                }
                            {
                                tracing::warn!("orbit-clap-instrument-child exited during initial attach ({status})");
                                stats.child_early_exit.store(true, Ordering::Release);
                                break;
                            }
                            tracing::warn!(
                                "orbit-clap-instrument-child exited ({status}); respawning"
                            );
                            // SAFETY: region は watchdog が所有する生存 ctl_mmap を指す。
                            // 前 incarnation の READY を消してから replacement を spawn する。
                            unsafe { reset_child_starting(region) };
                            match spawn_instrument_child(
                                &child_exe,
                                &watchdog_shm_path,
                                &plugin,
                                plugin_id.as_deref(),
                                sample_rate,
                            ) {
                                Ok(replacement) => {
                                    stats
                                        .current_child_pid
                                        .store(replacement.id(), Ordering::Relaxed);
                                    child = replacement;
                                    stats.respawn_count.fetch_add(1, Ordering::Relaxed);
                                    // The audio-thread adapter observes this generation counter
                                    // and resets its host-side voice bookkeeping on its next block.
                                }
                                Err(error) => {
                                    tracing::error!(
                                        "instrument child respawn failed; measurement invalid: {error}"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            try_wait_errors = 0;
                            std::thread::sleep(WATCHDOG_POLL);
                        }
                        Err(error) => {
                            try_wait_errors += 1;
                            if try_wait_errors >= TRY_WAIT_ERROR_LIMIT {
                                tracing::error!(
                                    "instrument child try_wait failed {try_wait_errors} consecutive times: {error}"
                                );
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            std::thread::sleep(WATCHDOG_POLL);
                        }
                    }
                }
                unsafe {
                    (*region).control.store(CONTROL_QUIT, Ordering::Release);
                }
                reap(&mut child);
            }) {
            Ok(handle) => handle,
            Err(error) => {
                if let Err(kill_error) = first_child.kill() {
                    tracing::warn!(
                        "instrument child kill during startup-failure cleanup failed: {kill_error}"
                    );
                }
                if let Err(wait_error) = first_child.wait() {
                    tracing::warn!(
                        "instrument child reap (wait) during startup-failure cleanup failed: {wait_error}"
                    );
                }
                if let Err(remove_error) = std::fs::remove_file(&shm_path) {
                    tracing::warn!("OOP instrument shm removal failed {shm_path:?}: {remove_error}");
                }
                return Err(error);
            }
        };

        if let Err(std::sync::mpsc::SendError(mut orphan)) = child_tx.send(first_child) {
            if let Err(kill_error) = orphan.kill() {
                tracing::warn!(
                    "orphaned instrument child kill during startup-failure cleanup failed: {kill_error}"
                );
            }
            if let Err(wait_error) = orphan.wait() {
                tracing::warn!(
                    "orphaned instrument child reap (wait) during startup-failure cleanup failed: {wait_error}"
                );
            }
            if let Err(remove_error) = std::fs::remove_file(&shm_path) {
                tracing::warn!("OOP instrument shm removal failed {shm_path:?}: {remove_error}");
            }
            return Err(io::Error::other(
                "instrument watchdog exited before receiving first child",
            ));
        }

        Ok(Self {
            shutdown,
            watchdog: Some(watchdog),
            shm_path,
            unlink_shm: true,
        })
    }

    /// Stop/reap the child but leave shm unlink ownership with `ChildLaunch` for a retry.
    pub fn detach_keep_shm(mut self) {
        self.unlink_shm = false;
    }
}

impl Drop for InstrumentChildSupervisor {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        if let Some(watchdog) = self.watchdog.take() {
            if watchdog.join().is_err() {
                tracing::error!("outproc instrument watchdog panicked during shutdown");
            }
        }
        if self.unlink_shm {
            if let Err(error) = std::fs::remove_file(&self.shm_path) {
                tracing::warn!(
                    "OOP instrument shm removal failed {:?}: {error}",
                    self.shm_path
                );
            }
        }
    }
}

pub struct OutProcInstrumentTeardownGuard {
    requested: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

impl OutProcInstrumentTeardownGuard {
    pub fn new(requested: Arc<AtomicBool>, done: Arc<AtomicBool>) -> Self {
        Self { requested, done }
    }
}

impl Drop for OutProcInstrumentTeardownGuard {
    fn drop(&mut self) {
        self.requested.store(true, Ordering::Release);
        let deadline = Instant::now() + TEARDOWN_TIMEOUT;
        while !self.done.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                tracing::warn!(
                    "OOP instrument teardown quiesce timed out after {}ms",
                    TEARDOWN_TIMEOUT.as_millis()
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orbit_audio_sandbox::{slot_index, VoiceAddr, VoiceKey, CHANNELS};

    fn engaged(value: bool) -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(value))
    }

    // pr-test-analyzer (item 7, PR #422 review): `OutProcInstrumentConfig::from_env`'s
    // `ORBIT_INSTRUMENT_BUFFER_FRAMES` parsing boundaries had no coverage. Test the extracted pure
    // helper directly rather than `std::env::set_var` (parallel-test flakiness trap; mirrors
    // `outproc_effect::tests::plugin_format_from_env_value_*`, which tests the same kind of
    // extracted pure helper instead of touching process-global env).
    #[test]
    fn parse_buffer_frames_boundaries() {
        assert_eq!(
            parse_buffer_frames(None),
            None,
            "unset must use device default"
        );
        assert_eq!(parse_buffer_frames(Some("64")), Some(64));
        assert_eq!(
            parse_buffer_frames(Some("0")),
            None,
            "zero must fall back to device default, not underflow/panic"
        );
        assert_eq!(
            parse_buffer_frames(Some("not-a-number")),
            None,
            "malformed value must fall back to device default"
        );
    }

    // CI-runnable regression guard for the output-event overflow health counters: no real child
    // or shared memory is needed to verify `snapshot()` surfaces every field (mirrors
    // `outproc_effect::tests::stats_snapshot_reflects_all_fields`). The gated hardware tests only
    // assert these are 0 on the happy path; this test is what actually guards the field-exposure
    // deliverable in CI (a future overflow regression would otherwise pass both silently).
    #[test]
    fn stats_snapshot_reflects_output_event_health_counters() {
        let stats = OutProcInstrumentStats::new();
        stats.output_event_dropped_count.store(3, Ordering::Relaxed);
        stats
            .output_event_spilled_count
            .store(11, Ordering::Relaxed);
        stats
            .output_note_end_dropped_count
            .store(2, Ordering::Relaxed);

        let snapshot = stats.snapshot();

        assert_eq!(snapshot.output_event_dropped_count, 3);
        assert_eq!(snapshot.output_event_spilled_count, 11);
        assert_eq!(snapshot.output_note_end_dropped_count, 2);
    }

    #[test]
    fn note_round_trip_adds_instrument_without_overwriting_master() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let ctl_mmap = open_shared(&path).expect("open control mapping");
        let region = region_ptr(&ctl_mmap);
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (mut event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let requested = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let mut processor = OutProcInstrumentPostProcessor::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            requested,
            done,
            stats.clone(),
        );
        let addr = VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: PROBE_KEY.channel,
            key: PROBE_KEY.key,
            _pad: 0,
        };
        let note = NeutralEvent::NoteOn {
            sample_offset: 0,
            addr,
            velocity: 0.8,
            tuning_cents: 0.0,
            length_frames: 0,
        };
        event_tx.push(note).expect("push note to control ring");

        let mut first = vec![0.5; 8 * CHANNELS];
        processor.process(&mut first);
        assert!(first.iter().all(|sample| *sample == 0.5));
        assert_eq!(
            stats.probe_live_count.load(Ordering::Relaxed),
            1,
            "probe must mirror host voice bookkeeping after NoteOn"
        );
        unsafe {
            let slot = slot_index(1);
            assert_eq!((*region).input_events[slot][0].decode(), Some(note));
            let output = std::ptr::addr_of_mut!((*region).output) as *mut f32;
            for index in 0..first.len() {
                *output.add(slot * BUF_LEN + index) = 0.25;
            }
            (*region).output_event_count[slot].store(0, Ordering::Relaxed);
            (*region).seq_tag[slot].store(1, Ordering::Release);
            (*region).seq_done.store(1, Ordering::Release);
        }

        let mut second = vec![0.5; first.len()];
        processor.process(&mut second);
        assert!(second.iter().all(|sample| *sample == 0.75));
        assert_eq!(
            f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed)),
            0.75,
            "post peak must be measured from the summed master bus"
        );

        drop(processor);
        drop(ctl_mmap);
        std::fs::remove_file(path).expect("remove shared memory");
    }

    #[test]
    fn respawn_generation_resets_voices_once_on_the_next_process() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let ctl_mmap = open_shared(&path).expect("open control mapping");
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (mut event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let stats = OutProcInstrumentStats::new();
        let mut processor = OutProcInstrumentPostProcessor::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            stats.clone(),
        );
        let addr = VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: 2,
            key: 60,
            _pad: 0,
        };
        let key = VoiceKey {
            port_index: addr.port_index,
            channel: addr.channel,
            key: addr.key,
        };
        event_tx
            .push(NeutralEvent::NoteOn {
                sample_offset: 0,
                addr,
                velocity: 0.8,
                tuning_cents: 0.0,
                length_frames: 0,
            })
            .expect("push note on");

        let mut data = vec![0.0; 8 * CHANNELS];
        processor.process(&mut data);
        assert_eq!(
            processor.host.live_count(key),
            1,
            "initial generation zero must not be misdetected as a respawn"
        );

        processor.process(&mut data);
        assert_eq!(
            processor.host.live_count(key),
            1,
            "unchanged generation must not reset voices every block"
        );

        stats.respawn_count.store(1, Ordering::Relaxed);
        processor.process(&mut data);
        assert_eq!(
            processor.host.live_count(key),
            0,
            "changed generation must reset voices on the next audio block"
        );
        assert_eq!(processor.last_respawn_count, 1);

        drop(processor);
        drop(ctl_mmap);
        std::fs::remove_file(path).expect("remove shared memory");
    }

    // pr-test-analyzer (item 4, PR #422 review): `OutProcInstrumentPostProcessor::process()`'s
    // `teardown_requested` early-return branch (sets `teardown_done`, skips all stats/audio
    // updates) had no unit test.
    #[test]
    fn teardown_requested_returns_early_and_sets_teardown_done_without_touching_stats_or_audio() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let ctl_mmap = open_shared(&path).expect("open control mapping");
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (_event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let requested = Arc::new(AtomicBool::new(true));
        let done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let mut processor = OutProcInstrumentPostProcessor::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            requested,
            done.clone(),
            stats.clone(),
        );

        let mut data = vec![0.42; 8 * CHANNELS];
        processor.process(&mut data);

        assert!(
            done.load(Ordering::Acquire),
            "teardown_requested early return must set teardown_done"
        );
        assert!(
            data.iter().all(|sample| *sample == 0.42),
            "teardown early return must not touch the audio buffer"
        );
        assert_eq!(
            stats.callback_count.load(Ordering::Relaxed),
            0,
            "teardown early return must skip the normal per-block stats update"
        );

        drop(processor);
        drop(ctl_mmap);
        std::fs::remove_file(path).expect("remove shared memory");
    }

    // disengaged (engaged=false) の間は event ring を drain してはいけない: drain してしまうと
    // engaged になった後の最初の process() でその note を再び読めず、note-on が消える data-loss
    // race になる。以前の版はイベントを1件も積まずに空の ring を検証していたため、この drain-vs-
    // no-drain の分岐を実際には踏んでいなかった（空の ring は pop() が常に Err なので、drain して
    // もしなくても外から見た結果は同じ）。note を1件積んでから process() を呼び、process() 後も
    // 同じ note が event_rx から pop できる（= 消費されていない）ことを直接検証する。
    #[test]
    fn disengaged_passes_dry_without_updating_stats() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (mut event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let stats = OutProcInstrumentStats::new();
        let addr = VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: PROBE_KEY.channel,
            key: PROBE_KEY.key,
            _pad: 0,
        };
        let note = NeutralEvent::NoteOn {
            sample_offset: 0,
            addr,
            velocity: 0.8,
            tuning_cents: 0.0,
            length_frames: 0,
        };
        event_tx.push(note).expect("push note to control ring");
        let mut processor = OutProcInstrumentPostProcessor::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(false),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            stats.clone(),
        );

        let mut data = vec![0.42; 8 * CHANNELS];
        processor.process(&mut data);

        assert!(data.iter().all(|sample| *sample == 0.42));
        assert_eq!(stats.callback_count.load(Ordering::Relaxed), 0);
        assert_eq!(
            processor.event_rx.pop(),
            Ok(note),
            "disengaged 中は event ring を drain せず、note がそのまま残っている"
        );

        drop(processor);
        std::fs::remove_file(path).expect("remove shared memory");
    }

    /// `InstrumentChildSupervisor`'s 2nd `open_shared` needs a shared-memory **file** to already
    /// exist; mapping is dropped immediately so the file survives for the supervisor to open.
    fn make_shm() -> PathBuf {
        let p = unique_shm_path();
        let _ = std::fs::remove_file(&p);
        let _ = orbit_audio_sandbox::create_shared(&p).expect("create_shared");
        p
    }

    /// Polls `cond` every 20ms until it's true or `timeout_secs` elapses (supervisor watchdog
    /// behavior is asynchronous).
    fn poll_until(timeout_secs: u64, mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    // pr-test-analyzer (item 4, PR #422 review): the watchdog state machine (child-exit ->
    // respawn, respawn-failure -> measurement_invalid) had zero CI-runnable coverage -- only
    // reachable via the `#[ignore]`d gated hardware tests. Mirrors
    // `outproc_effect::tests::supervisor_marks_measurement_invalid_when_respawn_fails` exactly:
    // a short-lived stub child + a nonexistent respawn binary forces the failure branch, no real
    // audio device or CLAP plugin needed.
    #[test]
    fn supervisor_marks_measurement_invalid_when_respawn_fails() {
        let shm = make_shm();
        let stats = OutProcInstrumentStats::new();
        let first = Command::new("sleep")
            .arg("0.2")
            .spawn()
            .expect("spawn stub child");
        let bad_exe = std::env::temp_dir().join("orbit-nonexistent-instrument-child-xyz");
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            bad_exe,
            PathBuf::from("/nonexistent.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let invalid = poll_until(5, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(invalid, "respawn 恒久失敗で measurement_invalid が立つ");
        drop(sup); // join がハングしないこと（watchdog は break 済み）。
        let _ = std::fs::remove_file(&shm);
    }

    // pr-test-analyzer (round 4, PR #422 review): open_shared 失敗時の cleanup（first_child を
    // kill+wait して shm を remove_file する分岐）に、その分岐を実際に踏ませるテストが無かった。
    // Mirrors `outproc_effect::tests::supervisor_spawn_reaps_first_child_on_open_shared_failure`
    // exactly: shm ファイルを消してから spawn を呼び open_shared を失敗させ、Err 返却 + child が
    // reap される（kill -0 が ESRCH）ことを検証する。
    #[test]
    fn supervisor_spawn_reaps_first_child_on_open_shared_failure() {
        let shm = unique_shm_path();
        let _ = std::fs::remove_file(&shm); // ファイル不在 → open_shared が失敗する
        let stats = OutProcInstrumentStats::new();
        let first = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn stub child");
        let pid = first.id();
        let r = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats,
            PathBuf::from("/nonexistent"),
            PathBuf::from("/nonexistent.clap"),
            None,
            48_000,
        );
        assert!(r.is_err(), "open_shared 失敗で Err を返す");
        // first_child が reap された（orphan でない）= kill -0 が失敗（ESRCH）する。
        let reaped = poll_until(3, || {
            !Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        });
        assert!(
            reaped,
            "open_shared 失敗時に first_child が reap される（orphan 化しない）"
        );
    }

    // pr-test-analyzer (item 4, PR #422 review): success-side counterpart. Mirrors
    // `outproc_effect::tests::supervisor_respawns_child_on_unexpected_exit`: an unexpectedly
    // exited child triggers a real respawn (PID publish + `respawn_count` incrementing) without
    // `measurement_invalid` being set.
    #[test]
    fn supervisor_respawns_child_on_unexpected_exit() {
        let shm = make_shm();
        let stats = OutProcInstrumentStats::new();
        // Regression for #441: a post-READY crash while attach is still pending must respawn.
        stats.initial_attach_pending.store(true, Ordering::Release);
        let mmap = open_shared(&shm).expect("open shm to publish READY");
        let region = region_ptr(&mmap);
        // SAFETY: mmap owns the live shared region for this test.
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, false) };
        let first = Command::new("sleep")
            .arg("0.2")
            .spawn()
            .expect("spawn stub child");
        let first_pid = first.id();
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            PathBuf::from("sleep"),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        let respawned = poll_until(5, || stats.respawn_count.load(Ordering::Relaxed) >= 1);
        assert!(respawned, "child の異常終了で respawn_count が進む");
        assert!(
            !stats.measurement_invalid.load(Ordering::Acquire),
            "respawn が成功している間は計測有効"
        );
        let pid_published = poll_until(5, || {
            let pid = stats.current_child_pid.load(Ordering::Relaxed);
            pid != 0 && pid != first_pid
        });
        assert!(
            pid_published,
            "respawn 後に current_child_pid が replacement の PID に更新される (first={first_pid}, current={})",
            stats.current_child_pid.load(Ordering::Relaxed)
        );
        drop(sup);
        let _ = std::fs::remove_file(&shm);
    }

    // pr-test-analyzer (item 3, PR #422 review): the watchdog's per-tick mirror of `SharedRegion`'s
    // output-event health counters (output_event_dropped_count / output_event_spilled_count /
    // output_note_end_dropped_count) into `OutProcInstrumentStats` had zero coverage -- every
    // existing supervisor test uses a stub `sleep` child that never touches these region fields.
    // Writes three *distinct* values directly into the region (same raw shared-memory pattern as
    // `note_round_trip_adds_instrument_without_overwriting_master`, via a second `open_shared`
    // mapping of the same shm file) then polls the stats Arc for the watchdog to mirror them --
    // verifying field identity (not just "some value moved"), which would catch a copy-paste swap
    // at the mirror site (this file's watchdog loop, around `output_event_dropped_count` /
    // `output_event_spilled_count` / `output_note_end_dropped_count`).
    #[test]
    fn watchdog_mirrors_region_output_event_counters_with_correct_field_mapping() {
        let shm = make_shm();
        let stats = OutProcInstrumentStats::new();
        let first = Command::new("sleep")
            .arg("2")
            .spawn()
            .expect("spawn stub child");
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            PathBuf::from("sleep"),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
        )
        .expect("supervisor spawn");

        // Second mapping of the same shm file (shared memory, not a private copy): writes here
        // are visible to the watchdog thread's own mapping opened inside `spawn`.
        let ctl_mmap = open_shared(&shm).expect("open control mapping for injection");
        let region = region_ptr(&ctl_mmap);
        unsafe {
            (*region)
                .output_event_dropped_count
                .store(5, Ordering::Relaxed);
            (*region)
                .output_event_spilled_count
                .store(11, Ordering::Relaxed);
            (*region)
                .output_note_end_dropped_count
                .store(2, Ordering::Relaxed);
        }

        let mirrored = poll_until(5, || {
            stats.output_event_dropped_count.load(Ordering::Relaxed) == 5
                && stats.output_event_spilled_count.load(Ordering::Relaxed) == 11
                && stats.output_note_end_dropped_count.load(Ordering::Relaxed) == 2
        });
        assert!(
            mirrored,
            "watchdog must mirror each region counter into its matching stats field: \
             dropped={}, spilled={}, note_end_dropped={}",
            stats.output_event_dropped_count.load(Ordering::Relaxed),
            stats.output_event_spilled_count.load(Ordering::Relaxed),
            stats.output_note_end_dropped_count.load(Ordering::Relaxed),
        );

        drop(sup);
        drop(ctl_mmap);
        let _ = std::fs::remove_file(&shm);
    }
}
