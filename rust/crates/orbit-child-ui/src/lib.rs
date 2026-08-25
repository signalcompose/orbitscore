//! AppKit-independent plugin UI lifecycle state machine.
//!
//! Platform and plugin-format operations deliberately live behind [`UiHostActions`].
//! P3b can implement that trait with AppKit/VST3/CLAP calls without putting any of
//! those dependencies into the transition logic tested here.

use std::borrow::Cow;
use std::ffi::c_void;
use std::time::Duration;

/// Logical plugin-editor size in host-view coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiSize {
    pub width: i32,
    pub height: i32,
}

/// AppKit- and plugin-format-independent editor-view endpoint.
///
/// `begin_open` deliberately stops before the parent view is created. The caller uses its
/// returned size to create the host-owned window, then passes that window's content view to
/// `attach`.
pub trait PluginUiEndpoint {
    /// Create the plugin editor and return its initial size.
    fn begin_open(&mut self) -> Result<UiSize, String>;

    /// Embed the editor into `parent`, an opaque platform parent-view pointer.
    fn attach(&mut self, parent: *mut c_void) -> Result<(), String>;

    /// Release the plugin editor before the host destroys its parent window.
    ///
    /// `was_destroyed` carries CLAP's `closed()` distinction. VST3 implementations ignore it.
    fn release(&mut self, was_destroyed: bool);

    /// Whether the plugin permits user-driven window resizing.
    fn can_resize(&self) -> bool;

    /// Apply a host-originated resize to the plugin editor.
    fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String>;
}

/// Detail returned when `OPEN_UI` arrives while the UI is already open. The goal state
/// (open) is already achieved, so idempotent callers may treat this as success — which is
/// why it must stay distinct from [`CLOSING_IN_PROGRESS_DETAIL`], where the UI is NOT open.
pub const ALREADY_OPEN_DETAIL: &str = "already-open";
/// Detail returned when `OPEN_UI` arrives before the previous close cycle drains.
pub const CLOSING_IN_PROGRESS_DETAIL: &str = "closing-in-progress";
/// Detail returned when `CLOSE_UI` arrives outside [`UiState::Open`].
pub const ALREADY_CLOSING_DETAIL: &str = "already-closing";

/// Externally visible UI lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiState {
    Closed,
    Open,
    Closing,
}

/// Why Phase B completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseCompletion {
    /// The host completed the `UI_CLOSED` safepoint and acked that event.
    SafepointCompleted,
    /// The host did not ack the safepoint before the configured close timeout.
    TimedOutWithoutSave,
}

/// Lossless child-to-host events used by the close handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiEvent {
    UiClosed,
    UiClosedDone(CloseCompletion),
}

/// Result returned to the command mailbox handler.
///
/// 🔴 **`transport::CommandOutcome` には統合しない。** あちらは doc どおり
/// 「`detail` = 失敗理由。成功時は空」という意味論で、`CMD_SAVE_STATE` がその契約に乗っている。
/// 一方 spec (UIH.4c) は `Closing` / `Closed` 中の `CLOSE_UI` について
/// **「no-op だが成功 ack を返す（`cmd_result=0` / `detail="already-closing"`）」**、つまり
/// **成功時にも detail を持つこと**を要求する。統合すると既存コマンドの契約の意味論を変えることになる。
///
/// P3b で mailbox へ載せる際の変換は `success` → `CMD_RESULT_OK` / それ以外、の単純マップでよい。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandAck {
    pub success: bool,
    pub detail: Cow<'static, str>,
}

impl CommandAck {
    /// `detail` は `&'static str`（静的メッセージ）でも `String`（プラグイン由来の動的な理由）でも
    /// 受ける。静的側は [`Cow::Borrowed`] のままなのでヒープ確保が起きない。
    fn new(success: bool, detail: impl Into<Cow<'static, str>>) -> Self {
        Self {
            success,
            detail: detail.into(),
        }
    }
}

/// Outcome for child-originated close requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseRequestDisposition {
    Started,
    AlreadyClosing,
}

/// All platform, plugin-format, and event-transport effects used by the state machine.
///
/// `try_publish_event` must be non-blocking and lossless: when it returns `None`,
/// the implementation retains that event and a repeated call with the same value
/// retries the retained publication rather than enqueueing a duplicate. Its returned
/// sequence is the sequence assigned when that exact event reaches the ring.
///
/// `is_event_ring_drained` includes both child-local pending events and shared-memory
/// cursors. For an `orbit_audio_sandbox::transport::EventRingChild` adapter, it maps
/// directly to `EventRingChild::is_drained`.
///
/// # P3b adapter requirements
///
/// - `destroy_window` must use AppKit's `close()`; it must not use `performClose:`,
///   because Phase B calls it before the machine transitions to [`UiState::Closed`].
/// - UI events must be published only through `try_publish_event`. Publishing through
///   another path breaks the retained-event retry contract and can duplicate
///   `UI_CLOSED_DONE`.
/// - Every `now` passed to this machine must come from one monotonic, `Instant`-based
///   clock. Wall-clock values and non-monotonic values must not be used.
/// - Opening a real window makes the main-runloop tick reentrant (modal sheets, live
///   resize, drag tracking). While a tick is reentrant the child's `service_main` is
///   skipped, so `ParentWatch::should_exit` — the orphan guard from #448 — would not be
///   evaluated there. ✅ **Closed in P3b-2**: `child_should_quit` now evaluates both
///   `CONTROL_QUIT` and `ParentWatch` outside the borrow, so a daemon crash during a modal
///   sheet still tears the child down. Its composition (not just the pure predicate) is
///   pinned by `child_should_quit_consults_the_injected_parent_watch`, which uses
///   `ParentWatch::orphaned_for_tests` to make the parent-died branch reachable in-process.
///   Keep that test whenever the predicate gains another term.
pub trait UiHostActions {
    /// Create and show the UI. P3b supplies the format-specific implementation.
    fn open_ui(&mut self) -> Result<(), String>;

    /// Try to publish one lossless event, returning its own ring sequence on success.
    /// This is the only permitted publication path for UI events.
    fn try_publish_event(&mut self, event: UiEvent) -> Option<u64>;

    /// Acquire-read the latest host-completed event sequence.
    fn event_ack_seq(&self) -> u64;

    /// Whether pending count is zero and `evt_ack_seq == evt_seq`.
    fn is_event_ring_drained(&self) -> bool;

    /// Release the plugin-owned UI, respecting CLAP's `was_destroyed` distinction.
    fn release_plugin_ui(&mut self, was_destroyed: bool);

    /// Destroy the child-owned window after plugin release using AppKit's `close()`.
    /// Implementations must not call `performClose:`.
    fn destroy_window(&mut self);
}

#[derive(Debug)]
struct ClosingState {
    started_at: Duration,
    was_destroyed: bool,
    /// The exact seq returned when this cycle's `UI_CLOSED` reached the ring.
    ui_closed_seq: Option<u64>,
}

#[derive(Debug)]
enum MachineState {
    Closed,
    Open,
    Closing(ClosingState),
}

/// `Closed -> Open -> Closing -> Closed` close-handshake state machine.
#[derive(Debug)]
pub struct UiCloseStateMachine {
    state: MachineState,
    close_timeout: Duration,
    pending_ui_closed: bool,
    pending_done: Option<CloseCompletion>,
}

impl UiCloseStateMachine {
    /// Construct an initially closed machine. The empty initial event ring is drained,
    /// so the first `OPEN_UI` is accepted when the injected drain predicate says so.
    pub fn new(close_timeout: Duration) -> Self {
        Self {
            state: MachineState::Closed,
            close_timeout,
            pending_ui_closed: false,
            pending_done: None,
        }
    }

    pub fn state(&self) -> UiState {
        match self.state {
            MachineState::Closed => UiState::Closed,
            MachineState::Open => UiState::Open,
            MachineState::Closing(_) => UiState::Closing,
        }
    }

    /// Handle `OPEN_UI`.
    ///
    /// Acceptance is exactly the drain gate: state is `Closed` and the event backend
    /// reports pending count zero with equal ack/publish cursors.
    pub fn open_command(&mut self, actions: &mut impl UiHostActions) -> CommandAck {
        // Open と「開いていない拒否」（Closing / ring 未 drain）は detail を分ける。
        // 同じ文言に潰すと、TS 側の冪等 open が「開いていないのに成功扱い」へ倒れる
        // （PR #619 R4 で実際に起きた取り違え）。
        if matches!(self.state, MachineState::Open) {
            return CommandAck::new(false, ALREADY_OPEN_DETAIL);
        }
        if !matches!(self.state, MachineState::Closed) || !actions.is_event_ring_drained() {
            return CommandAck::new(false, CLOSING_IN_PROGRESS_DETAIL);
        }

        match actions.open_ui() {
            Ok(()) => {
                self.state = MachineState::Open;
                CommandAck::new(true, "")
            }
            Err(detail) => CommandAck::new(false, detail),
        }
    }

    /// Entry path ①: AppKit's `windowShouldClose`.
    ///
    /// This always returns `false`: AppKit must not destroy the window before Phase B.
    /// `now` must come from the machine's monotonic, `Instant`-based clock.
    pub fn window_should_close(&mut self, now: Duration, actions: &mut impl UiHostActions) -> bool {
        self.begin_close(now, false, actions);
        false
    }

    /// Entry path ②: host-originated `CLOSE_UI`.
    ///
    /// The accepted ack is returned during Phase A, before waiting for the safepoint.
    /// Duplicate commands in `Closing` or `Closed` still receive a successful ack.
    /// `now` must come from the machine's monotonic, `Instant`-based clock.
    pub fn close_command(&mut self, now: Duration, actions: &mut impl UiHostActions) -> CommandAck {
        match self.begin_close(now, false, actions) {
            CloseRequestDisposition::Started => CommandAck::new(true, ""),
            CloseRequestDisposition::AlreadyClosing => {
                CommandAck::new(true, ALREADY_CLOSING_DETAIL)
            }
        }
    }

    /// Entry path ③: CLAP's thread-safe `closed(was_destroyed)` callback after P3b
    /// marshals it to the main thread.
    ///
    /// `now` must come from the machine's monotonic, `Instant`-based clock.
    pub fn clap_closed(
        &mut self,
        was_destroyed: bool,
        now: Duration,
        actions: &mut impl UiHostActions,
    ) -> CloseRequestDisposition {
        self.begin_close(now, was_destroyed, actions)
    }

    /// Advance lossless publication retries and the asynchronous Phase B boundary.
    ///
    /// This method never waits. Call it once per child main-runloop service tick.
    /// `now` must come from the same monotonic, `Instant`-based clock used by the
    /// close-entry methods.
    pub fn tick(&mut self, now: Duration, actions: &mut impl UiHostActions) {
        if matches!(self.state, MachineState::Closed) {
            self.try_publish_close_events(actions);
            return;
        }

        let phase_b = match &mut self.state {
            MachineState::Closing(closing) => {
                if closing.ui_closed_seq.is_none() {
                    closing.ui_closed_seq = actions.try_publish_event(UiEvent::UiClosed);
                }

                let safepoint_completed = closing
                    .ui_closed_seq
                    .is_some_and(|ui_closed_seq| actions.event_ack_seq() >= ui_closed_seq);
                let timed_out = now.saturating_sub(closing.started_at) >= self.close_timeout;

                if safepoint_completed {
                    Some((
                        closing.was_destroyed,
                        CloseCompletion::SafepointCompleted,
                        false,
                    ))
                } else if timed_out {
                    Some((
                        closing.was_destroyed,
                        CloseCompletion::TimedOutWithoutSave,
                        closing.ui_closed_seq.is_none(),
                    ))
                } else {
                    None
                }
            }
            MachineState::Closed | MachineState::Open => None,
        };

        let Some((was_destroyed, completion, pending_ui_closed)) = phase_b else {
            return;
        };

        debug_assert!(
            self.pending_done.is_none(),
            "a prior UI_CLOSED_DONE must not be overwritten at the Phase B boundary"
        );
        // Phase B ordering is normative: plugin release precedes parent-window destroy.
        actions.release_plugin_ui(was_destroyed);
        actions.destroy_window();
        self.state = MachineState::Closed;
        self.pending_ui_closed = pending_ui_closed;
        self.pending_done = Some(completion);
        self.try_publish_close_events(actions);
    }

    fn begin_close(
        &mut self,
        now: Duration,
        was_destroyed: bool,
        actions: &mut impl UiHostActions,
    ) -> CloseRequestDisposition {
        // This state check is the single reentry guard shared by all three paths.
        if !matches!(self.state, MachineState::Open) {
            return CloseRequestDisposition::AlreadyClosing;
        }

        // The seam is non-blocking and does not reenter the machine, so the sequence can
        // be resolved before the transition instead of patching the state afterwards.
        // A `None` here just means the ring was full; `tick` retries it.
        let ui_closed_seq = actions.try_publish_event(UiEvent::UiClosed);
        self.state = MachineState::Closing(ClosingState {
            started_at: now,
            was_destroyed,
            ui_closed_seq,
        });
        CloseRequestDisposition::Started
    }

    fn try_publish_close_events(&mut self, actions: &mut impl UiHostActions) {
        if self.pending_ui_closed {
            if actions.try_publish_event(UiEvent::UiClosed).is_none() {
                return;
            }
            self.pending_ui_closed = false;
        }
        self.try_publish_done(actions);
    }

    fn try_publish_done(&mut self, actions: &mut impl UiHostActions) {
        let Some(completion) = self.pending_done else {
            return;
        };
        if actions
            .try_publish_event(UiEvent::UiClosedDone(completion))
            .is_some()
        {
            self.pending_done = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Call {
        Open,
        Publish(u64, UiEvent),
        Release(bool),
        DestroyWindow,
    }

    struct MockActions {
        next_seq: u64,
        published_seq: u64,
        ack_seq: u64,
        open_error: Option<String>,
        publishing_enabled: bool,
        retained_event: Option<UiEvent>,
        calls: Vec<Call>,
    }

    impl MockActions {
        fn drained() -> Self {
            Self {
                next_seq: 1,
                published_seq: 0,
                ack_seq: 0,
                open_error: None,
                publishing_enabled: true,
                retained_event: None,
                calls: Vec::new(),
            }
        }

        fn published(&self, event: UiEvent) -> usize {
            self.calls
                .iter()
                .filter(|call| matches!(call, Call::Publish(_, candidate) if *candidate == event))
                .count()
        }

        fn releases(&self) -> Vec<bool> {
            self.calls
                .iter()
                .filter_map(|call| match call {
                    Call::Release(was_destroyed) => Some(*was_destroyed),
                    _ => None,
                })
                .collect()
        }
    }

    impl UiHostActions for MockActions {
        fn open_ui(&mut self) -> Result<(), String> {
            self.calls.push(Call::Open);
            match self.open_error.take() {
                Some(detail) => Err(detail),
                None => Ok(()),
            }
        }

        fn try_publish_event(&mut self, event: UiEvent) -> Option<u64> {
            match self.retained_event {
                Some(retained) => assert_eq!(
                    retained, event,
                    "lossless retry must target the retained head event"
                ),
                None => self.retained_event = Some(event),
            }
            if !self.publishing_enabled {
                return None;
            }

            let retained = self.retained_event.take().expect("event retained above");
            let seq = self.next_seq;
            self.next_seq += 1;
            self.published_seq = seq;
            self.calls.push(Call::Publish(seq, retained));
            Some(seq)
        }

        fn event_ack_seq(&self) -> u64 {
            self.ack_seq
        }

        fn is_event_ring_drained(&self) -> bool {
            self.retained_event.is_none() && self.ack_seq == self.published_seq
        }

        fn release_plugin_ui(&mut self, was_destroyed: bool) {
            self.calls.push(Call::Release(was_destroyed));
        }

        fn destroy_window(&mut self) {
            self.calls.push(Call::DestroyWindow);
        }
    }

    #[test]
    fn open_failure_preserves_closed_state_and_propagates_detail() {
        let mut actions = MockActions::drained();
        actions.open_error = Some("plugin editor creation failed".to_owned());
        let mut machine = UiCloseStateMachine::new(Duration::from_secs(10));

        let ack = machine.open_command(&mut actions);

        assert_eq!(machine.state(), UiState::Closed);
        assert!(!ack.success);
        assert_eq!(ack.detail, "plugin editor creation failed");
        assert_eq!(actions.calls, vec![Call::Open]);
    }

    #[test]
    fn close_machine_converges_all_paths_and_completes_only_on_own_seq_or_timeout() {
        #[derive(Clone, Copy)]
        enum Path {
            Window,
            Command,
            ClapDestroyed,
        }

        for path in [Path::Window, Path::Command, Path::ClapDestroyed] {
            let mut actions = MockActions::drained();
            let mut machine = UiCloseStateMachine::new(Duration::from_secs(10));

            assert_eq!(machine.state(), UiState::Closed);
            assert!(machine.open_command(&mut actions).success);
            assert_eq!(machine.state(), UiState::Open);
            let duplicate_open = machine.open_command(&mut actions);
            assert!(!duplicate_open.success);
            assert_eq!(duplicate_open.detail, "already-open");
            assert_eq!(
                actions
                    .calls
                    .iter()
                    .filter(|call| matches!(call, Call::Open))
                    .count(),
                1,
                "OPEN_UI requires state == Closed even when the ring is drained"
            );

            // Construct the UIH.8 hazard independently of the production open gate:
            // seq 41 is a prior DONE, ack is still 40, and this cycle's CLOSED gets 42.
            actions.next_seq = 42;
            actions.published_seq = 41;
            actions.ack_seq = 40;
            match path {
                Path::Window => {
                    assert!(!machine.window_should_close(Duration::from_secs(1), &mut actions))
                }
                Path::Command => {
                    let ack = machine.close_command(Duration::from_secs(1), &mut actions);
                    assert!(ack.success, "CLOSE_UI must ack in Phase A");
                    assert_eq!(ack.detail, "");
                }
                Path::ClapDestroyed => assert_eq!(
                    machine.clap_closed(true, Duration::from_secs(1), &mut actions),
                    CloseRequestDisposition::Started
                ),
            }
            assert_eq!(machine.state(), UiState::Closing);
            assert_eq!(actions.published(UiEvent::UiClosed), 1);

            // All three duplicate entry paths converge on the same reentry guard.
            assert!(!machine.window_should_close(Duration::from_secs(2), &mut actions));
            assert_eq!(
                machine.clap_closed(true, Duration::from_secs(2), &mut actions),
                CloseRequestDisposition::AlreadyClosing
            );
            let duplicate_close = machine.close_command(Duration::from_secs(2), &mut actions);
            assert!(duplicate_close.success);
            assert_eq!(duplicate_close.detail, "already-closing");
            assert_eq!(
                actions.published(UiEvent::UiClosed),
                1,
                "duplicates must not fire a second safepoint"
            );

            // Ack 41 is forward progress, but not this cycle's UI_CLOSED seq 42.
            actions.ack_seq = 41;
            machine.tick(Duration::from_secs(3), &mut actions);
            assert_eq!(machine.state(), UiState::Closing);
            assert!(
                actions.releases().is_empty(),
                "prior DONE progress must not trigger Phase B"
            );

            actions.ack_seq = 42;
            machine.tick(Duration::from_secs(4), &mut actions);
            assert_eq!(machine.state(), UiState::Closed);
            assert_eq!(
                actions.releases(),
                vec![matches!(path, Path::ClapDestroyed)]
            );
            assert_eq!(
                actions.published(UiEvent::UiClosedDone(CloseCompletion::SafepointCompleted)),
                1
            );
            let release_index = actions
                .calls
                .iter()
                .position(|call| matches!(call, Call::Release(_)))
                .expect("release call");
            let destroy_index = actions
                .calls
                .iter()
                .position(|call| matches!(call, Call::DestroyWindow))
                .expect("window destroy call");
            assert!(
                release_index < destroy_index,
                "plugin UI must be released before its parent window"
            );

            // Closed alone is insufficient while this cycle's DONE remains unacked.
            let reopen_while_done_unacked = machine.open_command(&mut actions);
            assert!(!reopen_while_done_unacked.success);
            assert_eq!(reopen_while_done_unacked.detail, "closing-in-progress");
            actions.ack_seq = 43;
            assert!(machine.open_command(&mut actions).success);
        }

        // Host-stall escape: timeout tears down without an ack and retains DONE until
        // publication succeeds, without duplicating the event on repeated ticks.
        let mut actions = MockActions::drained();
        let mut machine = UiCloseStateMachine::new(Duration::from_secs(10));
        assert!(machine.open_command(&mut actions).success);
        actions.publishing_enabled = false;
        assert!(!machine.window_should_close(Duration::ZERO, &mut actions));
        assert_eq!(actions.published(UiEvent::UiClosed), 0);
        machine.tick(Duration::from_secs(9), &mut actions);
        assert_eq!(machine.state(), UiState::Closing);
        machine.tick(Duration::from_secs(10), &mut actions);
        assert_eq!(machine.state(), UiState::Closed);
        assert_eq!(actions.releases(), vec![false]);
        assert_eq!(
            actions.published(UiEvent::UiClosedDone(CloseCompletion::TimedOutWithoutSave)),
            0
        );
        machine.tick(Duration::from_secs(11), &mut actions);
        actions.publishing_enabled = true;
        machine.tick(Duration::from_secs(12), &mut actions);
        assert_eq!(
            actions.published(UiEvent::UiClosed),
            1,
            "a timed-out UI_CLOSED must remain ahead of UI_CLOSED_DONE"
        );
        assert_eq!(
            actions.published(UiEvent::UiClosedDone(CloseCompletion::TimedOutWithoutSave)),
            1,
            "UI_CLOSED_DONE must retry until it reaches the ring"
        );
    }
}
