//! watchdog の「起動直後に死に続ける child を tight loop で respawn し続ける」検知ロジック（#573）。
//! effect と instrument で共有する。
//!
//! 判定そのものは [`crate::outproc_child_exe::child_exe_for_attach`] と同じ理由で共有する:
//! 別々に持つと片方だけ閾値やロジックを直し忘れる非対称が生まれる（#548 で実際に踏んだ形のバグ）。

use std::time::Duration;

use orbit_audio_sandbox::{CommandMailboxHost, UiEventPump};

use crate::engine_wrap::{PluginUiEvent, PluginUiTarget};

/// 直前の spawn からの経過時間（`elapsed_since_spawn`）が `threshold` 未満なら「速い失敗」として
/// 連続カウンタを進め、`threshold` 以上生きていれば（単発クラッシュからの正常な復帰とみなし）
/// カウンタをリセットする純関数。
///
/// watchdog 側は `elapsed_since_spawn` を `now - last_spawn_ns` として計算する。`last_respawn_ns`
/// は初期値 0（= supervisor 起動時刻 `base` を指す）なので、まだ一度も respawn していない
/// 初回 child の生存時間もこの式で正しく測れる（`base` は初回 child の spawn とほぼ同時刻に
/// 記録されるため）。
pub(crate) fn advance_fast_respawn_streak(
    consecutive_fast_fails: u32,
    elapsed_since_spawn: Duration,
    threshold: Duration,
) -> u32 {
    if elapsed_since_spawn < threshold {
        consecutive_fast_fails + 1
    } else {
        0
    }
}

/// Reset the UI coordinator after a confirmed child exit and publish the one-shot respawn
/// completion when a visible UI was invalidated. Returns false after logging a reset failure so
/// both watchdog roles use the same stop/continue decision.
pub(crate) fn service_ui_pump_on_respawn(
    role: &'static str,
    pump: &UiEventPump,
    mailbox: &CommandMailboxHost,
    target: &std::sync::Mutex<Option<PluginUiTarget>>,
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
) -> bool {
    let reset = match pump.reset_after_child_exit(mailbox) {
        Ok(reset) => reset,
        Err(error) => {
            tracing::error!(
                role,
                "plugin UI pump/mailbox reset failed; measurement invalid: {error}"
            );
            return false;
        }
    };
    if reset.closed_visible_ui {
        crate::engine_wrap::enqueue_plugin_ui_closed_by_respawn(target, events);
    }
    true
}

/// Service one watchdog tick with the shared non-blocking notification sink policy.
pub(crate) fn poll_ui_pump_once(
    role: &'static str,
    pump: &UiEventPump,
    target: &std::sync::Mutex<Option<PluginUiTarget>>,
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
) {
    if let Err(error) = pump.poll_step(|notification| {
        crate::engine_wrap::enqueue_plugin_ui_notification(target, events, notification)
    }) {
        tracing::error!(role, "plugin UI event pump failed: {error}");
    }
}

/// Drain publish-visible UI events before QUIT using the same sink as normal watchdog ticks.
pub(crate) fn drain_ui_pump(
    role: &'static str,
    pump: &UiEventPump,
    target: &std::sync::Mutex<Option<PluginUiTarget>>,
    events: &tokio::sync::broadcast::Sender<PluginUiEvent>,
) {
    if let Err(error) = pump.final_drain(|notification| {
        crate::engine_wrap::enqueue_plugin_ui_notification(target, events, notification)
    }) {
        tracing::error!(
            role,
            "plugin UI event final drain failed before QUIT: {error}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_death_increments_the_streak() {
        assert_eq!(
            advance_fast_respawn_streak(0, Duration::from_millis(100), Duration::from_secs(2)),
            1
        );
        assert_eq!(
            advance_fast_respawn_streak(4, Duration::from_millis(100), Duration::from_secs(2)),
            5
        );
    }

    #[test]
    fn surviving_past_threshold_resets_the_streak() {
        assert_eq!(
            advance_fast_respawn_streak(4, Duration::from_secs(3), Duration::from_secs(2)),
            0
        );
    }

    #[test]
    fn exactly_at_threshold_counts_as_survived() {
        // `elapsed_since_spawn < threshold` のみを速い失敗とみなす（境界は「生きていた」側）。
        assert_eq!(
            advance_fast_respawn_streak(4, Duration::from_secs(2), Duration::from_secs(2)),
            0
        );
    }
}
