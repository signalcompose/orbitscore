//! `EngineWrap` の起動 variant — instrument / both 系（#888 子 1・第 7 束）。
//!
//! 🔴 **本文は 1 行も書き換えていない。** `startup.rs` から分けた。1 ファイルにまとめると
//! **565 コード行**で #888 の閾値 500 を超えるため（設計 §13.9 の制約 1）。
//!
//! 変えたのは可視性だけで、`resolve_outproc_both_buffer_frames`（`engine_wrap.rs` に残る
//! インラインテストから）と `start_outproc_both_with_options`（親に残る
//! `start_with_options` から）を `pub(super)` にした（設計 §5 の **E3′** / §14）。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる。

use super::*;

impl EngineWrap {
    /// feature `outproc-instrument` production entry point. Configuration is fixed at daemon
    /// startup; live note events continue to use the existing PluginNoteOn/PluginNoteOff methods.
    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_instrument::OutProcInstrumentConfig::from_env()
            .map_err(WrapError::OutProcInstrumentUnavailable)?;
        Self::start_outproc_instrument_post_boot_with_options(cfg, options)
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
        Self::start_outproc_instrument_post_boot_with_options(cfg, StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "outproc-instrument",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-effect")
    ))]
    fn start_outproc_instrument_post_boot_with_options(
        cfg: crate::outproc_instrument::OutProcInstrumentConfig,
        options: StartupOptions,
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
                options.output_request(),
            )
            .map_err(WrapError::Output)?;
        let sample_rate = stream.sample_rate;

        // #540 P1: pending slot を ChildLaunch へ組み上げる（sample_rate は stream 起動後に確定）。
        let (instrument_slot_entries, instrument_child_guards, instrument_teardowns) =
            install_instrument_slots(pending_instrument_slots, &cfg.child_exe, sample_rate);

        let wrap = Self::finish_start(
            engine,
            &stream,
            stream_stats,
            buffer_frames,
            Some(cb_stats.clone()),
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
        Ok((wrap, guard))
    }

    /// both build の buffer size を解決する。両方指定され値が異なる場合は、RT 設定の暗黙優先を
    /// 作らず hard error にする。片方だけならその値、両方未指定なら `None` を使う。
    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) fn resolve_outproc_both_buffer_frames(
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
        Self::start_outproc_both_with_options(
            effect_cfg,
            instrument_cfg,
            StartupOptions::from_env(),
        )
    }

    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) fn start_outproc_both_with_options(
        effect_cfg: crate::outproc_effect::OutProcEffectConfig,
        instrument_cfg: crate::outproc_instrument::OutProcInstrumentConfig,
        options: StartupOptions,
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
        let (insert_buses, bus_builds, bus_lines, bus_line_programs) = build_effect_bus_stages()?;

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
                options.output_request(),
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
        let wrap = Self::finish_start(
            engine,
            &stream,
            stream_stats,
            buffer_frames,
            Some(effect_cb_stats.clone()),
        );
        *wrap
            .bus_lines
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line mutex poisoned".into()))? = bus_lines;
        let bus_line_shadows = initial_bus_line_shadows(&bus_line_programs);
        *wrap
            .bus_line_programs
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line mutex poisoned".into()))? =
            bus_line_programs;
        *wrap
            .bus_line_shadows
            .lock()
            .map_err(|_| WrapError::OutProcEffect("bus line shadow mutex poisoned".into()))? =
            bus_line_shadows;
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
        Ok((wrap, guard))
    }
}
