//! `EngineWrap` の out-of-process エフェクトの **load 経路**（#888 子 1・第 4 束）。
//!
//! replace / unload は同じ束の中で 500 行に収めるため `outproc_effect_replace.rs` にある。
//!
//! 🔴 **1 行を除いて純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! そのまま移した。唯一の変更は `apply_outproc_effect_chain_with_timeout` の可視性で、
//! `fn` → `pub(super) fn` にした（下記）。
//!
//! 🔴 **なぜ 1 行だけ可視性を変えたか**（設計 §5 の **E3′**）: 親は子の private メソッドを
//! 呼べない。このメソッドは `engine_wrap.rs` に残るインラインテスト `effect_rack_tests` から
//! 呼ばれているので、private のままでは E0624 になる。
//! `teardown_outproc_effect_slot` と `load_outproc_effect_chain_impl` は呼び出し元が
//! すべてこのモジュール内なので private のまま。**変更は必要最小の 1 行に留めた。**
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドには到達できる。

use super::*;

impl EngineWrap {
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
    pub(super) fn apply_outproc_effect_chain_with_timeout(
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
}
