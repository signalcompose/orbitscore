//! `EngineWrap` の起動 variant（#888 子 1・第 7 束）。
//!
//! 🔴 **2 行を除いて純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! cfg feature ごとの `start*()` variant をそのまま移した。唯一の変更は
//! `resolve_outproc_both_buffer_frames` の可視性（`pub(super)`）で、
//! `engine_wrap.rs` に残るインラインテスト 3 箇所から呼ばれているため（設計 §5 の **E3′**）。
//! もう 1 つは `start_outproc_both_with_options`（親に残る `start_with_options` から呼ばれる）。
//!
//! **なぜ variant が多いのか**: `start` / `start_with_options` は `clap-host` /
//! `outproc-effect` / `outproc-instrument` の組み合わせごとに別実装を持つ。
//! これは移動の対象であって、統合の対象ではない（4.0.1 は**振る舞い不変**）。
//!
//! 🔴 **抽出範囲の取り方**: 開始は `#[cfg(all(` の**複数行属性の先頭**（5006 の doc コメント）、
//! 終端は次の item の属性が始まる**直前**。第 7 束はここを 2 度取り違えた
//! （`expected item after attributes` で落ちて気づいた）。

use super::*;

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
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        not(feature = "link-audio"),
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats) = orbit_audio_native::start_default_output_with_device(
            capture_path_from_env(),
            options.output_request(),
        )?;
        let wrap = Self::finish_start(engine, &stream, stream_stats, None, None);
        let guard = StreamGuard { stream };
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
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "link-audio",
        not(feature = "clap-host"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream, stream_stats, reg_tx) =
            orbit_audio_native::start_default_output_with_link_egress(
                crate::link_audio::REG_RING_CAPACITY,
                capture_path_from_env(),
                options.output_request(),
            )?;
        let (control, link_guard) = crate::link_audio::LinkAudioControl::spawn(
            reg_tx,
            stream.sample_rate,
            // 🔴 デバイス幅ではなく **engine 幅**。RT は `ch.scratch[..frames * 2]` を commit する
            // ので、consumer 側がデバイス幅で drain すると 8ch デバイスで崩れる（Fable 監査 I-2）。
            orbit_audio_native::ENGINE_CHANNELS,
        )
        .map_err(|e| WrapError::LinkAudio(e.to_string()))?;
        let wrap = Self::finish_start(engine, &stream, stream_stats, None, None);
        *wrap
            .link
            .lock()
            .map_err(|_| WrapError::LinkAudio("link mutex poisoned".into()))? = Some(control);
        let guard = StreamGuard {
            stream,
            _link: Some(link_guard),
        };
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
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "clap-host",
        not(feature = "link-audio"),
        not(feature = "outproc-effect"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        // event ring 1024 / install ring 1（spike と同容量）。
        let (processor, parts) = orbit_clap_host::new_clap_host(1024, 1);
        let (engine, stream, stream_stats, cb_stats) =
            orbit_audio_native::start_default_output_with_clap(
                processor,
                None,
                capture_path_from_env(),
                options.output_request(),
            )
            .map_err(WrapError::Output)?;
        // 専用スレッドを起動（!Send instance + pump をここで所有）。install ring producer を渡す。
        let (cmd_tx, thread_guard) = crate::clap_host::spawn_clap_thread(
            parts.callback_requested,
            parts.resize_count,
            parts.install_tx,
        );
        let wrap = Self::finish_start(engine, &stream, stream_stats, None, Some(cb_stats.clone()));
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
        Self::start_with_options(StartupOptions::from_env())
    }

    #[cfg(all(
        feature = "outproc-effect",
        not(feature = "clap-host"),
        not(feature = "link-audio"),
        not(feature = "outproc-instrument")
    ))]
    pub fn start_with_options(
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let cfg = crate::outproc_effect::OutProcEffectConfig::from_env()
            .map_err(WrapError::OutProcEffectUnavailable)?;
        Self::start_outproc_effect_post_boot_with_options(cfg, options)
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
        Self::start_outproc_effect_post_boot_with_options(cfg, StartupOptions::from_env())
    }

    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    fn start_outproc_effect_post_boot_with_options(
        cfg: crate::outproc_effect::OutProcEffectConfig,
        options: StartupOptions,
    ) -> Result<(Arc<Self>, StreamGuard), WrapError> {
        use crate::outproc_effect::{
            OutProcEffectPostProcessor, OutProcEffectPostProcessorParts, OutProcEffectStats,
        };
        use std::sync::atomic::AtomicBool;

        // Each registered bus owns a complete transport up front.  Attachment is the existing
        // lock-free `engaged` release-store（activation は LoadPlugin 時・`EffectBusBuild` doc 参照）。
        let (insert_buses, bus_builds, bus_lines, bus_line_programs) = build_effect_bus_stages()?;

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
                options.output_request(),
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
        let wrap = Self::finish_start(
            engine,
            &stream,
            stream_stats,
            cfg.buffer_frames,
            Some(cb_stats.clone()),
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
        Ok((wrap, guard))
    }
}
