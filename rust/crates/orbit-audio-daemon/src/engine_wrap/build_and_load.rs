//! `EngineWrap` の構築と OOP プラグインの load 本体（#888 子 1・第 12 束＝最終）。
//!
//! 🔴 **1 行を除いて純粋な移動である。** 唯一の変更は `build` の可視性で、
//! `engine_wrap.rs` に残る `start_with` と `test_wrap_with_three_stage_topology` から
//! 呼ばれるため `pub(super)` にした（設計 §5 の **E3′**）。

#[allow(unused_imports)]
use super::*;

impl EngineWrap {
    /// `start` / `start_with` 共通の Arc<Self> 構築部。新しいフィールドが
    /// 追加された際、両経路で初期化漏れが起きないよう一箇所に集約する。
    pub(super) fn build(
        engine: Engine,
        device_name: String,
        sample_rate: u32,
        channels: u16,
        stream_stats: Arc<StreamStats>,
        master_gain: Arc<AtomicU32>,
        #[cfg(feature = "outproc-effect")] master_line: LineProgramInstaller,
    ) -> Arc<Self> {
        #[cfg(test)]
        crate::test_tracing::install_interest_anchor();
        let (plugin_ui_events, _) = tokio::sync::broadcast::channel(128);
        Arc::new(Self {
            engine,
            sample_rate,
            channels,
            stream_config: Mutex::new(StreamConfigSnapshot {
                device_name,
                sample_rate,
                channels,
                device_requested: None,
                device_fell_back: false,
                fallback_reason: None,
                first_callback_ms: 0,
                last_switch_failure: None,
                output_fault: OutputFault::None,
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
            connected_sessions: AtomicUsize::new(0),
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
            #[cfg(feature = "outproc-effect")]
            bus_lines: Mutex::new(HashMap::new()),
            #[cfg(feature = "outproc-effect")]
            bus_line_programs: Mutex::new(HashMap::new()),
            #[cfg(feature = "outproc-effect")]
            bus_line_shadows: Mutex::new(HashMap::new()),
            #[cfg(feature = "outproc-effect")]
            master_line,
            #[cfg(feature = "outproc-effect")]
            master_line_program: Mutex::new(default_master_line_program(channels)),
            // outproc-instrument: production start injects the NeutralEvent ring producer.
            #[cfg(feature = "outproc-instrument")]
            outproc_instrument: Mutex::new(None),
            master_gain,
        })
    }

    /// 確立済み session を登録する。session 切断 trigger は台帳が daemon 全体で共有されるため、
    /// 対応する [`Self::session_disconnected_is_last`] と組にして最後の接続だけで発火させる。
    pub(crate) fn session_connected(&self) {
        self.connected_sessions.fetch_add(1, Ordering::Relaxed);
    }

    /// session 登録を解除し、daemon の最後の確立済み session だったかを返す。
    pub(crate) fn session_disconnected_is_last(&self) -> bool {
        let previous = self.connected_sessions.fetch_sub(1, Ordering::Relaxed);
        if previous == 0 {
            self.connected_sessions.store(0, Ordering::Relaxed);
            tracing::error!("session counter underflow while disconnecting");
            return false;
        }
        previous == 1
    }

    pub fn subscribe_plugin_ui_events(&self) -> tokio::sync::broadcast::Receiver<PluginUiEvent> {
        self.plugin_ui_events.subscribe()
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) fn load_outproc_plugin_impl<R: OutProcRole>(
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
}
