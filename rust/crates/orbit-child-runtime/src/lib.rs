//! Shared execution model for the four out-of-process plugin children.
//!
//! On macOS the process main thread is given to an `NSApplication` runloop
//! (Accessory activation policy). A short main-runloop timer services the
//! command mailbox and process-liveness checks supplied by the child. Audio
//! processing runs on one dedicated user-interactive QoS thread.

use std::any::Any;
#[cfg(any(target_os = "macos", test))]
use std::cell::{BorrowMutError, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use thiserror::Error;

pub const HOST_BUNDLE_ID_ARG: &str = "--host-bundle-id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginWindowLevel {
    Normal,
    Floating,
}

/// Decide the plugin-window level without depending on AppKit notification plumbing.
///
/// A missing host bundle ID is the legacy configuration and always stays normal,
/// including when the child itself happens to be frontmost.
/// `frontmost_is_child_process` covers standalone child executables, for which
/// `NSRunningApplication::bundleIdentifier` is nil because there is no `Info.plist`.
pub fn desired_plugin_window_level(
    host_bundle_id: Option<&str>,
    child_bundle_id: Option<&str>,
    frontmost_bundle_id: Option<&str>,
    frontmost_is_child_process: bool,
) -> PluginWindowLevel {
    let Some(host_bundle_id) = host_bundle_id else {
        return PluginWindowLevel::Normal;
    };
    let host_is_frontmost = frontmost_bundle_id == Some(host_bundle_id);
    let child_is_frontmost = frontmost_is_child_process
        || child_bundle_id
            .is_some_and(|child_bundle_id| frontmost_bundle_id == Some(child_bundle_id));
    if host_is_frontmost || child_is_frontmost {
        PluginWindowLevel::Floating
    } else {
        PluginWindowLevel::Normal
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HostBundleIdArgumentError {
    #[error("--host-bundle-id requires a value")]
    MissingValue,
    #[error("--host-bundle-id must not be empty")]
    EmptyValue,
    #[error("--host-bundle-id must be specified at most once")]
    Duplicate,
}

/// Parse the one fixed host identifier supplied when this child was spawned.
pub fn parse_host_bundle_id_argument<I, S>(
    arguments: I,
) -> Result<Option<String>, HostBundleIdArgumentError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut arguments = arguments.into_iter();
    let mut host_bundle_id = None;
    while let Some(argument) = arguments.next() {
        if argument.as_ref() != HOST_BUNDLE_ID_ARG {
            continue;
        }
        if host_bundle_id.is_some() {
            return Err(HostBundleIdArgumentError::Duplicate);
        }
        let value = arguments
            .next()
            .ok_or(HostBundleIdArgumentError::MissingValue)?;
        if value.as_ref().trim().is_empty() {
            return Err(HostBundleIdArgumentError::EmptyValue);
        }
        host_bundle_id = Some(value.as_ref().to_owned());
    }
    Ok(host_bundle_id)
}

/// child / host が出す **正常系の通知**の level トークン規約（#618 / #625）。
pub mod notice;

// The UI service exists to drive an AppKit window; it has no meaning without one.
#[cfg(any(target_os = "macos", test))]
mod ui_service;
#[cfg(target_os = "macos")]
pub mod window;

#[cfg(any(target_os = "macos", test))]
pub use ui_service::{PluginMainHandle, UiCallbacks, UiEventHub, UiService, UI_CLOSE_TIMEOUT};

/// Why the child is shutting down. Distinguishing the two is the whole point of returning
/// an enum instead of `bool`: they look identical from the outside (the process exits) but
/// mean opposite things when the daemon is being debugged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitReason {
    /// The host wrote `CONTROL_QUIT` — an orderly shutdown.
    HostRequested,
    /// `getppid()` changed: the daemon died without writing `CONTROL_QUIT` (#448).
    ParentDied,
}

fn quit_reason(
    control_quit: bool,
    parent_should_exit: impl FnOnce() -> bool,
) -> Option<QuitReason> {
    if control_quit {
        return Some(QuitReason::HostRequested);
    }
    parent_should_exit().then_some(QuitReason::ParentDied)
}

/// Shared `run_child` predicate used by all plugin child binaries.
///
/// 🔴 Announces orphan detection on stderr. Children have no `tracing` subscriber, so stderr
/// (inherited by the daemon) is their **only** observation channel — and once the process is
/// gone, "the host asked us to quit" and "the daemon crashed and we noticed we were orphaned"
/// are indistinguishable without this line. Each child used to print it; folding the predicate
/// into one place dropped it (caught in review of #474 P3b), so it now lives with the check.
///
/// # Safety
/// `region` must point to a live mapped [`orbit_audio_sandbox::SharedRegion`].
pub unsafe fn child_should_quit(
    region: *const orbit_audio_sandbox::SharedRegion,
    parent_watch: &orbit_audio_sandbox::ParentWatch,
) -> bool {
    let reason = quit_reason(
        (unsafe { (*region).control.load(Ordering::Relaxed) }) == orbit_audio_sandbox::CONTROL_QUIT,
        || parent_watch.should_exit(),
    );
    if reason == Some(QuitReason::ParentDied) {
        eprintln!("[orbit-child-runtime] 親プロセス死亡を検知、終了する");
    }
    reason.is_some()
}

/// Shared `run_child` main-service body used by all plugin child binaries.
///
/// Services one mailbox command and advances the UI close state machine. Returns `false`
/// because the mailbox never asks the child to stop — teardown arrives through
/// [`child_should_quit`] instead.
///
/// Both the command vocabulary and the tick contract live here rather than in each
/// `main.rs`: the four children differ only in how they capture plugin state, and a
/// per-child copy of this body drifts as soon as a fifth command kind appears.
///
/// # Safety
/// `region` must point to a live mapped [`orbit_audio_sandbox::SharedRegion`], and this must
/// run on the process main thread (mailbox servicing is main-thread-only after #474 P1 —
/// `CMD_SAVE_STATE` may block on plugin serialization and fsync without stalling audio).
#[cfg(any(target_os = "macos", test))]
pub unsafe fn service_child_main<E: std::fmt::Display>(
    region: *mut orbit_audio_sandbox::SharedRegion,
    ui: &UiService,
    capture_state: impl FnOnce() -> Result<Vec<u8>, E>,
) -> bool {
    unsafe {
        orbit_audio_sandbox::service_command_mailbox(region, |kind, arg| match kind {
            orbit_audio_sandbox::CMD_SAVE_STATE => {
                Some(orbit_audio_sandbox::save_state_command(arg, capture_state))
            }
            orbit_audio_sandbox::CMD_OPEN_UI | orbit_audio_sandbox::CMD_CLOSE_UI => {
                Some(ui.handle_command(kind, arg))
            }
            _ => None,
        });
    }
    ui.tick(ui.now());
    false
}

/// Main-runloop service interval. Mailbox commands and liveness changes are
/// control-plane work, so 20 ms avoids a busy main thread while remaining
/// responsive enough for UI commands.
pub const MAIN_TICK_INTERVAL: Duration = Duration::from_millis(20);

/// 再入スキップの診断行を出す間隔（スキップ回数単位）。
///
/// [`MAIN_TICK_INTERVAL`] が 20ms なので 50 スキップ ≒ 1 秒。nested runloop が続く間、
/// 毎 tick 書くと 1 秒あたり 50 回の未バッファ書き込みになる — 初回 + 1 秒ごとで
/// 「今も再入している」ことは十分伝わる。
// Only the AppKit tick logs skipped ticks, so this has no meaning off macOS.
#[cfg(target_os = "macos")]
const REENTRANT_TICK_LOG_EVERY: u64 = 50;

#[cfg(any(target_os = "macos", test))]
fn try_call_main_service<S, Q>(
    service: &RefCell<S>,
    should_quit: &Q,
) -> Result<bool, BorrowMutError>
where
    S: FnMut() -> bool,
    Q: Fn() -> bool + ?Sized,
{
    let quit_requested = should_quit();
    let mut service = match service.try_borrow_mut() {
        Ok(service) => service,
        Err(_) if quit_requested => return Ok(true),
        Err(error) => return Err(error),
    };
    Ok((*service)() || quit_requested)
}

#[derive(Debug, Error)]
pub enum ChildRuntimeError {
    #[error("orbit child runtime must be started on the process main thread")]
    NotMainThread,
    #[error("NSApplication rejected Accessory activation policy")]
    AccessoryPolicyRejected,
    #[error("invalid host bundle ID argument: {0}")]
    InvalidHostBundleIdArgument(#[from] HostBundleIdArgumentError),
    #[error("failed to spawn dedicated audio thread: {0}")]
    SpawnAudio(#[source] std::io::Error),
    #[error("main-runloop service callback panicked")]
    ServicePanicked,
    #[error("dedicated audio thread panicked: {0}")]
    AudioPanicked(String),
    #[error("{runloop}; audio thread also failed: {audio}")]
    RunloopAndAudioFailed {
        runloop: Box<ChildRuntimeError>,
        audio: Box<ChildRuntimeError>,
    },
}

struct AudioDoneGuard(Arc<AtomicBool>);

impl Drop for AudioDoneGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct StopAudioGuard(Arc<AtomicBool>);

impl Drop for StopAudioGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn spawn_audio<T, F>(
    process_name: &str,
    audio_done: Arc<AtomicBool>,
    audio: F,
) -> Result<JoinHandle<T>, ChildRuntimeError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    thread::Builder::new()
        .name(format!("{process_name}-audio"))
        .spawn(move || {
            let _done = AudioDoneGuard(audio_done);
            set_audio_thread_qos();
            audio()
        })
        .map_err(ChildRuntimeError::SpawnAudio)
}

fn join_audio<T>(handle: JoinHandle<T>) -> Result<T, ChildRuntimeError> {
    handle
        .join()
        .map_err(|payload| ChildRuntimeError::AudioPanicked(panic_payload(payload)))
}

fn panic_payload(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

#[derive(Clone)]
struct StopCoordinator {
    stop_audio: Arc<AtomicBool>,
    audio_done: Arc<AtomicBool>,
}

impl StopCoordinator {
    fn new() -> Self {
        Self {
            stop_audio: Arc::new(AtomicBool::new(false)),
            audio_done: Arc::new(AtomicBool::new(false)),
        }
    }

    fn should_stop(&self, service_requested_stop: bool) -> bool {
        if service_requested_stop || self.audio_done.load(Ordering::Acquire) {
            self.stop_audio.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }
}

/// Run a plugin child with its control plane on the process main thread and
/// its audio loop on a dedicated thread.
///
/// `should_quit` reads `CONTROL_QUIT` without borrowing the main-thread service,
/// so teardown remains observable during a reentrant main-runloop tick.
/// `service_main` is invoked only by the main runloop timer. It should service
/// the command mailbox, then return `true` for parent death or another stop request.
/// `audio` receives a stop flag owned by this runtime; the audio loop should
/// additionally check shared-memory `CONTROL_QUIT` with a Relaxed load so it
/// can leave immediately without touching the mailbox.
///
/// The returned audio value is produced only after the audio thread has been
/// joined. Keeping the main-thread processor half in the caller and consuming
/// the returned value before dropping it structurally enforces
/// `runloop stop -> audio join -> main-thread teardown`.
pub fn run_child<T, A, Q, S>(
    process_name: &str,
    should_quit: Q,
    service_main: S,
    audio: A,
) -> Result<T, ChildRuntimeError>
where
    T: Send + 'static,
    A: FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    Q: Fn() -> bool,
    S: FnMut() -> bool,
{
    #[cfg(target_os = "macos")]
    let host_bundle_id = parse_host_bundle_id_argument(std::env::args().skip(1))?;
    // 🔴 型注釈は load-bearing。macOS では `parse_host_bundle_id_argument` が
    // `Option<String>` を与えるが、非 macOS ではその推論元ごと cfg で消えるため
    // `Option<_>` のままになり **Linux CI だけが E0282 で落ちる**（実測 2026-09-14）。
    #[cfg(not(target_os = "macos"))]
    let host_bundle_id: Option<String> = None;

    run_child_with_main_loop(
        process_name,
        should_quit,
        service_main,
        audio,
        |coordinator, should_quit, service_main| {
            run_main_loop(
                coordinator,
                should_quit,
                service_main,
                host_bundle_id.as_deref(),
            )
        },
    )
}

fn run_child_with_main_loop<T, A, Q, S, M>(
    process_name: &str,
    should_quit: Q,
    mut service_main: S,
    audio: A,
    main_loop: M,
) -> Result<T, ChildRuntimeError>
where
    T: Send + 'static,
    A: FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    Q: Fn() -> bool,
    S: FnMut() -> bool,
    M: FnOnce(&StopCoordinator, &Q, &mut S) -> Result<(), ChildRuntimeError>,
{
    let coordinator = StopCoordinator::new();
    let stop_for_audio = coordinator.stop_audio.clone();
    let audio_handle = spawn_audio(process_name, coordinator.audio_done.clone(), move || {
        audio(stop_for_audio)
    })?;
    // Declared after the handle so unwinding signals stop before detaching the
    // JoinHandle. On the normal path it is dropped before join for the same
    // stop -> join ordering.
    let stop_audio = StopAudioGuard(coordinator.stop_audio.clone());

    let runloop_result = main_loop(&coordinator, &should_quit, &mut service_main);
    drop(stop_audio);
    let audio_result = join_audio(audio_handle);

    match (runloop_result, audio_result) {
        (Ok(()), audio_result) => audio_result,
        (Err(runloop), Ok(_)) => Err(runloop),
        (Err(runloop), Err(audio)) => Err(ChildRuntimeError::RunloopAndAudioFailed {
            runloop: Box::new(runloop),
            audio: Box::new(audio),
        }),
    }
}

#[cfg(target_os = "macos")]
fn run_main_loop(
    coordinator: &StopCoordinator,
    should_quit: &dyn Fn() -> bool,
    service_main: &mut dyn FnMut() -> bool,
    host_bundle_id: Option<&str>,
) -> Result<(), ChildRuntimeError> {
    appkit::run_main_loop(coordinator, should_quit, service_main, host_bundle_id)
}

#[cfg(not(target_os = "macos"))]
fn run_main_loop(
    coordinator: &StopCoordinator,
    should_quit: &dyn Fn() -> bool,
    service_main: &mut dyn FnMut() -> bool,
    _host_bundle_id: Option<&str>,
) -> Result<(), ChildRuntimeError> {
    loop {
        let quit_requested = should_quit();
        let service_requested_stop = service_main();
        if coordinator.should_stop(service_requested_stop || quit_requested) {
            break;
        }
        thread::sleep(MAIN_TICK_INTERVAL);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod appkit;

#[cfg(target_os = "macos")]
fn set_audio_thread_qos() {
    type QosClass = u32;
    const QOS_CLASS_USER_INTERACTIVE: QosClass = 0x21;

    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos_class: QosClass, relative_priority: i32) -> i32;
    }

    let result = unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
    if result != 0 {
        eprintln!("[orbit-child-runtime] audio thread QoS user-interactive setup failed: {result}");
    }
}

#[cfg(not(target_os = "macos"))]
fn set_audio_thread_qos() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    #[test]
    fn parses_optional_host_bundle_id_argument() {
        assert_eq!(parse_host_bundle_id_argument(["--shm", "/tmp/x"]), Ok(None));
        assert_eq!(
            parse_host_bundle_id_argument([
                "--shm",
                "/tmp/x",
                HOST_BUNDLE_ID_ARG,
                "com.microsoft.VSCode",
            ]),
            Ok(Some("com.microsoft.VSCode".to_owned()))
        );
    }

    #[test]
    fn desired_window_level_tracks_host_child_other_and_legacy_cases() {
        let host = Some("com.microsoft.VSCode");
        let child = Some("dev.orbitscore.plugin-child");
        assert_eq!(
            desired_plugin_window_level(host, child, host, false),
            PluginWindowLevel::Floating,
            "host frontmost"
        );
        assert_eq!(
            desired_plugin_window_level(host, child, child, false),
            PluginWindowLevel::Floating,
            "child frontmost"
        );
        assert_eq!(
            desired_plugin_window_level(host, child, Some("com.apple.Safari"), false),
            PluginWindowLevel::Normal,
            "another application frontmost"
        );
        assert_eq!(
            desired_plugin_window_level(None, child, child, true),
            PluginWindowLevel::Normal,
            "legacy launch without a host bundle ID"
        );
        assert_eq!(
            desired_plugin_window_level(host, None, None, true),
            PluginWindowLevel::Floating,
            "standalone child process without a bundle ID frontmost"
        );
    }

    #[test]
    fn service_stop_sets_audio_stop_flag() {
        let coordinator = StopCoordinator::new();
        assert!(coordinator.should_stop(true));
        assert!(coordinator.stop_audio.load(Ordering::Acquire));
    }

    #[test]
    fn audio_completion_stops_main_loop_even_without_service_request() {
        let coordinator = StopCoordinator::new();
        coordinator.audio_done.store(true, Ordering::Release);
        assert!(coordinator.should_stop(false));
        assert!(coordinator.stop_audio.load(Ordering::Acquire));
    }

    #[test]
    fn spawned_audio_completion_signals_coordinator_and_requests_stop() {
        let coordinator = StopCoordinator::new();
        let handle = spawn_audio("runtime-test", coordinator.audio_done.clone(), || ())
            .expect("spawn audio");

        join_audio(handle).expect("join audio");

        assert!(coordinator.audio_done.load(Ordering::Acquire));
        assert!(coordinator.should_stop(false));
        assert!(coordinator.stop_audio.load(Ordering::Acquire));
    }

    #[test]
    fn audio_panic_is_reported_by_join() {
        let handle = spawn_audio("runtime-test", Arc::new(AtomicBool::new(false)), || {
            panic!("plugin process panic")
        })
        .expect("spawn audio");

        let error = join_audio(handle).expect_err("audio panic must fail join");
        assert!(matches!(
            error,
            ChildRuntimeError::AudioPanicked(message) if message == "plugin process panic"
        ));
    }

    #[test]
    fn panic_payload_extracts_borrowed_string() {
        assert_eq!(panic_payload(Box::new("borrowed panic")), "borrowed panic");
    }

    #[test]
    fn panic_payload_extracts_owned_string() {
        assert_eq!(
            panic_payload(Box::new(String::from("owned panic"))),
            "owned panic"
        );
    }

    #[test]
    fn panic_payload_reports_non_string_fallback() {
        assert_eq!(panic_payload(Box::new(42)), "non-string panic payload");
    }

    #[test]
    fn simultaneous_runloop_and_audio_failures_report_both_diagnostics() {
        let result: Result<(), ChildRuntimeError> = run_child_with_main_loop(
            "runtime-test",
            || false,
            || false,
            |_stop| panic!("plugin process panic"),
            |_coordinator, _should_quit, _service_main| Err(ChildRuntimeError::ServicePanicked),
        );

        let error = result.expect_err("both failures must be reported");
        assert!(matches!(
            &error,
            ChildRuntimeError::RunloopAndAudioFailed { runloop, audio }
                if matches!(runloop.as_ref(), ChildRuntimeError::ServicePanicked)
                    && matches!(
                        audio.as_ref(),
                        ChildRuntimeError::AudioPanicked(message)
                            if message == "plugin process panic"
                    )
        ));
        assert_eq!(
            error.to_string(),
            "main-runloop service callback panicked; audio thread also failed: \
             dedicated audio thread panicked: plugin process panic"
        );
    }

    #[test]
    fn main_loop_panic_still_requests_audio_stop() {
        let (audio_stopped_tx, audio_stopped_rx) = mpsc::channel();

        let panic_result = catch_unwind(AssertUnwindSafe(|| {
            let result: Result<(), ChildRuntimeError> = run_child_with_main_loop(
                "runtime-test",
                || false,
                || false,
                move |stop| {
                    while !stop.load(Ordering::Acquire) {
                        thread::yield_now();
                    }
                    audio_stopped_tx
                        .send(())
                        .expect("test receiver remains alive");
                },
                |_coordinator, _should_quit, _service_main| panic!("main loop setup panic"),
            );
            let _ = result;
        }));

        assert!(panic_result.is_err());
        audio_stopped_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("RAII guard must stop detached audio thread during unwind");
    }

    #[test]
    fn idle_tick_keeps_audio_running() {
        let coordinator = StopCoordinator::new();
        assert!(!coordinator.should_stop(false));
        assert!(!coordinator.stop_audio.load(Ordering::Acquire));
    }

    #[test]
    fn reentrant_main_service_tick_is_skipped_instead_of_panicking() {
        let calls = std::cell::Cell::new(0);
        let service = RefCell::new(|| {
            calls.set(calls.get() + 1);
            false
        });
        let held_by_outer_tick = service.borrow_mut();

        let busy_result = catch_unwind(AssertUnwindSafe(|| {
            try_call_main_service(&service, &|| false)
        }));
        assert!(
            busy_result.is_ok(),
            "a nested tick must not panic on an active RefCell borrow"
        );
        assert!(
            busy_result.expect("checked above").is_err(),
            "a nested tick must explicitly report the busy case"
        );
        assert_eq!(calls.get(), 0, "the busy tick must skip service execution");

        drop(held_by_outer_tick);
        assert!(matches!(
            try_call_main_service(&service, &|| false),
            Ok(false)
        ));
        assert_eq!(calls.get(), 1, "the next non-reentrant tick must run");
    }

    #[test]
    fn reentrant_main_service_tick_still_observes_teardown_request() {
        let service_calls = std::cell::Cell::new(0);
        let quit_checks = std::cell::Cell::new(0);
        let service = RefCell::new(|| {
            service_calls.set(service_calls.get() + 1);
            false
        });
        let held_by_outer_tick = service.borrow_mut();
        let coordinator = StopCoordinator::new();

        let requested_stop = try_call_main_service(&service, &|| {
            quit_checks.set(quit_checks.get() + 1);
            true
        })
        .expect("CONTROL_QUIT must bypass a reentrant service borrow");

        assert!(requested_stop);
        assert!(coordinator.should_stop(requested_stop));
        assert!(coordinator.stop_audio.load(Ordering::Acquire));
        assert_eq!(quit_checks.get(), 1);
        assert_eq!(
            service_calls.get(),
            0,
            "the busy service remains skipped while teardown still advances"
        );
        drop(held_by_outer_tick);
    }

    #[test]
    fn reentrant_main_service_tick_still_evaluates_parent_watch_predicate() {
        let service_calls = std::cell::Cell::new(0);
        let parent_watch_checks = std::cell::Cell::new(0);
        let service = RefCell::new(|| {
            service_calls.set(service_calls.get() + 1);
            false
        });
        let held_by_outer_tick = service.borrow_mut();

        let requested_stop = try_call_main_service(&service, &|| {
            quit_reason(false, || {
                parent_watch_checks.set(parent_watch_checks.get() + 1);
                // This stands for `parent_watch.should_exit()` after reparenting.
                true
            })
            .is_some()
        })
        .expect("ParentWatch must bypass a reentrant service borrow");

        assert!(requested_stop);
        assert_eq!(parent_watch_checks.get(), 1);
        assert_eq!(
            service_calls.get(),
            0,
            "the busy service remains skipped while orphan teardown advances"
        );
        drop(held_by_outer_tick);
    }

    /// Zeroed shared region: `CONTROL_RUN == 0`, so control alone never requests a stop.
    fn run_state_region() -> (*mut orbit_audio_sandbox::SharedRegion, std::alloc::Layout) {
        let layout = std::alloc::Layout::new::<orbit_audio_sandbox::SharedRegion>();
        let raw =
            unsafe { std::alloc::alloc_zeroed(layout) } as *mut orbit_audio_sandbox::SharedRegion;
        assert!(!raw.is_null(), "failed to allocate a zeroed SharedRegion");
        (raw, layout)
    }

    /// 🔴 Keeps the two shutdown causes distinguishable.
    ///
    /// Both make the child exit, so a `bool` return hides which one happened — and the stderr
    /// line that used to say so was lost when this predicate was folded into one place
    /// (#474 P3b review). Once the process is gone, the daemon-crash case is unrecoverable
    /// from the outside, so the distinction has to survive in the type.
    #[test]
    fn quit_reason_separates_host_request_from_parent_death() {
        assert_eq!(quit_reason(true, || false), Some(QuitReason::HostRequested));
        assert_eq!(quit_reason(false, || true), Some(QuitReason::ParentDied));
        assert_eq!(quit_reason(false, || false), None);
        // A live parent must not be reported as a host request either.
        assert_eq!(quit_reason(true, || true), Some(QuitReason::HostRequested));
    }

    /// 🔴 Binds `child_should_quit` to the **real** `ParentWatch` it is handed.
    ///
    /// The test above injects its own closure into `quit_reason`, so it only covers
    /// the pure function. Replacing `|| parent_watch.should_exit()` in `child_should_quit` with
    /// `|| false` left all tests green (measured 2026-07-31) — the orphan guard from #448 was
    /// live in all four child binaries with nothing pinning the composition. This test is what
    /// pins it: it goes through `child_should_quit` with control at `CONTROL_RUN`, so only the
    /// parent-watch leg can produce `true`.
    #[test]
    fn child_should_quit_consults_the_injected_parent_watch() {
        let (region, layout) = run_state_region();
        let orphaned = orbit_audio_sandbox::ParentWatch::orphaned_for_tests();
        let live = orbit_audio_sandbox::ParentWatch::new();

        let orphan_requests_quit = unsafe { child_should_quit(region, &orphaned) };
        let live_parent_keeps_running = unsafe { child_should_quit(region, &live) };

        unsafe {
            (*region)
                .control
                .store(orbit_audio_sandbox::CONTROL_QUIT, Ordering::Relaxed)
        };
        let control_quit_requests_quit = unsafe { child_should_quit(region, &live) };

        unsafe { std::alloc::dealloc(region.cast(), layout) };

        assert!(
            orphan_requests_quit,
            "child_should_quit must consult the ParentWatch it is given, not only CONTROL_QUIT"
        );
        assert!(
            !live_parent_keeps_running,
            "a live parent with CONTROL_RUN must not request a stop"
        );
        assert!(
            control_quit_requests_quit,
            "CONTROL_QUIT must still request a stop on its own"
        );
    }

    #[test]
    fn audio_work_runs_on_named_dedicated_thread_and_returns_after_join() {
        let main_id = thread::current().id();
        let executions = Arc::new(AtomicUsize::new(0));
        let executions_audio = executions.clone();
        let handle = spawn_audio(
            "runtime-test",
            Arc::new(AtomicBool::new(false)),
            move || {
                executions_audio.fetch_add(1, Ordering::Relaxed);
                (
                    thread::current().id(),
                    thread::current().name().map(str::to_owned),
                )
            },
        )
        .expect("spawn audio");
        let (audio_id, audio_name) = join_audio(handle).expect("join audio");

        assert_ne!(audio_id, main_id);
        assert_eq!(audio_name.as_deref(), Some("runtime-test-audio"));
        assert_eq!(executions.load(Ordering::Relaxed), 1);
    }
}
