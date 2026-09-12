//! `EngineWrap` の out-of-process エフェクトの replace / unload / teardown（#888 子 1・第 4 束）。
//!
//! 🔴 **本文は 1 行も書き換えていない。** `engine_wrap.rs` の `impl EngineWrap` からそのまま移した。
//! 変えたのは `teardown_outproc_effect_slot` の可視性だけで、兄弟から呼ばれるため
//! `pub(super)` にした（設計 §14）。
//!
//! `load` 系と分けたのは、1 ファイルにまとめると 724 コード行になり、
//! #888 の閾値 500 を超えるため（設計 §13.9 の制約 1: 分割で生まれる新ファイルも
//! **同じ PR 内で** 500 行以下でなければならない）。`teardown_outproc_effect_slot` は
//! `replace` と `unload` の両方が使うのでこちら側に置いた。
//!
//! 🔴 **可視性を変えた行が 1 つある**: `teardown_outproc_effect_slot` を `pub(super)` にした。
//! **兄弟モジュール同士も private は見えない**ので、`outproc_effect_slots.rs`（load 側）から
//! 呼ぶには親から見える必要がある（設計 §5 の **E3′** と同根）。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる。

use super::*;

impl EngineWrap {
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
    pub(super) fn teardown_outproc_effect_slot(
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
}
