//! Shared execution model for the four out-of-process plugin children.
//!
//! On macOS the process main thread is given to an `NSApplication` runloop
//! (Accessory activation policy). A short main-runloop timer services the
//! command mailbox and process-liveness checks supplied by the child. Audio
//! processing runs on one dedicated user-interactive QoS thread.

use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use thiserror::Error;

/// Main-runloop service interval. Mailbox commands and liveness changes are
/// control-plane work, so 20 ms avoids a busy main thread while remaining
/// responsive enough for UI commands.
pub const MAIN_TICK_INTERVAL: Duration = Duration::from_millis(20);

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
}

struct AudioDoneGuard(Arc<AtomicBool>);

impl Drop for AudioDoneGuard {
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
    mut service_main: S,
    audio: A,
) -> Result<T, ChildRuntimeError>
where
    T: Send + 'static,
    A: FnOnce(Arc<AtomicBool>) -> T + Send + 'static,
    S: FnMut() -> bool,
{
    let coordinator = StopCoordinator::new();
    let stop_for_audio = coordinator.stop_audio.clone();
    let audio_handle = spawn_audio(process_name, coordinator.audio_done.clone(), move || {
        audio(stop_for_audio)
    })?;

    let runloop_result = run_main_loop(&coordinator, &mut service_main);
    coordinator.stop_audio.store(true, Ordering::Release);
    let audio_result = join_audio(audio_handle);

    runloop_result?;
    audio_result
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

    use super::{ChildRuntimeError, StopCoordinator, MAIN_TICK_INTERVAL};

    type MainService<'a> = dyn FnMut() -> bool + 'a;

    struct TimerTargetIvars {
        service: RefCell<Box<MainService<'static>>>,
        coordinator: StopCoordinator,
        service_panicked: Cell<bool>,
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
                    (self.ivars().service.borrow_mut())()
                })) {
                    Ok(value) => value,
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
    use std::sync::atomic::AtomicUsize;

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
    fn idle_tick_keeps_audio_running() {
        let coordinator = StopCoordinator::new();
        assert!(!coordinator.should_stop(false));
        assert!(!coordinator.stop_audio.load(Ordering::Acquire));
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
