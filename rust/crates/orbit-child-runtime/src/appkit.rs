use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};

use objc2::rc::Retained;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    NSRunningApplication, NSWorkspace, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{
    NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRunLoop, NSRunLoopCommonModes, NSTimer,
};

use super::{
    desired_plugin_window_level, try_call_main_service, ChildRuntimeError, StopCoordinator,
    MAIN_TICK_INTERVAL,
};

type MainService<'a> = dyn FnMut() -> bool + 'a;
type QuitPredicate<'a> = dyn Fn() -> bool + 'a;

struct TimerTargetIvars {
    service: RefCell<Box<MainService<'static>>>,
    should_quit: Box<QuitPredicate<'static>>,
    coordinator: StopCoordinator,
    service_panicked: Cell<bool>,
    reentrant_tick_skip_count: Cell<u64>,
}

struct ActivationObserverIvars {
    host_bundle_id: String,
    child_bundle_id: Option<String>,
    child_application: Retained<NSRunningApplication>,
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
                try_call_main_service(&self.ivars().service, self.ivars().should_quit.as_ref())
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
                    //
                    // 🔴 Rate-limited: a nested runloop (modal sheet, live resize,
                    // drag tracking) can hold the borrow for seconds, and this tick
                    // runs every 20ms. Logging unconditionally would emit ~50
                    // unbuffered writes per second for the whole interaction. The
                    // first skip announces the condition; every REENTRANT_TICK_LOG_EVERY
                    // skips after that keeps the cumulative count fresh.
                    if skipped == 1 || skipped.is_multiple_of(crate::REENTRANT_TICK_LOG_EVERY) {
                        eprintln!(
                            "[orbit-child-runtime] skipped reentrant main-runloop tick; \
                             skipped_ticks={skipped}"
                        );
                    }
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

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The observer is retained for
    // exactly the main-runloop lifetime and receives notifications on that thread.
    #[unsafe(super = NSObject)]
    #[name = "OrbitChildRuntimeActivationObserver"]
    #[thread_kind = MainThreadOnly]
    #[ivars = ActivationObserverIvars]
    struct ActivationObserver;

    // SAFETY: NSObjectProtocol adds no extra invariants.
    unsafe impl NSObjectProtocol for ActivationObserver {}

    impl ActivationObserver {
        // SAFETY: NSNotificationCenter invokes this selector with one NSNotification.
        #[unsafe(method(frontmostApplicationDidChange:))]
        fn frontmost_application_did_change(&self, _notification: &NSNotification) {
            self.update_window_level();
        }
    }
);

impl TimerTarget {
    fn new(
        mtm: MainThreadMarker,
        service: Box<MainService<'static>>,
        should_quit: Box<QuitPredicate<'static>>,
        coordinator: StopCoordinator,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TimerTargetIvars {
            service: RefCell::new(service),
            should_quit,
            coordinator,
            service_panicked: Cell::new(false),
            reentrant_tick_skip_count: Cell::new(0),
        });
        // SAFETY: this is NSObject's designated initializer and the
        // superclass does not impose extra initialization requirements.
        unsafe { msg_send![super(this), init] }
    }
}

impl ActivationObserver {
    fn new(mtm: MainThreadMarker, host_bundle_id: String) -> Retained<Self> {
        let child_application = NSRunningApplication::currentApplication();
        let child_bundle_id = child_application
            .bundleIdentifier()
            .map(|bundle_id| bundle_id.to_string());
        let this = Self::alloc(mtm).set_ivars(ActivationObserverIvars {
            host_bundle_id,
            child_bundle_id,
            child_application,
        });
        // SAFETY: this is NSObject's designated initializer and the superclass does
        // not impose extra initialization requirements.
        unsafe { msg_send![super(this), init] }
    }

    fn update_window_level(&self) {
        let frontmost_application = NSWorkspace::sharedWorkspace().frontmostApplication();
        let frontmost_is_child_process = frontmost_application
            .as_ref()
            .is_some_and(|application| application == &self.ivars().child_application);
        let frontmost_bundle_id = frontmost_application
            .and_then(|application| application.bundleIdentifier())
            .map(|bundle_id| bundle_id.to_string());
        let level = desired_plugin_window_level(
            Some(&self.ivars().host_bundle_id),
            self.ivars().child_bundle_id.as_deref(),
            frontmost_bundle_id.as_deref(),
            frontmost_is_child_process,
        );
        crate::window::set_plugin_window_level(level);
    }
}

pub(super) fn run_main_loop(
    coordinator: &StopCoordinator,
    should_quit: &dyn Fn() -> bool,
    service_main: &mut dyn FnMut() -> bool,
    host_bundle_id: Option<&str>,
) -> Result<(), ChildRuntimeError> {
    let mtm = MainThreadMarker::new().ok_or(ChildRuntimeError::NotMainThread)?;

    // NSTimer retains its target until invalidation. The target never
    // escapes this function/runloop, so extending the callback reference
    // to that exact lifetime is sound. It is invalidated before return.
    let service: Box<MainService<'_>> = Box::new(service_main);
    let service: Box<MainService<'static>> = unsafe { std::mem::transmute(service) };
    let should_quit: Box<QuitPredicate<'_>> = Box::new(should_quit);
    let should_quit: Box<QuitPredicate<'static>> = unsafe { std::mem::transmute(should_quit) };
    let target = TimerTarget::new(mtm, service, should_quit, coordinator.clone());

    let app = NSApplication::sharedApplication(mtm);
    if !app.setActivationPolicy(NSApplicationActivationPolicy::Accessory) {
        coordinator
            .stop_audio
            .store(true, std::sync::atomic::Ordering::Release);
        return Err(ChildRuntimeError::AccessoryPolicyRejected);
    }

    let workspace = NSWorkspace::sharedWorkspace();
    let activation_observer = host_bundle_id.map(|host_bundle_id| {
        let observer = ActivationObserver::new(mtm, host_bundle_id.to_owned());
        let notification_center = workspace.notificationCenter();
        // SAFETY: the selector is implemented by ActivationObserver with the exact
        // one-notification signature, and the observer is retained until removal below.
        unsafe {
            notification_center.addObserver_selector_name_object(
                &observer,
                sel!(frontmostApplicationDidChange:),
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
            );
        }
        observer.update_window_level();
        observer
    });
    if activation_observer.is_none() {
        crate::window::set_plugin_window_level(super::PluginWindowLevel::Normal);
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

    if let Some(observer) = activation_observer {
        // SAFETY: this removes the same live observer from the center where it was added.
        unsafe {
            workspace.notificationCenter().removeObserver(&observer);
        }
    }

    if target.ivars().service_panicked.get() {
        Err(ChildRuntimeError::ServicePanicked)
    } else {
        Ok(())
    }
}
