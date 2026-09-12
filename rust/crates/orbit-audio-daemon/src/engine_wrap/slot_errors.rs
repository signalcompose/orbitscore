//! out-of-process のエラー変換とサマリ整形（#888 子 1・第 8 束）。
//!
//! 🔴 **これは純粋な移動である。** `slot_helpers.rs` から分けた。1 ファイルにまとめると
//! **503 コード行**で #888 の閾値 500 を 3 行超えるため（設計 §13.9 の制約 1）。

// 🔴 feature 次第で中身がすべて cfg で消えるため、この import も未使用になりうる。
#[allow(unused_imports)]
use super::*;

#[cfg(feature = "outproc-effect")]
pub(super) fn effect_chain_apply_mailbox_error(
    error: orbit_audio_sandbox::CommandMailboxError,
) -> WrapError {
    use orbit_audio_sandbox::CommandMailboxError;
    if !effect_chain_registry_is_intact_after_mailbox_error(&error) {
        return WrapError::OutProcEffectUncertain(format!(
            "effect chain apply ended without confirmation that the authoritative config is unchanged: {error}"
        ));
    }
    match error {
        CommandMailboxError::CommandFailed { detail, .. } => {
            let suffix = if detail.contains("the previous chain is kept") {
                ""
            } else {
                "; the previous chain is kept"
            };
            WrapError::OutProcEffect(format!("effect chain apply failed: {detail}{suffix}"))
        }
        _ => unreachable!("registry-intact mailbox failures are definitive child responses"),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn plugin_state_mailbox_error(
    error: orbit_audio_sandbox::CommandMailboxError,
) -> WrapError {
    use orbit_audio_sandbox::{
        CommandMailboxError as E, CMD_RESULT_BAD_ARG, CMD_RESULT_IO_ERROR, CMD_RESULT_PLUGIN_ERROR,
    };
    let detail = error.to_string();
    match error {
        E::Timeout { .. } => WrapError::PluginStateTimeout(detail),
        E::ChildExited { .. } => WrapError::PluginStateChildExited(detail),
        E::CommandFailed {
            result: CMD_RESULT_PLUGIN_ERROR,
            ..
        } => WrapError::PluginStateUnsupported(detail),
        E::CommandFailed {
            result: CMD_RESULT_IO_ERROR,
            ..
        } => WrapError::PluginStateIo(detail),
        E::CommandFailed {
            result: CMD_RESULT_BAD_ARG,
            ..
        }
        | E::InvalidArgument(_)
        | E::Mapping(_)
        | E::SidecarCleanup { .. } => WrapError::PluginStateIo(detail),
        _ => WrapError::PluginStateProtocol(detail),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn plugin_ui_mailbox_error(
    error: orbit_audio_sandbox::CommandMailboxError,
) -> WrapError {
    use orbit_audio_sandbox::CommandMailboxError as E;
    let detail = error.to_string();
    match error {
        E::Mapping(_) | E::SidecarCleanup { .. } => WrapError::PluginUiUnavailable(detail),
        E::CommandFailed { .. } | E::InvalidArgument(_) => WrapError::PluginUiCommand(detail),
        E::ChildExited { .. } => WrapError::PluginUiUnavailable(detail),
        _ => WrapError::PluginUiProtocol(detail),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn plugin_ui_pump_error(error: orbit_audio_sandbox::UiEventPumpError) -> WrapError {
    use orbit_audio_sandbox::UiEventPumpError as E;
    let detail = error.to_string();
    match error {
        E::Mapping(_) | E::Mailbox(_) => WrapError::PluginUiUnavailable(detail),
        E::CoordinatorPoisoned | E::GenerationMismatch { .. } | E::Protocol(_) => {
            WrapError::PluginUiProtocol(detail)
        }
    }
}

/// retryable な attach 失敗（role mismatch / early-exit / timeout）の共通終端処理。
/// supervisor を unlink 抜きで teardown し（unlink 所有権は launch に戻る）、teardown が
/// 書いた QUIT を RUN へ戻して、slot を retry 可能な `Empty(launch)` に復帰させる。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn retryable_attach_failure<R: OutProcRole>(
    supervisor: R::Supervisor,
    region: *mut orbit_audio_sandbox::transport::SharedRegion,
    child_slot: &Mutex<ChildSlot<R>>,
    launch: ChildLaunch<R>,
    message: String,
) -> WrapError {
    tracing::warn!("outproc attach failed (retryable): {message}");
    detach_and_reset_control_run::<R>(supervisor, region);
    let mut slot = lock_child_slot_recovering(child_slot, "retryable attach failure");
    debug_assert_slot_loading(&slot);
    *slot = ChildSlot::Empty(launch);
    WrapError::OutProcAttachFailed(message)
}

/// Supervisor を先に停止・join・reap してから、再利用する shm の control を RUN に戻す。
/// child を先に kill すると watchdog が予期しない exit と誤認して respawn するため、この順序を
/// 崩してはならない。`region` は呼び出し元が保持する mmap の生存中ポインタでなければならない。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn detach_and_reset_control_run<R: OutProcRole>(
    supervisor: R::Supervisor,
    region: *mut orbit_audio_sandbox::transport::SharedRegion,
) {
    R::detach_keep_shm(supervisor);
    // SAFETY: 呼び出し元が、この呼び出しの完了まで region の mmap を保持する。
    unsafe { orbit_audio_sandbox::transport::reset_control_run(region) };
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn outproc_plugin_summary(
    path: &std::path::Path,
    plugin_id: &Option<String>,
) -> LoadedPluginSummary {
    LoadedPluginSummary {
        plugin_id: plugin_id
            .clone()
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        plugin_name: path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned()),
        note_port_index: 0,
    }
}

#[cfg(feature = "outproc-effect")]
pub(super) fn effect_slot_label(bus: &Option<String>) -> String {
    match bus {
        Some(name) => format!("bus '{name}'"),
        None => "master".to_owned(),
    }
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod shm_cleanup_guard_tests {
    use super::ShmCleanupGuard;
    use std::path::PathBuf;

    pub(super) fn unique_path() -> PathBuf {
        std::env::temp_dir().join(format!("orbitscore-shm-cleanup-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    pub(super) fn armed_drop_removes_file_and_disarmed_drop_keeps_it() {
        let armed = unique_path();
        std::fs::write(&armed, b"guard test").expect("create armed guard file");
        drop(ShmCleanupGuard::new(armed.clone()));
        assert!(!armed.exists(), "armed guard must remove shm file");

        let disarmed = unique_path();
        std::fs::write(&disarmed, b"guard test").expect("create disarmed guard file");
        let mut guard = ShmCleanupGuard::new(disarmed.clone());
        guard.disarm();
        drop(guard);
        assert!(
            disarmed.exists(),
            "disarmed guard must leave ChildLaunch-owned file"
        );
        std::fs::remove_file(disarmed).expect("remove retained test file");
    }
}

#[cfg(all(test, feature = "outproc-effect", feature = "outproc-instrument"))]
mod outproc_both_tests {
    use super::EngineWrap;

    #[test]
    pub(super) fn both_buffer_frames_rejects_conflicting_values() {
        assert!(EngineWrap::resolve_outproc_both_buffer_frames(Some(32), Some(64)).is_err());
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(Some(32), None).unwrap(),
            Some(32)
        );
        assert_eq!(
            EngineWrap::resolve_outproc_both_buffer_frames(None, None).unwrap(),
            None
        );
    }
}
