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
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use orbit_audio_native::{BlockSource, BlockTransport};
use orbit_audio_sandbox::{
    open_shared, region_ptr, CommandMailboxHost, NeutralEvent, PipelinedInstrumentHost,
    TransportContext, UiEventPump, VoiceKey, BUF_LEN, CHANNELS, CONTROL_QUIT,
};

use crate::engine_wrap::PluginUiWiring;
use crate::outproc_respawn_guard::{
    advance_fast_respawn_streak, drain_ui_pump, poll_ui_pump_once, service_ui_pump_on_respawn,
};

const WATCHDOG_POLL: Duration = Duration::from_millis(20);
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const TEARDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const TRY_WAIT_ERROR_LIMIT: u32 = 50;
/// 「速い失敗」とみなす生存時間の閾値（#573）。`outproc_effect::FAST_RESPAWN_THRESHOLD` と同値・
/// 同じ理由（`CHILD_READY_TIMEOUT` より十分短く `WATCHDOG_POLL` よりずっと長い）。effect 側の
/// doc comment を参照。
const FAST_RESPAWN_THRESHOLD: Duration = Duration::from_secs(2);
/// 連続 fast-fail の上限（#573）。`outproc_effect::MAX_CONSECUTIVE_FAST_RESPAWNS` と同値・同じ理由。
const MAX_CONSECUTIVE_FAST_RESPAWNS: u32 = 5;
pub const NOTE_RING_CAPACITY: usize = 1024;
/// Fixed probe voice (A4 / port 0 / channel 0 / key 69) used by the gated cross-process
/// NOTE_END test. `pub` so the gated test references this instead of re-hardcoding the triple.
pub const PROBE_KEY: VoiceKey = VoiceKey {
    port_index: 0,
    channel: 0,
    key: 69,
};
fn transport_context(transport: &BlockTransport) -> TransportContext {
    const TEMPO_BPM: f64 = 120.0;
    let song_position_beats = if transport.sample_rate == 0 {
        0.0
    } else {
        transport.cursor_frames as f64 / transport.sample_rate as f64 * (TEMPO_BPM / 60.0)
    };
    TransportContext {
        tempo_bpm: TEMPO_BPM,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        is_playing: 1,
        is_looping: 0,
        song_position_beats,
    }
}

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
    /// eager start で host する plugin bundle のパス。post-boot attach は `LoadPlugin` で受け取る。
    pub plugin: Option<PathBuf>,
    pub plugin_id: Option<String>,
    pub buffer_frames: Option<u32>,
    /// 起動時に事前確保する instrument slot 数（#540 P1）。audio graph / shm / note ring は
    /// stream 起動時に固定で焼かれるため、複数 instrument は「N slot の事前確保 + LoadPlugin の
    /// instance 割当」で実現する（effect の per-bus slot と同じ方式）。
    pub slots: usize,
}

/// `ORBIT_OUTPROC_INSTRUMENT_SLOTS` の既定値。idle slot のコストは shm region と
/// engaged=false で即 return する block source のみ（child は LoadPlugin まで spawn しない）。
pub const DEFAULT_INSTRUMENT_SLOTS: usize = 8;
/// slot 数の上限（shm region とリングの事前確保が線形に増えるため暴走値を弾く）。
pub const MAX_INSTRUMENT_SLOTS: usize = 32;

impl OutProcInstrumentConfig {
    pub fn from_env() -> Result<Self, String> {
        let child_exe = match std::env::var_os("ORBIT_INSTRUMENT_CHILD_BIN") {
            Some(value) => PathBuf::from(value),
            None => default_child_exe()?,
        };
        let plugin = std::env::var_os("ORBIT_INSTRUMENT_PLUGIN").map(PathBuf::from);
        let plugin_id = std::env::var("ORBIT_INSTRUMENT_PLUGIN_ID").ok();
        let buffer_frames = parse_buffer_frames(
            std::env::var("ORBIT_INSTRUMENT_BUFFER_FRAMES")
                .ok()
                .as_deref(),
        );
        let slots = parse_instrument_slots(
            std::env::var("ORBIT_OUTPROC_INSTRUMENT_SLOTS")
                .ok()
                .as_deref(),
        );
        Ok(Self {
            child_exe,
            plugin,
            plugin_id,
            buffer_frames,
            slots,
        })
    }
}

/// `ORBIT_OUTPROC_INSTRUMENT_SLOTS` を [1, MAX] に clamp して解決する（純関数・unit テスト対象）。
/// 未設定・不正値は default（`parse_buffer_frames` と同じ「黙って壊さない」方針で warn のみ）。
fn parse_instrument_slots(value: Option<&str>) -> usize {
    let Some(value) = value else {
        return DEFAULT_INSTRUMENT_SLOTS;
    };
    match value.parse::<usize>() {
        Ok(slots) if (1..=MAX_INSTRUMENT_SLOTS).contains(&slots) => slots,
        _ => {
            tracing::warn!(
                "ORBIT_OUTPROC_INSTRUMENT_SLOTS='{value}' is invalid (want 1..={MAX_INSTRUMENT_SLOTS}); using default {DEFAULT_INSTRUMENT_SLOTS}"
            );
            DEFAULT_INSTRUMENT_SLOTS
        }
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

/// instrument child のフォーマット別デフォルト binary 名。VST3 だけが専用 child を持ち、
/// それ以外（.clap・raw .dylib CLAP 等）は従来どおり CLAP child が担当する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentPluginFormat {
    Clap,
    Vst3,
}

impl InstrumentPluginFormat {
    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-instrument-child",
            Self::Vst3 => "orbit-vst3-instrument-child",
        }
    }
}

/// attach する plugin の拡張子から instrument child binary を選ぶ（純関数・unit テスト対象）。
///
/// - `current_child_exe` の file name がフォーマット別デフォルト名（clap/vst3 child）で
///   ない場合は**明示指定と見なして触らない**（gated テストの config 直指定・
///   `ORBIT_INSTRUMENT_CHILD_BIN` override を保護）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは current_exe が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。retryable attach 失敗で
///   `ChildLaunch` が再利用されても、毎回この読み替えが走るので .vst3 → .clap の
///   attach し直しで元の child に戻る（対称・冪等）。
pub(crate) fn child_exe_for_attach(current_child_exe: &Path, plugin_path: &Path) -> PathBuf {
    // 規則そのものは effect と共有する（`outproc_child_exe`）。ここが持つのは
    // 「instrument の binary 名の対」だけ。
    crate::outproc_child_exe::child_exe_for_attach(
        current_child_exe,
        plugin_path,
        InstrumentPluginFormat::Clap.default_child_name(),
        InstrumentPluginFormat::Vst3.default_child_name(),
    )
}

fn default_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join(InstrumentPluginFormat::Clap.default_child_name()))
}

#[derive(Default)]
pub struct OutProcInstrumentStats {
    pub initial_attach_pending: AtomicBool,
    pub fresh: AtomicU64,
    pub callback_count: AtomicU64,
    pub respawn_count: AtomicU64,
    /// Slot tenant handoff generation. Unlike `respawn_count`, this does not report a watchdog
    /// respawn; it only asks the RT host to discard tenant-local voice bookkeeping.
    pub tenant_generation: AtomicU64,
    /// 直近 respawn のタイムスタンプ（supervisor 起動からの経過 ns・0 = 未 respawn）。#573 の
    /// fast-fail 検知が直前 spawn の生存時間を測るのに使う。`outproc_effect::OutProcEffectStats`
    /// の同名フィールドと同じ意味論。
    pub last_respawn_ns: AtomicU64,
    /// watchdog が supervise を諦めた（respawn 失敗 / try_wait 連続失敗 / #573: 起動直後に死に続ける
    /// child の respawn を連続上限で打ち切った）= 計測無効。gated harness が verdict を捨てる。
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
    /// child が decode できなかった input event / 未対応 `NeutralEvent` variant の数。
    /// `SharedRegion::event_decode_error_count` のミラー(他カウンタと同じ mirror パターン)。
    pub event_decode_error_count: AtomicU64,
    /// Gated cross-process probe: A4 (port 0 / channel 0 / key 69) の host-side live voice 数。
    pub probe_live_count: AtomicU16,
    /// Instrument source 出力の abs peak を f32 bits で累積する。非負 f32 の bits は
    /// u32 として単調なので、audio thread から `fetch_max` で lock-free に更新できる。
    pub post_peak_bits: AtomicU32,
    pub current_child_pid: AtomicU32,
    /// 初回 attach 中の child exit（**事実と理由の対**）。詳細は
    /// [`crate::outproc_child_exit::ChildEarlyExit`]。
    ///
    /// 🔴 **struct の末尾に置くこと。** 中身に `Mutex` を含むので、RT が毎コールバック触る
    /// atomic 群（`fresh` / `callback_count` 等）と同じキャッシュラインに乗せない。
    pub child_early_exit: crate::outproc_child_exit::ChildEarlyExit,
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
            last_respawn_ns: self.last_respawn_ns.load(Ordering::Relaxed),
            measurement_invalid: self.measurement_invalid.load(Ordering::Relaxed),
            child_process_error_count: self.child_process_error_count.load(Ordering::Relaxed),
            output_event_dropped_count: self.output_event_dropped_count.load(Ordering::Relaxed),
            output_event_spilled_count: self.output_event_spilled_count.load(Ordering::Relaxed),
            output_note_end_dropped_count: self
                .output_note_end_dropped_count
                .load(Ordering::Relaxed),
            event_decode_error_count: self.event_decode_error_count.load(Ordering::Relaxed),
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
    pub last_respawn_ns: u64,
    pub measurement_invalid: bool,
    pub child_process_error_count: u64,
    pub output_event_dropped_count: u64,
    pub output_event_spilled_count: u64,
    pub output_note_end_dropped_count: u64,
    pub event_decode_error_count: u64,
    pub probe_live_count: u16,
    pub post_peak: f32,
    pub current_child_pid: u32,
}

pub struct OutProcInstrumentBlockSource {
    host: PipelinedInstrumentHost,
    event_rx: rtrb::Consumer<NeutralEvent>,
    event_scratch: Vec<NeutralEvent>,
    audio_scratch: Vec<f32>,
    output_len: usize,
    /// PR-431: child が未 attach（post-boot attach 待ち）の間は出力なしにする安全弁。
    /// **本 PR では常に true で構築される**（既存起動経路は eager attach のまま無変更）。
    /// PR-1b で post-boot attach 実装時に false スタートさせる想定（詳細は Issue #431 参照）。
    engaged: Arc<AtomicBool>,
    signals: SlotSignals,
    stats: Arc<OutProcInstrumentStats>,
    /// Last supervisor generation observed by the audio thread. This field has exactly one reader
    /// and writer (`process`) and therefore needs no atomic synchronization of its own.
    last_respawn_count: u64,
    /// Last tenant handoff generation observed by the audio thread; same single-thread ownership.
    last_tenant_generation: u64,
}

pub struct SlotSignals {
    pub teardown_requested: Arc<AtomicBool>,
    pub teardown_done: Arc<AtomicBool>,
    /// #618: slot tenant 差し替え時、control thread が event ring の全残渣破棄を要求する。
    pub drain_requested: Arc<AtomicBool>,
    /// #618: `event_rx` を空にした後に audio thread が publish する決定論的 ack。
    pub drain_done: Arc<AtomicBool>,
}

impl OutProcInstrumentBlockSource {
    /// `host` = mmap を所有する production 構築子（`PipelinedInstrumentHost::from_mmap`）で作った
    /// host、`event_rx` = note event の受け側（`event_capacity` はその scratch buffer 分の容量）、
    /// `engaged` = child の post-boot attach 完了までの安全弁（本 PR では常に `true` で渡される）、
    /// `signals` = supervisor / replacement control と共有する協調フラグ、`stats` = 観測ミラー。
    pub fn new(
        host: PipelinedInstrumentHost,
        event_rx: rtrb::Consumer<NeutralEvent>,
        event_capacity: usize,
        engaged: Arc<AtomicBool>,
        signals: SlotSignals,
        stats: Arc<OutProcInstrumentStats>,
    ) -> Self {
        Self {
            host,
            event_rx,
            event_scratch: Vec::with_capacity(event_capacity),
            audio_scratch: vec![0.0; BUF_LEN],
            output_len: 0,
            engaged,
            signals,
            stats,
            last_respawn_count: 0,
            last_tenant_generation: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn into_event_rx_for_test(self) -> rtrb::Consumer<NeutralEvent> {
        self.event_rx
    }

    #[cfg(test)]
    pub(crate) fn probe_live_count_for_test(&self) -> u16 {
        self.host.live_count(PROBE_KEY)
    }
}

impl BlockSource for OutProcInstrumentBlockSource {
    fn render(&mut self, frames: usize, transport: &BlockTransport) -> usize {
        self.output_len = 0;
        if self.signals.teardown_requested.load(Ordering::Acquire) {
            self.signals.teardown_done.store(true, Ordering::Release);
            return 0;
        }
        // #618: tenant を切り替える slot は disengage 済みなので、旧 tenant の event を child へ
        // 渡さず全件捨てる。ack は consumer が ring を空にした後だけ publish する。
        if self.signals.drain_requested.load(Ordering::Acquire) {
            while self.event_rx.pop().is_ok() {}
            self.signals.drain_done.store(true, Ordering::Release);
            return 0;
        }
        if !self.engaged.load(Ordering::Acquire) {
            return 0;
        }

        let respawn_count = self.stats.respawn_count.load(Ordering::Relaxed);
        let tenant_generation = self.stats.tenant_generation.load(Ordering::Relaxed);
        if respawn_count != self.last_respawn_count
            || tenant_generation != self.last_tenant_generation
        {
            self.host.on_child_respawned();
            self.last_respawn_count = respawn_count;
            self.last_tenant_generation = tenant_generation;
        }

        self.event_scratch.clear();
        while let Ok(event) = self.event_rx.pop() {
            self.event_scratch.push(event);
        }

        let process_len = frames
            .saturating_mul(CHANNELS)
            .min(self.audio_scratch.len());
        let scratch = &mut self.audio_scratch[..process_len];
        // No zero-fill needed here: `process_block` unconditionally overwrites every sample of
        // `scratch` (fresh copy, stale repeat, or silence), so any prior content is fully
        // clobbered regardless of branch taken.
        self.host
            .process_block(scratch, &self.event_scratch, transport_context(transport));
        // `process_block` drains child output events before returning. Publish the resulting
        // host bookkeeping state for the fixed gated-test probe voice.
        self.stats
            .probe_live_count
            .store(self.host.live_count(PROBE_KEY), Ordering::Relaxed);

        let peak_bits_value = crate::peak_bits(scratch);
        self.stats
            .post_peak_bits
            .fetch_max(peak_bits_value, Ordering::Relaxed);

        self.stats.fresh.store(self.host.fresh, Ordering::Relaxed);
        self.stats.callback_count.fetch_add(1, Ordering::Relaxed);
        self.output_len = process_len;
        1
    }

    fn output(&self, unit: usize) -> &[f32] {
        if unit == 0 {
            &self.audio_scratch[..self.output_len]
        } else {
            &[]
        }
    }
}

/// child の起動コマンドを組み立てる純関数（unit テスト対象・#542 レビュー: `--state` の
/// 有無を含む引数構築を spawn から分離してピン留めできるようにする）。
fn instrument_child_command(
    child_exe: &Path,
    shm_path: &Path,
    plugin: &Path,
    plugin_id: Option<&str>,
    sample_rate: u32,
    state: Option<&Path>,
) -> Command {
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
    // #540 P2: 保存済み state。respawn 経路もここを通るため、respawn 後も音色が復元される。
    if let Some(state) = state {
        command.arg("--state").arg(state);
    }
    command
}

pub fn spawn_instrument_child(
    child_exe: &Path,
    shm_path: &Path,
    plugin: &Path,
    plugin_id: Option<&str>,
    sample_rate: u32,
    state: Option<&Path>,
) -> io::Result<Child> {
    instrument_child_command(child_exe, shm_path, plugin, plugin_id, sample_rate, state).spawn()
}

fn reap(child: &mut Child, child_name: &str) {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::yield_now(),
            Ok(None) => {
                tracing::warn!("{child_name} did not exit within {REAP_TIMEOUT:?}; killing");
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
        first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcInstrumentStats>,
        child_exe: PathBuf,
        plugin: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
        state: Option<PathBuf>,
    ) -> io::Result<Self> {
        let mailbox = Arc::new(CommandMailboxHost::new(shm_path.clone()));
        let ui_pump = Arc::new(UiEventPump::new(shm_path.clone()));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        Self::spawn_with_mailbox(
            first_child,
            shm_path,
            stats,
            child_exe,
            plugin,
            plugin_id,
            sample_rate,
            Arc::new(Mutex::new(state)),
            mailbox,
            PluginUiWiring {
                pump: ui_pump,
                target: ui_target,
                index_binding: None,
                events: ui_events,
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_with_mailbox(
        mut first_child: Child,
        shm_path: PathBuf,
        stats: Arc<OutProcInstrumentStats>,
        child_exe: PathBuf,
        plugin: PathBuf,
        plugin_id: Option<String>,
        sample_rate: u32,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> io::Result<Self> {
        let PluginUiWiring {
            pump: ui_pump,
            target: ui_target,
            index_binding,
            events: ui_events,
        } = ui;
        debug_assert!(
            index_binding.is_none(),
            "instrument UI wiring has no rack binding"
        );
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
        // #552 と対称: VST3 / CLAP どちらの child かをログに出す（決め打ちだと VST3 child の
        // クラッシュが CLAP child の障害に見える）。
        let child_name_wd =
            crate::outproc_child_exe::exe_label(&child_exe, "orbit-instrument-child");
        // #573: `last_respawn_ns` の基準時刻（初回 child の spawn とほぼ同時刻）。effect 側と同じ。
        let base = Instant::now();
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
                // #573: 連続 fast-fail（`FAST_RESPAWN_THRESHOLD` 未満で死んだ respawn）の回数。
                // `FAST_RESPAWN_THRESHOLD` 以上生きた respawn（正常な単発クラッシュからの復帰）でリセット。
                let mut consecutive_fast_fails: u32 = 0;
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
                    let event_decode_errors =
                        unsafe { (*region).event_decode_error_count.load(Ordering::Relaxed) };
                    stats
                        .event_decode_error_count
                        .store(event_decode_errors, Ordering::Relaxed);

                    match child.try_wait() {
                        Ok(Some(_)) if shutdown_thread.load(Ordering::Acquire) => break,
                        Ok(Some(status)) => {
                            try_wait_errors = 0;
                            // READY の publish は host が initial_attach_pending をクリアする処理と競合する:
                            // child は READY を publish した直後にその窓で crash しうる。pre-READY の exit の
                            // みが attach fast-fail であり、post-READY の exit は通常の respawn 経路に到達
                            // しなければならない（さもないと host が死んだ Active slot を install しうる）。
                            if stats.initial_attach_pending.load(Ordering::Acquire)
                                && unsafe {
                                    (*region).child_status.load(Ordering::Acquire)
                                        != orbit_audio_sandbox::transport::CHILD_STATUS_READY
                                }
                            {
                                tracing::warn!(plugin = ?plugin, "{child_name_wd} exited during initial attach ({status})");
                                stats.child_early_exit.record(status);
                                break;
                            }
                            // #573: 起動直後に死に続ける child を tight loop で respawn し続けない。
                            // `last_respawn_ns`（初期値 0 = supervisor 起動時刻 `base`）からの経過時間で
                            // 直前 spawn の生存時間を測る。
                            let elapsed_since_spawn = base.elapsed().saturating_sub(
                                Duration::from_nanos(stats.last_respawn_ns.load(Ordering::Relaxed)),
                            );
                            consecutive_fast_fails = advance_fast_respawn_streak(
                                consecutive_fast_fails,
                                elapsed_since_spawn,
                                FAST_RESPAWN_THRESHOLD,
                            );
                            if consecutive_fast_fails >= MAX_CONSECUTIVE_FAST_RESPAWNS {
                                tracing::error!(
                                    plugin = ?plugin,
                                    "{child_name_wd} exited {consecutive_fast_fails} times in a row \
                                     within less than {FAST_RESPAWN_THRESHOLD:?} of being spawned \
                                     (last exit status: {status}); giving up on the respawn loop \
                                     (measurement invalid)"
                                );
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            tracing::warn!(
                                plugin = ?plugin,
                                "{child_name_wd} exited ({status}); respawning"
                            );
                            // 旧 child の死亡確認後にだけ command failure/reset を行う。
                            if !service_ui_pump_on_respawn(
                                "instrument",
                                &ui_pump,
                                &mailbox,
                                &ui_target,
                                None,
                                &ui_events,
                            ) {
                                stats.measurement_invalid.store(true, Ordering::Release);
                                break;
                            }
                            let state = match latest_state.lock() {
                                Ok(state) => state.clone(),
                                Err(_) => {
                                    tracing::error!(
                                        plugin = ?plugin,
                                        "instrument latest-state mutex poisoned; measurement invalid"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            };
                            match spawn_instrument_child(
                                &child_exe,
                                &watchdog_shm_path,
                                &plugin,
                                plugin_id.as_deref(),
                                sample_rate,
                                state.as_deref(),
                            ) {
                                Ok(replacement) => {
                                    stats
                                        .current_child_pid
                                        .store(replacement.id(), Ordering::Relaxed);
                                    child = replacement;
                                    stats.respawn_count.fetch_add(1, Ordering::Relaxed);
                                    stats
                                        .last_respawn_ns
                                        .store(base.elapsed().as_nanos() as u64, Ordering::Relaxed);
                                    // The audio-thread adapter observes this generation counter
                                    // and resets its host-side voice bookkeeping on its next block.
                                }
                                Err(error) => {
                                    tracing::error!(
                                        plugin = ?plugin,
                                        "instrument child respawn failed; measurement invalid: {error}"
                                    );
                                    stats.measurement_invalid.store(true, Ordering::Release);
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            try_wait_errors = 0;
                            poll_ui_pump_once(
                                "instrument",
                                &ui_pump,
                                &ui_target,
                                None,
                                &ui_events,
                            );
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
                drain_ui_pump("instrument", &ui_pump, &ui_target, None, &ui_events);
                unsafe {
                    (*region).control.store(CONTROL_QUIT, Ordering::Release);
                }
                reap(&mut child, &child_name_wd);
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

    /// shm の unlink 所有権を `ChildLaunch` に残したまま supervisor を teardown する（retry 用）。
    /// 本体は `unlink_shm` を倒すだけで、stop/reap は値渡しで consume した self の即時 Drop が行う。
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
    use orbit_audio_native::{BlockSource, BlockTransport};
    use orbit_audio_sandbox::{slot_index, VoiceAddr, VoiceKey, CHANNELS};
    use std::sync::Mutex;

    static INSTRUMENT_PLUGIN_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn from_env_allows_plugin_to_be_unset_for_post_boot_attach() {
        let _guard = INSTRUMENT_PLUGIN_ENV_LOCK
            .lock()
            .expect("instrument env mutex");
        let previous = std::env::var_os("ORBIT_INSTRUMENT_PLUGIN");
        std::env::remove_var("ORBIT_INSTRUMENT_PLUGIN");

        let config = OutProcInstrumentConfig::from_env().expect("plugin path is optional at boot");

        if let Some(value) = previous {
            std::env::set_var("ORBIT_INSTRUMENT_PLUGIN", value);
        }
        assert_eq!(config.plugin, None);
    }

    fn engaged(value: bool) -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(value))
    }

    fn render_source(source: &mut OutProcInstrumentBlockSource, frames: usize) -> usize {
        source.render(
            frames,
            &BlockTransport {
                cursor_frames: 0,
                sample_rate: 48_000,
            },
        )
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
    fn note_round_trip_exposes_instrument_as_block_source_output() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let ctl_mmap = open_shared(&path).expect("open control mapping");
        let region = region_ptr(&ctl_mmap);
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (mut event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let requested = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let mut processor = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            SlotSignals {
                teardown_requested: requested,
                teardown_done: done,
                drain_requested: Arc::new(AtomicBool::new(false)),
                drain_done: Arc::new(AtomicBool::new(false)),
            },
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

        let transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };
        assert_eq!(processor.render(8, &transport), 1);
        assert!(processor.output(0).iter().all(|sample| *sample == 0.0));
        assert_eq!(
            stats.probe_live_count.load(Ordering::Relaxed),
            1,
            "probe must mirror host voice bookkeeping after NoteOn"
        );
        unsafe {
            let slot = slot_index(1);
            assert_eq!((*region).input_events[slot][0].decode(), Some(note));
            let output = std::ptr::addr_of_mut!((*region).output) as *mut f32;
            for index in 0..8 * CHANNELS {
                *output.add(slot * BUF_LEN + index) = 0.25;
            }
            (*region).output_event_count[slot].store(0, Ordering::Relaxed);
            (*region).seq_tag[slot].store(1, Ordering::Release);
            (*region).seq_done.store(1, Ordering::Release);
        }

        assert_eq!(processor.render(8, &transport), 1);
        assert!(processor.output(0).iter().all(|sample| *sample == 0.25));
        assert_eq!(
            f32::from_bits(stats.post_peak_bits.load(Ordering::Relaxed)),
            0.25,
            "post peak must be measured from the source output"
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
        let mut processor = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            SlotSignals {
                teardown_requested: Arc::new(AtomicBool::new(false)),
                teardown_done: Arc::new(AtomicBool::new(false)),
                drain_requested: Arc::new(AtomicBool::new(false)),
                drain_done: Arc::new(AtomicBool::new(false)),
            },
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

        render_source(&mut processor, 8);
        assert_eq!(
            processor.host.live_count(key),
            1,
            "initial generation zero must not be misdetected as a respawn"
        );

        render_source(&mut processor, 8);
        assert_eq!(
            processor.host.live_count(key),
            1,
            "unchanged generation must not reset voices every block"
        );

        stats.respawn_count.store(1, Ordering::Relaxed);
        render_source(&mut processor, 8);
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

    // pr-test-analyzer (item 4, PR #422 review): `OutProcInstrumentBlockSource::render()`'s
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
        let mut processor = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(true),
            SlotSignals {
                teardown_requested: requested,
                teardown_done: done.clone(),
                drain_requested: Arc::new(AtomicBool::new(false)),
                drain_done: Arc::new(AtomicBool::new(false)),
            },
            stats.clone(),
        );

        assert_eq!(render_source(&mut processor, 8), 0);

        assert!(
            done.load(Ordering::Acquire),
            "teardown_requested early return must set teardown_done"
        );
        assert!(
            processor.output(0).is_empty(),
            "teardown early return must expose no source output"
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
        let mut processor = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(false),
            SlotSignals {
                teardown_requested: Arc::new(AtomicBool::new(false)),
                teardown_done: Arc::new(AtomicBool::new(false)),
                drain_requested: Arc::new(AtomicBool::new(false)),
                drain_done: Arc::new(AtomicBool::new(false)),
            },
            stats.clone(),
        );

        assert_eq!(render_source(&mut processor, 8), 0);

        assert!(processor.output(0).is_empty());
        assert_eq!(stats.callback_count.load(Ordering::Relaxed), 0);
        assert_eq!(
            processor.event_rx.pop(),
            Ok(note),
            "disengaged 中は event ring を drain せず、note がそのまま残っている"
        );

        drop(processor);
        std::fs::remove_file(path).expect("remove shared memory");
    }

    #[test]
    fn replacement_drain_discards_all_events_and_acks_while_disengaged() {
        let path = unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&path).expect("create shared memory");
        let host = PipelinedInstrumentHost::from_mmap(host_mmap);
        let (mut event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let note = NeutralEvent::NoteOn {
            sample_offset: 0,
            addr: VoiceAddr {
                note_id: -1,
                port_index: 0,
                channel: 0,
                key: 72,
                _pad: 0,
            },
            velocity: 0.8,
            tuning_cents: 0.0,
            length_frames: 0,
        };
        event_tx.push(note).expect("push first stale note");
        event_tx.push(note).expect("push second stale note");
        let drain_requested = Arc::new(AtomicBool::new(true));
        let drain_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let mut processor = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged(false),
            SlotSignals {
                teardown_requested: Arc::new(AtomicBool::new(false)),
                teardown_done: Arc::new(AtomicBool::new(false)),
                drain_requested,
                drain_done: drain_done.clone(),
            },
            stats.clone(),
        );

        assert_eq!(render_source(&mut processor, 8), 0);

        assert!(drain_done.load(Ordering::Acquire));
        assert!(
            processor.event_rx.pop().is_err(),
            "drain ack must only publish after every stale event is discarded"
        );
        assert!(processor.output(0).is_empty());
        assert_eq!(stats.callback_count.load(Ordering::Relaxed), 0);

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

    /// コミット済み fixture はテスト中に write-open しないため、exec 対象 inode に
    /// ETXTBSY の前提となる書き込み fd が存在しない。
    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn respawn_argument_recorder() -> PathBuf {
        fixture("record-respawn-args.sh")
    }

    fn respawn_args_path(shm: &Path) -> PathBuf {
        let mut path = shm.as_os_str().to_os_string();
        path.push(".respawn-args");
        path.into()
    }

    fn invocation_count_path(shm: &Path) -> PathBuf {
        let mut path = shm.as_os_str().to_os_string();
        path.push(".invocation-count");
        path.into()
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
            None,
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
        let first = crate::outproc_stub_child::stub_child_command()
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
            None,
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
    //
    // #573: respawn 先は元々 bare `sleep`（transport 引数を数値と誤解して即 exit → fast respawn
    // loop）だった。fast-fail 対策導入前は無害な副作用だったが、導入後はこの respawn 先自体が
    // 「起動直後に死に続ける child」に該当し `MAX_CONSECUTIVE_FAST_RESPAWNS` 回で watchdog が
    // 諦めてしまう（`measurement_invalid` が立ち、本テストの assertion と矛盾する）。respawn
    // 成功の状態機械だけを検証したいので、引数を無視して生き続ける stub script に差し替える。
    #[test]
    fn supervisor_respawns_child_on_unexpected_exit() {
        let shm = make_shm();
        let stats = OutProcInstrumentStats::new();
        // #441 の regression: attach 保留中の post-READY crash は respawn しなければならない。
        stats.initial_attach_pending.store(true, Ordering::Release);
        let mmap = open_shared(&shm).expect("open shm to publish READY");
        let region = region_ptr(&mmap);
        // SAFETY: mmap はこのテストの生存する shared region を所有する。
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, false) };
        let first = Command::new("sleep")
            .arg("0.2")
            .spawn()
            .expect("spawn stub child");
        let first_pid = first.id();
        // 引数（--shm/--plugin/--sample-rate）を無視して生き続ける respawn 先（spawn は成功 =
        // respawn_count++、かつ #573 の fast-fail 検知に引っかからない）。
        let respawn_target = fixture("slow-child.sh");
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            respawn_target.clone(),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
            None,
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

    // #573: この respawn 先の script は元々 `sleep 0.2` で自分から終了していた。すると
    // watchdog がそれを異常終了として検知して**さらに respawn**してしまい、「どの respawn の
    // 記録を掴むか」がタイミング依存になっていた（fast-fail 対策の導入で連続 fast-fail の上限に
    // 達し respawn 自体が止まってしまう可能性もある）。長寿命（記録後は寝続ける）にすることで
    // respawn が「初回 child の強制 kill による1回」だけに確定し、決定論的なテストになる。
    #[test]
    fn supervisor_respawn_passes_the_state_saved_after_initial_spawn() {
        let fixture_dir = std::env::temp_dir().join(format!(
            "orbit-instrument-respawn-state-{}-{}",
            std::process::id(),
            SHM_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&fixture_dir).expect("create respawn fixture directory");
        let child_script = respawn_argument_recorder();

        let shm = make_shm();
        let args_path = respawn_args_path(&shm);
        let stats = OutProcInstrumentStats::new();
        let first = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn initial stub child");
        let first_pid = first.id();
        let latest_state = Arc::new(Mutex::new(None));
        let mailbox = Arc::new(CommandMailboxHost::new(shm.clone()));
        let ui_pump = Arc::new(UiEventPump::new(shm.clone()));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let sup = InstrumentChildSupervisor::spawn_with_mailbox(
            first,
            shm.clone(),
            stats.clone(),
            child_script,
            PathBuf::from("/ignored-instrument.clap"),
            None,
            48_000,
            latest_state.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump,
                target: ui_target,
                index_binding: None,
                events: ui_events,
            },
        )
        .expect("supervisor spawn");

        let saved_state = fixture_dir.join("saved-after-spawn.state");
        let expected_state = b"saved state".to_vec();
        let responder_shm = shm.clone();
        let responder_state = expected_state.clone();
        let responder = std::thread::spawn(move || {
            let mmap = open_shared(&responder_shm).expect("open responder mapping");
            let region = region_ptr(&mmap);
            let deadline = Instant::now() + Duration::from_secs(2);
            let seq = loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq != 0 {
                    break seq;
                }
                assert!(Instant::now() < deadline, "host did not publish SAVE_STATE");
                std::thread::yield_now();
            };
            let sidecar = unsafe {
                orbit_audio_sandbox::transport::read_cstr_field(&(*region).cmd_arg)
                    .expect("valid sidecar path")
                    .to_owned()
            };
            std::fs::write(&sidecar, &responder_state).expect("write saved state sidecar");
            unsafe {
                (*region)
                    .cmd_result_len
                    .store(responder_state.len() as u64, Ordering::Relaxed);
                (*region)
                    .cmd_result
                    .store(orbit_audio_sandbox::CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });
        let response = mailbox
            .issue_save_state(&saved_state)
            .expect("mailbox state save succeeds after initial spawn");
        responder.join().expect("state save responder");
        assert_eq!(response.bytes_written, expected_state.len() as u64);
        assert_eq!(
            std::fs::read(&saved_state).expect("read successful saved state"),
            expected_state
        );
        crate::engine_wrap::record_latest_state_after_save(&latest_state, saved_state.clone())
            .expect("record latest state after successful save");

        assert!(
            Command::new("kill")
                .args(["-9", &first_pid.to_string()])
                .status()
                .expect("kill initial child")
                .success(),
            "initial child must be forcibly terminated"
        );
        assert!(
            poll_until(5, || args_path.exists()
                && stats.respawn_count.load(Ordering::Relaxed) >= 1),
            "watchdog did not respawn through the argument recorder"
        );
        let args: Vec<String> = std::fs::read_to_string(&args_path)
            .expect("read respawn arguments")
            .lines()
            .map(str::to_owned)
            .collect();
        let state_index = args
            .iter()
            .position(|argument| argument == "--state")
            .expect("respawn must receive --state");
        assert_eq!(
            args.get(state_index + 1).map(String::as_str),
            saved_state.to_str(),
            "--state must be immediately followed by the state saved after initial spawn"
        );

        drop(sup);
        std::fs::remove_dir_all(fixture_dir).expect("remove respawn fixture directory");
        let _ = std::fs::remove_file(args_path);
        let _ = std::fs::remove_file(shm);
    }

    // #573: 起動直後に死に続ける child を watchdog が tight loop で respawn し続けない。respawn 先を
    // 即死する `true` にして、`MAX_CONSECUTIVE_FAST_RESPAWNS` 回連続の速い失敗で respawn をやめる
    // （measurement_invalid を立てて break する）ことを検証する。effect 側
    // `supervisor_stops_respawning_after_consecutive_fast_failures` のミラー。
    //
    // 変異検証: 上限判定（`consecutive_fast_fails >= MAX_CONSECUTIVE_FAST_RESPAWNS` の break）を
    // 外すと `true` が即死し続けるので respawn_count は無限に増え続け、「頭打ちで安定する」
    // assertion が red になる（実測は本 PR の報告を参照）。
    #[test]
    fn supervisor_stops_respawning_after_consecutive_fast_failures() {
        let shm = make_shm();
        let stats = OutProcInstrumentStats::new();
        let first = Command::new("true")
            .spawn()
            .expect("spawn immediately-exiting stub");
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            PathBuf::from("true"),
            PathBuf::from("/ignored.clap"),
            None,
            48_000,
            None,
        )
        .expect("supervisor spawn");

        let gave_up = poll_until(5, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(
            gave_up,
            "consecutive fast failures must trip measurement_invalid"
        );

        let stopped_at = stats.respawn_count.load(Ordering::Relaxed);
        assert_eq!(
            stopped_at,
            (MAX_CONSECUTIVE_FAST_RESPAWNS - 1) as u64,
            "respawn must stop exactly MAX_CONSECUTIVE_FAST_RESPAWNS-1 respawns after the \
             fast-failing streak begins (the Nth death that reaches the limit does not spawn \
             a replacement)"
        );
        // 打ち切り後も respawn_count が増え続けていないこと（本当に止まった証拠。tight loop の
        // 再発を検出する）。
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            stats.respawn_count.load(Ordering::Relaxed),
            stopped_at,
            "respawn_count must not keep climbing after the watchdog gave up"
        );

        drop(sup);
        let _ = std::fs::remove_file(&shm);
    }

    // #573: 単発クラッシュ（`FAST_RESPAWN_THRESHOLD` 以上生きてから死ぬ）は連続 fast-fail カウンタを
    // リセットする——壊れた child だと誤判定されず従来どおり復帰し続けられる。3 回目の起動だけ
    // 2.2s 生きてから死ぬ script を使い、reset の前後に fast fail を積んで検証する（2 fast fails →
    // 1 survivor(reset) → 4 fast fails = 7 respawn 後に 2 度目のストリークで上限に達する）。effect 側
    // `supervisor_resets_fast_fail_streak_after_a_survivor` のミラー。
    //
    // 変異検証: リセット（`advance_fast_respawn_streak` の `else 0`）を「常に加算する」よう変異させると、
    // 3 回目の survivor 死も加算されてしまい、合算が本来より早く上限へ達する。respawn_count は 7 では
    // なく 4 で頭打ちになり、`final_respawn_count == 7` assertion が red になる（実測は本 PR の報告を
    // 参照）。
    #[test]
    fn supervisor_resets_fast_fail_streak_after_a_survivor() {
        let shm = make_shm();
        let count_path = invocation_count_path(&shm);
        let script = fixture("variable-lifetime-child.sh");
        let slow_at = PathBuf::from("3");
        let stats = OutProcInstrumentStats::new();
        let first = spawn_instrument_child(&script, &shm, &slow_at, None, 48_000, None)
            .expect("spawn variable-lifetime stub (invocation 1)");
        let sup = InstrumentChildSupervisor::spawn(
            first,
            shm.clone(),
            stats.clone(),
            script.clone(),
            slow_at,
            None,
            48_000,
            None,
        )
        .expect("supervisor spawn");

        let gave_up = poll_until(10, || stats.measurement_invalid.load(Ordering::Acquire));
        assert!(
            gave_up,
            "the second fast-fail streak (after the reset) must eventually trip the breaker too"
        );
        assert_eq!(
            stats.respawn_count.load(Ordering::Relaxed),
            7,
            "2 fast fails + 1 survivor (reset) + 4 fast fails must respawn exactly 7 times before \
             giving up (without the reset, the streak would trip the breaker after only 4 respawns)"
        );

        drop(sup);
        let _ = std::fs::remove_file(count_path);
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
            None,
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
    #[test]
    fn instrument_plugin_format_selects_child_name_from_extension() {
        // 内部の format 判定ではなく**公開の入口**を通す（実際に attach で使われる経路）。
        let current = Path::new("/opt/orbit/bin/orbit-clap-instrument-child");
        let child_for = |plugin: &str| {
            child_exe_for_attach(current, Path::new(plugin))
                .file_name()
                .and_then(|name| name.to_str())
                .expect("child name")
                .to_owned()
        };
        assert_eq!(child_for("synth.clap"), "orbit-clap-instrument-child");
        assert_eq!(child_for("synth.VST3"), "orbit-vst3-instrument-child");
        // 未知拡張子は CLAP へフォールバック（raw .dylib の CLAP を attach する gated テストがある）。
        assert_eq!(
            child_for("libclap_test_synth.dylib"),
            "orbit-clap-instrument-child"
        );
    }

    #[test]
    fn child_exe_for_attach_swaps_default_names_in_place_and_is_symmetric() {
        let clap = PathBuf::from("/target/debug/orbit-clap-instrument-child");
        let vst3 = PathBuf::from("/target/debug/orbit-vst3-instrument-child");
        // .vst3 attach はデフォルト CLAP child を同ディレクトリの VST3 child に読み替える。
        assert_eq!(child_exe_for_attach(&clap, Path::new("synth.vst3")), vst3);
        // retryable attach 失敗で child_exe が VST3 に書き換わったまま .clap を attach し直しても
        // CLAP child に戻る（対称・冪等）。
        assert_eq!(child_exe_for_attach(&vst3, Path::new("synth.clap")), clap);
        assert_eq!(child_exe_for_attach(&vst3, Path::new("synth.vst3")), vst3);
    }

    #[test]
    fn child_exe_for_attach_preserves_explicit_non_default_binaries() {
        let custom = PathBuf::from("/tmp/gated-instrument-child");
        assert_eq!(
            child_exe_for_attach(&custom, Path::new("synth.vst3")),
            custom,
            "explicit child exe (env override / test fixture) must be retained"
        );
    }

    /// #540 P2（#542 レビュー test-gap）: `--state` 引数の構築をピン留めする。
    /// respawn 経路も同じ builder を通るため、この契約が「state が respawn を生き延びる」の
    /// コマンド構築レベルの証明になる（実機レベルは gated テストが担う）。
    #[test]
    fn instrument_child_command_includes_state_only_when_given() {
        use std::ffi::OsStr;
        let args_of = |state: Option<&Path>| -> Vec<String> {
            instrument_child_command(
                Path::new("/bin/child"),
                Path::new("/tmp/shm"),
                Path::new("/plugins/synth.vst3"),
                Some("plugin-id"),
                48_000,
                state,
            )
            .get_args()
            .map(|arg: &OsStr| arg.to_string_lossy().into_owned())
            .collect()
        };

        let with_state = args_of(Some(Path::new("/songs/kick.vstpreset")));
        let state_flag = with_state
            .iter()
            .position(|arg| arg == "--state")
            .expect("--state flag present when state is Some");
        assert_eq!(
            with_state.get(state_flag + 1).map(String::as_str),
            Some("/songs/kick.vstpreset"),
            "--state must be immediately followed by the state path"
        );

        let without_state = args_of(None);
        assert!(
            !without_state.iter().any(|arg| arg == "--state"),
            "--state must be omitted when state is None (child would treat an empty value as \
             an unsupported argument)"
        );
        // state の有無で他の引数は不変（--state ペア以外が同一）。
        let stripped: Vec<_> = with_state
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != state_flag && *i != state_flag + 1)
            .map(|(_, arg)| arg.clone())
            .collect();
        assert_eq!(stripped, without_state);
    }
}
