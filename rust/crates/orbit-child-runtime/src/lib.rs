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

/// Main-runloop service interval. Mailbox commands and liveness changes are
/// control-plane work, so 20 ms avoids a busy main thread while remaining
/// responsive enough for UI commands.
pub const MAIN_TICK_INTERVAL: Duration = Duration::from_millis(20);

#[cfg(any(target_os = "macos", test))]
fn try_call_main_service<S>(service: &RefCell<S>) -> Result<bool, BorrowMutError>
where
    S: FnMut() -> bool,
{
    let mut service = service.try_borrow_mut()?;
    Ok((*service)())
}

#[derive(Debug, Error)]
pub enum ChildRuntimeError {
    #[error("orbit child runtime must be started on the process main thread")]
    NotMainThread,
    #[error("NSApplication rejected Accessory activation policy")]
    AccessoryPolicyRejected,
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
/// `service_main` is invoked only by the main runloop timer. It should service
/// the command mailbox, then return `true` for `CONTROL_QUIT` or parent death.
/// `audio` receives a stop flag owned by this runtime; the audio loop should
/// additionally check shared-memory `CONTROL_QUIT` with a Relaxed load so it
/// can leave immediately without touching the mailbox.
///
/// The returned audio value is produced only after the audio thread has been
/// joined. Keeping the main-thread processor half in the caller and consuming
/// the returned value before dropping it structurally enforces
/// `runloop stop -> audio join -> main-thread teardown`.
pub fn run_child<T, A, S>(
    process_name: &str,
    service_main: S,
    audio: A,
) -> Result<T, ChildRuntimeError>
where
    T: Send + 'static,
    A: FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    S: FnMut() -> bool,
{
    run_child_with_main_loop(
        process_name,
        service_main,
        audio,
        |coordinator, service_main| run_main_loop(coordinator, service_main),
    )
}

fn run_child_with_main_loop<T, A, S, M>(
    process_name: &str,
    mut service_main: S,
    audio: A,
    main_loop: M,
) -> Result<T, ChildRuntimeError>
where
    T: Send + 'static,
    A: FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    S: FnMut() -> bool,
    M: FnOnce(&StopCoordinator, &mut S) -> Result<(), ChildRuntimeError>,
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

    let runloop_result = main_loop(&coordinator, &mut service_main);
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
    service_main: &mut dyn FnMut() -> bool,
) -> Result<(), ChildRuntimeError> {
    appkit::run_main_loop(coordinator, service_main)
}

#[cfg(not(target_os = "macos"))]
fn run_main_loop(
    coordinator: &StopCoordinator,
    service_main: &mut dyn FnMut() -> bool,
) -> Result<(), ChildRuntimeError> {
    while !coordinator.should_stop(service_main()) {
        thread::sleep(MAIN_TICK_INTERVAL);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod appkit {
    use std::cell::{Cell, RefCell};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    };
    use objc2_foundation::{
        NSObject, NSObjectProtocol, NSPoint, NSRunLoop, NSRunLoopCommonModes, NSTimer,
    };

    use super::{try_call_main_service, ChildRuntimeError, StopCoordinator, MAIN_TICK_INTERVAL};

    type MainService<'a> = dyn FnMut() -> bool + 'a;

    struct TimerTargetIvars {
        service: RefCell<Box<MainService<'static>>>,
        coordinator: StopCoordinator,
        service_panicked: Cell<bool>,
        reentrant_tick_skip_count: Cell<u64>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. TimerTarget has
        // no Drop implementation and is confined to the process main thread.
        #[unsafe(super = NSObject)]
        #[name = "OrbitChildRuntimeTimerTarget"]
        #[thread_kind = MainThreadOnly]
        #[ivars = TimerTargetIvars]
        struct TimerTarget;

        // SAFETY: NSObjectProtocol adds no extra invariants.
        unsafe impl NSObjectProtocol for TimerTarget {}

        impl TimerTarget {
            // SAFETY: NSTimer invokes this selector with exactly one NSTimer argument.
            #[unsafe(method(tick:))]
            fn tick(&self, timer: &NSTimer) {
                let requested_stop = match catch_unwind(AssertUnwindSafe(|| {
                    try_call_main_service(&self.ivars().service)
                })) {
                    Ok(Ok(value)) => value,
                    Ok(Err(_busy)) => {
                        let skipped = self
                            .ivars()
                            .reentrant_tick_skip_count
                            .get()
                            .saturating_add(1);
                        self.ivars().reentrant_tick_skip_count.set(skipped);
                        // Child stderr is inherited by the daemon in both effect and
                        // instrument supervisors, so the cumulative count is visible
                        // to the host even though child tracing has no subscriber.
                        eprintln!(
                            "[orbit-child-runtime] skipped reentrant main-runloop tick; \
                             skipped_ticks={skipped}"
                        );
                        return;
                    }
                    Err(_) => {
                        self.ivars().service_panicked.set(true);
                        true
                    }
                };
                if self.ivars().coordinator.should_stop(requested_stop) {
                    timer.invalidate();
                    let app = NSApplication::sharedApplication(self.mtm());
                    app.stop(None);

                    // `stop` is observed after AppKit finishes dispatching an
                    // event. A timer callback is not an event, so wake the
                    // headless runloop with a harmless application event.
                    let wake_event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                        NSEventType::ApplicationDefined,
                        NSPoint::ZERO,
                        NSEventModifierFlags::empty(),
                        0.0,
                        0,
                        None,
                        0,
                        0,
                        0,
                    );
                    if let Some(wake_event) = wake_event {
                        app.postEvent_atStart(&wake_event, true);
                    }
                }
            }
        }
    );

    impl TimerTarget {
        fn new(
            mtm: MainThreadMarker,
            service: Box<MainService<'static>>,
            coordinator: StopCoordinator,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(TimerTargetIvars {
                service: RefCell::new(service),
                coordinator,
                service_panicked: Cell::new(false),
                reentrant_tick_skip_count: Cell::new(0),
            });
            // SAFETY: this is NSObject's designated initializer and the
            // superclass does not impose extra initialization requirements.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub(super) fn run_main_loop(
        coordinator: &StopCoordinator,
        service_main: &mut dyn FnMut() -> bool,
    ) -> Result<(), ChildRuntimeError> {
        let mtm = MainThreadMarker::new().ok_or(ChildRuntimeError::NotMainThread)?;

        // NSTimer retains its target until invalidation. The target never
        // escapes this function/runloop, so extending the callback reference
        // to that exact lifetime is sound. It is invalidated before return.
        let service: Box<MainService<'_>> = Box::new(service_main);
        let service: Box<MainService<'static>> = unsafe { std::mem::transmute(service) };
        let target = TimerTarget::new(mtm, service, coordinator.clone());

        let app = NSApplication::sharedApplication(mtm);
        if !app.setActivationPolicy(NSApplicationActivationPolicy::Accessory) {
            coordinator
                .stop_audio
                .store(true, std::sync::atomic::Ordering::Release);
            return Err(ChildRuntimeError::AccessoryPolicyRejected);
        }

        let timer = unsafe {
            NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
                MAIN_TICK_INTERVAL.as_secs_f64(),
                &target,
                sel!(tick:),
                None,
                true,
            )
        };
        // Common modes keep mailbox/liveness servicing active while AppKit is
        // tracking mouse/keyboard interaction in a hosted plugin editor.
        unsafe {
            NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
        }
        timer.fire();
        if !coordinator
            .stop_audio
            .load(std::sync::atomic::Ordering::Acquire)
        {
            app.run();
        }
        timer.invalidate();

        if target.ivars().service_panicked.get() {
            Err(ChildRuntimeError::ServicePanicked)
        } else {
            Ok(())
        }
    }
}

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
            |_stop| panic!("plugin process panic"),
            |_coordinator, _service_main| Err(ChildRuntimeError::ServicePanicked),
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
                move |stop| {
                    while !stop.load(Ordering::Acquire) {
                        thread::yield_now();
                    }
                    audio_stopped_tx
                        .send(())
                        .expect("test receiver remains alive");
                },
                |_coordinator, _service_main| panic!("main loop setup panic"),
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

        let busy_result = catch_unwind(AssertUnwindSafe(|| try_call_main_service(&service)));
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
        assert!(matches!(try_call_main_service(&service), Ok(false)));
        assert_eq!(calls.get(), 1, "the next non-reentrant tick must run");
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
