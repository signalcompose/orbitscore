use super::*;

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Mutex;
use std::thread::ThreadId;

use orbit_audio_sandbox::transport::{CHILD_STATUS_LOAD_FAILED, CHILD_STATUS_READY};

#[derive(Clone, Copy)]
enum Operation {
    Add(f32),
    Mul(f32),
}

struct SynthAudio {
    operation: Operation,
}

impl AudioStage for SynthAudio {
    fn apply_params(&mut self, params: &[ResolvedParam]) -> Result<(), String> {
        for param in params {
            if param.id != 0 {
                return Err(format!("unknown synthetic parameter {}", param.id));
            }
            match &mut self.operation {
                Operation::Add(value) | Operation::Mul(value) => *value = param.value as f32,
            }
        }
        Ok(())
    }

    fn process_block(&mut self, block: &mut [f32]) -> bool {
        for sample in block {
            match self.operation {
                Operation::Add(value) => *sample += value,
                Operation::Mul(value) => *sample *= value,
            }
        }
        true
    }
}

#[derive(Default)]
struct Stats {
    live: AtomicUsize,
    drops: AtomicUsize,
    drop_threads: Mutex<Vec<ThreadId>>,
    trace: Mutex<Vec<String>>,
    writes: Mutex<Vec<(PathBuf, Vec<u8>)>>,
}

struct SynthControl {
    stats: Arc<Stats>,
    state: Vec<u8>,
    standard: bool,
}

impl Drop for SynthControl {
    fn drop(&mut self) {
        self.stats.live.fetch_sub(1, Ordering::SeqCst);
        self.stats.drops.fetch_add(1, Ordering::SeqCst);
        self.stats
            .drop_threads
            .lock()
            .expect("drop thread log")
            .push(std::thread::current().id());
    }
}

impl ControlStage for SynthControl {
    fn capture_state(&mut self) -> Result<Vec<u8>, String> {
        Ok(self.state.clone())
    }

    fn resolve_params(
        &mut self,
        params: &BTreeMap<String, f64>,
    ) -> Result<Vec<ResolvedParam>, String> {
        params
            .iter()
            .map(|(name, value)| {
                if name != "value" {
                    return Err(format!("unknown synthetic parameter {name}"));
                }
                Ok(ResolvedParam {
                    id: 0,
                    value: *value,
                })
            })
            .collect()
    }

    fn is_standard(&self) -> bool {
        self.standard
    }
}

struct SynthFactory {
    stats: Arc<Stats>,
    next_generation: u64,
    fail_write: AtomicBool,
}

impl SynthFactory {
    fn new(stats: Arc<Stats>) -> Self {
        Self {
            stats,
            next_generation: 1,
            fail_write: AtomicBool::new(false),
        }
    }

    fn operation(spec: &StageSpec) -> Result<(Operation, bool, Vec<u8>), String> {
        match spec {
            StageSpec::Catalog { path, .. } => {
                let name = path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if name == "fail" {
                    return Err("synthetic load failure".into());
                }
                let operation = if let Some(value) = name.strip_prefix("add-") {
                    Operation::Add(value.parse().map_err(|_| "invalid add stage")?)
                } else if let Some(value) = name.strip_prefix("mul-") {
                    Operation::Mul(value.parse().map_err(|_| "invalid mul stage")?)
                } else {
                    return Err(format!("unknown synthetic stage {name}"));
                };
                Ok((operation, false, name.as_bytes().to_vec()))
            }
            StageSpec::Standard { name, .. } => {
                let operation = if let Some(value) = name.strip_prefix("Add") {
                    Operation::Add(value.parse().map_err(|_| "invalid standard add")?)
                } else {
                    Operation::Mul(1.0)
                };
                Ok((operation, true, Vec::new()))
            }
            StageSpec::Layer { .. } => Err("layer is unsupported".into()),
        }
    }
}

impl StageFactory for SynthFactory {
    fn load(&mut self, spec: &StageSpec, index: usize) -> Result<Box<StageInstance>, String> {
        self.stats
            .trace
            .lock()
            .expect("trace")
            .push(format!("load:{index}"));
        let (operation, standard, state) = Self::operation(spec)?;
        self.stats.live.fetch_add(1, Ordering::SeqCst);
        let generation = self.next_generation;
        self.next_generation += 1;
        let mut control = SynthControl {
            stats: self.stats.clone(),
            state,
            standard,
        };
        let initial_params = control.resolve_params(spec.params())?;
        Ok(Box::new(StageInstance::new(
            Box::new(SynthAudio { operation }),
            Box::new(control),
            initial_params,
            generation,
            true,
        )))
    }

    fn write_state(&mut self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        self.stats
            .trace
            .lock()
            .expect("trace")
            .push(format!("save:{}", path.display()));
        if self.fail_write.load(Ordering::SeqCst) {
            return Err("injected state write failure".into());
        }
        self.stats
            .writes
            .lock()
            .expect("writes")
            .push((path.to_path_buf(), bytes.to_vec()));
        Ok(())
    }
}

fn catalog(name: &str, enabled: bool) -> StageSpec {
    StageSpec::Catalog {
        path: PathBuf::from(format!("{name}.clap")),
        plugin_id: None,
        state: None,
        enabled,
    }
}

fn load_plan(specs: Vec<StageSpec>) -> ApplyPlan {
    ApplyPlan {
        version: 1,
        stages: specs
            .into_iter()
            .map(|stage| PlanStage::Load { stage })
            .collect(),
        save_dropped: Vec::new(),
    }
}

fn keep_plan(index: usize, enabled: bool, params: BTreeMap<String, f64>) -> ApplyPlan {
    ApplyPlan {
        version: 1,
        stages: vec![PlanStage::Keep {
            prev_index: index,
            enabled,
            params,
        }],
        save_dropped: Vec::new(),
    }
}

fn fixture(
    specs: &[StageSpec],
) -> (
    RackController,
    AudioChain,
    SynthFactory,
    Arc<Stats>,
    AtomicU32,
) {
    let stats = Arc::new(Stats::default());
    let mut factory = SynthFactory::new(stats.clone());
    let status = AtomicU32::new(0);
    let (controller, audio) =
        RackController::load_initial(ChainExchange::new(), &mut factory, specs, &status)
            .expect("load initial synthetic chain");
    (controller, audio, factory, stats, status)
}

#[test]
fn c01_stages_process_in_declared_non_commutative_order() {
    let (_controller, mut audio, _factory, _stats, _status) =
        fixture(&[catalog("add-1", true), catalog("mul-2", true)]);
    let active = AtomicU32::new(u32::MAX);
    let mut block = [3.0];
    assert_eq!(audio.process_block(&mut block, &active), 0);
    assert_eq!(block, [8.0], "(3 + 1) * 2 must preserve declaration order");
}

#[test]
fn c02_failed_prepare_keeps_old_chain_and_reports_failed_index() {
    let (mut controller, mut audio, mut factory, stats, _status) =
        fixture(&[catalog("add-1", true)]);
    let error = controller
        .apply(
            &load_plan(vec![catalog("mul-2", true), catalog("fail", true)]),
            &mut factory,
        )
        .expect_err("second load must fail");
    assert_eq!(error.kind, ApplyFailureKind::Plugin);
    assert_eq!(error.failed_index, Some(1));
    assert_eq!(
        stats.live.load(Ordering::SeqCst),
        1,
        "old stage remains alive"
    );
    let mut block = [3.0];
    audio.process_block(&mut block, &AtomicU32::new(u32::MAX));
    assert_eq!(
        block,
        [4.0],
        "failed apply must leave the old chain audible"
    );
}

#[test]
fn c03_failed_prepare_drops_every_newly_built_stage() {
    let (mut controller, _audio, mut factory, stats, _status) = fixture(&[catalog("add-1", true)]);
    let drops_before = stats.drops.load(Ordering::SeqCst);
    let _ = controller.apply(
        &load_plan(vec![catalog("mul-2", true), catalog("fail", true)]),
        &mut factory,
    );
    assert_eq!(stats.live.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.drops.load(Ordering::SeqCst),
        drops_before + 1,
        "the successfully prepared new stage must be destroyed on abort"
    );
}

#[test]
fn c04_disabled_stage_is_identity_and_reenable_restores_processing() {
    let (mut controller, mut audio, mut factory, _stats, _status) =
        fixture(&[catalog("mul-2", false)]);
    let active = AtomicU32::new(u32::MAX);
    let mut disabled = [3.0];
    audio.process_block(&mut disabled, &active);
    assert_eq!(disabled, [3.0]);

    controller
        .apply(&keep_plan(0, true, BTreeMap::new()), &mut factory)
        .expect("enable keep");
    let mut enabled = [3.0];
    audio.process_block(&mut enabled, &active);
    assert_eq!(enabled, [6.0]);
    assert!(controller.collect_retired());
}

#[test]
fn c06_state_capture_finishes_before_swap_and_save_failure_aborts() {
    let (mut controller, mut audio, mut factory, stats, _status) =
        fixture(&[catalog("add-1", true)]);
    let path = PathBuf::from("captured.state");
    let plan = ApplyPlan {
        version: 1,
        stages: vec![PlanStage::Load {
            stage: catalog("mul-2", true),
        }],
        save_dropped: vec![SaveDropped {
            prev_index: 0,
            path: path.clone(),
        }],
    };
    controller
        .apply(&plan, &mut factory)
        .expect("prepared apply");
    assert_eq!(
        stats.trace.lock().expect("trace").as_slice(),
        ["load:0", "save:captured.state", "load:0"],
        "state write must complete before the replacement is published"
    );
    let mut block = [3.0];
    audio.process_block(&mut block, &AtomicU32::new(u32::MAX));
    assert_eq!(block, [6.0]);
    assert!(controller.collect_retired());

    let (mut controller, mut audio, mut factory, _stats, _status) =
        fixture(&[catalog("add-1", true)]);
    factory.fail_write.store(true, Ordering::SeqCst);
    let error = controller
        .apply(&plan, &mut factory)
        .expect_err("save failure must abort");
    assert_eq!(error.kind, ApplyFailureKind::Io);
    let mut block = [3.0];
    audio.process_block(&mut block, &AtomicU32::new(u32::MAX));
    assert_eq!(block, [4.0], "save failure must leave the old chain intact");
}

#[test]
fn c07_retired_stage_destruction_runs_on_collecting_main_thread() {
    let (mut controller, mut audio, mut factory, stats, _status) =
        fixture(&[catalog("add-1", true)]);
    controller
        .apply(&load_plan(Vec::new()), &mut factory)
        .expect("publish empty chain");
    assert_eq!(stats.drops.load(Ordering::SeqCst), 0);
    let main_thread = std::thread::current().id();
    audio.current.drop_threads = Some(Arc::new(Mutex::new(Vec::new())));
    let list_drop_threads = audio
        .current
        .drop_threads
        .as_ref()
        .expect("drop observer")
        .clone();
    let audio = std::thread::spawn(move || {
        let mut audio = audio;
        audio.process_block(&mut [1.0], &AtomicU32::new(u32::MAX));
        audio
    })
    .join()
    .expect("audio thread");
    assert_eq!(stats.drops.load(Ordering::SeqCst), 0);
    assert!(list_drop_threads.lock().expect("list drops").is_empty());
    assert!(controller.collect_retired());
    assert_eq!(stats.drops.load(Ordering::SeqCst), 1);
    assert_eq!(
        stats.drop_threads.lock().expect("drop threads").as_slice(),
        [main_thread]
    );
    assert_eq!(
        list_drop_threads.lock().expect("list drops").as_slice(),
        [main_thread]
    );
    drop(audio);
}

#[test]
fn c08_ready_is_not_published_when_a_later_stage_fails_to_load() {
    let stats = Arc::new(Stats::default());
    let status = AtomicU32::new(0);
    struct ReadyObservingFactory<'a> {
        inner: SynthFactory,
        status: &'a AtomicU32,
        observed_before_failure: u32,
    }
    impl StageFactory for ReadyObservingFactory<'_> {
        fn load(&mut self, spec: &StageSpec, index: usize) -> Result<Box<StageInstance>, String> {
            if index == 1 {
                self.observed_before_failure = self.status.load(Ordering::Acquire);
            }
            self.inner.load(spec, index)
        }
    }
    let mut factory = ReadyObservingFactory {
        inner: SynthFactory::new(stats),
        status: &status,
        observed_before_failure: u32::MAX,
    };
    let error = RackController::load_initial(
        ChainExchange::new(),
        &mut factory,
        &[catalog("add-1", true), catalog("fail", true)],
        &status,
    )
    .err()
    .expect("second stage load failure");
    assert_eq!(error.failed_index, Some(1));
    assert_ne!(factory.observed_before_failure, CHILD_STATUS_READY);
    assert_eq!(status.load(Ordering::Acquire), CHILD_STATUS_LOAD_FAILED);
    assert_ne!(status.load(Ordering::Acquire), CHILD_STATUS_READY);
}

#[test]
fn c09_active_stage_index_tracks_the_last_declared_stage() {
    let (_controller, mut audio, _factory, _stats, _status) = fixture(&[
        catalog("add-1", true),
        catalog("mul-2", false),
        catalog("add-3", true),
    ]);
    let active = AtomicU32::new(u32::MAX);
    audio.process_block(&mut [1.0], &active);
    assert_eq!(active.load(Ordering::Relaxed), 2);
}

#[test]
fn c10_save_state_at_uses_the_requested_stage_index() {
    let (mut controller, _audio, mut factory, stats, _status) =
        fixture(&[catalog("add-1", true), catalog("mul-2", true)]);
    let outcome = controller.save_state_at(1, Path::new("stage-1.state"), &mut factory);
    assert_eq!(outcome.result, CMD_RESULT_OK);
    assert_eq!(
        stats.writes.lock().expect("writes").as_slice(),
        [(PathBuf::from("stage-1.state"), b"mul-2".to_vec())]
    );
}

struct PublishDuringProcess {
    operation: Operation,
    exchange: Arc<ChainExchange>,
    next: Option<Box<StageList>>,
}

impl AudioStage for PublishDuringProcess {
    fn process_block(&mut self, block: &mut [f32]) -> bool {
        if let Some(next) = self.next.take() {
            assert!(self.exchange.publish(next).is_ok(), "publish test list");
        }
        SynthAudio {
            operation: self.operation,
        }
        .process_block(block)
    }
}

#[test]
fn c11_chain_swap_is_observed_only_at_a_block_boundary() {
    let exchange = ChainExchange::new();
    let stats = Arc::new(Stats::default());
    let make = |audio: Box<dyn AudioStage>| {
        stats.live.fetch_add(1, Ordering::SeqCst);
        Box::new(StageInstance::new(
            audio,
            Box::new(SynthControl {
                stats: stats.clone(),
                state: Vec::new(),
                standard: false,
            }),
            Vec::new(),
            1,
            true,
        ))
    };
    let new_stage = make(Box::new(SynthAudio {
        operation: Operation::Add(10.0),
    }));
    let next = Box::new(StageList {
        entries: vec![StageEntry {
            audio: new_stage.audio_ptr(),
            enabled: true,
            params: Vec::new(),
        }],
        apply_params_once: true,
        drop_threads: None,
    });
    let old_first = make(Box::new(PublishDuringProcess {
        operation: Operation::Add(1.0),
        exchange: exchange.clone(),
        next: Some(next),
    }));
    let old_second = make(Box::new(SynthAudio {
        operation: Operation::Mul(2.0),
    }));
    let current = Box::new(StageList {
        entries: vec![
            StageEntry {
                audio: old_first.audio_ptr(),
                enabled: true,
                params: Vec::new(),
            },
            StageEntry {
                audio: old_second.audio_ptr(),
                enabled: true,
                params: Vec::new(),
            },
        ],
        apply_params_once: true,
        drop_threads: None,
    });
    let mut audio = AudioChain::new(exchange, current);
    let active = AtomicU32::new(u32::MAX);
    let mut first = [3.0];
    audio.process_block(&mut first, &active);
    assert_eq!(first, [8.0], "the publishing block must remain wholly old");
    let mut second = [3.0];
    audio.process_block(&mut second, &active);
    assert_eq!(second, [13.0], "the following block must be wholly new");
    drop((audio, old_first, old_second, new_stage));
}

#[cfg(target_os = "macos")]
#[test]
fn c12_extension_selects_both_hosts_case_insensitively() {
    assert_eq!(
        host_format_for_path(Path::new("A.CLAP")),
        Ok(HostFormat::Clap)
    );
    assert_eq!(
        host_format_for_path(Path::new("B.vSt3")),
        Ok(HostFormat::Vst3)
    );
}

#[test]
fn c13_standard_path_uses_executable_sibling_and_env_override() {
    assert_eq!(
        resolve_standard_plugin_path(Path::new("/app/bin/rack"), None, "Gain").unwrap(),
        PathBuf::from("/app/bin/std-plugins/Gain.clap")
    );
    assert_eq!(
        resolve_standard_plugin_path(
            Path::new("/app/bin/rack"),
            Some(Path::new("/test/plugins")),
            "Gain",
        )
        .unwrap(),
        PathBuf::from("/test/plugins/Gain.clap")
    );
}

#[cfg(target_os = "macos")]
struct ActualFixture {
    path: PathBuf,
    _mmap: Box<dyn std::any::Any>,
    region: *mut orbit_audio_sandbox::SharedRegion,
}

#[cfg(target_os = "macos")]
impl ActualFixture {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "orbit-rack-{label}-{}-{}.shm",
            std::process::id(),
            line!()
        ));
        let mmap = orbit_audio_sandbox::create_shared(&path).expect("create rack shm");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        Self {
            path,
            _mmap: Box::new(mmap),
            region,
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for ActualFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(target_os = "macos")]
fn gain_bundle_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/std-plugins")
}

#[cfg(target_os = "macos")]
fn actual_gain(
    db: f64,
) -> (
    RackController,
    AudioChain,
    crate::macos::ActualFactory,
    ActualFixture,
) {
    let fixture = ActualFixture::new("gain");
    let mut factory = crate::macos::ActualFactory::new(fixture.region, 48_000).expect("factory");
    factory.set_standard_dir(gain_bundle_dir());
    let spec = StageSpec::Standard {
        name: "Gain".into(),
        params: BTreeMap::from([("db".into(), db)]),
        enabled: true,
    };
    let (controller, audio) =
        RackController::load_initial(ChainExchange::new(), &mut factory, &[spec], unsafe {
            &(*fixture.region).child_status
        })
        .expect("load real Gain.clap");
    (controller, audio, factory, fixture)
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires bash crates/orbit-std-gain/bundle-macos.sh"]
fn c05_real_gain_keep_updates_db_without_reconstruction() {
    let (mut controller, mut audio, mut factory, fixture) = actual_gain(0.0);
    let generation = controller.construction_generation(0);
    let mut before = [1.0, 1.0];
    audio.process_block(&mut before, unsafe {
        &(*fixture.region).active_stage_index
    });
    assert_eq!(before, [1.0, 1.0]);
    controller
        .apply(
            &keep_plan(0, true, BTreeMap::from([("db".into(), -20.0)])),
            &mut factory,
        )
        .expect("keep Gain and update db");
    assert_eq!(controller.construction_generation(0), generation);
    let mut after = [1.0, 1.0];
    audio.process_block(&mut after, unsafe { &(*fixture.region).active_stage_index });
    assert!((after[0] - 0.1).abs() < 1e-5, "after={after:?}");
    controller.collect_retired();
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires bash crates/orbit-std-gain/bundle-macos.sh"]
fn c13_real_gain_resolves_the_db_parameter_by_name() {
    let (mut controller, mut audio, mut factory, fixture) = actual_gain(0.0);
    controller
        .apply(
            &keep_plan(0, true, BTreeMap::from([("db".into(), -20.0)])),
            &mut factory,
        )
        .expect("the public CLAP name db must resolve");
    let mut block = [1.0, 1.0];
    audio.process_block(&mut block, unsafe { &(*fixture.region).active_stage_index });
    assert!((block[0] - 0.1).abs() < 1e-5);
    controller.collect_retired();

    let error = controller
        .apply(
            &keep_plan(0, true, BTreeMap::from([("not-db".into(), -20.0)])),
            &mut factory,
        )
        .expect_err("unknown name must not fall back to the first parameter");
    assert!(error.detail.contains("not-db"));
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires bash crates/orbit-std-gain/bundle-macos.sh"]
fn c14_real_gain_obeys_the_decibel_contract() {
    let (_controller, mut audio, _factory, fixture) = actual_gain(-20.0);
    let mut quiet = [1.0, -1.0];
    audio.process_block(&mut quiet, unsafe { &(*fixture.region).active_stage_index });
    assert!((quiet[0] - 0.1).abs() < 1e-5, "quiet={quiet:?}");
    assert!((quiet[1] + 0.1).abs() < 1e-5, "quiet={quiet:?}");

    let (_controller, mut audio, _factory, fixture) = actual_gain(0.0);
    let mut unity = [0.25, -0.5];
    audio.process_block(&mut unity, unsafe { &(*fixture.region).active_stage_index });
    assert_eq!(unity, [0.25, -0.5]);
}

/// 🔴 daemon が実際に書き出す APPLY plan の JSON をそのまま受理できること。
///
/// **#628 の実機ゲートで、daemon 側を直した直後に child 側で同じ欠陥が出た。**
/// `PlanStage` に `deny_unknown_fields` が付いており、serde は `flatten` との併用を
/// 支持しないため `Load` の中身が unknown field になっていた:
///
/// ```text
/// parse …/apply.json: unknown field `kind` at line 1 column 302
/// ```
///
/// **この文字列は daemon 側 `EffectChainPlan` の serde 出力形をそのまま写したもの**で、
/// 手で整えないこと — wire の実物と乖離した瞬間にこのテストは無意味になる。
#[test]
fn apply_plan_accepts_the_manifest_the_daemon_actually_writes() {
    let json = r#"{
        "version": 1,
        "stages": [
            {"op":"load","kind":"catalog","path":"/x/CLAPTestEffect.clap","enabled":true},
            {"op":"load","kind":"standard","name":"Gain","params":{"db":-20.0},"enabled":false},
            {"op":"keep","prev_index":0,"enabled":true,"params":{"db":-6.0}}
        ],
        "save_dropped": []
    }"#;
    let plan: super::ApplyPlan =
        serde_json::from_str(json).expect("daemon が書く plan は受理されなければならない");
    assert_eq!(plan.stages.len(), 3);

    // enabled が既定値へ落ちず、送られた値のまま届くこと（落ちると
    // 「バイパスしたのに音が鳴る」という無言の故障になる）。
    match &plan.stages[1] {
        super::PlanStage::Load {
            stage:
                super::StageSpec::Standard {
                    name,
                    params,
                    enabled,
                },
        } => {
            assert_eq!(name, "Gain");
            assert_eq!(params.get("db"), Some(&-20.0));
            assert!(!enabled, "enabled:false が既定 true に落ちてはいけない");
        }
        other => panic!("index 1 は standard load のはず: {other:?}"),
    }
}

/// 内側（`StageSpec`）の `deny_unknown_fields` は生きていること。
/// 外側から外したのは flatten の制約が理由であって、**検査を緩めたのではない**。
#[test]
fn unknown_fields_inside_a_stage_are_still_rejected() {
    let json = r#"{"version":1,"stages":[{"op":"load","kind":"catalog","path":"/x/y.clap",
                  "enabled":true,"bogus":1}],"save_dropped":[]}"#;
    assert!(
        serde_json::from_str::<super::ApplyPlan>(json).is_err(),
        "stage の中の未知フィールドは従来どおり拒否されなければならない"
    );
}
