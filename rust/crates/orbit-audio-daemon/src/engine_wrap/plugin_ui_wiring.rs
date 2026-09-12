//! プラグイン UI の配線と通知（#888 子 1・第 10 束）。
//!
//! 🔴 **これは純粋な移動である。** `instrument_slot_types.rs` から分けた。
//! 1 ファイルにまとめると **534 コード行**で #888 の閾値 500 を超えるため（設計 §13.9 の制約 1）。
//!
//! `PluginUiWiring` 等は `outproc_effect.rs` / `outproc_respawn_guard.rs` からも使われるので
//! `pub(crate)` のまま。親から再エクスポートしている。

#[allow(unused_imports)]
use super::*;

/// Watchdog UI components are bundled so supervisor construction remains readable and both roles
/// receive the exact same pump/target/event-channel contract.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
#[derive(Clone)]
pub(crate) struct PluginUiWiring {
    pub(crate) pump: Arc<orbit_audio_sandbox::UiEventPump>,
    pub(crate) target: Arc<Mutex<PluginUiRouteRegistry>>,
    /// Rack-only current stage index -> immutable window token binding. Instrument children keep
    /// this as `None`; their one legacy UI continues to use the `None` pump/route key.
    pub(crate) index_binding: Option<Arc<Mutex<PluginUiIndexBinding>>>,
    pub(crate) events: tokio::sync::broadcast::Sender<PluginUiEvent>,
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type PluginUiRouteRegistry = BTreeMap<orbit_audio_sandbox::UiWindowKey, PluginUiTarget>;

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) type PluginUiIndexBinding = BTreeMap<u32, u64>;

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn remove_plugin_ui_binding(
    index_binding: &Option<Arc<Mutex<PluginUiIndexBinding>>>,
    index: u32,
    window: orbit_audio_sandbox::UiWindowKey,
) {
    let (Some(index_binding), Some(window)) = (index_binding, window) else {
        return;
    };
    let mut binding = match index_binding.lock() {
        Ok(binding) => binding,
        Err(poisoned) => poisoned.into_inner(),
    };
    if binding.get(&index) == Some(&window) {
        binding.remove(&index);
    }
}

/// Fixed watchdog sink. It never waits: target lookup uses `try_lock`, broadcast send is
/// synchronous/non-blocking, and no socket or engine callback is touched while the pump lock is
/// held. Target contention returns false so the ring head is retried; no target means there is no
/// correlated UI request and the event is consumed. A safepoint is accepted only when broadcast
/// delivery succeeds, while a completion is consumed after a loud delivery failure because it
/// reports an already-completed transition and its route has already been taken.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) fn enqueue_plugin_ui_notification(
    target: &Mutex<PluginUiRouteRegistry>,
    index_binding: Option<&Mutex<PluginUiIndexBinding>>,
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
    notification: orbit_audio_sandbox::UiPumpNotification,
) -> bool {
    let window = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint { window, .. }
        | orbit_audio_sandbox::UiPumpNotification::CloseDone { window, .. } => window,
    };
    let mut routes = match target.try_lock() {
        Ok(target) => target,
        Err(std::sync::TryLockError::WouldBlock) => return false,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    // CloseDone must retire the route and its mutable destination binding as one sink decision.
    // Acquire both with try_lock before mutating either so contention retries the same ring head.
    let mut binding = match index_binding {
        Some(binding) => match binding.try_lock() {
            Ok(binding) => Some(binding),
            Err(std::sync::TryLockError::WouldBlock) => return false,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        },
        None => None,
    };
    let target = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint { .. } => routes.get(&window).cloned(),
        orbit_audio_sandbox::UiPumpNotification::CloseDone { .. } => {
            if let Some(binding) = binding.as_mut() {
                binding.retain(|_, bound_window| Some(*bound_window) != window);
            }
            routes.remove(&window)
        }
    };
    drop(binding);
    drop(routes);
    let Some(target) = target else {
        tracing::warn!(
            ?window,
            "plugin UI notification has no correlated window route"
        );
        return true;
    };
    let (event, retry_if_undelivered) = match notification {
        orbit_audio_sandbox::UiPumpNotification::Safepoint {
            generation,
            evt_seq,
            ..
        } => (
            PluginUiEvent::Closed {
                target,
                generation,
                evt_seq,
            },
            true,
        ),
        orbit_audio_sandbox::UiPumpNotification::CloseDone { completion, .. } => {
            let completion = match completion {
                orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted => {
                    PluginUiCompletion::SafepointCompleted
                }
                orbit_audio_sandbox::UiCloseCompletion::TimedOutWithoutSave => {
                    PluginUiCompletion::TimedOutWithoutSave
                }
            };
            (PluginUiEvent::CloseDone { target, completion }, false)
        }
    };
    match events.send(event) {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(
                event = ?error.0,
                retrying = retry_if_undelivered,
                "plugin UI notification could not be delivered: no broadcast receivers"
            );
            !retry_if_undelivered
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) fn enqueue_plugin_ui_closed_by_respawn(
    target: &Mutex<PluginUiRouteRegistry>,
    index_binding: Option<&Mutex<PluginUiIndexBinding>>,
    closed_windows: &[orbit_audio_sandbox::UiWindowKey],
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
) {
    // reset_after_child_exit has already released the pump lock here. Wait for the short-lived
    // route coordinator lock instead of dropping the one-shot respawn event on contention.
    let routes = match target.lock() {
        Ok(mut target) => std::mem::take(&mut *target),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    };
    if let Some(index_binding) = index_binding {
        match index_binding.lock() {
            Ok(mut binding) => binding.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
    }
    let routed_windows = routes.keys().copied().collect::<Vec<_>>();
    if routed_windows != closed_windows {
        tracing::warn!(
            ?closed_windows,
            ?routed_windows,
            "plugin UI pump/routes disagreed while resetting after child exit"
        );
    }
    for (_, target) in routes {
        if let Err(error) = events.send(PluginUiEvent::ClosedByRespawn { target }) {
            tracing::warn!(
                event = ?error.0,
                "plugin UI respawn completion could not be delivered: no broadcast receivers"
            );
        }
    }
}
