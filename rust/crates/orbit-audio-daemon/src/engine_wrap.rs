//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! `Arc<Mutex>` ベースで制御スレッドと audio callback を共有する。
//! audio callback 側は `try_lock` で競合時に無音 fallback する前提（lock-free 化は別 Issue）。

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::sync::MutexGuard;
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::sync::Weak;
use std::sync::{Arc, Mutex};
#[cfg(any(
    feature = "clap-host",
    feature = "outproc-effect",
    feature = "outproc-instrument"
))]
use std::time::Duration;

use orbit_audio_core::{resolve_slice_region, sanitize_rate, Engine, Sample};
#[cfg(feature = "outproc-effect")]
use orbit_audio_native::{
    decode_bus_routing_sentinel, default_bus_line_ops, default_master_line_ops, legacy_line_ops,
    BusSend, BusTarget, LegacyLineInstaller, LineOp, LineOutput, LineProgram, LineProgramInstaller,
    OutputDest,
};
use orbit_audio_native::{
    load_sample_resampled, LoaderError, OutputDeviceRequest, OutputError, OutputFault,
    OutputStream, ResampleError, StreamStats, StreamStatsSnapshot,
};
use uuid::Uuid;

use crate::backend::AudioBackend;

const OUTPUT_FAULT_ENV: &str = "ORBIT_AUDIO_OUTPUT_FAULT";

pub fn parse_output_fault(raw: Option<&str>) -> OutputFault {
    match raw.map(str::trim) {
        Some("dead-probe-requested" | "DeadProbeRequested") => OutputFault::DeadProbeRequested,
        Some("dead-all-probes" | "DeadAllProbes") => OutputFault::DeadAllProbes,
        Some("dead-real-stream" | "DeadRealStream") => OutputFault::DeadRealStream,
        Some("dead-real-stream-on-switch" | "DeadRealStreamOnSwitch") => {
            OutputFault::DeadRealStreamOnSwitch
        }
        _ => OutputFault::None,
    }
}

#[derive(Debug, Clone, Default, Eq, PartialEq)]
pub struct StartupOptions {
    pub device_name: Option<String>,
    pub fault: OutputFault,
}

impl StartupOptions {
    pub fn from_args_and_env<I: IntoIterator<Item = String>>(
        args: I,
        env_device_name: Option<&str>,
        allow_fault_injection: bool,
        fault_raw: Option<&str>,
    ) -> Self {
        let mut device_name = env_device_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            if arg == "--audio-device" {
                device_name = iter.next().filter(|name| !name.trim().is_empty());
            }
        }
        Self {
            device_name,
            fault: if allow_fault_injection {
                parse_output_fault(fault_raw)
            } else {
                OutputFault::None
            },
        }
    }

    pub fn from_env() -> Self {
        let allow_fault_injection =
            std::env::var("ORBIT_DAEMON_ALLOW_FAULT_INJECTION").as_deref() == Ok("1");
        let fault_raw = std::env::var(OUTPUT_FAULT_ENV).ok();
        let env_device_name = std::env::var("ORBIT_AUDIO_DEVICE").ok();
        Self::from_args_and_env(
            std::env::args().skip(1),
            env_device_name.as_deref(),
            allow_fault_injection,
            fault_raw.as_deref(),
        )
    }

    fn output_request(&self) -> OutputDeviceRequest {
        OutputDeviceRequest {
            name: self.device_name.clone(),
            fault: self.fault,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WrapError {
    #[error("audio output init failed: {0}")]
    Output(#[from] OutputError),
    #[error("loader error: {0}")]
    Loader(#[from] LoaderError),
    #[error("resample error: {0}")]
    Resample(#[from] ResampleError),
    #[error("sample not found: {0}")]
    SampleNotFound(String),
    #[error("scheduler error: {0}")]
    Scheduler(String),
    /// LinkAudio egress がこの daemon ビルド/インスタンスで利用できない（feature `link-audio` 無効、
    /// または test backend）。TS 層は feature-gap として warn-once で握り潰す（出力は hardware のみ）。
    #[error("link audio unavailable: {0}")]
    LinkAudioUnavailable(String),
    /// LinkAudio egress は利用可能だが registration が runtime で失敗した（channel 上限・consumer thread
    /// 不在・reg-ring 満杯・mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("link audio runtime error: {0}")]
    LinkAudio(String),
    /// CLAP plugin hosting がこの daemon ビルド/インスタンスで利用できない（feature `clap-host`
    /// 無効、または test backend）。TS 層は feature-gap として warn-once で握り潰す。
    #[error("clap host unavailable: {0}")]
    ClapUnavailable(String),
    /// CLAP plugin hosting は利用可能だが runtime で失敗した（load/activate 失敗・install ring 満杯・
    /// 専用スレッド不在・mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("clap host runtime error: {0}")]
    Clap(String),
    /// in-process CLAP host は単一 slot のため、先にロード済みの role と異なる再ロードを拒否する。
    #[error("clap cross-role load rejected: {0}")]
    ClapCrossRoleRejected(String),
    /// CLAP plugin hosting は利用可能だが、まだ一度も `load_plugin` に成功していない（#405）。
    /// feature-gap（`ClapUnavailable`）でも汎用 runtime エラー（`Clap`）でもなく、専用コードにすることで
    /// クライアントが「LoadPlugin をまだ呼んでいない／失敗した」ことを actionable に判定できるようにする
    /// （`push_plugin_event` の未ロードガードが返す）。
    #[error("clap plugin not loaded: {0}")]
    ClapNotLoaded(String),
    /// out-of-process effect がこの daemon ビルド/インスタンスで利用できない（feature `outproc-effect`
    /// 無効、または設定不足）。TS 層は feature-gap として warn-once で握り潰す（γ M1 PR-C）。
    #[error("out-of-process effect unavailable: {0}")]
    OutProcEffectUnavailable(String),
    /// out-of-process effect は利用可能だが runtime で失敗した（shm 作成失敗・child spawn 失敗・
    /// mutex poison 等）。TS 層は feature-gap と区別して rethrow する。
    #[error("out-of-process effect runtime error: {0}")]
    OutProcEffect(String),
    /// ApplyEffectChain が child/daemon の生死または未完了 mailbox を跨ぎ、権威 config が
    /// 要求前のままかを確認できない。TS 層は次評価を rebuild に倒す。
    #[error("out-of-process effect registry is uncertain: {0}")]
    OutProcEffectUncertain(String),
    #[error("malformed out-of-process effect request: {0}")]
    OutProcEffectRequest(String),
    /// out-of-process instrument がこの daemon ビルド/インスタンスで利用できない。
    #[error("out-of-process instrument unavailable: {0}")]
    OutProcInstrumentUnavailable(String),
    /// out-of-process instrument の runtime failure。
    #[error("out-of-process instrument runtime error: {0}")]
    OutProcInstrument(String),
    /// active-note 台帳が指す instrument instance が既に退役している。通常の note RPC では
    /// OUTPROC_INSTRUMENT_RUNTIME に写像するが、PluginAllNotesOff は文字列比較せずこの variant を
    /// stale として数える。
    #[error("out-of-process instrument instance is stale: {0}")]
    OutProcInstrumentStale(String),
    /// child launch 後の attach が失敗したが、shm slot は復元済みで再試行可能。
    #[error("out-of-process attach failed: {0}")]
    OutProcAttachFailed(String),
    /// OOP slot が永久に closed（起動インフラの失敗）。
    #[error("out-of-process slot closed: {0}")]
    OutProcSlotClosed(String),
    #[error("plugin state target error: {0}")]
    PluginStateTarget(String),
    #[error("plugin state child is not ready: {0}")]
    PluginStateNotReady(String),
    #[error("plugin state mailbox timeout: {0}")]
    PluginStateTimeout(String),
    #[error("plugin state is unsupported or rejected by the plugin: {0}")]
    PluginStateUnsupported(String),
    #[error("plugin state child exited: {0}")]
    PluginStateChildExited(String),
    #[error("plugin state mailbox protocol error: {0}")]
    PluginStateProtocol(String),
    #[error("plugin state I/O error: {0}")]
    PluginStateIo(String),
    #[error("plugin UI unavailable: {0}")]
    PluginUiUnavailable(String),
    #[error("plugin UI target error: {0}")]
    PluginUiTarget(String),
    #[error("plugin UI protocol error: {0}")]
    PluginUiProtocol(String),
    #[error("plugin UI command failed: {0}")]
    PluginUiCommand(String),
    /// ランタイムのオーディオデバイス切替（`SelectAudioDevice`・#484 D2）が実行できない状態。
    /// capture（`ORBIT_CAPTURE_WAV`）有効時の明示拒否、または `StreamGuard` 未生存（test backend 等）
    /// の場合に返す。cpal 側の実失敗（device open 失敗等）は `Output`（`OutputError` 経由）に別れる。
    #[error("audio device switch unavailable: {0}")]
    AudioDeviceSwitchUnavailable(String),
}

#[cfg(feature = "outproc-instrument")]
type ActivePluginNote = (String, u8, u8);
#[cfg(feature = "outproc-instrument")]
type ActivePluginNotes = HashSet<ActivePluginNote>;

/// daemon が追跡していた plugin note の一括解放結果（#606）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PluginAllNotesOffSummary {
    /// NoteOff の ring push に成功した件数。
    pub released: usize,
    /// 台帳にはあったが送り先 instance が既に無かった件数。
    pub stale: usize,
    /// NoteOff の送出を試みたが runtime error になった件数。
    pub failed: usize,
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_rack_tests {
    use super::{
        ChildLaunch, ChildSlot, EffectRole, EffectSlotEntry, EngineWrap, OutProcControl,
        PluginStateTarget, PluginUiWiring, WrapError,
    };
    use crate::backend::StubBackend;
    use crate::outproc_effect::{
        self, ApplyEffectChainMode, ChainStageConfig, EffectChainPlan, EffectChainPlanStage,
        EffectChainStageSpec, OutProcEffectStats, SaveDroppedStage,
    };
    use orbit_audio_native::CallbackTimeStats;
    use orbit_audio_sandbox::transport::{
        read_cstr_field, write_cstr_field, CMD_APPLY_CHAIN, CMD_CLOSE_UI_AT, CMD_OPEN_UI_AT,
        CMD_RESULT_OK, CMD_RESULT_PLUGIN_ERROR, CMD_SAVE_STATE_AT, EVT_UI_CLOSED,
        EVT_UI_CLOSED_DONE,
    };
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const BUS: &str = "seq-bus-0";
    const WAIT: Duration = Duration::from_secs(10);

    struct SlotFixture {
        slot: Arc<Mutex<ChildSlot<EffectRole>>>,
        entry: EffectSlotEntry,
        stats: Arc<OutProcEffectStats>,
        old_pid: u32,
    }

    struct RackFixture {
        wrap: Arc<EngineWrap>,
        master: SlotFixture,
        bus: Option<SlotFixture>,
        bus_active: Option<Arc<AtomicBool>>,
    }

    fn fixture_script(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn catalog(path: &str, state: Option<PathBuf>, enabled: bool) -> ChainStageConfig {
        ChainStageConfig::Catalog {
            path: PathBuf::from(path),
            plugin_id: None,
            latest_state: state,
            enabled,
        }
    }

    fn load_catalog(path: &str) -> EffectChainPlanStage {
        EffectChainPlanStage::Load {
            stage: EffectChainStageSpec::Catalog {
                path: PathBuf::from(path),
                plugin_id: None,
                state: None,
                enabled: true,
            },
        }
    }

    fn keep(index: usize, enabled: bool) -> EffectChainPlanStage {
        EffectChainPlanStage::Keep {
            prev_index: index,
            enabled,
            params: BTreeMap::new(),
        }
    }

    fn plan(chain: Vec<EffectChainPlanStage>) -> EffectChainPlan {
        EffectChainPlan {
            chain,
            save_dropped: Vec::new(),
        }
    }

    fn rack_ui_binding(fixture: &RackFixture) -> Arc<Mutex<BTreeMap<u32, u64>>> {
        let slot = fixture.master.slot.lock().expect("rack slot");
        match &*slot {
            ChildSlot::Active {
                ui_index_binding: Some(binding),
                ..
            } => binding.clone(),
            _ => panic!("rack fixture must have an active UI index binding"),
        }
    }

    fn open_rack_ui(fixture: &RackFixture, index: u64, window: u64) {
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_OPEN_UI_AT,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .open_outproc_plugin_ui(
                PluginStateTarget::Effect { bus: None },
                index,
                format!("Stage {index}"),
                Some(window),
            )
            .expect("open rack UI");
        let argument = response.join().expect("open UI responder");
        let argument: serde_json::Value =
            serde_json::from_str(&argument).expect("open UI JSON argument");
        assert_eq!(argument["index"], index);
        assert_eq!(argument["window"], window);
    }

    fn active_slot(chain: Vec<ChainStageConfig>, respawn_child: PathBuf) -> SlotFixture {
        let shm_path = outproc_effect::unique_shm_path();
        drop(orbit_audio_sandbox::create_shared(&shm_path).expect("create rack fixture shm"));
        let engaged = Arc::new(AtomicBool::new(true));
        let requested = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let mut first = Command::new(fixture_script("slow-child.sh"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn rack fixture child");
        assert!(first.try_wait().expect("preflight fixture child").is_none());
        let old_pid = first.id();
        stats.current_child_pid.store(old_pid, Ordering::Release);
        stats.initial_attach_pending.store(false, Ordering::Release);
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(shm_path.clone()));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let ui_index_binding = Arc::new(Mutex::new(BTreeMap::new()));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let chain = Arc::new(Mutex::new(chain));
        let supervisor = outproc_effect::EffectChildSupervisor::spawn_chain_with_mailbox(
            first,
            shm_path.clone(),
            stats.clone(),
            respawn_child.clone(),
            48_000,
            chain.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump.clone(),
                target: ui_target.clone(),
                index_binding: Some(ui_index_binding.clone()),
                events: ui_events,
            },
        )
        .expect("spawn rack fixture supervisor");
        let ready = orbit_audio_sandbox::open_shared(&shm_path).expect("open fixture ready map");
        unsafe {
            orbit_audio_sandbox::transport::publish_child_ready(
                orbit_audio_sandbox::region_ptr(&ready),
                true,
            )
        };
        let slot = Arc::new(Mutex::new(ChildSlot::Active {
            path: outproc_effect::chain_manifest_path(&shm_path),
            plugin_id: None,
            state: None,
            latest_state: Arc::new(Mutex::new(None)),
            engaged: engaged.clone(),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding: Some(ui_index_binding),
            _supervisor: supervisor,
        }));
        SlotFixture {
            slot,
            entry: EffectSlotEntry {
                shm_path,
                child_exe: respawn_child,
                sample_rate: 48_000,
                engaged,
                quiesce_requested: requested,
                quiesce_done: done,
                shutdown,
                chain,
            },
            stats,
            old_pid,
        }
    }

    fn empty_slot() -> SlotFixture {
        let shm_path = outproc_effect::unique_shm_path();
        drop(orbit_audio_sandbox::create_shared(&shm_path).expect("create empty rack shm"));
        let engaged = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let child_exe = fixture_script("slow-child.sh");
        let chain = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch::<EffectRole> {
            shm_path: shm_path.clone(),
            child_exe: child_exe.clone(),
            sample_rate: 48_000,
            stats: stats.clone(),
            engaged: engaged.clone(),
            cleanup_shm_on_drop: true,
        })));
        SlotFixture {
            slot,
            entry: EffectSlotEntry {
                shm_path,
                child_exe,
                sample_rate: 48_000,
                engaged,
                quiesce_requested: Arc::new(AtomicBool::new(false)),
                quiesce_done: Arc::new(AtomicBool::new(false)),
                shutdown: Arc::new(AtomicBool::new(false)),
                chain,
            },
            stats,
            old_pid: 0,
        }
    }

    fn rack_fixture(master: SlotFixture, bus: Option<SlotFixture>) -> RackFixture {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");
        let mut bus_slots = HashMap::new();
        let mut bus_entries = HashMap::new();
        let mut bus_stats = HashMap::new();
        let mut bus_actives = HashMap::new();
        let bus_active = bus.as_ref().map(|fixture| {
            bus_slots.insert(BUS.to_owned(), Arc::downgrade(&fixture.slot));
            bus_entries.insert(BUS.to_owned(), fixture.entry.clone());
            bus_stats.insert(BUS.to_owned(), fixture.stats.clone());
            let active = Arc::new(AtomicBool::new(false));
            bus_actives.insert(BUS.to_owned(), active.clone());
            active
        });
        *wrap.outproc.lock().expect("lock rack fixture control") = Some(OutProcControl {
            stats: master.stats.clone(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Arc::downgrade(&master.slot),
            master_entry: master.entry.clone(),
            bus_slots,
            bus_entries,
            bus_stats,
            bus_actives,
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        RackFixture {
            wrap,
            master,
            bus,
            bus_active,
        }
    }

    fn spawn_response(
        shm: PathBuf,
        expected_kind: u32,
        result: u32,
        detail: &'static str,
        body: impl FnOnce(&str) -> u64 + Send + 'static,
    ) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mmap = orbit_audio_sandbox::open_shared(&shm).expect("open responder shm");
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            let previous = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
            let deadline = Instant::now() + WAIT;
            let seq = loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq > previous {
                    break seq;
                }
                assert!(
                    Instant::now() < deadline,
                    "mailbox command was not published"
                );
                std::thread::sleep(Duration::from_millis(1));
            };
            assert_eq!(
                unsafe { (*region).cmd_kind.load(Ordering::Relaxed) },
                expected_kind,
                "mailbox command kind"
            );
            let arg = unsafe {
                read_cstr_field(&(*region).cmd_arg)
                    .expect("valid command argument")
                    .to_owned()
            };
            let bytes = body(&arg);
            unsafe {
                assert!(write_cstr_field(&mut (*region).cmd_result_detail, detail));
                (*region).cmd_result_len.store(bytes, Ordering::Relaxed);
                (*region).cmd_result.store(result, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
            arg
        })
    }

    fn spawn_quiesce_ack(entry: &EffectSlotEntry) -> std::thread::JoinHandle<()> {
        let requested = entry.quiesce_requested.clone();
        let done = entry.quiesce_done.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            while !requested.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "quiesce was not requested");
                std::thread::sleep(Duration::from_millis(1));
            }
            done.store(true, Ordering::Release);
        })
    }

    fn spawn_ready_after_new_pid(
        fixture: &SlotFixture,
        old_pid: u32,
    ) -> std::thread::JoinHandle<u32> {
        let stats = fixture.stats.clone();
        let shm = fixture.entry.shm_path.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            let pid = loop {
                let pid = stats.current_child_pid.load(Ordering::Acquire);
                if pid != 0 && pid != old_pid {
                    break pid;
                }
                assert!(
                    Instant::now() < deadline,
                    "replacement child was not spawned"
                );
                std::thread::sleep(Duration::from_millis(1));
            };
            let mmap = orbit_audio_sandbox::open_shared(&shm).expect("open replacement ready map");
            unsafe {
                orbit_audio_sandbox::transport::publish_child_ready(
                    orbit_audio_sandbox::region_ptr(&mmap),
                    true,
                )
            };
            pid
        })
    }

    fn rebuild(fixture: &RackFixture, bus: Option<String>, plan: EffectChainPlan) -> u32 {
        let target = match &bus {
            Some(_) => fixture.bus.as_ref().expect("bus fixture"),
            None => &fixture.master,
        };
        let old_pid = target.old_pid;
        let ack = spawn_quiesce_ack(&target.entry);
        let ready = spawn_ready_after_new_pid(target, old_pid);
        let summary = fixture
            .wrap
            .apply_outproc_effect_chain(bus, plan, ApplyEffectChainMode::Rebuild)
            .expect("rebuild apply succeeds");
        ack.join().expect("quiesce ack");
        let pid = ready.join().expect("ready publisher");
        assert_eq!(summary.child_pid, pid);
        pid
    }

    fn assert_active(slot: &Mutex<ChildSlot<EffectRole>>) {
        assert!(matches!(
            &*slot.lock().expect("lock rack slot"),
            ChildSlot::Active { .. }
        ));
    }

    fn process_exists(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn d1_master_and_bus_apply_resolve_distinct_slots() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("master.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            Some(active_slot(
                vec![catalog("bus.clap", None, true)],
                fixture_script("slow-child.sh"),
            )),
        );
        let master_response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
            .expect("master diff");
        master_response.join().expect("master responder");
        assert_eq!(
            *fixture.master.entry.chain.lock().expect("master chain"),
            vec![catalog("master.clap", None, false)]
        );
        assert_eq!(
            *fixture
                .bus
                .as_ref()
                .expect("bus")
                .entry
                .chain
                .lock()
                .expect("bus chain"),
            vec![catalog("bus.clap", None, true)]
        );

        let bus = fixture.bus.as_ref().expect("bus");
        let bus_response = spawn_response(
            bus.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(
                Some(BUS.into()),
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
            .expect("bus diff");
        bus_response.join().expect("bus responder");
        assert_eq!(
            *bus.entry.chain.lock().expect("bus chain"),
            vec![catalog("bus.clap", None, false)]
        );
    }

    #[test]
    fn d2_diff_apply_uses_mailbox_without_respawning() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let old_pid = fixture.master.old_pid;
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        let summary = fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, true), load_catalog("b.clap")]),
                ApplyEffectChainMode::Diff,
            )
            .expect("diff apply");
        response.join().expect("apply responder");
        assert_eq!(summary.child_pid, old_pid);
        assert_eq!(
            fixture.master.stats.respawn_count.load(Ordering::Acquire),
            0
        );
        assert_active(&fixture.master.slot);
    }

    #[test]
    fn d3_empty_apply_clears_engaged_keeps_bus_active_and_leaves_empty_slot() {
        let bus = active_slot(
            vec![catalog("a.clap", None, true)],
            fixture_script("slow-child.sh"),
        );
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("master.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            Some(bus),
        );
        let bus = fixture.bus.as_ref().expect("bus");
        let response = spawn_response(
            bus.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        let ack = spawn_quiesce_ack(&bus.entry);
        fixture
            .wrap
            .apply_outproc_effect_chain(
                Some(BUS.into()),
                plan(Vec::new()),
                ApplyEffectChainMode::Diff,
            )
            .expect("empty apply");
        response.join().expect("empty responder");
        ack.join().expect("quiesce ack");
        assert!(!bus.entry.engaged.load(Ordering::Acquire));
        assert!(fixture
            .bus_active
            .as_ref()
            .expect("bus active")
            .load(Ordering::Acquire));
        assert!(matches!(
            &*bus.slot.lock().expect("bus slot"),
            ChildSlot::Empty(_)
        ));
    }

    #[test]
    fn d4_empty_spawn_manifest_preserves_stage_count_and_order() {
        let fixture = rack_fixture(empty_slot(), None);
        let stats = fixture.master.stats.clone();
        let shm = fixture.master.entry.shm_path.clone();
        let observer = std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            while stats.current_child_pid.load(Ordering::Acquire) == 0 {
                assert!(Instant::now() < deadline, "spawn did not publish a PID");
                std::thread::sleep(Duration::from_millis(1));
            }
            let manifest_path = outproc_effect::chain_manifest_path(&shm);
            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&manifest_path).expect("read spawn manifest"),
            )
            .expect("parse spawn manifest");
            let mmap = orbit_audio_sandbox::open_shared(&shm).expect("open spawn ready map");
            unsafe {
                orbit_audio_sandbox::transport::publish_child_ready(
                    orbit_audio_sandbox::region_ptr(&mmap),
                    true,
                )
            };
            manifest
        });
        let standard = EffectChainPlanStage::Load {
            stage: EffectChainStageSpec::Standard {
                name: "Gain".into(),
                params: BTreeMap::from([("db".into(), -6.0)]),
                enabled: true,
            },
        };
        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![
                    load_catalog("a.clap"),
                    standard,
                    load_catalog("b.vst3"),
                ]),
                ApplyEffectChainMode::Diff,
            )
            .expect("empty spawn");
        let manifest = observer.join().expect("manifest observer");
        let stages = manifest["stages"].as_array().expect("manifest stages");
        assert_eq!(stages.len(), 3);
        assert_eq!(stages[0]["path"], "a.clap");
        assert_eq!(stages[1]["name"], "Gain");
        assert_eq!(stages[2]["path"], "b.vst3");
    }

    #[test]
    fn d5_plugin_error_keeps_authoritative_chain_unchanged() {
        let previous = vec![catalog("a.clap", None, true)];
        let fixture = rack_fixture(
            active_slot(previous.clone(), fixture_script("slow-child.sh")),
            None,
        );
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_PLUGIN_ERROR,
            "failed index 1: injected load failure",
            |_| 0,
        );
        let error = fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, true), load_catalog("bad.clap")]),
                ApplyEffectChainMode::Diff,
            )
            .expect_err("plugin error must propagate");
        response.join().expect("error responder");
        assert!(error.to_string().contains("failed index 1"));
        assert_eq!(*fixture.master.entry.chain.lock().expect("chain"), previous);
        assert_active(&fixture.master.slot);
    }

    #[test]
    fn mailbox_registry_predicate_separates_definitive_rejection_from_lifecycle_failures() {
        use orbit_audio_sandbox::CommandMailboxError;

        let definitive =
            super::effect_chain_apply_mailbox_error(CommandMailboxError::CommandFailed {
                seq: 1,
                result: CMD_RESULT_PLUGIN_ERROR,
                detail: "load rejected".into(),
            });
        assert!(matches!(definitive, WrapError::OutProcEffect(_)));

        for uncertain in [
            CommandMailboxError::Timeout {
                seq: 2,
                elapsed: Duration::from_millis(15),
            },
            CommandMailboxError::ChildExited {
                seq: 3,
                detail: "watchdog reset".into(),
            },
            CommandMailboxError::Poisoned { seq: 4 },
        ] {
            assert!(matches!(
                super::effect_chain_apply_mailbox_error(uncertain),
                WrapError::OutProcEffectUncertain(_)
            ));
        }
    }

    #[test]
    fn d6_timeout_releases_apply_reservation_for_the_next_request() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let shm = fixture.master.entry.shm_path.clone();
        let delayed = std::thread::spawn(move || {
            let mmap = orbit_audio_sandbox::open_shared(&shm).expect("open delayed responder");
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            let deadline = Instant::now() + WAIT;
            let seq = loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq != 0 {
                    break seq;
                }
                assert!(Instant::now() < deadline, "first apply was not published");
                std::thread::sleep(Duration::from_millis(1));
            };
            std::thread::sleep(Duration::from_millis(25));
            unsafe {
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });
        let first = fixture.wrap.apply_outproc_effect_chain_with_timeout(
            None,
            plan(vec![keep(0, false)]),
            ApplyEffectChainMode::Diff,
            Duration::from_millis(15),
        );
        assert!(matches!(first, Err(WrapError::OutProcEffectUncertain(_))));
        delayed.join().expect("delayed ack");
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
            .expect("reservation must be released after timeout");
        response.join().expect("second responder");
    }

    #[test]
    fn d7_respawn_manifest_uses_latest_applied_chain_and_per_stage_state() {
        let state_dir = std::env::temp_dir().join(format!(
            "orbit-d7-state-{}-{}",
            std::process::id(),
            super::short_uuid()
        ));
        std::fs::create_dir(&state_dir).expect("create state dir");
        let state_path = state_dir.join("b.state");
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("record-respawn-args.sh"),
            ),
            None,
        );
        let apply_response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, true), load_catalog("b.clap")]),
                ApplyEffectChainMode::Diff,
            )
            .expect("apply before respawn");
        apply_response.join().expect("apply responder");

        let saved_bytes = b"stage-b-state".to_vec();
        let save_bytes = saved_bytes.clone();
        let save_response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_SAVE_STATE_AT,
            CMD_RESULT_OK,
            "",
            move |arg| {
                let arg: serde_json::Value = serde_json::from_str(arg).expect("state arg JSON");
                assert_eq!(arg["index"], 1);
                std::fs::write(arg["path"].as_str().expect("sidecar"), &save_bytes)
                    .expect("write state sidecar");
                save_bytes.len() as u64
            },
        );
        fixture
            .wrap
            .save_outproc_plugin_state(
                PluginStateTarget::Effect { bus: None },
                1,
                state_path.clone(),
            )
            .expect("save second stage");
        save_response.join().expect("save responder");

        let args_path = PathBuf::from(format!(
            "{}.respawn-args",
            fixture.master.entry.shm_path.display()
        ));
        let _ = std::fs::remove_file(&args_path);
        assert!(Command::new("kill")
            .args(["-9", &fixture.master.old_pid.to_string()])
            .status()
            .expect("kill old child")
            .success());
        let deadline = Instant::now() + WAIT;
        while !args_path.exists() || fixture.master.stats.respawn_count.load(Ordering::Acquire) == 0
        {
            assert!(
                Instant::now() < deadline,
                "watchdog did not record respawn args"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let args: Vec<String> = std::fs::read_to_string(&args_path)
            .expect("read respawn args")
            .lines()
            .map(str::to_owned)
            .collect();
        let chain_arg = args
            .iter()
            .position(|arg| arg == "--chain")
            .and_then(|index| args.get(index + 1))
            .expect("respawn --chain argument");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(chain_arg).expect("read respawn manifest"))
                .expect("parse respawn manifest");
        assert_eq!(manifest["stages"].as_array().expect("stages").len(), 2);
        assert_eq!(manifest["stages"][0]["path"], "a.clap");
        assert_eq!(manifest["stages"][1]["path"], "b.clap");
        assert_eq!(manifest["stages"][1]["state"].as_str(), state_path.to_str());
        std::fs::remove_dir_all(state_dir).expect("remove state dir");
    }

    #[test]
    fn d8_parallel_apply_to_the_same_slot_is_rejected() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let shm = fixture.master.entry.shm_path.clone();
        let (published_tx, published_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let responder = std::thread::spawn(move || {
            let mmap = orbit_audio_sandbox::open_shared(&shm).expect("open held responder");
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            let deadline = Instant::now() + WAIT;
            let seq = loop {
                let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                if seq != 0 {
                    break seq;
                }
                assert!(Instant::now() < deadline, "first apply not published");
                std::thread::sleep(Duration::from_millis(1));
            };
            published_tx.send(()).expect("signal published");
            release_rx.recv().expect("wait release");
            unsafe {
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_ack_seq.store(seq, Ordering::Release);
            }
        });
        let wrap = fixture.wrap.clone();
        let first = std::thread::spawn(move || {
            wrap.apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
        });
        published_rx.recv().expect("first apply published");
        let second = fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
            .expect_err("second concurrent apply must fail");
        assert!(second.to_string().contains("already in progress"));
        release_tx.send(()).expect("release first apply");
        responder.join().expect("held responder");
        first.join().expect("first thread").expect("first apply");
    }

    #[test]
    fn d9_shutdown_latch_rejects_apply_without_touching_the_slot() {
        let previous = vec![catalog("a.clap", None, true)];
        let fixture = rack_fixture(
            active_slot(previous.clone(), fixture_script("slow-child.sh")),
            None,
        );
        fixture.master.entry.shutdown.store(true, Ordering::Release);
        let error = fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(0, false)]),
                ApplyEffectChainMode::Diff,
            )
            .expect_err("shutdown latch rejects apply");
        assert!(error.to_string().contains("engine is stopping"));
        assert_eq!(*fixture.master.entry.chain.lock().expect("chain"), previous);
        assert_eq!(
            fixture
                .master
                .stats
                .current_child_pid
                .load(Ordering::Acquire),
            fixture.master.old_pid
        );
        assert_active(&fixture.master.slot);
    }

    #[test]
    fn d10_get_plugin_state_sends_save_state_at_with_chain_index() {
        let state_dir = std::env::temp_dir().join(format!(
            "orbit-d10-state-{}-{}",
            std::process::id(),
            super::short_uuid()
        ));
        std::fs::create_dir(&state_dir).expect("create state dir");
        let final_path = state_dir.join("stage.state");
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_SAVE_STATE_AT,
            CMD_RESULT_OK,
            "",
            |arg| {
                let arg: serde_json::Value = serde_json::from_str(arg).expect("state arg JSON");
                assert_eq!(arg["index"], 1);
                std::fs::write(arg["path"].as_str().expect("sidecar path"), b"state")
                    .expect("write sidecar");
                5
            },
        );
        fixture
            .wrap
            .save_outproc_plugin_state(PluginStateTarget::Effect { bus: None }, 1, final_path)
            .expect("save stage 1");
        let arg = response.join().expect("state responder");
        let arg: serde_json::Value = serde_json::from_str(&arg).expect("state arg JSON");
        assert_eq!(arg["index"], 1);
        std::fs::remove_dir_all(state_dir).expect("remove state dir");
    }

    #[test]
    fn d11_open_plugin_ui_sends_open_ui_at_with_chain_index() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let response = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_OPEN_UI_AT,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .open_outproc_plugin_ui(
                PluginStateTarget::Effect { bus: None },
                1,
                "Stage B".into(),
                Some(101),
            )
            .expect("open stage UI");
        let arg = response.join().expect("UI responder");
        let arg: serde_json::Value = serde_json::from_str(&arg).expect("UI arg JSON");
        assert_eq!(arg["index"], 1);
        assert_eq!(arg["title"], "Stage B");
        assert_eq!(arg["window"], 101);
    }

    #[test]
    fn w4_ack_forwards_the_exact_window_to_the_pump() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let window = 202;
        open_rack_ui(&fixture, 1, window);
        let pump = {
            let slot = fixture.master.slot.lock().expect("rack slot");
            match &*slot {
                ChildSlot::Active { ui_pump, .. } => ui_pump.clone(),
                _ => panic!("rack fixture must remain active"),
            }
        };
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open UI event region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let mut child = orbit_audio_sandbox::transport::EventRingChild::new();
        let argument = orbit_audio_sandbox::encode_ui_closed_arg(Some(window));
        child
            .queue(EVT_UI_CLOSED, &argument)
            .expect("queue UI close safepoint");
        unsafe { child.service(region) }.expect("publish UI close safepoint");
        pump.poll_step(|notification| {
            assert!(matches!(
                notification,
                orbit_audio_sandbox::UiPumpNotification::Safepoint {
                    generation: 0,
                    evt_seq: 1,
                    window: Some(202),
                }
            ));
            true
        })
        .expect("establish pending safepoint");
        fixture
            .wrap
            .ack_outproc_ui_safepoint(
                PluginStateTarget::Effect { bus: None },
                1,
                Some(window),
                0,
                1,
            )
            .expect("ack matching window");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 1);
    }

    #[test]
    fn w5_apply_keep_remaps_binding_and_close_uses_the_new_index() {
        let fixture = rack_fixture(
            active_slot(
                vec![
                    catalog("a.clap", None, true),
                    catalog("b.clap", None, true),
                    catalog("c.clap", None, true),
                ],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let window = 303;
        open_rack_ui(&fixture, 2, window);
        let apply = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(1, true), keep(2, true)]),
                ApplyEffectChainMode::Diff,
            )
            .expect("apply leading drop");
        apply.join().expect("apply responder");
        assert_eq!(
            *rack_ui_binding(&fixture).lock().expect("binding"),
            BTreeMap::from([(1, window)])
        );

        let close = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_CLOSE_UI_AT,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .close_outproc_plugin_ui(PluginStateTarget::Effect { bus: None }, 1, Some(window))
            .expect("close remapped window");
        let argument = close.join().expect("close responder");
        let argument: serde_json::Value =
            serde_json::from_str(&argument).expect("close UI JSON argument");
        assert_eq!(argument, serde_json::json!({"index": 1, "window": window}));
    }

    #[test]
    fn w6_duplicate_open_is_loud_and_never_reaches_the_child() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        open_rack_ui(&fixture, 0, 404);
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open command counter region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let before = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };

        let error = fixture
            .wrap
            .open_outproc_plugin_ui(
                PluginStateTarget::Effect { bus: None },
                0,
                "duplicate".into(),
                Some(405),
            )
            .expect_err("duplicate open must be loud");
        assert!(error
            .to_string()
            .contains("OPEN_UI requested while lifecycle is Open"));
        assert_eq!(unsafe { (*region).cmd_seq.load(Ordering::Acquire) }, before);
    }

    #[test]
    fn w7_stale_close_window_is_loud_and_never_reaches_the_child() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        open_rack_ui(&fixture, 0, 505);
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open command counter region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let before = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };

        let error = fixture
            .wrap
            .close_outproc_plugin_ui(PluginStateTarget::Effect { bus: None }, 0, Some(506))
            .expect_err("wrong window close must be loud");
        assert!(error.to_string().contains("does not match chain index"));
        assert_eq!(unsafe { (*region).cmd_seq.load(Ordering::Acquire) }, before);
    }

    #[test]
    fn w8_all_keep_shift_and_disable_issue_no_ui_close_command() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        open_rack_ui(&fixture, 0, 601);
        open_rack_ui(&fixture, 1, 602);
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open command counter region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let before = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
        let apply = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );

        fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                plan(vec![keep(1, false), keep(0, true)]),
                ApplyEffectChainMode::Diff,
            )
            .expect("apply all-keep reorder and disable");
        apply.join().expect("apply responder");

        // The shared mailbox is the spy: the one and only command after `before` is APPLY itself.
        // Any pre-close would consume an extra sequence number (and the responder would observe
        // CLOSE_UI_AT instead of CMD_APPLY_CHAIN).
        assert_eq!(
            unsafe { (*region).cmd_seq.load(Ordering::Acquire) },
            before + 1
        );
        assert_eq!(
            *rack_ui_binding(&fixture).lock().expect("binding"),
            BTreeMap::from([(0, 602), (1, 601)])
        );
    }

    #[test]
    fn w9_drop_removes_its_binding_while_remapping_the_survivor() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        open_rack_ui(&fixture, 0, 701);
        open_rack_ui(&fixture, 1, 702);
        let apply = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );

        fixture
            .wrap
            .apply_outproc_effect_chain(None, plan(vec![keep(1, true)]), ApplyEffectChainMode::Diff)
            .expect("drop first stage");
        apply.join().expect("apply responder");

        assert_eq!(
            *rack_ui_binding(&fixture).lock().expect("binding"),
            BTreeMap::from([(0, 702)])
        );
    }

    #[test]
    fn w10_late_abandoned_ack_reaches_pump_after_its_stage_was_dropped() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true), catalog("b.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let window = 801;
        open_rack_ui(&fixture, 1, window);
        let apply = spawn_response(
            fixture.master.entry.shm_path.clone(),
            CMD_APPLY_CHAIN,
            CMD_RESULT_OK,
            "",
            |_| 0,
        );
        fixture
            .wrap
            .apply_outproc_effect_chain(None, plan(vec![keep(0, true)]), ApplyEffectChainMode::Diff)
            .expect("drop UI stage");
        apply.join().expect("apply responder");

        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open UI event region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let mut child = orbit_audio_sandbox::transport::EventRingChild::new();
        let closed = orbit_audio_sandbox::encode_ui_closed_arg(Some(window));
        let done = orbit_audio_sandbox::encode_ui_closed_done_arg(
            Some(window),
            orbit_audio_sandbox::UiCloseCompletion::TimedOutWithoutSave,
        );
        child
            .queue(EVT_UI_CLOSED, &closed)
            .expect("queue defensive close safepoint");
        child
            .queue(EVT_UI_CLOSED_DONE, &done)
            .expect("queue defensive close timeout");
        unsafe { child.service(region) }.expect("publish defensive close cycle");
        let deadline = Instant::now() + WAIT;
        while unsafe { (*region).evt_ack_seq.read() } < 2 {
            assert!(Instant::now() < deadline, "defensive close cycle deadline");
            std::thread::sleep(Duration::from_millis(10));
        }

        fixture
            .wrap
            .ack_outproc_ui_safepoint(
                PluginStateTarget::Effect { bus: None },
                1,
                Some(window),
                0,
                1,
            )
            .expect("late abandoned ack must not require the dropped stage");
    }

    #[test]
    fn d13_rebuild_tears_down_the_old_child_before_spawning_a_new_one() {
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("a.clap", None, true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let old_pid = fixture.master.old_pid;
        let new_pid = rebuild(&fixture, None, plan(vec![load_catalog("b.clap")]));
        assert_ne!(new_pid, old_pid);
        assert!(!process_exists(old_pid), "old child must be reaped");
        assert_active(&fixture.master.slot);
    }

    #[test]
    fn d14_unhealthy_active_diff_falls_back_to_rebuild() {
        for invalid in [false, true] {
            let fixture = rack_fixture(
                active_slot(
                    vec![catalog("a.clap", None, true)],
                    fixture_script("slow-child.sh"),
                ),
                None,
            );
            let old_pid = fixture.master.old_pid;
            if invalid {
                fixture
                    .master
                    .stats
                    .measurement_invalid
                    .store(true, Ordering::Release);
            } else {
                fixture
                    .master
                    .stats
                    .current_child_pid
                    .store(0, Ordering::Release);
            }
            let ack = spawn_quiesce_ack(&fixture.master.entry);
            let ready = spawn_ready_after_new_pid(&fixture.master, old_pid);
            let summary = fixture
                .wrap
                .apply_outproc_effect_chain(
                    None,
                    plan(vec![keep(0, true)]),
                    ApplyEffectChainMode::Diff,
                )
                .expect("unhealthy diff rebuilds");
            ack.join().expect("quiesce ack");
            let new_pid = ready.join().expect("ready publisher");
            assert_eq!(summary.child_pid, new_pid);
            assert_ne!(new_pid, old_pid);
            assert!(!process_exists(old_pid));
        }
    }

    #[test]
    fn unhealthy_active_drop_uses_latest_state_without_issuing_save() {
        let state_dir = std::env::temp_dir().join(format!(
            "orbit-unhealthy-drop-{}-{}",
            std::process::id(),
            super::short_uuid()
        ));
        std::fs::create_dir(&state_dir).expect("create state dir");
        let latest_state = state_dir.join("latest.state");
        let dropped_state = state_dir.join("dropped.state");
        std::fs::write(&latest_state, b"last-known-state").expect("write latest state");
        let fixture = rack_fixture(
            active_slot(
                vec![catalog("crashed.clap", Some(latest_state), true)],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        fixture
            .master
            .stats
            .current_child_pid
            .store(0, Ordering::Release);
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open command counter map");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let command_seq_before = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
        let ack = spawn_quiesce_ack(&fixture.master.entry);

        let summary = fixture
            .wrap
            .apply_outproc_effect_chain(
                None,
                EffectChainPlan {
                    chain: Vec::new(),
                    save_dropped: vec![SaveDroppedStage {
                        prev_index: 0,
                        path: dropped_state.clone(),
                    }],
                },
                ApplyEffectChainMode::Diff,
            )
            .expect("unhealthy culprit can be dropped without its dead mailbox");

        ack.join().expect("quiesce ack");
        assert_eq!(
            unsafe { (*region).cmd_seq.load(Ordering::Acquire) },
            command_seq_before,
            "an inspected-unhealthy Active must not receive SAVE_STATE_AT"
        );
        assert_eq!(summary.child_pid, 0);
        assert_eq!(summary.dropped.len(), 1);
        assert_eq!(summary.dropped[0].prev_index, 0);
        assert_eq!(summary.dropped[0].path, dropped_state);
        assert_eq!(summary.dropped[0].bytes_written, 16);
        assert_eq!(
            std::fs::read(&summary.dropped[0].path).expect("read recovered state"),
            b"last-known-state"
        );
        std::fs::remove_dir_all(state_dir).expect("remove state dir");
    }

    #[test]
    fn d15_standard_state_and_ui_targets_are_rejected_before_mailbox_issue() {
        let fixture = rack_fixture(
            active_slot(
                vec![ChainStageConfig::Standard {
                    name: "Gain".into(),
                    params: BTreeMap::from([("db".into(), -6.0)]),
                    enabled: true,
                }],
                fixture_script("slow-child.sh"),
            ),
            None,
        );
        let mmap = orbit_audio_sandbox::open_shared(&fixture.master.entry.shm_path)
            .expect("open command counter map");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let before = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
        let state = fixture.wrap.save_outproc_plugin_state(
            PluginStateTarget::Effect { bus: None },
            0,
            std::env::temp_dir().join("d15-standard.state"),
        );
        let ui = fixture.wrap.open_outproc_plugin_ui(
            PluginStateTarget::Effect { bus: None },
            0,
            "Gain".into(),
            Some(102),
        );
        for error in [
            state.expect_err("standard state rejected"),
            ui.expect_err("standard UI rejected"),
        ] {
            assert!(error
                .to_string()
                .contains("standard plugins have no UI/state; parameters live in the DSL"));
        }
        assert_eq!(
            unsafe { (*region).cmd_seq.load(Ordering::Acquire) },
            before,
            "standard target rejection must happen before mailbox issue"
        );
    }
}

/// 共有可能なエンジン wrapper。
///
/// `cpal::Stream` は `!Send` のため、ここには持ち込まない。
/// [`start`] が返す [`StreamGuard`] を main 側で alive に保つ責務。
pub struct EngineWrap {
    engine: Engine,
    // Engine 自体の構成値。device switch は PR-V4 の再構築対象であり、この PR では変えない。
    sample_rate: u32,
    channels: u16,
    /// 現在 cpal が掴んでいる stream の実効構成。GetStatus は固定 engine 値でなくこちらを読む。
    stream_config: Mutex<StreamConfigSnapshot>,
    /// 直近 1 Hz ticker 区間で callback count が前進したか。
    callback_alive: AtomicBool,
    samples: Mutex<HashMap<String, Sample>>,
    started_at: std::time::Instant,
    stream_stats: Arc<StreamStats>,
    /// Stop 経由で停止済みの play_id。PlayEnded 遅延タスクが自然発火を抑制するために参照する。
    /// PlayEnded 発火時に take（remove）されるため、通常ケースでは事後掃除不要。
    stopped_play_ids: Mutex<HashSet<String>>,
    /// child watchdog から既存 WebSocket event frame writer へ合流する daemon 内部 fan-out。
    ///
    /// これは child への新 IPC / engine への新接続ではない。既存 WS 接続ごとに subscriber を
    /// 1 本持ち、watchdog の非ブロッキング `send` を session writer の mpsc へ橋渡しする。
    plugin_ui_events: tokio::sync::broadcast::Sender<PluginUiEvent>,
    /// LinkAudio egress drop の **test 注入用** カウンタ（本番は常に 0）。`link_egress_ring_drops`
    /// がこれを加算する。integration test は `StubBackend` を使い `LinkAudioControl` を持たない
    /// （= 実 drop 源が無い）ため、この counter が link-audio feature の有無に依らず 1 Hz ticker の
    /// LINK_EGRESS_DROP 発火を駆動する唯一の seam になる（[`Self::link_egress_drops_arc`]）。
    /// 本番の drop は `LinkAudioControl::total_ring_drops`（GPL `link-audio` 側）が供給するので、
    /// production read-path ではこの addend は常に 0。`stream_stats` の `record_xrun`（本番と同一
    /// atomic を書く統合 seam）とは異なり、これは本番経路から分離した並行カウンタである点に注意。
    link_egress_drops: Arc<AtomicU64>,
    /// CLAP plugin `process()` エラーの **test 注入用** カウンタ（本番は常に 0）。
    /// `clap_process_error_count` がこれを加算する。integration test は plugin をロードしない
    /// （= 実 error 源が無い）ため、この counter が clap-host feature の有無に依らず 1 Hz ticker の
    /// CLAP_PROCESS_ERROR 発火を駆動する唯一の seam になる（[`Self::clap_process_errors_arc`]）。
    /// 本番の error は clap mutex 内の `ClapProcessorStats::process_error_count` が供給するので、
    /// production read-path ではこの addend は常に 0（`link_egress_drops` と同設計）。
    clap_process_errors: Arc<AtomicU64>,
    /// `load_plugin` が成功したことがあるかどうか（#405）。`push_plugin_event` がこれを見て、
    /// 未ロード時は「fire-and-forget ring に投げてから黙って捨てられる」のでなく、明示的な
    /// error を即座に返すようにする。一度 true になったら false に戻ることはない（hot-unload
    /// 機構が存在しないため・厳密な非同期状態追跡はしない）。`clap`/`link`/`outproc` と同様
    /// feature `clap-host` 専用（読み書きとも clap-host 経路にしかない）。
    #[cfg(feature = "clap-host")]
    plugin_loaded: AtomicBool,
    /// OOP effect `frames_clamped` の **test 注入用** カウンタ（本番は常に 0）。`outproc_health` が
    /// これを加算する。integration test は child process を spawn しない（= 実 clamp 源が無い）ため、
    /// この counter が outproc-effect feature の有無に依らず 1 Hz ticker の
    /// OUTPROC_EFFECT_FRAMES_CLAMPED 発火を駆動する唯一の seam になる（[`Self::outproc_frames_clamped_arc`]）。
    /// `link_egress_drops` / `clap_process_errors` と同設計（#406 /simplify: 専用 seam が無いと
    /// この signal はどのテストからも exercise できなかった）。
    outproc_frames_clamped: Arc<AtomicU64>,
    /// OOP instrument `output_event_dropped_count`（M2 §4.2 output 方向の真の loss）の **test 注入用**
    /// カウンタ（本番は常に 0）。`outproc_instrument_health` が real stats（feature
    /// `outproc-instrument` 時のみ存在）にこれを加算する。integration test は instrument child
    /// process を spawn しない（= 実 drop 源が無い）ため、この counter が outproc-instrument feature
    /// の有無に依らず 1 Hz ticker の OUTPROC_INSTRUMENT_OUTPUT_DROPPED 発火を駆動する唯一の seam に
    /// なる（[`Self::outproc_instrument_output_dropped_arc`]）。`outproc_frames_clamped` と同設計
    /// （PR #422 round 2 review: 追加済みの counter が daemon health 経路に配線されていなかった）。
    outproc_instrument_output_dropped: Arc<AtomicU64>,
    /// OOP instrument `child_process_error_count`(child の CLAP `process()` 呼び出し失敗) の
    /// **test 注入用** カウンタ（本番は常に 0）。`outproc_instrument_health` が real stats
    /// （feature `outproc-instrument` 時のみ存在）にこれを加算する。integration test は instrument
    /// child process を spawn しない（= 実 error 源が無い）ため、この counter が
    /// outproc-instrument feature の有無に依らず 1 Hz ticker の OUTPROC_INSTRUMENT_ERROR 発火を
    /// 駆動する唯一の seam になる（[`Self::outproc_instrument_child_errors_arc`]）。
    /// `outproc_instrument_output_dropped` と同設計（PR #422 round 3: code-reviewer 指摘 — effect
    /// 側の `OUTPROC_EFFECT_ERROR`/`_RESPAWN`/`_INVALID` に相当する instrument 側 signal が
    /// daemon health 経路に配線されていなかった）。
    outproc_instrument_child_errors: Arc<AtomicU64>,
    /// OOP instrument `respawn_count`(child crash → watchdog respawn 回数) の **test 注入用**
    /// カウンタ（本番は常に 0）。`outproc_instrument_child_errors` と同設計。
    outproc_instrument_respawns: Arc<AtomicU64>,
    /// OOP instrument `measurement_invalid`(watchdog が respawn/try_wait を諦め、計測が恒久的に
    /// 無効になったフラグ) の **test 注入用** フラグ（本番は常に false）。数値カウンタではなく
    /// 恒久 bool のため `AtomicBool` を使うが、他の `outproc_instrument_*` 注入用フィールドと同じ
    /// 「本番経路から分離した cross-thread 注入 seam」設計（[`Self::outproc_instrument_measurement_invalid_arc`]）。
    outproc_instrument_measurement_invalid: Arc<AtomicBool>,
    /// in-process / OOP instrument の note push が bounded retry（[`push_with_bounded_retry`]）の末に
    /// 諦めた回数（本番は常に 0 に近い想定・health signal）。event ring は audio callback が毎 block
    /// 全量 drain するため満杯は一時的であり、真の drop はこの回数だけ発生する（issue #400）。
    /// `EngineWrap` は常に `Arc<EngineWrap>` として共有
    /// されるため、`link_egress_drops`/`clap_process_errors` と異なり test 注入用の `_arc()` getter
    /// が不要。本番の bounded retry 書き込みも test 注入用の
    /// [`plugin_event_ring_overflow_inject`](Self::plugin_event_ring_overflow_inject)（#402）も、
    /// producer 側を別スレッドへ outsource せず常に `&self` 経由で `EngineWrap` 自身が直接書くため、
    /// `Arc` clone による cross-thread 共有が不要で、プレーンな `AtomicU64` で足りる。
    plugin_event_ring_overflow_count: AtomicU64,
    /// control-side で送信に成功し、まだ NoteOff が成功していない OOP instrument note の集合。
    /// `PluginAllNotesOff` の最後の砦と replacement 成功後の旧 tenant 掃除がこの台帳を消費する。
    #[cfg(feature = "outproc-instrument")]
    active_plugin_notes: Mutex<ActivePluginNotes>,
    /// 確立済み WebSocket session 数。daemon は複数接続を受け付けるため、途中の 1 session が
    /// 切れても別 session の note を止めず、最後の session 切断だけを異常終了 trigger にする。
    connected_sessions: AtomicUsize,
    /// device switch（#484 D2）: `StreamGuard`（延いては `cpal::Stream`）を排他所有する専用 OS thread
    /// （"audio owner thread"・`main.rs` が spawn）への要求チャンネル。`cpal::Stream` は `!Send` なので
    /// `EngineWrap`（`Arc` 共有で `Send + Sync` 必須）にはハンドルを一切持たせられない — 代わりに
    /// `Send + Sync` な `mpsc::Sender` だけを持ち、実際の device 差し替え（[`OutputStream`] の入れ替え）
    /// は要求を受けた owner thread 自身が [`EngineWrap::apply_device_switch`] で行う。`start_with`
    /// （test backend）経路では未設定（`None`）のまま — `select_audio_device` は
    /// `AudioDeviceSwitchUnavailable` を返す。
    device_switch_tx: Mutex<Option<std::sync::mpsc::Sender<DeviceSwitchRequest>>>,
    /// device switch（#484 D2）: 起動時に解決した `buffer_frames`（gated stale-rate harness 用の
    /// 明示指定 or `None`=device 既定）。`rebuild_output_stream` に同じ値を渡し、switch 前後で
    /// バッファサイズ設定がドリフトしないようにする。
    output_buffer_frames: Mutex<Option<u32>>,
    /// device switch（#484 D2）: 起動時に得た callback-duration 統計 Arc（`post` 有りの variant のみ
    /// `Some`）。switch 後の新 stream にも同じ Arc を渡し、計測を継続させる（カウンタリセットしない）。
    output_cb_stats: Mutex<Option<Arc<orbit_audio_native::CallbackTimeStats>>>,
    /// LinkAudio egress の control-side ハンドル（feature `link-audio` 専用・A4-2b-2）。
    /// reg-ring push / mpsc send が内部可変性（`&mut LinkAudioControl`）を要する一方、`EngineWrap`
    /// は `Arc` 共有で `&self` しか持てない。`Mutex` で内包することで `register_link_audio_channel`
    /// を `&self` のまま提供する。本番 `start()` で `Some`、test backend 経路では `None`。
    #[cfg(feature = "link-audio")]
    link: Mutex<Option<crate::link_audio::LinkAudioControl>>,
    /// CLAP plugin hosting の control-side ハンドル（feature `clap-host` 専用・Issue #340）。
    /// 専用スレッドへの `cmd_tx`（LoadPlugin）/ audio thread への `event_tx`（note）/ 統計を保持する。
    /// rtrb `Producer` は `push` に `&mut self` が要り `!Sync`。`Sender`（Send+Sync）ともども 1 つの
    /// `Mutex` に内包し `&self` のまま提供する。本番 `start()` で `Some`、test backend 経路では `None`。
    #[cfg(feature = "clap-host")]
    clap: Mutex<Option<ClapControl>>,
    /// out-of-process effect の control-side ハンドル（feature `outproc-effect` 専用・γ M1 PR-C）。
    /// 観測 stats（fresh/stale/stall/respawn/child error）と callback-duration stats を保持する。
    /// 本番 `start()` で `Some`、test backend 経路では `None`（`clap` / `link` と同設計）。
    #[cfg(feature = "outproc-effect")]
    outproc: Mutex<Option<OutProcControl>>,
    /// Generic line-program publication handles for named buses. Kept outside `OutProcControl` so
    /// the compatibility state there remains the old atomics while `SetBusRouting` is translated
    /// into one full program install.
    #[cfg(feature = "outproc-effect")]
    bus_lines: Mutex<HashMap<String, LegacyLineInstaller>>,
    /// `SetBusLine` が complete program を publish する named-bus control seam。
    #[cfg(feature = "outproc-effect")]
    bus_line_programs: Mutex<HashMap<String, LineProgramInstaller>>,
    /// 直前に publish した resolved ops。current_gains と対応付けて再 publish の seed を作る。
    #[cfg(feature = "outproc-effect")]
    bus_line_shadows: Mutex<HashMap<String, Vec<LineOp>>>,
    /// master は named bus topology の外側だが、同じ LineSlot publication を使う。
    #[cfg(feature = "outproc-effect")]
    master_line: LineProgramInstaller,
    #[cfg(feature = "outproc-effect")]
    master_line_program: Mutex<Vec<LineOp>>,
    /// out-of-process instrument の note-ring producer（control side）。
    #[cfg(feature = "outproc-instrument")]
    outproc_instrument: Mutex<Option<OutProcInstrumentControl>>,
    /// master line（native `MasterLine`・#649 PR-O2）の互換 gain 書き込みハンドル。
    /// `SetGlobalGain` は PR-O4 までこの atomic だけを更新する。
    /// `orbit_audio_core::Engine::set_global_gain`（core の scheduler ramp）は production では
    /// 呼ばない（`docs/design/611-output-line-design.md` §5.4/§5.5 row 4）。
    /// `start_with`（test backend）経路は実 stream を持たないため、どこにも接続されない
    /// オーファン Arc を持つ（wire レベルの accept/reject 検証のみが対象で、実音は無い）。
    master_gain: Arc<AtomicU32>,
}

impl EngineWrap {
    #[cfg(all(
        feature = "outproc-effect",
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "outproc-effect",
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let effect = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        let instrument = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_both_with_options(effect, instrument, options)
    }

    /// [`AudioBackend`] 経由で起動する（integration test 用）。
    ///
    /// guard は `Box<dyn Any + Send>` の不透明ハンドル。scope 終了まで
    /// drop せずに保持する必要がある。
    pub fn start_with<B: AudioBackend>(
        backend: B,
    ) -> Result<(Arc<Self>, Box<dyn std::any::Any + Send>), WrapError> {
        let started = backend.start()?;
        // test backend は実 `OutputStream`/`MasterLine` を持たない。`SetGlobalGain` の
        // 受理/拒否検証だけが対象なので、どこにも接続されないオーファン Arc で足りる
        // （実音は無い＝値は誰も読まない）。
        let master_gain = Arc::new(AtomicU32::new(1.0_f32.to_bits()));
        #[cfg(feature = "outproc-effect")]
        let master_line =
            orbit_audio_native::InsertBusStage::unattached("test-master").line_program_installer();
        let wrap = Self::build(
            started.engine,
            "test audio backend".to_string(),
            started.sample_rate,
            started.channels,
            started.stats,
            master_gain,
            #[cfg(feature = "outproc-effect")]
            master_line,
        );
        Ok((wrap, started.guard))
    }

    /// Real-output start variants share this final construction and stream-config recording path.
    fn finish_start(
        engine: Engine,
        stream: &OutputStream,
        stream_stats: Arc<StreamStats>,
        buffer_frames: Option<u32>,
        cb_stats: Option<Arc<orbit_audio_native::CallbackTimeStats>>,
    ) -> Arc<Self> {
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
            // master gain の Arc は `RenderState.master.gain_target` の clone（#649）。
            // ここで引くことで、6 つの start バリアントが個別に受け渡さなくてよい。
            stream.master_gain(),
            #[cfg(feature = "outproc-effect")]
            stream.master_line_program_installer(),
        );
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(stream),
            buffer_frames,
            cb_stats,
        );
        wrap
    }

    /// CLAP プラグインをロードして hot-install する（feature `clap-host` 専用）。
    /// 専用スレッドへ `LoadPlugin` を送り、discovery + instantiate + activate + start_processing +
    /// install ring push を実行させ、結果を待つ。**blocking**（`reply.recv()`）なので呼び出し側は
    /// `spawn_blocking` で tokio ワーカーを塞がないこと（discovery + dlopen + activate は重い）。
    #[cfg(feature = "clap-host")]
    pub fn load_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        role: ClapPluginRole,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        {
            // lock は send までで解放し、reply 待ちの blocking を mutex 外で行う。
            let mut guard = self
                .clap
                .lock()
                .map_err(|_| WrapError::Clap("clap mutex poisoned".into()))?;
            let ctl = guard.as_mut().ok_or_else(|| {
                WrapError::ClapUnavailable(
                    "clap host not initialized (test backend has no clap path)".into(),
                )
            })?;
            if let Some(loaded_role) = ctl.loaded_role {
                if loaded_role != role {
                    return Err(WrapError::ClapCrossRoleRejected(
                        "in-process clap-host has one plugin slot; unload before changing role"
                            .into(),
                    ));
                }
            }
            ctl.cmd_tx
                .send(crate::clap_host::ClapCommand::LoadPlugin {
                    path,
                    plugin_id,
                    sample_rate: self.sample_rate,
                    // 🔴 デバイス幅ではなく **engine 幅**。`ClapPostProcessor` が受け取るのは
                    // `master.buffer`（常に 2ch）で、デバイス幅で de-interleave すると
                    // 8ch デバイスで frame 数が 1/4 になって音が化ける（Fable 監査 I-2）。
                    channels: orbit_audio_native::ENGINE_CHANNELS,
                    max_frames: CLAP_MAX_FRAMES,
                    reply: reply_tx,
                })
                .map_err(|_| WrapError::Clap("clap host thread is gone".into()))?;
        }
        match reply_rx.recv() {
            Ok(Ok(info)) => {
                // #405: 以後 push_plugin_event が「未ロード」を検知して事前に弾けるようにする。
                self.plugin_loaded.store(true, Ordering::Relaxed);
                if let Ok(mut guard) = self.clap.lock() {
                    if let Some(ctl) = guard.as_mut() {
                        ctl.loaded_role = Some(role);
                    }
                }
                Ok(LoadedPluginSummary {
                    plugin_id: info.plugin_id,
                    plugin_name: info.plugin_name,
                    note_port_index: info.note_port_index,
                })
            }
            Ok(Err(e)) => Err(WrapError::Clap(e)),
            Err(_) => Err(WrapError::Clap("clap host thread dropped reply".into())),
        }
    }

    /// feature `clap-host` 無効ビルド用の stub。TS は UNAVAILABLE を warn-once で握り潰す。
    #[cfg(not(feature = "clap-host"))]
    pub fn load_plugin(
        &self,
        _path: PathBuf,
        _plugin_id: Option<String>,
        _role: ClapPluginRole,
    ) -> Result<LoadedPluginSummary, WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' feature".into(),
        ))
    }

    /// active-note 台帳の poison 方針を一箇所で強制する。poison は回復せず、呼び手へ大声の
    /// runtime error として返す。
    #[cfg(feature = "outproc-instrument")]
    fn lock_active_notes(&self) -> Result<MutexGuard<'_, ActivePluginNotes>, WrapError> {
        self.active_plugin_notes.lock().map_err(|_| {
            WrapError::OutProcInstrument("active plugin note tracker mutex poisoned".into())
        })
    }
}

mod build_and_load;
mod bus_lines;
mod bus_stages;
mod device_link;
mod effect_slot_types;
mod instrument_slot_types;
mod notes;
mod outproc_effect_chain;
mod outproc_effect_replace;
mod outproc_effect_slots;
mod outproc_instrument_slots;
mod playback;
mod slot_errors;
mod slot_helpers;
// 🔴 第 8 束: `slot_helpers` は `impl EngineWrap` の**外**にある自由関数と小さな型を持つ。
// 親（本モジュール）とその子モジュールが名前で参照しているので、glob で親のスコープへ戻す。
// これが無いと `cannot find function ... in this scope` になる（`pub(super)` は可視性を
// 上げるだけで、名前をスコープへ持ち込むわけではない）。
#[allow(unused_imports)]
use bus_stages::*;
#[allow(unused_imports)]
use device_link::*;
#[allow(unused_imports)]
use effect_slot_types::*;
#[allow(unused_imports)]
use instrument_slot_types::*;
#[allow(unused_imports)]
use plugin_ui_wiring::*;
// 🔴 default 象限では unused に見えるが、`outproc-*` 象限のインラインテストと
// 兄弟モジュールが `super::ChildSlot` 等でここ経由の名前に到達する。単一象限の
// unused 警告だけで消すと `check-cfg-matrix.sh` の両 feature 象限が E0432 で落ちる。
#[allow(unused_imports)]
use role::*;
// 🔴 `main.rs` が `orbit_audio_daemon::engine_wrap::DeviceSwitchRequest` を import している。
pub use device_link::DeviceSwitchRequest;
pub use role::ClapPluginRole;
// 🔴 第 12 束: wire に載る公開型は `session.rs` / `main.rs` から名前で参照されるので再エクスポート。
pub use playback::LoadedSample;
pub use wire_types::*;
// 🔴 `session.rs` のテストが `crate::engine_wrap::test_wrap_with_three_stage_topology` を
// 名前で import している。
#[cfg(all(test, feature = "outproc-effect"))]
pub(crate) use bus_stages::test_wrap_with_three_stage_topology;
// 🔴 `outproc_effect.rs` / `outproc_instrument.rs` / `outproc_respawn_guard.rs` が
// `crate::engine_wrap::` から名前で import している。移動先が子モジュールになったので
// **親から再エクスポート**する（cfg は定義側と一致させること）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) use plugin_ui_wiring::{
    enqueue_plugin_ui_closed_by_respawn, enqueue_plugin_ui_notification, PluginUiIndexBinding,
    PluginUiRouteRegistry, PluginUiWiring,
};
// 🔴 `session.rs` が `crate::engine_wrap::{BusKind, BusLineDest, BusLineOp, SourceRoutingTarget}`
// を名前で import している。移動先が子モジュールになったので、**親から再エクスポート**する
// （`use` は既定で private なので `pub(crate) use` が要る）。
// 🔴 cfg は**定義側と一致させる**。`SourceRoutingTarget` だけ
// `any(test, all(outproc-effect, outproc-instrument))` で他の 3 つと条件が違う。
#[cfg(any(test, all(feature = "outproc-effect", feature = "outproc-instrument")))]
pub(crate) use effect_slot_types::SourceRoutingTarget;
#[cfg(feature = "outproc-effect")]
pub(crate) use effect_slot_types::{BusKind, BusLineDest, BusLineOp};
#[allow(unused_imports)]
use slot_errors::*;
#[allow(unused_imports)]
use slot_helpers::*;
mod plugin_ui;
mod plugin_ui_wiring;
mod role;
mod startup;
mod startup_instrument;
mod stats;
mod wire_types;

#[cfg(feature = "outproc-instrument")]
pub(crate) fn record_latest_state_after_save(
    latest_state: &Arc<Mutex<Option<PathBuf>>>,
    final_path: PathBuf,
) -> Result<(), WrapError> {
    *latest_state.lock().map_err(|_| {
        WrapError::PluginStateProtocol("latest-state mutex poisoned after save".into())
    })? = Some(final_path);
    Ok(())
}

#[cfg(feature = "clap-host")]
#[cfg(test)]
mod plugin_load_gate_tests {
    use super::*;
    use orbit_audio_native::StreamStats;

    // `Self::build` は clap: Mutex::new(None)（test backend 相当）で構築するため、実 device・実
    // ClapControl 無しで plugin_loaded ガードだけを検証できる（#405）。
    fn unstarted_engine() -> Arc<EngineWrap> {
        let engine = orbit_audio_core::Engine::new(48_000, 2);
        EngineWrap::build(
            engine,
            "test-device".to_string(),
            48_000,
            2,
            Arc::new(StreamStats::default()),
            Arc::new(AtomicU32::new(1.0_f32.to_bits())),
        )
    }

    /// plugin 未ロード時に `f` が **専用の** `WrapError::ClapNotLoaded` を返すことを検証する共通
    /// アサーション（note_on/note_off の2テストは setup・assertion が同一で呼び出しメソッドのみ
    /// 異なるため、ここに集約・/simplify レビュー #407）。
    ///
    /// `is_err()` だけの弱いアサーションだと、`push_plugin_event` 冒頭の `plugin_loaded` ガード
    /// （#405 の本体）を丸ごと削除しても、後段の `guard.as_mut().ok_or_else(...)` が
    /// `clap: Mutex::new(None)`（test backend）により `WrapError::ClapUnavailable` を返すため
    /// テストが通ってしまい、回帰保護にならない（PR #407 レビュー finding）。variant を pin する
    /// ことで、ガード削除時は `ClapUnavailable`（≠ `ClapNotLoaded`）が返り `matches!` が偽になって
    /// 確実に fail する（このテストの自己検証: ガードを一時的にコメントアウトして fail することを
    /// `cargo test --features clap-host plugin_load_gate_tests` で確認済み）。
    fn assert_rejected_before_load(f: impl FnOnce(&EngineWrap) -> Result<(), WrapError>) {
        let wrap = unstarted_engine();
        let result = f(&wrap);
        assert!(
            matches!(result, Err(WrapError::ClapNotLoaded(_))),
            "plugin 未ロード時は WrapError::ClapNotLoaded を返すべき（#405）。got: {result:?}"
        );
    }

    #[test]
    fn note_on_before_load_returns_explicit_error_not_success() {
        assert_rejected_before_load(|wrap| wrap.plugin_note_on(60, 0, 0.8, None));
    }

    #[test]
    fn note_off_before_load_returns_explicit_error_not_success() {
        assert_rejected_before_load(|wrap| wrap.plugin_note_off(60, 0, 0.0, None));
    }

    #[test]
    fn plugin_loaded_flag_defaults_false() {
        let wrap = unstarted_engine();
        assert!(!wrap.plugin_loaded.load(Ordering::Relaxed));
    }

    /// `wrap.clap` へ実 `ClapControl` を直接注入する共通セットアップ（PR #406 の private
    /// フィールド直接注入手法）。呼び出し側は event ring の consumer と LoadPlugin コマンドの
    /// receiver の両方を受け取り、不要な方は `_` で捨てる（`loaded_engine`/`loadable_engine`
    /// が共有・/simplify レビュー #412: 個別に組み立てると `ClapControl` のフィールド変更が
    /// 2箇所同時保守になる）。
    fn wire_clap_control(
        wrap: &Arc<EngineWrap>,
    ) -> (
        orbit_clap_host::PluginEventConsumer,
        std::sync::mpsc::Receiver<crate::clap_host::ClapCommand>,
    ) {
        let (event_tx, event_rx) = orbit_clap_host::make_event_ring(16);
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let stats = orbit_clap_host::ClapProcessorStats::new();
        let cb_stats = orbit_audio_native::CallbackTimeStats::new();
        *wrap.clap.lock().expect("clap mutex") = Some(ClapControl {
            cmd_tx,
            loaded_role: None,
            event_tx,
            stats,
            cb_stats,
        });
        (event_rx, cmd_rx)
    }

    /// `unstarted_engine` に `wire_clap_control` で実 `ClapControl` を構築注入し、
    /// `plugin_loaded = true` かつ `clap = Some(...)` な wrap を返す。呼び出し側は
    /// 返る consumer で event ring への実配送を検証できる（positive-path・#405 finding 3）。
    /// `cmd_rx` は保持しない（LoadPlugin コマンドは実際には送らないため不要）。
    fn loaded_engine() -> (Arc<EngineWrap>, orbit_clap_host::PluginEventConsumer) {
        let wrap = unstarted_engine();
        let (event_rx, _cmd_rx) = wire_clap_control(&wrap);
        wrap.plugin_loaded.store(true, Ordering::Relaxed);
        (wrap, event_rx)
    }

    /// `unstarted_engine` に `wire_clap_control` で実 `ClapControl` を構築注入するが、
    /// `loaded_engine` と異なり `plugin_loaded` は事前に store しない。呼び出し側は
    /// `load_plugin()` を実際に呼び、その成功分岐が `plugin_loaded` を true にすることを
    /// `cmd_rx` 経由の LoadPlugin コマンド応答で検証できる（#411）。
    fn loadable_engine() -> (
        Arc<EngineWrap>,
        std::sync::mpsc::Receiver<crate::clap_host::ClapCommand>,
    ) {
        let wrap = unstarted_engine();
        let (_event_rx, cmd_rx) = wire_clap_control(&wrap);
        (wrap, cmd_rx)
    }

    #[test]
    fn load_plugin_success_sets_plugin_loaded_flag() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            // `recv_timeout` で fail-fast にする（`clap_host.rs` の専用スレッド pump loop と同じ
            // パターン）。現状 `load_plugin()` は必ず send 後に待つため無期限 `recv()` でも通るが、
            // 将来の regression（lock 順序ミス等で send 前に return する等）が入ると無期限ブロックし、
            // `rust-ci.yml` に `timeout-minutes` 未設定のため CI job が GitHub Actions のデフォルト
            // 上限（最大6時間）までハングしてから失敗する fail-slow リスクがある
            // （pr-test-analyzer / silent-failure-hunter 独立指摘・PR #412）。
            let cmd = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("load_plugin should send LoadPlugin within 5s");
            // `ClapCommand` は現状 `LoadPlugin` の1バリアントのみなので irrefutable pattern
            // で受けられる（/simplify レビュー #412: match 1本腕は不要なネスト）。
            let crate::clap_host::ClapCommand::LoadPlugin {
                path,
                plugin_id,
                sample_rate,
                channels,
                max_frames,
                reply,
            } = cmd;
            assert_eq!(path, PathBuf::from("dummy.clap"));
            assert_eq!(plugin_id, None);
            assert_eq!(sample_rate, 48_000);
            assert_eq!(channels, 2);
            assert_eq!(max_frames, CLAP_MAX_FRAMES);
            reply
                .send(Ok(orbit_clap_host::LoadedPluginInfo {
                    plugin_id: "com.example.dummy".to_string(),
                    plugin_name: Some("Dummy".to_string()),
                    note_port_index: 0,
                }))
                .expect("load_plugin should still be waiting for reply");
        });

        let result = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");

        // `LoadedPluginSummary` は Debug 未実装のため `assert!(result.is_ok(), "{result:?}")`
        // が使えない（sibling の `note_on_after_load_reaches_ring` は `Result<(), WrapError>` で
        // `()` が Debug のため同型の assert! が効くが、ここは Err 側だけ表示する）。
        if let Err(err) = result {
            panic!("load_plugin should succeed: {err:?}");
        }
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "load_plugin success branch must set plugin_loaded"
        );
    }

    #[test]
    fn same_role_resend_reaches_existing_already_loaded_path() {
        let (wrap, cmd_rx) = loadable_engine();
        wrap.clap
            .lock()
            .expect("clap mutex")
            .as_mut()
            .expect("clap control")
            .loaded_role = Some(ClapPluginRole::Effect);
        let responder = std::thread::spawn(move || {
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("same-role resend should reach clap host");
            reply
                .send(Err("AlreadyLoaded".to_string()))
                .expect("caller should wait for reply");
        });

        let result = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");
        assert!(
            matches!(result, Err(WrapError::Clap(message)) if message == "AlreadyLoaded"),
            "same-role resend must preserve the clap host's AlreadyLoaded behavior"
        );
    }

    #[test]
    fn failed_first_load_leaves_role_unset_and_permits_a_different_role() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            for message in ["first load failed", "second load failed"] {
                let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("both loads should reach clap host while no role is loaded");
                reply
                    .send(Err(message.to_string()))
                    .expect("caller waits for reply");
            }
        });

        let first = wrap.load_plugin(PathBuf::from("first.clap"), None, ClapPluginRole::Effect);
        assert!(matches!(first, Err(WrapError::Clap(message)) if message == "first load failed"));
        assert_eq!(
            wrap.clap
                .lock()
                .expect("clap mutex")
                .as_ref()
                .expect("clap control")
                .loaded_role,
            None,
            "failed first load must not claim a role"
        );

        let second = wrap.load_plugin(
            PathBuf::from("second.clap"),
            None,
            ClapPluginRole::Instrument,
        );
        responder.join().expect("responder thread should not panic");
        assert!(
            matches!(second, Err(WrapError::Clap(message)) if message == "second load failed"),
            "different role after a failed first load must reach clap host, not cross-role reject"
        );
    }

    #[test]
    fn failed_same_role_reload_preserves_the_successfully_loaded_role() {
        let (wrap, cmd_rx) = loadable_engine();
        let responder = std::thread::spawn(move || {
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("first load should reach clap host");
            reply
                .send(Ok(orbit_clap_host::LoadedPluginInfo {
                    plugin_id: "com.example.dummy".to_string(),
                    plugin_name: Some("Dummy".to_string()),
                    note_port_index: 0,
                }))
                .expect("caller waits for first reply");
            let crate::clap_host::ClapCommand::LoadPlugin { reply, .. } = cmd_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("same-role reload should reach clap host");
            reply
                .send(Err("reload failed".to_string()))
                .expect("caller waits for reload reply");
        });

        let first = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        assert!(first.is_ok(), "first load should succeed");
        let reload = wrap.load_plugin(PathBuf::from("dummy.clap"), None, ClapPluginRole::Effect);
        responder.join().expect("responder thread should not panic");
        assert!(matches!(reload, Err(WrapError::Clap(message)) if message == "reload failed"));
        assert_eq!(
            wrap.clap
                .lock()
                .expect("clap mutex")
                .as_ref()
                .expect("clap control")
                .loaded_role,
            Some(ClapPluginRole::Effect),
            "failed same-role reload must preserve the successful load's role"
        );
    }

    #[test]
    fn different_role_resend_is_rejected_before_clap_host_replacement() {
        let (wrap, cmd_rx) = loadable_engine();
        wrap.clap
            .lock()
            .expect("clap mutex")
            .as_mut()
            .expect("clap control")
            .loaded_role = Some(ClapPluginRole::Effect);

        let result = wrap.load_plugin(
            PathBuf::from("dummy.clap"),
            None,
            ClapPluginRole::Instrument,
        );
        assert!(
            matches!(result, Err(WrapError::ClapCrossRoleRejected(_))),
            "different role must be rejected before the single slot can be replaced"
        );
        assert!(
            matches!(
                cmd_rx.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "cross-role rejection must not send a replacement command to clap host"
        );
    }

    #[test]
    fn note_on_after_load_reaches_ring() {
        let (wrap, mut consumer) = loaded_engine();
        let result = wrap.plugin_note_on(60, 0, 0.8, None);
        assert!(result.is_ok(), "load 後は成功するはず: {result:?}");
        match consumer.pop() {
            Ok(orbit_clap_host::PluginEvent::NoteOn {
                key,
                channel,
                velocity,
            }) => {
                assert_eq!(key, 60);
                assert_eq!(channel, 0);
                assert_eq!(velocity, 0.8);
            }
            other => panic!("event ring に NoteOn が届いているべき。got: {other:?}"),
        }
    }

    #[test]
    fn note_off_after_load_reaches_ring() {
        let (wrap, mut consumer) = loaded_engine();
        let result = wrap.plugin_note_off(60, 0, 0.0, None);
        assert!(result.is_ok(), "load 後は成功するはず: {result:?}");
        match consumer.pop() {
            Ok(orbit_clap_host::PluginEvent::NoteOff {
                key,
                channel,
                velocity,
            }) => {
                assert_eq!(key, 60);
                assert_eq!(channel, 0);
                assert_eq!(velocity, 0.0);
            }
            other => panic!("event ring に NoteOff が届いているべき。got: {other:?}"),
        }
    }

    /// monotonic invariant（finding 4）: `plugin_loaded` への書き込みは**本番コード**中
    /// `load_plugin` 成功時の1箇所のみ（`grep -n "plugin_loaded.store" engine_wrap.rs` で確認可能。
    /// このテストモジュール内の `loaded_engine()` ヘルパーによる直接注入は別途1箇所ヒットするが、
    /// それは test-only の注入であり本番の書き込み経路ではない）。false に戻す経路は本番コードに
    /// 存在しない。runtime test で reset を再現する手段が無いため、ここでは複数回 push が成功し
    /// 続けフラグが true のままであることだけを軽量に確認する。
    #[test]
    fn plugin_loaded_flag_stays_true_across_multiple_events() {
        let (wrap, mut consumer) = loaded_engine();
        assert!(wrap.plugin_note_on(60, 0, 0.5, None).is_ok());
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "1回目 push 後も true のまま"
        );
        assert!(wrap.plugin_note_off(60, 0, 0.0, None).is_ok());
        assert!(
            wrap.plugin_loaded.load(Ordering::Relaxed),
            "2回目 push 後も true のまま（reset 経路が無いことの確認）"
        );
        assert!(consumer.pop().is_ok());
        assert!(consumer.pop().is_ok());
    }
}

#[cfg(all(test, feature = "outproc-effect", not(feature = "outproc-instrument")))]
mod outproc_effect_eager_start_tests {
    use super::{EngineWrap, WrapError};
    use crate::outproc_effect::{OutProcEffectConfig, PluginFormat};
    use std::path::PathBuf;

    #[test]
    fn eager_effect_start_requires_a_plugin_path_before_device_access() {
        let result = EngineWrap::start_outproc_effect(OutProcEffectConfig {
            format: PluginFormat::Clap,
            child_exe: PathBuf::from("unused-child"),
            plugin: None,
            plugin_id: None,
            buffer_frames: None,
        });
        assert!(
            matches!(result, Err(WrapError::OutProcEffect(message)) if message == "eager start requires a plugin path")
        );
    }
}

#[cfg(all(test, feature = "outproc-instrument", not(feature = "outproc-effect")))]
mod outproc_instrument_eager_start_tests {
    use super::{EngineWrap, WrapError};
    use crate::outproc_instrument::OutProcInstrumentConfig;
    use std::path::PathBuf;

    #[test]
    fn eager_instrument_start_requires_a_plugin_path_before_device_access() {
        let result = EngineWrap::start_outproc_instrument(OutProcInstrumentConfig {
            child_exe: PathBuf::from("unused-child"),
            plugin: None,
            plugin_id: None,
            buffer_frames: None,
            slots: 1,
        });
        assert!(
            matches!(result, Err(WrapError::OutProcInstrument(message)) if message == "eager start requires a plugin path")
        );
    }
}

#[cfg(any(feature = "clap-host", feature = "outproc-instrument"))]
#[cfg(test)]
mod plugin_event_ring_retry_tests {
    use super::{push_with_bounded_retry, Ordering, PushAttemptOutcome};
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;

    /// test 用の1回試行クロージャ。本番の `push_plugin_event` と異なり mutex 越しではなく
    /// `rtrb::Producer` を直接 push するだけ（lock scope の検証は責務外・retry ロジックのみ検証）。
    fn attempt_push(producer: &mut rtrb::Producer<u32>, item: u32) -> PushAttemptOutcome<u32> {
        match producer.push(item) {
            Ok(()) => PushAttemptOutcome::Sent,
            Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
        }
    }

    #[test]
    fn succeeds_immediately_when_space_available() {
        let (mut tx, _rx) = rtrb::RingBuffer::<u32>::new(4);
        let overflow = AtomicU64::new(0);
        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            42,
            5,
            Duration::from_millis(1),
            &overflow,
            || super::WrapError::Clap("test ring exhausted".into()),
        );
        assert!(result.is_ok());
        assert_eq!(overflow.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn retries_then_succeeds_once_consumer_drains() {
        let (mut tx, mut rx) = rtrb::RingBuffer::<u32>::new(1);
        tx.push(1).expect("fill capacity 1");
        let overflow = AtomicU64::new(0);

        // audio callback が数 ms 後に ring を drain する状況を模擬する。
        let drain_handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            let _ = rx.pop();
        });

        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            2,
            50,
            Duration::from_millis(1),
            &overflow,
            || super::WrapError::Clap("test ring exhausted".into()),
        );
        drain_handle.join().expect("drain thread should not panic");

        assert!(result.is_ok(), "should succeed once consumer drains space");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            0,
            "successful retry must not count as overflow"
        );
    }

    #[test]
    fn gives_up_and_counts_overflow_when_ring_stays_full() {
        let (mut tx, _rx) = rtrb::RingBuffer::<u32>::new(1);
        tx.push(1).expect("fill capacity 1");
        let overflow = AtomicU64::new(0);

        // _rx を drain せずに保持したまま(＝満杯が解消しない)、少ない retry 回数で確実に諦めさせる。
        let result = push_with_bounded_retry(
            |item| attempt_push(&mut tx, item),
            2,
            3,
            Duration::from_millis(1),
            &overflow,
            || super::WrapError::Clap("test ring exhausted".into()),
        );

        assert!(result.is_err(), "should give up after max_attempts");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            1,
            "overflow counter must increment exactly once on give-up"
        );
    }

    #[test]
    fn fatal_outcome_short_circuits_without_retry_or_overflow_count() {
        let overflow = AtomicU64::new(0);
        let mut calls = 0u32;
        let result: Result<(), super::WrapError> = push_with_bounded_retry(
            |_item| {
                calls += 1;
                PushAttemptOutcome::Fatal(super::WrapError::Clap("clap mutex poisoned".into()))
            },
            42u32,
            5,
            Duration::from_millis(1),
            &overflow,
            || super::WrapError::Clap("test ring exhausted".into()),
        );

        assert!(result.is_err(), "fatal outcome must propagate as an error");
        assert_eq!(calls, 1, "fatal outcome must not retry");
        assert_eq!(
            overflow.load(Ordering::Relaxed),
            0,
            "fatal outcome is not an overflow (retrying would not have helped)"
        );
    }
}

/// `push_plugin_event`（`plugin_note_on`/`plugin_note_off` の共通経路）を、test backend
/// （`clap: Mutex<Option<ClapControl>>` が `None`）越しに直接叩く（#402 pr-test-analyzer 指摘: 上の
/// `plugin_event_ring_retry_tests` は `push_with_bounded_retry` を bare `rtrb::Producer` クロージャで
/// 検証するのみで、本番の `push_plugin_event` クロージャ（mutex lock/poison 分岐・
/// `guard.as_mut() == None` → `ClapUnavailable` の Fatal 分岐）を一度も経由していなかった）。
///
/// `Sent` 分岐（実際に event ring へ push が成功する）と mutex-poisoned 分岐は、実 clap-host
/// 初期化済み `EngineWrap`（`EngineWrap::start()` が spawn する専用スレッド + 実 audio stream）が
/// 要るため practical でない。ここでは `start_with(StubBackend)` で到達可能な None/ClapUnavailable
/// 分岐にスコープする。`plugin_loaded` は #405 のガードが先に短絡してしまわないよう明示的に true を
/// セットしてから叩く（このモジュールの狙いは「ロード済みなのに clap ハンドルが無い」分岐であり
/// 「未ロード」分岐ではない・#407 との merge で `push_plugin_event` にガードが追加されたことへの
/// 追従）。
#[cfg(feature = "clap-host")]
#[cfg(test)]
mod push_plugin_event_tests {
    use super::{EngineWrap, WrapError};
    use crate::backend::StubBackend;

    #[test]
    fn plugin_note_on_returns_clap_unavailable_when_clap_not_initialized() {
        let (engine, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");
        engine
            .plugin_loaded
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let before = engine.plugin_event_ring_overflow_count();

        let err = engine
            .plugin_note_on(60, 0, 0.8, None)
            .expect_err("test backend has no clap control (clap field is None)");

        assert!(
            matches!(err, WrapError::ClapUnavailable(_)),
            "expected ClapUnavailable (Fatal short-circuit), got {err:?}"
        );
        assert_eq!(
            engine.plugin_event_ring_overflow_count(),
            before,
            "Fatal short-circuit must not be counted as a bounded-retry overflow"
        );
    }

    #[test]
    fn plugin_note_off_returns_clap_unavailable_when_clap_not_initialized() {
        let (engine, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");
        engine
            .plugin_loaded
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let before = engine.plugin_event_ring_overflow_count();

        let err = engine
            .plugin_note_off(60, 0, 0.0, None)
            .expect_err("test backend has no clap control (clap field is None)");

        assert!(
            matches!(err, WrapError::ClapUnavailable(_)),
            "expected ClapUnavailable (Fatal short-circuit), got {err:?}"
        );
        assert_eq!(
            engine.plugin_event_ring_overflow_count(),
            before,
            "Fatal short-circuit must not be counted as a bounded-retry overflow"
        );
    }

    #[test]
    fn plugin_all_notes_off_is_a_noop_without_an_outproc_ledger() {
        let (engine, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend starts");

        let summary = engine
            .plugin_all_notes_off()
            .expect("clap-only build has no tracked outproc notes to release");

        assert_eq!(summary, Default::default());
    }
}

#[cfg(test)]
mod capture_path_tests {
    use super::resolve_capture_path;
    use std::path::PathBuf;

    #[test]
    fn none_when_unset() {
        assert_eq!(resolve_capture_path(None), None);
    }

    #[test]
    fn none_when_empty() {
        assert_eq!(resolve_capture_path(Some(String::new())), None);
    }

    #[test]
    fn none_when_whitespace_only() {
        assert_eq!(resolve_capture_path(Some("   ".to_string())), None);
    }

    #[test]
    fn resolves_plain_path() {
        assert_eq!(
            resolve_capture_path(Some("/tmp/out.wav".to_string())),
            Some(PathBuf::from("/tmp/out.wav"))
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        // 前後の空白は落として実パスにする（untrimmed だと存在しないパス名になり capture が
        // silent に失敗する）。
        assert_eq!(
            resolve_capture_path(Some("  /tmp/out.wav  ".to_string())),
            Some(PathBuf::from("/tmp/out.wav"))
        );
    }
}

#[cfg(test)]
mod startup_options_tests {
    use super::{parse_output_fault, StartupOptions};
    use orbit_audio_native::OutputFault;

    #[test]
    fn parses_output_fault_names_and_defaults_unknown_values_to_none() {
        assert_eq!(parse_output_fault(None), OutputFault::None);
        assert_eq!(
            parse_output_fault(Some("dead-probe-requested")),
            OutputFault::DeadProbeRequested
        );
        assert_eq!(
            parse_output_fault(Some("DeadAllProbes")),
            OutputFault::DeadAllProbes
        );
        assert_eq!(
            parse_output_fault(Some("dead-real-stream")),
            OutputFault::DeadRealStream
        );
        assert_eq!(parse_output_fault(Some("unknown")), OutputFault::None);
    }

    #[test]
    fn startup_options_only_honor_faults_when_the_gate_is_enabled() {
        let args = ["--audio-device".to_string(), "USB Audio".to_string()];
        assert_eq!(
            StartupOptions::from_args_and_env(
                args.clone(),
                Some("Environment Audio"),
                false,
                Some("dead-all-probes"),
            ),
            StartupOptions {
                device_name: Some("USB Audio".to_string()),
                fault: OutputFault::None,
            }
        );
        assert_eq!(
            StartupOptions::from_args_and_env(args, None, true, Some("dead-all-probes")),
            StartupOptions {
                device_name: Some("USB Audio".to_string()),
                fault: OutputFault::DeadAllProbes,
            }
        );
    }
}

/// device switch（#484 D2）: `select_audio_device` の非 cpal 分岐（capture 拒否・
/// owner thread 未生存）を `StubBackend`（実 cpal I/O を伴わない test backend）で検証する。
/// 実際の cpal `Device`/`Stream` 差し替えそのもの（`apply_device_switch`）は実機 gated harness の
/// 領域（unit test では検証不能）。
#[cfg(test)]
mod select_audio_device_tests {
    use super::{probe_then_pause_old, EngineWrap, OutputFault, StreamConfigSnapshot, WrapError};
    use crate::backend::StubBackend;
    use crate::test_tracing::{capture_tracing, simulate_subscriberless_rebuild};
    use orbit_audio_native::OutputError;
    use std::cell::RefCell;
    use std::sync::Arc;

    #[test]
    fn probe_completes_before_pause_and_probe_failure_never_pauses() {
        let calls = RefCell::new(Vec::new());
        let selected = probe_then_pause_old(
            || {
                calls.borrow_mut().push("probe");
                Ok("live")
            },
            || {
                calls.borrow_mut().push("pause");
                Ok(())
            },
        )
        .expect("successful probe should proceed to pause");
        assert_eq!(selected, "live");
        assert_eq!(*calls.borrow(), ["probe", "pause"]);

        calls.borrow_mut().clear();
        let failed = probe_then_pause_old::<()>(
            || {
                calls.borrow_mut().push("probe");
                Err(OutputError::NoDevice)
            },
            || {
                calls.borrow_mut().push("pause");
                Ok(())
            },
        );
        assert!(matches!(failed, Err(OutputError::NoDevice)));
        assert_eq!(*calls.borrow(), ["probe"]);
    }

    /// capture-active（`ORBIT_CAPTURE_WAV`）拒否と、audio owner thread 未登録（`start_with` /
    /// test backend 経路）拒否の両方を **1 テスト関数内**で順に検証する。`ORBIT_CAPTURE_WAV` は
    /// プロセス全体で共有される可変状態なので、別テスト関数に分けて cargo test のデフォルト並列
    /// 実行に晒すと set/remove がレースする（`named_bus_pool_tests` の既存 env 慣習と同じ落とし穴）。
    #[test]
    fn select_audio_device_records_capture_owner_and_send_rejections() {
        // SAFETY: テスト専用の単一テスト関数内 env 操作（このテストの実行区間でのみ意味を持つ値）。
        unsafe {
            std::env::set_var("ORBIT_CAPTURE_WAV", "/tmp/does-not-matter.wav");
        }
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let capture_error = wrap
            .select_audio_device(Some("Any Device".to_string()))
            .expect_err("capture-active must reject the switch");
        assert!(
            format!("{capture_error}").contains("ORBIT_CAPTURE_WAV is active"),
            "{capture_error}"
        );
        assert!(wrap
            .stream_config_snapshot()
            .last_switch_failure
            .as_deref()
            .is_some_and(|reason| reason.contains("ORBIT_CAPTURE_WAV is active")));

        // capture を無効化すると test backend は owner thread 未登録として明示的に reject する。
        unsafe {
            std::env::remove_var("ORBIT_CAPTURE_WAV");
        }
        let no_owner_error = wrap
            .select_audio_device(None)
            .expect_err("no owner thread must reject the switch");
        assert!(
            format!("{no_owner_error}").contains("no audio owner thread"),
            "{no_owner_error}"
        );
        assert!(wrap
            .stream_config_snapshot()
            .last_switch_failure
            .as_deref()
            .is_some_and(|reason| reason.contains("no audio owner thread")));

        let (tx, rx) = std::sync::mpsc::channel();
        drop(rx);
        wrap.install_device_switch_channel(tx);
        let send_error = wrap
            .select_audio_device(Some("Disconnected Device".into()))
            .expect_err("closed owner channel must reject the switch");
        assert!(
            format!("{send_error}").contains("audio owner thread has exited"),
            "{send_error}"
        );
        assert!(wrap
            .stream_config_snapshot()
            .last_switch_failure
            .as_deref()
            .is_some_and(|reason| reason.contains("audio owner thread has exited")));
    }

    #[test]
    fn stream_config_snapshot_replaces_all_effective_fields_together() {
        let (wrap, _guard) = EngineWrap::start_with(StubBackend {
            sample_rate: 44_100,
            channels: 1,
        })
        .expect("stub backend start");
        assert_eq!(
            wrap.stream_config_snapshot(),
            StreamConfigSnapshot {
                device_name: "test audio backend".to_string(),
                sample_rate: 44_100,
                channels: 1,
                device_requested: None,
                device_fell_back: false,
                fallback_reason: None,
                first_callback_ms: 0,
                last_switch_failure: None,
                output_fault: OutputFault::None,
            }
        );

        wrap.record_stream_config(
            StreamConfigSnapshot {
                device_name: "switched output".to_string(),
                sample_rate: 96_000,
                channels: 6,
                device_requested: Some("requested output".to_string()),
                device_fell_back: true,
                fallback_reason: Some("test fallback".to_string()),
                first_callback_ms: 12,
                last_switch_failure: None,
                output_fault: OutputFault::DeadProbeRequested,
            },
            None,
            None,
        );

        let switched = wrap.stream_config_snapshot();
        assert_eq!(switched.device_name, "switched output");
        assert_eq!(
            switched.device_requested.as_deref(),
            Some("requested output")
        );
        assert!(switched.device_fell_back);
        assert_eq!(switched.fallback_reason.as_deref(), Some("test fallback"));
        assert_eq!(switched.first_callback_ms, 12);
        assert_eq!(wrap.output_sample_rate(), 96_000);
        assert_eq!(wrap.output_channels(), 6);
    }

    #[test]
    fn device_switch_result_records_failure_and_success_through_the_same_path() {
        let (wrap, _guard) = EngineWrap::start_with(StubBackend {
            sample_rate: 48_000,
            channels: 2,
        })
        .expect("stub backend start");
        let original = wrap.stream_config_snapshot();
        let failed = Err(WrapError::Output(OutputError::StreamDead {
            device: "Rejected Output".to_string(),
            waited_ms: 3_000,
            phase: orbit_audio_native::StreamLivenessPhase::Probe,
        }));
        let ((), rendered) = capture_tracing(tracing::Level::ERROR, || {
            wrap.record_device_switch_result(Some("Requested Output"), &failed, None, None);
        });

        let rejected = wrap.stream_config_snapshot();
        assert_eq!(rejected.device_name, original.device_name);
        assert_eq!(rejected.sample_rate, original.sample_rate);
        assert_eq!(rejected.channels, original.channels);
        assert!(rejected
            .last_switch_failure
            .as_deref()
            .is_some_and(|reason| reason.contains("produced no callback within 3000 ms")));
        assert!(rendered.contains("ERROR"), "captured log: {rendered:?}");
        assert_eq!(
            rendered
                .lines()
                .filter(
                    |line| line.contains("audio output device switch") && line.contains("failed")
                )
                .count(),
            1,
            "captured log: {rendered:?}"
        );
        assert!(
            rendered.contains("Requested Output")
                && rendered.contains("produced no callback within 3000 ms"),
            "captured log: {rendered:?}"
        );

        let mut selected = original;
        selected.device_name = "Selected Output".to_string();
        selected.device_requested = Some("Requested Output".to_string());
        selected.first_callback_ms = 9;
        selected.last_switch_failure = None;
        let succeeded = Ok((selected.device_name.clone(), selected.clone()));
        wrap.record_device_switch_result(Some("Requested Output"), &succeeded, None, None);

        assert_eq!(wrap.stream_config_snapshot(), selected);
    }

    #[test]
    fn device_switch_capture_survives_subscriberless_first_registration_and_rebuild() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let failed = Err(WrapError::Output(OutputError::StreamDead {
            device: "Rejected Output".to_string(),
            waited_ms: 3_000,
            phase: orbit_audio_native::StreamLivenessPhase::Probe,
        }));

        let ((), log) = capture_tracing(tracing::Level::ERROR, || {
            // Exercise the culprit's product path without a subscriber while capture is active.
            let other_thread_wrap = Arc::clone(&wrap);
            std::thread::spawn(move || {
                other_thread_wrap.record_device_switch_failure_for_test("Other", "poke");
            })
            .join()
            .expect("subscriber-less product call thread");

            // Model a late interest write even when another test registered the callsite first.
            std::thread::spawn(simulate_subscriberless_rebuild)
                .join()
                .expect("subscriber-less callsite rebuild thread");

            wrap.record_device_switch_result(Some("Requested Output"), &failed, None, None);
        });

        assert_eq!(
            log.lines()
                .filter(
                    |line| line.contains("audio output device switch") && line.contains("failed")
                )
                .count(),
            1,
            "captured log: {log:?}"
        );
    }
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod outproc_load_error_test_support {
    use super::{ChildLaunch, ChildSlot, EngineWrap, OutProcRole, PluginUiWiring, WrapError};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    type InjectedSlot<R> = (Arc<EngineWrap>, Arc<Mutex<ChildSlot<R>>>);

    /// テストのセットアップ段階（child spawn 等）の完了待ち上限。検証対象の性質ではなく
    /// 「セットアップが終わらないなら何かが壊れている」の保険なので、CI の高負荷でも
    /// 越えない大きな値にする（#491: 2s では遅い runner で spawn が間に合わず flake）。
    /// 各ポーリングループは条件成立で即抜けるため、正常時の所要時間には影響しない。
    const SETUP_DEADLINE: Duration = Duration::from_secs(30);

    /// パニックメッセージ用に slot の**種別だけ**を名乗る（中身は出さない）。
    ///
    /// #529: 失敗時に「どの状態で止まっていたか」が分かると、離脱経路の同定が効く
    /// （Empty = spawn 失敗 / ready timeout、Closed = shm open 失敗 / supervisor 失敗）。
    fn slot_kind<R: OutProcRole>(slot: &Mutex<ChildSlot<R>>) -> &'static str {
        match &*slot.lock().expect("lock child slot for diagnostics") {
            ChildSlot::Empty(_) => "Empty",
            ChildSlot::Loading { .. } => "Loading",
            ChildSlot::Active { .. } => "Active",
            ChildSlot::Closed => "Closed",
        }
    }

    fn child_launch<R: OutProcRole>(
        shm_path: PathBuf,
        child_exe: PathBuf,
        stats: Arc<R::Stats>,
    ) -> ChildLaunch<R> {
        ChildLaunch {
            shm_path,
            child_exe,
            sample_rate: 48_000,
            stats,
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: true,
        }
    }

    pub(super) fn open_shared_failure_closes_slot<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let stats = R::new_stats();
        let launch = child_launch::<R>(
            shm_path,
            PathBuf::from("unused-child-executable"),
            stats.clone(),
        );
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(plugin_path),
                None,
                None,
            )
            .expect_err("missing shared memory must fail before spawn");

        assert_error(error, "open child readiness mapping");
        assert!(
            matches!(
                *child_slot.lock().expect("lock child slot"),
                ChildSlot::Closed
            ),
            "open_shared failure must transition the slot to Closed"
        );
    }

    #[cfg(feature = "outproc-effect")]
    pub(super) fn poisoned_slot_open_shared_failure_recovers_to_closed<R: OutProcRole + 'static>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let stats = R::new_stats();
        let (wrap, child_slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path,
                PathBuf::from("unused-child-executable"),
                stats.clone(),
            )),
            stats,
        );
        let poison_slot = child_slot.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_slot.lock().expect("lock slot for poison");
            panic!("intentional child slot poison");
        })
        .join();

        let error = match wrap.load_outproc_plugin_impl::<R>(
            child_slot.clone(),
            PathBuf::from(plugin_path),
            None,
            None,
        ) {
            Ok(_) => panic!("missing shm must take the Closed terminal transition after recovery"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            WrapError::OutProcEffect(_) | WrapError::OutProcInstrument(_)
        ));
        assert!(matches!(
            *child_slot.lock().unwrap_or_else(|p| p.into_inner()),
            ChildSlot::Closed
        ));
    }

    pub(super) fn spawn_failure_restores_empty_for_retry<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let bad_child_exe = unique_path();
        let _ = std::fs::remove_file(&bad_child_exe);
        let stats = R::new_stats();
        let launch = child_launch::<R>(shm_path, bad_child_exe, stats.clone());
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        for attempt in 1..=2 {
            let error = wrap
                .load_outproc_plugin_impl::<R>(
                    child_slot.clone(),
                    PathBuf::from(plugin_path),
                    None,
                    None,
                )
                .expect_err("nonexistent child executable must fail to spawn");
            assert_error(error, "spawn outproc child");
            assert!(
                matches!(
                    *child_slot.lock().expect("lock child slot"),
                    ChildSlot::Empty(_)
                ),
                "spawn failure attempt {attempt} must restore Empty so the same slot is retryable"
            );
        }
    }

    pub(super) fn closed_slot_is_rejected<R: OutProcRole>(
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
    ) {
        let (wrap, child_slot) = inject(ChildSlot::Closed, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(plugin_path),
                None,
                None,
            )
            .expect_err("Closed slot must reject attach");

        assert_error(error, "closed after an unrecoverable attach failure");
        assert!(matches!(
            *child_slot.lock().expect("lock child slot"),
            ChildSlot::Closed
        ));
    }

    pub(super) fn loading_slot_is_rejected<R: OutProcRole>(
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        loading_path: &str,
        second_path: &str,
    ) {
        let (wrap, child_slot) = inject(
            ChildSlot::Loading {
                path: PathBuf::from(loading_path),
            },
            R::new_stats(),
        );

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(second_path),
                None,
                None,
            )
            .expect_err("Loading slot must reject concurrent attach");

        assert_error(error, "already in progress");
        assert!(
            matches!(&*child_slot.lock().expect("lock child slot"), ChildSlot::Loading { path } if path == Path::new(loading_path))
        );
    }

    /// 実際に生存する（が無害な）child を起動して `ChildSlot::Active` を直接構築する。
    /// `EffectChildSupervisor`/`InstrumentChildSupervisor` は `spawn_effect_child` 経由の
    /// `Command` 起動を要求するので、実 CLAP/VST3 plugin なしで到達するには `R::spawn_supervisor`
    /// を直接呼び、`first_child` には（respawn を誘発しない）長寿命の `sleep` を渡す（outproc_effect.rs
    /// の `supervisor_*` テストと同じ手法）。supervisor が以後の shm unlink を所有するため、ローカルの
    /// `launch` の `cleanup_shm_on_drop` は production の `load_outproc_plugin` 成功パスと同様に外す。
    pub(super) fn active_child_slot<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        plugin_path: &str,
        plugin_id: Option<String>,
    ) -> ChildSlot<R> {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");

        let mut launch = child_launch::<R>(
            shm_path,
            PathBuf::from("unused-child-executable-for-respawn-only"),
            R::new_stats(),
        );
        let first_child = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn stub child for Active fixture");

        let path = PathBuf::from(plugin_path);
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            launch.shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(
            launch.shm_path.clone(),
        ));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let ui_index_binding =
            R::SUPPORTS_INDEXED_UI.then(|| Arc::new(Mutex::new(Default::default())));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let latest_state = Arc::new(Mutex::new(None));
        let supervisor = R::spawn_supervisor(
            first_child,
            &launch,
            path.clone(),
            plugin_id.clone(),
            latest_state.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump.clone(),
                target: ui_target.clone(),
                index_binding: ui_index_binding.clone(),
                events: ui_events,
            },
        )
        .expect("spawn supervisor for Active fixture");
        launch.cleanup_shm_on_drop = false;

        ChildSlot::Active {
            path,
            plugin_id,
            state: None,
            latest_state,
            engaged: Arc::new(AtomicBool::new(true)),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding,
            _supervisor: supervisor,
        }
    }

    /// Important finding 2a: `ChildSlot::Active` への同一 path・同一 plugin_id の再送は冪等に
    /// `Ok` を返し、slot を `Active` のまま維持すること。
    pub(super) fn active_slot_accepts_idempotent_reload<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
        plugin_id: Option<String>,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, plugin_id.clone());
        let (wrap, child_slot) = inject(slot, R::new_stats());

        wrap.load_outproc_plugin_impl::<R>(
            child_slot.clone(),
            PathBuf::from(plugin_path),
            plugin_id,
            None,
        )
        .expect("idempotent re-load of the same path+plugin_id while Active must succeed");
        assert!(
            matches!(
                &*child_slot.lock().expect("lock child slot"),
                ChildSlot::Active { .. }
            ),
            "idempotent re-load must keep the slot Active"
        );
    }

    /// Critical finding: `ChildSlot::Active` への同一 path・**異なる** plugin_id は replacement
    /// 要求として拒否すること（呼び出し側が指定した plugin_id を握り潰して古い plugin_id のまま
    /// 黙って `Ok` を返してはならない）。
    pub(super) fn active_slot_rejects_plugin_id_change<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
        initial_plugin_id: Option<String>,
        changed_plugin_id: Option<String>,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, initial_plugin_id.clone());
        let (wrap, child_slot) = inject(slot, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(plugin_path),
                changed_plugin_id,
                None,
            )
            .expect_err("same path with a different plugin_id while Active must be rejected");
        assert_error(error, "does not support replacement");
        assert!(
            matches!(
                &*child_slot.lock().expect("lock child slot"),
                ChildSlot::Active { plugin_id, .. } if *plugin_id == initial_plugin_id
            ),
            "rejected plugin_id change must not disturb the previously-active plugin_id"
        );
    }

    /// Important finding 2b: `ChildSlot::Active` への **異なる** path は v1 では replacement
    /// 拒否のまま（既存の Loading 側テストと対になる Active 側の直接検証）。
    pub(super) fn active_slot_rejects_path_replacement<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        plugin_path: &str,
        other_path: &str,
    ) {
        let slot = active_child_slot::<R>(unique_path, plugin_path, None);
        let (wrap, child_slot) = inject(slot, R::new_stats());

        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(other_path),
                None,
                None,
            )
            .expect_err("a different path while Active must be rejected");
        assert_error(error, "does not support replacement");
        assert!(matches!(
            &*child_slot.lock().expect("lock child slot"),
            ChildSlot::Active { path, .. } if path == Path::new(plugin_path)
        ));
    }

    /// テスト専用 child はコミット済み fixture を参照する。ETXTBSY の必要条件は、exec 時点で
    /// 対象 inode を誰かが write-open していること。fixture はテストプロセスの生存中に一度も
    /// write-open しないため、別スレッドの spawn へ継承される write fd 自体が発生しない。
    fn child_script_fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    /// CLI 引数（`--shm`/`--plugin`/`--sample-rate` 等）をすべて無視して、**親が生きている
    /// 限り生き続ける** POSIX shell script。素の coreutils は未知オプションで即 exit するため
    /// fixture を使う。
    ///
    /// 契約は「生き続ける」であって「N 秒待つ」ではない（#622）。
    /// [`slow_child_fixture_has_no_fixed_lifetime`] がその形を固定している。
    fn slow_child_script() -> PathBuf {
        child_script_fixture("slow-child.sh")
    }

    fn exit_child_script() -> PathBuf {
        child_script_fixture("exit-child.sh")
    }

    /// 🔴 #622: child stub の fixture に**固定寿命を持たせてはいけない**。
    ///
    /// stub が生き残らねばならない経路は [`SETUP_DEADLINE`] と [`CHILD_READY_TIMEOUT`] に
    /// ゲートされている。fixture に書いた固定秒数はその deadline と**独立に**存在するので、
    /// deadline が伸びた時に黙って下回る。しかも**速いマシンでは表面化しない**（テスト全体が
    /// ミリ秒で終わるため）。`slow-child.sh` の `exec sleep 20` がまさにそれで、CI が詰まった
    /// 時だけ `child exited before publishing READY` で落ちていた。逆に秒数を伸ばすと、
    /// テスト異常終了時に孤児がその時間だけ残る（`record-respawn-args.sh` は `sleep 3600` で
    /// 最大 1 時間残る形だった）。
    ///
    /// 🔴 **ディレクトリ全体を走査する。** 最初この検査は `slow-child.sh` 1 本しか見ておらず、
    /// **同じ罠が残っていた `record-respawn-args.sh` を見落とした**。「他に無い」は列挙を
    /// 尽くして初めて言えるので、対象を1本に固定しない。
    ///
    /// 実時間側の検査は [`slow_child_fixture_outlives_the_deadlines_it_must_survive`]
    /// （`#[ignore]`）。
    #[test]
    fn no_child_fixture_ends_after_a_fixed_wait() {
        use crate::engine_wrap::CHILD_READY_TIMEOUT;

        /// 固定秒数が**目的そのもの**の fixture。ここに載せるには「その秒数が守る Rust 定数と
        /// 外れた時、テストが**大きな声で落ちる**」ことが条件。
        ///
        /// `variable-lifetime-child.sh` は `FAST_RESPAWN_THRESHOLD`(2s) を超えて生きることで
        /// 「生存者」と判定される必要があり、`sleep 2.2` はその意味を担う。負荷は寿命を
        /// **縮めない**（`sleep` は遅延しても短くならない・`last_respawn_ns` は spawn 直後に
        /// 打たれるので計測寿命は伸びる方向にしか動かない）ので、#622 の「黙って下回る」形には
        /// ならない。
        ///
        /// **実測（#629 レビューの指摘を受けて）**: 閾値を 2s → 3s へ動かすと
        /// `supervisor_resets_fast_fail_streak_after_a_survivor` が
        /// 「7 回 respawn するはず」の assert で落ちる。定数が 2.2 を超えたら**大きな声で
        /// 落ちる**というこの例外の前提は、主張ではなく確認済みの事実である。
        const FIXED_WAIT_IS_THE_POINT: &[&str] = &["variable-lifetime-child.sh"];

        let dir = slow_child_script()
            .parent()
            .expect("fixtures dir")
            .to_path_buf();
        // 🔴 **再帰する。** `read_dir` は非再帰なので、共有スニペットを置いた `lib/` が
        // 丸ごと盲点になっていた（#629 レビューで pr-test-analyzer と code-reviewer が独立に
        // 指摘）。「ディレクトリ全体を走査する」と書いておきながらサブディレクトリを見て
        // いなかったのは、**この検査自身が繰り返した列挙漏れ**である。
        let mut pending = vec![dir];
        let mut scanned = 0usize;
        while let Some(current) = pending.pop() {
            for entry in std::fs::read_dir(&current).expect("read fixtures dir") {
                let path = entry.expect("fixture dir entry").path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().and_then(|ext| ext.to_str()) != Some("sh") {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .expect("fixture file name")
                    .to_string();
                if FIXED_WAIT_IS_THE_POINT.contains(&name.as_str()) {
                    continue;
                }
                scanned += 1;
                let script = std::fs::read_to_string(&path).expect("read fixture");
                let code: Vec<&str> = script
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .collect();
                // 見るのは**最後の文**だけ。ループ内の `sleep 1`（ポーリング間隔）は寿命ではない。
                //
                // ⚠️ 判定しているのは「最後の**実行文**」ではなく「コメント/空行を除いた最終行」。
                // `lib/live-until-parent-exits.sh` は関数定義のみで最終行が `}` なので安全側に
                // 倒れるが、それは**現在の書き方に依存した性質**である（#629 fix 再点検 Minor）。
                // ライブラリ側の末尾に実行文を足す時はこの判定も見直すこと。
                let last_statement = code.last().copied().unwrap_or_default();
                let ends_after_a_fixed_wait = last_statement
                    .strip_prefix("exec ")
                    .unwrap_or(last_statement)
                    .strip_prefix("sleep ")
                    .is_some_and(|arg| arg.trim().parse::<f64>().is_ok());
                assert!(
                    !ends_after_a_fixed_wait,
                    "{name} must not end after a fixed duration: a child stub has to outlive \
                     SETUP_DEADLINE ({SETUP_DEADLINE:?}) and CHILD_READY_TIMEOUT \
                     ({CHILD_READY_TIMEOUT:?}), and any fixed number eventually falls below them \
                     without anyone noticing (#622). Source lib/live-until-parent-exits.sh instead. \
                     Script was:\n{script}"
                );
            }
        }
        // 期待件数を明示する。`>= 2` では、走査対象が 1 本静かに外れても気づけない
        // （#629 レビュー Minor）。件数が変わったらこのテストごと見直させる。
        const EXPECTED_SCANNED: usize = 4;
        assert_eq!(
            scanned, EXPECTED_SCANNED,
            "the fixture scan covered {scanned} script(s), expected {EXPECTED_SCANNED} — the \
             enumeration is what makes this test meaningful (#622 was missed by checking a \
             single file, and the lib/ subdirectory was missed by not recursing), so a scan \
             whose coverage changed is itself the failure"
        );
    }

    /// #622 の不変条件そのものを実時間で検査する。deadline の合計を超えて待つので
    /// `#[ignore]`（`cargo test -- --ignored` で明示的に回す）。
    #[test]
    #[ignore = "waits longer than SETUP_DEADLINE + CHILD_READY_TIMEOUT by design"]
    fn slow_child_fixture_outlives_the_deadlines_it_must_survive() {
        use crate::engine_wrap::CHILD_READY_TIMEOUT;
        let must_survive = SETUP_DEADLINE + CHILD_READY_TIMEOUT;
        let mut child = std::process::Command::new(slow_child_script())
            .arg("--shm")
            .arg("/ignored")
            .spawn()
            .expect("spawn slow-child fixture");
        std::thread::sleep(must_survive + Duration::from_secs(5));
        let still_running = matches!(child.try_wait(), Ok(None));
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            still_running,
            "slow-child.sh died within {must_survive:?}; the ready poll it must survive is \
             gated by exactly that budget (#622)"
        );
    }

    pub(super) fn early_exit_fast_fails_and_keeps_retry_shm<R: OutProcRole>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = exit_child_script();
        let stats = R::new_stats();
        let (wrap, slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path.clone(),
                child_exe.clone(),
                stats,
            )),
            R::new_stats(),
        );
        let started = std::time::Instant::now();
        let error = match wrap.load_outproc_plugin_impl::<R>(
            slot.clone(),
            PathBuf::from(plugin_path),
            None,
            None,
        ) {
            Ok(_) => panic!("immediately exiting child must fail attach"),
            Err(error) => error,
        };
        // 🔴 「exited」だけでは足りない（#622）。SIGKILL（資源圧で殺された）と child 自身の
        // エラー終了を区別できず、失敗を受け取った側が次に何を見ればよいか分からない。
        // fixture は `exit 1` なので、終了理由が載っていれば `exit status: 1` が現れる。
        let WrapError::OutProcAttachFailed(ref message) = error else {
            panic!("early exit must surface as OutProcAttachFailed, got {error:?}");
        };
        assert!(
            message.contains("exited before publishing READY"),
            "unexpected attach failure message: {message}"
        );
        assert!(
            message.contains("exit status: 1"),
            "the attach failure must carry the child's exit status, not just the fact that it \
             exited (#622); message was: {message}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "early exit waited too long"
        );
        assert!(matches!(*slot.lock().unwrap(), ChildSlot::Empty(_)));
        assert!(shm_path.exists(), "retry shm must remain linked");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        assert_eq!(
            unsafe { (*region).control.load(std::sync::atomic::Ordering::Acquire) },
            orbit_audio_sandbox::CONTROL_RUN
        );
    }

    pub(super) fn role_mismatch_retries_same_slot<R: OutProcRole + 'static>(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        plugin_path: &str,
        wrong_has_audio_input: bool,
        correct_has_audio_input: bool,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = slow_child_script();
        let stats = R::new_stats();
        let (wrap, slot) = inject(
            ChildSlot::Empty(child_launch::<R>(
                shm_path.clone(),
                child_exe.clone(),
                stats.clone(),
            )),
            stats.clone(),
        );
        for (attempt, has_input) in [(1, wrong_has_audio_input), (2, correct_has_audio_input)] {
            R::current_child_pid_atomic(&stats).store(0, std::sync::atomic::Ordering::Relaxed);
            let wrap_call = wrap.clone();
            let slot_call = slot.clone();
            let path = PathBuf::from(plugin_path);
            let call = std::thread::spawn(move || {
                wrap_call.load_outproc_plugin_impl::<R>(slot_call, path, None, None)
            });
            let started = std::time::Instant::now();
            let deadline = started + SETUP_DEADLINE;
            let mut polls: u64 = 0;
            // PID は reset_child_starting の後に publish されるため、この READY はそれによって消されない。
            let call = loop {
                polls += 1;
                if R::current_child_pid_atomic(&stats).load(std::sync::atomic::Ordering::Relaxed)
                    != 0
                {
                    break call;
                }
                if call.is_finished() {
                    // 🔴 pid を**読み直す**。前回の load と is_finished の間に worker が
                    // pid を publish して終了した場合、「publish 前に終わった」は虚偽になる。
                    if R::current_child_pid_atomic(&stats)
                        .load(std::sync::atomic::Ordering::Relaxed)
                        != 0
                    {
                        break call;
                    }
                    // 🔴 join して**実エラーを message に載せる**。ここで join せずに落ちると、
                    // #529 の原因そのもの（エラー握り潰し → 原因を語らない panic）を再演する。
                    let result = call.join().expect("load thread panicked");
                    panic!(
                        "attempt {attempt}: load call finished without ever publishing a child \
                         PID (after {polls} polls / {:?}); its result was {result:?}",
                        started.elapsed()
                    );
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "attempt {attempt}: child spawn never completed (after {polls} polls / {:?})",
                    started.elapsed()
                );
                std::thread::sleep(Duration::from_millis(5));
            };
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, has_input) };
            let result = call.join().expect("load thread panicked");
            if attempt == 1 {
                assert!(
                    matches!(result, Err(WrapError::OutProcAttachFailed(ref msg)) if msg.contains("role does not match"))
                );
                assert!(matches!(*slot.lock().unwrap(), ChildSlot::Empty(_)));
                assert!(shm_path.exists());
                assert_eq!(
                    unsafe { (*region).control.load(std::sync::atomic::Ordering::Acquire) },
                    orbit_audio_sandbox::CONTROL_RUN
                );
            } else {
                result.expect("second attach must reuse Empty slot and succeed");
                assert!(matches!(*slot.lock().unwrap(), ChildSlot::Active { .. }));
            }
        }
    }

    /// Important finding 1: f36e99c の regression guard。`Loading` 中の 2 本目の `LoadPlugin` は、
    /// 1 本目が shm-open/spawn/ready-ack poll（lock 外・最大 `CHILD_READY_TIMEOUT`）で実際に
    /// ブロックしている **最中**でも、mutex 待ちでなく `ChildSlot::Loading` を即座に観測して
    /// fail-fast すること。この lock-scope fix が無いと 2 本目は `.lock()` 自体で最大 10 秒
    /// ブロックされ、意図された「Loading 中は即座に in progress で reject」が到達不能になる。
    pub(super) fn concurrent_load_call_observes_loading_without_blocking<
        R: OutProcRole + 'static,
    >(
        unique_path: impl Fn() -> PathBuf,
        inject: impl Fn(ChildSlot<R>, Arc<R::Stats>) -> InjectedSlot<R>,
        assert_error: impl Fn(WrapError, &str),
        has_audio_input: bool,
        loading_path: &str,
        second_path: &str,
    ) {
        let shm_path = unique_path();
        let _ = std::fs::remove_file(&shm_path);
        let _mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create shared memory");
        let child_exe = slow_child_script();

        let stats = R::new_stats();
        let launch = child_launch::<R>(shm_path.clone(), child_exe.clone(), stats.clone());
        let (wrap, child_slot) = inject(ChildSlot::Empty(launch), stats);

        let wrap_a = wrap.clone();
        let slot_a = child_slot.clone();
        let loading_path_owned = PathBuf::from(loading_path);
        let first_call = std::thread::spawn(move || {
            wrap_a.load_outproc_plugin_impl::<R>(slot_a, loading_path_owned, None, None)
        });

        // 1本目が Empty -> Loading へ遷移して lock を解放するまで待つ。
        //
        // 🔴 #529: **壁時計だけに頼らない**。`Loading` は child spawn の**前**に設定されるので
        // （`*slot = ChildSlot::Loading` → `drop(slot)` → spawn の順）、「CI が遅くて spawn が
        // 間に合わない」ではここに到達しない。到達しない実際の経路は
        // **worker が `Loading` を設定せずに早期 return すること**（`select_child_exe` の失敗など）で、
        // その場合このループは deadline まで回り切ってから「never reached Loading」という
        // **原因を何も語らないメッセージ**で落ちる。
        //
        // そこで待ちの条件を「`Loading` を観測 **or** worker が終了」にする。worker が先に
        // 終わったならそれが答えなので、join してエラーを message に載せて即座に落とす。
        // deadline は「どちらも起きない」異常系の最後の安全弁としてのみ残す。
        let started = std::time::Instant::now();
        let deadline = started + SETUP_DEADLINE;
        let mut polls: u64 = 0;
        let first_call = loop {
            polls += 1;
            if matches!(
                &*child_slot.lock().expect("poll child slot"),
                ChildSlot::Loading { .. }
            ) {
                break first_call;
            }
            if first_call.is_finished() {
                // 🔴 主張できるのは「**ポーラが Loading を観測する前に** worker が終了した」
                // ことだけ。「Loading を一度も設定しなかった」と断言してはいけない —
                // ポーラの反復が遅延すると、その間に worker が Loading 設定 → spawn →
                // ready timeout → Empty まで進んで終了しうる（設定はされていた）。
                // 離脱経路の同定は join した Err の文言に委ねる。
                let observed = slot_kind(&child_slot);
                let result = first_call.join().expect("load thread panicked");
                panic!(
                    "first LoadPlugin call finished before the poller ever observed \
                     ChildSlot::Loading (slot is now {observed}, after {polls} polls / \
                     {:?}); its result was {result:?}",
                    started.elapsed()
                );
            }
            assert!(
                std::time::Instant::now() < deadline,
                "first LoadPlugin call neither reached ChildSlot::Loading nor finished \
                 (slot is {}, after {polls} polls / {:?} — **反復回数が判別材料**: \
                 数千回なら本当にスケジューリング問題、数回〜数百回ならランナー停止)",
                slot_kind(&child_slot),
                started.elapsed()
            );
            std::thread::sleep(Duration::from_millis(5));
        };

        // 1本目はまだ ready-ack poll 中（child script は READY を publish しない）。この状態で 2本目を
        // 発行し、mutex 待ちでなく即座に "already in progress" で失敗することを検証する。
        let start = std::time::Instant::now();
        let error = wrap
            .load_outproc_plugin_impl::<R>(
                child_slot.clone(),
                PathBuf::from(second_path),
                None,
                None,
            )
            .expect_err("concurrent call against a Loading slot must fail");
        let elapsed = start.elapsed();

        assert_error(error, "already in progress");
        assert!(
            elapsed < Duration::from_secs(1),
            "second LoadPlugin call took {elapsed:?} while the first was still parked in its \
             lock-free readiness poll -- it must fail fast on ChildSlot::Loading, not block on \
             the mutex for up to CHILD_READY_TIMEOUT (regression guard for f36e99c)"
        );

        // 後片付け: READY を publish して 1本目を Active まで完走させ、決定的に join する
        // （detach したまま放置すると child プロセス / watchdog スレッドがテストを跨いで残る）。
        let ready_mmap =
            orbit_audio_sandbox::open_shared(&shm_path).expect("open shm to publish READY");
        let region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        // SAFETY: region は直前に開いた ready_mmap を指し、この scope の間生存する。
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, has_audio_input) };
        first_call
            .join()
            .expect("first LoadPlugin call thread panicked")
            .expect("first LoadPlugin call must succeed once READY is published");
    }
}

/// `outproc_health()` の real body（`#[cfg(feature = "outproc-effect")]`）を直接叩く unit test。
///
/// `tests/protocol.rs` の統合テストは default feature build（`outproc-effect` 無効）で走るため、
/// stub（`(0, 0, false, injected)`）しか exercise できず、この real body の match arm は
/// どのテストからも一度も compile even されていなかった（#406 pr-test-analyzer 指摘）。
/// ここは同一 crate 内の `#[cfg(test)]` submodule なので `EngineWrap::outproc`（private field）
/// と `OutProcControl`（private struct）へ直接アクセスできる（親モジュールの private item は子
/// module から可視）。`OutProcEffectStats::new()` / `CallbackTimeStats::new()` はどちらも
/// child process 不要の cheap constructor（plain atomic のみ）なので、`StubBackend` で起動した
/// `EngineWrap` に対して real child を spawn せず `Some(OutProcControl)` を注入できる。
#[cfg(all(test, feature = "outproc-effect"))]
mod outproc_health_tests {
    use super::{
        ChildLaunch, ChildSlot, EffectRole, EngineWrap, OutProcControl, OutProcRole,
        PluginStateTarget, WrapError,
    };
    use crate::backend::StubBackend;
    use crate::outproc_effect::OutProcEffectStats;
    use orbit_audio_native::CallbackTimeStats;
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex, Weak};

    /// `StubBackend` で `EngineWrap` を起動し、real child なしで組み立てた `OutProcControl` を
    /// `self.outproc` に注入する。返す `Arc<OutProcEffectStats>` はテスト側から直接
    /// `store`/`load` して `Ok(Some(c))` real-value summing 経路を駆動するのに使う。
    fn wrap_with_outproc_stats() -> (Arc<EngineWrap>, Arc<OutProcEffectStats>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let stats = OutProcEffectStats::new();
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: stats.clone(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            master_entry: super::test_effect_slot_entry(),
            bus_slots: HashMap::new(),
            bus_entries: HashMap::new(),
            bus_stats: HashMap::new(),
            bus_actives: HashMap::new(),
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        (wrap, stats)
    }

    fn wrap_with_child_slot(
        slot: ChildSlot<EffectRole>,
        stats: Arc<OutProcEffectStats>,
    ) -> (Arc<EngineWrap>, Arc<Mutex<ChildSlot<EffectRole>>>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let child_slot = Arc::new(Mutex::new(slot));
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats,
            cb_stats: CallbackTimeStats::new(),
            child_slot: Arc::downgrade(&child_slot),
            master_entry: super::test_effect_slot_entry(),
            bus_slots: HashMap::new(),
            bus_entries: HashMap::new(),
            bus_stats: HashMap::new(),
            bus_actives: HashMap::new(),
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        (wrap, child_slot)
    }

    /// #552 配線ピン: effect の `select_child_exe` が**実際に読み替えを行う**ことを検証する。
    ///
    /// `outproc_effect::child_exe_for_attach` の純関数ユニットテストだけでは足りない —
    /// trait 実装が no-op（修正前の状態）に戻っても、純関数のテストは green のままだった
    /// （変異検証で実証）。**純関数と load 経路を繋ぐ配線そのもの**をここで押さえる。
    #[test]
    fn effect_select_child_exe_swaps_default_child_by_extension() {
        let stats = EffectRole::new_stats();
        let mut launch = ChildLaunch::<EffectRole> {
            shm_path: PathBuf::from("/tmp/unused-effect-select-child-exe.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/orbit-clap-effect-child"),
            sample_rate: 48_000,
            stats: stats.clone(),
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };

        EffectRole::select_child_exe(&mut launch, Path::new("Tape Echo.vst3"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-vst3-effect-child"),
            "VST3 エフェクトを attach したら VST3 child に読み替わらねばならない（#552）"
        );

        // 対称: 次に .clap を attach すると CLAP child へ戻る（混在チェーンの前提）。
        EffectRole::select_child_exe(&mut launch, Path::new("Surge.clap"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-clap-effect-child"),
            "CLAP エフェクトを attach したら CLAP child へ戻らねばならない（#552）"
        );

        // 明示指定（デフォルト名以外）は touch しない = ORBIT_EFFECT_CHILD_BIN / gated 直指定の保護。
        let mut explicit_launch = ChildLaunch::<EffectRole> {
            shm_path: PathBuf::from("/tmp/unused-effect-select-child-exe-explicit.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/custom-effect-child"),
            sample_rate: 48_000,
            stats,
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };
        EffectRole::select_child_exe(&mut explicit_launch, Path::new("Tape Echo.vst3"))
            .expect("select_child_exe must not error on explicit child name");
        assert_eq!(
            explicit_launch.child_exe,
            PathBuf::from("/opt/orbitscore/custom-effect-child"),
            "明示指定された child exe は読み替えてはならない"
        );
    }

    #[test]
    fn load_outproc_effect_plugin_rejects_unknown_bus() {
        let (wrap, _child_slot) =
            wrap_with_child_slot(ChildSlot::Closed, OutProcEffectStats::new());
        let error = wrap
            .load_outproc_effect_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("nope".into()),
            )
            .expect_err("unknown bus must be rejected before touching the master slot");
        assert_effect_runtime_error_contains(error, "unknown effect bus 'nope'");
    }

    #[test]
    fn load_outproc_effect_plugin_routes_known_bus_to_its_own_slot_not_master() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        // master `child_slot` is dropped (Weak::new()), so if the bus lookup fell through to it
        // this call would fail with "stream is closed" instead of reaching the bus-specific slot.
        let bus_slot = Arc::new(Mutex::new(ChildSlot::<EffectRole>::Closed));
        let mut bus_slots = HashMap::new();
        bus_slots.insert("fx1".to_owned(), Arc::downgrade(&bus_slot));
        let mut bus_entries = HashMap::new();
        bus_entries.insert("fx1".to_owned(), super::test_effect_slot_entry());
        let mut bus_stats = HashMap::new();
        bus_stats.insert("fx1".to_owned(), OutProcEffectStats::new());
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: OutProcEffectStats::new(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            master_entry: super::test_effect_slot_entry(),
            bus_slots,
            bus_entries,
            bus_stats,
            bus_actives: HashMap::new(),
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        let error = wrap
            .load_outproc_effect_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("fx1".into()),
            )
            .expect_err("closed bus slot still rejects the load, but past the routing step");
        assert_effect_runtime_error_contains(error, "closed after an unrecoverable attach failure");
    }

    #[test]
    fn load_outproc_effect_plugin_keeps_bus_activation_monotone_on_failure() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let bus_slot = Arc::new(Mutex::new(ChildSlot::<EffectRole>::Closed));
        let active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut bus_slots = HashMap::new();
        bus_slots.insert("fx1".to_owned(), Arc::downgrade(&bus_slot));
        let mut bus_actives = HashMap::new();
        bus_actives.insert("fx1".to_owned(), active.clone());
        let mut bus_entries = HashMap::new();
        bus_entries.insert("fx1".to_owned(), super::test_effect_slot_entry());
        let mut bus_stats = HashMap::new();
        bus_stats.insert("fx1".to_owned(), OutProcEffectStats::new());
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: OutProcEffectStats::new(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            master_entry: super::test_effect_slot_entry(),
            bus_slots,
            bus_entries,
            bus_stats,
            bus_actives,
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        let result = wrap.load_outproc_effect_plugin(
            std::path::PathBuf::from("unused.clap"),
            None,
            Some("fx1".into()),
        );
        assert!(result.is_err());
        assert!(
            active.load(std::sync::atomic::Ordering::Acquire),
            "bus activation is monotone once a receiver is declared (#625)"
        );
    }

    #[test]
    fn plugin_state_save_atomically_replaces_file_and_updates_latest_state_value() {
        let shm_path = crate::outproc_effect::unique_shm_path();
        let active = super::outproc_load_error_test_support::active_child_slot::<EffectRole>(
            || shm_path.clone(),
            "stateful-effect.clap",
            None,
        );
        let (wrap, _child_slot) = wrap_with_child_slot(active, OutProcEffectStats::new());
        let chain = wrap
            .outproc
            .lock()
            .expect("lock effect control")
            .as_ref()
            .expect("effect control")
            .master_entry
            .chain
            .clone();
        *chain.lock().expect("lock authoritative chain") =
            vec![crate::outproc_effect::ChainStageConfig::Catalog {
                path: PathBuf::from("stateful-effect.clap"),
                plugin_id: None,
                latest_state: None,
                enabled: true,
            }];

        let ready_mmap = orbit_audio_sandbox::open_shared(&shm_path).expect("open ready mapping");
        let ready_region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        // SAFETY: mapping remains alive and the stub supervisor child does not access this mapping.
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(ready_region, true) };

        let state_directory = std::env::temp_dir().join(format!(
            "orbit-daemon-plugin-state-{}-{}",
            std::process::id(),
            super::short_uuid()
        ));
        std::fs::create_dir(&state_directory).expect("create state directory");
        let final_path = state_directory.join("effect.state");
        std::fs::write(&final_path, b"old state").expect("seed old final state");
        let expected_state = b"new oracle state".to_vec();

        let spawn_responder = |responder_state: Vec<u8>| {
            let responder_shm = shm_path.clone();
            std::thread::spawn(move || {
                let mmap = orbit_audio_sandbox::open_shared(&responder_shm).expect("child map");
                let region = orbit_audio_sandbox::region_ptr(&mmap);
                let previous_ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                let seq = loop {
                    // SAFETY: region points into the live mapping; Acquire pairs with host publish.
                    let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
                    if seq > previous_ack {
                        break seq;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "host did not publish SAVE_STATE"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(1));
                };
                let arg = unsafe {
                    orbit_audio_sandbox::transport::read_cstr_field(&(*region).cmd_arg)
                        .expect("valid rack state JSON")
                        .to_owned()
                };
                assert_eq!(
                    unsafe { (*region).cmd_kind.load(Ordering::Relaxed) },
                    orbit_audio_sandbox::transport::CMD_SAVE_STATE_AT
                );
                let arg: serde_json::Value =
                    serde_json::from_str(&arg).expect("parse rack state JSON");
                assert_eq!(arg["index"], 0);
                let sidecar = arg["path"].as_str().expect("state sidecar path");
                let mut file = std::fs::File::create(sidecar).expect("create sidecar");
                std::io::Write::write_all(&mut file, &responder_state).expect("write sidecar");
                file.sync_all().expect("sync sidecar");
                unsafe {
                    (*region)
                        .cmd_result_len
                        .store(responder_state.len() as u64, Ordering::Relaxed);
                    (*region)
                        .cmd_result
                        .store(orbit_audio_sandbox::CMD_RESULT_OK, Ordering::Relaxed);
                    (*region).cmd_ack_seq.store(seq, Ordering::Release);
                }
            })
        };
        let responder = spawn_responder(expected_state.clone());

        let saved = wrap
            .save_outproc_plugin_state(
                PluginStateTarget::Effect { bus: None },
                0,
                final_path.clone(),
            )
            .expect("save state");
        responder.join().expect("responder join");
        assert_eq!(saved.path, final_path);
        assert_eq!(saved.bytes_written, expected_state.len() as u64);
        assert_eq!(
            std::fs::read(&final_path).expect("read final state"),
            expected_state
        );
        assert_eq!(
            *chain.lock().expect("authoritative chain lock"),
            vec![crate::outproc_effect::ChainStageConfig::Catalog {
                path: PathBuf::from("stateful-effect.clap"),
                plugin_id: None,
                latest_state: Some(final_path.clone()),
                enabled: true,
            }],
            "the per-stage latest_state in ChainConfig must advance after save"
        );
        assert_eq!(
            std::fs::read_dir(&state_directory)
                .expect("read state directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
                .count(),
            0,
            "successful save must leave no sidecar"
        );

        // UI close safepoint (b) is allowed while audio is performing. The stub backend never
        // renders this long sample, so it remains active throughout the second SAVE_STATE.
        wrap.engine
            .schedule(
                0.0,
                orbit_audio_core::Sample::new(vec![0.0; 48_000 * 2], 48_000, 2),
            )
            .expect("schedule performing sample");
        assert!(wrap.engine.active_count_strict().expect("active count") > 0);
        let performing_path = state_directory.join("performing.state");
        let performing_state = b"state captured during playback".to_vec();
        let performing_responder = spawn_responder(performing_state.clone());
        let performing_saved = wrap
            .save_outproc_plugin_state(
                PluginStateTarget::Effect { bus: None },
                0,
                performing_path.clone(),
            )
            .expect("state save must succeed while performing");
        performing_responder
            .join()
            .expect("performing responder join");
        assert_eq!(performing_saved.path, performing_path);
        assert_eq!(
            std::fs::read(&performing_path).expect("read performing state"),
            performing_state
        );

        std::fs::remove_dir_all(&state_directory).expect("remove state directory");
    }

    fn assert_effect_runtime_error_contains(error: WrapError, expected: &str) {
        assert!(
            matches!(&error,
                WrapError::OutProcEffect(message) | WrapError::OutProcSlotClosed(message)
                if message.contains(expected)),
            "expected OutProcEffect error containing {expected:?}, got {error:?}"
        );
    }

    #[test]
    fn effect_load_outproc_open_shared_failure_closes_slot() {
        super::outproc_load_error_test_support::open_shared_failure_closes_slot(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_poisoned_slot_recovers_to_closed_on_open_shared_failure() {
        super::outproc_load_error_test_support::poisoned_slot_open_shared_failure_recovers_to_closed(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "poisoned-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_spawn_failure_restores_empty_for_retry() {
        super::outproc_load_error_test_support::spawn_failure_restores_empty_for_retry(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_early_exit_fast_fails_and_keeps_retry_shm() {
        super::outproc_load_error_test_support::early_exit_fast_fails_and_keeps_retry_shm(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "exit-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_role_mismatch_retries_same_slot() {
        super::outproc_load_error_test_support::role_mismatch_retries_same_slot(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "retry-effect.clap",
            false,
            true,
        );
    }

    #[test]
    fn effect_load_outproc_rejects_closed_slot() {
        super::outproc_load_error_test_support::closed_slot_is_rejected(
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "unused-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_rejects_loading_slot() {
        super::outproc_load_error_test_support::loading_slot_is_rejected(
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "already-loading-effect.clap",
            "second-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_concurrent_call_fails_fast_on_loading() {
        super::outproc_load_error_test_support::concurrent_load_call_observes_loading_without_blocking(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            true, // effect role: CHILD_FLAG_HAS_AUDIO_INPUT set
            "loading-effect.clap",
            "second-effect.clap",
        );
    }

    #[test]
    fn effect_load_outproc_active_accepts_idempotent_reload() {
        super::outproc_load_error_test_support::active_slot_accepts_idempotent_reload(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            "active-effect.clap",
            Some("sub-a".to_string()),
        );
    }

    #[test]
    fn effect_load_outproc_active_rejects_plugin_id_change() {
        super::outproc_load_error_test_support::active_slot_rejects_plugin_id_change(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "active-effect.clap",
            Some("sub-a".to_string()),
            Some("sub-b".to_string()),
        );
    }

    #[test]
    fn effect_load_outproc_active_rejects_path_replacement() {
        super::outproc_load_error_test_support::active_slot_rejects_path_replacement(
            crate::outproc_effect::unique_shm_path,
            wrap_with_child_slot,
            assert_effect_runtime_error_contains,
            "active-effect.clap",
            "other-effect.clap",
        );
    }

    #[test]
    fn effect_ready_ack_requires_audio_input_flag() {
        assert!(EffectRole::role_matches(
            orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT
        ));
        assert!(!EffectRole::role_matches(0));
    }

    #[test]
    fn ok_none_reports_only_injected_frames_clamped() {
        // outproc 未注入（build() 直後の初期値）= Ok(None) 分岐。
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        wrap.outproc_frames_clamped_arc()
            .fetch_add(7, Ordering::Relaxed);
        assert_eq!(wrap.outproc_health(), (0, 0, false, 7));
    }

    #[test]
    fn ok_some_sums_real_stats_with_injected_counter() {
        // Ok(Some(c)) 分岐: 実 OutProcEffectStats スナップショットと injected カウンタを両方
        // 合算して返すこと（finding 3: 実 stats の summing が一度も exercise されていなかった）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.child_process_error_count.store(3, Ordering::Relaxed);
        stats.respawn_count.store(2, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats.frames_clamped.store(5, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(9, Ordering::Relaxed);

        assert_eq!(wrap.outproc_health(), (3, 2, true, 14));
    }

    #[test]
    fn would_block_ignores_real_stats_and_reports_only_injected() {
        // WouldBlock 分岐: 別スレッドが outproc mutex を保持している間は real stats を読まず
        // injected カウンタのみ返すこと（cumulative なので次 tick で real 分も取り戻せる設計）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.frames_clamped.store(100, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(1, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let (holding_tx, holding_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc
                .lock()
                .expect("lock outproc for contention setup");
            holding_tx.send(()).expect("signal lock held");
            release_rx.recv().expect("wait for release signal");
        });
        holding_rx.recv().expect("holder thread signaled lock held");

        assert_eq!(wrap.outproc_health(), (0, 0, false, 1));

        release_tx.send(()).expect("signal release");
        holder.join().expect("holder thread should not panic");
    }

    #[test]
    fn poisoned_still_reports_injected_frames_clamped_not_lost() {
        // Poisoned 分岐: real stats は 0 に丸めるが、injected の frames_clamped は黙って
        // 失わず返すこと（finding 2: silent-failure-hunter が指摘した「値が消えないこと」の
        // 直接検証。手法は PR #403 の genuine-poison パターン（別スレッドで panic → join）を流用）。
        let (wrap, stats) = wrap_with_outproc_stats();
        stats.frames_clamped.store(42, Ordering::Relaxed);
        wrap.outproc_frames_clamped_arc()
            .fetch_add(3, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc
                .lock()
                .expect("lock outproc for poison setup");
            panic!("intentional poison for outproc_health poisoned test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        assert_eq!(wrap.outproc_health(), (0, 0, false, 3));
    }
}

/// `outproc_instrument_health()` の real body（`#[cfg(feature = "outproc-instrument")]`）を直接叩く
/// unit test。`outproc_health_tests` と同じ理由（`tests/protocol.rs` の統合テストは default feature
/// build で走るため real body の match arm がどのテストからも一度も compile even されない）で、この
/// `#[cfg(test)]` submodule から `EngineWrap::outproc_instrument`（private field）と
/// `OutProcInstrumentControl`（private struct）へ直接アクセスして注入する。
#[cfg(all(test, feature = "outproc-instrument"))]
mod outproc_instrument_health_tests {
    use super::{ChildLaunch, ChildSlot, EngineWrap, InstrumentRole, OutProcRole, WrapError};
    use crate::backend::StubBackend;
    use crate::outproc_instrument::OutProcInstrumentStats;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, Weak};

    /// `StubBackend` で `EngineWrap` を起動し、real child なしで組み立てた `OutProcInstrumentControl`
    /// を `self.outproc_instrument` に注入する。event_tx の consumer 側は即 drop するが、この
    /// テストは health accessor だけを exercise するので note の push は行わない。
    fn wrap_with_instrument_stats() -> (Arc<EngineWrap>, Arc<OutProcInstrumentStats>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let stats = OutProcInstrumentStats::new();
        let (event_tx, _event_rx) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control for injection") =
            Some(super::test_instrument_control(
                vec![super::InstrumentSlotEntry {
                    event_tx,
                    stats: stats.clone(),
                    shm_path: PathBuf::from("/tmp/unused-instrument-health.shm"),
                    child_exe: PathBuf::from("unused-instrument-child"),
                    sample_rate: 48_000,
                    engaged: Arc::new(AtomicBool::new(false)),
                    drain_requested: Arc::new(AtomicBool::new(false)),
                    drain_done: Arc::new(AtomicBool::new(false)),
                    source_dests: super::default_source_dests(),
                    child_slot: Weak::new(),
                }],
                std::collections::HashMap::from([(
                    String::from(super::DEFAULT_INSTRUMENT_INSTANCE),
                    0,
                )]),
                1,
            ));
        (wrap, stats)
    }

    fn wrap_with_child_slot(
        slot: ChildSlot<InstrumentRole>,
        stats: Arc<OutProcInstrumentStats>,
    ) -> (Arc<EngineWrap>, Arc<Mutex<ChildSlot<InstrumentRole>>>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let child_slot = Arc::new(Mutex::new(slot));
        let (event_tx, _event_rx) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control for injection") =
            Some(super::test_instrument_control(
                vec![super::InstrumentSlotEntry {
                    event_tx,
                    stats,
                    shm_path: PathBuf::from("/tmp/unused-instrument-child-slot.shm"),
                    child_exe: PathBuf::from("unused-instrument-child"),
                    sample_rate: 48_000,
                    engaged: Arc::new(AtomicBool::new(false)),
                    drain_requested: Arc::new(AtomicBool::new(false)),
                    drain_done: Arc::new(AtomicBool::new(false)),
                    source_dests: super::default_source_dests(),
                    child_slot: Arc::downgrade(&child_slot),
                }],
                std::collections::HashMap::from([(
                    String::from(super::DEFAULT_INSTRUMENT_INSTANCE),
                    0,
                )]),
                1,
            ));
        (wrap, child_slot)
    }

    fn assert_instrument_runtime_error_contains(error: WrapError, expected: &str) {
        assert!(
            matches!(&error,
                WrapError::OutProcInstrument(message) | WrapError::OutProcSlotClosed(message)
                if message.contains(expected)),
            "expected OutProcInstrument error containing {expected:?}, got {error:?}"
        );
    }

    #[cfg(not(feature = "outproc-effect"))]
    #[test]
    fn instrument_only_plugin_state_save_resolves_the_default_instance() {
        let shm_path = crate::outproc_instrument::unique_shm_path();
        let active = super::outproc_load_error_test_support::active_child_slot::<InstrumentRole>(
            || shm_path.clone(),
            "stateful-instrument.clap",
            None,
        );
        let (wrap, _child_slot) = wrap_with_child_slot(active, OutProcInstrumentStats::new());
        let final_path = std::env::temp_dir().join(format!(
            "orbit-instrument-only-state-{}-{}.state",
            std::process::id(),
            super::short_uuid()
        ));

        let error = wrap
            .save_outproc_plugin_state(
                super::PluginStateTarget::Instrument {
                    instance: super::DEFAULT_INSTRUMENT_INSTANCE.to_string(),
                },
                0,
                final_path.clone(),
            )
            .expect_err("STARTING child must reject state save after resolving the instance");

        assert!(
            matches!(error, WrapError::PluginStateNotReady(_)),
            "instrument-only save must reach the selected child mailbox, got {error:?}"
        );
        assert!(
            !final_path.exists(),
            "not-ready rejection must happen before creating the final state file"
        );
    }

    #[test]
    fn instrument_load_outproc_open_shared_failure_closes_slot() {
        super::outproc_load_error_test_support::open_shared_failure_closes_slot(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_spawn_failure_restores_empty_for_retry() {
        super::outproc_load_error_test_support::spawn_failure_restores_empty_for_retry(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_early_exit_fast_fails_and_keeps_retry_shm() {
        super::outproc_load_error_test_support::early_exit_fast_fails_and_keeps_retry_shm(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "exit-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_role_mismatch_retries_same_slot() {
        super::outproc_load_error_test_support::role_mismatch_retries_same_slot(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "retry-instrument.clap",
            true,
            false,
        );
    }

    #[test]
    fn instrument_select_child_exe_swaps_default_child_by_extension() {
        let stats = InstrumentRole::new_stats();
        let mut launch = ChildLaunch::<InstrumentRole> {
            shm_path: PathBuf::from("/tmp/unused-select-child-exe.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/orbit-clap-instrument-child"),
            sample_rate: 48_000,
            stats: stats.clone(),
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };

        InstrumentRole::select_child_exe(&mut launch, Path::new("synth.vst3"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-vst3-instrument-child")
        );

        // Symmetric: attaching a .clap plugin afterwards swaps back to the CLAP child.
        InstrumentRole::select_child_exe(&mut launch, Path::new("synth.clap"))
            .expect("select_child_exe must not error on default child name");
        assert_eq!(
            launch.child_exe.file_name().and_then(|name| name.to_str()),
            Some("orbit-clap-instrument-child")
        );

        // An explicitly-named (non-default) child exe is preserved untouched.
        let mut explicit_launch = ChildLaunch::<InstrumentRole> {
            shm_path: PathBuf::from("/tmp/unused-select-child-exe-explicit.shm"),
            child_exe: PathBuf::from("/opt/orbitscore/custom-instrument-child"),
            sample_rate: 48_000,
            stats,
            engaged: Arc::new(AtomicBool::new(false)),
            cleanup_shm_on_drop: false,
        };
        InstrumentRole::select_child_exe(&mut explicit_launch, Path::new("synth.vst3"))
            .expect("select_child_exe must not error on explicit child name");
        assert_eq!(
            explicit_launch
                .child_exe
                .file_name()
                .and_then(|name| name.to_str()),
            Some("custom-instrument-child")
        );
    }

    #[test]
    fn instrument_load_outproc_rejects_closed_slot() {
        super::outproc_load_error_test_support::closed_slot_is_rejected(
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "unused-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_rejects_loading_slot() {
        super::outproc_load_error_test_support::loading_slot_is_rejected(
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "already-loading-instrument.clap",
            "second-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_concurrent_call_fails_fast_on_loading() {
        super::outproc_load_error_test_support::concurrent_load_call_observes_loading_without_blocking(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            false, // instrument role: CHILD_FLAG_HAS_AUDIO_INPUT must stay clear
            "loading-instrument.clap",
            "second-instrument.clap",
        );
    }

    #[test]
    fn instrument_load_outproc_active_accepts_idempotent_reload() {
        super::outproc_load_error_test_support::active_slot_accepts_idempotent_reload(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            "active-instrument.clap",
            Some("sub-a".to_string()),
        );
    }

    #[test]
    fn instrument_load_outproc_active_rejects_plugin_id_change() {
        super::outproc_load_error_test_support::active_slot_rejects_plugin_id_change(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "active-instrument.clap",
            Some("sub-a".to_string()),
            Some("sub-b".to_string()),
        );
    }

    #[test]
    fn instrument_load_outproc_active_rejects_path_replacement() {
        super::outproc_load_error_test_support::active_slot_rejects_path_replacement(
            crate::outproc_instrument::unique_shm_path,
            wrap_with_child_slot,
            assert_instrument_runtime_error_contains,
            "active-instrument.clap",
            "other-instrument.clap",
        );
    }

    #[test]
    fn instrument_ready_ack_rejects_audio_input_flag() {
        assert!(InstrumentRole::role_matches(0));
        assert!(!InstrumentRole::role_matches(
            orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT
        ));
    }

    // `outproc_instrument_health()` mirrors `outproc_health_tests` (effect side) exactly --
    // Ok(None)/Ok(Some)/WouldBlock/Poisoned branches. It bundles all 6 instrument health signals
    // (child-process trio + output-event-overflow trio + event_decode_error_count) into one
    // accessor/one try_lock, so every test below uses distinct values to catch a field-to-field
    // mapping swap anywhere in the tuple.

    #[test]
    fn health_ok_none_reports_only_injected_values() {
        // instrument 未注入（build() 直後の初期値）= Ok(None) 分岐。
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(4, Ordering::Relaxed);
        wrap.outproc_instrument_respawns_arc()
            .fetch_add(2, Ordering::Relaxed);
        wrap.outproc_instrument_measurement_invalid_arc()
            .store(true, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(7, Ordering::Relaxed);
        assert_eq!(
            wrap.outproc_instrument_health(),
            (4, 2, true, 7, 0, 0, 0),
            "Ok(None): only injected counters/flag surface; real output-event fields are 0"
        );
    }

    #[test]
    fn health_ok_some_sums_real_stats_with_injected_counters() {
        // Ok(Some(c)) 分岐: 実 OutProcInstrumentStats スナップショットと injected カウンタを両方
        // 合算/OR して返すこと（6 値とも異なる数にして field-to-field mapping の swap を検知
        // できるようにする -- `outproc_health_tests::ok_some_sums_real_stats_with_injected_counter`
        // と同じ意図）。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats.child_process_error_count.store(3, Ordering::Relaxed);
        stats.respawn_count.store(2, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(11, Ordering::Relaxed);
        stats
            .output_event_spilled_count
            .store(13, Ordering::Relaxed);
        stats
            .output_note_end_dropped_count
            .store(6, Ordering::Relaxed);
        stats.event_decode_error_count.store(8, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(9, Ordering::Relaxed);
        wrap.outproc_instrument_respawns_arc()
            .fetch_add(5, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(1, Ordering::Relaxed);

        assert_eq!(
            wrap.outproc_instrument_health(),
            (12, 7, true, 12, 13, 6, 8)
        );
    }

    #[test]
    fn health_would_block_ignores_real_stats_and_reports_only_injected() {
        // WouldBlock 分岐: 別スレッドが outproc_instrument mutex を保持している間は real stats を
        // 読まず injected 分のみ返すこと（cumulative なので次 tick で real 分も取り戻せる設計）。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats
            .child_process_error_count
            .store(100, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(200, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(1, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(4, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let (holding_tx, holding_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc_instrument
                .lock()
                .expect("lock outproc_instrument for contention setup");
            holding_tx.send(()).expect("signal lock held");
            release_rx.recv().expect("wait for release signal");
        });
        holding_rx.recv().expect("holder thread signaled lock held");

        assert_eq!(wrap.outproc_instrument_health(), (1, 0, false, 4, 0, 0, 0));

        release_tx.send(()).expect("signal release");
        holder.join().expect("holder thread should not panic");
    }

    #[test]
    fn health_poisoned_still_reports_injected_values_not_lost() {
        // Poisoned 分岐: real stats は 0/false に丸めるが、injected 分は黙って失わず返すこと
        // (`outproc_health_tests::poisoned_still_reports_injected_frames_clamped_not_lost` と同じ
        // genuine-poison パターン: 別スレッドで panic → join)。
        let (wrap, stats) = wrap_with_instrument_stats();
        stats.child_process_error_count.store(42, Ordering::Relaxed);
        stats.measurement_invalid.store(true, Ordering::Relaxed);
        stats
            .output_event_dropped_count
            .store(99, Ordering::Relaxed);
        wrap.outproc_instrument_child_errors_arc()
            .fetch_add(3, Ordering::Relaxed);
        wrap.outproc_instrument_output_dropped_arc()
            .fetch_add(2, Ordering::Relaxed);

        let wrap_clone = wrap.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = wrap_clone
                .outproc_instrument
                .lock()
                .expect("lock outproc_instrument for poison setup");
            panic!("intentional poison for outproc_instrument_health poisoned test");
        })
        .join()
        .is_err();
        assert!(
            panicked,
            "spawned thread should have panicked while holding the lock"
        );

        assert_eq!(wrap.outproc_instrument_health(), (3, 0, false, 2, 0, 0, 0));
    }
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_replace_tests {
    use super::{
        clear_quiesce_unless_shutdown, clear_quiesce_unless_shutdown_with, test_effect_slot_entry,
        ChildLaunch, ChildSlot, EffectRole, EffectSlotEntry, EngineWrap, OutProcControl,
        OutProcRole, PluginUiWiring, UnloadedPluginStatus, WrapError,
    };
    use crate::backend::StubBackend;
    use crate::outproc_effect::OutProcEffectStats;
    use orbit_audio_native::CallbackTimeStats;
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const BUS: &str = "fx1";
    const OLD_PLUGIN: &str = "old-effect.clap";
    const BUS_PLUGIN: &str = "bus-effect.clap";
    const NEW_PLUGIN: &str = "new-effect.clap";
    const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

    struct SlotFixture {
        slot: Arc<Mutex<ChildSlot<EffectRole>>>,
        entry: EffectSlotEntry,
        stats: Arc<OutProcEffectStats>,
        old_pid: u32,
    }

    struct EffectFixture {
        wrap: Arc<EngineWrap>,
        master: SlotFixture,
        bus: Option<SlotFixture>,
        bus_active: Option<Arc<AtomicBool>>,
    }

    fn fixture_script(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn active_slot(plugin: &str, child_exe: PathBuf) -> SlotFixture {
        let shm_path = crate::outproc_effect::unique_shm_path();
        let _ = std::fs::remove_file(&shm_path);
        drop(orbit_audio_sandbox::create_shared(&shm_path).expect("create fixture shm"));
        let stats = OutProcEffectStats::new();
        let engaged = Arc::new(AtomicBool::new(false));
        let requested = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut launch = ChildLaunch::<EffectRole> {
            shm_path: shm_path.clone(),
            child_exe: child_exe.clone(),
            sample_rate: 48_000,
            stats: stats.clone(),
            engaged: engaged.clone(),
            cleanup_shm_on_drop: true,
        };
        let mut child = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn old effect fixture child");
        let old_pid = child.id();
        assert!(child.try_wait().expect("try_wait old child").is_none());
        stats.current_child_pid.store(old_pid, Ordering::Relaxed);
        let path = PathBuf::from(plugin);
        let latest_state = Arc::new(Mutex::new(None));
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(shm_path.clone()));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let ui_index_binding = Arc::new(Mutex::new(Default::default()));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let supervisor = EffectRole::spawn_supervisor(
            child,
            &launch,
            path.clone(),
            None,
            latest_state.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump.clone(),
                target: ui_target.clone(),
                index_binding: Some(ui_index_binding.clone()),
                events: ui_events,
            },
        )
        .expect("spawn old effect fixture supervisor");
        launch.cleanup_shm_on_drop = false;
        engaged.store(true, Ordering::Release);
        let slot = Arc::new(Mutex::new(ChildSlot::Active {
            path,
            plugin_id: None,
            state: None,
            latest_state,
            engaged: engaged.clone(),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding: Some(ui_index_binding),
            _supervisor: supervisor,
        }));
        SlotFixture {
            slot,
            entry: EffectSlotEntry {
                shm_path,
                child_exe,
                sample_rate: 48_000,
                engaged,
                quiesce_requested: requested,
                quiesce_done: done,
                shutdown,
                chain: Arc::new(Mutex::new(vec![
                    crate::outproc_effect::ChainStageConfig::Catalog {
                        path: PathBuf::from(OLD_PLUGIN),
                        plugin_id: None,
                        latest_state: None,
                        enabled: true,
                    },
                ])),
            },
            stats,
            old_pid,
        }
    }

    fn fixture(master_child: PathBuf, bus_child: Option<PathBuf>) -> EffectFixture {
        let master = active_slot(OLD_PLUGIN, master_child);
        let bus = bus_child.map(|child| active_slot(BUS_PLUGIN, child));
        let bus_active = bus.as_ref().map(|_| Arc::new(AtomicBool::new(true)));
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let mut bus_slots = HashMap::new();
        let mut bus_entries = HashMap::new();
        let mut bus_stats = HashMap::new();
        let mut bus_actives = HashMap::new();
        if let Some(bus_fixture) = &bus {
            bus_slots.insert(BUS.to_owned(), Arc::downgrade(&bus_fixture.slot));
            bus_entries.insert(BUS.to_owned(), bus_fixture.entry.clone());
            bus_stats.insert(BUS.to_owned(), bus_fixture.stats.clone());
            bus_actives.insert(
                BUS.to_owned(),
                bus_active.as_ref().expect("bus active exists").clone(),
            );
        }
        *wrap.outproc.lock().expect("lock effect fixture control") = Some(OutProcControl {
            stats: master.stats.clone(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Arc::downgrade(&master.slot),
            master_entry: master.entry.clone(),
            bus_slots,
            bus_entries,
            bus_stats,
            bus_actives,
            bus_kinds: HashMap::new(),
            bus_index: HashMap::new(),
            bus_routing: HashMap::new(),
            bus_sends: HashMap::new(),
            replacements_in_flight: HashSet::new(),
        });
        EffectFixture {
            wrap,
            master,
            bus,
            bus_active,
        }
    }

    fn wait_until(message: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        while !predicate() {
            assert!(Instant::now() < deadline, "timed out waiting for {message}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn process_exists(pid: u32) -> bool {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run kill -0")
            .success()
    }

    fn publish_ready(slot: &SlotFixture) {
        let mmap = orbit_audio_sandbox::open_shared(&slot.entry.shm_path)
            .expect("open fixture shm for READY");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        // SAFETY: mmap is live for the publish and this fixture has one READY writer.
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, true) };
    }

    fn spawn_quiesce_ack(entry: &EffectSlotEntry) -> std::thread::JoinHandle<()> {
        let requested = entry.quiesce_requested.clone();
        let done = entry.quiesce_done.clone();
        std::thread::spawn(move || {
            wait_until("effect quiesce request", || {
                requested.load(Ordering::Acquire)
            });
            done.store(true, Ordering::Release);
        })
    }

    fn complete_replace(
        wrap: Arc<EngineWrap>,
        slot: &SlotFixture,
        target: Option<String>,
        plugin: &str,
    ) -> u32 {
        let previous_pid = slot.stats.current_child_pid.load(Ordering::Relaxed);
        let ack = spawn_quiesce_ack(&slot.entry);
        let plugin = PathBuf::from(plugin);
        let call = std::thread::spawn(move || {
            wrap.replace_outproc_effect_plugin(plugin, None, target, None)
        });
        wait_until("replacement child pid", || {
            let pid = slot.stats.current_child_pid.load(Ordering::Relaxed);
            pid != 0 && pid != previous_pid
        });
        wait_until("old effect child teardown", || {
            !process_exists(previous_pid)
        });
        publish_ready(slot);
        call.join()
            .expect("replacement thread panicked")
            .expect("effect replacement succeeds");
        ack.join().expect("quiesce ack thread panicked");
        slot.stats.current_child_pid.load(Ordering::Relaxed)
    }

    #[test]
    fn replace_active_tears_down_old_child_before_attach() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        let old_pid = fixture.master.old_pid;
        let new_pid = complete_replace(fixture.wrap.clone(), &fixture.master, None, NEW_PLUGIN);
        assert_ne!(new_pid, old_pid);
        assert!(!process_exists(old_pid), "old child must be reaped");
        assert!(matches!(
            &*fixture.master.slot.lock().expect("lock master"),
            ChildSlot::Active { path, .. } if path == Path::new(NEW_PLUGIN)
        ));
    }

    #[test]
    fn unload_keeps_bus_active_and_resets_slot_to_empty() {
        let fixture = fixture(
            fixture_script("slow-child.sh"),
            Some(fixture_script("slow-child.sh")),
        );
        let bus = fixture.bus.as_ref().expect("bus fixture exists");
        let old_pid = bus.old_pid;
        let ack = spawn_quiesce_ack(&bus.entry);

        let status = fixture
            .wrap
            .unload_outproc_effect_plugin(Some(BUS.to_owned()))
            .expect("effect unload succeeds");
        ack.join().expect("quiesce ack thread panicked");

        assert_eq!(status, UnloadedPluginStatus::Unloaded);
        assert!(!process_exists(old_pid), "old child must be reaped");
        assert!(matches!(
            &*bus.slot.lock().expect("lock bus slot"),
            ChildSlot::Empty(_)
        ));
        assert!(
            fixture
                .bus_active
                .as_ref()
                .expect("bus active exists")
                .load(Ordering::Acquire),
            "unload must not deactivate the allocated bus"
        );
        {
            let control = fixture.wrap.outproc.lock().expect("lock outproc");
            let control = control.as_ref().expect("outproc exists");
            assert!(control.bus_slots.contains_key(BUS));
            assert!(control.bus_entries.contains_key(BUS));
        }

        assert_eq!(
            fixture
                .wrap
                .unload_outproc_effect_plugin(Some(BUS.to_owned()))
                .expect("empty effect unload is idempotent"),
            UnloadedPluginStatus::Noop
        );
    }

    #[test]
    fn replace_same_spec_is_idempotent() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        let summary = fixture
            .wrap
            .replace_outproc_effect_plugin(PathBuf::from(OLD_PLUGIN), None, None, None)
            .expect("same spec is an idempotent success");
        assert_eq!(summary.plugin.plugin_id, OLD_PLUGIN);
        assert_eq!(
            fixture
                .master
                .stats
                .current_child_pid
                .load(Ordering::Relaxed),
            fixture.master.old_pid
        );
        assert!(!fixture
            .master
            .entry
            .quiesce_requested
            .load(Ordering::Acquire));
        assert!(!fixture.master.entry.quiesce_done.load(Ordering::Acquire));
    }

    #[test]
    fn replace_rolls_back_when_quiesce_ack_times_out() {
        let fixture = fixture(PathBuf::from("/definitely/missing/effect-child"), None);
        let started = Instant::now();
        let error = fixture
            .wrap
            .replace_outproc_effect_plugin(PathBuf::from(NEW_PLUGIN), None, None, None)
            .expect_err("missing quiesce ack must fail before teardown");
        assert!(started.elapsed() >= super::EFFECT_QUIESCE_TIMEOUT);
        assert!(matches!(&error, WrapError::OutProcEffect(message)
            if message.contains("quiesce ack timed out")
                && message.contains("previous effect is kept")));
        assert!(matches!(
            &*fixture.master.slot.lock().expect("lock master"),
            ChildSlot::Active { path, .. } if path == Path::new(OLD_PLUGIN)
        ));
        assert!(fixture.master.entry.engaged.load(Ordering::Acquire));
        assert!(!fixture
            .master
            .entry
            .quiesce_requested
            .load(Ordering::Acquire));
        assert!(!fixture.master.entry.quiesce_done.load(Ordering::Acquire));
        assert!(process_exists(fixture.master.old_pid));
    }

    #[test]
    fn failed_replacement_attach_keeps_bus_active() {
        let fixture = fixture(
            fixture_script("slow-child.sh"),
            Some(fixture_script("exit-child.sh")),
        );
        let bus = fixture.bus.as_ref().expect("bus fixture");
        let ack = spawn_quiesce_ack(&bus.entry);
        let error = fixture
            .wrap
            .replace_outproc_effect_plugin(
                PathBuf::from("/definitely/nonexistent/Issue625.clap"),
                None,
                Some(BUS.to_owned()),
                None,
            )
            .expect_err("replacement child exits before READY");
        ack.join().expect("quiesce ack thread panicked");
        assert!(matches!(error, WrapError::OutProcAttachFailed(_)));
        assert!(
            fixture
                .bus_active
                .as_ref()
                .expect("bus active")
                .load(Ordering::Acquire),
            "replacement failure must not deactivate an already-declared bus"
        );
        assert!(matches!(
            &*bus.slot.lock().expect("lock bus"),
            ChildSlot::Empty(_)
        ));
    }

    #[test]
    fn second_replace_while_in_flight_is_rejected() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        let wrap_first = fixture.wrap.clone();
        let first = std::thread::spawn(move || {
            wrap_first.replace_outproc_effect_plugin(PathBuf::from(NEW_PLUGIN), None, None, None)
        });
        wait_until("effect replacement reservation", || {
            fixture
                .wrap
                .outproc
                .lock()
                .expect("lock effect control")
                .as_ref()
                .expect("effect control")
                .replacements_in_flight
                .contains(&None)
        });
        let second = fixture
            .wrap
            .replace_outproc_effect_plugin(PathBuf::from("other-effect.clap"), None, None, None)
            .expect_err("second replacement must fail fast");
        assert!(matches!(&second, WrapError::OutProcEffect(message)
            if message.contains("effect replacement already in progress")
                && message.contains("master")));

        fixture
            .master
            .entry
            .quiesce_done
            .store(true, Ordering::Release);
        wait_until("first replacement child pid", || {
            let pid = fixture
                .master
                .stats
                .current_child_pid
                .load(Ordering::Relaxed);
            pid != 0 && pid != fixture.master.old_pid
        });
        publish_ready(&fixture.master);
        first
            .join()
            .expect("first replacement thread panicked")
            .expect("first replacement succeeds");
    }

    #[test]
    fn quiesce_flags_reset_after_successful_replace() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        complete_replace(fixture.wrap.clone(), &fixture.master, None, NEW_PLUGIN);
        assert!(!fixture
            .master
            .entry
            .quiesce_requested
            .load(Ordering::Acquire));
        assert!(!fixture.master.entry.quiesce_done.load(Ordering::Acquire));

        complete_replace(
            fixture.wrap.clone(),
            &fixture.master,
            None,
            "third-effect.clap",
        );
        assert!(!fixture
            .master
            .entry
            .quiesce_requested
            .load(Ordering::Acquire));
        assert!(!fixture.master.entry.quiesce_done.load(Ordering::Acquire));
    }

    /// #625 audit A-1: a tenant handoff must clear the previous tenant's sticky health verdict.
    ///
    /// `measurement_invalid` is latched by the watchdog when it gives up on a child and is
    /// never cleared anywhere else. Without a reset here, replacing a crash-looping effect
    /// with a healthy one leaves the daemon reporting "measurement invalid" for the new
    /// tenant until restart — every health-based diagnostic (and the E2E error-count oracle)
    /// then reads a verdict about a plugin that is no longer loaded.
    #[test]
    fn replace_clears_the_previous_tenants_measurement_invalid_verdict() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        fixture
            .master
            .stats
            .measurement_invalid
            .store(true, Ordering::Release);
        complete_replace(fixture.wrap.clone(), &fixture.master, None, NEW_PLUGIN);
        assert!(
            !fixture
                .master
                .stats
                .measurement_invalid
                .load(Ordering::Acquire),
            "the new tenant must not inherit the old tenant's measurement_invalid verdict"
        );
    }

    #[test]
    fn replace_without_bus_targets_master_slot() {
        let fixture = fixture(
            fixture_script("slow-child.sh"),
            Some(fixture_script("slow-child.sh")),
        );
        let bus = fixture.bus.as_ref().expect("bus fixture");
        let bus_pid = bus.old_pid;
        complete_replace(fixture.wrap.clone(), &fixture.master, None, NEW_PLUGIN);
        assert!(matches!(
            &*fixture.master.slot.lock().expect("lock master"),
            ChildSlot::Active { path, .. } if path == Path::new(NEW_PLUGIN)
        ));
        assert!(matches!(
            &*bus.slot.lock().expect("lock bus"),
            ChildSlot::Active { path, .. } if path == Path::new(BUS_PLUGIN)
        ));
        assert_eq!(bus.stats.current_child_pid.load(Ordering::Relaxed), bus_pid);
        assert!(process_exists(bus_pid));
    }

    #[test]
    fn replace_respects_stream_shutdown_latch() {
        let fixture = fixture(fixture_script("slow-child.sh"), None);
        fixture.master.entry.shutdown.store(true, Ordering::Release);
        let error = fixture
            .wrap
            .replace_outproc_effect_plugin(PathBuf::from(NEW_PLUGIN), None, None, None)
            .expect_err("shutdown latch must reject replacement before touching the slot");
        assert!(matches!(&error, WrapError::OutProcEffect(message)
            if message.contains("engine is stopping")));
        assert!(matches!(
            &*fixture.master.slot.lock().expect("lock master"),
            ChildSlot::Active { path, .. } if path == Path::new(OLD_PLUGIN)
        ));
        assert!(fixture.master.entry.engaged.load(Ordering::Acquire));
        assert!(!fixture
            .master
            .entry
            .quiesce_requested
            .load(Ordering::Acquire));
        assert!(!fixture.master.entry.quiesce_done.load(Ordering::Acquire));

        let entry = test_effect_slot_entry();
        entry.quiesce_requested.store(true, Ordering::Release);
        entry.quiesce_done.store(true, Ordering::Release);
        entry.shutdown.store(true, Ordering::Release);
        clear_quiesce_unless_shutdown(&entry);
        assert!(entry.quiesce_requested.load(Ordering::Acquire));
        assert!(entry.quiesce_done.load(Ordering::Acquire));

        let entry = test_effect_slot_entry();
        entry.quiesce_requested.store(true, Ordering::Release);
        entry.quiesce_done.store(true, Ordering::Release);
        clear_quiesce_unless_shutdown_with(&entry, || {
            // Deterministic guard interleaving: Drop stores shutdown before requested.
            entry.shutdown.store(true, Ordering::Release);
            entry.quiesce_requested.store(true, Ordering::Release);
        });
        assert!(
            entry.quiesce_requested.load(Ordering::Acquire),
            "a shutdown request racing the clear must be restored"
        );
        assert!(!entry.quiesce_done.load(Ordering::Acquire));
    }
}

#[cfg(all(test, feature = "outproc-instrument"))]
mod outproc_instrument_replace_tests {
    use super::{
        test_instrument_control, ChildLaunch, ChildSlot, EngineWrap, InstrumentRole,
        InstrumentSlotEntry, InstrumentSlotTeardownResources, OutProcRole, PluginUiWiring,
        WrapError,
    };
    use crate::backend::StubBackend;
    use crate::outproc_instrument::OutProcInstrumentStats;
    use crate::test_tracing::capture_tracing;
    use orbit_audio_sandbox::NeutralEvent;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const OLD_INSTANCE: &str = "plugin:lead";
    const OLD_PLUGIN: &str = "old-instrument.clap";
    const NEW_PLUGIN: &str = "new-instrument.clap";
    const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

    struct SlotFixture {
        slot: Arc<Mutex<ChildSlot<InstrumentRole>>>,
        event_rx: Option<rtrb::Consumer<NeutralEvent>>,
        stats: Arc<OutProcInstrumentStats>,
        shm_path: PathBuf,
        engaged: Arc<AtomicBool>,
        drain_requested: Arc<AtomicBool>,
        drain_done: Arc<AtomicBool>,
        source_dests: Vec<orbit_audio_native::SourceDestCell>,
    }

    fn fixture_script(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn empty_slot(child_exe: PathBuf) -> (InstrumentSlotEntry, SlotFixture) {
        let shm_path = crate::outproc_instrument::unique_shm_path();
        let _ = std::fs::remove_file(&shm_path);
        drop(orbit_audio_sandbox::create_shared(&shm_path).expect("create fixture shm"));
        let stats = OutProcInstrumentStats::new();
        let engaged = Arc::new(AtomicBool::new(false));
        let drain_requested = Arc::new(AtomicBool::new(false));
        let drain_done = Arc::new(AtomicBool::new(false));
        let (event_tx, event_rx) = rtrb::RingBuffer::new(16);
        let source_dests = super::default_source_dests();
        let slot = Arc::new(Mutex::new(ChildSlot::Empty(
            ChildLaunch::<InstrumentRole> {
                shm_path: shm_path.clone(),
                child_exe: child_exe.clone(),
                sample_rate: 48_000,
                stats: stats.clone(),
                engaged: engaged.clone(),
                cleanup_shm_on_drop: true,
            },
        )));
        let entry = InstrumentSlotEntry {
            event_tx,
            stats: stats.clone(),
            shm_path: shm_path.clone(),
            child_exe,
            sample_rate: 48_000,
            engaged: engaged.clone(),
            drain_requested: drain_requested.clone(),
            drain_done: drain_done.clone(),
            source_dests: source_dests.clone(),
            child_slot: Arc::downgrade(&slot),
        };
        (
            entry,
            SlotFixture {
                slot,
                event_rx: Some(event_rx),
                stats,
                shm_path,
                engaged,
                drain_requested,
                drain_done,
                source_dests,
            },
        )
    }

    fn activate_slot(fixture: &SlotFixture, plugin: &str) -> u32 {
        let mut slot = fixture.slot.lock().expect("lock fixture slot");
        let mut launch = match std::mem::replace(&mut *slot, ChildSlot::Closed) {
            ChildSlot::Empty(launch) => launch,
            _ => panic!("fixture slot must start Empty"),
        };
        let mut child = crate::outproc_stub_child::stub_child_command()
            .spawn()
            .expect("spawn old fixture child");
        let pid = child.id();
        fixture
            .stats
            .current_child_pid
            .store(pid, Ordering::Relaxed);
        // A synchronous preflight proves the fixture child is still alive before ownership moves
        // into the supervisor. Cleanup assertions later use kill -0 disappearance.
        assert!(child.try_wait().expect("try_wait old fixture").is_none());
        let path = PathBuf::from(plugin);
        let latest_state = Arc::new(Mutex::new(None));
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            launch.shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(
            launch.shm_path.clone(),
        ));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let (ui_events, _) = tokio::sync::broadcast::channel(16);
        let supervisor = InstrumentRole::spawn_supervisor(
            child,
            &launch,
            path.clone(),
            None,
            latest_state.clone(),
            mailbox.clone(),
            PluginUiWiring {
                pump: ui_pump.clone(),
                target: ui_target.clone(),
                index_binding: None,
                events: ui_events,
            },
        )
        .expect("spawn old fixture supervisor");
        launch.cleanup_shm_on_drop = false;
        launch.engaged.store(true, Ordering::Release);
        *slot = ChildSlot::Active {
            path,
            plugin_id: None,
            state: None,
            latest_state,
            engaged: launch.engaged.clone(),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding: None,
            _supervisor: supervisor,
        };
        pid
    }

    fn inject_control(
        entries: Vec<InstrumentSlotEntry>,
        instance_index: HashMap<String, usize>,
        next_unassigned: usize,
    ) -> Arc<EngineWrap> {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock replacement fixture control") = Some(test_instrument_control(
            entries,
            instance_index,
            next_unassigned,
        ));
        wrap
    }

    fn wait_until(message: &str, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        while !predicate() {
            assert!(Instant::now() < deadline, "timed out waiting for {message}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn publish_ready(fixture: &SlotFixture) {
        let mmap = orbit_audio_sandbox::open_shared(&fixture.shm_path).expect("open fixture shm");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        // SAFETY: mmap lives through the publish and this fixture has a single readiness writer.
        unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, false) };
    }

    fn control_mode(fixture: &SlotFixture) -> u32 {
        let mmap = orbit_audio_sandbox::open_shared(&fixture.shm_path).expect("open fixture shm");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        unsafe { (*region).control.load(Ordering::Acquire) }
    }

    fn process_exists(pid: u32) -> bool {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .expect("run kill -0")
            .success()
    }

    fn spawn_drain_ack(
        event_rx: rtrb::Consumer<NeutralEvent>,
        shm_path: PathBuf,
        engaged: Arc<AtomicBool>,
        requested: Arc<AtomicBool>,
        done: Arc<AtomicBool>,
        stats: Arc<OutProcInstrumentStats>,
    ) -> std::thread::JoinHandle<rtrb::Consumer<NeutralEvent>> {
        std::thread::spawn(move || {
            use orbit_audio_native::{BlockSource, BlockTransport};

            let host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(
                orbit_audio_sandbox::open_shared(&shm_path).expect("open RT fixture shm"),
            );
            let mut processor = crate::outproc_instrument::OutProcInstrumentBlockSource::new(
                host,
                event_rx,
                16,
                engaged,
                crate::outproc_instrument::SlotSignals {
                    teardown_requested: Arc::new(AtomicBool::new(false)),
                    teardown_done: Arc::new(AtomicBool::new(false)),
                    drain_requested: requested.clone(),
                    drain_done: done,
                },
                stats,
            );
            wait_until("drain request", || requested.load(Ordering::Acquire));
            processor.render(
                0,
                &BlockTransport {
                    cursor_frames: 0,
                    sample_rate: 48_000,
                },
            );
            processor.into_event_rx_for_test()
        })
    }

    fn take_processor(
        fixture: &mut SlotFixture,
    ) -> crate::outproc_instrument::OutProcInstrumentBlockSource {
        let host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(
            orbit_audio_sandbox::open_shared(&fixture.shm_path)
                .expect("open persistent RT fixture shm"),
        );
        crate::outproc_instrument::OutProcInstrumentBlockSource::new(
            host,
            fixture.event_rx.take().expect("fixture event consumer"),
            16,
            fixture.engaged.clone(),
            crate::outproc_instrument::SlotSignals {
                teardown_requested: Arc::new(AtomicBool::new(false)),
                teardown_done: Arc::new(AtomicBool::new(false)),
                drain_requested: fixture.drain_requested.clone(),
                drain_done: fixture.drain_done.clone(),
            },
            fixture.stats.clone(),
        )
    }

    fn start_successful_replace(
        wrap: Arc<EngineWrap>,
        old: &mut SlotFixture,
        spare: &SlotFixture,
        new_plugin: &str,
    ) -> (
        Result<super::ReplacedPluginSummary, WrapError>,
        rtrb::Consumer<NeutralEvent>,
    ) {
        let ack = spawn_drain_ack(
            old.event_rx.take().expect("old event consumer"),
            old.shm_path.clone(),
            old.engaged.clone(),
            old.drain_requested.clone(),
            old.drain_done.clone(),
            old.stats.clone(),
        );
        let plugin = PathBuf::from(new_plugin);
        let call = std::thread::spawn(move || {
            wrap.replace_outproc_instrument_plugin(plugin, None, Some(OLD_INSTANCE.into()), None)
        });
        wait_until("spare child pid", || {
            spare.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(spare);
        let result = call.join().expect("replace thread panicked");
        let event_rx = ack.join().expect("drain ack thread panicked");
        (result, event_rx)
    }

    fn two_slot_fixture(spare_child: &str) -> (Arc<EngineWrap>, SlotFixture, SlotFixture, u32) {
        let (old_entry, old) = empty_slot(fixture_script("slow-child.sh"));
        let old_pid = activate_slot(&old, OLD_PLUGIN);
        let (spare_entry, spare) = empty_slot(fixture_script(spare_child));
        let wrap = inject_control(
            vec![old_entry, spare_entry],
            HashMap::from([(OLD_INSTANCE.to_string(), 0)]),
            1,
        );
        (wrap, old, spare, old_pid)
    }

    /// `free_slot` は同じ index を二重に積まない。積むと1つの slot が2テナントへ
    /// 同時に払い出され、shm を共有した child が2本立つ。抽出前は呼び出し側2箇所に
    /// 手書きされていたガードなので、抽出先で不変条件が生きていることを直接固定する。
    #[test]
    fn free_slot_never_lists_the_same_index_twice() {
        let mut control = test_instrument_control(Vec::new(), HashMap::new(), 0);

        control.free_slot(3);
        control.free_slot(3);
        assert_eq!(
            control.free_slots,
            vec![3],
            "duplicate free must be ignored"
        );

        control.free_slot(1);
        assert_eq!(control.free_slots, vec![3, 1]);
        assert_eq!(
            control.allocate_slot(),
            Some(1),
            "LIFO reuse order is preserved"
        );
        assert_eq!(control.allocate_slot(), Some(3));
        assert_eq!(
            control.allocate_slot(),
            None,
            "no slots exist, so the unassigned pool must not hand one out"
        );
    }

    #[test]
    fn replacement_reservation_releases_in_flight_on_unwind() {
        let wrap = inject_control(Vec::new(), HashMap::new(), 0);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let wrap = wrap.clone();
            move || {
                let mut reservation =
                    super::InstrumentReplacementReservation::new(&wrap, OLD_INSTANCE.into());
                {
                    let mut guard = wrap.outproc_instrument.lock().expect("lock control");
                    guard
                        .as_mut()
                        .expect("instrument control")
                        .replacements_in_flight
                        .insert(OLD_INSTANCE.into());
                    reservation.mark_in_flight();
                }
                panic!("intentional replacement unwind");
            }
        }))
        .is_err();
        assert!(panicked);
        assert!(
            wrap.outproc_instrument
                .lock()
                .expect("lock control after unwind")
                .as_ref()
                .expect("instrument control")
                .replacements_in_flight
                .is_empty(),
            "Drop must release in-flight ownership during unwind"
        );
    }

    #[test]
    fn replacement_reservation_returns_spare_when_child_slot_upgrade_fails() {
        let (wrap, _old, spare, old_pid) = two_slot_fixture("slow-child.sh");
        drop(spare);

        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("expired spare child slot must fail replacement");
        assert!(matches!(&error, WrapError::OutProcInstrument(message)
            if message.contains("instrument stream is closed")));
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.free_slots, vec![1]);
        assert!(control.replacements_in_flight.is_empty());
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert!(process_exists(old_pid));
    }

    #[test]
    fn replace_active_same_spec_is_an_idempotent_no_op() {
        let (wrap, old, spare, old_pid) = two_slot_fixture("slow-child.sh");
        old.engaged.store(false, Ordering::Release);

        let result = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(OLD_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect("same spec must converge without preparing a spare");

        assert!(!result.quarantined_slot);
        assert_eq!(result.plugin.plugin_id, OLD_PLUGIN);
        assert!(old.engaged.load(Ordering::Acquire));
        assert!(process_exists(old_pid));
        assert_eq!(spare.stats.current_child_pid.load(Ordering::Relaxed), 0);
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert!(control.free_slots.is_empty());
        assert_eq!(control.next_unassigned, 1);
        assert!(control.replacements_in_flight.is_empty());
    }

    #[test]
    fn replace_loading_instance_returns_explicit_in_progress_error() {
        let (old_entry, old) = empty_slot(fixture_script("slow-child.sh"));
        let (spare_entry, spare) = empty_slot(fixture_script("slow-child.sh"));
        {
            let mut slot = old.slot.lock().expect("lock old slot");
            let launch = match std::mem::replace(&mut *slot, ChildSlot::Closed) {
                ChildSlot::Empty(launch) => launch,
                _ => panic!("fixture old slot must be Empty"),
            };
            *slot = ChildSlot::Loading {
                path: PathBuf::from(OLD_PLUGIN),
            };
            drop(launch);
        }
        let wrap = inject_control(
            vec![old_entry, spare_entry],
            HashMap::from([(OLD_INSTANCE.into(), 0)]),
            1,
        );

        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("Loading old slot must reject replace");
        assert!(matches!(&error, WrapError::OutProcInstrument(message)
            if message.contains("instrument plugin load already in progress")
                && message.contains(OLD_PLUGIN)));
        assert_eq!(spare.stats.current_child_pid.load(Ordering::Relaxed), 0);
        let control = wrap.outproc_instrument.lock().expect("lock control");
        assert!(control
            .as_ref()
            .expect("instrument control")
            .replacements_in_flight
            .is_empty());
    }

    #[test]
    fn replace_closed_instance_returns_slot_closed_error() {
        let (old_entry, old) = empty_slot(fixture_script("slow-child.sh"));
        let (spare_entry, spare) = empty_slot(fixture_script("slow-child.sh"));
        {
            let mut slot = old.slot.lock().expect("lock old slot");
            let previous = std::mem::replace(&mut *slot, ChildSlot::Closed);
            drop(previous);
        }
        let wrap = inject_control(
            vec![old_entry, spare_entry],
            HashMap::from([(OLD_INSTANCE.into(), 0)]),
            1,
        );

        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("Closed old slot must reject replace");
        assert!(matches!(&error, WrapError::OutProcSlotClosed(message)
            if message.contains("slot is closed after an unrecoverable attach failure")));
        assert_eq!(spare.stats.current_child_pid.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn replace_mapped_empty_instance_degrades_to_load_in_the_same_slot() {
        let (old_entry, old) = empty_slot(fixture_script("slow-child.sh"));
        let (spare_entry, spare) = empty_slot(fixture_script("slow-child.sh"));
        let wrap = inject_control(
            vec![old_entry, spare_entry],
            HashMap::from([(OLD_INSTANCE.into(), 0)]),
            1,
        );
        let wrap_call = wrap.clone();
        let call = std::thread::spawn(move || {
            wrap_call.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("mapped Empty child pid", || {
            old.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&old);
        let result = call
            .join()
            .expect("replace thread panicked")
            .expect("mapped Empty must load normally");

        assert!(!result.quarantined_slot);
        assert_eq!(spare.stats.current_child_pid.load(Ordering::Relaxed), 0);
        assert!(matches!(
            &*old.slot.lock().expect("lock loaded old slot"),
            ChildSlot::Active { path, .. } if path == Path::new(NEW_PLUGIN)
        ));
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert_eq!(control.next_unassigned, 1);
        assert!(control.free_slots.is_empty());
        assert!(control.replacements_in_flight.is_empty());
    }

    #[test]
    fn r1_replace_migrates_all_unit_destinations_then_resets_every_freed_unit() {
        let (wrap, mut old, spare, old_pid) = two_slot_fixture("slow-child.sh");
        let expected_dests = (0..orbit_audio_native::MAX_SOURCE_UNITS)
            .map(orbit_audio_native::SourceDest::Bus)
            .collect::<Vec<_>>();
        for (cell, dest) in old.source_dests.iter().zip(&expected_dests) {
            cell.store(*dest);
        }
        let (result, _old_rx) =
            start_successful_replace(wrap.clone(), &mut old, &spare, NEW_PLUGIN);
        let result = result.expect("replacement succeeds");
        assert!(!result.quarantined_slot);

        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&1));
        assert_eq!(
            control.free_slots,
            vec![0],
            "old slot is returned exactly once"
        );
        assert!(control.replacements_in_flight.is_empty());
        assert!(!process_exists(old_pid), "old child PID must disappear");
        assert!(matches!(
            &*spare.slot.lock().expect("lock spare"),
            ChildSlot::Active { path, .. } if path == Path::new(NEW_PLUGIN)
        ));
        assert_ne!(spare.stats.current_child_pid.load(Ordering::Relaxed), 0);
        assert_eq!(
            spare
                .source_dests
                .iter()
                .map(orbit_audio_native::SourceDestCell::load)
                .collect::<Vec<_>>(),
            expected_dests,
            "replace must migrate every source unit destination"
        );
        assert!(
            old.source_dests
                .iter()
                .all(|cell| cell.load() == orbit_audio_native::SourceDest::None),
            "a successfully freed slot must reset every source unit to None"
        );
    }

    #[test]
    fn replacement_cleanup_keeps_notes_added_after_repoint() {
        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        wrap.inject_active_plugin_note(OLD_INSTANCE, 0, 60)
            .expect("inject old tenant note");

        let wrap_call = wrap.clone();
        let call = std::thread::spawn(move || {
            wrap_call.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("spare child pid", || {
            spare.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&spare);
        wait_until("old slot drain request", || {
            old.drain_requested.load(Ordering::Acquire)
        });

        // drain request は snapshot と instance_index の再ポイントより後。ここで入れた note は
        // 新 tenant の entry なので、旧 tenant snapshot の cleanup に巻き込まれてはならない。
        wrap.inject_active_plugin_note(OLD_INSTANCE, 0, 61)
            .expect("inject new tenant note during teardown");
        let ack = spawn_drain_ack(
            old.event_rx.take().expect("old event consumer"),
            old.shm_path.clone(),
            old.engaged.clone(),
            old.drain_requested.clone(),
            old.drain_done.clone(),
            old.stats.clone(),
        );

        call.join()
            .expect("replace thread panicked")
            .expect("replacement succeeds");
        ack.join().expect("drain ack thread panicked");

        let active = wrap.lock_active_notes().expect("lock active notes");
        assert_eq!(active.len(), 1);
        assert!(
            active.contains(&(OLD_INSTANCE.to_string(), 0, 61)),
            "cleanup must remove only the pre-repoint snapshot"
        );
    }

    #[test]
    fn successful_teardown_resets_all_unit_destinations_before_slot_reuse() {
        let (entry, mut fixture) = empty_slot(fixture_script("slow-child.sh"));
        let child_pid = activate_slot(&fixture, OLD_PLUGIN);
        for (unit, cell) in fixture.source_dests.iter().enumerate() {
            cell.store(orbit_audio_native::SourceDest::Link(unit));
        }
        let resources =
            InstrumentSlotTeardownResources::from_entry(0, &entry, fixture.slot.clone());
        let ack = spawn_drain_ack(
            fixture.event_rx.take().expect("fixture event consumer"),
            fixture.shm_path.clone(),
            fixture.engaged.clone(),
            fixture.drain_requested.clone(),
            fixture.drain_done.clone(),
            fixture.stats.clone(),
        );
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");

        wrap.teardown_outproc_instrument_resources(OLD_INSTANCE, resources)
            .expect("teardown with RT drain ack and valid mapping must succeed");
        ack.join().expect("drain ack thread panicked");

        assert!(
            fixture
                .source_dests
                .iter()
                .all(|cell| cell.load() == orbit_audio_native::SourceDest::None),
            "teardown must reset all source units before the slot can be reused"
        );
        assert!(!process_exists(child_pid), "teardown must reap the child");
    }

    #[test]
    fn r11_replacement_teardown_never_respawns_the_old_child() {
        let (wrap, mut old, spare, old_pid) = two_slot_fixture("slow-child.sh");
        let respawns_before = old.stats.respawn_count.load(Ordering::Relaxed);
        let (result, _old_rx) =
            start_successful_replace(wrap.clone(), &mut old, &spare, NEW_PLUGIN);
        result.expect("replacement succeeds");

        assert!(!process_exists(old_pid), "old child PID must disappear");
        let observation_deadline = Instant::now() + Duration::from_millis(200);
        while Instant::now() < observation_deadline {
            assert_eq!(
                old.stats.respawn_count.load(Ordering::Relaxed),
                respawns_before,
                "teardown must not be mistaken for an unexpected child exit"
            );
            assert_eq!(
                old.stats.current_child_pid.load(Ordering::Relaxed),
                0,
                "old slot must stay without a child after teardown"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        let new_pid = spare.stats.current_child_pid.load(Ordering::Relaxed);
        assert_ne!(new_pid, 0, "replacement child must still be running");
        drop(wrap);
        drop(old);
        drop(spare);
        wait_until("replacement child cleanup", || !process_exists(new_pid));
    }

    #[test]
    fn r2_prepare_failure_keeps_old_mapping_and_child_and_returns_empty_spare() {
        let (wrap, old, spare, old_pid) = two_slot_fixture("exit-child.sh");
        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("pre-READY exit must fail prepare");
        assert!(matches!(&error, WrapError::OutProcAttachFailed(message)
            if message.contains("exited before publishing READY")));
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert_eq!(control.free_slots, vec![1]);
        assert!(control.replacements_in_flight.is_empty());
        assert!(process_exists(old_pid), "old child must remain alive");
        assert!(matches!(
            &*old.slot.lock().expect("lock old"),
            ChildSlot::Active { path, .. } if path == Path::new(OLD_PLUGIN)
        ));
        assert!(matches!(
            &*spare.slot.lock().expect("lock spare"),
            ChildSlot::Empty(_)
        ));
    }

    #[test]
    fn r10_closed_prepare_spare_is_not_returned_to_free_list() {
        let (wrap, old, spare, old_pid) = two_slot_fixture("slow-child.sh");
        std::fs::remove_file(&spare.shm_path)
            .expect("remove spare shm to force an unrecoverable prepare failure");

        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("missing spare shm must fail replacement prepare");

        assert!(matches!(&error, WrapError::OutProcInstrument(message)
            if message.contains("open child readiness mapping")));
        {
            let control = wrap.outproc_instrument.lock().expect("lock control");
            let control = control.as_ref().expect("instrument control");
            assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
            assert_eq!(
                control.free_slots,
                Vec::<usize>::new(),
                "Closed spare must not enter the free-list"
            );
            assert!(control.replacements_in_flight.is_empty());
        }
        assert!(process_exists(old_pid), "old child must remain alive");
        assert!(matches!(
            &*old.slot.lock().expect("lock old"),
            ChildSlot::Active { path, .. } if path == Path::new(OLD_PLUGIN)
        ));
        assert!(matches!(
            &*spare.slot.lock().expect("lock spare"),
            ChildSlot::Closed
        ));

        drop(wrap);
        drop(old);
        wait_until("old child cleanup", || !process_exists(old_pid));
    }

    #[test]
    fn r3_freed_slot_is_reused_only_after_control_run_is_restored() {
        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        let (result, _old_rx) =
            start_successful_replace(wrap.clone(), &mut old, &spare, NEW_PLUGIN);
        result.expect("replacement succeeds");
        assert_eq!(control_mode(&old), orbit_audio_sandbox::CONTROL_RUN);

        let wrap_call = wrap.clone();
        let load = std::thread::spawn(move || {
            wrap_call.load_outproc_instrument_plugin(
                PathBuf::from("third-instrument.clap"),
                None,
                Some("plugin:third".into()),
                None,
            )
        });
        wait_until("reused-slot child pid", || {
            old.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        assert_eq!(control_mode(&old), orbit_audio_sandbox::CONTROL_RUN);
        publish_ready(&old);
        load.join()
            .expect("load thread panicked")
            .expect("freed slot load succeeds");

        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get("plugin:third"), Some(&0));
        assert!(control.free_slots.is_empty());
        assert!(matches!(
            &*old.slot.lock().expect("lock reused slot"),
            ChildSlot::Active { path, .. } if path == Path::new("third-instrument.clap")
        ));
    }

    #[test]
    fn r4_concurrent_replace_of_same_instance_is_rejected_by_in_flight_guard() {
        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        let ack = spawn_drain_ack(
            old.event_rx.take().expect("old event consumer"),
            old.shm_path.clone(),
            old.engaged.clone(),
            old.drain_requested.clone(),
            old.drain_done.clone(),
            old.stats.clone(),
        );
        let wrap_first = wrap.clone();
        let first = std::thread::spawn(move || {
            wrap_first.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("replacement in-flight", || {
            wrap.outproc_instrument
                .lock()
                .expect("lock control")
                .as_ref()
                .expect("instrument control")
                .replacements_in_flight
                .contains(OLD_INSTANCE)
        });
        let second = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from("other-target.clap"),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("second replace must fail fast");
        assert!(matches!(&second, WrapError::OutProcInstrument(message)
            if message.contains("replacement already in progress")
                && message.contains(OLD_INSTANCE)));
        wait_until("first replacement child pid", || {
            spare.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&spare);
        first
            .join()
            .expect("first replace thread panicked")
            .expect("first replace succeeds");
        ack.join().expect("drain ack thread panicked");
    }

    #[test]
    fn r5_pool_exhaustion_requires_spare_and_leaves_old_untouched() {
        let (entry, old) = empty_slot(fixture_script("slow-child.sh"));
        let old_pid = activate_slot(&old, OLD_PLUGIN);
        let wrap = inject_control(
            vec![entry],
            HashMap::from([(OLD_INSTANCE.to_string(), 0)]),
            1,
        );
        let error = wrap
            .replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
            .expect_err("replacement without spare must fail");
        assert!(matches!(&error, WrapError::OutProcInstrument(message)
            if message.contains("replacement needs one spare slot")));
        assert!(process_exists(old_pid));
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert!(control.replacements_in_flight.is_empty());
    }

    #[test]
    fn r6_replace_of_unassigned_instance_degrades_to_normal_load() {
        let (entry, slot) = empty_slot(fixture_script("slow-child.sh"));
        let wrap = inject_control(vec![entry], HashMap::new(), 0);
        let wrap_call = wrap.clone();
        let call = std::thread::spawn(move || {
            wrap_call.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("ensure-load child pid", || {
            slot.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&slot);
        call.join()
            .expect("ensure thread panicked")
            .expect("unassigned ensure load succeeds");
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&0));
        assert!(control.replacements_in_flight.is_empty());
    }

    #[test]
    fn r7_replacement_supervisor_respawns_the_new_plugin_spec() {
        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("record-respawn-args.sh");
        let (result, _old_rx) = start_successful_replace(wrap, &mut old, &spare, NEW_PLUGIN);
        result.expect("replacement succeeds");
        let args_path = PathBuf::from(format!("{}.respawn-args", spare.shm_path.display()));
        wait_until("initial child argument record", || args_path.exists());
        let _ = std::fs::remove_file(&args_path);
        let first_pid = spare.stats.current_child_pid.load(Ordering::Relaxed);
        let before = spare.stats.respawn_count.load(Ordering::Relaxed);
        let killed = Command::new("kill")
            .arg("-9")
            .arg(first_pid.to_string())
            .status()
            .expect("kill replacement child");
        assert!(killed.success());
        wait_until("replacement child respawn", || {
            spare.stats.respawn_count.load(Ordering::Relaxed) > before && args_path.exists()
        });
        let args = std::fs::read_to_string(&args_path).expect("read respawn args");
        assert!(args.lines().any(|arg| arg == NEW_PLUGIN), "args={args:?}");
        assert!(!args.lines().any(|arg| arg == OLD_PLUGIN), "args={args:?}");
        assert_ne!(
            spare.stats.current_child_pid.load(Ordering::Relaxed),
            first_pid
        );
        std::fs::remove_file(args_path).expect("remove respawn args");
    }

    #[test]
    fn r8_commit_time_ring_residue_is_discarded_before_next_tenant() {
        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        wrap.plugin_note_on(64, 0, 0.8, Some(OLD_INSTANCE.into()))
            .expect("queue old-tenant note immediately before replace");
        let (result, mut old_rx) =
            start_successful_replace(wrap.clone(), &mut old, &spare, NEW_PLUGIN);
        result.expect("replacement succeeds");
        assert!(old_rx.pop().is_err(), "freed ring must be empty");

        let wrap_call = wrap.clone();
        let load = std::thread::spawn(move || {
            wrap_call.load_outproc_instrument_plugin(
                PathBuf::from("next-tenant.clap"),
                None,
                Some("plugin:next".into()),
                None,
            )
        });
        wait_until("next-tenant child pid", || {
            old.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&old);
        load.join()
            .expect("next load thread panicked")
            .expect("next tenant loads into freed slot");
        assert!(
            old_rx.pop().is_err(),
            "next tenant must not receive the old tenant's note"
        );
    }

    #[test]
    fn tenant_handoff_resets_voice_bookkeeping_and_sticky_health() {
        use orbit_audio_native::{BlockSource, BlockTransport};

        let transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };

        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        let mut processor = take_processor(&mut old);
        wrap.plugin_note_on(
            u8::try_from(crate::outproc_instrument::PROBE_KEY.key).expect("probe key fits u8"),
            u8::try_from(crate::outproc_instrument::PROBE_KEY.channel)
                .expect("probe channel fits u8"),
            0.8,
            Some(OLD_INSTANCE.into()),
        )
        .expect("queue old tenant note");
        processor.render(0, &transport);
        assert_eq!(processor.probe_live_count_for_test(), 1);
        assert_eq!(old.stats.probe_live_count.load(Ordering::Relaxed), 1);
        old.stats.measurement_invalid.store(true, Ordering::Release);

        let wrap_replace = wrap.clone();
        let replace = std::thread::spawn(move || {
            wrap_replace.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("replacement spare child pid", || {
            spare.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&spare);
        wait_until("tenant handoff drain request", || {
            old.drain_requested.load(Ordering::Acquire)
        });
        processor.render(0, &transport);
        let result = replace
            .join()
            .expect("replace thread panicked")
            .expect("replacement succeeds");
        assert!(!result.quarantined_slot);
        assert!(!old.stats.measurement_invalid.load(Ordering::Acquire));
        assert_eq!(old.stats.probe_live_count.load(Ordering::Relaxed), 0);

        let wrap_load = wrap.clone();
        let load = std::thread::spawn(move || {
            wrap_load.load_outproc_instrument_plugin(
                PathBuf::from("next-tenant.clap"),
                None,
                Some("plugin:next".into()),
                None,
            )
        });
        wait_until("next tenant child pid", || {
            old.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&old);
        load.join()
            .expect("next tenant load thread panicked")
            .expect("next tenant loads into freed slot");

        processor.render(0, &transport);
        assert_eq!(
            processor.probe_live_count_for_test(),
            0,
            "new tenant must not inherit the old VoiceTable"
        );
        assert_eq!(
            old.stats.probe_live_count.load(Ordering::Relaxed),
            0,
            "new tenant health must start with no live probe voice"
        );
    }

    #[test]
    fn reset_mapping_failure_quarantines_the_old_slot_and_reports_it() {
        use orbit_audio_native::{BlockSource, BlockTransport};

        let transport = BlockTransport {
            cursor_frames: 0,
            sample_rate: 48_000,
        };

        let (wrap, mut old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        let mut processor = take_processor(&mut old);
        let wrap_replace = wrap.clone();
        let replace = std::thread::spawn(move || {
            wrap_replace.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        wait_until("mapping-failure spare child pid", || {
            spare.stats.current_child_pid.load(Ordering::Relaxed) != 0
        });
        publish_ready(&spare);
        wait_until("mapping-failure drain request", || {
            old.drain_requested.load(Ordering::Acquire)
        });
        std::fs::remove_file(&old.shm_path).expect("unlink old shm before teardown reset mapping");
        processor.render(0, &transport);
        let result = replace
            .join()
            .expect("replace thread panicked")
            .expect("replacement commit still succeeds");

        assert!(result.quarantined_slot);
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&1));
        assert_eq!(control.free_slots, Vec::<usize>::new());
        assert!(control.replacements_in_flight.is_empty());
        assert!(matches!(
            &*old.slot.lock().expect("lock quarantined old slot"),
            ChildSlot::Empty(_)
        ));
    }

    #[test]
    fn r9_missing_rt_ack_warns_and_quarantines_old_slot() {
        let (wrap, old, spare, _old_pid) = two_slot_fixture("slow-child.sh");
        let publisher_stats = spare.stats.clone();
        let publisher_path = spare.shm_path.clone();
        let publisher = std::thread::spawn(move || {
            wait_until("timeout-test spare child pid", || {
                publisher_stats.current_child_pid.load(Ordering::Relaxed) != 0
            });
            let mmap = orbit_audio_sandbox::open_shared(&publisher_path)
                .expect("open timeout-test spare shm");
            let region = orbit_audio_sandbox::region_ptr(&mmap);
            unsafe { orbit_audio_sandbox::transport::publish_child_ready(region, false) };
        });
        let started = Instant::now();
        let (result, rendered) = capture_tracing(tracing::Level::WARN, || {
            wrap.replace_outproc_instrument_plugin(
                PathBuf::from(NEW_PLUGIN),
                None,
                Some(OLD_INSTANCE.into()),
                None,
            )
        });
        let result = result.expect("commit succeeds even when old slot is quarantined");
        assert!(result.quarantined_slot);
        publisher.join().expect("READY publisher panicked");
        assert!(started.elapsed() >= super::INSTRUMENT_DRAIN_TIMEOUT);
        let timeout_warning = rendered
            .lines()
            .find(|line| line.contains("event drain-and-discard ack timed out"))
            .expect("drain timeout warning");
        assert!(
            timeout_warning.contains("slot quarantined from free-list")
                && timeout_warning.contains(OLD_INSTANCE),
            "captured warning: {rendered:?}"
        );
        let control = wrap.outproc_instrument.lock().expect("lock control");
        let control = control.as_ref().expect("instrument control");
        assert_eq!(control.instance_index.get(OLD_INSTANCE), Some(&1));
        assert!(!control.free_slots.contains(&0));
        assert!(control.replacements_in_flight.is_empty());
        assert!(old.drain_requested.load(Ordering::Acquire));
        assert!(matches!(
            &*old.slot.lock().expect("lock quarantined slot"),
            ChildSlot::Empty(_)
        ));
    }
}

#[cfg(all(test, feature = "outproc-instrument"))]
mod outproc_instrument_note_tests {
    use super::{test_instrument_control, EngineWrap, WrapError};
    use crate::backend::StubBackend;
    use orbit_audio_sandbox::{NeutralEvent, VoiceAddr};

    fn wrap_with_note_consumer(
        capacity: usize,
    ) -> (std::sync::Arc<EngineWrap>, rtrb::Consumer<NeutralEvent>) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let (event_tx, event_rx) = rtrb::RingBuffer::new(capacity);
        let stats = crate::outproc_instrument::OutProcInstrumentStats::new();
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control") = Some(test_instrument_control(
            vec![super::InstrumentSlotEntry {
                event_tx,
                stats,
                shm_path: std::path::PathBuf::from("/tmp/unused-note-slot.shm"),
                child_exe: std::path::PathBuf::from("unused-instrument-child"),
                sample_rate: 48_000,
                engaged: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                drain_requested: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                drain_done: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                source_dests: super::default_source_dests(),
                child_slot: std::sync::Weak::new(),
            }],
            std::collections::HashMap::from([(
                String::from(super::DEFAULT_INSTRUMENT_INSTANCE),
                0,
            )]),
            1,
        ));
        (wrap, event_rx)
    }

    #[test]
    fn plugin_notes_are_converted_to_neutral_events_on_control_side() {
        let (wrap, mut event_rx) = wrap_with_note_consumer(4);
        wrap.plugin_note_on(60, 3, 0.75, None)
            .expect("send note on");
        wrap.plugin_note_off(61, 4, 0.25, None)
            .expect("send note off");

        let expected_addr = |channel, key| VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel,
            key,
            _pad: 0,
        };
        assert_eq!(
            event_rx.pop(),
            Ok(NeutralEvent::NoteOn {
                sample_offset: 0,
                addr: expected_addr(3, 60),
                velocity: 0.75,
                tuning_cents: 0.0,
                length_frames: 0,
            })
        );
        assert_eq!(
            event_rx.pop(),
            Ok(NeutralEvent::NoteOff {
                sample_offset: 0,
                addr: expected_addr(4, 61),
                velocity: 0.25,
            })
        );
    }

    /// #540 P1: 2 slot の control を組み、instance ごとの ring を返す（slot routing 検証用）。
    fn wrap_with_two_slots() -> (
        std::sync::Arc<EngineWrap>,
        rtrb::Consumer<NeutralEvent>,
        rtrb::Consumer<NeutralEvent>,
    ) {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let (tx_a, rx_a) = rtrb::RingBuffer::new(4);
        let (tx_b, rx_b) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control") = Some(test_instrument_control(
            vec![
                super::InstrumentSlotEntry {
                    event_tx: tx_a,
                    stats: crate::outproc_instrument::OutProcInstrumentStats::new(),
                    shm_path: std::path::PathBuf::from("/tmp/unused-note-slot-a.shm"),
                    child_exe: std::path::PathBuf::from("unused-instrument-child"),
                    sample_rate: 48_000,
                    engaged: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    drain_requested: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    drain_done: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    source_dests: super::default_source_dests(),
                    child_slot: std::sync::Weak::new(),
                },
                super::InstrumentSlotEntry {
                    event_tx: tx_b,
                    stats: crate::outproc_instrument::OutProcInstrumentStats::new(),
                    shm_path: std::path::PathBuf::from("/tmp/unused-note-slot-b.shm"),
                    child_exe: std::path::PathBuf::from("unused-instrument-child"),
                    sample_rate: 48_000,
                    engaged: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    drain_requested: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    drain_done: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    source_dests: super::default_source_dests(),
                    child_slot: std::sync::Weak::new(),
                },
            ],
            std::collections::HashMap::from([
                (String::from("plugin:kick"), 0),
                (String::from("plugin:lead"), 1),
            ]),
            2,
        ));
        (wrap, rx_a, rx_b)
    }

    // #540 P1: instance が note を正しい slot の ring へ導くこと。取り違え（常に slot 0 へ
    // 送る退行）は rx_b が空のままになるので検出できる。
    #[test]
    fn plugin_notes_route_to_the_slot_of_their_instance() {
        let (wrap, mut rx_a, mut rx_b) = wrap_with_two_slots();
        wrap.plugin_note_on(60, 0, 0.8, Some("plugin:lead".into()))
            .expect("note to lead slot");
        wrap.plugin_note_on(61, 0, 0.8, Some("plugin:kick".into()))
            .expect("note to kick slot");

        // lead (slot 1) には key 60 のみ、kick (slot 0) には key 61 のみが届く。
        match rx_b.pop() {
            Ok(NeutralEvent::NoteOn { addr, .. }) => assert_eq!(addr.key, 60),
            other => panic!("expected NoteOn(60) in lead slot ring, got {other:?}"),
        }
        assert!(
            rx_b.pop().is_err(),
            "lead slot must receive exactly 1 event"
        );
        match rx_a.pop() {
            Ok(NeutralEvent::NoteOn { addr, .. }) => assert_eq!(addr.key, 61),
            other => panic!("expected NoteOn(61) in kick slot ring, got {other:?}"),
        }
        assert!(
            rx_a.pop().is_err(),
            "kick slot must receive exactly 1 event"
        );
    }

    // #540 P1: 未割当 instance への note は「ロード前」と同義の明示エラー（黙って slot 0 に
    // 送らない — 取り違えたら別シーケンスの音源が鳴る）。
    #[test]
    fn plugin_note_to_unknown_instance_is_an_explicit_error() {
        let (wrap, mut rx_a, mut rx_b) = wrap_with_two_slots();
        let err = wrap
            .plugin_note_on(60, 0, 0.8, Some("plugin:ghost".into()))
            .expect_err("unknown instance must error");
        assert!(
            matches!(&err, WrapError::OutProcInstrument(message)
                if message.contains("unknown instrument instance 'plugin:ghost'")),
            "expected unknown-instance error, got {err:?}"
        );
        assert!(rx_a.pop().is_err(), "no slot may receive the event");
        assert!(rx_b.pop().is_err(), "no slot may receive the event");
    }

    // #540 P1: pool 枯渇は明示エラー（既存 instance の再ロードは exhaustion にならない —
    // 既存は slot 解決まで到達して「stream is closed」で落ちる = 割当ロジックの区別を検証）。
    //
    // 🔴 cfg は呼び先に合わせる: `load_outproc_instrument_plugin` は both build
    // (`all(outproc-effect, outproc-instrument)`) でのみ定義される。テスト側を
    // `outproc-instrument` だけで有効にすると、**`--features outproc-instrument` 単独の
    // ビルドがコンパイルエラーになる**（出荷経路は常に both build なので成果物は無事だが、
    // 単独 feature で `cargo test` を叩いた開発者が理由の分からないエラーに当たる）。
    #[cfg(feature = "outproc-effect")]
    #[test]
    fn load_distinguishes_existing_instance_from_pool_exhaustion() {
        let (wrap, _rx_a, _rx_b) = wrap_with_two_slots();
        // 既存 instance → slot 解決へ進む（Weak::new() のため stream closed で落ちる）。
        let existing = wrap
            .load_outproc_instrument_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("plugin:kick".into()),
                None,
            )
            .expect_err("weak slot cannot upgrade");
        assert!(
            matches!(&existing, WrapError::OutProcInstrument(message)
                if message.contains("stream is closed")),
            "existing instance must reach slot resolution, got {existing:?}"
        );
        // 新規 instance（3つ目）→ pool (2 slots) 枯渇の明示エラー。
        let exhausted = wrap
            .load_outproc_instrument_plugin(
                std::path::PathBuf::from("unused.clap"),
                None,
                Some("plugin:extra".into()),
                None,
            )
            .expect_err("pool of 2 is exhausted by a 3rd instance");
        assert!(
            matches!(&exhausted, WrapError::OutProcInstrument(message)
                if message.contains("instrument slot pool exhausted")
                    && message.contains("ORBIT_OUTPROC_INSTRUMENT_SLOTS")),
            "expected exhaustion error with the env-var hint, got {exhausted:?}"
        );
    }

    // pr-test-analyzer (item 6, PR #422 review): `push_outproc_instrument_event`'s ring-full error
    // path (increments `plugin_event_ring_overflow_count`, returns `WrapError::OutProcInstrument`)
    // had no coverage. A capacity-1 ring plus a consumer that never drains guarantees the ring
    // fills; loop until `plugin_note_on` errors rather than assuming rtrb's exact fill count.
    #[test]
    fn push_outproc_instrument_event_reports_ring_full_and_increments_overflow_counter() {
        let (wrap, _event_rx) = wrap_with_note_consumer(1);
        let before = wrap.plugin_event_ring_overflow_count();

        let mut result = Ok(());
        for _ in 0..8 {
            result = wrap.plugin_note_on(60, 0, 0.8, None);
            if result.is_err() {
                break;
            }
        }

        let err = result.expect_err("ring must eventually report full (never drained)");
        assert!(
            matches!(err, WrapError::OutProcInstrument(_)),
            "expected OutProcInstrument(ring full), got {err:?}"
        );
        assert_eq!(
            wrap.plugin_event_ring_overflow_count(),
            before + 1,
            "ring-full push must increment the overflow counter exactly once"
        );
    }

    #[test]
    fn plugin_all_notes_off_keeps_every_ring_full_entry_and_reports_failures() {
        let (wrap, _event_rx) = wrap_with_note_consumer(1);
        wrap.plugin_note_on(60, 0, 0.8, None)
            .expect("first note fills the ring");
        wrap.inject_active_plugin_note(super::DEFAULT_INSTRUMENT_INSTANCE, 0, 61)
            .expect("inject second tracked note");
        let before = wrap.plugin_event_ring_overflow_count();

        let summary = wrap
            .plugin_all_notes_off()
            .expect("delivery failures are returned in the summary");

        assert_eq!(summary.released, 0);
        assert_eq!(summary.stale, 0);
        assert_eq!(summary.failed, 2);
        assert_eq!(
            wrap.active_plugin_note_count().expect("count notes"),
            2,
            "failed entries must never leave the active-note ledger"
        );
        assert_eq!(
            wrap.plugin_event_ring_overflow_count(),
            before + 2,
            "a failure must not prevent the remaining ledger entry from being attempted"
        );
    }

    #[test]
    fn plugin_all_notes_off_panic_leaves_the_full_ledger_intact() {
        let (wrap, mut event_rx) = wrap_with_note_consumer(1);
        for (instance, key) in [
            ("plugin:first", 60),
            ("plugin:panic", 61),
            ("plugin:last", 62),
        ] {
            wrap.inject_active_plugin_note(instance, 0, key)
                .expect("inject tracked note");
        }

        // HashSet iteration is deliberately unordered. Read the stable order for this unchanged
        // set, then make its middle entry panic: entry 0 must be delivered successfully first,
        // while entry 2 must remain unprocessed after the panic.
        let iteration_order = wrap
            .lock_active_notes()
            .expect("lock active notes")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(iteration_order.len(), 3);
        let panic_instance = iteration_order[1].0.clone();
        let mut instrument = wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control");
        let instance_index = &mut instrument
            .as_mut()
            .expect("instrument control")
            .instance_index;
        for (instance, _, _) in &iteration_order {
            instance_index.insert(instance.clone(), 0);
        }
        instance_index.insert(panic_instance, usize::MAX);
        drop(instrument);

        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = wrap.plugin_all_notes_off();
        }))
        .is_err();

        assert!(
            panicked,
            "invalid slot index must exercise the loop panic path"
        );
        let delivered = event_rx
            .pop()
            .expect("first entry must be delivered before panic");
        match delivered {
            NeutralEvent::NoteOff { addr, .. } => {
                assert_eq!(addr.channel, i16::from(iteration_order[0].1));
                assert_eq!(addr.key, i16::from(iteration_order[0].2));
            }
            other => panic!("expected NoteOff before panic, got {other:?}"),
        }
        assert!(
            event_rx.pop().is_err(),
            "entry after the panic must never be processed"
        );
        assert_eq!(
            wrap.active_plugin_note_count().expect("count notes"),
            3,
            "even the successfully delivered entry must remain until the whole loop commits"
        );
    }

    /// 🔴 ラウンド3 のレビュー指摘: **成功時に台帳から除去することを検査するテストが 1 本も無かった**。
    /// panic テストは `retain` ブロックに到達する前に止まるので、**ブロックを丸ごと削除する変異が
    /// 全テストを通過していた**。台帳が永久に増え、次の解放で死んだ note を送り続ける状態になる。
    #[test]
    fn plugin_all_notes_off_removes_every_released_entry_from_the_ledger() {
        let (wrap, mut event_rx) = wrap_with_note_consumer(8);
        let notes = [("plugin:a", 60u8), ("plugin:b", 61), ("plugin:c", 62)];
        for (instance, key) in notes {
            wrap.inject_active_plugin_note(instance, 0, key)
                .expect("inject tracked note");
        }
        {
            let mut instrument = wrap
                .outproc_instrument
                .lock()
                .expect("lock instrument control");
            let instance_index = &mut instrument
                .as_mut()
                .expect("instrument control")
                .instance_index;
            for (instance, _) in notes {
                instance_index.insert(instance.to_string(), 0);
            }
        }

        let summary = wrap
            .plugin_all_notes_off()
            .expect("every entry resolves to a live slot");

        assert_eq!(summary.released, notes.len());
        assert_eq!(summary.stale, 0);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            wrap.active_plugin_note_count().expect("count notes"),
            0,
            "released entries must be removed from the ledger once the loop commits"
        );
        let mut delivered = 0;
        while event_rx.pop().is_ok() {
            delivered += 1;
        }
        assert_eq!(delivered, notes.len(), "every release must reach the ring");
    }

    /// 🔴 ラウンド3: bounded retry の「途中で成功する」分岐を、**本番の
    /// `push_outproc_instrument_event` 経由**で通す。既存の `plugin_event_ring_retry_tests` は
    /// bare な `rtrb::Producer` を叩くだけで、instance 解決と lock 分岐を含む実経路は通らない。
    #[test]
    fn outproc_push_retries_then_succeeds_once_the_consumer_drains() {
        let (wrap, mut event_rx) = wrap_with_note_consumer(1);
        {
            let mut instrument = wrap
                .outproc_instrument
                .lock()
                .expect("lock instrument control");
            instrument
                .as_mut()
                .expect("instrument control")
                .instance_index
                .insert(super::DEFAULT_INSTRUMENT_INSTANCE.to_string(), 0);
        }
        // 容量 1 の ring を埋めて、次の push を必ず Full にする。
        wrap.plugin_note_on(60, 0, 0.8, None)
            .expect("first note fills the ring");

        // retry の途中（budget 200ms のうち十数 ms）で 1 枠あける。
        let drainer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(15));
            event_rx.pop().expect("consumer drains the queued event");
            event_rx
        });

        wrap.plugin_note_on(62, 0, 0.8, None)
            .expect("bounded retry must succeed once the consumer drains a slot");

        let mut event_rx = drainer.join().expect("drainer thread panicked");
        assert!(
            event_rx.pop().is_ok(),
            "the retried note must actually be in the ring"
        );
    }

    // pr-test-analyzer (item 8, PR #422 review): `push_outproc_instrument_event`'s `None` branch
    // (outproc_instrument not initialized, e.g. test backend) had no direct test, unlike the
    // analogous and already-tested `clap-host` `ClapUnavailable` branch
    // (`push_plugin_event_tests`) in this same file.
    #[test]
    fn plugin_note_on_returns_unavailable_when_not_initialized() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let err = wrap
            .plugin_note_on(60, 0, 0.8, None)
            .expect_err("outproc_instrument mutex holds None by default (no injection)");
        assert!(
            matches!(err, WrapError::OutProcInstrumentUnavailable(_)),
            "expected OutProcInstrumentUnavailable, got {err:?}"
        );
    }

    #[test]
    fn plugin_note_off_returns_unavailable_when_not_initialized() {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let err = wrap
            .plugin_note_off(60, 0, 0.0, None)
            .expect_err("outproc_instrument mutex holds None by default (no injection)");
        assert!(
            matches!(err, WrapError::OutProcInstrumentUnavailable(_)),
            "expected OutProcInstrumentUnavailable, got {err:?}"
        );
    }
}
