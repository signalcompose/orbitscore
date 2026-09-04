//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! `Arc<Mutex>` ベースで制御スレッドと audio callback を共有する。
//! audio callback 側は `try_lock` で競合時に無音 fallback する前提（lock-free 化は別 Issue）。

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use std::collections::BTreeMap;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(feature = "outproc-effect")]
use std::sync::atomic::{AtomicU32, AtomicUsize};
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
use orbit_audio_native::{
    load_sample_resampled, LoaderError, OutputError, OutputStream, ResampleError, StreamStats,
    StreamStatsSnapshot,
};
use uuid::Uuid;

use crate::backend::AudioBackend;

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
    /// `push_plugin_event` が bounded retry（[`push_with_bounded_retry`]）の末に諦めた回数（本番は
    /// 常に 0 に近い想定・health signal）。event ring は audio callback が毎 block 全量 drain する
    /// ため満杯は一時的であり、真の drop はこの回数だけ発生する（M2 doc の「溢れても失わない」方針を
    /// in-process ring に retrofit・issue #400）。`EngineWrap` は常に `Arc<EngineWrap>` として共有
    /// されるため、`link_egress_drops`/`clap_process_errors` と異なり test 注入用の `_arc()` getter
    /// が不要。本番の bounded retry 書き込みも test 注入用の
    /// [`plugin_event_ring_overflow_inject`](Self::plugin_event_ring_overflow_inject)（#402）も、
    /// producer 側を別スレッドへ outsource せず常に `&self` 経由で `EngineWrap` 自身が直接書くため、
    /// `Arc` clone による cross-thread 共有が不要で、プレーンな `AtomicU64` で足りる。
    plugin_event_ring_overflow_count: AtomicU64,
    /// control-sideで送信に成功した NoteOn の集合。state保存は音声処理と同じchild loopを止めるため、
    /// sample schedulerだけでなくlive instrument noteが残る間もfail-closedに拒否する。
    #[cfg(feature = "outproc-instrument")]
    active_plugin_notes: Mutex<HashSet<(String, u8, u8)>>,
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
    /// out-of-process instrument の note-ring producer（control side）。
    #[cfg(feature = "outproc-instrument")]
    outproc_instrument: Mutex<Option<OutProcInstrumentControl>>,
}

/// out-of-process effect の control-side ハンドル一式（feature `outproc-effect` 専用）。
/// supervisor 本体（watchdog / child）は `StreamGuard::_child_guard` が保持する。ここは accessor が
/// 読む観測 stats だけを持つ（`ClapControl` と同様 read-path のハンドル）。
#[cfg(feature = "outproc-effect")]
struct OutProcControl {
    /// 観測 stats（fresh/stale/stall/frames_clamped/callback_count/respawn/child error）。
    /// adapter（audio thread）と watchdog（control thread）が書き、accessor / gated harness が読む。
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で測る）。
    cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    child_slot: Weak<Mutex<ChildSlot>>,
    /// master effect slot の再構築と stream shutdown 交錯の制御に必要な固定部材。
    master_entry: EffectSlotEntry,
    /// 起動時に固定した named insert bus の effect slots。master slot は `child_slot` のまま
    /// 保持し、bus 無し LoadPlugin の後方互換を保つ。
    bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>,
    /// bus 名 → slot 再構築部材。`bus_slots` と同じキー集合を持つ。
    bus_entries: HashMap<String, EffectSlotEntry>,
    /// bus 名 → その bus の `OutProcEffectStats`（`outproc_effect_bus_stats` gated 計測用）。
    /// `bus_slots` と同じキー集合で、child の生死に関わらず統計自体は生存し続けるため強参照。
    bus_stats: HashMap<String, Arc<crate::outproc_effect::OutProcEffectStats>>,
    /// bus 名 → render 側 `InsertBusStage::active` と共有する activation flag。LoadPlugin が
    /// bus を指名した時点で `true`（宣言 = activation）。全 bus inactive の間、callback は
    /// bus 無し経路（ビット同一）を通る。
    bus_actives: HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    /// bus 名 → kind（M2・#459/#453）。`SetBusRouting` の検証（output は sum のみ・send 先は
    /// aux のみ許可・MX.4）に使う。
    bus_kinds: HashMap<String, BusKind>,
    /// bus 名 → stage 配列内の絶対 index（M2）。forward-only（後方参照のみ・MX.4）の検証に使う。
    bus_index: HashMap<String, usize>,
    /// bus 名 → render 側 `InsertBusStage::routing_override` と共有する atomic ハンドル（M2）。
    /// `SetBusRouting` がここを書き換えて output target を実行時に切替える。
    bus_routing: HashMap<String, Arc<AtomicUsize>>,
    /// bus 名 → render 側 `InsertBusStage::send_gain_overrides` と共有する atomic ハンドル群
    /// （M2・index k = 「この bus の絶対 index + 1 + k」への send gain）。
    bus_sends: HashMap<String, Vec<Arc<AtomicU32>>>,
    /// 同じ固定 slot に対する差し替えを直列化する。`None` は master。
    replacements_in_flight: HashSet<Option<String>>,
}

/// effect slot 1 本分の control-side 固定部材。in-place teardown 後も同じ shm と gate を使う。
#[cfg(feature = "outproc-effect")]
#[derive(Clone)]
struct EffectSlotEntry {
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    engaged: Arc<AtomicBool>,
    quiesce_requested: Arc<AtomicBool>,
    quiesce_done: Arc<AtomicBool>,
    /// stream 停止が一度始まったことを示す control-side latch。false へ戻さない。
    shutdown: Arc<AtomicBool>,
    /// Rack child の respawn と control command が共有する権威設定。RT は読まない。
    chain: Arc<Mutex<crate::outproc_effect::ChainConfig>>,
}

/// RT adapter が保持する flags と control-side slot/teardown guard を一度だけ束ねる入力。
/// named fields にすることで同型 Arc の位置引数取り違えを構築側にも持ち込まない。
#[cfg(feature = "outproc-effect")]
struct EffectSlotInstallParts {
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    engaged: Arc<AtomicBool>,
    quiesce_requested: Arc<AtomicBool>,
    quiesce_done: Arc<AtomicBool>,
}

#[cfg(feature = "outproc-effect")]
struct InstalledEffectSlot {
    entry: EffectSlotEntry,
    child_slot: Arc<Mutex<ChildSlot<EffectRole>>>,
    teardown: crate::outproc_effect::OutProcTeardownGuard,
}

/// bus / effect-only master / combined master の3経路が共有する配線点。
/// entry・ChildLaunch・guard はここで同じ Arc から同時に構築される。
#[cfg(feature = "outproc-effect")]
fn install_effect_slot(parts: EffectSlotInstallParts) -> InstalledEffectSlot {
    let shutdown = Arc::new(AtomicBool::new(false));
    let entry = EffectSlotEntry {
        shm_path: parts.shm_path.clone(),
        child_exe: parts.child_exe.clone(),
        sample_rate: parts.sample_rate,
        engaged: parts.engaged.clone(),
        quiesce_requested: parts.quiesce_requested.clone(),
        quiesce_done: parts.quiesce_done.clone(),
        shutdown: shutdown.clone(),
        chain: Arc::new(Mutex::new(Vec::new())),
    };
    let child_slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch::<EffectRole> {
        shm_path: parts.shm_path,
        child_exe: parts.child_exe,
        sample_rate: parts.sample_rate,
        stats: parts.stats,
        engaged: parts.engaged,
        cleanup_shm_on_drop: true,
    })));
    let teardown = crate::outproc_effect::OutProcTeardownGuard::new(
        crate::outproc_effect::OutProcTeardownParts {
            requested: parts.quiesce_requested,
            done: parts.quiesce_done,
            shutdown,
        },
    );
    InstalledEffectSlot {
        entry,
        child_slot,
        teardown,
    }
}

#[cfg(feature = "outproc-effect")]
struct EffectReplacementReservation<'a> {
    engine: &'a EngineWrap,
    target: Option<String>,
    in_flight: bool,
}

#[cfg(feature = "outproc-effect")]
impl<'a> EffectReplacementReservation<'a> {
    fn new(engine: &'a EngineWrap, target: Option<String>) -> Self {
        Self {
            engine,
            target,
            in_flight: false,
        }
    }

    fn mark_in_flight(&mut self) {
        self.in_flight = true;
    }
}

#[cfg(feature = "outproc-effect")]
impl Drop for EffectReplacementReservation<'_> {
    fn drop(&mut self) {
        if !self.in_flight {
            return;
        }
        let mut guard = match self.engine.outproc.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!(
                    bus = ?self.target,
                    "effect control poisoned while releasing replacement reservation"
                );
                poisoned.into_inner()
            }
        };
        let Some(control) = guard.as_mut() else {
            tracing::error!(
                bus = ?self.target,
                "effect control missing while releasing replacement reservation"
            );
            return;
        };
        control.replacements_in_flight.remove(&self.target);
    }
}

#[cfg(feature = "outproc-effect")]
type ResolvedOutProcEffectSlot = (
    Arc<Mutex<ChildSlot<EffectRole>>>,
    EffectSlotEntry,
    Arc<crate::outproc_effect::OutProcEffectStats>,
);

#[cfg(feature = "outproc-effect")]
fn resolve_outproc_effect_slot(
    control: &OutProcControl,
    bus: &Option<String>,
) -> Result<ResolvedOutProcEffectSlot, WrapError> {
    if control.replacements_in_flight.contains(bus) {
        return Err(WrapError::OutProcEffect(format!(
            "effect replacement already in progress for {}",
            effect_slot_label(bus)
        )));
    }

    let (weak_slot, entry, stats) = match bus.as_ref() {
        Some(name) => (
            control.bus_slots.get(name).ok_or_else(|| {
                WrapError::OutProcEffect(format!(
                    "unknown effect bus '{name}' (configured by ORBIT_EFFECT_BUSES)"
                ))
            })?,
            control.bus_entries.get(name).cloned().ok_or_else(|| {
                WrapError::OutProcEffect(format!("effect bus '{name}' is missing its slot entry"))
            })?,
            control.bus_stats.get(name).cloned().ok_or_else(|| {
                WrapError::OutProcEffect(format!("effect bus '{name}' is missing its stats entry"))
            })?,
        ),
        None => (
            &control.child_slot,
            control.master_entry.clone(),
            control.stats.clone(),
        ),
    };
    if entry.shutdown.load(Ordering::Acquire) {
        return Err(WrapError::OutProcEffect("engine is stopping".into()));
    }
    let child_slot = weak_slot
        .upgrade()
        .ok_or_else(|| WrapError::OutProcEffect("outproc effect stream is closed".into()))?;
    Ok((child_slot, entry, stats))
}

#[cfg(all(test, feature = "outproc-effect"))]
fn test_effect_slot_entry() -> EffectSlotEntry {
    EffectSlotEntry {
        shm_path: PathBuf::from("unused-effect-slot.shm"),
        child_exe: PathBuf::from("unused-effect-child"),
        sample_rate: 48_000,
        engaged: Arc::new(AtomicBool::new(false)),
        quiesce_requested: Arc::new(AtomicBool::new(false)),
        quiesce_done: Arc::new(AtomicBool::new(false)),
        shutdown: Arc::new(AtomicBool::new(false)),
        chain: Arc::new(Mutex::new(Vec::new())),
    }
}

/// `ORBIT_EFFECT_BUSES` の値を解析する純関数。カンマ区切りの bus 名を trim・空要素除去した上で、
/// 重複や NUL 文字を含む名前を拒否する。env 直読みを避けることで unit テスト可能にする
/// （`PluginFormat::from_env_value` / `parse_buffer_frames` と同じ「値渡し純関数 + env 読みラッパー」
/// の慣習に合わせる）。
#[cfg(feature = "outproc-effect")]
fn parse_effect_buses(raw: &str) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    raw.split(',')
        .filter_map(|s| {
            let s = s.trim();
            (!s.is_empty()).then(|| s.to_owned())
        })
        .map(|bus| {
            if bus.contains('\0') || !seen.insert(bus.clone()) {
                Err(format!(
                    "ORBIT_EFFECT_BUSES contains duplicate or invalid bus '{bus}'"
                ))
            } else {
                Ok(bus)
            }
        })
        .collect()
}

/// 既定 insert bus プールの名前 prefix。DSL 側（TS）の per-sequence effect manager が
/// 同じ規則（`seq-bus-<n>`）で bus 名を組み立てて `LoadPlugin.bus` / `PlayAt.bus` に
/// 送るため、prefix を変える場合は TS 側の定数も合わせて更新すること（#434 S3）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_EFFECT_BUS_POOL_PREFIX: &str = "seq-bus-";

/// `ORBIT_EFFECT_BUS_POOL` の既定サイズ（未設定時）。PH.2b の v1 上限（同時 insert 8 seq）と一致。
#[cfg(feature = "outproc-effect")]
const DEFAULT_EFFECT_BUS_POOL_SIZE: usize = 8;

/// 既定プール名 `seq-bus-0..N` を生成する純関数。`ORBIT_EFFECT_BUSES`（明示名）が指定されて
/// いない場合のみ呼ばれる。`pool_size` は `ORBIT_EFFECT_BUS_POOL` の解析結果（既定 8・0 で無効）。
#[cfg(feature = "outproc-effect")]
fn default_effect_bus_pool(pool_size: usize) -> Vec<String> {
    (0..pool_size)
        .map(|n| format!("{DEFAULT_EFFECT_BUS_POOL_PREFIX}{n}"))
        .collect()
}

/// `ORBIT_EFFECT_BUS_POOL` を解析する純関数。空 / 未設定は既定値（8）。`"0"` はプール無効
/// （明示的な `ORBIT_EFFECT_BUSES` のみ使う後方互換モード）。非数値・負値は起動時エラー。
#[cfg(feature = "outproc-effect")]
fn parse_effect_bus_pool_size(raw: &str) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_EFFECT_BUS_POOL_SIZE);
    }
    trimmed
        .parse::<usize>()
        .map_err(|_| format!("ORBIT_EFFECT_BUS_POOL must be a non-negative integer, got '{raw}'"))
}

/// bus 名の解決: `ORBIT_EFFECT_BUSES`（明示名・非空）が設定されていればそれを使う（既存 S2 挙動を
/// 保つ）。未設定なら `ORBIT_EFFECT_BUS_POOL`（既定 8・`"0"` で無効）に従って `seq-bus-<n>` の
/// 既定プールを生成する。両方指定は `ORBIT_EFFECT_BUSES` を優先（明示指定が常に勝つ）。
#[cfg(feature = "outproc-effect")]
fn effect_buses_from_env() -> Result<Vec<String>, WrapError> {
    let explicit = std::env::var("ORBIT_EFFECT_BUSES").unwrap_or_default();
    if !explicit.trim().is_empty() {
        return parse_effect_buses(&explicit).map_err(WrapError::OutProcEffect);
    }
    let pool_raw = std::env::var("ORBIT_EFFECT_BUS_POOL").unwrap_or_default();
    let pool_size = parse_effect_bus_pool_size(&pool_raw).map_err(WrapError::OutProcEffect)?;
    Ok(default_effect_bus_pool(pool_size))
}

/// bus のグラフ上の役割（#459/#453 M2）。`insert` = 既存の per-seq effect bus（PH.2b・#434）・
/// `sum` = 複数 insert の合流点（`seq.output(sum)`）・`aux` = post-fader send 先（`seq.send(aux, gain)`）。
/// 名前 prefix（`seq-bus-`/`sum-bus-`/`aux-bus-`）からも判別できるが、`SetBusRouting` の検証
/// （output は sum のみ・send 先は aux のみ許可・MX.4）を prefix 文字列比較に依存させないため、
/// 構築時に確定した値として明示的に持つ。
#[cfg(feature = "outproc-effect")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusKind {
    Insert,
    Sum,
    Aux,
}

/// `sum-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.output(sum)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_SUM_BUS_POOL_PREFIX: &str = "sum-bus-";
/// `aux-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.send(aux, gain)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_AUX_BUS_POOL_PREFIX: &str = "aux-bus-";
/// `ORBIT_SUM_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
const DEFAULT_SUM_BUS_POOL_SIZE: usize = 4;
/// `ORBIT_AUX_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
const DEFAULT_AUX_BUS_POOL_SIZE: usize = 4;

/// `ORBIT_SUM_BUS_POOL` / `ORBIT_AUX_BUS_POOL` に共通のプールサイズ解析（`parse_effect_bus_pool_size`
/// と同じ規則: 空 = 既定値・非数値/負値はエラー）。env 名をメッセージに含めるため呼び出し側が
/// 渡す（`ORBIT_EFFECT_BUS_POOL` 用の既存関数と重複させない）。
#[cfg(feature = "outproc-effect")]
fn parse_named_bus_pool_size(env_name: &str, raw: &str, default: usize) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default);
    }
    trimmed
        .parse::<usize>()
        .map_err(|_| format!("{env_name} must be a non-negative integer, got '{raw}'"))
}

/// `ORBIT_SUM_BUS_POOL`（既定 4）から `sum-bus-0..N-1` の既定プール名を組み立てる。
#[cfg(feature = "outproc-effect")]
fn sum_bus_pool_from_env() -> Result<Vec<String>, WrapError> {
    named_bus_pool_from_env(
        "ORBIT_SUM_BUS_POOL",
        DEFAULT_SUM_BUS_POOL_SIZE,
        DEFAULT_SUM_BUS_POOL_PREFIX,
    )
}

/// `ORBIT_AUX_BUS_POOL`（既定 4）から `aux-bus-0..N-1` の既定プール名を組み立てる。
#[cfg(feature = "outproc-effect")]
fn aux_bus_pool_from_env() -> Result<Vec<String>, WrapError> {
    named_bus_pool_from_env(
        "ORBIT_AUX_BUS_POOL",
        DEFAULT_AUX_BUS_POOL_SIZE,
        DEFAULT_AUX_BUS_POOL_PREFIX,
    )
}

/// env 名 + 既定サイズ + prefix から `<prefix>0..N-1` の既定プール名を組み立てる共通体
/// （/simplify: sum/aux の同一実装を単一化・命名スキーム変更時のドリフト防止）。
#[cfg(feature = "outproc-effect")]
fn named_bus_pool_from_env(
    env_name: &str,
    default_size: usize,
    prefix: &str,
) -> Result<Vec<String>, WrapError> {
    let raw = std::env::var(env_name).unwrap_or_default();
    let n = parse_named_bus_pool_size(env_name, &raw, default_size)
        .map_err(WrapError::OutProcEffect)?;
    Ok((0..n).map(|i| format!("{prefix}{i}")).collect())
}

/// 1 本の named bus stage（insert/sum/aux 共通）を構成する部材（`build_effect_bus_stages` →
/// `install_effect_bus_slots` の間で運ぶ・#434 S2/S3・M2 で kind/routing を追加）。
/// effect-only / both の両起動経路で同一のライフサイクルを共有する。
#[cfg(feature = "outproc-effect")]
struct EffectBusBuild {
    name: String,
    kind: BusKind,
    shm_path: std::path::PathBuf,
    engaged: Arc<std::sync::atomic::AtomicBool>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    done: Arc<std::sync::atomic::AtomicBool>,
    stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// render 側 `InsertBusStage::active` と共有。LoadPlugin が bus を指名した時点で
    /// `true`（宣言 = activation → 以降 pass-through）。それまで callback は bus を
    /// render 対象に含めない = 既定プールのコストゼロ。
    active: Arc<std::sync::atomic::AtomicBool>,
    /// render 側 `InsertBusStage::routing_override` と共有（M2）。`SetBusRouting` が
    /// control 側からこの Arc を書き換えて実行時に output target を切替える。
    routing_override: Arc<AtomicUsize>,
    /// render 側 `InsertBusStage::send_gain_overrides` と共有（M2・index k = 「この stage の
    /// 絶対 index + 1 + k」への send gain）。`SetBusRouting` が該当 index の Arc を書き換える。
    send_gain_overrides: Vec<Arc<AtomicU32>>,
}

/// `ORBIT_EFFECT_BUSES`/`ORBIT_EFFECT_BUS_POOL`（insert）+ `ORBIT_SUM_BUS_POOL`（sum）+
/// `ORBIT_AUX_BUS_POOL`（aux）の bus 名から、render 側の `InsertBusStage` 群と daemon 側の部材
/// （`EffectBusBuild`）を構築する。**stage 配列の並びは `[insert…, sum…, aux…]` に固定**する
/// （MX.4: insert → sum/aux への forward-only 参照が常に構築可能になるよう、insert を先頭に
/// 置く）。stage は inactive で生まれ、LoadPlugin（`load_outproc_effect_plugin` の bus 指定）
/// で activate される。sum/aux stage も同じ `OutProcEffectPostProcessor` 機構（PH.2b）で
/// 自前の insert chain を持てる（M2 で明示解禁）。
#[cfg(feature = "outproc-effect")]
fn build_effect_bus_stages(
) -> Result<(Vec<orbit_audio_native::InsertBusStage>, Vec<EffectBusBuild>), WrapError> {
    use crate::outproc_effect::{
        OutProcEffectPostProcessor, OutProcEffectPostProcessorParts, OutProcEffectStats,
    };
    use std::sync::atomic::AtomicBool;

    let insert_names = effect_buses_from_env()?;
    let sum_names = sum_bus_pool_from_env()?;
    let aux_names = aux_bus_pool_from_env()?;
    let named: Vec<(String, BusKind)> = insert_names
        .into_iter()
        .map(|n| (n, BusKind::Insert))
        .chain(sum_names.into_iter().map(|n| (n, BusKind::Sum)))
        .chain(aux_names.into_iter().map(|n| (n, BusKind::Aux)))
        .collect();
    let total = named.len();
    if total > orbit_audio_native::MAX_INSERT_BUS_STAGES {
        return Err(WrapError::OutProcEffect(format!(
            "too many bus stages: {total} (insert+sum+aux, max {})",
            orbit_audio_native::MAX_INSERT_BUS_STAGES
        )));
    }

    let mut builds = Vec::with_capacity(total);
    let mut insert_buses = Vec::with_capacity(total);
    for (index, (name, kind)) in named.into_iter().enumerate() {
        let shm_path = crate::outproc_effect::unique_shm_path();
        let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(
            orbit_audio_sandbox::create_shared(&shm_path).map_err(|e| {
                WrapError::OutProcEffect(format!("create bus shm {shm_path:?}: {e}"))
            })?,
        );
        let engaged = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let routing_override = Arc::new(AtomicUsize::new(0));
        // この stage より後ろの全 stage 分の send gain スロットを構築時に確保する（v1 の設計判断:
        // `SetBusRouting` は既存スロットへの書き込みのみ・実行時に Vec を伸長しない）。
        let send_gain_overrides: Vec<Arc<AtomicU32>> = (0..(total - index - 1))
            .map(|_| Arc::new(AtomicU32::new(0)))
            .collect();
        insert_buses.push(
            orbit_audio_native::InsertBusStage::with_activation(
                name.clone(),
                Some(Box::new(OutProcEffectPostProcessor::new(
                    OutProcEffectPostProcessorParts {
                        host,
                        engaged: engaged.clone(),
                        teardown_requested: stop.clone(),
                        teardown_done: done.clone(),
                        stats: stats.clone(),
                    },
                ))),
                0,
                active.clone(),
            )
            .with_routing_overrides(routing_override.clone(), send_gain_overrides.clone()),
        );
        builds.push(EffectBusBuild {
            name,
            kind,
            shm_path,
            engaged,
            stop,
            done,
            stats,
            active,
            routing_override,
            send_gain_overrides,
        });
    }
    Ok((insert_buses, builds))
}

/// bus 部材を ChildSlot / 観測 map / routing map / StreamGuard 用 guard 群へ展開する（stream 起動後・
/// sample_rate 確定後に呼ぶ）。返り値: (bus_slots, bus_stats, bus_actives, bus_kinds, bus_index,
/// bus_routing, bus_sends, bus_entries, child_guards, teardowns)。
#[cfg(feature = "outproc-effect")]
#[allow(clippy::type_complexity)]
fn install_effect_bus_slots(
    builds: Vec<EffectBusBuild>,
    child_exe: &std::path::Path,
    sample_rate: u32,
) -> (
    HashMap<String, Weak<Mutex<ChildSlot>>>,
    HashMap<String, Arc<crate::outproc_effect::OutProcEffectStats>>,
    HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    HashMap<String, BusKind>,
    HashMap<String, usize>,
    HashMap<String, Arc<AtomicUsize>>,
    HashMap<String, Vec<Arc<AtomicU32>>>,
    HashMap<String, EffectSlotEntry>,
    Vec<Arc<Mutex<ChildSlot>>>,
    Vec<crate::outproc_effect::OutProcTeardownGuard>,
) {
    let mut bus_slots = HashMap::new();
    let mut bus_stats = HashMap::new();
    let mut bus_actives = HashMap::new();
    let mut bus_kinds = HashMap::new();
    let mut bus_index = HashMap::new();
    let mut bus_routing = HashMap::new();
    let mut bus_sends = HashMap::new();
    let mut bus_entries = HashMap::new();
    let mut child_guards = Vec::with_capacity(builds.len());
    let mut teardowns = Vec::with_capacity(builds.len());
    for (index, build) in builds.into_iter().enumerate() {
        let installed = install_effect_slot(EffectSlotInstallParts {
            shm_path: build.shm_path,
            child_exe: child_exe.to_path_buf(),
            sample_rate,
            stats: build.stats.clone(),
            engaged: build.engaged,
            quiesce_requested: build.stop,
            quiesce_done: build.done,
        });
        bus_slots.insert(build.name.clone(), Arc::downgrade(&installed.child_slot));
        bus_entries.insert(build.name.clone(), installed.entry);
        bus_stats.insert(build.name.clone(), build.stats);
        bus_actives.insert(build.name.clone(), build.active);
        bus_kinds.insert(build.name.clone(), build.kind);
        bus_index.insert(build.name.clone(), index);
        bus_routing.insert(build.name.clone(), build.routing_override);
        bus_sends.insert(build.name, build.send_gain_overrides);
        child_guards.push(installed.child_slot);
        teardowns.push(installed.teardown);
    }
    (
        bus_slots,
        bus_stats,
        bus_actives,
        bus_kinds,
        bus_index,
        bus_routing,
        bus_sends,
        bus_entries,
        child_guards,
        teardowns,
    )
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_slot_wiring_tests {
    use super::{
        install_effect_bus_slots, install_effect_slot, BusKind, ChildSlot, EffectBusBuild,
        EffectRole, EffectSlotEntry, EffectSlotInstallParts, InstalledEffectSlot,
    };
    use crate::outproc_effect::{
        OutProcEffectPostProcessor, OutProcEffectPostProcessorParts, OutProcEffectStats,
    };
    use orbit_audio_native::PostProcessor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const BUS: &str = "wiring-bus";

    struct WiringParts {
        shm_path: PathBuf,
        stats: Arc<OutProcEffectStats>,
        engaged: Arc<AtomicBool>,
        requested: Arc<AtomicBool>,
        done: Arc<AtomicBool>,
        processor: OutProcEffectPostProcessor,
    }

    fn wiring_parts() -> WiringParts {
        let shm_path = crate::outproc_effect::unique_shm_path();
        let mmap = orbit_audio_sandbox::create_shared(&shm_path).expect("create wiring shm");
        let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(mmap);
        let stats = OutProcEffectStats::new();
        let engaged = Arc::new(AtomicBool::new(true));
        let requested = Arc::new(AtomicBool::new(false));
        // Guard drop must not spend the teardown timeout in these pure wiring tests.
        let done = Arc::new(AtomicBool::new(true));
        let processor = OutProcEffectPostProcessor::new(OutProcEffectPostProcessorParts {
            host,
            engaged: engaged.clone(),
            teardown_requested: requested.clone(),
            teardown_done: done.clone(),
            stats: stats.clone(),
        });
        WiringParts {
            shm_path,
            stats,
            engaged,
            requested,
            done,
            processor,
        }
    }

    fn assert_entry_launch_and_render_share_engaged(
        entry: &EffectSlotEntry,
        child_slot: &Mutex<ChildSlot<EffectRole>>,
        render_engaged: &AtomicBool,
        mut processor: OutProcEffectPostProcessor,
        origin: &str,
    ) {
        entry.engaged.store(false, Ordering::Release);
        assert!(
            !render_engaged.load(Ordering::Acquire),
            "{origin}: entry disengage must reach the render-side gate"
        );
        let launch_engaged = {
            let slot = child_slot.lock().expect("lock wiring child slot");
            let ChildSlot::Empty(launch) = &*slot else {
                panic!("{origin}: fresh installed slot must be Empty");
            };
            assert!(
                !launch.engaged.load(Ordering::Acquire),
                "{origin}: entry disengage must reach ChildLaunch"
            );
            launch.engaged.clone()
        };

        let mut audio = vec![0.625_f32; 32];
        processor.process(&mut audio);
        assert!(
            audio.iter().all(|sample| *sample == 0.625),
            "{origin}: disengaged render path must remain dry"
        );

        // Attach completion writes through ChildLaunch. Both the replacement entry and the RT
        // post-processor must observe that same edge; otherwise an attached insert stays dry.
        launch_engaged.store(true, Ordering::Release);
        assert!(
            entry.engaged.load(Ordering::Acquire),
            "{origin}: ChildLaunch engage must reach the replacement entry"
        );
        assert!(
            render_engaged.load(Ordering::Acquire),
            "{origin}: ChildLaunch engage must reach the render-side gate"
        );
        let mut engaged_audio = vec![0.375_f32; 32];
        processor.process(&mut engaged_audio);
        assert!(
            engaged_audio.iter().all(|sample| *sample == 0.0),
            "{origin}: engaged render path must enter the host (first block primes silence)"
        );
    }

    fn install_master_fixture() -> (
        Arc<AtomicBool>,
        InstalledEffectSlot,
        OutProcEffectPostProcessor,
    ) {
        let parts = wiring_parts();
        let render_engaged = parts.engaged.clone();
        let processor = parts.processor;
        let installed = install_effect_slot(EffectSlotInstallParts {
            shm_path: parts.shm_path,
            child_exe: PathBuf::from("unused-master-effect-child"),
            sample_rate: 48_000,
            stats: parts.stats,
            engaged: parts.engaged,
            quiesce_requested: parts.requested,
            quiesce_done: parts.done,
        });
        (render_engaged, installed, processor)
    }

    fn install_bus_fixture() -> (
        Arc<AtomicBool>,
        InstalledEffectSlot,
        OutProcEffectPostProcessor,
    ) {
        let parts = wiring_parts();
        let render_engaged = parts.engaged.clone();
        let processor = parts.processor;
        let build = EffectBusBuild {
            name: BUS.to_owned(),
            kind: BusKind::Insert,
            shm_path: parts.shm_path,
            engaged: parts.engaged,
            stop: parts.requested,
            done: parts.done,
            stats: parts.stats,
            active: Arc::new(AtomicBool::new(true)),
            routing_override: Arc::new(AtomicUsize::new(0)),
            send_gain_overrides: Vec::<Arc<AtomicU32>>::new(),
        };
        let (_, _, _, _, _, _, _, mut entries, mut child_slots, mut teardowns) =
            install_effect_bus_slots(
                vec![build],
                PathBuf::from("unused-bus-effect-child").as_path(),
                48_000,
            );
        let installed = InstalledEffectSlot {
            entry: entries.remove(BUS).expect("bus entry"),
            child_slot: child_slots.pop().expect("bus child slot"),
            teardown: teardowns.pop().expect("bus teardown"),
        };
        (render_engaged, installed, processor)
    }

    #[test]
    fn bus_slot_shares_the_engaged_flag_across_entry_launch_and_render_stage() {
        let (render_engaged, installed, processor) = install_bus_fixture();
        assert_entry_launch_and_render_share_engaged(
            &installed.entry,
            &installed.child_slot,
            &render_engaged,
            processor,
            "bus pool",
        );
    }

    #[test]
    fn effect_only_master_slot_shares_the_engaged_flag_across_entry_launch_and_render_stage() {
        let (render_engaged, installed, processor) = install_master_fixture();
        assert_entry_launch_and_render_share_engaged(
            &installed.entry,
            &installed.child_slot,
            &render_engaged,
            processor,
            "effect-only master",
        );
    }

    #[test]
    fn combined_master_slot_shares_the_engaged_flag_across_entry_launch_and_render_stage() {
        let (render_engaged, installed, processor) = install_master_fixture();
        assert_entry_launch_and_render_share_engaged(
            &installed.entry,
            &installed.child_slot,
            &render_engaged,
            processor,
            "combined master",
        );
    }

    #[test]
    fn bus_teardown_guard_latches_the_entry_shutdown() {
        let (_, installed, _) = install_bus_fixture();
        let InstalledEffectSlot {
            entry,
            child_slot: _,
            teardown,
        } = installed;
        assert!(!entry.shutdown.load(Ordering::Acquire));
        drop(teardown);
        assert!(
            entry.shutdown.load(Ordering::Acquire),
            "bus guard drop must latch the entry observed by replacement"
        );
    }

    #[test]
    fn effect_only_master_teardown_guard_latches_the_entry_shutdown() {
        assert_master_teardown_guard_latches_entry_shutdown("effect-only master");
    }

    #[test]
    fn combined_master_teardown_guard_latches_the_entry_shutdown() {
        assert_master_teardown_guard_latches_entry_shutdown("combined master");
    }

    fn assert_master_teardown_guard_latches_entry_shutdown(origin: &str) {
        let (_, installed, _) = install_master_fixture();
        let InstalledEffectSlot {
            entry,
            child_slot: _,
            teardown,
        } = installed;
        assert!(!entry.shutdown.load(Ordering::Acquire), "{origin}");
        drop(teardown);
        assert!(
            entry.shutdown.load(Ordering::Acquire),
            "{origin}: guard drop must latch the entry observed by replacement"
        );
    }
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_buses_from_env_tests {
    use super::parse_effect_buses;

    #[test]
    fn empty_string_yields_no_buses() {
        assert_eq!(parse_effect_buses(""), Ok(Vec::new()));
    }

    #[test]
    fn whitespace_only_yields_no_buses() {
        assert_eq!(parse_effect_buses("   "), Ok(Vec::new()));
    }

    #[test]
    fn parses_comma_separated_names_and_trims_whitespace() {
        assert_eq!(
            parse_effect_buses(" fx1 ,fx2"),
            Ok(vec!["fx1".to_owned(), "fx2".to_owned()])
        );
    }

    #[test]
    fn skips_empty_elements_between_commas() {
        assert_eq!(
            parse_effect_buses("fx1,,fx2,"),
            Ok(vec!["fx1".to_owned(), "fx2".to_owned()])
        );
    }

    #[test]
    fn rejects_duplicate_bus_names() {
        let error = parse_effect_buses("fx1,fx1").expect_err("duplicate must be rejected");
        assert!(error.contains("duplicate"), "unexpected message: {error}");
    }

    #[test]
    fn rejects_nul_byte_in_bus_name() {
        let error =
            parse_effect_buses("fx1,fx\x002").expect_err("NUL byte in name must be rejected");
        assert!(error.contains("invalid"), "unexpected message: {error}");
    }
}

#[cfg(all(test, feature = "outproc-effect"))]
mod effect_bus_pool_tests {
    use super::{
        default_effect_bus_pool, parse_effect_bus_pool_size, DEFAULT_EFFECT_BUS_POOL_SIZE,
    };

    #[test]
    fn pool_size_defaults_to_eight_when_unset_or_blank() {
        assert_eq!(
            parse_effect_bus_pool_size(""),
            Ok(DEFAULT_EFFECT_BUS_POOL_SIZE)
        );
        assert_eq!(
            parse_effect_bus_pool_size("   "),
            Ok(DEFAULT_EFFECT_BUS_POOL_SIZE)
        );
    }

    #[test]
    fn pool_size_zero_disables_the_pool() {
        assert_eq!(parse_effect_bus_pool_size("0"), Ok(0));
        assert_eq!(default_effect_bus_pool(0), Vec::<String>::new());
    }

    #[test]
    fn pool_size_parses_explicit_count() {
        assert_eq!(parse_effect_bus_pool_size("3"), Ok(3));
    }

    #[test]
    fn pool_size_rejects_non_numeric_or_negative() {
        assert!(parse_effect_bus_pool_size("abc").is_err());
        assert!(parse_effect_bus_pool_size("-1").is_err());
    }

    #[test]
    fn default_pool_generates_seq_bus_names_in_order() {
        assert_eq!(
            default_effect_bus_pool(3),
            vec![
                "seq-bus-0".to_string(),
                "seq-bus-1".to_string(),
                "seq-bus-2".to_string(),
            ]
        );
    }
}

/// M2（#459/#453）: sum/aux プール名生成・`SetBusRouting` の検証規則の unit テスト。
#[cfg(all(test, feature = "outproc-effect"))]
mod named_bus_pool_tests {
    use super::{
        aux_bus_pool_from_env, parse_named_bus_pool_size, sum_bus_pool_from_env,
        DEFAULT_AUX_BUS_POOL_SIZE, DEFAULT_SUM_BUS_POOL_SIZE,
    };

    #[test]
    fn pool_size_defaults_when_unset_or_blank() {
        assert_eq!(
            parse_named_bus_pool_size("X", "", 4),
            Ok(DEFAULT_SUM_BUS_POOL_SIZE)
        );
        assert_eq!(parse_named_bus_pool_size("X", "  ", 4), Ok(4));
    }

    #[test]
    fn pool_size_rejects_non_numeric() {
        let error = parse_named_bus_pool_size("ORBIT_SUM_BUS_POOL", "abc", 4)
            .expect_err("non-numeric must be rejected");
        assert!(error.contains("ORBIT_SUM_BUS_POOL"), "{error}");
    }

    #[test]
    fn sum_pool_generates_default_four_names() {
        // env は他テストと並行するプロセス内 global mutable state なので、明示的に空文字へ戻す
        // （unset だと他テストの残留値を拾いうる・#434 系の既存慣習に合わせる）。
        std::env::set_var("ORBIT_SUM_BUS_POOL", "");
        let names = sum_bus_pool_from_env().expect("default sum pool");
        assert_eq!(names.len(), DEFAULT_SUM_BUS_POOL_SIZE);
        assert_eq!(names[0], "sum-bus-0");
        std::env::remove_var("ORBIT_SUM_BUS_POOL");
    }

    #[test]
    fn aux_pool_generates_default_four_names() {
        std::env::set_var("ORBIT_AUX_BUS_POOL", "");
        let names = aux_bus_pool_from_env().expect("default aux pool");
        assert_eq!(names.len(), DEFAULT_AUX_BUS_POOL_SIZE);
        assert_eq!(names[0], "aux-bus-0");
        std::env::remove_var("ORBIT_AUX_BUS_POOL");
    }
}

/// `EngineWrap::set_bus_routing` の検証規則を stub backend + 手組み `OutProcControl` で
/// 直接 exercise する unit テスト（M2・#459/#453）。real child は不要（bus_index/bus_kinds/
/// bus_routing/bus_sends だけを検証する経路のため）。
#[cfg(all(test, feature = "outproc-effect"))]
mod set_bus_routing_tests {
    use super::{AtomicU32, AtomicUsize, BusKind, EngineWrap, Ordering, OutProcControl, Weak};
    use crate::backend::StubBackend;
    use crate::outproc_effect::OutProcEffectStats;
    use orbit_audio_native::CallbackTimeStats;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;

    /// stage 配列 `[seq-bus-0 (Insert), sum-bus-0 (Sum), aux-bus-0 (Aux)]` を模した
    /// `OutProcControl` を注入する（native stage 自体は起動しない・routing 検証のみが対象）。
    pub(super) fn wrap_with_three_stage_topology() -> Arc<EngineWrap> {
        let (wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let mut bus_index = HashMap::new();
        bus_index.insert("seq-bus-0".to_owned(), 0usize);
        bus_index.insert("sum-bus-0".to_owned(), 1usize);
        bus_index.insert("aux-bus-0".to_owned(), 2usize);
        let mut bus_kinds = HashMap::new();
        bus_kinds.insert("seq-bus-0".to_owned(), BusKind::Insert);
        bus_kinds.insert("sum-bus-0".to_owned(), BusKind::Sum);
        bus_kinds.insert("aux-bus-0".to_owned(), BusKind::Aux);
        let mut bus_routing = HashMap::new();
        bus_routing.insert("seq-bus-0".to_owned(), Arc::new(AtomicUsize::new(0)));
        let mut bus_sends = HashMap::new();
        // seq-bus-0 (index 0) has 2 later stages (index 1, 2) => 2 send slots.
        bus_sends.insert(
            "seq-bus-0".to_owned(),
            vec![Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0))],
        );
        // sum-bus-0 (index 1) has 1 later stage (index 2) => 1 send slot.
        bus_sends.insert("sum-bus-0".to_owned(), vec![Arc::new(AtomicU32::new(0))]);
        *wrap.outproc.lock().expect("lock outproc for injection") = Some(OutProcControl {
            stats: OutProcEffectStats::new(),
            cb_stats: CallbackTimeStats::new(),
            child_slot: Weak::new(),
            master_entry: super::test_effect_slot_entry(),
            bus_slots: HashMap::new(),
            bus_entries: HashMap::new(),
            bus_stats: HashMap::new(),
            bus_actives: ["seq-bus-0", "sum-bus-0", "aux-bus-0"]
                .into_iter()
                .map(|name| {
                    (
                        name.to_owned(),
                        Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                })
                .collect(),
            bus_kinds,
            bus_index,
            bus_routing,
            bus_sends,
            replacements_in_flight: HashSet::new(),
        });
        wrap
    }

    #[test]
    fn output_to_sum_bus_stores_encoded_target_on_the_routing_atomic() {
        let wrap = wrap_with_three_stage_topology();
        wrap.set_bus_routing("seq-bus-0", Some("sum-bus-0"), &[])
            .expect("sum output must be accepted");
        let guard = wrap.outproc.lock().unwrap();
        let routing = guard
            .as_ref()
            .unwrap()
            .bus_routing
            .get("seq-bus-0")
            .unwrap();
        // encoding: n = target_index + 2 (see native InsertBusStage doc).
        assert_eq!(routing.load(Ordering::Relaxed), 1 + 2);
    }

    #[test]
    fn reserved_master_output_resets_the_routing_atomic() {
        let wrap = wrap_with_three_stage_topology();
        wrap.set_bus_routing("seq-bus-0", Some("sum-bus-0"), &[])
            .expect("sum output must be accepted");
        wrap.set_bus_routing("seq-bus-0", Some("master"), &[])
            .expect("reserved master output must be accepted");
        let guard = wrap.outproc.lock().unwrap();
        let routing = guard
            .as_ref()
            .unwrap()
            .bus_routing
            .get("seq-bus-0")
            .unwrap();
        assert_eq!(routing.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn output_to_insert_bus_is_rejected_kind_mismatch() {
        let wrap = wrap_with_three_stage_topology();
        let error = wrap
            .set_bus_routing("seq-bus-0", Some("aux-bus-0"), &[])
            .expect_err("output to an aux bus must be rejected (output requires sum kind)");
        let message = format!("{error:?}");
        assert!(message.contains("must be a sum bus"), "{message}");
    }

    #[test]
    fn output_to_earlier_or_equal_index_is_rejected() {
        let wrap = wrap_with_three_stage_topology();
        let error = wrap
            .set_bus_routing("sum-bus-0", Some("seq-bus-0"), &[])
            .expect_err("backward reference must be rejected");
        let message = format!("{error:?}");
        assert!(message.contains("later stage"), "{message}");
    }

    #[test]
    fn send_to_aux_bus_stores_gain_bits_on_the_correct_slot() {
        let wrap = wrap_with_three_stage_topology();
        wrap.set_bus_routing("seq-bus-0", None, &[("aux-bus-0".to_owned(), 0.75)])
            .expect("send to an aux bus must be accepted");
        let guard = wrap.outproc.lock().unwrap();
        let sends = guard.as_ref().unwrap().bus_sends.get("seq-bus-0").unwrap();
        // aux-bus-0 is at absolute index 2; seq-bus-0 is at index 0 => slot k = 2 - 0 - 1 = 1.
        let gain = f32::from_bits(sends[1].load(Ordering::Relaxed));
        assert_eq!(gain, 0.75);
        // The untouched slot (sum-bus-0, k=0) must remain disabled.
        assert_eq!(f32::from_bits(sends[0].load(Ordering::Relaxed)), 0.0);
    }

    /// #587: E2E（PR #585）が使う **sum バス発の send**（`sum.aux(amount)` 相当）の slot 書込みを
    /// pin する。`set_bus_routing` は source 非依存（k = target_index − seq_index − 1）だが、
    /// 従来この式を pin していたのは seq-bus 発のみで、sum 発は #587 診断まで未検証だった。
    #[test]
    fn send_from_sum_bus_stores_gain_bits_on_the_correct_slot() {
        let wrap = wrap_with_three_stage_topology();
        wrap.set_bus_routing("sum-bus-0", None, &[("aux-bus-0".to_owned(), 1.0)])
            .expect("sum-source send to an aux bus must be accepted");
        let guard = wrap.outproc.lock().unwrap();
        let sends = guard.as_ref().unwrap().bus_sends.get("sum-bus-0").unwrap();
        // aux-bus-0 is at absolute index 2; sum-bus-0 is at index 1 => slot k = 2 - 1 - 1 = 0.
        assert_eq!(f32::from_bits(sends[0].load(Ordering::Relaxed)), 1.0);
        // The seq-bus-0 slots must remain untouched (no cross-source bleed).
        let seq_sends = guard.as_ref().unwrap().bus_sends.get("seq-bus-0").unwrap();
        assert_eq!(f32::from_bits(seq_sends[0].load(Ordering::Relaxed)), 0.0);
        assert_eq!(f32::from_bits(seq_sends[1].load(Ordering::Relaxed)), 0.0);
    }

    #[test]
    fn send_to_sum_bus_is_rejected_kind_mismatch() {
        let wrap = wrap_with_three_stage_topology();
        let error = wrap
            .set_bus_routing("seq-bus-0", None, &[("sum-bus-0".to_owned(), 0.5)])
            .expect_err("send to a sum bus must be rejected (send requires aux kind)");
        let message = format!("{error:?}");
        assert!(message.contains("must be an aux bus"), "{message}");
    }

    #[test]
    fn non_finite_gain_is_rejected() {
        let wrap = wrap_with_three_stage_topology();
        let error = wrap
            .set_bus_routing("seq-bus-0", None, &[("aux-bus-0".to_owned(), f32::NAN)])
            .expect_err("NaN gain must be rejected");
        let message = format!("{error:?}");
        assert!(message.contains("finite"), "{message}");
    }

    #[test]
    fn unknown_bus_name_is_rejected() {
        let wrap = wrap_with_three_stage_topology();
        let error = wrap
            .set_bus_routing("nope", None, &[])
            .expect_err("unknown seq_bus must be rejected");
        let message = format!("{error:?}");
        assert!(message.contains("unknown bus"), "{message}");
    }

    /// M3（#459/#453）: `SetBusRouting` は参照された bus（seq_bus 自身・output 先・send 先）を
    /// activation する（`LoadPlugin` 未実行の pass-through bus でも routing が render 対象になる）。
    #[test]
    fn set_bus_routing_activates_seq_bus_and_referenced_targets() {
        let wrap = wrap_with_three_stage_topology();
        let seq_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sum_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let aux_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut guard = wrap.outproc.lock().unwrap();
            let control = guard.as_mut().unwrap();
            control
                .bus_actives
                .insert("seq-bus-0".to_owned(), seq_active.clone());
            control
                .bus_actives
                .insert("sum-bus-0".to_owned(), sum_active.clone());
            control
                .bus_actives
                .insert("aux-bus-0".to_owned(), aux_active.clone());
        }

        wrap.set_bus_routing(
            "seq-bus-0",
            Some("sum-bus-0"),
            &[("aux-bus-0".to_owned(), 0.5)],
        )
        .expect("routing with output + send must be accepted");

        assert!(seq_active.load(Ordering::Acquire), "seq_bus must activate");
        assert!(
            sum_active.load(Ordering::Acquire),
            "output target must activate"
        );
        assert!(
            aux_active.load(Ordering::Acquire),
            "send target must activate"
        );
    }
}

#[cfg(all(test, feature = "outproc-effect", feature = "outproc-instrument"))]
mod set_source_routing_tests {
    use super::{test_instrument_control, EngineWrap, InstrumentSlotEntry};
    use orbit_audio_native::{SourceDest, SourceDestCell, MAX_SOURCE_UNITS};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Weak};

    const SOURCE: &str = "opaque:source/key";

    fn wrap_with_source() -> (Arc<EngineWrap>, Vec<SourceDestCell>) {
        let wrap = super::set_bus_routing_tests::wrap_with_three_stage_topology();
        let source_dests = super::default_source_dests();
        let (event_tx, _event_rx) = rtrb::RingBuffer::new(4);
        *wrap
            .outproc_instrument
            .lock()
            .expect("lock instrument control") = Some(test_instrument_control(
            vec![InstrumentSlotEntry {
                event_tx,
                stats: crate::outproc_instrument::OutProcInstrumentStats::new(),
                shm_path: PathBuf::from("/tmp/unused-source-routing.shm"),
                child_exe: PathBuf::from("unused-instrument-child"),
                sample_rate: 48_000,
                engaged: Arc::new(AtomicBool::new(false)),
                drain_requested: Arc::new(AtomicBool::new(false)),
                drain_done: Arc::new(AtomicBool::new(false)),
                source_dests: source_dests.clone(),
                child_slot: Weak::new(),
            }],
            HashMap::from([(SOURCE.to_owned(), 0)]),
            1,
        ));
        (wrap, source_dests)
    }

    #[test]
    fn insert_target_activates_bus_and_stores_the_absolute_bus_index() {
        let (wrap, source_dests) = wrap_with_source();

        wrap.set_source_routing(SOURCE, 3, Some("seq-bus-0"))
            .expect("insert target must be accepted");

        assert_eq!(source_dests[3].load(), SourceDest::Bus(0));
        let control = wrap.outproc.lock().expect("lock effect control");
        assert!(
            control.as_ref().expect("effect control").bus_actives["seq-bus-0"]
                .load(Ordering::Acquire),
            "referenced insert bus must be activated"
        );
    }

    #[test]
    fn null_target_routes_the_selected_unit_back_to_master() {
        let (wrap, source_dests) = wrap_with_source();
        source_dests[2].store(SourceDest::Bus(0));

        wrap.set_source_routing(SOURCE, 2, None)
            .expect("null target must select Master");

        assert_eq!(source_dests[2].load(), SourceDest::Master);
    }

    #[test]
    fn unknown_source_is_rejected_as_an_exact_opaque_key() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing("source/key", 0, None)
            .expect_err("partial source match must be rejected");

        assert!(format!("{error:?}").contains("unknown source"));
        assert_eq!(source_dests[0].load(), SourceDest::Master);
    }

    #[test]
    fn unit_outside_the_preallocated_range_is_rejected() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing(
                SOURCE,
                u32::try_from(MAX_SOURCE_UNITS).expect("unit capacity fits u32"),
                None,
            )
            .expect_err("out-of-range unit must be rejected");

        assert!(format!("{error:?}").contains("unit"));
        assert!(source_dests
            .iter()
            .all(|cell| cell.load() == SourceDest::Master));
    }

    #[test]
    fn unknown_target_bus_is_rejected_without_changing_the_destination() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing(SOURCE, 0, Some("not-a-bus"))
            .expect_err("unknown target bus must be rejected");

        assert!(format!("{error:?}").contains("unknown bus"));
        assert_eq!(source_dests[0].load(), SourceDest::Master);
    }

    #[test]
    fn sum_and_aux_targets_are_rejected_because_only_insert_is_valid() {
        let (wrap, source_dests) = wrap_with_source();

        for target in ["sum-bus-0", "aux-bus-0"] {
            let error = wrap
                .set_source_routing(SOURCE, 0, Some(target))
                .expect_err("non-insert target must be rejected");
            assert!(format!("{error:?}").contains("must be an insert bus"));
        }
        assert_eq!(source_dests[0].load(), SourceDest::Master);
    }
}

#[cfg(feature = "outproc-instrument")]
struct OutProcInstrumentControl {
    /// #540 P1: 起動時に事前確保した instrument slot 群（index = slot 番号）。audio graph /
    /// shm / note ring は stream 起動時に固定で焼かれるため、複数 instrument は N slot の
    /// 事前確保 + `LoadPlugin` の instance 割当で実現する（effect の per-bus slot と同方式）。
    slots: Vec<InstrumentSlotEntry>,
    /// instance ID → slot index。respawn 中は安定し、差し替え commit でのみ意図的に張り替える。
    instance_index: HashMap<String, usize>,
    /// teardown と drain ack が完了し、別 tenant に安全に再利用できる slot。
    free_slots: Vec<usize>,
    /// 起動時 pool のうち、一度も割り当て・prepare 予約されていない次の index。
    next_unassigned: usize,
    /// instance ごとの replace 排他。READY 待ちと teardown は control mutex 外で行う。
    replacements_in_flight: HashSet<String>,
}

#[cfg(feature = "outproc-instrument")]
impl OutProcInstrumentControl {
    fn allocate_slot(&mut self) -> Option<usize> {
        self.free_slots.pop().or_else(|| {
            if self.next_unassigned < self.slots.len() {
                let index = self.next_unassigned;
                self.next_unassigned += 1;
                Some(index)
            } else {
                None
            }
        })
    }

    fn free_slot(&mut self, index: usize) {
        if !self.free_slots.contains(&index) {
            self.free_slots.push(index);
        }
    }
}

#[cfg(all(test, feature = "outproc-instrument"))]
fn test_instrument_control(
    slots: Vec<InstrumentSlotEntry>,
    instance_index: HashMap<String, usize>,
    next_unassigned: usize,
) -> OutProcInstrumentControl {
    OutProcInstrumentControl {
        slots,
        instance_index,
        free_slots: Vec::new(),
        next_unassigned,
        replacements_in_flight: HashSet::new(),
    }
}

/// instance 引数の無い互換経路（旧単数 API・wire の `instance` 欠如）が写る instance 名。
///
/// 「= slot 0」が**強制**されるのは instrument-only build の互換経路
/// （`load_outproc_plugin` の `or_insert(0)`）のみ。both build では "default" も通常の
/// 先着順割当を通るため、名前付き instance が先行していれば slot 0 とは限らない
/// （slot は同質なので挙動差は無く、互換 accessor `outproc_instrument_stats()` =
/// slots\[0\] が別 instance の統計を返し得る、というテストハーネス表面のみ —
/// #542 レビュー指摘）。
#[cfg(feature = "outproc-instrument")]
pub(crate) const DEFAULT_INSTRUMENT_INSTANCE: &str = "default";

/// stream 起動前に確保した instrument slot の中間部品（起動後に `ChildLaunch` へ組み上げる。
/// sample_rate が stream 起動後にしか確定しないため 2 段階になる）。
#[cfg(feature = "outproc-instrument")]
struct PendingInstrumentSlot {
    shm_path: PathBuf,
    cleanup: ShmCleanupGuard,
    event_tx: rtrb::Producer<orbit_audio_sandbox::NeutralEvent>,
    stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    engaged: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    drain_requested: Arc<AtomicBool>,
    drain_done: Arc<AtomicBool>,
    source_dests: Vec<orbit_audio_native::SourceDestCell>,
}

/// instrument slot 1本分の control-side ハンドル（旧 `OutProcInstrumentControl` のフィールド群）。
#[cfg(feature = "outproc-instrument")]
struct InstrumentSlotEntry {
    /// Control threadで構築済みの NeutralEvent を audio thread へ渡す producer。
    event_tx: rtrb::Producer<orbit_audio_sandbox::NeutralEvent>,
    /// Audio adapter と watchdog が更新し、gated harness が読む観測 stats。
    stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    /// slot teardown 後に `ChildLaunch` を再構築するため stream 起動時から保持する値。
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    engaged: Arc<AtomicBool>,
    /// tenant 間で note ring を持ち越さないための RT drain-and-discard handshake。
    drain_requested: Arc<AtomicBool>,
    drain_done: Arc<AtomicBool>,
    source_dests: Vec<orbit_audio_native::SourceDestCell>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    child_slot: Weak<Mutex<ChildSlot<InstrumentRole>>>,
    #[cfg(not(all(feature = "outproc-effect", feature = "outproc-instrument")))]
    child_slot: Weak<Mutex<ChildSlot>>,
}

#[cfg(feature = "outproc-instrument")]
fn default_source_dests() -> Vec<orbit_audio_native::SourceDestCell> {
    (0..orbit_audio_native::MAX_SOURCE_UNITS)
        .map(|_| orbit_audio_native::SourceDestCell::default())
        .collect()
}

#[cfg(feature = "outproc-instrument")]
struct InstrumentSlotTeardownResources {
    index: usize,
    child_slot: Arc<Mutex<ChildSlot<InstrumentRole>>>,
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    stats: Arc<crate::outproc_instrument::OutProcInstrumentStats>,
    engaged: Arc<AtomicBool>,
    drain_requested: Arc<AtomicBool>,
    drain_done: Arc<AtomicBool>,
    source_dests: Vec<orbit_audio_native::SourceDestCell>,
}

#[cfg(feature = "outproc-instrument")]
impl InstrumentSlotTeardownResources {
    fn from_entry(
        index: usize,
        entry: &InstrumentSlotEntry,
        child_slot: Arc<Mutex<ChildSlot<InstrumentRole>>>,
    ) -> Self {
        Self {
            index,
            child_slot,
            shm_path: entry.shm_path.clone(),
            child_exe: entry.child_exe.clone(),
            sample_rate: entry.sample_rate,
            stats: entry.stats.clone(),
            engaged: entry.engaged.clone(),
            drain_requested: entry.drain_requested.clone(),
            drain_done: entry.drain_done.clone(),
            source_dests: entry.source_dests.clone(),
        }
    }
}

#[cfg(feature = "outproc-instrument")]
#[derive(Debug)]
enum InstrumentSlotTeardownFailure {
    ControlPoisoned,
    ControlMissing,
    SlotNotActive,
    DrainAckTimeout,
    ResetMapping(String),
    DrainAckTimeoutAndResetMapping(String),
}

#[cfg(feature = "outproc-instrument")]
impl std::fmt::Display for InstrumentSlotTeardownFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ControlPoisoned => formatter.write_str("instrument control poisoned"),
            Self::ControlMissing => formatter.write_str("instrument control missing"),
            Self::SlotNotActive => formatter.write_str("slot was not Active"),
            Self::DrainAckTimeout => formatter.write_str("event drain ack timed out"),
            Self::ResetMapping(error) => write!(formatter, "control reset mapping failed: {error}"),
            Self::DrainAckTimeoutAndResetMapping(error) => write!(
                formatter,
                "event drain ack timed out and control reset mapping failed: {error}"
            ),
        }
    }
}

#[cfg(feature = "outproc-instrument")]
struct InstrumentReplacementReservation<'a> {
    engine: &'a EngineWrap,
    instance: String,
    in_flight: bool,
    spare_index: Option<usize>,
    spare_resources: Option<InstrumentSlotTeardownResources>,
}

#[cfg(feature = "outproc-instrument")]
enum ReservedSpareState {
    Empty,
    Active,
    Loading,
    Closed,
}

#[cfg(feature = "outproc-instrument")]
impl<'a> InstrumentReplacementReservation<'a> {
    fn new(engine: &'a EngineWrap, instance: String) -> Self {
        Self {
            engine,
            instance,
            in_flight: false,
            spare_index: None,
            spare_resources: None,
        }
    }

    fn mark_in_flight(&mut self) {
        self.in_flight = true;
    }

    fn reserve_spare(&mut self, index: usize) {
        self.spare_index = Some(index);
    }

    fn attach_spare_resources(&mut self, resources: InstrumentSlotTeardownResources) {
        self.spare_resources = Some(resources);
    }

    fn commit_spare(&mut self) {
        self.spare_index = None;
        self.spare_resources = None;
    }
}

#[cfg(feature = "outproc-instrument")]
impl Drop for InstrumentReplacementReservation<'_> {
    fn drop(&mut self) {
        let reusable_spare = match self.spare_resources.take() {
            None => self.spare_index.is_some(),
            Some(resources) => {
                let state = {
                    let slot = lock_child_slot_recovering(
                        &resources.child_slot,
                        "replacement reservation rollback",
                    );
                    match &*slot {
                        ChildSlot::Empty(_) => ReservedSpareState::Empty,
                        ChildSlot::Active { .. } => ReservedSpareState::Active,
                        ChildSlot::Loading { .. } => ReservedSpareState::Loading,
                        ChildSlot::Closed => ReservedSpareState::Closed,
                    }
                };
                match state {
                    ReservedSpareState::Empty => true,
                    ReservedSpareState::Active => match self
                        .engine
                        .teardown_outproc_instrument_resources(&self.instance, resources)
                    {
                        Ok(()) => true,
                        Err(reason) => {
                            tracing::error!(
                                instance = %self.instance,
                                reason = %reason,
                                "uncommitted replacement spare teardown failed; slot quarantined from free-list"
                            );
                            false
                        }
                    },
                    ReservedSpareState::Loading => {
                        tracing::error!(
                            instance = %self.instance,
                            slot = resources.index,
                            "uncommitted replacement spare remained Loading; slot quarantined from free-list"
                        );
                        false
                    }
                    ReservedSpareState::Closed => {
                        tracing::error!(
                            instance = %self.instance,
                            slot = resources.index,
                            "uncommitted replacement spare became Closed; slot quarantined from free-list"
                        );
                        false
                    }
                }
            }
        };

        if !self.in_flight && self.spare_index.is_none() {
            return;
        }
        let mut guard = match self.engine.outproc_instrument.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!(
                    instance = %self.instance,
                    "instrument control poisoned while releasing replacement reservation"
                );
                poisoned.into_inner()
            }
        };
        let Some(control) = guard.as_mut() else {
            tracing::error!(
                instance = %self.instance,
                "instrument control missing while releasing replacement reservation"
            );
            return;
        };
        if reusable_spare {
            if let Some(index) = self.spare_index {
                control.free_slot(index);
            }
        }
        if self.in_flight {
            control.replacements_in_flight.remove(&self.instance);
        }
    }
}

/// #540 P1: N slot 分の shm / note ring / block source を確保する（stream 起動前・
/// both / instrument-only 両起動経路で共有 — effect 側の `install_effect_bus_slots` と同じ
/// 「抽出 helper を両 spawn 経路が呼ぶ」型）。
#[cfg(feature = "outproc-instrument")]
fn build_pending_instrument_slots(
    slot_count: usize,
) -> Result<
    (
        Vec<PendingInstrumentSlot>,
        Vec<orbit_audio_native::SourceSlot>,
    ),
    WrapError,
> {
    use crate::outproc_instrument::{
        OutProcInstrumentBlockSource, OutProcInstrumentStats, SlotSignals, NOTE_RING_CAPACITY,
    };
    use orbit_audio_native::{SourceSlot, MAX_SOURCE_SLOTS};
    const {
        assert!(
            crate::outproc_instrument::MAX_INSTRUMENT_SLOTS <= MAX_SOURCE_SLOTS,
            "daemon instrument capacity must fit native source capacity"
        );
    }
    assert!(
        slot_count <= MAX_SOURCE_SLOTS,
        "requested instrument slots must fit native source capacity"
    );
    let mut pending = Vec::with_capacity(slot_count);
    let mut sources = Vec::with_capacity(slot_count);
    for _ in 0..slot_count {
        let shm_path = crate::outproc_instrument::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path).map_err(|error| {
            WrapError::OutProcInstrument(format!("create shm {shm_path:?}: {error}"))
        })?;
        let cleanup = ShmCleanupGuard::new(shm_path.clone());
        let host = orbit_audio_sandbox::PipelinedInstrumentHost::from_mmap(host_mmap);
        let (event_tx, event_rx) = rtrb::RingBuffer::new(NOTE_RING_CAPACITY);
        let engaged = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let drain_requested = Arc::new(AtomicBool::new(false));
        let drain_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcInstrumentStats::new();
        let source_dests = default_source_dests();
        let source = OutProcInstrumentBlockSource::new(
            host,
            event_rx,
            NOTE_RING_CAPACITY,
            engaged.clone(),
            SlotSignals {
                teardown_requested: stop.clone(),
                teardown_done: done.clone(),
                drain_requested: drain_requested.clone(),
                drain_done: drain_done.clone(),
            },
            stats.clone(),
        );
        sources.push(SourceSlot {
            source: Box::new(source),
            dests: source_dests.clone(),
        });
        pending.push(PendingInstrumentSlot {
            shm_path,
            cleanup,
            event_tx,
            stats,
            engaged,
            stop,
            done,
            drain_requested,
            drain_done,
            source_dests,
        });
    }
    Ok((pending, sources))
}

/// `install_instrument_slots` の戻り値（entry / child guard / teardown guard の3列）。
#[cfg(feature = "outproc-instrument")]
type InstalledInstrumentSlots = (
    Vec<InstrumentSlotEntry>,
    Vec<Arc<Mutex<ChildSlot<InstrumentRole>>>>,
    Vec<crate::outproc_instrument::OutProcInstrumentTeardownGuard>,
);

/// #540 P1: pending slot を ChildLaunch / control entry / guard へ組み上げる
/// （sample_rate が stream 起動後にしか確定しないため build と2段階・両起動経路で共有）。
#[cfg(feature = "outproc-instrument")]
fn install_instrument_slots(
    pending_slots: Vec<PendingInstrumentSlot>,
    child_exe: &std::path::Path,
    sample_rate: u32,
) -> InstalledInstrumentSlots {
    let mut entries = Vec::with_capacity(pending_slots.len());
    let mut child_guards = Vec::with_capacity(pending_slots.len());
    let mut teardowns = Vec::with_capacity(pending_slots.len());
    for pending in pending_slots {
        let PendingInstrumentSlot {
            shm_path,
            mut cleanup,
            event_tx,
            stats,
            engaged,
            stop,
            done,
            drain_requested,
            drain_done,
            source_dests,
        } = pending;
        let child_slot = Arc::new(Mutex::new(ChildSlot::<InstrumentRole>::Empty(
            ChildLaunch {
                shm_path: shm_path.clone(),
                child_exe: child_exe.to_path_buf(),
                sample_rate,
                stats: stats.clone(),
                engaged: engaged.clone(),
                cleanup_shm_on_drop: true,
            },
        )));
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        cleanup.disarm();
        entries.push(InstrumentSlotEntry {
            event_tx,
            stats,
            shm_path,
            child_exe: child_exe.to_path_buf(),
            sample_rate,
            engaged,
            drain_requested,
            drain_done,
            source_dests,
            child_slot: Arc::downgrade(&child_slot),
        });
        child_guards.push(child_slot);
        teardowns.push(crate::outproc_instrument::OutProcInstrumentTeardownGuard::new(stop, done));
    }
    (entries, child_guards, teardowns)
}

/// Watchdog UI components are bundled so supervisor construction remains readable and both roles
/// receive the exact same pump/target/event-channel contract.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
#[derive(Clone)]
pub(crate) struct PluginUiWiring {
    pub(crate) pump: Arc<orbit_audio_sandbox::UiEventPump>,
    pub(crate) target: Arc<Mutex<PluginUiRouteRegistry>>,
    /// Rack-only current stage index -> immutable window token binding. Instrument children keep
    /// this as `None`; their one legacy UI continues to use the `None` pump/route key.
    pub(crate) index_binding: Option<Arc<Mutex<PluginUiIndexBinding>>>,
    pub(crate) events: tokio::sync::broadcast::Sender<PluginUiEvent>,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type PluginUiRouteRegistry = BTreeMap<orbit_audio_sandbox::UiWindowKey, PluginUiTarget>;

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type PluginUiIndexBinding = BTreeMap<u32, u64>;

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn remove_plugin_ui_binding(
    index_binding: &Option<Arc<Mutex<PluginUiIndexBinding>>>,
    index: u32,
    window: orbit_audio_sandbox::UiWindowKey,
) {
    let (Some(index_binding), Some(window)) = (index_binding, window) else {
        return;
    };
    let mut binding = match index_binding.lock() {
        Ok(binding) => binding,
        Err(poisoned) => poisoned.into_inner(),
    };
    if binding.get(&index) == Some(&window) {
        binding.remove(&index);
    }
}

/// Fixed watchdog sink. It never waits: target lookup uses `try_lock`, broadcast send is
/// synchronous/non-blocking, and no socket or engine callback is touched while the pump lock is
/// held. Target contention returns false so the ring head is retried; no target means there is no
/// correlated UI request and the event is consumed. A safepoint is accepted only when broadcast
/// delivery succeeds, while a completion is consumed after a loud delivery failure because it
/// reports an already-completed transition and its route has already been taken.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) fn enqueue_plugin_ui_notification(
    target: &Mutex<PluginUiRouteRegistry>,
    index_binding: Option<&Mutex<PluginUiIndexBinding>>,
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
    notification: orbit_audio_sandbox::UiPumpNotification,
) -> bool {
    let window = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint { window, .. }
        | orbit_audio_sandbox::UiPumpNotification::CloseDone { window, .. } => window,
    };
    let mut routes = match target.try_lock() {
        Ok(target) => target,
        Err(std::sync::TryLockError::WouldBlock) => return false,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    // CloseDone must retire the route and its mutable destination binding as one sink decision.
    // Acquire both with try_lock before mutating either so contention retries the same ring head.
    let mut binding = match index_binding {
        Some(binding) => match binding.try_lock() {
            Ok(binding) => Some(binding),
            Err(std::sync::TryLockError::WouldBlock) => return false,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        },
        None => None,
    };
    let target = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint { .. } => routes.get(&window).cloned(),
        orbit_audio_sandbox::UiPumpNotification::CloseDone { .. } => {
            if let Some(binding) = binding.as_mut() {
                binding.retain(|_, bound_window| Some(*bound_window) != window);
            }
            routes.remove(&window)
        }
    };
    drop(binding);
    drop(routes);
    let Some(target) = target else {
        tracing::warn!(
            ?window,
            "plugin UI notification has no correlated window route"
        );
        return true;
    };
    let (event, retry_if_undelivered) = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint {
            generation,
            evt_seq,
            ..
        } => (
            PluginUiEvent::Closed {
                target,
                generation,
                evt_seq,
            },
            true,
        ),
        orbit_audio_sandbox::UiPumpNotification::CloseDone { completion, .. } => {
            let completion = match completion {
                orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted => {
                    PluginUiCompletion::SafepointCompleted
                }
                orbit_audio_sandbox::UiCloseCompletion::TimedOutWithoutSave => {
                    PluginUiCompletion::TimedOutWithoutSave
                }
            };
            (PluginUiEvent::CloseDone { target, completion }, false)
        }
    };
    match events.send(event) {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(
                event = ?error.0,
                retrying = retry_if_undelivered,
                "plugin UI notification could not be delivered: no broadcast receivers"
            );
            !retry_if_undelivered
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) fn enqueue_plugin_ui_closed_by_respawn(
    target: &Mutex<PluginUiRouteRegistry>,
    index_binding: Option<&Mutex<PluginUiIndexBinding>>,
    closed_windows: &[orbit_audio_sandbox::UiWindowKey],
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
) {
    // reset_after_child_exit has already released the pump lock here. Wait for the short-lived
    // route coordinator lock instead of dropping the one-shot respawn event on contention.
    let routes = match target.lock() {
        Ok(mut target) => std::mem::take(&mut *target),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    };
    if let Some(index_binding) = index_binding {
        match index_binding.lock() {
            Ok(mut binding) => binding.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
    }
    let routed_windows = routes.keys().copied().collect::<Vec<_>>();
    if routed_windows != closed_windows {
        tracing::warn!(
            ?closed_windows,
            ?routed_windows,
            "plugin UI pump/routes disagreed while resetting after child exit"
        );
    }
    for (_, target) in routes {
        if let Err(error) = events.send(PluginUiEvent::ClosedByRespawn { target }) {
            tracing::warn!(
                event = ?error.0,
                "plugin UI respawn completion could not be delivered: no broadcast receivers"
            );
        }
    }
}

/// OOP role ごとの差分を child-slot state machine から分離する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) trait OutProcRole: Sized {
    /// `Send + Sync` は生産コード上も既に前提（watchdog スレッドが `Arc<Self::Stats>` を共有する）。
    /// ジェネリックなテストヘルパーが `Arc<Mutex<ChildSlot<R>>>` をスレッド間で受け渡す際、
    /// コンパイラにその前提を明示するために必要。
    type Stats: Send + Sync;
    type Supervisor: Send;
    const ROLE_NAME: &'static str;

    /// この role の child が **UI を index 付きで複数枚持てる**か（#633）。
    ///
    /// rack（effect）は 1 child に複数 stage を載せるので `index_binding` を持つ。instrument は
    /// いま 1 child 1 UI なので持たない。**呼び出し側で `ROLE_NAME` を文字列比較しない** —
    /// 綴りを間違えても型エラーにならず、instrument 側が静かに壊れる。マルチティンバー
    /// （#647）で instrument も複数枚になる時は、この const を 1 箇所 true にすれば済む。
    const SUPPORTS_INDEXED_UI: bool;

    /// `state` は保存済みプラグイン state ファイル。#562 以降は effect / instrument の
    /// 両 role が READY publish 前に適用する。
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child>;
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor>;
    fn detach_keep_shm(supervisor: Self::Supervisor);
    fn role_matches(child_flags: u32) -> bool;
    fn runtime_error(message: String) -> WrapError;
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool);
    /// 初回 attach 中の child exit の**事実と理由の対**。片方だけ動かせないよう1つの型に
    /// まとめてある（#629 レビュー）— 詳細は [`crate::outproc_child_exit::ChildEarlyExit`]。
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit;
    fn set_current_child_pid(stats: &Self::Stats, pid: u32);
    /// Attach する plugin のパスから、その format に対応する child を選び直す。
    ///
    /// **#552 以降、effect と instrument の両 role が per-plugin 解決を行う**（利用者に
    /// プラグイン形式を見せないため・CAP.6-1）。デフォルト名以外の child exe は明示指定と
    /// 見なして保持する。詳細は各 role の `child_exe_for_attach` doc を参照。
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String>;
    /// テスト専用: role ジェネリックなテストヘルパーが `Self::Stats` を構築するためのコンストラクタ。
    /// production コードはこれを呼ばない（`load_outproc_plugin_impl` 等は呼び出し側から渡された
    /// `ChildLaunch::stats` を使う）。
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats>;
    /// テスト専用: `current_child_pid` の生 atomic への参照。`role_mismatch_retries_same_slot` が
    /// spawn 完了の同期に使う（両 role の `Stats` に同名 `pub` field があるが、`Self::Stats` への
    /// ジェネリックコードからは field アクセスできないため trait 経由にする）。
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32;
}

#[cfg(feature = "outproc-effect")]
pub(crate) struct EffectRole;
#[cfg(feature = "outproc-instrument")]
pub(crate) struct InstrumentRole;
/// single-role ビルドの既定 role（both ビルドでは legacy API 用に effect を指す）。
/// 委譲 impl を複製せず type alias で本体 impl を継承する。
#[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
pub(crate) type DefaultOutProcRole = EffectRole;
#[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
pub(crate) type DefaultOutProcRole = InstrumentRole;
#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type DefaultOutProcRole = EffectRole;

#[cfg(feature = "outproc-effect")]
impl OutProcRole for EffectRole {
    type Stats = crate::outproc_effect::OutProcEffectStats;
    type Supervisor = crate::outproc_effect::EffectChildSupervisor;
    const ROLE_NAME: &'static str = "effect";
    /// rack は 1 child に複数 stage を載せるので、UI も index ごとに開ける。
    const SUPPORTS_INDEXED_UI: bool = true;
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child> {
        let chain = vec![crate::outproc_effect::ChainStageConfig::Catalog {
            path: path.to_path_buf(),
            plugin_id: plugin_id.map(str::to_owned),
            latest_state: state.map(PathBuf::from),
            enabled: true,
        }];
        let manifest = crate::outproc_effect::write_chain_manifest(&launch.shm_path, &chain)?;
        crate::outproc_effect::spawn_effect_child(
            &launch.child_exe,
            &launch.shm_path,
            &manifest,
            launch.sample_rate,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_effect::EffectChildSupervisor::spawn_with_mailbox(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
            latest_state,
            mailbox,
            ui,
        )
    }
    fn detach_keep_shm(supervisor: Self::Supervisor) {
        supervisor.detach_keep_shm();
    }
    fn role_matches(flags: u32) -> bool {
        flags & orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT != 0
    }
    fn runtime_error(message: String) -> WrapError {
        WrapError::OutProcEffect(message)
    }
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool) {
        stats.initial_attach_pending.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit {
        &stats.child_early_exit
    }
    fn set_current_child_pid(stats: &Self::Stats, pid: u32) {
        stats.current_child_pid.store(pid, Ordering::Relaxed);
    }
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String> {
        // #552: 拡張子ベースの読み替え（.vst3 → VST3 child・それ以外 → CLAP child）。
        // 明示指定された child exe（デフォルト名以外）は保持される。instrument 側と同一の規則で、
        // 詳細は `outproc_effect::child_exe_for_attach` の doc を参照。
        launch.child_exe = crate::outproc_effect::child_exe_for_attach(&launch.child_exe, path);
        tracing::debug!(
            ?path,
            child_exe = ?launch.child_exe,
            "effect child selected for attach"
        );
        Ok(())
    }
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats> {
        crate::outproc_effect::OutProcEffectStats::new()
    }
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32 {
        &stats.current_child_pid
    }
}

#[cfg(feature = "outproc-instrument")]
impl OutProcRole for InstrumentRole {
    type Stats = crate::outproc_instrument::OutProcInstrumentStats;
    type Supervisor = crate::outproc_instrument::InstrumentChildSupervisor;
    const ROLE_NAME: &'static str = "instrument";
    /// instrument はいま 1 child 1 UI。マルチティンバー（#647）で複数枚になったら true へ。
    const SUPPORTS_INDEXED_UI: bool = false;
    fn spawn_child(
        launch: &ChildLaunch<Self>,
        path: &std::path::Path,
        plugin_id: Option<&str>,
        state: Option<&std::path::Path>,
    ) -> std::io::Result<std::process::Child> {
        crate::outproc_instrument::spawn_instrument_child(
            &launch.child_exe,
            &launch.shm_path,
            path,
            plugin_id,
            launch.sample_rate,
            state,
        )
    }
    fn spawn_supervisor(
        child: std::process::Child,
        launch: &ChildLaunch<Self>,
        path: PathBuf,
        plugin_id: Option<String>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui: PluginUiWiring,
    ) -> std::io::Result<Self::Supervisor> {
        crate::outproc_instrument::InstrumentChildSupervisor::spawn_with_mailbox(
            child,
            launch.shm_path.clone(),
            launch.stats.clone(),
            launch.child_exe.clone(),
            path,
            plugin_id,
            launch.sample_rate,
            latest_state,
            mailbox,
            ui,
        )
    }
    fn detach_keep_shm(supervisor: Self::Supervisor) {
        supervisor.detach_keep_shm();
    }
    fn role_matches(flags: u32) -> bool {
        flags & orbit_audio_sandbox::transport::CHILD_FLAG_HAS_AUDIO_INPUT == 0
    }
    fn runtime_error(message: String) -> WrapError {
        WrapError::OutProcInstrument(message)
    }
    fn set_initial_attach_pending(stats: &Self::Stats, value: bool) {
        stats.initial_attach_pending.store(value, Ordering::Release);
    }
    fn child_early_exit(stats: &Self::Stats) -> &crate::outproc_child_exit::ChildEarlyExit {
        &stats.child_early_exit
    }
    fn set_current_child_pid(stats: &Self::Stats, pid: u32) {
        stats.current_child_pid.store(pid, Ordering::Relaxed);
    }
    fn select_child_exe(
        launch: &mut ChildLaunch<Self>,
        path: &std::path::Path,
    ) -> Result<(), String> {
        // 拡張子ベースの読み替え（.vst3 → VST3 child・それ以外 → CLAP child）。明示指定された
        // child exe（デフォルト名以外）は保持される。詳細は `child_exe_for_attach` の doc 参照。
        launch.child_exe = crate::outproc_instrument::child_exe_for_attach(&launch.child_exe, path);
        tracing::debug!(
            ?path,
            child_exe = ?launch.child_exe,
            "instrument child selected for attach"
        );
        Ok(())
    }
    #[cfg(test)]
    fn new_stats() -> Arc<Self::Stats> {
        crate::outproc_instrument::OutProcInstrumentStats::new()
    }
    #[cfg(test)]
    fn current_child_pid_atomic(stats: &Self::Stats) -> &std::sync::atomic::AtomicU32 {
        &stats.current_child_pid
    }
}

/// OOP child の post-boot attach 状態。v1 は一つの daemon role につき一つの plugin path 固定。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) enum ChildSlot<R: OutProcRole = DefaultOutProcRole> {
    Empty(ChildLaunch<R>),
    Loading {
        path: PathBuf,
    },
    Active {
        path: PathBuf,
        plugin_id: Option<String>,
        /// 保存済み state ファイル（#540 P2）。ロード identity の一部 — 同 path/plugin_id でも
        /// state が異なる再宣言は v1 では差し替え扱いで拒否する。
        state: Option<PathBuf>,
        /// supervisor が次の respawn で復元する最新 state。保存成功時に `state`（ロード
        /// identity）は変えず、この共有値だけを原子的に差し替える。
        latest_state: Arc<Mutex<Option<PathBuf>>>,
        engaged: Arc<AtomicBool>,
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        ui_pump: Arc<orbit_audio_sandbox::UiEventPump>,
        ui_target: Arc<Mutex<PluginUiRouteRegistry>>,
        ui_index_binding: Option<Arc<Mutex<PluginUiIndexBinding>>>,
        _supervisor: R::Supervisor,
    },
    Closed,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) struct ChildLaunch<R: OutProcRole = DefaultOutProcRole> {
    shm_path: PathBuf,
    child_exe: PathBuf,
    sample_rate: u32,
    stats: Arc<R::Stats>,
    engaged: Arc<AtomicBool>,
    cleanup_shm_on_drop: bool,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl<R: OutProcRole> Drop for ChildLaunch<R> {
    fn drop(&mut self) {
        // cleanup_shm_on_drop=true は retryable attach failure 後を含め、この launch が unlink の
        // 唯一の所有者であることを意味する。よって NotFound を含む
        // あらゆる失敗が異常であり、無条件で warn する。
        if self.cleanup_shm_on_drop {
            if let Err(error) = std::fs::remove_file(&self.shm_path) {
                tracing::warn!(
                    "ChildLaunch drop: shm 削除失敗 {:?}: {error}",
                    self.shm_path
                );
            }
        }
    }
}

/// stream 起動前に失敗した場合だけ shm を回収する暫定所有者。
/// `ChildLaunch` 構築後はそちらが unlink 所有者になるため、必ず disarm する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
struct ShmCleanupGuard {
    path: PathBuf,
    armed: bool,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl ShmCleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl Drop for ShmCleanupGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = std::fs::remove_file(&self.path) {
                tracing::warn!(
                    "ShmCleanupGuard drop: shm 削除失敗 {:?}: {error}",
                    self.path
                );
            }
        }
    }
}

/// child plugin load は通常 dlopen を含む。十分な上限を設け、応答を永久に保留しない。
///
/// **60s の根拠**（実測・2026-08-01・#605）。従来の 10s はサンプラー系で足りなかった:
///
/// | 内訳 | 実測 |
/// |---|---|
/// | Kontakt 8 の load（state 無し・release） | 3.1s |
/// | 同（1.33MB の component state 復元込み） | 4.3s |
/// | 初回 dylib 検証（Gatekeeper・plugin ごとに一度きり） | 最大 20s |
///
/// 計測は `orbit-vst3-host/tests/kontakt_state_gated.rs`。定常状態には 5s で足りるが、
/// **初回起動・コールドキャッシュ・大規模ライブラリ**が重なる最悪ケースを許容する。
/// この上限は「遅いプラグインを待つ」ためのもので、**ハングの検出には使わない**
/// （ハングは child 側の `ParentWatch` と watchdog が別途拾う）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
const CHILD_READY_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
const CHILD_READY_POLL: Duration = Duration::from_millis(10);
/// effect in-place 差し替え時に RT transport 離脱 ack を待つ上限と poll 間隔。
#[cfg(feature = "outproc-effect")]
const EFFECT_QUIESCE_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(feature = "outproc-effect")]
const EFFECT_QUIESCE_POLL: Duration = Duration::from_millis(2);
/// #618: tenant 差し替え時の note ring drain-and-discard ack 待ち上限。
/// timeout は再利用禁止へ degrade し、残渣入り slot を別 tenant へ渡さない。
#[cfg(feature = "outproc-instrument")]
const INSTRUMENT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(feature = "outproc-instrument")]
const INSTRUMENT_DRAIN_POLL: Duration = Duration::from_millis(2);

/// effect replacement が共有 quiesce flags を片付ける。stream 停止 latch が立っていれば
/// guard 所有の request を消さず、clear 直後に latch が立つ競合も再検査で復元する。
#[cfg(feature = "outproc-effect")]
fn clear_quiesce_unless_shutdown(entry: &EffectSlotEntry) {
    clear_quiesce_unless_shutdown_with(entry, || {});
}

#[cfg(feature = "outproc-effect")]
/// Clears the quiesce handshake **unless** the stream owner has latched shutdown.
///
/// 🔴 `SeqCst` on the shutdown load and the `quiesce_requested` clear is load-bearing, not
/// decoration (#625 audit B-1). This function and `OutProcTeardownGuard::latch_then_request`
/// form a store-buffering (Dekker) pair: each side stores its own flag and then loads the
/// other's. Under `Release`/`Acquire` alone, the re-check below is permitted to read a stale
/// `shutdown == false` even though the guard already stored `true` — coherence only forbids
/// reading a value *older* than one already read, and this thread read `false` a moment ago.
/// x86-TSO realises exactly this via the store buffer. The consequence is the failure the
/// latch exists to prevent: this thread clears the guard's `quiesce_requested`, never restores
/// it, the audio thread therefore never acks, and the stream owner stops without a real
/// quiesce. A single total order over these two accesses removes the interleaving.
///
/// The `SeqCst` stores are confined to these two control-thread code paths. The audio thread
/// reads the same `quiesce_requested` atomic with `Acquire` on every callback, but performs no
/// `SeqCst` operation; the `shutdown` atomic itself remains control-thread-only.
///
/// **This is not covered by a test.** Logical interleaving (the `after_clear` hook) cannot
/// reproduce a memory-ordering relaxation; only a model checker such as `loom` could.
fn clear_quiesce_unless_shutdown_with(entry: &EffectSlotEntry, after_clear: impl FnOnce()) {
    if !entry.shutdown.load(Ordering::SeqCst) {
        entry.quiesce_requested.store(false, Ordering::SeqCst);
        entry.quiesce_done.store(false, Ordering::Release);
        after_clear();
        if entry.shutdown.load(Ordering::SeqCst) {
            entry.quiesce_requested.store(true, Ordering::Release);
        }
    }
}

/// CLAP host の control-side ハンドル一式（feature `clap-host` 専用）。
#[cfg(feature = "clap-host")]
struct ClapControl {
    /// 専用スレッドへ `LoadPlugin` を送る Sender。
    cmd_tx: std::sync::mpsc::Sender<crate::clap_host::ClapCommand>,
    /// 単一 CLAP slot に正常ロード済みの plugin role。成功応答後だけ更新する。
    loaded_role: Option<ClapPluginRole>,
    /// audio thread（cpal callback の `ClapPostProcessor`）へ note を渡す event ring producer。
    event_tx: rtrb::Producer<orbit_clap_host::PluginEvent>,
    /// CLAP processor 統計（post-mix peak / process error 等）。daemon が読む。
    stats: Arc<orbit_clap_host::ClapProcessorStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で
    /// 測る）。daemon の RT 監視 / gated test の budget 検証が読む。
    cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
}

/// in-process CLAP host の単一 slot に紐付く plugin role。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClapPluginRole {
    Effect,
    Instrument,
}

/// CLAP plugin の activate に渡す最大フレーム数。daemon の cpal stream は可変 buffer（`None`）なので
/// device の実 buffer がこれを超えたら `HostAudioBuffers::ensure_buffer_size_matches` が resize する
/// （resize_count に計上）。典型的な device buffer（256〜2048）を十分上回る値を選び resize を実質
/// ゼロに保つ。
#[cfg(feature = "clap-host")]
const CLAP_MAX_FRAMES: u32 = 8192;

/// event ring への bounded retry の再試行間隔。
#[cfg(feature = "clap-host")]
const PLUGIN_EVENT_RETRY_INTERVAL: Duration = Duration::from_millis(1);
/// 最大再試行回数（≈200ms 上限）。event ring の consumer（audio callback）は毎 block ごとに
/// ring を全量 drain するため、通常は最初の数回で空きが生まれる。この上限は大きめの buffer
/// 構成（cpal callback 周期が長いケース）でも安全にカバーする余裕を持たせた値であり、
/// 「ここまで待っても空かない」を真の overflow とみなす閾値。
#[cfg(feature = "clap-host")]
const PLUGIN_EVENT_RETRY_MAX_ATTEMPTS: u32 = 200;

/// 1回の push 試行の結果。`Fatal` はリトライしても解決しない状態（mutex poisoned / clap 未初期化）
/// を表し、bounded retry ループを即座に打ち切る。
#[cfg(feature = "clap-host")]
enum PushAttemptOutcome<T> {
    Sent,
    Full(T),
    Fatal(WrapError),
}

/// `attempt` を bounded retry で呼び出す。producer は audio callback（RT スレッド）ではなく制御
/// スレッド（WS handler 等）からのみ呼ばれる前提 — consumer 側が毎 callback で ring を全量 drain
/// するので、最大 1 callback 周期待てば空きが保証される。この性質を利用し、満杯を「データ喪失」
/// でなく「一時的なリトライ待ち」として扱う（M2 doc `docs/development/POST_2.0_GAMMA_M2_DESIGN.md`
/// §4.4 の「溢れても失わない」方針を in-process ring に retrofit したもの・issue #400）。
///
/// **`attempt` は1回の試行につき1回だけ呼ばれ、mutex 等の lock 取得はその中で行い、`sleep` の
/// 前に解放されていること**（呼び出し側の責務）。retry の待機中に共有 lock を握り続けると、
/// 他の control-thread 操作（別セッションの LoadPlugin/PluginNoteOn 等）を最大
/// `max_attempts × retry_interval` だけ足止めしてしまう（`load_plugin` の「lock は send までで
/// 解放」規約と同じ理由・#402 レビュー指摘）。
///
/// 真に `max_attempts` 尽きた場合のみ `overflow_count` を進めてエラーを返す。
#[cfg(feature = "clap-host")]
fn push_with_bounded_retry<T>(
    mut attempt: impl FnMut(T) -> PushAttemptOutcome<T>,
    mut item: T,
    max_attempts: u32,
    retry_interval: Duration,
    overflow_count: &AtomicU64,
) -> Result<(), WrapError> {
    let attempts = max_attempts.max(1);
    for i in 0..attempts {
        match attempt(item) {
            PushAttemptOutcome::Sent => return Ok(()),
            PushAttemptOutcome::Fatal(e) => return Err(e),
            PushAttemptOutcome::Full(returned) => {
                item = returned;
                if i + 1 < attempts {
                    std::thread::sleep(retry_interval);
                }
            }
        }
    }
    overflow_count.fetch_add(1, Ordering::Relaxed);
    Err(WrapError::Clap(
        "plugin event ring full after bounded retry".into(),
    ))
}

// link-audio と clap-host の併用は現状未対応（1 つの cpal callback で LinkAudio per-channel egress と
// CLAP master-bus post-processor の render 順序を統合する設計が defer・Issue #340）。両方有効なビルドは
// 早期に弾く（`start()` の cfg 分岐も両者排他なので、これが無いと start() 未定義でわかりにくく落ちる）。
#[cfg(all(feature = "link-audio", feature = "clap-host"))]
compile_error!(
    "features `link-audio` and `clap-host` are mutually exclusive for now \
     (combined cpal-callback render ordering is deferred — Issue #340)"
);

// γ M1 PR-C: out-of-process effect も master-bus post-processor 経路（cpal callback への単一注入）
// なので、in-process CLAP（clap-host）/ LinkAudio egress（link-audio）とは併用不可。3-way 排他を
// compile-time に固定する（start() の cfg 分岐も 3 者排他前提なので、これが無いと未定義 start() で
// わかりにくく落ちる）。
#[cfg(all(feature = "outproc-effect", feature = "clap-host"))]
compile_error!(
    "features `outproc-effect` and `clap-host` are mutually exclusive \
     (both own the single master-bus post-processor seam)"
);
#[cfg(all(feature = "outproc-effect", feature = "link-audio"))]
compile_error!(
    "features `outproc-effect` and `link-audio` are mutually exclusive \
     (both integrate the single cpal callback)"
);
#[cfg(all(feature = "outproc-instrument", feature = "clap-host"))]
compile_error!(
    "features `outproc-instrument` and `clap-host` are mutually exclusive \
     (both own the single master-bus post-processor seam)"
);
#[cfg(all(feature = "outproc-instrument", feature = "link-audio"))]
compile_error!(
    "features `outproc-instrument` and `link-audio` are mutually exclusive \
     (both integrate the single cpal callback)"
);

/// `cpal::Stream` を保持する guard。drop されるとストリーム停止。`!Send`。
///
/// ## `link-audio` ビルド時（`_stream` → `_link`）
/// **この 2 フィールドの順は UB 安全だが意図的**（advisor #2）: `_stream` を先に drop して cpal
/// callback（ring の push 元）を止めてから `_link`（consumer thread を signal+join）を drop する。
/// rtrb はどちらの順でも UB にならない（逆順なら callback が undrained ring に push して drop
/// カウントするだけ）が、teardown 時の無駄な drop を避けるためこの順にしてある。reorder 禁止。
///
/// ## `clap-host` ビルド時（`_clap_teardown` → `_stream` → `_clap_thread`・carry-forward #1）
/// **この順は load-bearing**（UB 回避・上の link-audio とは性質が異なる）:
/// - `_clap_teardown` が先 = audio thread の callback で `stop_processing()` を済ませてから stream を
///   止める。逆順だと `StartedPluginAudioProcessor` が stream（callback）停止後に残り、wrong-thread
///   での暗黙 stop_processing/drop = CLAP 仕様違反（strict plugin で UB）。
/// - `_clap_thread` が後 = stream 停止後に専用スレッドを join し、instance の home thread で deactivate。
///
/// ## `outproc-effect` ビルド時（`_outproc_teardown` → `_stream` → `_child_guard`・γ M1 PR-C）
/// clap-host と同型の load-bearing 順:
/// - `_outproc_teardown` が先 = audio thread の adapter を quiesce（transport submit 停止）してから stream を止める。
/// - `_child_guard` が後 = stream 停止後に watchdog を止め child を QUIT/reap し shm を unlink する。
///
/// `outproc-instrument` も同じ teardown ordering を専用 guard/supervisor で維持する。
///
/// `clap-host` / `link-audio` は outproc family と引き続き `compile_error!` で排他である。一方
/// `outproc-effect` と `outproc-instrument` は both build で共存でき、その場合は両 child guard が
/// 同時に存在する。
pub struct StreamGuard {
    /// carry-forward #1（clap-host）: stream 停止 **前** に drop され、audio thread で `stop_processing`
    /// を済ませる（`ClapTeardownGuard::drop` が teardown_requested を立て teardown_done を待つ）。
    /// **field 順は load-bearing**: これは `_stream` より前に宣言する（Rust の field drop 順 = 宣言順）。
    #[cfg(feature = "clap-host")]
    _clap_teardown: crate::clap_host::ClapTeardownGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **前** に drop され、audio thread の adapter を quiesce
    /// させる（transport への submit を止めて dry 素通しに入る）。**field 順は load-bearing**: `_stream`
    /// より前に宣言する（clap-host とは feature 排他なので同時には存在しない）。
    #[cfg(feature = "outproc-effect")]
    _outproc_teardown: crate::outproc_effect::OutProcTeardownGuard,
    #[cfg(feature = "outproc-effect")]
    _outproc_bus_teardowns: Vec<crate::outproc_effect::OutProcTeardownGuard>,
    /// outproc-instrument: stream 前に audio-thread adapter を quiesce する（#540 P1 で
    /// slot pool 化に伴い Vec。guard 間に共有状態は無く順序は load-bearing ではない）。
    /// both build における `_outproc_teardown` との相対順序も load-bearing ではない
    /// （各 guard は自 role 専用の requested/done atomic のみを操作し共有状態がない。
    /// stream 停止後の child guard 2つと同じ独立性）。
    #[cfg(feature = "outproc-instrument")]
    _outproc_instrument_teardowns: Vec<crate::outproc_instrument::OutProcInstrumentTeardownGuard>,
    /// device switch（#484 D2）: `cpal::Stream`（`OutputStream` 内部）は `!Send` のため、`EngineWrap`
    /// （`Arc` 共有・tokio task を跨ぐため `Send + Sync` 必須）には一切保持させない。`StreamGuard` は
    /// 従来どおり単一の "audio owner thread"（`main.rs` が spawn する専用 OS thread）だけがローカル
    /// 変数として所有し続け、switch は `mpsc` 経由でその thread 上に処理を委譲する
    /// （[`EngineWrap::apply_device_switch`]）。**field 順は変わらず load-bearing**（従来の `_stream`
    /// と同じ位置）。
    stream: OutputStream,
    #[cfg(feature = "link-audio")]
    _link: Option<crate::link_audio::LinkAudioGuard>,
    /// clap-host: stream 停止 **後** に drop され、専用スレッドを停止 → `ClapHost::shutdown()` で
    /// instance を deactivate（instance の home thread）。**field 順は load-bearing**: `_stream` より
    /// 後に宣言する。
    #[cfg(feature = "clap-host")]
    _clap_thread: crate::clap_host::ClapThreadGuard,
    /// γ M1 PR-C（outproc-effect）: stream 停止 **後** に drop され、watchdog を止めて（respawn 停止）
    /// child へ QUIT → reap → shm unlink する。**field 順は load-bearing**: `_stream` より後に宣言する。
    #[cfg(feature = "outproc-effect")]
    _child_guard: Arc<Mutex<ChildSlot>>,
    #[cfg(feature = "outproc-effect")]
    _bus_child_guards: Vec<Arc<Mutex<ChildSlot>>>,
    /// both build では同種 guard 間の順序は load-bearing ではない（どちらも stream 停止後）。別々の
    /// child process / shm region を持ち supervisor 間に共有状態が無いため、独立に teardown できる。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    _instrument_child_guards: Vec<Arc<Mutex<ChildSlot<InstrumentRole>>>>,
    #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
    _child_guards: Vec<Arc<Mutex<ChildSlot>>>,
}

/// 現在の出力 stream から得た実効構成。device switch 成功時に一括で差し替える。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamConfigSnapshot {
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

impl StreamConfigSnapshot {
    fn from_output_stream(stream: &OutputStream) -> Self {
        Self {
            device_name: stream.device_name.clone(),
            sample_rate: stream.sample_rate,
            channels: stream.channels,
        }
    }
}

impl StreamGuard {
    /// capture seam（#307 realtime）: capture 有効時のみ producer-side drop 累積を返す（無効は `None`）。
    /// `Some(0)` は録音健全・`> 0` は録音破損（検証 invalid）。gated 検証ハーネスが teardown 前に
    /// assert する（`stream: OutputStream` へ委譲）。全 feature variant が `stream` を持つので共通。
    pub fn capture_drops(&self) -> Option<u64> {
        self.stream.capture_drops()
    }
}

/// device switch（#484 D2）: `EngineWrap::select_audio_device`（任意スレッド・`Send`）から
/// audio owner thread（`StreamGuard` を所有する専用 OS thread）へ送る要求。`reply` は
/// `std::sync::mpsc::Sender` なので、要求元は対応する `Receiver::recv()` で同期的に結果を待てる。
pub struct DeviceSwitchRequest {
    pub device: Option<String>,
    pub reply: std::sync::mpsc::Sender<Result<String, WrapError>>,
}

/// 生の env 値（`Some(raw)`）を capture 出力先 [`PathBuf`] へ解決する純関数（`capture_path_from_env`
/// の testable コア）。未設定 / 空 / 空白のみは `None`（capture 無効）。trim した値から `PathBuf` を
/// 組む（`"  /tmp/x.wav  "` のような前後空白を含む env でも正しいパスになる）。
fn resolve_capture_path(raw: Option<String>) -> Option<PathBuf> {
    let raw = raw?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// capture seam（#307）: 環境変数 `ORBIT_CAPTURE_WAV` を解決して whole-stream WAV 録音の出力先を
/// 返す（未設定 / 空文字列なら `None` = capture 無効）。**env 読取りは daemon 層に集約**し、解決済み
/// パスを `orbit-audio-native` の `start_default_output*` へ typed で渡す（`OutProcEffectConfig` /
/// `buffer_frames` と同じ層分け＝native の公開 API に隠れた ambient env 依存を作らない）。
fn capture_path_from_env() -> Option<PathBuf> {
    match std::env::var("ORBIT_CAPTURE_WAV") {
        Ok(raw) => resolve_capture_path(Some(raw)),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            // 非 UTF-8 の値を握り潰すと「capture したつもりが無効」になるので operator に報告する。
            // 🔴 #612: `eprintln!` は書き込み失敗で panic する。panic hook が `exit(1)` する
            // ようになった今、**この警告が書けないだけで daemon 全体が終了する**。
            crate::best_effort_stderr::write_line_best_effort(
                "[capture] ORBIT_CAPTURE_WAV が非 UTF-8 のため無視した（capture 無効）",
            );
            None
        }
    }
}

/// device 選択（#484 D1）: 環境変数 `ORBIT_AUDIO_DEVICE` を解決する。main.rs が `--audio-device`
/// CLI 引数をこの env に反映してから `EngineWrap::start()` を呼ぶ（`capture_path_from_env` と
/// 同じ層分け＝env 読取りは daemon 層に集約し、native へは解決済み値を渡す）。未設定 / 空文字列は
/// `None`（host 既定を使う・従来経路とビット同一）。
fn device_name_from_env() -> Option<String> {
    match std::env::var("ORBIT_AUDIO_DEVICE") {
        Ok(raw) if !raw.trim().is_empty() => Some(raw),
        Ok(_) => None,
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            // 🔴 #612: 上と同じ理由で best-effort（診断が書けないだけで daemon を殺さない）。
            crate::best_effort_stderr::write_line_best_effort(
                "[audio-device] ORBIT_AUDIO_DEVICE が非 UTF-8 のため無視した（host 既定へ縮退）",
            );
            None
        }
    }
}

impl EngineWrap {
    /// Engine とストリーム guard を起動する（本番用、cpal 既定出力）。
    /// guard は caller（通常は main）が drop されるまで保持すること。
    ///
    /// 本番経路は `cpal::Stream` が `!Send` のため [`Self::start_with`] の
    /// `Box<dyn Any + Send>` guard 型に詰められない。そのため本番は専用パス。
    #[cfg(all(
        not(feature = "link-audio"),
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats) = orbit_audio_native::start_default_output_with_device(
            capture_path_from_env(),
            device_name_from_env(),
        )?;
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        let guard = StreamGuard { stream };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            None,
            None,
        );
        Ok((wrap, guard))
    }

    /// feature `link-audio` 版: cpal 出力を LinkAudio egress 経路付きで起動し、GPL consumer thread を
    /// spawn する（A4-2b-2）。reg-ring producer は callback に組み込まれ、`register_link_audio_channel`
    /// 経由で channel を流す。返す `StreamGuard` が consumer thread の teardown guard を保持する。
    #[cfg(all(
        feature = "link-audio",
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats, reg_tx) =
            orbit_audio_native::start_default_output_with_link_egress(
                crate::link_audio::REG_RING_CAPACITY,
                capture_path_from_env(),
                device_name_from_env(),
            )?;
        let (control, link_guard) = crate::link_audio::LinkAudioControl::spawn(
            reg_tx,
            stream.sample_rate,
            stream.channels as usize,
        )
        .map_err(|e| WrapError::LinkAudio(e.to_string()))?;
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        *wrap
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))? = Some(control);
        let guard = StreamGuard {
            stream,
            _link: Some(link_guard),
        };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            None,
            None,
        );
        Ok((wrap, guard))
    }

    /// feature `clap-host` 版（Issue #340）: cpal 出力を CLAP master-bus post-processor 経路付きで
    /// 起動し、`orbit-clap-host` の `ClapHost`(!Send) を専用スレッドで動かす。`ClapPostProcessor`
    /// （`PostProcessor` 実装）を native callback に注入し、plugin の hot-install は install ring 経由で
    /// audio thread に渡す。返す `StreamGuard` が teardown guard（carry-forward #1）と専用スレッド
    /// guard を保持する（drop 順で stop_processing → stream 停止 → deactivate を強制）。
    #[cfg(all(
        feature = "clap-host",
        not(feature = "link-audio"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        // event ring 1024 / install ring 1（spike と同容量）。
        let (processor, parts) = orbit_clap_host::new_clap_host(1024, 1);
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_clap(
                processor,
                None,
                capture_path_from_env(),
                device_name_from_env(),
            )
            .map_err(WrapError::Output)?;
        // 専用スレッドを起動（!Send instance + pump をここで所有）。install ring producer を渡す。
        let (cmd_tx, thread_guard) = crate::clap_host::spawn_clap_thread(
            parts.callback_requested,
            parts.resize_count,
            parts.install_tx,
        );
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        *wrap
            .clap
            .lock()
            .map_err(|_| WrapError::Clap("clap mutex poisoned".into()))? = Some(ClapControl {
            cmd_tx,
            loaded_role: None,
            event_tx: parts.event_producer,
            stats: parts.stats,
            cb_stats: cb_stats.clone(),
        });
        let guard = StreamGuard {
            _clap_teardown: crate::clap_host::ClapTeardownGuard::new(
                parts.teardown_requested,
                parts.teardown_done,
            ),
            stream,
            _clap_thread: thread_guard,
        };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            None,
            Some(cb_stats),
        );
        Ok((wrap, guard))
    }

    /// feature `outproc-effect` 版（γ M1 PR-C・Issue #359）: cpal 出力を OOP effect master-bus
    /// post-processor 経路付きで起動する。production は環境変数から child 設定を組み、plugin は
    /// `LoadPlugin` で post-boot attach する。
    #[cfg(all(
        feature = "outproc-effect",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        Self::start_outproc_effect_post_boot(cfg)
    }

    /// 既存 gated harness 用の明示設定入口。従来どおり、返却前に設定済み plugin を attach する。
    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    pub fn start_outproc_effect(
        cfg: crate::outproc_effect::OutProcEffectConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let plugin = cfg
            .plugin
            .clone()
            .ok_or_else(|| WrapError::OutProcEffect("eager start requires a plugin path".into()))?;
        let plugin_id = cfg.plugin_id.clone();
        let (wrap, guard) = Self::start_outproc_effect_post_boot(cfg)?;
        wrap.load_outproc_plugin(plugin, plugin_id)?;
        Ok((wrap, guard))
    }

    /// production daemon の OOP effect 経路本体。
    /// shm → adapter → stream までを daemon boot 時に構築し、child supervisor は初回
    /// `LoadPlugin(role=effect)` まで遅延する。
    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    pub fn start_outproc_effect_post_boot(
        cfg: crate::outproc_effect::OutProcEffectConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            OutProcEffectPostProcessor, OutProcEffectPostProcessorParts, OutProcEffectStats,
        };
        use std::sync::atomic::AtomicBool;

        // Each registered bus owns a complete transport up front.  Attachment is the existing
        // lock-free `engaged` release-store（activation は LoadPlugin 時・`EffectBusBuild` doc 参照）。
        let (insert_buses, bus_builds) = build_effect_bus_stages()?;

        // 1. shm 作成 → host mmap（adapter が所有・audio thread）。
        let shm_path = crate::outproc_effect::unique_shm_path();
        let host_mmap = orbit_audio_sandbox::create_shared(&shm_path)
            .map_err(|e| WrapError::OutProcEffect(format!("create shm {shm_path:?}: {e}")))?;
        let mut shm_cleanup = ShmCleanupGuard::new(shm_path.clone());
        let host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(host_mmap);

        // 2. engaged ゲート + teardown flags + 観測 stats + adapter。
        let engaged = Arc::new(AtomicBool::new(false));
        let teardown_requested = Arc::new(AtomicBool::new(false));
        let teardown_done = Arc::new(AtomicBool::new(false));
        let stats = OutProcEffectStats::new();
        let processor = Box::new(OutProcEffectPostProcessor::new(
            OutProcEffectPostProcessorParts {
                host,
                engaged: engaged.clone(),
                teardown_requested: teardown_requested.clone(),
                teardown_done: teardown_done.clone(),
                stats: stats.clone(),
            },
        ));

        // 3. cpal stream 起動（ここで device の sample_rate が確定する）。adapter を注入する。
        //    gated stale-rate harness は cfg.buffer_frames に 32/64 を渡し小バッファを要求する。
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_insert_buses_and_post(
                insert_buses,
                processor,
                cfg.buffer_frames,
                capture_path_from_env(),
                device_name_from_env(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;
        let installed_master = install_effect_slot(EffectSlotInstallParts {
            shm_path,
            child_exe: cfg.child_exe.clone(),
            sample_rate,
            stats: stats.clone(),
            engaged,
            quiesce_requested: teardown_requested,
            quiesce_done: teardown_done,
        });
        let master_entry = installed_master.entry;
        let child_slot = installed_master.child_slot;
        let master_teardown = installed_master.teardown;
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        shm_cleanup.disarm();

        // 6. wrap 構築 + control 注入。
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        *wrap
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))? =
            Some(OutProcControl {
                stats,
                cb_stats: cb_stats.clone(),
                child_slot: Arc::downgrade(&child_slot),
                master_entry,
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

        let (
            bus_slots,
            bus_stats,
            bus_actives,
            bus_kinds,
            bus_index,
            bus_routing,
            bus_sends,
            bus_entries,
            bus_child_guards,
            bus_teardowns,
        ) = install_effect_bus_slots(bus_builds, &cfg.child_exe, sample_rate);
        {
            let mut guard = wrap
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().expect("outproc control installed");
            control.bus_slots = bus_slots;
            control.bus_entries = bus_entries;
            control.bus_stats = bus_stats;
            control.bus_actives = bus_actives;
            control.bus_kinds = bus_kinds;
            control.bus_index = bus_index;
            control.bus_routing = bus_routing;
            control.bus_sends = bus_sends;
        }

        // 7. StreamGuard（field 順 = teardown 順）。
        let guard = StreamGuard {
            _outproc_teardown: master_teardown,
            _outproc_bus_teardowns: bus_teardowns,
            stream,
            _child_guard: child_slot,
            _bus_child_guards: bus_child_guards,
        };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            cfg.buffer_frames,
            Some(cb_stats),
        );
        Ok((wrap, guard))
    }

    /// feature `outproc-instrument` production entry point. Configuration is fixed at daemon
    /// startup; live note events continue to use the existing PluginNoteOn/PluginNoteOff methods.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_instrument_post_boot(cfg)
    }

    /// Existing gated-harness entry point. Preserves its pre-existing eager attach behavior.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start_outproc_instrument(
        cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let plugin = cfg.plugin.clone().ok_or_else(|| {
            WrapError::OutProcInstrument("eager start requires a plugin path".into())
        })?;
        let plugin_id = cfg.plugin_id.clone();
        let (wrap, guard) = Self::start_outproc_instrument_post_boot(cfg)?;
        wrap.load_outproc_plugin(plugin, plugin_id)?;
        Ok((wrap, guard))
    }

    /// Production daemon path: build transport and stream now, attach child on first LoadPlugin.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start_outproc_instrument_post_boot(
        cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        // #540 P1: instrument slot pool（both build と同方式・instrument-only 版）。
        let (pending_instrument_slots, instrument_sources) =
            build_pending_instrument_slots(cfg.slots)?;

        let buffer_frames = cfg.buffer_frames;
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_sources(
                instrument_sources,
                buffer_frames,
                capture_path_from_env(),
                device_name_from_env(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;

        // #540 P1: pending slot を ChildLaunch へ組み上げる（sample_rate は stream 起動後に確定）。
        let (instrument_slot_entries, instrument_child_guards, instrument_teardowns) =
            install_instrument_slots(pending_instrument_slots, &cfg.child_exe, sample_rate);

        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        *wrap.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })? = Some(OutProcInstrumentControl {
            slots: instrument_slot_entries,
            instance_index: HashMap::new(),
            free_slots: Vec::new(),
            next_unassigned: 0,
            replacements_in_flight: HashSet::new(),
        });

        let guard = StreamGuard {
            _outproc_instrument_teardowns: instrument_teardowns,
            stream,
            _child_guards: instrument_child_guards,
        };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            buffer_frames,
            Some(cb_stats),
        );
        Ok((wrap, guard))
    }

    /// both build の buffer size を解決する。両方指定され値が異なる場合は、RT 設定の暗黙優先を
    /// 作らず hard error にする。片方だけならその値、両方未指定なら `None` を使う。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn resolve_outproc_both_buffer_frames(
        effect: Option<u32>,
        instrument: Option<u32>,
    ) -> Result<Option<u32>, WrapError> {
        match (effect, instrument) {
            (Some(effect), Some(instrument)) if effect != instrument => Err(WrapError::OutProcEffect(format!(
                    "ORBIT_EFFECT_BUFFER_FRAMES ({effect}) and ORBIT_INSTRUMENT_BUFFER_FRAMES ({instrument}) must match"
                ))),
            (Some(value), _) | (_, Some(value)) => Ok(Some(value)),
            (None, None) => Ok(None),
        }
    }

    /// effect と instrument の transport を一つの callback に合成して起動する。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn start_outproc_both(
        effect_cfg: crate::outproc_effect::OutProcEffectConfig,
        instrument_cfg: crate::outproc_instrument::OutProcInstrumentConfig,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            OutProcEffectPostProcessor, OutProcEffectPostProcessorParts, OutProcEffectStats,
        };
        let buffer_frames = Self::resolve_outproc_both_buffer_frames(
            effect_cfg.buffer_frames,
            instrument_cfg.buffer_frames,
        )?;

        // 同じ transport 構築を effect-only 経路（`start_outproc_effect_post_boot`）と共有する。
        // bus 0 個（または全 bus inactive）なら render は従来経路とビット同一に振る舞う。
        let (insert_buses, bus_builds) = build_effect_bus_stages()?;

        let effect_shm = crate::outproc_effect::unique_shm_path();
        let effect_host = orbit_audio_sandbox::PipelinedEffectHost::from_mmap(
            orbit_audio_sandbox::create_shared(&effect_shm)
                .map_err(|e| WrapError::OutProcEffect(format!("create shm {effect_shm:?}: {e}")))?,
        );
        let mut effect_shm_cleanup = ShmCleanupGuard::new(effect_shm.clone());
        // #540 P1: instrument slot pool。stream 起動前に N slot 分の shm / note ring /
        // block source を事前確保する（audio graph は起動時固定のため）。child は
        // LoadPlugin まで spawn しないので idle slot のコストは shm と即-return の
        // block source のみ。
        let (pending_instrument_slots, instrument_sources) =
            build_pending_instrument_slots(instrument_cfg.slots)?;
        let effect_engaged = Arc::new(AtomicBool::new(false));
        let effect_stop = Arc::new(AtomicBool::new(false));
        let effect_done = Arc::new(AtomicBool::new(false));
        let effect_stats = OutProcEffectStats::new();
        let processor = Box::new(OutProcEffectPostProcessor::new(
            OutProcEffectPostProcessorParts {
                host: effect_host,
                engaged: effect_engaged.clone(),
                teardown_requested: effect_stop.clone(),
                teardown_done: effect_done.clone(),
                stats: effect_stats.clone(),
            },
        ));
        let (engine, stream, stream_stats, effect_cb_stats) =
            orbit_audio_native::start_default_output_with_insert_buses_sources_and_post(
                insert_buses,
                instrument_sources,
                processor,
                buffer_frames,
                capture_path_from_env(),
                device_name_from_env(),
            )
            .map_err(WrapError::Output)?;
        let installed_master = install_effect_slot(EffectSlotInstallParts {
            shm_path: effect_shm,
            child_exe: effect_cfg.child_exe.clone(),
            sample_rate: stream.sample_rate,
            stats: effect_stats.clone(),
            engaged: effect_engaged,
            quiesce_requested: effect_stop,
            quiesce_done: effect_done,
        });
        let master_entry = installed_master.entry;
        let effect_slot = installed_master.child_slot;
        let master_teardown = installed_master.teardown;
        // unlink 所有権を起動失敗用 guard から ChildLaunch へ移す。
        effect_shm_cleanup.disarm();
        // #540 P1: pending slot を ChildLaunch へ組み上げる（sample_rate は stream 起動後に確定）。
        let (instrument_slot_entries, instrument_child_guards, instrument_teardowns) =
            install_instrument_slots(
                pending_instrument_slots,
                &instrument_cfg.child_exe,
                stream.sample_rate,
            );
        let wrap = Self::build(
            engine,
            stream.device_name.clone(),
            stream.sample_rate,
            stream.channels,
            stream_stats,
        );
        *wrap
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))? =
            Some(OutProcControl {
                stats: effect_stats,
                cb_stats: effect_cb_stats.clone(),
                child_slot: Arc::downgrade(&effect_slot),
                master_entry,
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
        *wrap.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })? = Some(OutProcInstrumentControl {
            slots: instrument_slot_entries,
            instance_index: HashMap::new(),
            free_slots: Vec::new(),
            next_unassigned: 0,
            replacements_in_flight: HashSet::new(),
        });

        let (
            bus_slots,
            bus_stats,
            bus_actives,
            bus_kinds,
            bus_index,
            bus_routing,
            bus_sends,
            bus_entries,
            bus_child_guards,
            bus_teardowns,
        ) = install_effect_bus_slots(bus_builds, &effect_cfg.child_exe, stream.sample_rate);
        {
            let mut guard = wrap
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().expect("outproc control installed");
            control.bus_slots = bus_slots;
            control.bus_entries = bus_entries;
            control.bus_stats = bus_stats;
            control.bus_actives = bus_actives;
            control.bus_kinds = bus_kinds;
            control.bus_index = bus_index;
            control.bus_routing = bus_routing;
            control.bus_sends = bus_sends;
        }

        let guard = StreamGuard {
            _outproc_teardown: master_teardown,
            _outproc_bus_teardowns: bus_teardowns,
            _outproc_instrument_teardowns: instrument_teardowns,
            stream,
            _child_guard: effect_slot,
            _bus_child_guards: bus_child_guards,
            _instrument_child_guards: instrument_child_guards,
        };
        wrap.record_stream_config(
            StreamConfigSnapshot::from_output_stream(&guard.stream),
            buffer_frames,
            Some(effect_cb_stats),
        );
        Ok((wrap, guard))
    }

    #[cfg(all(
        feature = "outproc-effect",
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let effect = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        let instrument = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_both(effect, instrument)
    }

    /// [`AudioBackend`] 経由で起動する（integration test 用）。
    ///
    /// guard は `Box<dyn Any + Send>` の不透明ハンドル。scope 終了まで
    /// drop せずに保持する必要がある。
    pub fn start_with<B: AudioBackend>(
        backend: B,
    ) -> Result<(Arc<Self>, Box<dyn std::any::Any + Send>), WrapError> {
        let started = backend.start()?;
        let wrap = Self::build(
            started.engine,
            "test audio backend".to_string(),
            started.sample_rate,
            started.channels,
            started.stats,
        );
        Ok((wrap, started.guard))
    }

    /// `start` / `start_with` 共通の Arc<Self> 構築部。新しいフィールドが
    /// 追加された際、両経路で初期化漏れが起きないよう一箇所に集約する。
    fn build(
        engine: Engine,
        device_name: String,
        sample_rate: u32,
        channels: u16,
        stream_stats: Arc<StreamStats>,
    ) -> Arc<Self> {
        let (plugin_ui_events, _) = tokio::sync::broadcast::channel(128);
        Arc::new(Self {
            engine,
            sample_rate,
            channels,
            stream_config: Mutex::new(StreamConfigSnapshot {
                device_name,
                sample_rate,
                channels,
            }),
            callback_alive: AtomicBool::new(false),
            samples: Mutex::new(HashMap::new()),
            started_at: std::time::Instant::now(),
            stream_stats,
            stopped_play_ids: Mutex::new(HashSet::new()),
            plugin_ui_events,
            link_egress_drops: Arc::new(AtomicU64::new(0)),
            clap_process_errors: Arc::new(AtomicU64::new(0)),
            #[cfg(feature = "clap-host")]
            plugin_loaded: AtomicBool::new(false),
            outproc_frames_clamped: Arc::new(AtomicU64::new(0)),
            outproc_instrument_output_dropped: Arc::new(AtomicU64::new(0)),
            outproc_instrument_child_errors: Arc::new(AtomicU64::new(0)),
            outproc_instrument_respawns: Arc::new(AtomicU64::new(0)),
            outproc_instrument_measurement_invalid: Arc::new(AtomicBool::new(false)),
            plugin_event_ring_overflow_count: AtomicU64::new(0),
            #[cfg(feature = "outproc-instrument")]
            active_plugin_notes: Mutex::new(HashSet::new()),
            device_switch_tx: Mutex::new(None),
            output_buffer_frames: Mutex::new(None),
            output_cb_stats: Mutex::new(None),
            // 本番 `start()`（feature 時）が spawn 後に Some を注入する。test backend 経路は None。
            #[cfg(feature = "link-audio")]
            link: Mutex::new(None),
            // clap-host: 本番 `start()` が spawn 後に Some を注入する。test backend 経路は None。
            #[cfg(feature = "clap-host")]
            clap: Mutex::new(None),
            // outproc-effect: 本番 `start()` / `start_outproc_effect` が spawn 後に Some を注入する。
            #[cfg(feature = "outproc-effect")]
            outproc: Mutex::new(None),
            // outproc-instrument: production start injects the NeutralEvent ring producer.
            #[cfg(feature = "outproc-instrument")]
            outproc_instrument: Mutex::new(None),
        })
    }

    pub fn subscribe_plugin_ui_events(&self) -> tokio::sync::broadcast::Receiver<PluginUiEvent> {
        self.plugin_ui_events.subscribe()
    }

    /// device switch（#484 D2）: 各 `start*()` variant 共通の後処理。`buffer_frames`/`cb_stats` を
    /// `self` に保存する（`apply_device_switch` が switch 時に同じ値を再利用し、バッファサイズ設定・
    /// callback-duration 計測の連続性を保つ）。`StreamGuard` 自体の所有権はこれまでどおり呼び出し側
    /// （`main.rs` の audio owner thread ローカル変数）が持つ — ここでは触らない。
    fn record_stream_config(
        &self,
        stream_config: StreamConfigSnapshot,
        buffer_frames: Option<u32>,
        cb_stats: Option<Arc<orbit_audio_native::CallbackTimeStats>>,
    ) {
        match self.stream_config.lock() {
            Ok(mut slot) => *slot = stream_config,
            Err(poisoned) => {
                tracing::warn!(
                    "stream config mutex poisoned; replacing the stored stream configuration"
                );
                *poisoned.into_inner() = stream_config;
            }
        }
        if let Ok(mut slot) = self.output_buffer_frames.lock() {
            *slot = buffer_frames;
        }
        if let Ok(mut slot) = self.output_cb_stats.lock() {
            *slot = cb_stats;
        }
    }

    /// device switch（#484 D2）: `main.rs` の audio owner thread が `EngineWrap::start()` 直後に
    /// 一度だけ呼ぶ。以後、[`Self::select_audio_device`] からの要求はこのチャンネル経由で
    /// owner thread（`tx` の受け手側 `rx` を loop で回すコード）に届く。
    pub fn install_device_switch_channel(&self, tx: std::sync::mpsc::Sender<DeviceSwitchRequest>) {
        if let Ok(mut slot) = self.device_switch_tx.lock() {
            *slot = Some(tx);
        }
    }

    /// device switch（#484 D2）: 制御スレッド（RPC handler・`spawn_blocking` 経由）から呼ぶ公開 API。
    /// 実際の cpal I/O は行わず、audio owner thread へ要求を送って応答を待つだけ（`cpal::Stream` は
    /// `!Send` のため `EngineWrap` 自身は一切触れない）。
    ///
    /// - `device`: `None`/空文字列 = システム既定へ縮退（`resolve_output_device` と同じ規約）。
    /// - capture（`ORBIT_CAPTURE_WAV`）が有効な場合は明示的に拒否する（継続不可・#484 D2 ブリーフの
    ///   選択(a)）: capture writer は switch 前の stream 専用に生成されており、新 stream に持ち越すと
    ///   ring producer が古い stream の drop と一緒に失われるため、無音で録音が壊れるより先に fail する。
    /// - **ブロッキング呼び出し**: 呼び出し側は `spawn_blocking`（session.rs の他の cpal I/O ハンドラと
    ///   同じ隔離）から呼ぶこと。RT callback 内からは絶対に呼ばない。
    pub fn select_audio_device(&self, device: Option<String>) -> Result<String, WrapError> {
        if capture_path_from_env().is_some() {
            return Err(WrapError::AudioDeviceSwitchUnavailable(
                "ORBIT_CAPTURE_WAV is active; runtime device switch is unsupported while \
                 capture is recording (restart the daemon to change device with capture on)"
                    .into(),
            ));
        }
        let tx = self
            .device_switch_tx
            .lock()
            .map_err(|_| {
                WrapError::AudioDeviceSwitchUnavailable("device switch channel poisoned".into())
            })?
            .clone()
            .ok_or_else(|| {
                WrapError::AudioDeviceSwitchUnavailable(
                    "no audio owner thread registered (test backend or daemon shutting down)"
                        .into(),
                )
            })?;
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        tx.send(DeviceSwitchRequest {
            device,
            reply: reply_tx,
        })
        .map_err(|_| {
            WrapError::AudioDeviceSwitchUnavailable("audio owner thread has exited".into())
        })?;
        reply_rx.recv().map_err(|_| {
            WrapError::AudioDeviceSwitchUnavailable(
                "audio owner thread dropped the reply channel".into(),
            )
        })?
    }

    /// device switch（#484 D2）: 実際の cpal I/O。**audio owner thread 上でのみ呼ぶこと**
    /// （`cpal::Stream` の `!Send` 制約を型システムではなく運用で守る seam — `&mut StreamGuard` を
    /// 要求することで、呼び出し側が `StreamGuard` を所有するその thread からしか呼べないよう
    /// 誘導する）。`Engine`（scheduler 状態）・OOP effect/instrument child・plugin routing は
    /// 一切触らない（`orbit_audio_native::RenderState` を新 stream に丸ごと引き継ぐ）。
    pub fn apply_device_switch(
        &self,
        guard: &mut StreamGuard,
        device: Option<String>,
    ) -> Result<String, WrapError> {
        let device_label = match &device {
            Some(name) if !name.trim().is_empty() => name.clone(),
            _ => "system default".to_string(),
        };
        let render_state = guard.stream.render_state();
        let buffer_frames = self.output_buffer_frames.lock().ok().and_then(|g| *g);
        let cb_stats = self.output_cb_stats.lock().ok().and_then(|g| g.clone());

        let new_stream = orbit_audio_native::rebuild_output_stream(
            render_state,
            self.engine.clone(),
            self.stream_stats.clone(),
            cb_stats.clone(),
            buffer_frames,
            device,
        )?;
        let stream_config = StreamConfigSnapshot::from_output_stream(&new_stream);
        // 新 stream が再生開始した後にだけ古い stream を差し替える（`rebuild_output_stream` は
        // 内部で `stream.play()` 済みを返す）。切替が失敗した場合はこの代入に到達せず、古い stream が
        // そのまま生き続ける＝無音のまま失敗しない。
        guard.stream = new_stream;
        self.record_stream_config(stream_config, buffer_frames, cb_stats);
        Ok(device_label)
    }

    /// 名前付き LinkAudio channel を登録する（A4-2b-2・feature `link-audio` 専用）。
    /// `RingTapSink` を生成し sink を cpal callback へ・consumer side を GPL consumer thread へ配る。
    #[cfg(feature = "link-audio")]
    pub fn register_link_audio_channel(&self, name: &str) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let mut guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_mut() {
            // registration の失敗（channel 上限・consumer 不在・reg-ring 満杯）は runtime error。
            Some(ctl) => ctl
                .register_channel(name)
                .map_err(|e| WrapError::LinkAudio(e.to_string())),
            // egress 経路が無い（test backend）= unavailable（feature-gap と同じ扱い）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。daemon command handler を feature 非依存に保つ。
    #[cfg(not(feature = "link-audio"))]
    pub fn register_link_audio_channel(&self, _name: &str) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// Link セッションに tempo(BPM)を push し OrbitScore を tempo leader にする（PR3・#333）。
    /// `LinkAudioControl::set_tempo` は内部で `captureAppSessionState`（非RT・block しうる）を呼ぶので、
    /// daemon WS handler は **spawn_blocking** で audio スレッド以外に隔離すること（session.rs）。
    /// `&self` で足りる: `set_link_tempo` は Rust 可視の可変状態を持たない（`LinkTempoControl` は `Arc`
    /// 共有で、tempo 反映は shim の interior mutability＝captureAppSessionState→commit）。
    /// `register_link_audio_channel` が `registered` HashMap を変更し `as_mut` を要するのと違い、ここは
    /// `guard.as_ref()` で足りる。
    #[cfg(feature = "link-audio")]
    pub fn set_link_tempo(&self, bpm: f64) -> Result<(), WrapError> {
        // mutex poison は egress 利用可能だが runtime で壊れた状態 → runtime error。
        let guard = self
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))?;
        match guard.as_ref() {
            // set_tempo は成功 true / 失敗 false。false（shim 内 Link 例外・実質起きない）は
            // false-positive success を返さず runtime error に昇格する（silent-failure 対策）。
            Some(ctl) => {
                if ctl.set_tempo(bpm) {
                    Ok(())
                } else {
                    Err(WrapError::LinkAudio(
                        "link set_tempo failed (Link rejected commit)".into(),
                    ))
                }
            }
            // egress 経路が無い（test backend）= unavailable（TS は warn-once で握り潰す）。
            None => Err(WrapError::LinkAudioUnavailable(
                "link audio not initialized (test backend has no egress path)".into(),
            )),
        }
    }

    /// feature `link-audio` 無効ビルド用の stub。TS は UNAVAILABLE を warn-once で握り潰す。
    #[cfg(not(feature = "link-audio"))]
    pub fn set_link_tempo(&self, _bpm: f64) -> Result<(), WrapError> {
        Err(WrapError::LinkAudioUnavailable(
            "engine built without 'link-audio' feature".into(),
        ))
    }

    /// OOP feature の初回 `LoadPlugin` で child + watchdog を attach する。
    ///
    /// blocking API: child の readiness を poll するため、session handler は `spawn_blocking` から
    /// 呼ぶこと。同一 path の再送は冪等、別 path への差し替えは v1 では拒否する。
    ///
    /// **契約（precondition）**: `StreamGuard`（`_child_guard` の唯一の強参照保持者）は in-flight
    /// の本呼び出しより必ず長生きすること。破ると: 成功パスで `Ok` を返した直後、本関数ローカルの
    /// `Arc` drop が最後の強参照となり、attach 直後の child が同期的に teardown（QUIT/reap/unlink）
    /// されうる（「成功応答=生きた plugin」が崩れる）。現行の全配線（main.rs のプロセス寿命
    /// `_stream_guard`・gated テストの関数スコープ `_guard`）はこれを満たす。
    ///
    /// **both ビルドでの意味論**: この legacy 単一 role API は **effect slot 専用**になる
    /// （instrument slot には触れない）。production 経路（session.rs の LoadPlugin dispatch）は
    /// both ビルドでは本メソッドを使わず、必ず role 別の `load_outproc_effect_plugin` /
    /// `load_outproc_instrument_plugin` を呼ぶこと。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn load_outproc_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
        return self.load_outproc_effect_plugin(path, plugin_id, None);
        #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
        return self.load_outproc_effect_plugin(path, plugin_id, None);
        #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
        let child_slot = {
            let mut guard = self.outproc_instrument.lock().map_err(|_| {
                InstrumentRole::runtime_error("outproc instrument mutex poisoned".into())
            })?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcInstrumentUnavailable(
                    "outproc instrument not initialized (test backend has no outproc path)".into(),
                )
            })?;
            // #540 P1: instance 引数の無いこの経路は互換の "default" instance = slot 0。
            // note 側の instance 解決（instance_index lookup）が通るよう登録しておく。
            control
                .instance_index
                .entry(DEFAULT_INSTRUMENT_INSTANCE.to_string())
                .or_insert(0);
            control
                .slots
                .first()
                .expect("slot pool has at least 1 slot (clamped in from_env)")
                .child_slot
                .upgrade()
                .ok_or_else(|| {
                    InstrumentRole::runtime_error("outproc instrument stream is closed".into())
                })?
        };
        #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
        return self
            .load_outproc_plugin_impl::<DefaultOutProcRole>(child_slot, path, plugin_id, None);
    }

    /// both build で effect slot へ attach する。
    #[cfg(feature = "outproc-effect")]
    pub fn load_outproc_effect_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        bus: Option<String>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        self.load_outproc_effect_plugin_with_state(path, plugin_id, bus, None)
    }

    #[cfg(feature = "outproc-effect")]
    pub fn load_outproc_effect_plugin_with_state(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        bus: Option<String>,
        state: Option<PathBuf>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let requested = crate::outproc_effect::ChainStageConfig::Catalog {
            path: path.clone(),
            plugin_id: plugin_id.clone(),
            latest_state: state.clone(),
            enabled: true,
        };
        let existing = {
            let guard = self
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_ref().ok_or_else(|| {
                WrapError::OutProcEffectUnavailable(
                    "outproc effect not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let (_, entry, _) = resolve_outproc_effect_slot(control, &bus)?;
            let existing = entry
                .chain
                .lock()
                .map_err(|_| WrapError::OutProcEffect("effect chain config mutex poisoned".into()))?
                .clone();
            existing
        };
        if existing == [requested.clone()] {
            return Ok(outproc_plugin_summary(&path, &plugin_id));
        }
        if !existing.is_empty() {
            return Err(WrapError::OutProcEffect(
                "outproc effect chain is already loaded; use ApplyEffectChain to replace it".into(),
            ));
        }
        self.apply_outproc_effect_chain(
            bus,
            crate::outproc_effect::EffectChainPlan {
                chain: vec![crate::outproc_effect::EffectChainPlanStage::Load {
                    stage: crate::outproc_effect::EffectChainStageSpec::Catalog {
                        path: path.clone(),
                        plugin_id: plugin_id.clone(),
                        state,
                        enabled: true,
                    },
                }],
                save_dropped: Vec::new(),
            },
            crate::outproc_effect::ApplyEffectChainMode::Diff,
        )?;
        Ok(outproc_plugin_summary(&path, &plugin_id))
    }

    /// Apply one receiver's complete serial effect rack. Diff mode uses the live rack mailbox;
    /// rebuild mode (and an unhealthy Active slot) reuses the #625 quiesce/teardown path.
    #[cfg(feature = "outproc-effect")]
    pub fn apply_outproc_effect_chain(
        &self,
        bus: Option<String>,
        plan: crate::outproc_effect::EffectChainPlan,
        mode: crate::outproc_effect::ApplyEffectChainMode,
    ) -> Result<AppliedEffectChainSummary, WrapError> {
        self.apply_outproc_effect_chain_with_timeout(
            bus,
            plan,
            mode,
            orbit_audio_sandbox::APPLY_CHAIN_MAILBOX_TIMEOUT,
        )
    }

    #[cfg(feature = "outproc-effect")]
    fn apply_outproc_effect_chain_with_timeout(
        &self,
        bus: Option<String>,
        plan: crate::outproc_effect::EffectChainPlan,
        mode: crate::outproc_effect::ApplyEffectChainMode,
        apply_timeout: Duration,
    ) -> Result<AppliedEffectChainSummary, WrapError> {
        let mut reservation = EffectReplacementReservation::new(self, bus.clone());
        let (child_slot, entry, stats, bus_active) = {
            let mut guard = self
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcEffectUnavailable(
                    "outproc effect not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let (child_slot, entry, stats) = resolve_outproc_effect_slot(control, &bus)?;
            let bus_active = bus
                .as_ref()
                .and_then(|name| control.bus_actives.get(name))
                .cloned();
            if let Some(active) = &bus_active {
                // Declaration is monotone for the lifetime of the bus pool (#625 R25).
                active.store(true, Ordering::Release);
            }
            control.replacements_in_flight.insert(bus.clone());
            reservation.mark_in_flight();
            (child_slot, entry, stats, bus_active)
        };

        let previous = entry
            .chain
            .lock()
            .map_err(|_| WrapError::OutProcEffect("effect chain config mutex poisoned".into()))?
            .clone();
        let desired = crate::outproc_effect::desired_chain(&previous, &plan)
            .map_err(WrapError::OutProcEffectRequest)?;
        // `desired_chain` above has already rejected duplicate/out-of-range keeps. Each surviving
        // binding therefore has exactly one possible destination: the plan position of its
        // `Keep { prev_index }` operation.
        let binding_remap = plugin_ui_keep_remap(&plan)?;

        enum ApplyRoute {
            Mailbox {
                mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
                index_binding: Arc<Mutex<PluginUiIndexBinding>>,
            },
            Rebuild(Option<Arc<orbit_audio_sandbox::CommandMailboxHost>>),
            Empty,
        }

        let mut route = {
            let slot = lock_child_slot_recovering(&child_slot, "effect chain route inspection");
            let registry_is_intact = effect_chain_registry_is_intact(&slot, &stats);
            match &*slot {
                ChildSlot::Active {
                    mailbox,
                    ui_index_binding: Some(index_binding),
                    ..
                } if mode == crate::outproc_effect::ApplyEffectChainMode::Diff
                    && registry_is_intact =>
                {
                    ApplyRoute::Mailbox {
                        mailbox: mailbox.clone(),
                        index_binding: index_binding.clone(),
                    }
                }
                ChildSlot::Active { mailbox, .. } => {
                    ApplyRoute::Rebuild(registry_is_intact.then(|| mailbox.clone()))
                }
                ChildSlot::Empty(_) if desired.is_empty() && previous.is_empty() => {
                    ApplyRoute::Empty
                }
                ChildSlot::Empty(_) => ApplyRoute::Rebuild(None),
                ChildSlot::Loading { path } => {
                    return Err(WrapError::OutProcEffect(format!(
                        "effect plugin load already in progress for {path:?}"
                    )))
                }
                ChildSlot::Closed => {
                    return Err(WrapError::OutProcSlotClosed(
                        "outproc effect slot is closed after an unrecoverable attach failure"
                            .into(),
                    ))
                }
            }
        };

        if let ApplyRoute::Mailbox {
            mailbox,
            index_binding,
        } = &route
        {
            let plan_path = crate::outproc_effect::write_apply_plan(&entry.shm_path, &plan)
                .map_err(|error| {
                    WrapError::OutProcEffect(format!("write effect chain apply plan: {error}"))
                })?;
            match mailbox.issue_apply_chain_with_timeout(&plan_path, apply_timeout) {
                Ok(_) => {
                    let desired_is_empty = desired.is_empty();
                    remap_plugin_ui_index_binding(index_binding, &binding_remap);
                    *entry.chain.lock().map_err(|_| {
                        WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                    })? = desired;
                    let dropped = dropped_stage_summaries(&plan.save_dropped)?;
                    if desired_is_empty {
                        self.teardown_outproc_effect_slot(
                            &bus,
                            &child_slot,
                            &entry,
                            stats.clone(),
                        )?;
                        return Ok(AppliedEffectChainSummary {
                            child_pid: 0,
                            dropped,
                        });
                    }
                    return Ok(AppliedEffectChainSummary {
                        child_pid: stats.current_child_pid.load(Ordering::Acquire),
                        dropped,
                    });
                }
                Err(orbit_audio_sandbox::CommandMailboxError::ChildExited { .. }) => {
                    // The desired config was computed from the pre-crash authority. Rebuild below.
                    route = ApplyRoute::Rebuild(None);
                }
                Err(error) => return Err(effect_chain_apply_mailbox_error(error)),
            }
        }

        if matches!(route, ApplyRoute::Empty) {
            entry.engaged.store(false, Ordering::Release);
            *entry.chain.lock().map_err(|_| {
                WrapError::OutProcEffect("effect chain config mutex poisoned".into())
            })? = Vec::new();
            return Ok(AppliedEffectChainSummary {
                child_pid: 0,
                dropped: Vec::new(),
            });
        }

        let dropped = match &route {
            ApplyRoute::Rebuild(Some(mailbox)) => {
                for stage in &plan.save_dropped {
                    let argument = serde_json::to_string(&serde_json::json!({
                        "index": stage.prev_index,
                        "path": stage.path,
                    }))
                    .map_err(|error| WrapError::OutProcEffectRequest(error.to_string()))?;
                    mailbox
                        .issue_save_state_at(&argument, &stage.path)
                        .map_err(effect_chain_apply_mailbox_error)?;
                }
                dropped_stage_summaries(&plan.save_dropped)?
            }
            ApplyRoute::Rebuild(None) => {
                dropped_stage_summaries_from_latest_state(&previous, &plan.save_dropped)?
            }
            ApplyRoute::Mailbox { .. } | ApplyRoute::Empty => Vec::new(),
        };

        let was_active = matches!(
            &*lock_child_slot_recovering(&child_slot, "effect rebuild state check"),
            ChildSlot::Active { .. }
        );
        if was_active {
            self.teardown_outproc_effect_slot(&bus, &child_slot, &entry, stats.clone())?;
        }
        if desired.is_empty() {
            *entry.chain.lock().map_err(|_| {
                WrapError::OutProcEffect("effect chain config mutex poisoned".into())
            })? = Vec::new();
            entry.engaged.store(false, Ordering::Release);
            return Ok(AppliedEffectChainSummary {
                child_pid: 0,
                dropped,
            });
        }

        self.load_outproc_effect_chain_impl(child_slot, &entry, stats.clone(), previous, desired)?;
        // Keep the monotone activation handle alive in this scope so accidental future rollback
        // is visible at the exact apply boundary. No false store is permitted here.
        let _ = bus_active;
        Ok(AppliedEffectChainSummary {
            child_pid: stats.current_child_pid.load(Ordering::Acquire),
            dropped,
        })
    }

    #[cfg(feature = "outproc-effect")]
    fn load_outproc_effect_chain_impl(
        &self,
        child_slot: Arc<Mutex<ChildSlot<EffectRole>>>,
        entry: &EffectSlotEntry,
        stats: Arc<crate::outproc_effect::OutProcEffectStats>,
        previous: crate::outproc_effect::ChainConfig,
        desired: crate::outproc_effect::ChainConfig,
    ) -> Result<(), WrapError> {
        let marker = crate::outproc_effect::chain_manifest_path(&entry.shm_path);
        let mut slot = lock_child_slot_recovering(&child_slot, "rack initial state check");
        match &*slot {
            ChildSlot::Empty(_) => {}
            ChildSlot::Loading { path } => {
                return Err(WrapError::OutProcEffect(format!(
                    "effect plugin load already in progress for {path:?}"
                )))
            }
            ChildSlot::Active { .. } => {
                return Err(WrapError::OutProcEffect(
                    "effect rack spawn requires an Empty slot".into(),
                ))
            }
            ChildSlot::Closed => {
                return Err(WrapError::OutProcSlotClosed(
                    "outproc effect slot is closed after an unrecoverable attach failure".into(),
                ))
            }
        }
        let mut launch = match std::mem::replace(&mut *slot, ChildSlot::Closed) {
            ChildSlot::Empty(launch) => launch,
            _ => unreachable!("ChildSlot state was checked while holding the same mutex"),
        };
        *slot = ChildSlot::Loading {
            path: marker.clone(),
        };
        drop(slot);

        let ready_mmap = match orbit_audio_sandbox::open_shared(&launch.shm_path) {
            Ok(mmap) => mmap,
            Err(error) => {
                *lock_child_slot_recovering(&child_slot, "rack open_shared failure") =
                    ChildSlot::Closed;
                return Err(WrapError::OutProcEffect(format!(
                    "open child readiness mapping {:?}: {error}",
                    launch.shm_path
                )));
            }
        };
        let region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            launch.shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(
            launch.shm_path.clone(),
        ));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let ui_index_binding = Arc::new(Mutex::new(Default::default()));
        if let Err(error) = ui_pump.reset_after_child_exit(&mailbox) {
            *lock_child_slot_recovering(&child_slot, "rack UI reset failure") =
                ChildSlot::Empty(launch);
            return Err(WrapError::OutProcEffect(format!(
                "reset UI event pump: {error}"
            )));
        }

        stats.initial_attach_pending.store(true, Ordering::Release);
        stats.child_early_exit.arm_for_new_attempt();
        let manifest = match crate::outproc_effect::write_chain_manifest(&launch.shm_path, &desired)
        {
            Ok(path) => path,
            Err(error) => {
                *lock_child_slot_recovering(&child_slot, "rack manifest failure") =
                    ChildSlot::Empty(launch);
                return Err(WrapError::OutProcEffect(format!(
                    "write effect chain spawn manifest: {error}"
                )));
            }
        };
        let first_child = match crate::outproc_effect::spawn_effect_child(
            &launch.child_exe,
            &launch.shm_path,
            &manifest,
            launch.sample_rate,
        ) {
            Ok(child) => child,
            Err(error) => {
                let child_exe = launch.child_exe.clone();
                *lock_child_slot_recovering(&child_slot, "rack child spawn failure") =
                    ChildSlot::Empty(launch);
                return Err(WrapError::OutProcEffect(format!(
                    "spawn outproc child {child_exe:?}: {error}"
                )));
            }
        };
        stats
            .current_child_pid
            .store(first_child.id(), Ordering::Relaxed);
        *entry
            .chain
            .lock()
            .map_err(|_| WrapError::OutProcEffect("effect chain config mutex poisoned".into()))? =
            desired;
        let supervisor =
            match crate::outproc_effect::EffectChildSupervisor::spawn_chain_with_mailbox(
                first_child,
                launch.shm_path.clone(),
                stats.clone(),
                launch.child_exe.clone(),
                launch.sample_rate,
                entry.chain.clone(),
                mailbox.clone(),
                PluginUiWiring {
                    pump: ui_pump.clone(),
                    target: ui_target.clone(),
                    index_binding: Some(ui_index_binding.clone()),
                    events: self.plugin_ui_events.clone(),
                },
            ) {
                Ok(supervisor) => supervisor,
                Err(error) => {
                    launch.cleanup_shm_on_drop = false;
                    *entry.chain.lock().map_err(|_| {
                        WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                    })? = previous;
                    *lock_child_slot_recovering(&child_slot, "rack supervisor spawn failure") =
                        ChildSlot::Closed;
                    return Err(WrapError::OutProcEffect(format!(
                        "spawn outproc watchdog: {error}"
                    )));
                }
            };

        let deadline = std::time::Instant::now() + CHILD_READY_TIMEOUT;
        loop {
            let status = unsafe { (*region).child_status.load(Ordering::Acquire) };
            if status == orbit_audio_sandbox::transport::CHILD_STATUS_READY {
                let flags = unsafe { (*region).child_flags.load(Ordering::Acquire) };
                if !EffectRole::role_matches(flags) {
                    let error = retryable_attach_failure(
                        supervisor,
                        region,
                        &child_slot,
                        launch,
                        format!(
                            "loaded plugin role does not match daemon role (child_flags={flags:#x})"
                        ),
                    );
                    *entry.chain.lock().map_err(|_| {
                        WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                    })? = previous;
                    return Err(error);
                }
                stats.initial_attach_pending.store(false, Ordering::Release);
                break;
            }
            // Root 3-3: `CHILD_STATUS_LOAD_FAILED` is the rack child's own, more specific signal
            // (set by `RackController::load_initial` before it exits) — checking it before
            // falling through to the generic `child_early_exit` wait means we surface *why* the
            // load failed (e.g. "failed index 1: <plugin>: <reason>") instead of only ever
            // learning the process exited. The child also writes the same text into
            // `cmd_result_detail` right after setting this status; read it back here rather than
            // reconstructing a generic message from the exit status alone.
            if status == orbit_audio_sandbox::transport::CHILD_STATUS_LOAD_FAILED {
                let detail = unsafe {
                    orbit_audio_sandbox::transport::read_cstr_field(&(*region).cmd_result_detail)
                        .map(str::to_string)
                }
                .filter(|detail| !detail.is_empty())
                .unwrap_or_else(|| "child reported a load failure without detail".into());
                let error =
                    retryable_attach_failure(supervisor, region, &child_slot, launch, detail);
                *entry.chain.lock().map_err(|_| {
                    WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                })? = previous;
                return Err(error);
            }
            if stats.child_early_exit.fired() {
                let detail = stats
                    .child_early_exit
                    .reason()
                    .map(|status| format!("child exited before publishing READY ({status})"))
                    .unwrap_or_else(|| "child exited before publishing READY".into());
                let error =
                    retryable_attach_failure(supervisor, region, &child_slot, launch, detail);
                *entry.chain.lock().map_err(|_| {
                    WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                })? = previous;
                return Err(error);
            }
            if std::time::Instant::now() >= deadline {
                let error = retryable_attach_failure(
                    supervisor,
                    region,
                    &child_slot,
                    launch,
                    format!("timed out waiting {CHILD_READY_TIMEOUT:?} for child READY"),
                );
                *entry.chain.lock().map_err(|_| {
                    WrapError::OutProcEffect("effect chain config mutex poisoned".into())
                })? = previous;
                return Err(error);
            }
            std::thread::sleep(CHILD_READY_POLL);
        }

        launch.engaged.store(true, Ordering::Release);
        launch.cleanup_shm_on_drop = false;
        let mut slot = lock_child_slot_recovering(&child_slot, "successful rack attach");
        debug_assert_slot_loading(&slot);
        *slot = ChildSlot::Active {
            path: marker,
            plugin_id: None,
            state: None,
            latest_state: Arc::new(Mutex::new(None)),
            engaged: launch.engaged.clone(),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding: Some(ui_index_binding),
            _supervisor: supervisor,
        };
        Ok(())
    }

    /// effect plugin を固定 slot 上で目標 spec へ収束させる ensure 操作。
    /// Active の異 spec だけを quiesce ack 後に同じ shm 上で建て直す。
    #[cfg(feature = "outproc-effect")]
    pub fn replace_outproc_effect_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        bus: Option<String>,
        state: Option<PathBuf>,
    ) -> Result<ReplacedPluginSummary, WrapError> {
        // outproc mutex より先に宣言する。early-return / panic でも後から取った mutex guard が
        // 先に落ち、Drop が同じ mutex を安全に取り直して in-flight を解除できる。
        let mut reservation = EffectReplacementReservation::new(self, bus.clone());
        let (child_slot, entry, stats) = {
            let mut guard = self
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcEffectUnavailable(
                    "outproc effect not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let (child_slot, entry, stats) = resolve_outproc_effect_slot(control, &bus)?;

            {
                let slot =
                    lock_child_slot_recovering(&child_slot, "effect replacement state check");
                match &*slot {
                    ChildSlot::Active {
                        path: active_path,
                        plugin_id: active_plugin_id,
                        state: active_state,
                        engaged,
                        ..
                    } if active_path == &path
                        && active_plugin_id == &plugin_id
                        && active_state == &state =>
                    {
                        engaged.store(true, Ordering::Release);
                        return Ok(ReplacedPluginSummary {
                            plugin: outproc_plugin_summary(active_path, active_plugin_id),
                            quarantined_slot: false,
                        });
                    }
                    ChildSlot::Active { .. } => {}
                    ChildSlot::Empty(_) => {
                        drop(slot);
                        drop(guard);
                        if entry.shutdown.load(Ordering::Acquire) {
                            return Err(WrapError::OutProcEffect("engine is stopping".into()));
                        }
                        return self
                            .load_outproc_plugin_impl::<EffectRole>(
                                child_slot, path, plugin_id, state,
                            )
                            .map(|plugin| ReplacedPluginSummary {
                                plugin,
                                quarantined_slot: false,
                            });
                    }
                    ChildSlot::Loading { path: loading_path } => {
                        return Err(WrapError::OutProcEffect(format!(
                            "effect plugin load already in progress for {loading_path:?}"
                        )));
                    }
                    ChildSlot::Closed => {
                        return Err(WrapError::OutProcSlotClosed(
                            "outproc effect slot is closed after an unrecoverable attach failure"
                                .into(),
                        ));
                    }
                }
            }

            control.replacements_in_flight.insert(bus.clone());
            reservation.mark_in_flight();
            (child_slot, entry, stats)
        };

        // FM-R5 mutation point: removing this teardown must leave the old Active slot in place.
        self.teardown_outproc_effect_slot(&bus, &child_slot, &entry, stats)?;

        // The stream guard may have latched shutdown while teardown was clearing its flags.
        // Distinct wording from the pre-teardown check: by this point the old effect is
        // already gone and the bus has degraded to dry pass-through, which is what an
        // operator reading the log needs to know (#625 audit C-1).
        if entry.shutdown.load(Ordering::Acquire) {
            return Err(WrapError::OutProcEffect(
                "engine is stopping after the previous effect was torn down; the bus is passing through dry"
                    .into(),
            ));
        }
        let plugin =
            self.load_outproc_plugin_impl::<EffectRole>(child_slot, path, plugin_id, state)?;
        Ok(ReplacedPluginSummary {
            plugin,
            quarantined_slot: false,
        })
    }

    /// Removes the current effect tenant while preserving the slot, bus activation,
    /// routing, and allocation bookkeeping. An already-empty slot is an idempotent noop.
    #[cfg(feature = "outproc-effect")]
    pub fn unload_outproc_effect_plugin(
        &self,
        bus: Option<String>,
    ) -> Result<UnloadedPluginStatus, WrapError> {
        let mut reservation = EffectReplacementReservation::new(self, bus.clone());
        let (child_slot, entry, stats) = {
            let mut guard = self
                .outproc
                .lock()
                .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcEffectUnavailable(
                    "outproc effect not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let (child_slot, entry, stats) = resolve_outproc_effect_slot(control, &bus)?;
            {
                let slot = lock_child_slot_recovering(&child_slot, "effect unload state check");
                match &*slot {
                    ChildSlot::Empty(_) => return Ok(UnloadedPluginStatus::Noop),
                    ChildSlot::Active { .. } => {}
                    ChildSlot::Loading { path } => {
                        return Err(WrapError::OutProcEffect(format!(
                            "effect plugin load already in progress for {path:?}"
                        )));
                    }
                    ChildSlot::Closed => {
                        return Err(WrapError::OutProcSlotClosed(
                            "outproc effect slot is closed after an unrecoverable attach failure"
                                .into(),
                        ));
                    }
                }
            }
            control.replacements_in_flight.insert(bus.clone());
            reservation.mark_in_flight();
            (child_slot, entry, stats)
        };

        self.teardown_outproc_effect_slot(&bus, &child_slot, &entry, stats)?;
        Ok(UnloadedPluginStatus::Unloaded)
    }

    /// Active effect child を quiesce して停止し、同じ shm を使う Empty slot へ戻す。
    #[cfg(feature = "outproc-effect")]
    fn teardown_outproc_effect_slot(
        &self,
        target: &Option<String>,
        child_slot: &Arc<Mutex<ChildSlot<EffectRole>>>,
        entry: &EffectSlotEntry,
        stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    ) -> Result<(), WrapError> {
        entry.engaged.store(false, Ordering::Release);
        entry.quiesce_done.store(false, Ordering::Release);
        entry.quiesce_requested.store(true, Ordering::Release);
        let deadline = std::time::Instant::now() + EFFECT_QUIESCE_TIMEOUT;
        let quiesce_acked = loop {
            if entry.quiesce_done.load(Ordering::Acquire) {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(EFFECT_QUIESCE_POLL);
        };
        if !quiesce_acked {
            clear_quiesce_unless_shutdown(entry);
            if !entry.shutdown.load(Ordering::Acquire) {
                entry.engaged.store(true, Ordering::Release);
            }
            // error!: the RT thread failed to answer the quiesce request — the entry point of
            // the unresponsive-audio-thread class #625 fought; the RPC error below reaches the
            // caller, but this record is what get_log keeps after the evaluation scrolls away.
            tracing::error!(
                slot = %effect_slot_label(target),
                "effect replacement quiesce ack timed out; the previous effect is kept"
            );
            return Err(WrapError::OutProcEffect(
                "effect replacement quiesce ack timed out; the previous effect is kept".into(),
            ));
        }

        let supervisor = {
            let mut slot = lock_child_slot_recovering(child_slot, "effect slot teardown");
            match std::mem::replace(&mut *slot, ChildSlot::Closed) {
                ChildSlot::Active { _supervisor, .. } => _supervisor,
                other => {
                    *slot = other;
                    clear_quiesce_unless_shutdown(entry);
                    if !entry.shutdown.load(Ordering::Acquire) {
                        entry.engaged.store(true, Ordering::Release);
                    }
                    tracing::warn!(
                        slot = %effect_slot_label(target),
                        "effect replacement teardown expected an Active slot"
                    );
                    return Err(WrapError::OutProcEffect(format!(
                        "effect replacement teardown expected an Active {} slot",
                        effect_slot_label(target)
                    )));
                }
            }
        };

        let reset = orbit_audio_sandbox::open_shared(&entry.shm_path);
        match reset {
            Ok(mmap) => {
                let region = orbit_audio_sandbox::region_ptr(&mmap);
                detach_and_reset_control_run::<EffectRole>(supervisor, region);
            }
            Err(error) => {
                EffectRole::detach_keep_shm(supervisor);
                EffectRole::set_current_child_pid(&stats, 0);
                clear_quiesce_unless_shutdown(entry);
                return Err(WrapError::OutProcEffect(format!(
                    "open effect control reset mapping {:?}: {error}",
                    entry.shm_path
                )));
            }
        }
        EffectRole::set_current_child_pid(&stats, 0);
        // Tenant handoff clears the previous tenant's sticky health verdict (#625 audit A-1).
        // `measurement_invalid` is latched by the watchdog when it gives up on a child
        // (fast-fail cutoff / respawn failure / try_wait failure / poisoned mutex) and is
        // never cleared elsewhere, so a crash-looping effect that the user then *replaces*
        // would keep reporting "measurement invalid" for the healthy new tenant until the
        // daemon restarts. The instrument teardown resets the same field for the same reason
        // (see `teardown_outproc_instrument_resources`); effect stats carry the field too, so
        // the invariant is inherited rather than skipped.
        stats.measurement_invalid.store(false, Ordering::Release);
        *lock_child_slot_recovering(child_slot, "effect slot teardown completion") =
            ChildSlot::Empty(ChildLaunch::<EffectRole> {
                shm_path: entry.shm_path.clone(),
                child_exe: entry.child_exe.clone(),
                sample_rate: entry.sample_rate,
                stats,
                engaged: entry.engaged.clone(),
                cleanup_shm_on_drop: true,
            });
        // FM-R18/R27 mutation point: stale flags and shutdown-owned requests are both unsafe.
        clear_quiesce_unless_shutdown(entry);
        Ok(())
    }

    /// 実行時ルーティング切替（#459/#453 M2）: `seq_bus` の output target / send gain を非 RT で
    /// 書き換える。**forward-only（MX.4）と kind 制約（output は sum のみ・send 先は aux のみ）を
    /// ここで検証してから atomic に反映する**（RT callback は検証済みの値を load するだけ）。
    ///
    /// - `output = Some("master")`: **予約語**。sum への出力先指定を解除して hardware/master へ
    ///   戻す（#517 S3 で追加。この予約語は bus 名として検索・登録しない）。
    /// - `output = Some(name)`: `name` は `sum` kind かつ `seq_bus` より後ろの index でなければ
    ///   ならない。それ以外はエラーで拒否し、既存の routing_override には触れない（部分適用しない）。
    /// - `output = None`: output target には触れない（既存の override をそのまま保つ）。
    ///   予約語との区別で「変更なし / sum へ変更 / master へ戻す」の三状態を表現する。
    /// - `sends`: 列挙された `(name, gain)` のみを反映する（列挙されていない既存 send には触れない）。
    ///   `name` は `aux` kind かつ `seq_bus` より後ろの index でなければならない。`gain` は有限
    ///   （NaN/Inf 拒否）。1 件でも検証に失敗したら **どの send も反映しない**（部分適用しない）。
    #[cfg(feature = "outproc-effect")]
    pub fn set_bus_routing(
        &self,
        seq_bus: &str,
        output: Option<&str>,
        sends: &[(String, f32)],
    ) -> Result<(), WrapError> {
        let guard = self
            .outproc
            .lock()
            .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
        let control = guard.as_ref().ok_or_else(|| {
            WrapError::OutProcEffectUnavailable(
                "outproc effect not initialized (test backend has no outproc path)".into(),
            )
        })?;

        let seq_index = *control
            .bus_index
            .get(seq_bus)
            .ok_or_else(|| WrapError::OutProcEffect(format!("unknown bus '{seq_bus}'")))?;

        // 1. output target を検証（反映はまだしない・部分適用を避ける）。
        let resolved_output = match output {
            Some("master") => Some(1),
            Some(name) => {
                let target_index = *control.bus_index.get(name).ok_or_else(|| {
                    WrapError::OutProcEffect(format!("SetBusRouting output: unknown bus '{name}'"))
                })?;
                if target_index <= seq_index {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' (index {target_index}) must be a later stage than '{seq_bus}' (index {seq_index})"
                    )));
                }
                if control.bus_kinds.get(name) != Some(&BusKind::Sum) {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetBusRouting output '{name}' must be a sum bus"
                    )));
                }
                Some(target_index + 2)
            }
            None => None,
        };

        // 2. sends を検証（同上・1 件でも失敗したら全体を拒否）。
        let mut resolved_sends = Vec::with_capacity(sends.len());
        for (name, gain) in sends {
            if !gain.is_finite() {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' gain must be finite, got {gain}"
                )));
            }
            let target_index = *control.bus_index.get(name).ok_or_else(|| {
                WrapError::OutProcEffect(format!("SetBusRouting send: unknown bus '{name}'"))
            })?;
            if target_index <= seq_index {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' (index {target_index}) must be a later stage than '{seq_bus}' (index {seq_index})"
                )));
            }
            if control.bus_kinds.get(name) != Some(&BusKind::Aux) {
                return Err(WrapError::OutProcEffect(format!(
                    "SetBusRouting send '{name}' must be an aux bus"
                )));
            }
            resolved_sends.push((target_index, *gain));
        }

        // 3. 検証済みの値だけを atomic へ反映する。
        if let Some(routing_value) = resolved_output {
            let routing = control.bus_routing.get(seq_bus).ok_or_else(|| {
                WrapError::OutProcEffect(format!("bus '{seq_bus}' has no routing handle"))
            })?;
            // エンコード: 0=override 無し・1=Master・n>=2 => Bus(n-2)（native `InsertBusStage`
            // doc 参照）。
            routing.store(routing_value, Ordering::Relaxed);
        }
        if !resolved_sends.is_empty() {
            let send_slots = control.bus_sends.get(seq_bus).ok_or_else(|| {
                WrapError::OutProcEffect(format!("bus '{seq_bus}' has no send slots"))
            })?;
            for (target_index, gain) in resolved_sends {
                // slot k は絶対 index `seq_index + 1 + k` を指す（構築時の割当・build_effect_bus_stages
                // doc 参照）ので k = target_index - seq_index - 1。
                let k = target_index - seq_index - 1;
                let slot = send_slots.get(k).ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "bus '{seq_bus}' has no send slot for target index {target_index}"
                    ))
                })?;
                slot.store(gain.to_bits(), Ordering::Relaxed);
            }
        }

        // 4. activation（M3・#459/#453）: `SetBusRouting` は `LoadPlugin` と同じ activation 機構を
        //    共有する（MX.4）。plugin 未ロードの pass-through bus（insert 未宣言の seq が
        //    `seq.output`/`seq.send` だけを持つケース）でも routing が生きるよう、参照された bus
        //    （seq_bus 自身・output 先・send 先）を render 対象に含める。既に active な bus への
        //    再 store は無害（RT 経路は bool load のみ）。
        for name in std::iter::once(seq_bus)
            .chain(output)
            .chain(sends.iter().map(|(name, _)| name.as_str()))
        {
            if let Some(active) = control.bus_actives.get(name) {
                active.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    /// Route one preallocated output unit of an opaque source to Master or a named insert bus.
    /// All name/kind/range validation happens before either shared atomic is changed.
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn set_source_routing(
        &self,
        source: &str,
        unit: u32,
        target: Option<&str>,
    ) -> Result<(), WrapError> {
        let (resolved, active) = match target {
            None => (orbit_audio_native::SourceDest::Master, None),
            Some(name) => {
                let guard = self
                    .outproc
                    .lock()
                    .map_err(|_| WrapError::OutProcEffect("outproc mutex poisoned".into()))?;
                let control = guard.as_ref().ok_or_else(|| {
                    WrapError::OutProcEffectUnavailable(
                        "outproc effect not initialized (test backend has no outproc path)".into(),
                    )
                })?;
                let bus_index = *control.bus_index.get(name).ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "SetSourceRouting target: unknown bus '{name}'"
                    ))
                })?;
                if control.bus_kinds.get(name) != Some(&BusKind::Insert) {
                    return Err(WrapError::OutProcEffect(format!(
                        "SetSourceRouting target '{name}' must be an insert bus"
                    )));
                }
                let active = control.bus_actives.get(name).cloned().ok_or_else(|| {
                    WrapError::OutProcEffect(format!(
                        "SetSourceRouting target bus '{name}' has no activation handle"
                    ))
                })?;
                (orbit_audio_native::SourceDest::Bus(bus_index), Some(active))
            }
        };

        // Keep the instance mapping lock through the destination store. Replacement commits use
        // the same lock to copy all destinations, so routing cannot land on a just-retired slot.
        let guard = self.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })?;
        let control = guard.as_ref().ok_or_else(|| {
            WrapError::OutProcInstrumentUnavailable(
                "outproc instrument not initialized (test backend has no outproc path)".into(),
            )
        })?;
        let slot_index = *control.instance_index.get(source).ok_or_else(|| {
            WrapError::OutProcInstrument(format!("SetSourceRouting: unknown source '{source}'"))
        })?;
        let slot = control.slots.get(slot_index).ok_or_else(|| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: source '{source}' resolves to missing slot {slot_index}"
            ))
        })?;
        let unit_index = usize::try_from(unit).map_err(|_| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: unit {unit} is out of range for source '{source}'"
            ))
        })?;
        let source_dest = slot.source_dests.get(unit_index).ok_or_else(|| {
            WrapError::OutProcInstrument(format!(
                "SetSourceRouting: unit {unit} is out of range for source '{source}' ({} units)",
                slot.source_dests.len()
            ))
        })?;
        if let Some(active) = active {
            active.store(true, Ordering::Release);
        }
        source_dest.store(resolved);
        Ok(())
    }

    /// both build で instrument slot へ attach する。
    #[cfg(feature = "outproc-instrument")]
    pub fn load_outproc_instrument_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        instance: Option<String>,
        state: Option<PathBuf>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        // #540 P1/#618: instance → slot index の解決。初出 instance は teardown 済み free slot を
        // 優先し、無ければ起動時 pool の未割当 slot を使う。割当後の LoadPlugin semantics
        // （失敗しても instance が slot を占有し続ける）は従来どおり。
        let slot = {
            let mut guard = self.outproc_instrument.lock().map_err(|_| {
                WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
            })?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcInstrumentUnavailable(
                    "outproc instrument not initialized (test backend has no outproc path)".into(),
                )
            })?;
            let name = instance.as_deref().unwrap_or(DEFAULT_INSTRUMENT_INSTANCE);
            let index = match control.instance_index.get(name) {
                Some(&index) => index,
                None => {
                    let Some(next) = control.allocate_slot() else {
                        return Err(WrapError::OutProcInstrument(format!(
                            "instrument slot pool exhausted ({} slots, all assigned); \
                             raise ORBIT_OUTPROC_INSTRUMENT_SLOTS (max {}) and restart the engine",
                            control.slots.len(),
                            crate::outproc_instrument::MAX_INSTRUMENT_SLOTS,
                        )));
                    };
                    // 注（#542 レビュー F12）: 割当はロード試行**前**で、失敗しても解除しない
                    // （TS 層は失敗宣言を忘れて再試行できるのと非対称）。attach が unrecoverable
                    // 失敗（slot=Closed）した instance は daemon 生存中その slot を占有し続ける。
                    // 解除には slot の再初期化（shm/ring の作り直し）が要るため v1 は保持で確定 —
                    // 枯渇時のエラーが env 引き上げ + 再起動を案内する。
                    control.instance_index.insert(name.to_string(), next);
                    next
                }
            };
            control.slots[index].child_slot.upgrade().ok_or_else(|| {
                WrapError::OutProcInstrument("outproc instrument stream is closed".into())
            })?
        };
        self.load_outproc_plugin_impl::<InstrumentRole>(slot, path, plugin_id, state)
    }

    /// #618: instrument plugin を目標 spec へ収束させる ensure 操作。
    ///
    /// 未割当/Empty は通常 load、同一 Active は no-op、異 spec Active は spare へ prepare して
    /// READY 後に `instance_index` を commit する。既存 `LoadPlugin` の Active-reject semantics は
    /// `load_outproc_plugin_impl` 側にそのまま残す。
    #[cfg(feature = "outproc-instrument")]
    pub fn replace_outproc_instrument_plugin(
        &self,
        path: PathBuf,
        plugin_id: Option<String>,
        instance: Option<String>,
        state: Option<PathBuf>,
    ) -> Result<ReplacedPluginSummary, WrapError> {
        let name = instance
            .as_deref()
            .unwrap_or(DEFAULT_INSTRUMENT_INSTANCE)
            .to_string();
        // Declared before every control mutex guard: during unwinding, the later-declared mutex
        // guard drops first, so this reservation can lock control without self-deadlocking.
        let mut reservation = InstrumentReplacementReservation::new(self, name.clone());

        let (old_index, old_slot, spare_index, spare_slot) = {
            let mut guard = self.outproc_instrument.lock().map_err(|_| {
                WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
            })?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcInstrumentUnavailable(
                    "outproc instrument not initialized (test backend has no outproc path)".into(),
                )
            })?;
            if control.replacements_in_flight.contains(&name) {
                return Err(WrapError::OutProcInstrument(format!(
                    "instrument replacement already in progress for instance '{name}'"
                )));
            }
            let Some(&old_index) = control.instance_index.get(&name) else {
                drop(guard);
                return self
                    .load_outproc_instrument_plugin(path, plugin_id, Some(name), state)
                    .map(|plugin| ReplacedPluginSummary {
                        plugin,
                        quarantined_slot: false,
                    });
            };
            let old_slot = control.slots[old_index]
                .child_slot
                .upgrade()
                .ok_or_else(|| {
                    WrapError::OutProcInstrument("outproc instrument stream is closed".into())
                })?;
            {
                let slot = lock_child_slot_recovering(&old_slot, "replacement state check");
                match &*slot {
                    ChildSlot::Active {
                        path: active_path,
                        plugin_id: active_plugin_id,
                        state: active_state,
                        engaged,
                        ..
                    } if active_path == &path
                        && active_plugin_id == &plugin_id
                        && active_state == &state =>
                    {
                        engaged.store(true, Ordering::Release);
                        return Ok(ReplacedPluginSummary {
                            plugin: outproc_plugin_summary(active_path, active_plugin_id),
                            quarantined_slot: false,
                        });
                    }
                    ChildSlot::Active { .. } => {}
                    ChildSlot::Empty(_) => {
                        drop(slot);
                        drop(guard);
                        return self
                            .load_outproc_instrument_plugin(path, plugin_id, Some(name), state)
                            .map(|plugin| ReplacedPluginSummary {
                                plugin,
                                quarantined_slot: false,
                            });
                    }
                    ChildSlot::Loading { path: loading_path } => {
                        return Err(WrapError::OutProcInstrument(format!(
                            "instrument plugin load already in progress for {loading_path:?}"
                        )));
                    }
                    ChildSlot::Closed => {
                        return Err(WrapError::OutProcSlotClosed(
                            "outproc instrument slot is closed after an unrecoverable attach failure"
                                .into(),
                        ));
                    }
                }
            }

            control.replacements_in_flight.insert(name.clone());
            reservation.mark_in_flight();
            let Some(spare_index) = control.allocate_slot() else {
                return Err(WrapError::OutProcInstrument(format!(
                    "instrument slot pool exhausted (replacement needs one spare slot; {} slots are assigned or unavailable); \
                     raise ORBIT_OUTPROC_INSTRUMENT_SLOTS (max {}) and restart the engine",
                    control.slots.len(),
                    crate::outproc_instrument::MAX_INSTRUMENT_SLOTS,
                )));
            };
            reservation.reserve_spare(spare_index);
            let spare_slot = control.slots[spare_index]
                .child_slot
                .upgrade()
                .ok_or_else(|| {
                    WrapError::OutProcInstrument("outproc instrument stream is closed".into())
                })?;
            reservation.attach_spare_resources(InstrumentSlotTeardownResources::from_entry(
                spare_index,
                &control.slots[spare_index],
                spare_slot.clone(),
            ));
            (old_index, old_slot, spare_index, spare_slot)
        };

        let summary = self.load_outproc_plugin_impl::<InstrumentRole>(
            spare_slot.clone(),
            path,
            plugin_id,
            state,
        )?;

        // Atomic commit: every subsequent note/state/UI lookup resolves to the READY spare.
        {
            let mut guard = self.outproc_instrument.lock().map_err(|_| {
                WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
            })?;
            let control = guard.as_mut().ok_or_else(|| {
                WrapError::OutProcInstrumentUnavailable(
                    "outproc instrument control disappeared during replacement".into(),
                )
            })?;
            debug_assert_eq!(control.instance_index.get(&name), Some(&old_index));
            // 🔴 長さが揃わないと `zip` が黙って切り詰め、移行漏れの unit が
            // **リバーブごと外れたまま**新 slot に引き継がれる（設計 §7 が名指しした silent detach）。
            // ここは制御スレッドなので `assert!` も書けるが、**採らない** — 演奏中に daemon が落ちる方が
            // 害が大きい（owner 原則: エラーで止めない）。共通部分は移行し、差分をログに出して
            // `get_log` から観測可能にする。両 slot とも `default_source_dests()` 由来なので
            // 正常経路では到達しない。
            let old_units = control.slots[old_index].source_dests.len();
            let new_units = control.slots[spare_index].source_dests.len();
            if old_units != new_units {
                tracing::error!(
                    instance = %name,
                    old_slot = old_index,
                    new_slot = spare_index,
                    old_units,
                    new_units,
                    "instrument replacement: source destination arrays differ in length; \
                     units beyond the shorter array are not migrated and stay at Master \
                     on the new slot (wiring bug)"
                );
            }
            // 🔴 移行とリセットを1ループに畳んでいるので、**リセットも `zip` の共通長まで**しか
            // 及ばない。長さが揃っている（両者とも `default_source_dests()` 由来 = `MAX_SOURCE_UNITS`
            // 固定長）ことが前提で、上のログはその前提が崩れた事実を残すためにある。
            // **可変長にする変更が入ったら、このループも見直すこと**（リセットだけ全長に戻すか、
            // 長さ不一致を早期に弾くか）。
            for (old_dest, new_dest) in control.slots[old_index]
                .source_dests
                .iter()
                .zip(&control.slots[spare_index].source_dests)
            {
                new_dest.store(old_dest.load());
                old_dest.store(orbit_audio_native::SourceDest::Master);
            }
            control.instance_index.insert(name.clone(), spare_index);
        }
        reservation.commit_spare();

        let teardown = self.teardown_outproc_instrument_slot(&name, old_index, &old_slot);
        let quarantined_slot = teardown.is_err();
        if let Err(reason) = &teardown {
            tracing::warn!(
                instance = %name,
                slot = old_index,
                reason = %reason,
                "instrument replacement completed with old slot quarantined from free-list"
            );
        }
        let mut guard = self.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })?;
        if let Some(control) = guard.as_mut() {
            if teardown.is_ok() {
                control.free_slot(old_index);
            }
            // in-flight 解除を free_slot と同じロック区間で行う。`reservation` の Drop も
            // 解除するが、それは**このガードが落ちた後**に別のロックを取り直すため、その間
            // 同一 instance への並行 replace が「already in progress」で偽に弾かれる窓が開く
            // （fix 前は1つのロック区間で両方やっていた）。`HashSet::remove` は冪等なので、
            // Drop 側は失敗・パニック時の安全網として残したままでよい。
            control.replacements_in_flight.remove(&name);
        }
        Ok(ReplacedPluginSummary {
            plugin: summary,
            quarantined_slot,
        })
    }

    /// Active instrument slot の資源を取得し、tenant teardown を行う。
    /// teardown が完了した slot は child 消滅・shm 保持の Empty へ戻る。event drain ack と
    /// CONTROL_RUN 復元の両方が成功した場合だけ再利用可能であり、どちらかが失敗した Empty は
    /// 前 tenant の痕跡または stale control を持ちうるため free-list へ返さず隔離する。
    /// control が取得できない場合や slot が Active でない場合は状態を作り替えず失敗する。
    #[cfg(feature = "outproc-instrument")]
    fn teardown_outproc_instrument_slot(
        &self,
        instance: &str,
        index: usize,
        child_slot: &Arc<Mutex<ChildSlot<InstrumentRole>>>,
    ) -> Result<(), InstrumentSlotTeardownFailure> {
        let (resources, control_failure) = {
            let (guard, control_failure) = match self.outproc_instrument.lock() {
                Ok(guard) => (guard, None),
                Err(poisoned) => {
                    tracing::error!(
                        instance,
                        slot = index,
                        "instrument control poisoned during teardown"
                    );
                    (
                        poisoned.into_inner(),
                        Some(InstrumentSlotTeardownFailure::ControlPoisoned),
                    )
                }
            };
            let Some(control) = guard.as_ref() else {
                tracing::error!(
                    instance,
                    slot = index,
                    "instrument control missing during teardown"
                );
                return Err(InstrumentSlotTeardownFailure::ControlMissing);
            };
            (
                InstrumentSlotTeardownResources::from_entry(
                    index,
                    &control.slots[index],
                    child_slot.clone(),
                ),
                control_failure,
            )
        };
        let teardown = self.teardown_outproc_instrument_resources(instance, resources);
        match (control_failure, teardown) {
            (Some(failure), _) => Err(failure),
            (None, result) => result,
        }
    }

    #[cfg(feature = "outproc-instrument")]
    fn teardown_outproc_instrument_resources(
        &self,
        instance: &str,
        resources: InstrumentSlotTeardownResources,
    ) -> Result<(), InstrumentSlotTeardownFailure> {
        let InstrumentSlotTeardownResources {
            index,
            child_slot,
            shm_path,
            child_exe,
            sample_rate,
            stats,
            engaged,
            drain_requested,
            drain_done,
            source_dests,
        } = resources;

        engaged.store(false, Ordering::Release);
        drain_done.store(false, Ordering::Release);
        drain_requested.store(true, Ordering::Release);
        let deadline = std::time::Instant::now() + INSTRUMENT_DRAIN_TIMEOUT;
        let drain_acked = loop {
            if drain_done.load(Ordering::Acquire) {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                tracing::warn!(
                    instance,
                    slot = index,
                    timeout_ms = INSTRUMENT_DRAIN_TIMEOUT.as_millis(),
                    "instrument event drain-and-discard ack timed out; slot quarantined from free-list"
                );
                break false;
            }
            std::thread::sleep(INSTRUMENT_DRAIN_POLL);
        };

        let supervisor = {
            let mut slot = lock_child_slot_recovering(&child_slot, "instrument slot teardown");
            match std::mem::replace(&mut *slot, ChildSlot::Closed) {
                ChildSlot::Active { _supervisor, .. } => _supervisor,
                other => {
                    *slot = other;
                    tracing::error!(
                        instance,
                        slot = index,
                        "instrument replacement teardown expected an Active old slot"
                    );
                    return Err(InstrumentSlotTeardownFailure::SlotNotActive);
                }
            }
        };

        let reset_error = match orbit_audio_sandbox::open_shared(&shm_path) {
            Ok(mmap) => {
                let region = orbit_audio_sandbox::region_ptr(&mmap);
                detach_and_reset_control_run::<InstrumentRole>(supervisor, region);
                None
            }
            Err(error) => {
                InstrumentRole::detach_keep_shm(supervisor);
                tracing::warn!(
                    instance,
                    slot = index,
                    ?shm_path,
                    %error,
                    "instrument slot control reset mapping failed; slot quarantined from free-list"
                );
                Some(error.to_string())
            }
        };
        stats.current_child_pid.store(0, Ordering::Relaxed);
        // Tenant handoff is the same host-side discontinuity as a watchdog respawn, but it is not
        // an actual respawn. A separate generation asks the RT adapter to reset VoiceTable without
        // corrupting respawn_count diagnostics (and the R11 no-respawn invariant).
        stats.measurement_invalid.store(false, Ordering::Release);
        stats.probe_live_count.store(0, Ordering::Relaxed);
        stats.tenant_generation.fetch_add(1, Ordering::Relaxed);

        let launch = ChildLaunch::<InstrumentRole> {
            shm_path,
            child_exe,
            sample_rate,
            stats,
            engaged,
            cleanup_shm_on_drop: true,
        };
        *lock_child_slot_recovering(&child_slot, "instrument slot teardown completion") =
            ChildSlot::Empty(launch);

        if drain_acked && reset_error.is_none() {
            for dest in &source_dests {
                dest.store(orbit_audio_native::SourceDest::Master);
            }
            drain_requested.store(false, Ordering::Release);
            drain_done.store(false, Ordering::Release);
            return Ok(());
        }
        match (drain_acked, reset_error) {
            (false, Some(error)) => {
                Err(InstrumentSlotTeardownFailure::DrainAckTimeoutAndResetMapping(error))
            }
            (false, None) => Err(InstrumentSlotTeardownFailure::DrainAckTimeout),
            (true, Some(error)) => Err(InstrumentSlotTeardownFailure::ResetMapping(error)),
            (true, None) => unreachable!("successful teardown returned above"),
        }
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn resolve_outproc_slot(
        &self,
        target: &PluginStateTarget,
        error_kind: OutProcSlotErrorKind,
    ) -> Result<ResolvedOutProcSlot, WrapError> {
        match target {
            #[cfg(feature = "outproc-effect")]
            PluginStateTarget::Effect { bus } => {
                let control_guard = self
                    .outproc
                    .lock()
                    .map_err(|_| error_kind.target("outproc effect mutex poisoned".into()))?;
                let control = control_guard.as_ref().ok_or_else(|| {
                    error_kind.unavailable("outproc effect is not initialized".into())
                })?;
                let (slot, chain) = match bus {
                    Some(bus) => (
                        control
                            .bus_slots
                            .get(bus)
                            .ok_or_else(|| {
                                error_kind.target(format!("unknown effect bus '{bus}'"))
                            })?
                            .upgrade()
                            .ok_or_else(|| {
                                error_kind.target(format!("effect bus '{bus}' stream is closed"))
                            })?,
                        control
                            .bus_entries
                            .get(bus)
                            .ok_or_else(|| {
                                error_kind.target(format!(
                                    "effect bus '{bus}' is missing its chain config"
                                ))
                            })?
                            .chain
                            .clone(),
                    ),
                    None => (
                        control.child_slot.upgrade().ok_or_else(|| {
                            error_kind.target("master effect stream is closed".into())
                        })?,
                        control.master_entry.chain.clone(),
                    ),
                };
                Ok(ResolvedOutProcSlot::Effect { slot, chain })
            }
            #[cfg(feature = "outproc-instrument")]
            PluginStateTarget::Instrument { instance } => {
                let control_guard = self
                    .outproc_instrument
                    .lock()
                    .map_err(|_| error_kind.target("outproc instrument mutex poisoned".into()))?;
                let control = control_guard.as_ref().ok_or_else(|| {
                    error_kind.unavailable("outproc instrument is not initialized".into())
                })?;
                let slot_index = control.instance_index.get(instance).ok_or_else(|| {
                    error_kind.target(format!("unknown instrument instance '{instance}'"))
                })?;
                let slot = control.slots[*slot_index]
                    .child_slot
                    .upgrade()
                    .ok_or_else(|| {
                        error_kind
                            .target(format!("instrument instance '{instance}' stream is closed"))
                    })?;
                Ok(ResolvedOutProcSlot::Instrument(slot))
            }
        }
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn plugin_ui_handles_for_target(
        &self,
        target: &PluginStateTarget,
        chain_index: usize,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
        self.resolve_outproc_slot(target, OutProcSlotErrorKind::Ui)?
            .ui_handles(chain_index)
    }

    /// Ack correlation is entirely `(generation, window, evt_seq)`. Unlike open/close, a late ack
    /// must still reach the child slot after the stage that originated it has been dropped.
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn plugin_ui_handles_for_ack(
        &self,
        target: &PluginStateTarget,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
        self.resolve_outproc_slot(target, OutProcSlotErrorKind::Ui)?
            .ui_handles_without_stage_validation()
    }

    /// OPEN_UI は view attach 完了 ack を待つ。window title は mailbox `cmd_arg` で child へ渡す。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn open_outproc_plugin_ui(
        &self,
        target: PluginStateTarget,
        index: u64,
        window_title: String,
        window: Option<u64>,
    ) -> Result<(), WrapError> {
        if window_title.trim().is_empty() {
            return Err(WrapError::PluginUiProtocol(
                "windowTitle must be a non-empty string".into(),
            ));
        }
        let ((mailbox, pump, route, index_binding), rack_target) =
            self.plugin_ui_handles_for_target(&target, index as usize)?;
        if !mailbox.child_is_ready().map_err(plugin_ui_mailbox_error)? {
            return Err(WrapError::PluginUiUnavailable(
                "the selected child is starting or respawning".into(),
            ));
        }
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        let binding_index = u32::try_from(index).map_err(|_| {
            WrapError::PluginUiTarget(format!("plugin UI chain index {index} exceeds u32"))
        })?;
        if let (Some(window), Some(index_binding)) = (key, index_binding.as_ref()) {
            let mut binding = index_binding.lock().map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI index binding poisoned".into())
            })?;
            if let Some(existing) = binding.get(&binding_index) {
                return Err(WrapError::PluginUiProtocol(format!(
                    "OPEN_UI requested while lifecycle is Open (chain index {index} is bound to window {existing})"
                )));
            }
            // Reserve before the blocking child command so concurrent MCP opens cannot both pass
            // the loud duplicate-open gate. Failure paths below roll this reservation back.
            binding.insert(binding_index, window);
        }
        if let Err(error) = pump.begin_open(key) {
            remove_plugin_ui_binding(&index_binding, binding_index, key);
            return Err(plugin_ui_pump_error(error));
        }
        let rendered_target = PluginUiTarget::from_state_target(&target, index, key);
        match route.lock() {
            Ok(mut route) => {
                if route.insert(key, rendered_target.clone()).is_some() {
                    pump.finish_open(key, false).map_err(plugin_ui_pump_error)?;
                    remove_plugin_ui_binding(&index_binding, binding_index, key);
                    return Err(WrapError::PluginUiProtocol(format!(
                        "OPEN_UI requested while lifecycle is Open (window {key:?} already has a route)"
                    )));
                }
            }
            Err(_) => {
                pump.finish_open(key, false).map_err(plugin_ui_pump_error)?;
                remove_plugin_ui_binding(&index_binding, binding_index, key);
                return Err(WrapError::PluginUiProtocol(
                    "plugin UI target coordinator poisoned".into(),
                ));
            }
        }
        let result = if rack_target {
            let argument = serde_json::to_string(&serde_json::json!({
                "index": index,
                "title": window_title,
                "window": key.expect("rack window token was required above"),
            }))
            .map_err(|error| WrapError::PluginUiProtocol(error.to_string()))?;
            mailbox.issue_open_ui_at(&argument)
        } else {
            mailbox.issue_open_ui(&window_title)
        }
        .map(|_| ())
        .map_err(plugin_ui_mailbox_error);
        let finish = pump
            .finish_open(key, result.is_ok())
            .map_err(plugin_ui_pump_error);
        if result.is_err() || finish.is_err() {
            if let Ok(mut route) = route.lock() {
                if route.get(&key) == Some(&rendered_target) {
                    route.remove(&key);
                }
            }
            remove_plugin_ui_binding(&index_binding, binding_index, key);
        }
        finish?;
        result
    }

    /// CLOSE_UI response is Phase A acceptance only. Completion is broadcast exclusively from
    /// the pump's `UI_CLOSED_DONE` observation.
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn close_outproc_plugin_ui(
        &self,
        target: PluginStateTarget,
        index: u64,
        window: Option<u64>,
    ) -> Result<(), WrapError> {
        let ((mailbox, _pump, route, index_binding), rack_target) =
            self.plugin_ui_handles_for_target(&target, index as usize)?;
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        if rack_target {
            let binding_index = u32::try_from(index).map_err(|_| {
                WrapError::PluginUiTarget(format!("plugin UI chain index {index} exceeds u32"))
            })?;
            let binding = index_binding
                .as_ref()
                .ok_or_else(|| {
                    WrapError::PluginUiProtocol("rack plugin UI index binding is missing".into())
                })?
                .lock()
                .map_err(|_| {
                    WrapError::PluginUiProtocol("plugin UI index binding poisoned".into())
                })?;
            if binding.get(&binding_index).copied() != key {
                return Err(WrapError::PluginUiTarget(format!(
                    "requested UI window {key:?} does not match chain index {index} binding {:?}",
                    binding.get(&binding_index)
                )));
            }
        }
        let current = route
            .lock()
            .map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI target coordinator poisoned".into())
            })?
            .get(&key)
            .cloned();
        if !current
            .as_ref()
            .is_some_and(|current| current.matches_state_target(&target))
        {
            return Err(WrapError::PluginUiTarget(format!(
                "requested UI target {target:?} window {key:?} is not the currently open target {current:?}"
            )));
        }
        if rack_target {
            let argument = serde_json::to_string(&serde_json::json!({
                "index": index,
                "window": key.expect("rack window token was required above"),
            }))
            .map_err(|error| WrapError::PluginUiProtocol(error.to_string()))?;
            mailbox.issue_close_ui_at(&argument)
        } else {
            mailbox.issue_close_ui()
        }
        .map(|_| ())
        .map_err(plugin_ui_mailbox_error)
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn ack_outproc_ui_safepoint(
        &self,
        target: PluginStateTarget,
        _index: u64,
        window: Option<u64>,
        generation: u64,
        evt_seq: u64,
    ) -> Result<(), WrapError> {
        let ((_mailbox, pump, route, _index_binding), rack_target) =
            self.plugin_ui_handles_for_ack(&target)?;
        let key = if rack_target {
            Some(window.ok_or_else(|| {
                WrapError::PluginUiProtocol("rack plugin UI requires a window token".into())
            })?)
        } else {
            None
        };
        let current = route
            .lock()
            .map_err(|_| {
                WrapError::PluginUiProtocol("plugin UI target coordinator poisoned".into())
            })?
            .get(&key)
            .cloned();
        // timeout-without-save の DONE 後は route が消えるが、spec が許す遅着保存 ack は同じ
        // target の slot/pump へ届ける。別の UI が既に open なら誤配送として拒否する。
        let matches_route = current
            .as_ref()
            .is_none_or(|current| current.matches_state_target(&target));
        if !matches_route {
            return Err(WrapError::PluginUiTarget(format!(
                "AckUiSafepoint target does not match current UI target {current:?}"
            )));
        }
        pump.ack_safepoint(generation, key, evt_seq)
            .map_err(plugin_ui_pump_error)
    }

    /// out-of-process childへstate保存を1回だけ発行し、同一directoryの一時ファイルを
    /// 検証後に最終パスへatomic renameする。P1 完了後は演奏中も許可される。
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub fn save_outproc_plugin_state(
        &self,
        target: PluginStateTarget,
        chain_index: usize,
        final_path: PathBuf,
    ) -> Result<SavedPluginStateSummary, WrapError> {
        if !final_path.is_absolute() {
            return Err(WrapError::PluginStateIo(format!(
                "state path must be absolute: {final_path:?}"
            )));
        }

        let handles = self
            .resolve_outproc_slot(&target, OutProcSlotErrorKind::State)?
            .state_handles(chain_index)?;
        let mailbox = handles.mailbox();

        if !mailbox
            .child_is_ready()
            .map_err(plugin_state_mailbox_error)?
        {
            return Err(WrapError::PluginStateNotReady(
                "the selected child is starting or respawning".into(),
            ));
        }

        let parent = final_path.parent().ok_or_else(|| {
            WrapError::PluginStateIo(format!("state path has no parent: {final_path:?}"))
        })?;
        std::fs::create_dir_all(parent).map_err(|error| {
            WrapError::PluginStateIo(format!("create state directory {parent:?}: {error}"))
        })?;
        let file_name = final_path.file_name().ok_or_else(|| {
            WrapError::PluginStateIo(format!("state path has no file name: {final_path:?}"))
        })?;
        let temp_path = parent.join(format!(
            ".{}.orbit-state-{}.tmp",
            file_name.to_string_lossy(),
            Uuid::new_v4().simple()
        ));

        let response = match handles.issue_save(&temp_path) {
            Ok(response) => response,
            Err(error) => {
                if !matches!(
                    &error,
                    orbit_audio_sandbox::CommandMailboxError::Timeout { .. }
                ) {
                    let _ = std::fs::remove_file(&temp_path);
                } else {
                    tracing::warn!(
                        ?temp_path,
                        "state mailbox timed out; retaining unique sidecar until child ack/reset"
                    );
                }
                return Err(plugin_state_mailbox_error(error));
            }
        };
        if response.bytes_written == 0 {
            let _ = std::fs::remove_file(&temp_path);
            return Err(WrapError::PluginStateUnsupported(
                "plugin returned an empty state".into(),
            ));
        }
        let actual_len = match std::fs::metadata(&temp_path) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(WrapError::PluginStateIo(format!(
                    "stat state sidecar {temp_path:?} after child ack: {error}"
                )));
            }
        };
        if actual_len != response.bytes_written {
            let _ = std::fs::remove_file(&temp_path);
            return Err(WrapError::PluginStateProtocol(format!(
                "child ack reported {} bytes but sidecar has {actual_len} bytes",
                response.bytes_written
            )));
        }
        std::fs::rename(&temp_path, &final_path).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            WrapError::PluginStateIo(format!(
                "atomically replace state file {final_path:?}: {error}"
            ))
        })?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                WrapError::PluginStateIo(format!(
                    "sync state directory {parent:?} after rename: {error}"
                ))
            })?;
        handles.record_latest_state(final_path.clone())?;

        Ok(SavedPluginStateSummary {
            path: final_path,
            bytes_written: response.bytes_written,
        })
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn load_outproc_plugin_impl<R: OutProcRole>(
        &self,
        child_slot: Arc<Mutex<ChildSlot<R>>>,
        path: PathBuf,
        plugin_id: Option<String>,
        state: Option<PathBuf>,
    ) -> Result<LoadedPluginSummary, WrapError> {
        let _role_name = R::ROLE_NAME;
        let mut slot = lock_child_slot_recovering(&child_slot, "initial state check");

        match &*slot {
            ChildSlot::Active {
                path: active_path,
                plugin_id: active_plugin_id,
                state: active_state,
                engaged,
                ..
            } if active_path == &path
                && active_plugin_id == &plugin_id
                && active_state == &state =>
            {
                // READY を確認済みの Active だけがここへ来る。冪等再送でも gate を維持する。
                engaged.store(true, Ordering::Release);
                return Ok(outproc_plugin_summary(active_path, active_plugin_id));
            }
            ChildSlot::Active {
                path: active_path,
                plugin_id: active_plugin_id,
                state: active_state,
                ..
            } if active_path == &path && active_plugin_id == &plugin_id => {
                // 同一 path/plugin_id だが state が異なる = 音色の差し替え要求（#540 P2）。
                // v1 は他の差し替えと同様に拒否する（黙って古い音色のまま Ok を返さない）。
                return Err(R::runtime_error(format!(
                    "outproc plugin already loaded from {active_path:?} with state {active_state:?}; \
                     v1 does not support replacement with state {state:?} (restart the engine to change the sound)"
                )));
            }
            ChildSlot::Active {
                path: active_path,
                plugin_id: active_plugin_id,
                ..
            } if active_path == &path => {
                // 同一 path だが plugin_id が異なる = bundle 内の別サブプラグインへの差し替え
                // 要求。path 差し替えと同様 v1 は拒否する（呼び出し側が指定した plugin_id を
                // 握り潰して古い plugin_id のまま黙って Ok を返さない）。
                return Err(R::runtime_error(format!(
                    "outproc plugin already loaded from {active_path:?} with plugin_id {active_plugin_id:?}; v1 does not support replacement with plugin_id {plugin_id:?}"
                )));
            }
            ChildSlot::Active {
                path: active_path, ..
            } => {
                return Err(R::runtime_error(format!(
                    "outproc plugin already loaded from {active_path:?}; v1 does not support replacement with {path:?}"
                )));
            }
            ChildSlot::Loading {
                path: loading_path, ..
            } => {
                return Err(R::runtime_error(format!(
                    "outproc plugin load already in progress for {loading_path:?}"
                )));
            }
            ChildSlot::Closed => {
                return Err(WrapError::OutProcSlotClosed(
                    "outproc child slot is closed after an unrecoverable attach failure".into(),
                ));
            }
            ChildSlot::Empty(_) => {}
        }

        let mut launch = match std::mem::replace(&mut *slot, ChildSlot::Closed) {
            ChildSlot::Empty(launch) => launch,
            _ => unreachable!("ChildSlot state was checked while holding the same mutex"),
        };
        if let Err(error) = R::select_child_exe(&mut launch, &path) {
            *slot = ChildSlot::Empty(launch);
            return Err(R::runtime_error(error));
        }
        *slot = ChildSlot::Loading { path: path.clone() };
        // Loading 書き込みを可視化した直後にロックを解放する。以降の shm open・spawn・
        // ready-ack poll（最大 CHILD_READY_TIMEOUT）はロック外で行う。他の LoadPlugin
        // 呼び出しは Loading を即座に観測して「in progress」で失敗できる（この関数だけが
        // Loading→Active/Closed/Empty へ遷移させるため、再取得後も Loading のままである
        // ことが保証される。teardown は child_slot の Arc を保持するだけで .lock() しない）。
        drop(slot);

        let ready_mmap = match orbit_audio_sandbox::open_shared(&launch.shm_path) {
            Ok(mmap) => mmap,
            Err(error) => {
                let mut slot = lock_child_slot_recovering(&child_slot, "open_shared failure");
                debug_assert_slot_loading(&slot);
                *slot = ChildSlot::Closed;
                return Err(R::runtime_error(format!(
                    "open child readiness mapping {:?}: {error}",
                    launch.shm_path
                )));
            }
        };
        let region = orbit_audio_sandbox::region_ptr(&ready_mmap);
        let mailbox = Arc::new(orbit_audio_sandbox::CommandMailboxHost::new(
            launch.shm_path.clone(),
        ));
        let ui_pump = Arc::new(orbit_audio_sandbox::UiEventPump::new(
            launch.shm_path.clone(),
        ));
        let ui_target = Arc::new(Mutex::new(Default::default()));
        let ui_index_binding =
            R::SUPPORTS_INDEXED_UI.then(|| Arc::new(Mutex::new(Default::default())));
        // 初回 attach も同じ reset 経路を通す。まだ child は生存していないため、
        // 「旧 child の死亡確認後のみ reset」の前提を満たす。
        ui_pump
            .reset_after_child_exit(&mailbox)
            .map_err(|error| R::runtime_error(format!("reset UI event pump: {error}")))?;

        // spawn 前にセットしておくことで、即座に終了する child が通常の respawn 経路に紛れ込むのを防ぐ。
        R::set_initial_attach_pending(&launch.stats, true);
        R::child_early_exit(&launch.stats).arm_for_new_attempt();
        let first_child =
            match R::spawn_child(&launch, &path, plugin_id.as_deref(), state.as_deref()) {
                Ok(child) => child,
                Err(error) => {
                    let child_exe = launch.child_exe.clone();
                    let mut slot = lock_child_slot_recovering(&child_slot, "child spawn failure");
                    debug_assert_slot_loading(&slot);
                    *slot = ChildSlot::Empty(launch);
                    return Err(R::runtime_error(format!(
                        "spawn outproc child {:?}: {error}",
                        child_exe
                    )));
                }
            };
        R::set_current_child_pid(&launch.stats, first_child.id());

        let latest_state = Arc::new(Mutex::new(state.clone()));
        let supervisor = match R::spawn_supervisor(
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
                events: self.plugin_ui_events.clone(),
            },
        ) {
            Ok(supervisor) => supervisor,
            Err(error) => {
                // spawn_outproc_supervisor はエラー時に自身の cleanup で shm を unlink して返るため、
                // この slot は再利用不能。launch の fallback unlink は解除。
                launch.cleanup_shm_on_drop = false;
                let mut slot = lock_child_slot_recovering(&child_slot, "supervisor spawn failure");
                debug_assert_slot_loading(&slot);
                *slot = ChildSlot::Closed;
                return Err(R::runtime_error(format!("spawn outproc watchdog: {error}")));
            }
        };

        let deadline = std::time::Instant::now() + CHILD_READY_TIMEOUT;
        loop {
            // Acquire で READY を観測した後の flags load は child の publish 順と同期する。
            let status = unsafe { (*region).child_status.load(Ordering::Acquire) };
            if status == orbit_audio_sandbox::transport::CHILD_STATUS_READY {
                let flags = unsafe { (*region).child_flags.load(Ordering::Acquire) };
                if !R::role_matches(flags) {
                    return Err(retryable_attach_failure(
                        supervisor,
                        region,
                        &child_slot,
                        launch,
                        format!(
                            "loaded plugin role does not match daemon role (child_flags={flags:#x})"
                        ),
                    ));
                }
                R::set_initial_attach_pending(&launch.stats, false);
                break;
            }
            let early_exit = R::child_early_exit(&launch.stats);
            if early_exit.fired() {
                // 終了理由まで載せる（#622）。「exited」だけでは SIGKILL（資源圧で殺された）と
                // child 自身のエラー終了を区別できず、受け取った側が次に何を見ればよいか
                // 分からない。watchdog は既に status を tracing へ出しているが、**呼び出し元へ
                // 返るエラーには乗っていなかった**。
                const EXITED: &str = "child exited before publishing READY";
                let detail = match early_exit.reason() {
                    Some(status) => format!("{EXITED} ({status})"),
                    None => {
                        // `record` は理由 → 事実の順で書くので、fired が立っていて理由が無いのは
                        // 現構造では不到達。**黙って汎用文言へ退化させない**（#629 レビュー）—
                        // 退化すると #622 が問題にした「SIGKILL か child のエラー終了か区別
                        // できない」状態へ、警告も無く逆戻りする。
                        tracing::warn!(
                            "child early exit fired without a recorded reason; \
                             the attach failure will not say why the child died"
                        );
                        EXITED.to_string()
                    }
                };
                return Err(retryable_attach_failure(
                    supervisor,
                    region,
                    &child_slot,
                    launch,
                    detail,
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Err(retryable_attach_failure(
                    supervisor,
                    region,
                    &child_slot,
                    launch,
                    format!(
                        "timed out waiting {:?} for child READY",
                        CHILD_READY_TIMEOUT
                    ),
                ));
            }
            std::thread::sleep(CHILD_READY_POLL);
        }

        launch.engaged.store(true, Ordering::Release);
        let summary = outproc_plugin_summary(&path, &plugin_id);
        // Active supervisor が以後の unlink を所有する。local launch の fallback cleanup は解除する。
        launch.cleanup_shm_on_drop = false;
        let mut slot = lock_child_slot_recovering(&child_slot, "successful attach");
        debug_assert_slot_loading(&slot);
        *slot = ChildSlot::Active {
            path,
            plugin_id,
            state,
            latest_state,
            engaged: launch.engaged.clone(),
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding,
            _supervisor: supervisor,
        };
        Ok(summary)
    }

    // ── CLAP plugin hosting（feature `clap-host` 専用・Issue #340）─────────────────────

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
                    channels: self.channels as usize,
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

    /// ロード済み CLAP プラグインへ NoteOn を送る（event ring 経由・非ブロッキング・feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_on(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        // in-process CLAP は単一インスタンスなので instance 指定は縮退する（#540 P1）。
        let _ = instance;
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOn {
            key,
            channel,
            velocity,
        })
    }

    /// ロード済み CLAP プラグインへ NoteOff を送る（feature 専用）。
    #[cfg(feature = "clap-host")]
    pub fn plugin_note_off(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        let _ = instance;
        self.push_plugin_event(orbit_clap_host::PluginEvent::NoteOff {
            key,
            channel,
            velocity,
        })
    }

    /// Out-of-process instrument NoteOn. Conversion to the format-neutral wire event happens on
    /// this control-side method; the audio thread only pops already-converted events.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_on(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(
            orbit_audio_sandbox::NeutralEvent::NoteOn {
                sample_offset: 0,
                addr: Self::outproc_instrument_voice_addr(channel, key),
                velocity,
                tuning_cents: 0.0,
                length_frames: 0,
            },
            instance.as_deref(),
        )?;
        let name = instance
            .as_deref()
            .unwrap_or(DEFAULT_INSTRUMENT_INSTANCE)
            .to_string();
        self.active_plugin_notes
            .lock()
            .map_err(|_| {
                WrapError::OutProcInstrument("active plugin note tracker mutex poisoned".into())
            })?
            .insert((name, channel, key));
        Ok(())
    }

    /// Out-of-process instrument NoteOff, converted on the control side.
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    pub fn plugin_note_off(
        &self,
        key: u8,
        channel: u8,
        velocity: f64,
        instance: Option<String>,
    ) -> Result<(), WrapError> {
        self.push_outproc_instrument_event(
            orbit_audio_sandbox::NeutralEvent::NoteOff {
                sample_offset: 0,
                addr: Self::outproc_instrument_voice_addr(channel, key),
                velocity,
            },
            instance.as_deref(),
        )?;
        let name = instance
            .as_deref()
            .unwrap_or(DEFAULT_INSTRUMENT_INSTANCE)
            .to_string();
        self.active_plugin_notes
            .lock()
            .map_err(|_| {
                WrapError::OutProcInstrument("active plugin note tracker mutex poisoned".into())
            })?
            .remove(&(name, channel, key));
        Ok(())
    }

    /// Builds the `VoiceAddr` shared by `plugin_note_on`/`plugin_note_off` for the
    /// out-of-process instrument path (single-port, note-id-less MIDI addressing).
    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn outproc_instrument_voice_addr(channel: u8, key: u8) -> orbit_audio_sandbox::VoiceAddr {
        orbit_audio_sandbox::VoiceAddr {
            note_id: -1,
            port_index: 0,
            channel: channel as i16,
            key: key as i16,
            _pad: 0,
        }
    }

    #[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
    fn push_outproc_instrument_event(
        &self,
        event: orbit_audio_sandbox::NeutralEvent,
        instance: Option<&str>,
    ) -> Result<(), WrapError> {
        let mut guard = self.outproc_instrument.lock().map_err(|_| {
            WrapError::OutProcInstrument("outproc instrument mutex poisoned".into())
        })?;
        let control = guard.as_mut().ok_or_else(|| {
            WrapError::OutProcInstrumentUnavailable(
                "outproc instrument not initialized (test backend)".into(),
            )
        })?;
        // #540 P1: instance → slot の解決。未割当の instance への note は「未ロード」と同義
        // なので明示エラーにする（旧単数時代は ring へ積んで黙って捨てられていた — 診断の改善）。
        let name = instance.unwrap_or(DEFAULT_INSTRUMENT_INSTANCE);
        let Some(&index) = control.instance_index.get(name) else {
            return Err(WrapError::OutProcInstrument(format!(
                "unknown instrument instance '{name}' (LoadPlugin has not assigned it a slot)"
            )));
        };
        let slot = control
            .slots
            .get_mut(index)
            .expect("instance_index always maps to a pre-allocated slot");
        slot.event_tx.push(event).map_err(|_| {
            self.plugin_event_ring_overflow_count
                .fetch_add(1, Ordering::Relaxed);
            // 診断の同一性方針（#542 レビュー）: N 台化したエラーは instance を名指しする
            // （unknown-instance / pool-exhausted と対称）。
            WrapError::OutProcInstrument(format!("instrument note ring full (instance '{name}')"))
        })
    }

    #[cfg(feature = "clap-host")]
    fn push_plugin_event(&self, ev: orbit_clap_host::PluginEvent) -> Result<(), WrapError> {
        // #405: プラグイン未ロード時は event ring に投げても audio thread が黙って drain して
        // 捨てるだけ（fire-and-forget ring の設計上ロード状態の同期確認は本来 cross-thread
        // round-trip が要る）。少なくとも「一度もロードに成功していない」ことは control スレッド
        // 側でここまで同期的に判定できるので、その場合は明示的なエラーを返す（嘘の成功応答を防ぐ）。
        // 残存課題（Issue #410）: このガードは「LoadPlugin の応答が成功した」ことしか検知できない。
        // 応答成功後 audio thread が install ring から実際に pop してインストールするまでの狭い
        // window では `plugin_loaded == true` かつ install 未完了になりうる。その window で送った
        // note はガードを通過して `Ok(())` を返すが audio thread 側は無音のままドレインする（同種の
        // false-success が window 限定で残る・追跡は Issue #410）。cross-thread ack の追加は
        // #405/#407 では scope 外（owner 判断待ち）。
        if !self.plugin_loaded.load(Ordering::Relaxed) {
            return Err(WrapError::ClapNotLoaded(
                "no plugin loaded (send LoadPlugin first)".into(),
            ));
        }
        // event ring（1024 slot）が満杯でも、audio callback が毎 block 全量 drain するので
        // bounded retry で lossless 化する（#400）。真にタイムアウトした場合のみ error。
        // mutex は各試行ごとに取得・解放し、sleep 中は保持しない（load_plugin と同じ「lock は
        // send までで解放」規約・#402 レビュー指摘: sleep 中も保持すると他セッションの
        // LoadPlugin/PluginNoteOn 等を最大リトライ時間だけ足止めしてしまう）。
        push_with_bounded_retry(
            |item| {
                let mut guard = match self.clap.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        return PushAttemptOutcome::Fatal(WrapError::Clap(
                            "clap mutex poisoned".into(),
                        ))
                    }
                };
                let ctl = match guard.as_mut() {
                    Some(ctl) => ctl,
                    None => {
                        return PushAttemptOutcome::Fatal(WrapError::ClapUnavailable(
                            "clap host not initialized (test backend)".into(),
                        ))
                    }
                };
                match ctl.event_tx.push(item) {
                    Ok(()) => PushAttemptOutcome::Sent,
                    Err(rtrb::PushError::Full(returned)) => PushAttemptOutcome::Full(returned),
                }
            },
            ev,
            PLUGIN_EVENT_RETRY_MAX_ATTEMPTS,
            PLUGIN_EVENT_RETRY_INTERVAL,
            &self.plugin_event_ring_overflow_count,
        )
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（#420 PR #422
    /// Part 2 で `cfg` を `outproc-instrument` にも拡張したが、このコメントは `clap-host` 単独無効
    /// としか書いておらず実際の条件と食い違っていた — comment-analyzer round 3 指摘）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_on(
        &self,
        _key: u8,
        _channel: u8,
        _velocity: f64,
        _instance: Option<String>,
    ) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// feature `clap-host` と `outproc-instrument` の両方が無効なビルド用の stub（上の
    /// `plugin_note_on` stub と同じ食い違い・同じ修正）。
    #[cfg(not(any(feature = "clap-host", feature = "outproc-instrument")))]
    pub fn plugin_note_off(
        &self,
        _key: u8,
        _channel: u8,
        _velocity: f64,
        _instance: Option<String>,
    ) -> Result<(), WrapError> {
        Err(WrapError::ClapUnavailable(
            "engine built without 'clap-host' or 'outproc-instrument' feature".into(),
        ))
    }

    /// test harness 用: CLAP post-mix peak（plugin add-mix 後の絶対値ピーク）。発音検証に使う。
    /// `#[doc(hidden)]`。plugin 未ロード / clap 無効時は 0.0。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_post_peak(&self) -> f32 {
        match self.clap.lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| f32::from_bits(c.stats.post_peak_bits.load(Ordering::Relaxed)))
                .unwrap_or(0.0),
            // poison を「plugin 未ロード」と同じ 0.0 で握り潰すと、gated テストが
            // 「発音しなかった」と誤診断する。warn で root cause を残す（silent-failure 対策）。
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_post_peak returning 0.0");
                0.0
            }
        }
    }

    /// test harness / RT 監視用: callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。clap 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        let guard = match self.clap.lock() {
            Ok(g) => g,
            Err(_) => {
                tracing::warn!("clap mutex poisoned; clap_callback_stats returning None");
                return None;
            }
        };
        guard.as_ref().map(|c| c.cb_stats.snapshot())
    }

    /// test harness 用: CLAP post-mix peak をリセットする。effect 検証の two-phase 計測で
    /// baseline（plugin 無し）と effect（plugin 有り）の位相を分けるために使う。`#[doc(hidden)]`。
    #[cfg(feature = "clap-host")]
    #[doc(hidden)]
    pub fn clap_reset_post_peak(&self) {
        match self.clap.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_post_peak();
                }
            }
            // reset が黙って no-op だと、後続の two-phase 計測が baseline 汚染で誤判定する。
            Err(_) => tracing::warn!("clap mutex poisoned; clap_reset_post_peak skipped"),
        }
    }

    /// ロード済み plugin の `process()` エラー累積回数（#340）。daemon の 1 Hz ticker が polling して
    /// 増加を `CLAP_PROCESS_ERROR` WARNING で surface する（非 RT observability）。effect は dry 素通し /
    /// instrument は無音になるため、この counter だけが失敗の可視化手段になる。
    /// `try_lock` で ticker をブロックしない: **WouldBlock** は cumulative counter なので次 tick が
    /// 全累積を報告する。**Poisoned** は `link_egress_ring_drops` と同様 warn で post-mortem の根拠を
    /// 残し、以降の発火を抑制する（contention と poison を同一視しない）。
    #[cfg(feature = "clap-host")]
    pub fn clap_process_error_count(&self) -> u64 {
        let control_errors = match self.clap.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| c.stats.process_error_count.load(Ordering::Relaxed))
                .unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "clap mutex poisoned; clap_process_error_count reporting 0 for control errors \
                     (CLAP_PROCESS_ERROR suppressed until daemon restart)"
                );
                0
            }
        };
        control_errors + self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// feature `clap-host` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "clap-host"))]
    pub fn clap_process_error_count(&self) -> u64 {
        self.clap_process_errors.load(Ordering::Relaxed)
    }

    /// `push_plugin_event` の bounded retry が力尽きた回数（#400）。event ring は audio callback
    /// が毎 block 全量 drain するため、通常は 0 のまま推移する health signal。1 Hz ticker が polling
    /// して増加を `PLUGIN_EVENT_RING_OVERFLOW` WARNING で surface する。feature `clap-host` 無効
    /// ビルドでも安全に呼べる（`clap_process_error_count` と同様 unconditional フィールド）。
    pub fn plugin_event_ring_overflow_count(&self) -> u64 {
        self.plugin_event_ring_overflow_count
            .load(Ordering::Relaxed)
    }

    /// test harness 用: `plugin_event_ring_overflow_count` を直接加算する注入 seam（#402
    /// pr-test-analyzer 指摘: sibling counter `link_egress_drops_arc`/`clap_process_errors_arc` に
    /// ある「1 Hz ticker の dedup latch（増加時のみ発火・据え置きでは再発火しない）」の integration
    /// test パターンが、この counter にはまだ無かった）。他の2つと違い `Arc` を返さないのは、この
    /// counter が別スレッドへ producer 側を outsource しない（`EngineWrap` 自身が bounded retry の
    /// 末に直接書く）フィールドだから（struct 定義側の doc 参照）— `&self` 越しの直接 `fetch_add` で
    /// 足りる。`#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn plugin_event_ring_overflow_inject(&self, n: u64) {
        self.plugin_event_ring_overflow_count
            .fetch_add(n, Ordering::Relaxed);
    }

    /// test harness / gated 計測用: OOP effect の観測スナップショット（fresh/stale/stall/respawn/
    /// child error 等）。slot 数決定（stale 率）と child crash 生存（respawn）の検証に使う。`#[doc(hidden)]`。
    /// plugin 未起動 / outproc 無効 / poison 時は None（poison は warn で区別）。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_stats(&self) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_stats returning None");
                None
            }
        }
    }

    /// test harness / gated 計測用: 特定の named insert bus（`ORBIT_EFFECT_BUSES`）に attach された
    /// OOP effect の観測スナップショット。master bus の [`Self::outproc_effect_stats`] と異なり、
    /// 未知の bus 名 / bus 未起動時は `None`（poison も `None`・warn で区別）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_effect_bus_stats(
        &self,
        bus: &str,
    ) -> Option<crate::outproc_effect::OutProcEffectSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g
                .as_ref()
                .and_then(|c| c.bus_stats.get(bus))
                .map(|stats| stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_effect_bus_stats returning None");
                None
            }
        }
    }

    /// test harness / RT 監視用: OOP effect の callback-duration スナップショット（A0 §6・budget 検証）。
    /// `#[doc(hidden)]`。outproc 無効時は None。poison 時も None だが warn で区別する。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_callback_stats(&self) -> Option<orbit_audio_native::CallbackTimeSnapshot> {
        match self.outproc.lock() {
            Ok(g) => g.as_ref().map(|c| c.cb_stats.snapshot()),
            Err(_) => {
                tracing::warn!("outproc mutex poisoned; outproc_callback_stats returning None");
                None
            }
        }
    }

    /// test harness 用: OOP effect の dry / post ピークをリセットする。kill-test / parity の two-phase
    /// 計測で位相を分けるのに使う（`clap_reset_post_peak` と同設計）。`#[doc(hidden)]`。
    #[cfg(feature = "outproc-effect")]
    #[doc(hidden)]
    pub fn outproc_reset_peaks(&self) {
        match self.outproc.lock() {
            Ok(g) => {
                if let Some(c) = g.as_ref() {
                    c.stats.reset_peaks();
                }
            }
            Err(_) => tracing::warn!("outproc mutex poisoned; outproc_reset_peaks skipped"),
        }
    }

    /// Gated instrument harness 用: OOP instrument の発音・child・respawn 観測値を返す。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_stats(
        &self,
    ) -> Option<crate::outproc_instrument::OutProcInstrumentSnapshot> {
        // #540 P1: 互換 accessor は slot 0（= 単数時代の唯一の slot）を返す。
        // instance 指定版は `outproc_instrument_stats_for` を使う。
        match self.outproc_instrument.lock() {
            Ok(guard) => guard
                .as_ref()
                .and_then(|control| control.slots.first().map(|slot| slot.stats.snapshot())),
            Err(_) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_stats returning None"
                );
                None
            }
        }
    }

    /// Gated instrument harness 用（#540 P1）: instance 指定で slot の観測値を返す。
    /// 未割当の instance は None。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_stats_for(
        &self,
        instance: &str,
    ) -> Option<crate::outproc_instrument::OutProcInstrumentSnapshot> {
        match self.outproc_instrument.lock() {
            Ok(guard) => guard.as_ref().and_then(|control| {
                let index = *control.instance_index.get(instance)?;
                control.slots.get(index).map(|slot| slot.stats.snapshot())
            }),
            Err(_) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_stats_for returning None"
                );
                None
            }
        }
    }

    /// Gated kill-test の計測位相を分けるため、instrument source の累積 peak をリセットする。
    #[cfg(feature = "outproc-instrument")]
    #[doc(hidden)]
    pub fn outproc_instrument_reset_post_peak(&self) {
        // #540 P1: 計測位相のリセットは全 slot に適用する（未使用 slot への reset は無害）。
        match self.outproc_instrument.lock() {
            Ok(guard) => {
                if let Some(control) = guard.as_ref() {
                    for slot in &control.slots {
                        slot.stats.reset_post_peak();
                    }
                }
            }
            Err(_) => tracing::warn!(
                "outproc instrument mutex poisoned; outproc_instrument_reset_post_peak skipped"
            ),
        }
    }

    /// OOP effect の health signal を `(child_process_error_count, respawn_count, measurement_invalid,
    /// frames_clamped)` で返す（daemon の 1 Hz ticker が polling して WARNING/FATAL event で surface する
    /// 非 RT observability）。`clap_process_error_count` と同様 `try_lock` で ticker をブロックしない
    /// （**WouldBlock** は cumulative なので次 tick が全累積を報告・**Poisoned** は warn して 0 を返し
    /// post-mortem の根拠を残す）。plugin 未起動 / outproc 無効時は `(0, 0, false, <injected>)`。
    ///
    /// `frames_clamped` は #404 で `OutProcEffectStats` から追加した 4 つ目の signal（block が
    /// `MAX_FRAMES` を超えて clamp された累積回数）。当初は独立した `outproc_frames_clamped()`
    /// accessor だったが、同一 tick 内で同一 `self.outproc` mutex を 2 回 `try_lock` + `snapshot` する
    /// ことになり（(a) 無駄な二重ロック (b) 4 signal が同一スナップショットである保証が消える —
    /// 片方が `WouldBlock` で 0 を返す間にもう片方が非ゼロを観測しうる）、#406 /simplify レビューで
    /// この 1 accessor に統合した。
    #[cfg(feature = "outproc-effect")]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        let injected = self.outproc_frames_clamped.load(Ordering::Relaxed);
        match self.outproc.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let s = c.stats.snapshot();
                    (
                        s.child_process_error_count,
                        s.respawn_count,
                        s.measurement_invalid,
                        s.frames_clamped + injected,
                    )
                })
                .unwrap_or((0, 0, false, injected)),
            Err(std::sync::TryLockError::WouldBlock) => (0, 0, false, injected),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc mutex poisoned; outproc_health reporting zeros \
                     (OUTPROC_EFFECT events suppressed until daemon restart)"
                );
                (0, 0, false, injected)
            }
        }
    }

    /// per-bus OOP effect の health を bus 名つきで列挙する（#461 review Critical: bus child の
    /// crash/respawn/計測無効/frames_clamped が ticker に出ない穴を塞ぐ）。master の
    /// [`Self::outproc_health`] と同型の tuple を bus ごとに返す。1 tick = 1 try_lock +
    /// snapshot 群（WouldBlock/Poisoned/未初期化は空 Vec = 次 tick 持ち越し）。
    #[cfg(feature = "outproc-effect")]
    pub fn outproc_effect_bus_health(&self) -> Vec<(String, (u64, u64, bool, u64))> {
        match self.outproc.try_lock() {
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    c.bus_stats
                        .iter()
                        .map(|(name, stats)| {
                            let s = stats.snapshot();
                            (
                                name.clone(),
                                (
                                    s.child_process_error_count,
                                    s.respawn_count,
                                    s.measurement_invalid,
                                    s.frames_clamped,
                                ),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }

    /// feature 無効ビルド用 stub（ticker 側を cfg なしで書けるようにする）。
    #[cfg(not(feature = "outproc-effect"))]
    pub fn outproc_effect_bus_health(&self) -> Vec<(String, (u64, u64, bool, u64))> {
        Vec::new()
    }

    /// 未登録 named target へ tag された event の skip 累計（core の retain ハザード観測点・
    /// `Scheduler::unroutable_event_count`）。lock 競合時は 0（cumulative なので次 tick で回収）。
    pub fn unroutable_event_count(&self) -> u64 {
        self.engine.unroutable_event_count().unwrap_or(0)
    }

    /// feature `outproc-effect` 無効ビルド用の stub。本番は常に `(0, 0, false, ...)`（control が無い）。
    /// `frames_clamped` は test 注入分のみ反映（`link_egress_ring_drops` / `clap_process_error_count`
    /// の無効ビルド stub と同設計）。
    #[cfg(not(feature = "outproc-effect"))]
    pub fn outproc_health(&self) -> (u64, u64, bool, u64) {
        (
            0,
            0,
            false,
            self.outproc_frames_clamped.load(Ordering::Relaxed),
        )
    }

    /// OOP instrument の全 health signal を `(child_process_error_count, respawn_count,
    /// measurement_invalid, output_event_dropped_count, output_event_spilled_count,
    /// output_note_end_dropped_count, event_decode_error_count)` で返す（daemon の 1 Hz ticker が polling して WARNING event
    /// で surface する非 RT observability）。`outproc_health()`（effect 側）と同じ「1 tick = 1
    /// try_lock + 1 snapshot」設計 — child-process 系 3 signal と output-event overflow 系 3 signal を
    /// 1 accessor に統合し、同一 tick 内で `outproc_instrument` mutex を複数回 `try_lock` する
    /// 二重ロック（(a) 無駄なロック (b) 6 signal が同一スナップショットである保証の消失）を避ける。
    ///
    /// try_lock 方針は `outproc_health()` と同じ: **WouldBlock** は次 tick に持ち越すだけ
    /// （cumulative なので drop しない）、**Poisoned** は warn して real 分を 0/false に丸める
    /// （injected 分は失わない）。instrument 未起動 / outproc-instrument 無効時は injected 分のみ返す。
    #[cfg(feature = "outproc-instrument")]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        let injected_errors = self.outproc_instrument_child_errors.load(Ordering::Relaxed);
        let injected_respawns = self.outproc_instrument_respawns.load(Ordering::Relaxed);
        let injected_invalid = self
            .outproc_instrument_measurement_invalid
            .load(Ordering::Relaxed);
        let injected_dropped = self
            .outproc_instrument_output_dropped
            .load(Ordering::Relaxed);
        match self.outproc_instrument.try_lock() {
            // #540 P1: slot pool の cumulative counter を合算し bool は OR する（1 Hz ticker の
            // WARNING surface は「どこかの instrument child が悪い」で十分。instance 別の詳細は
            // `outproc_instrument_stats_for` で個別に引ける）。
            Ok(g) => g
                .as_ref()
                .map(|c| {
                    let mut totals = (0u64, 0u64, false, 0u64, 0u64, 0u64, 0u64);
                    for slot in &c.slots {
                        let s = slot.stats.snapshot();
                        totals.0 += s.child_process_error_count;
                        totals.1 += s.respawn_count;
                        totals.2 |= s.measurement_invalid;
                        totals.3 += s.output_event_dropped_count;
                        totals.4 += s.output_event_spilled_count;
                        totals.5 += s.output_note_end_dropped_count;
                        totals.6 += s.event_decode_error_count;
                    }
                    (
                        totals.0 + injected_errors,
                        totals.1 + injected_respawns,
                        totals.2 || injected_invalid,
                        totals.3 + injected_dropped,
                        totals.4,
                        totals.5,
                        totals.6,
                    )
                })
                .unwrap_or((
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )),
            Err(std::sync::TryLockError::WouldBlock) => (
                injected_errors,
                injected_respawns,
                injected_invalid,
                injected_dropped,
                0,
                0,
                0,
            ),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "outproc instrument mutex poisoned; outproc_instrument_health reporting \
                     zeros for real stats (OUTPROC_INSTRUMENT_ERROR/_RESPAWN/_INVALID/ \
                     _OUTPUT_DROPPED events suppressed until daemon restart)"
                );
                (
                    injected_errors,
                    injected_respawns,
                    injected_invalid,
                    injected_dropped,
                    0,
                    0,
                    0,
                )
            }
        }
    }

    /// feature `outproc-instrument` 無効ビルド用の stub。本番は常に injected 分のみ（control が無い）。
    #[cfg(not(feature = "outproc-instrument"))]
    pub fn outproc_instrument_health(&self) -> (u64, u64, bool, u64, u64, u64, u64) {
        (
            self.outproc_instrument_child_errors.load(Ordering::Relaxed),
            self.outproc_instrument_respawns.load(Ordering::Relaxed),
            self.outproc_instrument_measurement_invalid
                .load(Ordering::Relaxed),
            self.outproc_instrument_output_dropped
                .load(Ordering::Relaxed),
            0,
            0,
            0,
        )
    }

    /// 全 LinkAudio channel の ring overflow drop（interleaved サンプル数）の累積合計（A4-2b-2b）。
    /// daemon の 1 Hz ticker が polling して増加を WARNING event で surface する（非 RT observability）。
    /// link 未初期化（test backend）時は control 分が 0。test 注入分（本番 0）を必ず加える。
    #[cfg(feature = "link-audio")]
    pub fn link_egress_ring_drops(&self) -> u64 {
        // try_lock で ticker をブロックしない。**WouldBlock**（callback / register との一時競合）は
        // 次 tick に持ち越すだけ — counter は cumulative なので drop は失われず後続 tick が全累積を
        // 報告する。**Poisoned** は以降ずっと control 分を 0 に固定し LINK_EGRESS_DROP を session 中
        // 抑制してしまうため、他アクセサ（`loaded_sample_count` 等）と同様 `warn!` で post-mortem の
        // 根拠を残す（contention と poison を `.ok()` で同一視しない）。
        let control_drops = match self.link.try_lock() {
            Ok(g) => g.as_ref().map(|ctl| ctl.total_ring_drops()).unwrap_or(0),
            Err(std::sync::TryLockError::WouldBlock) => 0,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                tracing::warn!(
                    "link mutex poisoned; link_egress_ring_drops reporting 0 for control drops \
                     (LINK_EGRESS_DROP events suppressed until daemon restart)"
                );
                0
            }
        };
        control_drops + self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// feature `link-audio` 無効ビルド用の stub。本番は常に 0（control が無い）。test 注入分のみ反映。
    #[cfg(not(feature = "link-audio"))]
    pub fn link_egress_ring_drops(&self) -> u64 {
        self.link_egress_drops.load(Ordering::Relaxed)
    }

    /// test harness 用: LinkAudio egress drop の注入カウンタを取得する。accessor の形（`Arc` clone を
    /// 返す）は `stream_stats_arc` と同じだが、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の LINK_EGRESS_DROP 発火を駆動する。
    /// `#[doc(hidden)]` で公開 API としては扱わない。
    #[doc(hidden)]
    pub fn link_egress_drops_arc(&self) -> Arc<AtomicU64> {
        self.link_egress_drops.clone()
    }

    /// test harness 用: CLAP process error の注入カウンタを取得する。`link_egress_drops_arc` と同形で、
    /// 下層 counter は本番経路から分離した注入専用（本番 0）。integration test から `fetch_add` して
    /// 1 Hz ticker の CLAP_PROCESS_ERROR 発火を駆動する（plugin ロード不要）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn clap_process_errors_arc(&self) -> Arc<AtomicU64> {
        self.clap_process_errors.clone()
    }

    /// test harness 用: OOP effect `frames_clamped` の注入カウンタを取得する。`link_egress_drops_arc` /
    /// `clap_process_errors_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_EFFECT_FRAMES_CLAMPED 発火を
    /// 駆動する（child process 不要・#406）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_frames_clamped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_frames_clamped.clone()
    }

    /// test harness 用: OOP instrument `output_event_dropped_count` の注入カウンタを取得する。
    /// `outproc_frames_clamped_arc` と同形で、下層 counter は本番経路から分離した注入専用（本番 0）。
    /// integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_OUTPUT_DROPPED 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 2）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_output_dropped_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_output_dropped.clone()
    }

    /// test harness 用: OOP instrument `child_process_error_count` の注入カウンタを取得する。
    /// `outproc_instrument_output_dropped_arc` と同形で、下層 counter は本番経路から分離した注入専用
    /// （本番 0）。integration test から `fetch_add` して 1 Hz ticker の OUTPROC_INSTRUMENT_ERROR 発火を
    /// 駆動する（instrument child process 不要・PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_child_errors_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_child_errors.clone()
    }

    /// test harness 用: OOP instrument `respawn_count` の注入カウンタを取得する。
    /// `outproc_instrument_child_errors_arc` と同形。integration test から `fetch_add` して 1 Hz
    /// ticker の OUTPROC_INSTRUMENT_RESPAWN 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_respawns_arc(&self) -> Arc<AtomicU64> {
        self.outproc_instrument_respawns.clone()
    }

    /// test harness 用: OOP instrument `measurement_invalid` の注入フラグを取得する。数値カウンタ
    /// 系の `_arc()` getter と異なり `AtomicBool` を返すが、同じ「本番経路から分離した注入専用
    /// （本番 false）」設計。integration test から `store(true, ..)` して 1 Hz ticker の
    /// OUTPROC_INSTRUMENT_INVALID fire-once 発火を駆動する（PR #422 round 3）。`#[doc(hidden)]`。
    #[doc(hidden)]
    pub fn outproc_instrument_measurement_invalid_arc(&self) -> Arc<AtomicBool> {
        self.outproc_instrument_measurement_invalid.clone()
    }

    /// test harness 用: `StreamStats` への参照を取得し、外部から
    /// xrun / device_lost を駆動できるようにする。
    ///
    /// 外部 crate (`tests/`) から呼ぶ必要があるため `pub` だが、
    /// `#[doc(hidden)]` で rustdoc からは不可視にし公開 API としては扱わない。
    #[doc(hidden)]
    pub fn stream_stats_arc(&self) -> Arc<StreamStats> {
        self.stream_stats.clone()
    }

    pub fn uptime_sec(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    /// 現在スケジュール中の（まだ完了していない）再生イベント数。
    /// audio callback がロックを握っている瞬間は取得できないので、その場合は 0 を返す。
    pub fn active_play_count(&self) -> usize {
        self.engine.active_count().unwrap_or(0)
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.stream_config_snapshot().sample_rate
    }

    /// 現在の出力ストリーム時刻（scheduler transport 秒）。`play_at` の `time_sec` と同一座標系。
    /// ロック競合時は `None`（callback がロック保持中）。
    pub fn now_sec(&self) -> Option<f64> {
        self.engine.now_sec()
    }

    /// `Engine::lock_contention_count` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling する（#401）。
    pub fn engine_lock_contention_count(&self) -> u64 {
        self.engine.lock_contention_count()
    }

    /// `Engine::is_lock_poisoned` の delegate（詳細はそちら参照）。daemon の 1 Hz ticker が
    /// polling して fire-once の FATAL event を出す（#401）。
    pub fn engine_lock_poisoned(&self) -> bool {
        self.engine.is_lock_poisoned()
    }

    /// test harness 用: `Engine::contention_count_arc` の delegate。integration test から
    /// `fetch_add` して 1 Hz ticker の `ENGINE_LOCK_CONTENTION` WARNING 発火を駆動する
    /// （`link_egress_drops_arc` と同様の注入 seam・`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_contention_arc(&self) -> Arc<AtomicU64> {
        self.engine.contention_count_arc()
    }

    /// test harness 用: `Engine::poisoned_arc` の delegate。integration test から `store(true, ..)`
    /// して 1 Hz ticker の `ENGINE_LOCK_POISONED` FATAL 発火を、実際に Mutex を panic-poison させずに
    /// 駆動する（`#[doc(hidden)]`）。
    #[doc(hidden)]
    pub fn engine_lock_poisoned_arc(&self) -> Arc<AtomicBool> {
        self.engine.poisoned_arc()
    }

    pub fn output_channels(&self) -> u16 {
        self.stream_config_snapshot().channels
    }

    /// ファイルをロードし sample_id を返す。
    pub fn load_sample(&self, path: PathBuf) -> Result<LoadedSample, WrapError> {
        let sample = load_sample_resampled(&path, self.sample_rate)?;
        let id = format!("s-{}", short_uuid());
        let info = LoadedSample {
            sample_id: id.clone(),
            frames: sample.frames(),
            channels: sample.channels,
            sample_rate: sample.sample_rate,
        };
        self.lock_samples()?.insert(id, sample);
        Ok(info)
    }

    pub fn unload_sample(&self, sample_id: &str) -> Result<(), WrapError> {
        if self.lock_samples()?.remove(sample_id).is_some() {
            Ok(())
        } else {
            Err(WrapError::SampleNotFound(sample_id.to_string()))
        }
    }

    /// sample を現在時刻 + offset でスケジュール。
    ///
    /// `time_sec` は daemon 起動からの経過秒（Engine transport 基準）。
    /// `pan` は [-1.0, 1.0]（0.0 = 中央、範囲外は core で clamp）。
    /// `offset_sec` / `duration_sec` は再生領域（`chop` の slice）。`duration_sec <= 0` で
    /// 「offset 以降すべて」。いずれもサンプル端で clamp。
    /// `rate` は varispeed（1.0 = 自然尺、>1 = 速く短く高ピッチ、<1 = 遅く長く低ピッチ。
    /// `<=0`/非有限は core で 1.0 に丸め）。
    /// `channel` は出力先 channel 名（LinkAudio outputChannel・#209）。`None` = 既定
    /// （unrouted / hardware sum）。同名 channel の event は per-channel render で加算合成される。
    /// 戻り値の `duration_sec` は **実際に再生される区間の出力尺**（slice 実尺 / rate）なので、
    /// 呼び出し側は PlayEnded を再生終端（varispeed 後の出力終端）に合わせて遅延送信できる。
    #[allow(clippy::too_many_arguments)]
    pub fn play_at(
        &self,
        sample_id: &str,
        time_sec: f64,
        gain: f32,
        pan: f32,
        offset_sec: f64,
        duration_sec: f64,
        rate: f64,
        channel: Option<String>,
    ) -> Result<PlayHandle, WrapError> {
        let sample = self
            .lock_samples()?
            .get(sample_id)
            .cloned()
            .ok_or_else(|| WrapError::SampleNotFound(sample_id.to_string()))?;
        let sr = sample.sample_rate as f64;
        let total_frames = sample.frames();
        // サンプル内オフセット / slice 長（フレーム）。0 = offset 以降すべて。
        // サンプル端 clamp は resolve_slice_region に集約する。
        let offset_frames = (offset_sec.max(0.0) * sr) as usize;
        let requested_len_frames = if duration_sec > 0.0 {
            (duration_sec * sr).round() as usize
        } else {
            0
        };
        // 再生領域を clamp。render が読む source 尺（effective_len_frames）は rate に依らず
        // 不変で、scheduler の render と同一式（resolve_slice_region）を共有する。
        let (slice_start_frame, effective_len_frames) =
            resolve_slice_region(total_frames, offset_frames, requested_len_frames);
        // PlayEnded 用の **出力**尺は varispeed で source 尺 / rate になる（render の出力尺と一致）。
        // core と同じ sanitize_rate で正規化し、出力尺の規約を一致させる。
        let out_duration_sec = effective_len_frames as f64 / sr / sanitize_rate(rate);
        let play_id = format!("p-{}", short_uuid());
        self.engine
            .schedule_with_play_id(
                time_sec,
                gain,
                pan,
                slice_start_frame,
                // clamp 済みの実尺を渡す。生の requested_len_frames を渡すと、render 尺と
                // PlayEnded 尺の一致が scheduler 内の再 clamp に依存してしまう（latent な desync）。
                effective_len_frames,
                rate,
                channel,
                play_id.clone(),
                sample,
            )
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        Ok(PlayHandle {
            play_id,
            start_sec: time_sec,
            duration_sec: out_duration_sec,
        })
    }

    /// 全アクティブ再生を即時停止する hard-stop-all。停止件数を返す。
    /// daemon が保持する disposable な voice（in-flight one-shot / varispeed の長尺 slice）を
    /// respawn / stopAll で一括 drop する。PlayEnded 抑制集合は触らない（停止された voice の
    /// PlayEnded 遅延タスクはそのまま発火しうるが、consumer 側が play_id 不在で無害に無視する）。
    pub fn stop_all(&self) -> Result<usize, WrapError> {
        self.engine
            .stop_all()
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// `play_id` に一致するアクティブ再生を停止する。true = 停止、false = 見つからず。
    ///
    /// 停止成功時は `stopped_play_ids` にも記録し、PlayEnded 遅延タスクに
    /// 自然発火を抑制させる（take_play_ended_suppressed で消費される）。
    pub fn stop(&self, play_id: &str) -> Result<bool, WrapError> {
        let stopped = self
            .engine
            .stop(play_id)
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        if stopped {
            self.stopped_play_ids
                .lock()
                .map_err(|_| WrapError::Scheduler("stopped_play_ids mutex poisoned".to_string()))?
                .insert(play_id.to_string());
        }
        Ok(stopped)
    }

    /// PlayEnded 送信直前に呼ぶ。Stop によって停止された `play_id` なら true を返し、
    /// 該当エントリを remove する。呼び出し側は true なら PlayEnded の送出をスキップする。
    pub fn take_play_ended_suppressed(&self, play_id: &str) -> bool {
        match self.stopped_play_ids.lock() {
            Ok(mut s) => s.remove(play_id),
            // poisoned は非致命的エラー扱い: 抑制されていない前提で PlayEnded を送出する。
            // poison 状態は通常発生せず、発生した場合は Stop 後に PlayEnded が漏れるため
            // post-mortem の根拠として warn! を残す。
            Err(_) => {
                tracing::warn!(
                    play_id = %play_id,
                    "stopped_play_ids mutex poisoned; PlayEnded suppression disabled for this id"
                );
                false
            }
        }
    }

    /// 読み取り専用カウンタ。poisoned 時は fallback として 0 を返す。
    ///
    /// poison 時は GetStatus などで「サンプル未ロード」に見える根因を示すため
    /// warn! を残す。
    pub fn loaded_sample_count(&self) -> usize {
        match self.samples.lock() {
            Ok(guard) => guard.len(),
            Err(_) => {
                tracing::warn!(
                    "samples mutex poisoned; loaded_sample_count returning 0 (GetStatus will misreport)"
                );
                0
            }
        }
    }

    /// transport 時刻（audio callback 駆動）を優先し、未起動時のみ wall-clock にフォールバック。
    pub fn transport_or_uptime_sec(&self) -> f64 {
        self.engine.now_sec().unwrap_or_else(|| self.uptime_sec())
    }

    /// `render_offline` / `render_offline_channel` の共通本体。`render_fn` で 1 block 分の
    /// 描画（全 channel / channel filter）を切り替える。`block_frames` 単位で回すことで、
    /// 実 callback と同様にイベントが block 境界をまたぐ経路も通す。
    ///
    /// `block_frames == 0` は panic（テストハーネス用途なので不正設定は早期に落とす）。
    fn render_offline_inner(
        &self,
        total_frames: usize,
        block_frames: usize,
        mut render_fn: impl FnMut(&mut [f32]),
    ) -> Vec<f32> {
        assert!(block_frames > 0, "render_offline: block_frames must be > 0");
        let channels = self.channels as usize;
        let mut data = Vec::with_capacity(total_frames * channels);
        let mut block = vec![0.0f32; block_frames * channels];
        let mut rendered = 0usize;
        while rendered < total_frames {
            let this_frames = block_frames.min(total_frames - rendered);
            let buf = &mut block[..this_frames * channels];
            render_fn(buf);
            data.extend_from_slice(buf);
            rendered += this_frames;
        }
        data
    }

    /// 検証ハーネス（#311 phase 2）用: スケジュール済みイベントを cpal を介さず
    /// オフラインで `total_frames` 分 render し、interleaved f32 PCM を返す。
    ///
    /// 本番経路（cpal callback）とは独立した test-only API。`Engine::render` は内部で
    /// `try_lock` するが、オフライン単スレッド駆動では競合がなく常に成功する。
    /// `play_at` 由来の sec→frame 変換 / `resolve_slice_region` を経た出力を捕捉できる
    /// （phase 1 の Scheduler 直接駆動が飛ばした層）。
    #[doc(hidden)]
    pub fn render_offline(&self, total_frames: usize, block_frames: usize) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| self.engine.render(buf))
    }

    /// `render_offline` の channel filter 版（LinkAudio per-channel 受信側の決定論検証・層A）。
    /// 指定 channel 名に属する event だけをオフラインで決定論レンダする。同名 channel は
    /// 加算合成される（sum-by-name）。1 つの wrap で複数 channel を続けて tap すると transport が
    /// 二重に進むため（[`orbit_audio_core::Scheduler::render_channel`] 参照）、検証は channel
    /// ごとに fresh な wrap を使うこと。
    #[doc(hidden)]
    pub fn render_offline_channel(
        &self,
        channel: &str,
        total_frames: usize,
        block_frames: usize,
    ) -> Vec<f32> {
        self.render_offline_inner(total_frames, block_frames, |buf| {
            self.engine.render_channel(buf, channel)
        })
    }

    /// マスターゲインを設定する。`ramp_sec` が 0 以下なら即時。
    pub fn set_global_gain(&self, value: f32, ramp_sec: f64) -> Result<(), WrapError> {
        self.engine
            .set_global_gain(value, ramp_sec)
            .map_err(|e| WrapError::Scheduler(e.to_string()))
    }

    /// audio stream の稼働統計スナップショット（StreamStats event 用）。
    pub fn stream_stats_snapshot(&self) -> StreamStatsSnapshot {
        self.stream_stats.snapshot()
    }

    /// GetStatus 用の現在の実効 stream 構成。1 回の lock で3フィールドを整合したまま複製する。
    pub fn stream_config_snapshot(&self) -> StreamConfigSnapshot {
        match self.stream_config.lock() {
            Ok(snapshot) => snapshot.clone(),
            Err(poisoned) => {
                tracing::warn!(
                    "stream config mutex poisoned; reporting the last stored stream configuration"
                );
                poisoned.into_inner().clone()
            }
        }
    }

    /// 1 Hz ticker が直近区間の callback 前進有無を書き込む。
    pub(crate) fn set_callback_alive(&self, alive: bool) {
        self.callback_alive.store(alive, Ordering::Relaxed);
    }

    /// GetStatus は時間窓を作らず、1 Hz ticker が確定した値だけを読む。
    pub fn callback_alive(&self) -> bool {
        self.callback_alive.load(Ordering::Relaxed)
    }

    /// `samples` Mutex を poisoned-safe に取得する。
    /// poisoned 時は `WrapError::Scheduler` に変換して呼び出し側に明示的に通知する。
    fn lock_samples(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Sample>>, WrapError> {
        self.samples
            .lock()
            .map_err(|_| WrapError::Scheduler("samples mutex poisoned".to_string()))
    }
}

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

/// `load_outproc_plugin` の終端遷移直前の不変条件検査（release では noop）。
/// Loading 以外を観測したら、この関数以外に slot への書き手が現れたことを意味する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn debug_assert_slot_loading<R: OutProcRole>(slot: &ChildSlot<R>) {
    debug_assert!(
        matches!(slot, ChildSlot::Loading { .. }),
        "load_outproc_plugin: slot must still be Loading (only this function \
         transitions Loading -> Active/Closed/Empty)"
    );
}

/// child slot の poison は attach state machine の停止理由にせず、唯一の書き手である本関数が
/// 回復して本来の遷移を完遂する。放置すると Loading/Closed/Empty の中間状態が恒久化する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn lock_child_slot_recovering<'a, R: OutProcRole>(
    child_slot: &'a Mutex<ChildSlot<R>>,
    site: &'static str,
) -> MutexGuard<'a, ChildSlot<R>> {
    child_slot.lock().unwrap_or_else(|poisoned| {
        tracing::error!("child slot mutex poisoned during {site}; recovering");
        poisoned.into_inner()
    })
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
type PluginStateHandles = (
    Arc<orbit_audio_sandbox::CommandMailboxHost>,
    Arc<Mutex<Option<PathBuf>>>,
);

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
#[derive(Clone, Copy)]
enum OutProcSlotErrorKind {
    State,
    Ui,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl OutProcSlotErrorKind {
    fn target(self, message: String) -> WrapError {
        match self {
            Self::State => WrapError::PluginStateTarget(message),
            Self::Ui => WrapError::PluginUiTarget(message),
        }
    }

    fn unavailable(self, message: String) -> WrapError {
        match self {
            Self::State => WrapError::PluginStateTarget(message),
            Self::Ui => WrapError::PluginUiUnavailable(message),
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
enum ResolvedOutProcSlot {
    #[cfg(feature = "outproc-effect")]
    Effect {
        slot: Arc<Mutex<ChildSlot<EffectRole>>>,
        chain: Arc<Mutex<crate::outproc_effect::ChainConfig>>,
    },
    #[cfg(feature = "outproc-instrument")]
    Instrument(Arc<Mutex<ChildSlot<InstrumentRole>>>),
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl ResolvedOutProcSlot {
    fn state_handles(&self, chain_index: usize) -> Result<ResolvedPluginStateHandles, WrapError> {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { slot, chain } => {
                validate_effect_chain_target(chain, chain_index, OutProcSlotErrorKind::State)?;
                let (mailbox, _) = active_plugin_state_handles(slot, "effect")?;
                Ok(ResolvedPluginStateHandles::Effect {
                    mailbox,
                    chain: chain.clone(),
                    index: chain_index,
                })
            }
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument(slot) => {
                if chain_index != 0 {
                    return Err(WrapError::PluginStateTarget(format!(
                        "instrument chain_path index {chain_index} is out of range"
                    )));
                }
                let (mailbox, latest_state) = active_plugin_state_handles(slot, "instrument")?;
                Ok(ResolvedPluginStateHandles::Instrument {
                    mailbox,
                    latest_state,
                })
            }
        }
    }

    fn ui_handles(&self, chain_index: usize) -> Result<(PluginUiHandles, bool), WrapError> {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { slot, chain } => {
                validate_effect_chain_target(chain, chain_index, OutProcSlotErrorKind::Ui)?;
                Ok((active_plugin_ui_handles(slot, "effect")?, true))
            }
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument(slot) => {
                if chain_index != 0 {
                    return Err(WrapError::PluginUiTarget(format!(
                        "instrument chain_path index {chain_index} is out of range"
                    )));
                }
                Ok((active_plugin_ui_handles(slot, "instrument")?, false))
            }
        }
    }

    fn ui_handles_without_stage_validation(&self) -> Result<(PluginUiHandles, bool), WrapError> {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { slot, .. } => Ok((active_plugin_ui_handles(slot, "effect")?, true)),
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument(slot) => Ok((active_plugin_ui_handles(slot, "instrument")?, false)),
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
enum ResolvedPluginStateHandles {
    #[cfg(feature = "outproc-effect")]
    Effect {
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        chain: Arc<Mutex<crate::outproc_effect::ChainConfig>>,
        index: usize,
    },
    #[cfg(feature = "outproc-instrument")]
    Instrument {
        mailbox: Arc<orbit_audio_sandbox::CommandMailboxHost>,
        latest_state: Arc<Mutex<Option<PathBuf>>>,
    },
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl ResolvedPluginStateHandles {
    fn mailbox(&self) -> &orbit_audio_sandbox::CommandMailboxHost {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { mailbox, .. } => mailbox,
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument { mailbox, .. } => mailbox,
        }
    }

    fn issue_save(
        &self,
        path: &std::path::Path,
    ) -> Result<orbit_audio_sandbox::CommandMailboxResponse, orbit_audio_sandbox::CommandMailboxError>
    {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { mailbox, index, .. } => {
                let argument = serde_json::to_string(&serde_json::json!({
                    "index": index,
                    "path": path,
                }))
                .map_err(|error| {
                    orbit_audio_sandbox::CommandMailboxError::InvalidArgument(error.to_string())
                })?;
                mailbox.issue_save_state_at(&argument, path)
            }
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument { mailbox, .. } => mailbox.issue_save_state(path),
        }
    }

    fn record_latest_state(&self, path: PathBuf) -> Result<(), WrapError> {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { chain, index, .. } => {
                let mut chain = chain.lock().map_err(|_| {
                    WrapError::PluginStateProtocol("effect chain config mutex poisoned".into())
                })?;
                match chain.get_mut(*index) {
                    Some(crate::outproc_effect::ChainStageConfig::Catalog {
                        latest_state,
                        ..
                    }) => {
                        *latest_state = Some(path);
                        Ok(())
                    }
                    Some(crate::outproc_effect::ChainStageConfig::Standard { .. }) => Err(
                        WrapError::PluginStateTarget(
                            "standard plugins have no UI/state; parameters live in the DSL (SC.10.8)"
                                .into(),
                        ),
                    ),
                    None => Err(WrapError::PluginStateTarget(format!(
                        "effect chain_path index {index} is out of range"
                    ))),
                }
            }
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument { latest_state, .. } => {
                record_latest_state_after_save(latest_state, path)
            }
        }
    }
}

#[cfg(feature = "outproc-effect")]
fn validate_effect_chain_target(
    chain: &Mutex<crate::outproc_effect::ChainConfig>,
    index: usize,
    error_kind: OutProcSlotErrorKind,
) -> Result<(), WrapError> {
    let chain = chain
        .lock()
        .map_err(|_| error_kind.target("effect chain config mutex poisoned".into()))?;
    match chain.get(index) {
        Some(crate::outproc_effect::ChainStageConfig::Catalog { .. }) => Ok(()),
        Some(crate::outproc_effect::ChainStageConfig::Standard { .. }) => Err(error_kind.target(
            "standard plugins have no UI/state; parameters live in the DSL (SC.10.8)".into(),
        )),
        None => Err(error_kind.target(format!("effect chain_path index {index} is out of range"))),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
type PluginUiHandles = (
    Arc<orbit_audio_sandbox::CommandMailboxHost>,
    Arc<orbit_audio_sandbox::UiEventPump>,
    Arc<Mutex<PluginUiRouteRegistry>>,
    Option<Arc<Mutex<PluginUiIndexBinding>>>,
);

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn active_plugin_state_handles<R: OutProcRole>(
    child_slot: &Mutex<ChildSlot<R>>,
    role: &str,
) -> Result<PluginStateHandles, WrapError> {
    let slot = child_slot
        .lock()
        .map_err(|_| WrapError::PluginStateTarget(format!("{role} child slot mutex poisoned")))?;
    match &*slot {
        ChildSlot::Active {
            mailbox,
            latest_state,
            ..
        } => Ok((mailbox.clone(), latest_state.clone())),
        ChildSlot::Empty(_) => Err(WrapError::PluginStateTarget(format!(
            "{role} child slot has no loaded plugin"
        ))),
        ChildSlot::Loading { path } => Err(WrapError::PluginStateNotReady(format!(
            "{role} plugin is still loading from {path:?}"
        ))),
        ChildSlot::Closed => Err(WrapError::PluginStateTarget(format!(
            "{role} child slot is closed"
        ))),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn active_plugin_ui_handles<R: OutProcRole>(
    child_slot: &Mutex<ChildSlot<R>>,
    role: &str,
) -> Result<PluginUiHandles, WrapError> {
    let slot = child_slot
        .lock()
        .map_err(|_| WrapError::PluginUiTarget(format!("{role} child slot mutex poisoned")))?;
    match &*slot {
        ChildSlot::Active {
            mailbox,
            ui_pump,
            ui_target,
            ui_index_binding,
            ..
        } => Ok((
            mailbox.clone(),
            ui_pump.clone(),
            ui_target.clone(),
            ui_index_binding.clone(),
        )),
        ChildSlot::Empty(_) => Err(WrapError::PluginUiTarget(format!(
            "{role} child slot has no loaded plugin"
        ))),
        ChildSlot::Loading { path } => Err(WrapError::PluginUiUnavailable(format!(
            "{role} plugin is still loading from {path:?}"
        ))),
        ChildSlot::Closed => Err(WrapError::PluginUiTarget(format!(
            "{role} child slot is closed"
        ))),
    }
}

#[cfg(feature = "outproc-effect")]
fn effect_chain_registry_is_intact(
    slot: &ChildSlot<EffectRole>,
    stats: &crate::outproc_effect::OutProcEffectStats,
) -> bool {
    matches!(slot, ChildSlot::Active { .. })
        && stats.current_child_pid.load(Ordering::Acquire) != 0
        && !stats.measurement_invalid.load(Ordering::Acquire)
}

#[cfg(feature = "outproc-effect")]
fn plugin_ui_keep_remap(
    plan: &crate::outproc_effect::EffectChainPlan,
) -> Result<BTreeMap<u32, u32>, WrapError> {
    let mut remap = BTreeMap::new();
    for (new_index, stage) in plan.chain.iter().enumerate() {
        let crate::outproc_effect::EffectChainPlanStage::Keep { prev_index, .. } = stage else {
            continue;
        };
        let previous = u32::try_from(*prev_index).map_err(|_| {
            WrapError::OutProcEffectRequest(format!(
                "effect chain prev_index {prev_index} exceeds the plugin UI binding range"
            ))
        })?;
        let next = u32::try_from(new_index).map_err(|_| {
            WrapError::OutProcEffectRequest(format!(
                "effect chain index {new_index} exceeds the plugin UI binding range"
            ))
        })?;
        remap.insert(previous, next);
    }
    Ok(remap)
}

#[cfg(feature = "outproc-effect")]
fn remap_plugin_ui_index_binding(
    index_binding: &Mutex<PluginUiIndexBinding>,
    keep_remap: &BTreeMap<u32, u32>,
) {
    let mut binding = match index_binding.lock() {
        Ok(binding) => binding,
        Err(poisoned) => poisoned.into_inner(),
    };
    let previous = std::mem::take(&mut *binding);
    for (old_index, window) in previous {
        if let Some(new_index) = keep_remap.get(&old_index) {
            binding.insert(*new_index, window);
        }
    }
}

#[cfg(feature = "outproc-effect")]
fn dropped_stage_summaries(
    dropped: &[crate::outproc_effect::SaveDroppedStage],
) -> Result<Vec<DroppedEffectStageSummary>, WrapError> {
    dropped
        .iter()
        .map(|stage| {
            let bytes_written = std::fs::metadata(&stage.path)
                .map_err(|error| {
                    WrapError::OutProcEffect(format!(
                        "stat dropped stage state {:?}: {error}",
                        stage.path
                    ))
                })?
                .len();
            Ok(DroppedEffectStageSummary {
                prev_index: stage.prev_index,
                path: stage.path.clone(),
                bytes_written,
            })
        })
        .collect()
}

#[cfg(feature = "outproc-effect")]
fn dropped_stage_summaries_from_latest_state(
    previous: &crate::outproc_effect::ChainConfig,
    dropped: &[crate::outproc_effect::SaveDroppedStage],
) -> Result<Vec<DroppedEffectStageSummary>, WrapError> {
    let mut summaries = Vec::new();
    for stage in dropped {
        let Some(crate::outproc_effect::ChainStageConfig::Catalog {
            latest_state: Some(source),
            ..
        }) = previous.get(stage.prev_index)
        else {
            // A dead child cannot produce a first snapshot. Omitting the summary keeps TS from
            // registering a nonexistent file while still allowing the crashed stage to be dropped.
            continue;
        };
        if source != &stage.path {
            std::fs::copy(source, &stage.path).map_err(|error| {
                WrapError::OutProcEffect(format!(
                    "recover dropped stage state from {source:?} to {:?}: {error}",
                    stage.path
                ))
            })?;
        }
        let bytes_written = std::fs::metadata(&stage.path)
            .map_err(|error| {
                WrapError::OutProcEffect(format!(
                    "stat recovered dropped stage state {:?}: {error}",
                    stage.path
                ))
            })?
            .len();
        summaries.push(DroppedEffectStageSummary {
            prev_index: stage.prev_index,
            path: stage.path.clone(),
            bytes_written,
        });
    }
    Ok(summaries)
}

#[cfg(feature = "outproc-effect")]
/// `CommandFailed` is the only definitive rejection: the child inspected the plan and refused,
/// and its prepare-commit invariant guarantees the previous chain is untouched. Every other
/// variant is uncertain. Five of them (`Busy` / `InvalidArgument` / `SequenceExhausted` /
/// `Mapping` / `SidecarCleanup`) fail before the command is written and are over-conservative
/// here, but all are dormant today — RPCs are fully serial within a connection, so `Busy` in
/// particular only becomes reachable if a second concurrent WebSocket client is ever connected.
fn effect_chain_registry_is_intact_after_mailbox_error(
    error: &orbit_audio_sandbox::CommandMailboxError,
) -> bool {
    matches!(
        error,
        orbit_audio_sandbox::CommandMailboxError::CommandFailed { .. }
    )
}

#[cfg(feature = "outproc-effect")]
fn effect_chain_apply_mailbox_error(error: orbit_audio_sandbox::CommandMailboxError) -> WrapError {
    use orbit_audio_sandbox::CommandMailboxError;
    if !effect_chain_registry_is_intact_after_mailbox_error(&error) {
        return WrapError::OutProcEffectUncertain(format!(
            "effect chain apply ended without confirmation that the authoritative config is unchanged: {error}"
        ));
    }
    match error {
        CommandMailboxError::CommandFailed { detail, .. } => {
            let suffix = if detail.contains("the previous chain is kept") {
                ""
            } else {
                "; the previous chain is kept"
            };
            WrapError::OutProcEffect(format!("effect chain apply failed: {detail}{suffix}"))
        }
        _ => unreachable!("registry-intact mailbox failures are definitive child responses"),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn plugin_state_mailbox_error(error: orbit_audio_sandbox::CommandMailboxError) -> WrapError {
    use orbit_audio_sandbox::{
        CommandMailboxError as E, CMD_RESULT_BAD_ARG, CMD_RESULT_IO_ERROR, CMD_RESULT_PLUGIN_ERROR,
    };
    let detail = error.to_string();
    match error {
        E::Timeout { .. } => WrapError::PluginStateTimeout(detail),
        E::ChildExited { .. } => WrapError::PluginStateChildExited(detail),
        E::CommandFailed {
            result: CMD_RESULT_PLUGIN_ERROR,
            ..
        } => WrapError::PluginStateUnsupported(detail),
        E::CommandFailed {
            result: CMD_RESULT_IO_ERROR,
            ..
        } => WrapError::PluginStateIo(detail),
        E::CommandFailed {
            result: CMD_RESULT_BAD_ARG,
            ..
        }
        | E::InvalidArgument(_)
        | E::Mapping(_)
        | E::SidecarCleanup { .. } => WrapError::PluginStateIo(detail),
        _ => WrapError::PluginStateProtocol(detail),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn plugin_ui_mailbox_error(error: orbit_audio_sandbox::CommandMailboxError) -> WrapError {
    use orbit_audio_sandbox::CommandMailboxError as E;
    let detail = error.to_string();
    match error {
        E::Mapping(_) | E::SidecarCleanup { .. } => WrapError::PluginUiUnavailable(detail),
        E::CommandFailed { .. } | E::InvalidArgument(_) => WrapError::PluginUiCommand(detail),
        E::ChildExited { .. } => WrapError::PluginUiUnavailable(detail),
        _ => WrapError::PluginUiProtocol(detail),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn plugin_ui_pump_error(error: orbit_audio_sandbox::UiEventPumpError) -> WrapError {
    use orbit_audio_sandbox::UiEventPumpError as E;
    let detail = error.to_string();
    match error {
        E::Mapping(_) | E::Mailbox(_) => WrapError::PluginUiUnavailable(detail),
        E::CoordinatorPoisoned | E::GenerationMismatch { .. } | E::Protocol(_) => {
            WrapError::PluginUiProtocol(detail)
        }
    }
}

/// retryable な attach 失敗（role mismatch / early-exit / timeout）の共通終端処理。
/// supervisor を unlink 抜きで teardown し（unlink 所有権は launch に戻る）、teardown が
/// 書いた QUIT を RUN へ戻して、slot を retry 可能な `Empty(launch)` に復帰させる。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn retryable_attach_failure<R: OutProcRole>(
    supervisor: R::Supervisor,
    region: *mut orbit_audio_sandbox::transport::SharedRegion,
    child_slot: &Mutex<ChildSlot<R>>,
    launch: ChildLaunch<R>,
    message: String,
) -> WrapError {
    tracing::warn!("outproc attach failed (retryable): {message}");
    detach_and_reset_control_run::<R>(supervisor, region);
    let mut slot = lock_child_slot_recovering(child_slot, "retryable attach failure");
    debug_assert_slot_loading(&slot);
    *slot = ChildSlot::Empty(launch);
    WrapError::OutProcAttachFailed(message)
}

/// Supervisor を先に停止・join・reap してから、再利用する shm の control を RUN に戻す。
/// child を先に kill すると watchdog が予期しない exit と誤認して respawn するため、この順序を
/// 崩してはならない。`region` は呼び出し元が保持する mmap の生存中ポインタでなければならない。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn detach_and_reset_control_run<R: OutProcRole>(
    supervisor: R::Supervisor,
    region: *mut orbit_audio_sandbox::transport::SharedRegion,
) {
    R::detach_keep_shm(supervisor);
    // SAFETY: 呼び出し元が、この呼び出しの完了まで region の mmap を保持する。
    unsafe { orbit_audio_sandbox::transport::reset_control_run(region) };
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn outproc_plugin_summary(
    path: &std::path::Path,
    plugin_id: &Option<String>,
) -> LoadedPluginSummary {
    LoadedPluginSummary {
        plugin_id: plugin_id
            .clone()
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        plugin_name: path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned()),
        note_port_index: 0,
    }
}

#[cfg(feature = "outproc-effect")]
fn effect_slot_label(bus: &Option<String>) -> String {
    match bus {
        Some(name) => format!("bus '{name}'"),
        None => "master".to_owned(),
    }
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod shm_cleanup_guard_tests {
    use super::ShmCleanupGuard;
    use std::path::PathBuf;

    fn unique_path() -> PathBuf {
        std::env::temp_dir().join(format!("orbitscore-shm-cleanup-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn armed_drop_removes_file_and_disarmed_drop_keeps_it() {
        let armed = unique_path();
        std::fs::write(&armed, b"guard test").expect("create armed guard file");
        drop(ShmCleanupGuard::new(armed.clone()));
        assert!(!armed.exists(), "armed guard must remove shm file");

        let disarmed = unique_path();
        std::fs::write(&disarmed, b"guard test").expect("create disarmed guard file");
        let mut guard = ShmCleanupGuard::new(disarmed.clone());
        guard.disarm();
        drop(guard);
        assert!(
            disarmed.exists(),
            "disarmed guard must leave ChildLaunch-owned file"
        );
        std::fs::remove_file(disarmed).expect("remove retained test file");
    }
}

#[cfg(all(test, feature = "outproc-effect", feature = "outproc-instrument"))]
mod outproc_both_tests {
    use super::EngineWrap;

    #[test]
    fn both_buffer_frames_rejects_conflicting_values() {
        assert!(EngineWrap::resolve_outproc_both_buffer_frames(Some(32), Some(64)).is_err());
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(Some(32), None).unwrap(),
            Some(32)
        );
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(None, None).unwrap(),
            None
        );
    }
}

pub struct LoadedSample {
    pub sample_id: String,
    pub frames: usize,
    pub channels: u16,
    pub sample_rate: u32,
}

/// `load_plugin` の結果サマリ（feature 非依存型・session.rs を feature 非依存に保つ）。
/// feature 有効時は `orbit_clap_host::LoadedPluginInfo` から変換、無効時は stub が Err を返す。
#[derive(Debug)]
pub struct LoadedPluginSummary {
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub note_port_index: u16,
}

#[derive(Debug)]
pub struct ReplacedPluginSummary {
    pub plugin: LoadedPluginSummary,
    pub quarantined_slot: bool,
}

#[derive(Debug)]
pub struct DroppedEffectStageSummary {
    pub prev_index: usize,
    pub path: PathBuf,
    pub bytes_written: u64,
}

#[derive(Debug)]
pub struct AppliedEffectChainSummary {
    pub child_pid: u32,
    pub dropped: Vec<DroppedEffectStageSummary>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnloadedPluginStatus {
    Unloaded,
    Noop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginStateTarget {
    #[cfg(feature = "outproc-effect")]
    Effect { bus: Option<String> },
    #[cfg(feature = "outproc-instrument")]
    Instrument { instance: String },
}

/// WS event frame に載せる、解決済み plugin UI 宛先。
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct PluginUiTarget {
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Immutable open token used for event attribution. `index` below is the open-time position
    /// retained only for display/diagnostics and must never be used as an ownership key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
    pub index: u64,
}

impl PluginUiTarget {
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn from_state_target(
        target: &PluginStateTarget,
        index: u64,
        window: orbit_audio_sandbox::UiWindowKey,
    ) -> Self {
        match target {
            #[cfg(feature = "outproc-effect")]
            PluginStateTarget::Effect { bus } => Self {
                role: "effect",
                bus: bus.clone(),
                instance: None,
                window,
                index,
            },
            #[cfg(feature = "outproc-instrument")]
            PluginStateTarget::Instrument { instance } => Self {
                role: "instrument",
                bus: None,
                instance: Some(instance.clone()),
                window,
                index,
            },
        }
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    fn matches_state_target(&self, target: &PluginStateTarget) -> bool {
        match target {
            #[cfg(feature = "outproc-effect")]
            PluginStateTarget::Effect { bus } => {
                self.role == "effect" && self.bus == *bus && self.instance.is_none()
            }
            #[cfg(feature = "outproc-instrument")]
            PluginStateTarget::Instrument { instance } => {
                self.role == "instrument"
                    && self.instance.as_ref() == Some(instance)
                    && self.bus.is_none()
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginUiCompletion {
    SafepointCompleted,
    TimedOutWithoutSave,
}

impl PluginUiCompletion {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SafepointCompleted => "safepoint-completed",
            Self::TimedOutWithoutSave => "timeout-without-save",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginUiEvent {
    Closed {
        target: PluginUiTarget,
        generation: u64,
        evt_seq: u64,
    },
    CloseDone {
        target: PluginUiTarget,
        completion: PluginUiCompletion,
    },
    ClosedByRespawn {
        target: PluginUiTarget,
    },
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod plugin_ui_event_routing_tests {
    use super::*;

    fn target() -> PluginUiTarget {
        PluginUiTarget {
            role: "effect",
            bus: Some("lead".into()),
            instance: None,
            window: None,
            index: 2,
        }
    }

    fn route(window: orbit_audio_sandbox::UiWindowKey, index: u64) -> PluginUiTarget {
        PluginUiTarget {
            window,
            index,
            ..target()
        }
    }

    #[test]
    fn close_completion_is_emitted_only_for_the_done_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(4);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );
        assert_eq!(
            receiver.try_recv().expect("safepoint event"),
            PluginUiEvent::Closed {
                target: target(),
                generation: 3,
                evt_seq: 5,
            }
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: None,
            },
        ));
        assert_eq!(
            receiver.try_recv().expect("DONE event"),
            PluginUiEvent::CloseDone {
                target: target(),
                completion: PluginUiCompletion::SafepointCompleted,
            }
        );
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn undelivered_safepoint_is_retried_on_every_pump_tick() {
        let shm = std::env::temp_dir().join(format!(
            "orbit-ui-undelivered-safepoint-{}-{}.shm",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mmap = orbit_audio_sandbox::create_shared(&shm).expect("create shared region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let mut child = orbit_audio_sandbox::transport::EventRingChild::new();
        child
            .queue(orbit_audio_sandbox::transport::EVT_UI_CLOSED, "")
            .expect("queue UI_CLOSED");
        unsafe { child.service(region) }.expect("publish UI_CLOSED");

        let pump = orbit_audio_sandbox::UiEventPump::new(shm.clone());
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, receiver) = tokio::sync::broadcast::channel(1);
        drop(receiver);
        let mut attempts = 0;

        for _ in 0..3 {
            let outcome = pump
                .poll_step(|notification| {
                    attempts += 1;
                    enqueue_plugin_ui_notification(&route, None, &events, notification)
                })
                .expect("poll undelivered safepoint");
            assert!(matches!(
                outcome,
                orbit_audio_sandbox::transport::EventPollOutcome::Blocked { seq: 1, .. }
            ));
        }

        assert_eq!(attempts, 3, "delivery must be retried on every tick");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );

        drop(mmap);
        std::fs::remove_file(shm).expect("remove shared region");
    }

    #[test]
    fn undelivered_close_done_is_consumed_after_taking_its_route() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, receiver) = tokio::sync::broadcast::channel(1);
        drop(receiver);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: None,
            },
        ));
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn contended_target_lock_retries_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);
        let guard = route.lock().expect("hold route lock");

        assert!(!enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        drop(guard);
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );
    }

    #[test]
    fn poisoned_target_lock_still_routes_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let poison_route = route.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_route.lock().expect("lock before poison");
            panic!("poison plugin UI target lock");
        })
        .join();
        assert!(route.is_poisoned());
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert_eq!(
            receiver.try_recv().expect("event from poisoned route"),
            PluginUiEvent::Closed {
                target: target(),
                generation: 3,
                evt_seq: 5,
            }
        );
    }

    #[test]
    fn respawn_event_is_loud_and_consumes_the_visible_route() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);
        enqueue_plugin_ui_closed_by_respawn(&route, None, &[None], &events);

        assert_eq!(
            receiver.try_recv().expect("respawn event"),
            PluginUiEvent::ClosedByRespawn { target: target() }
        );
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn w1_close_done_removes_only_its_window_route() {
        let w1 = Some(11);
        let w2 = Some(22);
        let t1 = route(w1, 0);
        let t2 = route(w2, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, t2.clone())]));
        let binding = Mutex::new(BTreeMap::from([(0, 11), (2, 22)]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        assert!(enqueue_plugin_ui_notification(
            &routes,
            Some(&binding),
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: w2,
            },
        ));

        assert_eq!(
            receiver.try_recv().expect("w2 completion"),
            PluginUiEvent::CloseDone {
                target: t2,
                completion: PluginUiCompletion::SafepointCompleted,
            }
        );
        assert_eq!(*routes.lock().expect("routes"), BTreeMap::from([(w1, t1)]));
        assert_eq!(*binding.lock().expect("binding"), BTreeMap::from([(0, 11)]));
    }

    #[test]
    fn w2_safepoint_uses_the_notification_window_route() {
        // Make w2 the first BTreeMap entry so a "first route" regression cannot accidentally pass.
        let w1 = Some(22);
        let w2 = Some(11);
        let t1 = route(w1, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, route(w2, 0))]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        assert!(enqueue_plugin_ui_notification(
            &routes,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: w1,
            },
        ));

        assert_eq!(
            receiver.try_recv().expect("w1 safepoint"),
            PluginUiEvent::Closed {
                target: t1,
                generation: 3,
                evt_seq: 5,
            }
        );
    }

    #[test]
    fn w3_respawn_drains_every_route_and_binding() {
        let w1 = Some(11);
        let w2 = Some(22);
        let t1 = route(w1, 0);
        let t2 = route(w2, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, t2.clone())]));
        let binding = Mutex::new(BTreeMap::from([(0, 11), (2, 22)]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        enqueue_plugin_ui_closed_by_respawn(&routes, Some(&binding), &[w1, w2], &events);

        let received = [
            receiver.try_recv().expect("first respawn event"),
            receiver.try_recv().expect("second respawn event"),
        ];
        assert_eq!(received.len(), 2);
        assert!(received.contains(&PluginUiEvent::ClosedByRespawn { target: t1 }));
        assert!(received.contains(&PluginUiEvent::ClosedByRespawn { target: t2 }));
        assert!(routes.lock().expect("routes").is_empty());
        assert!(binding.lock().expect("binding").is_empty());
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct SavedPluginStateSummary {
    pub path: PathBuf,
    pub bytes_written: u64,
}

pub struct PlayHandle {
    pub play_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
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

#[cfg(feature = "clap-host")]
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

/// device switch（#484 D2）: `select_audio_device` の非 cpal 分岐（capture 拒否・
/// owner thread 未生存）を `StubBackend`（実 cpal I/O を伴わない test backend）で検証する。
/// 実際の cpal `Device`/`Stream` 差し替えそのもの（`apply_device_switch`）は実機 gated harness の
/// 領域（unit test では検証不能）。
#[cfg(test)]
mod select_audio_device_tests {
    use super::{EngineWrap, StreamConfigSnapshot};
    use crate::backend::StubBackend;

    /// capture-active（`ORBIT_CAPTURE_WAV`）拒否と、audio owner thread 未登録（`start_with` /
    /// test backend 経路）拒否の両方を **1 テスト関数内**で順に検証する。`ORBIT_CAPTURE_WAV` は
    /// プロセス全体で共有される可変状態なので、別テスト関数に分けて cargo test のデフォルト並列
    /// 実行に晒すと set/remove がレースする（`named_bus_pool_tests` の既存 env 慣習と同じ落とし穴）。
    #[test]
    fn select_audio_device_rejects_capture_active_then_missing_owner_thread() {
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

        // capture を無効化すると、`start_with`（test backend）が `install_device_switch_channel`
        // を一度も呼んでいないため「audio owner thread 未登録」として明示的に reject する
        // （無音で成功したふりをしない）。
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
            }
        );

        wrap.record_stream_config(
            StreamConfigSnapshot {
                device_name: "switched output".to_string(),
                sample_rate: 96_000,
                channels: 6,
            },
            None,
            None,
        );

        let switched = wrap.stream_config_snapshot();
        assert_eq!(switched.device_name, "switched output");
        assert_eq!(wrap.output_sample_rate(), 96_000);
        assert_eq!(wrap.output_channels(), 6);
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
    use orbit_audio_sandbox::NeutralEvent;
    use std::collections::HashMap;
    use std::io::Write;
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
                .all(|cell| cell.load() == orbit_audio_native::SourceDest::Master),
            "a successfully freed slot must reset every source unit to Master"
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
                .all(|cell| cell.load() == orbit_audio_native::SourceDest::Master),
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

    #[derive(Clone)]
    struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

    struct CaptureGuard(Arc<Mutex<Vec<u8>>>);

    impl Write for CaptureGuard {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("capture log mutex").extend(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
        type Writer = CaptureGuard;

        fn make_writer(&'a self) -> Self::Writer {
            CaptureGuard(self.0.clone())
        }
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
        let log = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(CaptureWriter(log.clone()))
            .finish();
        let started = Instant::now();
        let result = tracing::subscriber::with_default(subscriber, || {
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
        let rendered = String::from_utf8(log.lock().expect("capture log mutex").clone())
            .expect("tracing output is utf8");
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
