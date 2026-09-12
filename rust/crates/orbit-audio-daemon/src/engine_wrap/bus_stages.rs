//! エフェクトバス stage の構築（#888 子 1・第 12 束＝最終）。
//!
//! 🔴 **本文は 1 行も書き換えていない。** 変えたのは可視性だけで、`startup.rs` /
//! `startup_instrument.rs` から呼ばれる項目に `pub(super)` を付けた（設計 §14）。
//! `build_effect_bus_stages` /
//! `install_effect_bus_slots` と、その周辺のインラインテストをそのまま移した。

#[allow(unused_imports)]
use super::*;

/// `ORBIT_EFFECT_BUSES`/`ORBIT_EFFECT_BUS_POOL`（insert）+ `ORBIT_SUM_BUS_POOL`（sum）+
/// `ORBIT_AUX_BUS_POOL`（aux）の bus 名から、render 側の `InsertBusStage` 群と daemon 側の部材
/// （`EffectBusBuild`）を構築する。**stage 配列の並びは `[insert…, sum…, aux…]` に固定**する
/// （MX.4: insert → sum/aux への forward-only 参照が常に構築可能になるよう、insert を先頭に
/// 置く）。stage は inactive で生まれ、LoadPlugin（`load_outproc_effect_plugin` の bus 指定）
/// で activate される。sum/aux stage も同じ `OutProcEffectPostProcessor` 機構（PH.2b）で
/// 自前の insert chain を持てる（M2 で明示解禁）。
#[cfg(feature = "outproc-effect")]
pub(super) fn build_effect_bus_stages() -> Result<EffectBusStagesBuild, WrapError> {
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
    let mut bus_lines = HashMap::with_capacity(total);
    let mut bus_line_programs = HashMap::with_capacity(total);
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
        let stage = orbit_audio_native::InsertBusStage::with_activation(
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
        );
        bus_lines.insert(name.clone(), stage.legacy_line_installer());
        bus_line_programs.insert(name.clone(), stage.line_program_installer());
        insert_buses.push(stage);
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
    Ok((insert_buses, builds, bus_lines, bus_line_programs))
}

/// bus 部材を ChildSlot / 観測 map / routing map / StreamGuard 用 guard 群へ展開する（stream 起動後・
/// sample_rate 確定後に呼ぶ）。返り値: (bus_slots, bus_stats, bus_actives, bus_kinds, bus_index,
/// bus_routing, bus_sends, bus_entries, child_guards, teardowns)。
#[cfg(feature = "outproc-effect")]
#[allow(clippy::type_complexity)]
pub(super) fn install_effect_bus_slots(
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
        let mut bus_lines = wrap.bus_lines.lock().expect("lock bus lines for injection");
        for name in ["seq-bus-0", "sum-bus-0", "aux-bus-0"] {
            bus_lines.insert(name.to_owned(), Arc::new(|_, _, _, _| Ok(())));
        }
        drop(bus_lines);
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
    fn set_bus_routing_publishes_one_complete_legacy_line_program_per_partial_update() {
        let wrap = wrap_with_three_stage_topology();
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = calls.clone();
        wrap.bus_lines.lock().unwrap().insert(
            "seq-bus-0".to_owned(),
            Arc::new(move |target, sends, bus_index, bus_count| {
                recorded
                    .lock()
                    .unwrap()
                    .push((target, sends, bus_index, bus_count));
                Ok(())
            }),
        );

        wrap.set_bus_routing(
            "seq-bus-0",
            Some("sum-bus-0"),
            &[("aux-bus-0".to_owned(), 0.375)],
        )
        .expect("legacy routing must publish a line program");
        wrap.set_bus_routing("seq-bus-0", Some("master"), &[])
            .expect("output-only update must retain the existing send");

        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let (target, sends, bus_index, bus_count) = &calls[0];
        assert_eq!(*target, super::BusTarget::Bus(1));
        assert_eq!((*bus_index, *bus_count), (0, 3));
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].target, 2);
        assert_eq!(sends[0].gain.to_bits(), 0.375_f32.to_bits());
        let (target, sends, bus_index, bus_count) = &calls[1];
        assert_eq!(*target, super::BusTarget::Master);
        assert_eq!((*bus_index, *bus_count), (0, 3));
        assert_eq!(sends.len(), 1, "the unmentioned send must be retained");
        assert_eq!(sends[0].target, 2);
        assert_eq!(sends[0].gain.to_bits(), 0.375_f32.to_bits());
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

    #[test]
    fn set_bus_routing_rejects_bus_without_registered_line() {
        let wrap = wrap_with_three_stage_topology();
        wrap.bus_lines.lock().unwrap().remove("seq-bus-0");

        let error = wrap
            .set_bus_routing("seq-bus-0", Some("master"), &[])
            .expect_err("a bus without an RT line installer must be rejected");
        let message = format!("{error:?}");
        assert!(message.contains("unknown bus 'seq-bus-0'"), "{message}");
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

#[cfg(all(test, feature = "outproc-effect"))]
mod set_bus_line_tests {
    use super::{
        line_republish_seeds, BusLineDest, BusLineOp, EngineWrap, LineOp, LineOutput, WrapError,
    };
    use crate::backend::StubBackend;
    use crate::session::wrap_err_to_protocol;
    use orbit_audio_native::LineProgramInstaller;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    type RecordedInstalls = Arc<Mutex<Vec<Vec<LineOp>>>>;
    type RecordedInstallCalls = Arc<Mutex<Vec<(Vec<LineOp>, usize, usize)>>>;

    fn wrap_and_installs() -> (Arc<EngineWrap>, RecordedInstalls) {
        let wrap = super::set_bus_routing_tests::wrap_with_three_stage_topology();
        let installs = Arc::new(Mutex::new(Vec::new()));
        let recorded = installs.clone();
        wrap.bus_line_programs.lock().unwrap().insert(
            "seq-bus-0".to_owned(),
            LineProgramInstaller::new(
                move |program, _, _| {
                    recorded.lock().unwrap().push(program.ops.to_vec());
                    Ok(())
                },
                || vec![1.0, 1.0],
            ),
        );
        (wrap, installs)
    }

    fn wrap_and_install_calls() -> (Arc<EngineWrap>, RecordedInstallCalls) {
        let wrap = super::set_bus_routing_tests::wrap_with_three_stage_topology();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        wrap.bus_line_programs.lock().unwrap().insert(
            "seq-bus-0".to_owned(),
            LineProgramInstaller::new(
                move |program, bus_index, bus_count| {
                    recorded
                        .lock()
                        .unwrap()
                        .push((program.ops.to_vec(), bus_index, bus_count));
                    Ok(())
                },
                || vec![1.0, 1.0],
            ),
        );
        (wrap, calls)
    }

    fn wrap_and_master_install_calls() -> (Arc<EngineWrap>, RecordedInstallCalls) {
        let (mut wrap, _guard) =
            EngineWrap::start_with(StubBackend::default()).expect("stub backend start");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let wrap_mut = Arc::get_mut(&mut wrap).expect("fresh wrap must be uniquely owned");
        wrap_mut.master_line = LineProgramInstaller::new(
            move |program, bus_index, bus_count| {
                recorded
                    .lock()
                    .unwrap()
                    .push((program.ops.to_vec(), bus_index, bus_count));
                Ok(())
            },
            || vec![1.0, 1.0, 1.0],
        );
        (wrap, calls)
    }

    fn output(dest: BusLineDest, thru: bool, gain: f32) -> BusLineOp {
        BusLineOp::Output { dest, thru, gain }
    }

    #[test]
    fn set_bus_line_wire_bus_destination_must_be_known_and_forward_only() {
        let (wrap, _) = wrap_and_installs();
        for (bus, dest) in [("seq-bus-0", "missing-bus"), ("sum-bus-0", "seq-bus-0")] {
            let error = wrap
                .set_bus_line(bus, &[output(BusLineDest::Bus(dest.into()), false, 1.0)])
                .expect_err("unknown or backward bus destination must be rejected");
            let protocol = wrap_err_to_protocol(&error);
            eprintln!("set_bus_line validation code={}", protocol.code);
            assert_eq!(protocol.code, "OUTPROC_EFFECT_RUNTIME");
        }
    }

    #[cfg(not(feature = "link-audio"))]
    #[test]
    fn set_bus_line_wire_link_requires_the_link_audio_feature() {
        let (wrap, _) = wrap_and_installs();
        let error = wrap
            .set_bus_line(
                "seq-bus-0",
                &[output(BusLineDest::Link("live-out".into()), false, 1.0)],
            )
            .expect_err("link destination must reject a build without link-audio");
        let protocol = wrap_err_to_protocol(&error);
        eprintln!("set_bus_line validation code={}", protocol.code);
        assert_eq!(protocol.code, "LINK_AUDIO_UNAVAILABLE");
    }

    #[test]
    fn set_bus_line_installs_the_sent_program_in_signal_order() {
        let (wrap, installs) = wrap_and_installs();
        wrap.set_bus_line(
            "seq-bus-0",
            &[
                BusLineOp::Rack,
                BusLineOp::Gain(0.5),
                BusLineOp::Pan(0.25),
                output(BusLineDest::Bus("sum-bus-0".into()), true, 0.25),
                output(BusLineDest::Master, false, 1.0),
            ],
        )
        .expect("valid line must install");

        assert_eq!(
            installs.lock().unwrap().as_slice(),
            &[vec![
                LineOp::Rack,
                LineOp::Gain(0.5),
                LineOp::Pan(0.25),
                LineOp::Output(LineOutput {
                    dest: orbit_audio_native::OutputDest::Bus(1),
                    thru: true,
                    gain: 0.25,
                }),
                LineOp::Output(LineOutput {
                    dest: orbit_audio_native::OutputDest::Master,
                    thru: false,
                    gain: 1.0,
                }),
            ]]
        );
    }

    #[test]
    fn set_bus_line_accepts_a_rack_only_program_with_no_destination() {
        let (wrap, installs) = wrap_and_installs();

        wrap.set_bus_line("seq-bus-0", &[BusLineOp::Rack])
            .expect("an explicit line with no output must be accepted");

        assert_eq!(installs.lock().unwrap().as_slice(), &[vec![LineOp::Rack]]);
    }

    #[test]
    fn set_bus_line_activates_source_and_referenced_destination_buses() {
        let (wrap, calls) = wrap_and_install_calls();
        let (source_active, destination_active) = {
            let guard = wrap.outproc.lock().unwrap();
            let control = guard.as_ref().expect("effect control");
            (
                control.bus_actives["seq-bus-0"].clone(),
                control.bus_actives["sum-bus-0"].clone(),
            )
        };

        wrap.set_bus_line(
            "seq-bus-0",
            &[output(BusLineDest::Bus("sum-bus-0".into()), false, 1.0)],
        )
        .expect("forward bus output must install");

        assert!(
            source_active.load(Ordering::Acquire),
            "source must activate"
        );
        assert!(
            destination_active.load(Ordering::Acquire),
            "referenced destination must activate"
        );
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(
                vec![LineOp::Output(LineOutput {
                    dest: orbit_audio_native::OutputDest::Bus(1),
                    thru: false,
                    gain: 1.0,
                })],
                0,
                3,
            )]
        );
    }

    #[test]
    fn set_bus_line_converts_one_based_mono_device_channel_for_the_installer() {
        let (wrap, calls) = wrap_and_install_calls();

        wrap.set_bus_line(
            "seq-bus-0",
            &[output(
                BusLineDest::Device {
                    left: 3,
                    right: None,
                },
                false,
                1.0,
            )],
        )
        .expect("valid device channels must install");

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(
                vec![LineOp::Output(LineOutput {
                    dest: orbit_audio_native::OutputDest::Device {
                        left: 2,
                        right: None,
                    },
                    thru: false,
                    gain: 1.0,
                })],
                0,
                3,
            )]
        );
    }

    #[test]
    fn set_bus_line_master_is_successful_and_all_or_nothing() {
        let (wrap, calls) = wrap_and_master_install_calls();
        let installed = vec![
            LineOp::Rack,
            LineOp::Gain(0.5),
            LineOp::Output(LineOutput {
                dest: orbit_audio_native::OutputDest::Device {
                    left: 0,
                    right: Some(1),
                },
                thru: false,
                gain: 0.75,
            }),
        ];

        wrap.set_bus_line(
            "master",
            &[
                BusLineOp::Rack,
                BusLineOp::Gain(0.5),
                output(
                    BusLineDest::Device {
                        left: 1,
                        right: Some(2),
                    },
                    false,
                    0.75,
                ),
            ],
        )
        .expect("valid master line must install");
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(installed.clone(), usize::MAX, 0)]
        );
        assert_eq!(*wrap.master_line_program.lock().unwrap(), installed);

        let error = wrap
            .set_bus_line(
                "master",
                &[
                    BusLineOp::Gain(0.25),
                    output(BusLineDest::Master, false, 1.0),
                ],
            )
            .expect_err("master self-reference must reject the complete replacement");
        assert_eq!(wrap_err_to_protocol(&error).code, "MALFORMED_REQUEST");
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(installed.clone(), usize::MAX, 0)],
            "failed replacement must not publish"
        );
        assert_eq!(
            *wrap.master_line_program.lock().unwrap(),
            installed,
            "failed replacement must not mutate the shadow"
        );
    }

    #[test]
    fn set_bus_line_accepts_a_forward_aux_destination() {
        let (wrap, calls) = wrap_and_install_calls();

        wrap.set_bus_line(
            "seq-bus-0",
            &[output(BusLineDest::Bus("aux-bus-0".into()), false, 0.75)],
        )
        .expect("forward output must not depend on the destination bus kind");

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[(
                vec![LineOp::Output(LineOutput {
                    dest: orbit_audio_native::OutputDest::Bus(2),
                    thru: false,
                    gain: 0.75,
                })],
                0,
                3,
            )]
        );
    }

    #[test]
    fn set_global_gain_only_updates_the_compatibility_atomic() {
        let (wrap, calls) = wrap_and_master_install_calls();
        let original_shadow = wrap.master_line_program.lock().unwrap().clone();

        wrap.set_global_gain(0.1, 0.005)
            .expect("first gain update must succeed");
        wrap.set_global_gain(0.316, 0.005)
            .expect("second gain update must succeed");

        assert_eq!(
            f32::from_bits(wrap.master_gain.load(Ordering::Relaxed)),
            0.316
        );
        assert!(
            calls.lock().unwrap().is_empty(),
            "SetGlobalGain must not republish a fresh master LineProgram"
        );
        assert_eq!(
            *wrap.master_line_program.lock().unwrap(),
            original_shadow,
            "SetGlobalGain must leave the SetBusLine shadow untouched"
        );
    }

    #[test]
    fn set_bus_line_is_all_or_nothing_when_the_second_op_is_invalid() {
        let (wrap, installs) = wrap_and_installs();
        let before = [BusLineOp::Rack, output(BusLineDest::Master, false, 1.0)];
        wrap.set_bus_line("seq-bus-0", &before)
            .expect("initial line must install");
        let snapshot = installs.lock().unwrap().last().cloned().unwrap();
        let shadow_before = wrap.bus_line_shadows.lock().unwrap()["seq-bus-0"].clone();

        let error = wrap
            .set_bus_line(
                "seq-bus-0",
                &[
                    BusLineOp::Gain(0.25),
                    output(BusLineDest::Bus("missing-bus".into()), false, 1.0),
                ],
            )
            .expect_err("invalid second op must reject the complete replacement");
        assert!(matches!(error, WrapError::OutProcEffect(_)));
        let guard = installs.lock().unwrap();
        assert_eq!(guard.len(), 1, "failed replacement must not publish");
        assert_eq!(guard[0], snapshot, "effective line must remain unchanged");
        assert_eq!(
            wrap.bus_line_shadows.lock().unwrap()["seq-bus-0"],
            shadow_before,
            "failed replacement must not mutate the seed shadow"
        );
    }

    #[test]
    fn set_bus_line_seed_for_a_new_output_starts_at_zero() {
        let old_ops = vec![LineOp::Output(LineOutput {
            dest: orbit_audio_native::OutputDest::Master,
            thru: false,
            gain: 0.1,
        })];
        let wrap = super::set_bus_routing_tests::wrap_with_three_stage_topology();
        wrap.bus_line_shadows
            .lock()
            .unwrap()
            .insert("seq-bus-0".to_owned(), old_ops);
        let captured = Arc::new(Mutex::new(Vec::new()));
        let recorded = captured.clone();
        wrap.bus_line_programs.lock().unwrap().insert(
            "seq-bus-0".to_owned(),
            LineProgramInstaller::new(
                move |program, _, _| {
                    *recorded.lock().unwrap() = program
                        .current_gain
                        .iter()
                        .map(|gain| f32::from_bits(gain.load(Ordering::Relaxed)))
                        .collect();
                    Ok(())
                },
                || vec![0.1],
            ),
        );
        wrap.set_bus_line(
            "seq-bus-0",
            &[
                output(BusLineDest::Master, true, 1.0),
                output(BusLineDest::Bus("sum-bus-0".to_owned()), false, 0.5),
            ],
        )
        .expect("matched and new outputs install atomically");
        let seeds = captured.lock().unwrap().clone();
        eprintln!(
            "republish output seeds: matched={} new={}",
            seeds[0], seeds[1]
        );
        assert_eq!(seeds, vec![0.1, 0.0]);
    }

    #[test]
    fn set_bus_line_seeds_match_kind_destination_and_occurrence_ordinal() {
        let output = |dest, gain| {
            LineOp::Output(LineOutput {
                dest,
                thru: true,
                gain,
            })
        };
        let old_ops = vec![
            LineOp::Gain(0.2),
            output(orbit_audio_native::OutputDest::Master, 0.3),
            LineOp::Gain(0.4),
            LineOp::Pan(-0.5),
            output(orbit_audio_native::OutputDest::Master, 0.6),
            output(orbit_audio_native::OutputDest::Bus(1), 0.7),
            LineOp::Pan(0.8),
        ];
        let new_ops = vec![
            LineOp::Pan(0.0),
            LineOp::Gain(1.0),
            output(orbit_audio_native::OutputDest::Master, 1.0),
            LineOp::Pan(1.0),
            LineOp::Gain(2.0),
            output(orbit_audio_native::OutputDest::Master, 1.0),
            output(
                orbit_audio_native::OutputDest::Device {
                    left: 2,
                    right: None,
                },
                1.0,
            ),
            LineOp::Rack,
        ];
        let seeds = line_republish_seeds(
            &new_ops,
            &old_ops,
            &[0.21, 0.31, 0.41, -0.51, 0.61, 0.71, 0.81],
        );
        assert_eq!(seeds, vec![-0.51, 0.21, 0.31, 0.81, 0.41, 0.61, 0.0, 1.0]);
    }

    /// #611 束 A 監査（Fable Important #1）: 上のテストは新プログラムの Gain が
    /// すべて旧プログラム側に対応物を持つケースだけを押さえており、
    /// `line_republish_seeds` の `LineOp::Gain(_) => 1.0`（対応する旧 Gain が無い時の既定値）
    /// 分岐に到達するケースが無かった。旧に Gain を一切含まない republish を単独で固定する。
    #[test]
    fn set_bus_line_seed_for_a_new_gain_without_a_match_defaults_to_unity() {
        let old_ops = vec![LineOp::Rack];
        let new_ops = vec![LineOp::Rack, LineOp::Gain(0.5)];
        let seeds = line_republish_seeds(&new_ops, &old_ops, &[1.0]);
        assert_eq!(
            seeds,
            vec![1.0, 1.0],
            "an unmatched new Gain must seed at the default unity (1.0), \
             not the new target (0.5) nor the Output default (0.0)"
        );
    }

    #[test]
    fn set_bus_line_rejects_non_finite_or_out_of_range_pan_before_publish() {
        let (wrap, installs) = wrap_and_installs();
        for pan in [f32::NAN, -1.01, 1.01] {
            let error = wrap
                .set_bus_line("seq-bus-0", &[BusLineOp::Pan(pan)])
                .expect_err("invalid pan must reject");
            assert_eq!(wrap_err_to_protocol(&error).code, "MALFORMED_REQUEST");
        }
        assert!(installs.lock().unwrap().is_empty());
    }
}

#[cfg(all(test, feature = "outproc-effect"))]
pub(crate) fn test_wrap_with_three_stage_topology() -> Arc<EngineWrap> {
    let wrap = set_bus_routing_tests::wrap_with_three_stage_topology();
    let mut bus_line_programs = wrap
        .bus_line_programs
        .lock()
        .expect("lock generic bus lines for injection");
    for name in ["seq-bus-0", "sum-bus-0", "aux-bus-0"] {
        bus_line_programs.insert(
            name.to_owned(),
            orbit_audio_native::LineProgramInstaller::new(|_, _, _| Ok(()), || vec![1.0, 1.0]),
        );
    }
    drop(bus_line_programs);
    wrap
}

#[cfg(all(test, feature = "outproc-effect", feature = "outproc-instrument"))]
mod set_source_routing_tests {
    use super::{test_instrument_control, EngineWrap, InstrumentSlotEntry, SourceRoutingTarget};
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

        wrap.set_source_routing(SOURCE, 3, SourceRoutingTarget::Bus("seq-bus-0".into()))
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
    fn none_and_master_targets_store_distinct_destinations() {
        let (wrap, source_dests) = wrap_with_source();
        source_dests[2].store(SourceDest::Bus(0));

        wrap.set_source_routing(SOURCE, 2, SourceRoutingTarget::None)
            .expect("none target must be accepted");
        assert_eq!(source_dests[2].load(), SourceDest::None);

        wrap.set_source_routing(SOURCE, 2, SourceRoutingTarget::Master)
            .expect("master target must be accepted");
        assert_eq!(source_dests[2].load(), SourceDest::Master);
    }

    #[test]
    fn unknown_source_is_rejected_as_an_exact_opaque_key() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing("source/key", 0, SourceRoutingTarget::None)
            .expect_err("partial source match must be rejected");

        assert!(format!("{error:?}").contains("unknown source"));
        assert_eq!(source_dests[0].load(), SourceDest::None);
    }

    #[test]
    fn unit_outside_the_preallocated_range_is_rejected() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing(
                SOURCE,
                u32::try_from(MAX_SOURCE_UNITS).expect("unit capacity fits u32"),
                SourceRoutingTarget::Master,
            )
            .expect_err("out-of-range unit must be rejected");

        assert!(format!("{error:?}").contains("unit"));
        assert!(source_dests
            .iter()
            .all(|cell| cell.load() == SourceDest::None));
    }

    #[test]
    fn unknown_target_bus_is_rejected_without_changing_the_destination() {
        let (wrap, source_dests) = wrap_with_source();

        let error = wrap
            .set_source_routing(SOURCE, 0, SourceRoutingTarget::Bus("not-a-bus".into()))
            .expect_err("unknown target bus must be rejected");

        assert!(format!("{error:?}").contains("unknown bus"));
        assert_eq!(source_dests[0].load(), SourceDest::None);
    }

    #[test]
    fn sum_and_aux_targets_are_rejected_because_only_insert_is_valid() {
        let (wrap, source_dests) = wrap_with_source();

        for target in ["sum-bus-0", "aux-bus-0"] {
            let error = wrap
                .set_source_routing(SOURCE, 0, SourceRoutingTarget::Bus(target.into()))
                .expect_err("non-insert target must be rejected");
            assert!(format!("{error:?}").contains("must be an insert bus"));
        }
        assert_eq!(source_dests[0].load(), SourceDest::None);
    }
}
