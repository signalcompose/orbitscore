//! out-of-process スロットのヘルパー群（#888 子 1・第 8 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の **`impl EngineWrap` の外**にある
//! 自由関数・小さな型をそのまま移した。**本文は 1 行も書き換えていない。**
//! 変えたのは可視性だけで、兄弟モジュールから呼ばれる項目に `pub(super)` を付けた
//! （設計 §5 の **E3′** / §14）。
//!
//! これまでの束が `impl` のメソッドを動かしてきたのに対し、本束は**モジュールレベルの item**
//! が対象。`engine_wrap.rs` に残る側から呼ばれるものは `pub(super)` にする必要がある
//! （設計 §5 の **E3′** と同根）。

// 🔴 `clap-host` 単独ビルドではこのモジュールの item がすべて cfg で消えるため、
// この import も未使用になる（`-D warnings` の CI で落ちる）。中身が feature 次第で
// 空になるモジュールの定型。
#[allow(unused_imports)]
use super::*;

/// `load_outproc_plugin` の終端遷移直前の不変条件検査（release では noop）。
/// Loading 以外を観測したら、この関数以外に slot への書き手が現れたことを意味する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn debug_assert_slot_loading<R: OutProcRole>(slot: &ChildSlot<R>) {
    debug_assert!(
        matches!(slot, ChildSlot::Loading { .. }),
        "load_outproc_plugin: slot must still be Loading (only this function \
         transitions Loading -> Active/Closed/Empty)"
    );
}

/// child slot の poison は attach state machine の停止理由にせず、唯一の書き手である本関数が
/// 回復して本来の遷移を完遂する。放置すると Loading/Closed/Empty の中間状態が恒久化する。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn lock_child_slot_recovering<'a, R: OutProcRole>(
    child_slot: &'a Mutex<ChildSlot<R>>,
    site: &'static str,
) -> MutexGuard<'a, ChildSlot<R>> {
    child_slot.lock().unwrap_or_else(|poisoned| {
        tracing::error!("child slot mutex poisoned during {site}; recovering");
        poisoned.into_inner()
    })
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) type PluginStateHandles = (
    Arc<orbit_audio_sandbox::CommandMailboxHost>,
    Arc<Mutex<Option<PathBuf>>>,
);

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
#[derive(Clone, Copy)]
pub(super) enum OutProcSlotErrorKind {
    State,
    Ui,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
impl OutProcSlotErrorKind {
    pub(super) fn target(self, message: String) -> WrapError {
        match self {
            Self::State => WrapError::PluginStateTarget(message),
            Self::Ui => WrapError::PluginUiTarget(message),
        }
    }

    pub(super) fn unavailable(self, message: String) -> WrapError {
        match self {
            Self::State => WrapError::PluginStateTarget(message),
            Self::Ui => WrapError::PluginUiUnavailable(message),
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) enum ResolvedOutProcSlot {
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
    pub(super) fn state_handles(
        &self,
        chain_index: usize,
    ) -> Result<ResolvedPluginStateHandles, WrapError> {
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

    pub(super) fn ui_handles(
        &self,
        chain_index: usize,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
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

    pub(super) fn ui_handles_without_stage_validation(
        &self,
    ) -> Result<(PluginUiHandles, bool), WrapError> {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { slot, .. } => Ok((active_plugin_ui_handles(slot, "effect")?, true)),
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument(slot) => Ok((active_plugin_ui_handles(slot, "instrument")?, false)),
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) enum ResolvedPluginStateHandles {
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
    pub(super) fn mailbox(&self) -> &orbit_audio_sandbox::CommandMailboxHost {
        match self {
            #[cfg(feature = "outproc-effect")]
            Self::Effect { mailbox, .. } => mailbox,
            #[cfg(feature = "outproc-instrument")]
            Self::Instrument { mailbox, .. } => mailbox,
        }
    }

    pub(super) fn issue_save(
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

    pub(super) fn record_latest_state(&self, path: PathBuf) -> Result<(), WrapError> {
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
pub(super) fn validate_effect_chain_target(
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
pub(super) type PluginUiHandles = (
    Arc<orbit_audio_sandbox::CommandMailboxHost>,
    Arc<orbit_audio_sandbox::UiEventPump>,
    Arc<Mutex<PluginUiRouteRegistry>>,
    Option<Arc<Mutex<PluginUiIndexBinding>>>,
);

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn active_plugin_state_handles<R: OutProcRole>(
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
pub(super) fn active_plugin_ui_handles<R: OutProcRole>(
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
pub(super) fn effect_chain_registry_is_intact(
    slot: &ChildSlot<EffectRole>,
    stats: &crate::outproc_effect::OutProcEffectStats,
) -> bool {
    matches!(slot, ChildSlot::Active { .. })
        && stats.current_child_pid.load(Ordering::Acquire) != 0
        && !stats.measurement_invalid.load(Ordering::Acquire)
}

#[cfg(feature = "outproc-effect")]
pub(super) fn plugin_ui_keep_remap(
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
pub(super) fn remap_plugin_ui_index_binding(
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
pub(super) fn dropped_stage_summaries(
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
pub(super) fn dropped_stage_summaries_from_latest_state(
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
pub(super) fn effect_chain_registry_is_intact_after_mailbox_error(
    error: &orbit_audio_sandbox::CommandMailboxError,
) -> bool {
    matches!(
        error,
        orbit_audio_sandbox::CommandMailboxError::CommandFailed { .. }
    )
}
