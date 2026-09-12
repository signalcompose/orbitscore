//! `EngineWrap` の out-of-process エフェクト chain の適用本体（#888 子 1・第 4 束）。
//!
//! 🔴 **本文は 1 行も書き換えていない。** 変えたのは可視性だけ（設計 §14）。
//! `outproc_effect_slots.rs` から `load_outproc_effect_chain_impl`
//! だけを切り出した。**1 ファイルにまとめると 510 コード行**になり #888 の閾値 500 を
//! 10 行超えるため（設計 §13.9 の制約 1）。
//!
//! 呼び出し元は `outproc_effect_slots.rs` の 1 箇所だけなので `pub(super)` にしてある
//! （兄弟モジュール同士は private が見えない・設計 §5 の **E3′**）。

use super::*;

impl EngineWrap {
    #[cfg(feature = "outproc-effect")]
    pub(super) fn load_outproc_effect_chain_impl(
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
}
