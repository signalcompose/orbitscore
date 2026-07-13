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
        let buffer_frames = match std::env::var("ORBIT_INSTRUMENT_BUFFER_FRAMES") {
            Ok(value) => match value.parse::<u32>() {
                Ok(frames) if frames > 0 => Some(frames),
                _ => {
                    tracing::warn!(
                        "ORBIT_INSTRUMENT_BUFFER_FRAMES='{value}' is invalid; using device default"
                    );
                    None
                }
            },
            Err(_) => None,
        };
        Ok(Self {
            child_exe,
            plugin,
            plugin_id,
            buffer_frames,
        })
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
    pub fresh: AtomicU64,
    pub callback_count: AtomicU64,
    pub respawn_count: AtomicU64,
    pub measurement_invalid: AtomicBool,
    pub child_process_error_count: AtomicU64,
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
    pub probe_live_count: u16,
    pub post_peak: f32,
    pub current_child_pid: u32,
}

pub struct OutProcInstrumentPostProcessor {
    host: PipelinedInstrumentHost,
    event_rx: rtrb::Consumer<NeutralEvent>,
    event_scratch: Vec<NeutralEvent>,
    audio_scratch: Vec<f32>,
    teardown_requested: Arc<AtomicBool>,
    teardown_done: Arc<AtomicBool>,
    stats: Arc<OutProcInstrumentStats>,
    /// Last supervisor generation observed by the audio thread. This field has exactly one reader
    /// and writer (`process`) and therefore needs no atomic synchronization of its own.
    last_respawn_count: u64,
}

impl OutProcInstrumentPostProcessor {
    pub fn new(
        host: PipelinedInstrumentHost,
        event_rx: rtrb::Consumer<NeutralEvent>,
        event_capacity: usize,
        teardown_requested: Arc<AtomicBool>,
        teardown_done: Arc<AtomicBool>,
        stats: Arc<OutProcInstrumentStats>,
    ) -> Self {
        Self {
            host,
            event_rx,
            event_scratch: Vec::with_capacity(event_capacity),
            audio_scratch: vec![0.0; BUF_LEN],
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
                let _ = first_child.kill();
                let _ = first_child.wait();
                let _ = std::fs::remove_file(&shm_path);
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

                    match child.try_wait() {
                        Ok(Some(_)) if shutdown_thread.load(Ordering::Acquire) => break,
                        Ok(Some(status)) => {
                            try_wait_errors = 0;
                            tracing::warn!(
                                "orbit-clap-instrument-child exited ({status}); respawning"
                            );
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
                let _ = first_child.kill();
                let _ = first_child.wait();
                let _ = std::fs::remove_file(&shm_path);
                return Err(error);
            }
        };

        if let Err(std::sync::mpsc::SendError(mut orphan)) = child_tx.send(first_child) {
            let _ = orphan.kill();
            let _ = orphan.wait();
            let _ = std::fs::remove_file(&shm_path);
            return Err(io::Error::other(
                "instrument watchdog exited before receiving first child",
            ));
        }

        Ok(Self {
            shutdown,
            watchdog: Some(watchdog),
            shm_path,
        })
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
        if let Err(error) = std::fs::remove_file(&self.shm_path) {
            tracing::warn!(
                "OOP instrument shm removal failed {:?}: {error}",
                self.shm_path
            );
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
}
