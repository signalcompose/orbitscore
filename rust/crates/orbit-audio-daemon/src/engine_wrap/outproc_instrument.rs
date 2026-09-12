//! `EngineWrap` の out-of-process インストゥルメントとプラグイン UI（#888 子 1・第 5 束）。
//!
//! 🔴 **1 行を除いて純粋な移動である。** `engine_wrap.rs` の `impl EngineWrap` から
//! そのまま移した。唯一の変更は `teardown_outproc_instrument_resources` の可視性で、
//! `fn` → `pub(super) fn` にした。`engine_wrap.rs` に残るインラインテスト 2 箇所から
//! 呼ばれており、**親は子の private メソッドを呼べない**ため（設計 §5 の **E3′**）。
//!
//! 🔴 **可視性を変えた行が 2 つある**: `teardown_outproc_instrument_resources`（親の
//! インラインテストから）と `resolve_outproc_slot`（兄弟 `plugin_ui.rs` から）を `pub(super)` に。
//! **親は子の private を呼べず、兄弟同士も private は見えない**（設計 §5 の **E3′**）。
//!
//! 親の子モジュールなので `EngineWrap` の private フィールドに到達できる。

use super::*;

impl EngineWrap {
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

        // 台帳 lock と control lock は入れ子にしない。再ポイント前の旧 tenant 集合だけを
        // 写し取り、teardown 中に新 tenant が追加した同名 entry を掃除へ巻き込まない。
        let old_active_notes = {
            let active = self.lock_active_notes()?;
            active
                .iter()
                .filter(|(instance, _, _)| instance == &name)
                .cloned()
                .collect::<HashSet<_>>()
        };

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
                     units beyond the shorter array are not migrated and stay at None \
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
                old_dest.store(orbit_audio_native::SourceDest::None);
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
        // teardown 成功時だけ、再ポイント前に写し取った旧 tenant の entry を捨てる。
        // teardown 中に新 tenant が追加した entry は集合に無いため残る。失敗時は旧 child がまだ
        // 鳴っている可能性があるため、最後の砦 PluginAllNotesOff が拾えるよう全 entry を保持する。
        let note_cleanup_error = if teardown.is_ok() {
            match self.lock_active_notes() {
                Ok(mut active) => {
                    active.retain(|note| !old_active_notes.contains(note));
                    None
                }
                Err(error) => Some(error),
            }
        } else {
            None
        };
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
        if let Some(error) = note_cleanup_error {
            return Err(error);
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
    pub(super) fn teardown_outproc_instrument_resources(
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
                dest.store(orbit_audio_native::SourceDest::None);
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
    pub(super) fn resolve_outproc_slot(
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
}
