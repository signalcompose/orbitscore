use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

use orbit_audio_sandbox::transport::{EventRingChild, EVT_UI_CLOSED, EVT_UI_CLOSED_DONE};
#[cfg(test)]
use orbit_audio_sandbox::CMD_SAVE_STATE;
use orbit_audio_sandbox::{
    CommandOutcome, SharedRegion, CMD_CLOSE_UI, CMD_OPEN_UI, CMD_RESULT_PLUGIN_ERROR,
    CMD_RESULT_UNKNOWN_KIND,
};
use orbit_child_ui::{
    CloseCompletion, PluginUiEndpoint, UiCloseStateMachine, UiEvent, UiHostActions, UiSize,
    ALREADY_OPEN_DETAIL,
};

/// Maximum time Phase B waits for the host to complete the `UI_CLOSED` safepoint.
pub const UI_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) type WindowCloseCallback = Rc<dyn Fn() -> bool>;
pub(crate) type WindowResizeCallback = Rc<dyn Fn(UiSize)>;

pub(crate) trait WindowHandle {
    fn content_view(&self) -> *mut c_void;
    fn set_title(&mut self, title: &str) -> Result<(), String>;
    fn resize(&mut self, size: UiSize) -> Result<(), String>;
    fn close(&mut self);
}

pub(crate) trait WindowFactory {
    fn create(
        &mut self,
        size: UiSize,
        can_resize: bool,
        close_callback: WindowCloseCallback,
        resize_callback: WindowResizeCallback,
    ) -> Result<Box<dyn WindowHandle>, String>;
}

/// Thread-safe plugin GUI callbacks consumed by the main-runloop tick.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UiCallbacks {
    pub closed: Option<bool>,
    pub requested_size: Option<UiSize>,
}

/// Main-thread access to the concrete plugin object also used through the UI endpoint trait.
pub struct PluginMainHandle<E> {
    endpoint: Rc<RefCell<E>>,
}

impl<E> PluginMainHandle<E> {
    pub fn with_mut<T>(&self, operation: impl FnOnce(&mut E) -> T) -> T {
        operation(&mut self.endpoint.borrow_mut())
    }
}

struct SharedEndpoint<E> {
    endpoint: Rc<RefCell<E>>,
}

impl<E: PluginUiEndpoint> PluginUiEndpoint for SharedEndpoint<E> {
    fn begin_open(&mut self) -> Result<UiSize, String> {
        self.endpoint.borrow_mut().begin_open()
    }

    fn attach(&mut self, parent: *mut c_void) -> Result<(), String> {
        self.endpoint.borrow_mut().attach(parent)
    }

    fn release(&mut self, was_destroyed: bool) {
        self.endpoint.borrow_mut().release(was_destroyed);
    }

    fn can_resize(&self) -> bool {
        self.endpoint.borrow().can_resize()
    }

    fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String> {
        self.endpoint.borrow_mut().apply_host_resize(size)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IndexedUiEvent {
    index: Option<u32>,
    event: UiEvent,
}

struct UiEventHubCore {
    region: *mut SharedRegion,
    event_ring: EventRingChild,
    queued_in_ring: Option<IndexedUiEvent>,
    pending: VecDeque<IndexedUiEvent>,
    published: Vec<(IndexedUiEvent, u64)>,
}

impl UiEventHubCore {
    fn event_arg(event: IndexedUiEvent) -> String {
        match (event.index, event.event) {
            (None, UiEvent::UiClosed) => String::new(),
            (None, UiEvent::UiClosedDone(CloseCompletion::SafepointCompleted)) => {
                "safepoint-completed".into()
            }
            (None, UiEvent::UiClosedDone(CloseCompletion::TimedOutWithoutSave)) => {
                "timeout-without-save".into()
            }
            (Some(index), UiEvent::UiClosed) => format!(r#"{{"index":{index}}}"#),
            (Some(index), UiEvent::UiClosedDone(CloseCompletion::SafepointCompleted)) => {
                format!(r#"{{"index":{index},"completion":"safepoint-completed"}}"#)
            }
            (Some(index), UiEvent::UiClosedDone(CloseCompletion::TimedOutWithoutSave)) => {
                format!(r#"{{"index":{index},"completion":"timeout-without-save"}}"#)
            }
        }
    }

    fn event_kind(event: UiEvent) -> u32 {
        match event {
            UiEvent::UiClosed => EVT_UI_CLOSED,
            UiEvent::UiClosedDone(_) => EVT_UI_CLOSED_DONE,
        }
    }

    fn try_publish(&mut self, requested: IndexedUiEvent) -> Option<u64> {
        if let Some(position) = self
            .published
            .iter()
            .position(|(event, _)| *event == requested)
        {
            return Some(self.published.swap_remove(position).1);
        }
        if self.queued_in_ring != Some(requested) && !self.pending.contains(&requested) {
            self.pending.push_back(requested);
        }

        if self.queued_in_ring.is_none() {
            if let Some(event) = self.pending.pop_front() {
                let arg = Self::event_arg(event);
                self.event_ring
                    .queue(Self::event_kind(event.event), &arg)
                    .expect("UiEvent always maps to a supported event-ring kind");
                self.queued_in_ring = Some(event);
            }
        }

        let published = match unsafe { self.event_ring.service(self.region) } {
            Ok(published) => published,
            Err(error) => {
                eprintln!("[orbit-child-runtime] plugin UI event publication failed: {error}");
                return None;
            }
        };
        if published > 0 {
            debug_assert_eq!(published, 1);
            let event = self
                .queued_in_ring
                .take()
                .expect("a published UI event must have a retained identity");
            let seq = unsafe { (*self.region).evt_seq.load_own() };
            self.published.push((event, seq));
        }

        self.published
            .iter()
            .position(|(event, _)| *event == requested)
            .map(|position| self.published.swap_remove(position).1)
    }

    fn event_ack_seq(&self) -> u64 {
        unsafe { (*self.region).evt_ack_seq.read() }
    }

    fn is_drained(&self) -> bool {
        self.pending.is_empty()
            && self.queued_in_ring.is_none()
            && self.published.is_empty()
            && unsafe { self.event_ring.is_drained(self.region) }
    }
}

/// Shared event publisher for all indexed plugin UIs in one rack child.
///
/// Every indexed [`UiService`] in a child must use the same hub so close events retain one
/// total order in the single shared-memory event ring.
#[derive(Clone)]
pub struct UiEventHub(Rc<RefCell<UiEventHubCore>>);

impl UiEventHub {
    pub fn new(region: *mut SharedRegion) -> Self {
        Self(Rc::new(RefCell::new(UiEventHubCore {
            region,
            event_ring: EventRingChild::new(),
            queued_in_ring: None,
            pending: VecDeque::new(),
            published: Vec::new(),
        })))
    }
}

struct UiActions {
    event_hub: UiEventHub,
    event_index: Option<Rc<Cell<u32>>>,
    endpoint: Box<dyn PluginUiEndpoint>,
    poll_callbacks: Box<dyn FnMut() -> UiCallbacks>,
    window_factory: Box<dyn WindowFactory>,
    window: Option<Box<dyn WindowHandle>>,
    next_window_title: Option<String>,
    close_callback: WindowCloseCallback,
    resize_callback: WindowResizeCallback,
}

impl UiActions {
    fn resize_window(&mut self, size: UiSize) {
        let Some(window) = self.window.as_mut() else {
            return;
        };
        if let Err(detail) = window.resize(size) {
            eprintln!("[orbit-child-runtime] plugin UI resize failed: {detail}");
        }
    }

    fn apply_host_resize(&mut self, size: UiSize) {
        if let Err(detail) = self.endpoint.apply_host_resize(size) {
            eprintln!("[orbit-child-runtime] plugin rejected host window resize: {detail}");
        }
    }
}

impl UiHostActions for UiActions {
    fn open_ui(&mut self) -> Result<(), String> {
        let (size, can_resize) = {
            let size = self.endpoint.begin_open()?;
            (size, self.endpoint.can_resize())
        };
        let mut window = match self.window_factory.create(
            size,
            can_resize,
            self.close_callback.clone(),
            self.resize_callback.clone(),
        ) {
            Ok(window) => window,
            Err(detail) => {
                self.endpoint.release(false);
                return Err(detail);
            }
        };

        if let Some(title) = self.next_window_title.take() {
            if let Err(detail) = window.set_title(&title) {
                self.endpoint.release(false);
                window.close();
                return Err(detail);
            }
        }

        if let Err(detail) = self.endpoint.attach(window.content_view()) {
            // The plugin-owned view must be released before its parent is destroyed.
            self.endpoint.release(false);
            window.close();
            return Err(detail);
        }
        self.window = Some(window);
        Ok(())
    }

    fn try_publish_event(&mut self, event: UiEvent) -> Option<u64> {
        let indexed = IndexedUiEvent {
            index: self.event_index.as_ref().map(|index| index.get()),
            event,
        };
        self.event_hub.0.borrow_mut().try_publish(indexed)
    }

    fn event_ack_seq(&self) -> u64 {
        self.event_hub.0.borrow().event_ack_seq()
    }

    fn is_event_ring_drained(&self) -> bool {
        self.event_hub.0.borrow().is_drained()
    }

    fn release_plugin_ui(&mut self, was_destroyed: bool) {
        self.endpoint.release(was_destroyed);
    }

    fn destroy_window(&mut self) {
        if let Some(mut window) = self.window.take() {
            window.close();
        }
    }
}

struct UiServiceCore {
    machine: UiCloseStateMachine,
    actions: UiActions,
}

fn with_machine<T>(
    core: &mut UiServiceCore,
    operation: impl FnOnce(&mut UiCloseStateMachine, &mut UiActions) -> T,
) -> T {
    operation(&mut core.machine, &mut core.actions)
}

/// Shared AppKit/plugin/transport adapter used by all four plugin child binaries.
pub struct UiService {
    core: Rc<RefCell<UiServiceCore>>,
    pending_window_close: Rc<Cell<bool>>,
    pending_host_resize: Rc<Cell<Option<UiSize>>>,
    event_index: Option<Rc<Cell<u32>>>,
    idempotent_open: bool,
    started_at: Instant,
}

impl UiService {
    #[cfg(target_os = "macos")]
    pub fn new<E, F>(
        region: *mut SharedRegion,
        endpoint: E,
        poll_callbacks: F,
    ) -> (Self, PluginMainHandle<E>)
    where
        E: PluginUiEndpoint + 'static,
        F: FnMut(&E) -> UiCallbacks + 'static,
    {
        Self::with_window_factory_and_events(
            region,
            UiEventHub::new(region),
            None,
            endpoint,
            poll_callbacks,
            Box::new(crate::window::AppKitWindowFactory),
            UI_CLOSE_TIMEOUT,
        )
    }

    /// Construct one stage-indexed UI using a rack-wide shared event hub.
    #[cfg(target_os = "macos")]
    pub fn new_indexed<E, F>(
        region: *mut SharedRegion,
        index: u32,
        event_hub: UiEventHub,
        endpoint: E,
        poll_callbacks: F,
    ) -> (Self, PluginMainHandle<E>)
    where
        E: PluginUiEndpoint + 'static,
        F: FnMut(&E) -> UiCallbacks + 'static,
    {
        Self::with_window_factory_and_events(
            region,
            event_hub,
            Some(index),
            endpoint,
            poll_callbacks,
            Box::new(crate::window::AppKitWindowFactory),
            UI_CLOSE_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn with_window_factory<E, F>(
        region: *mut SharedRegion,
        endpoint: E,
        poll_callbacks: F,
        window_factory: Box<dyn WindowFactory>,
        close_timeout: Duration,
    ) -> (Self, PluginMainHandle<E>)
    where
        E: PluginUiEndpoint + 'static,
        F: FnMut(&E) -> UiCallbacks + 'static,
    {
        Self::with_window_factory_and_events(
            region,
            UiEventHub::new(region),
            None,
            endpoint,
            poll_callbacks,
            window_factory,
            close_timeout,
        )
    }

    fn with_window_factory_and_events<E, F>(
        _region: *mut SharedRegion,
        event_hub: UiEventHub,
        index: Option<u32>,
        endpoint: E,
        mut poll_callbacks: F,
        window_factory: Box<dyn WindowFactory>,
        close_timeout: Duration,
    ) -> (Self, PluginMainHandle<E>)
    where
        E: PluginUiEndpoint + 'static,
        F: FnMut(&E) -> UiCallbacks + 'static,
    {
        let endpoint = Rc::new(RefCell::new(endpoint));
        let endpoint_for_ui = endpoint.clone();
        let endpoint_for_callbacks = endpoint.clone();
        let pending_window_close = Rc::new(Cell::new(false));
        let pending_for_callback = pending_window_close.clone();
        let pending_host_resize = Rc::new(Cell::new(None));
        let pending_resize_for_callback = pending_host_resize.clone();
        let started_at = Instant::now();
        let event_index = index.map(|index| Rc::new(Cell::new(index)));
        let weak_core: Rc<RefCell<Weak<RefCell<UiServiceCore>>>> =
            Rc::new(RefCell::new(Weak::new()));
        let weak_for_callback = weak_core.clone();
        let close_callback: WindowCloseCallback = Rc::new(move || {
            let Some(core) = weak_for_callback.borrow().upgrade() else {
                return false;
            };
            let Ok(mut core) = core.try_borrow_mut() else {
                pending_for_callback.set(true);
                return false;
            };
            with_machine(&mut core, |machine, actions| {
                machine.window_should_close(started_at.elapsed(), actions)
            })
        });
        let weak_for_resize = weak_core.clone();
        let resize_callback: WindowResizeCallback = Rc::new(move |size| {
            let Some(core) = weak_for_resize.borrow().upgrade() else {
                return;
            };
            let Ok(mut core) = core.try_borrow_mut() else {
                pending_resize_for_callback.set(Some(size));
                return;
            };
            core.actions.apply_host_resize(size);
        });

        let core = Rc::new(RefCell::new(UiServiceCore {
            machine: UiCloseStateMachine::new(close_timeout),
            actions: UiActions {
                event_hub,
                event_index: event_index.clone(),
                endpoint: Box::new(SharedEndpoint {
                    endpoint: endpoint_for_ui,
                }),
                poll_callbacks: Box::new(move || {
                    let endpoint = endpoint_for_callbacks.borrow();
                    poll_callbacks(&endpoint)
                }),
                window_factory,
                window: None,
                next_window_title: None,
                close_callback,
                resize_callback,
            },
        }));
        *weak_core.borrow_mut() = Rc::downgrade(&core);

        (
            Self {
                core,
                pending_window_close,
                pending_host_resize,
                event_index,
                idempotent_open: index.is_some(),
                started_at,
            },
            PluginMainHandle { endpoint },
        )
    }

    /// Elapsed time from the single monotonic clock used by this service.
    pub fn now(&self) -> Duration {
        self.started_at.elapsed()
    }

    /// Update the stage index carried by future close events after a keep operation shifts it.
    pub fn set_index(&self, index: u32) {
        if let Some(event_index) = &self.event_index {
            event_index.set(index);
        }
    }

    /// Handle one UI mailbox command. `OPEN_UI` acks after title + attach; `CLOSE_UI` acks at
    /// Phase A. The daemon only validates and forwards the caller-rendered title in `cmd_arg`; the
    /// child applies it to the host-owned window before plugin attach.
    pub fn handle_command(&self, kind: u32, arg: Option<&str>) -> CommandOutcome {
        let now = self.now();
        let ack = {
            let mut core = self.core.borrow_mut();
            if kind == CMD_OPEN_UI {
                core.actions.next_window_title =
                    arg.filter(|title| !title.is_empty()).map(str::to_owned);
            }
            with_machine(&mut core, |machine, actions| match kind {
                CMD_OPEN_UI => machine.open_command(actions),
                CMD_CLOSE_UI => machine.close_command(now, actions),
                _ => orbit_child_ui::CommandAck {
                    success: false,
                    detail: format!("unknown UI cmd_kind {kind}").into(),
                },
            })
        };
        CommandOutcome {
            result: if ack.success || (self.idempotent_open && ack.detail == ALREADY_OPEN_DETAIL) {
                orbit_audio_sandbox::CMD_RESULT_OK
            } else if matches!(kind, CMD_OPEN_UI | CMD_CLOSE_UI) {
                CMD_RESULT_PLUGIN_ERROR
            } else {
                CMD_RESULT_UNKNOWN_KIND
            },
            len: 0,
            detail: ack.detail.into_owned(),
        }
    }

    /// Advance callback marshaling, retained-event publication, and close Phase B.
    pub fn tick(&self, now: Duration) {
        let mut core = self.core.borrow_mut();
        if self.pending_window_close.replace(false) {
            with_machine(&mut core, |machine, actions| {
                machine.window_should_close(now, actions);
            });
        }
        if let Some(size) = self.pending_host_resize.take() {
            core.actions.apply_host_resize(size);
        }

        let callbacks = (core.actions.poll_callbacks)();
        if let Some(was_destroyed) = callbacks.closed {
            with_machine(&mut core, |machine, actions| {
                machine.clap_closed(was_destroyed, now, actions);
            });
        }
        if let Some(size) = callbacks.requested_size {
            core.actions.resize_window(size);
        }
        with_machine(&mut core, |machine, actions| machine.tick(now, actions));
    }
}

impl Drop for UiService {
    fn drop(&mut self) {
        let Ok(mut core) = self.core.try_borrow_mut() else {
            return;
        };
        if core.actions.window.is_some() {
            core.actions.release_plugin_ui(false);
            core.actions.destroy_window();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use orbit_audio_sandbox::{create_shared, region_ptr, CMD_RESULT_OK};
    use orbit_child_ui::UiState;

    struct TestRegion {
        path: PathBuf,
        region: *mut SharedRegion,
        _mapping: Box<dyn std::any::Any>,
    }

    impl TestRegion {
        fn new(label: &str) -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "orbit-ui-service-{label}-{}-{id}.shm",
                std::process::id()
            ));
            let mmap = create_shared(&path).expect("create test shared region");
            let region = region_ptr(&mmap);
            Self {
                path,
                region,
                _mapping: Box::new(mmap),
            }
        }

        fn ptr(&self) -> *mut SharedRegion {
            self.region
        }
    }

    impl Drop for TestRegion {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[derive(Default)]
    struct EndpointControls {
        attach_error: Cell<bool>,
    }

    struct MockEndpoint {
        trace: Rc<RefCell<Vec<String>>>,
        controls: Rc<EndpointControls>,
    }

    impl PluginUiEndpoint for MockEndpoint {
        fn begin_open(&mut self) -> Result<UiSize, String> {
            self.trace.borrow_mut().push("endpoint.begin_open".into());
            Ok(UiSize {
                width: 640,
                height: 480,
            })
        }

        fn attach(&mut self, parent: *mut c_void) -> Result<(), String> {
            assert!(!parent.is_null(), "mock parent must be non-null");
            self.trace.borrow_mut().push("endpoint.attach".into());
            if self.controls.attach_error.get() {
                Err("attach rejected".into())
            } else {
                Ok(())
            }
        }

        fn release(&mut self, was_destroyed: bool) {
            self.trace
                .borrow_mut()
                .push(format!("endpoint.release({was_destroyed})"));
        }

        fn can_resize(&self) -> bool {
            true
        }

        fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String> {
            self.trace.borrow_mut().push(format!(
                "endpoint.apply_host_resize({}x{})",
                size.width, size.height
            ));
            Ok(())
        }
    }

    #[derive(Default)]
    struct WindowProbe {
        callback: RefCell<Option<WindowCloseCallback>>,
        resize_callback: RefCell<Option<WindowResizeCallback>>,
        invoke_callback_on_close: Cell<bool>,
        close_callback_result: Cell<Option<bool>>,
        last_size: Cell<Option<UiSize>>,
        title: RefCell<Option<String>>,
    }

    struct MockWindow {
        trace: Rc<RefCell<Vec<String>>>,
        probe: Rc<WindowProbe>,
    }

    impl WindowHandle for MockWindow {
        fn content_view(&self) -> *mut c_void {
            std::ptr::dangling_mut::<c_void>()
        }

        fn set_title(&mut self, title: &str) -> Result<(), String> {
            self.trace
                .borrow_mut()
                .push(format!("window.set_title({title})"));
            *self.probe.title.borrow_mut() = Some(title.to_owned());
            Ok(())
        }

        fn resize(&mut self, size: UiSize) -> Result<(), String> {
            self.trace
                .borrow_mut()
                .push(format!("window.resize({}x{})", size.width, size.height));
            self.probe.last_size.set(Some(size));
            Ok(())
        }

        fn close(&mut self) {
            self.trace.borrow_mut().push("window.close".into());
            if self.probe.invoke_callback_on_close.get() {
                let callback = self
                    .probe
                    .callback
                    .borrow()
                    .clone()
                    .expect("window close callback");
                self.probe.close_callback_result.set(Some(callback()));
            }
        }
    }

    struct MockWindowFactory {
        trace: Rc<RefCell<Vec<String>>>,
        probe: Rc<WindowProbe>,
    }

    impl WindowFactory for MockWindowFactory {
        fn create(
            &mut self,
            size: UiSize,
            can_resize: bool,
            close_callback: WindowCloseCallback,
            resize_callback: WindowResizeCallback,
        ) -> Result<Box<dyn WindowHandle>, String> {
            assert_eq!(
                size,
                UiSize {
                    width: 640,
                    height: 480
                }
            );
            assert!(can_resize);
            self.trace.borrow_mut().push("window.create".into());
            *self.probe.callback.borrow_mut() = Some(close_callback);
            *self.probe.resize_callback.borrow_mut() = Some(resize_callback);
            Ok(Box::new(MockWindow {
                trace: self.trace.clone(),
                probe: self.probe.clone(),
            }))
        }
    }

    struct Fixture {
        region: TestRegion,
        ui: UiService,
        endpoint_controls: Rc<EndpointControls>,
        callbacks: Rc<Cell<UiCallbacks>>,
        window: Rc<WindowProbe>,
        trace: Rc<RefCell<Vec<String>>>,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let region = TestRegion::new(label);
            let trace = Rc::new(RefCell::new(Vec::new()));
            let endpoint_controls = Rc::new(EndpointControls::default());
            let callbacks = Rc::new(Cell::new(UiCallbacks::default()));
            let callbacks_for_poller = callbacks.clone();
            let window = Rc::new(WindowProbe::default());
            let (ui, _main) = UiService::with_window_factory(
                region.ptr(),
                MockEndpoint {
                    trace: trace.clone(),
                    controls: endpoint_controls.clone(),
                },
                move |_| callbacks_for_poller.take(),
                Box::new(MockWindowFactory {
                    trace: trace.clone(),
                    probe: window.clone(),
                }),
                Duration::from_secs(10),
            );
            Self {
                region,
                ui,
                endpoint_controls,
                callbacks,
                window,
                trace,
            }
        }

        fn open(&self) -> CommandOutcome {
            self.ui.handle_command(CMD_OPEN_UI, None)
        }

        fn state(&self) -> UiState {
            self.ui.core.borrow().machine.state()
        }
    }

    /// Post one command into the real mailbox and let `service_child_main` dispatch it.
    ///
    /// `arg` matters for `CMD_SAVE_STATE`: without a sidecar path `save_state_command` returns
    /// `BAD_ARG` *without* invoking the capture closure, which would make a capture-count
    /// assertion pass for the wrong reason.
    fn dispatch(fixture: &Fixture, kind: u32, arg: &str) {
        let region = fixture.region.ptr();
        unsafe {
            (*region).cmd_kind.store(kind, Ordering::Release);
            assert!(
                orbit_audio_sandbox::transport::write_cstr_field(&mut (*region).cmd_arg, arg),
                "test argument must fit cmd_arg"
            );
            let seq = (*region).cmd_ack_seq.load(Ordering::Relaxed) + 1;
            (*region).cmd_seq.store(seq, Ordering::Release);
        }
    }

    /// 🔴 Pins **which handler each command kind reaches** in [`crate::service_child_main`].
    ///
    /// The four children share that one body, so a swapped arm breaks all of them at once — and
    /// the swap type-checks, since both arms return `CommandOutcome`. Nothing covered it: routing
    /// `CMD_OPEN_UI`/`CMD_CLOSE_UI` into `save_state_command` instead left the **entire workspace
    /// suite green** (measured 2026-07-31), while the mirror-image swap of `CMD_SAVE_STATE` was
    /// caught by the existing real-process `mailbox_wiring` tests. Only the UI arm was unguarded.
    ///
    /// Asserting the capture count as well as the state matters: checking only the state would let
    /// an implementation that runs *both* handlers pass.
    #[test]
    fn service_child_main_routes_each_command_kind_to_its_own_handler() {
        let fixture = Fixture::new("dispatch");
        let captures = Rc::new(Cell::new(0usize));

        let sidecar = std::env::temp_dir().join(format!(
            "orbit-dispatch-{}-{}.state",
            std::process::id(),
            line!()
        ));
        let run = |kind: u32, arg: &str| {
            dispatch(&fixture, kind, arg);
            let captures = captures.clone();
            unsafe {
                crate::service_child_main(fixture.region.ptr(), &fixture.ui, move || {
                    captures.set(captures.get() + 1);
                    Ok::<Vec<u8>, String>(vec![7])
                })
            }
        };

        // OPEN_UI must reach the state machine, and must not be mistaken for a state capture.
        run(CMD_OPEN_UI, "");
        assert_eq!(
            fixture.state(),
            UiState::Open,
            "CMD_OPEN_UI must open the UI"
        );
        assert_eq!(
            captures.get(),
            0,
            "CMD_OPEN_UI must not capture plugin state"
        );

        // CLOSE_UI likewise — and it is the same match arm, so it needs its own assertion.
        run(CMD_CLOSE_UI, "");
        assert_eq!(
            fixture.state(),
            UiState::Closing,
            "CMD_CLOSE_UI must start the close handshake"
        );
        assert_eq!(
            captures.get(),
            0,
            "CMD_CLOSE_UI must not capture plugin state"
        );

        // SAVE_STATE takes the other arm: it captures, and must not disturb the machine.
        let before = fixture.state();
        run(CMD_SAVE_STATE, sidecar.to_str().expect("utf-8 temp path"));
        assert_eq!(
            captures.get(),
            1,
            "CMD_SAVE_STATE must capture exactly once"
        );
        assert_eq!(
            fixture.state(),
            before,
            "CMD_SAVE_STATE must not drive the UI state machine"
        );

        // An unknown kind must fall through to the mailbox's UNKNOWN_KIND result, not silently
        // pick either handler.
        run(9999, "");
        assert_eq!(captures.get(), 1, "an unknown kind must not capture state");
        let result = unsafe { (*fixture.region.ptr()).cmd_result.load(Ordering::Acquire) };
        assert_eq!(
            result, CMD_RESULT_UNKNOWN_KIND,
            "an unknown kind must be reported as such"
        );

        let _ = std::fs::remove_file(&sidecar);
    }

    #[test]
    fn open_ack_waits_for_attach_and_attach_failure_destroys_the_window() {
        let fixture = Fixture::new("attach-failure");
        fixture.endpoint_controls.attach_error.set(true);

        let outcome = fixture.open();

        assert_eq!(outcome.result, CMD_RESULT_PLUGIN_ERROR);
        assert_eq!(outcome.detail, "attach rejected");
        assert_eq!(fixture.state(), UiState::Closed);
        assert_eq!(
            fixture.trace.borrow().as_slice(),
            [
                "endpoint.begin_open",
                "window.create",
                "endpoint.attach",
                "endpoint.release(false)",
                "window.close",
            ],
            "failure ack may be produced only after attach cleanup completes"
        );
    }

    #[test]
    fn open_applies_mailbox_window_title_before_plugin_attach() {
        let fixture = Fixture::new("window-title");
        let outcome = fixture
            .ui
            .handle_command(CMD_OPEN_UI, Some("Gain Oracle — lead[0]"));

        assert_eq!(outcome.result, CMD_RESULT_OK);
        assert_eq!(
            fixture.window.title.borrow().as_deref(),
            Some("Gain Oracle — lead[0]")
        );
        let trace = fixture.trace.borrow();
        let title = trace
            .iter()
            .position(|call| call == "window.set_title(Gain Oracle — lead[0])")
            .expect("set title call");
        let attach = trace
            .iter()
            .position(|call| call == "endpoint.attach")
            .expect("attach call");
        assert!(
            title < attach,
            "window title must be set before plugin attach"
        );
    }

    #[test]
    fn close_acks_at_acceptance_and_duplicate_close_is_a_successful_no_op() {
        let fixture = Fixture::new("close-ack");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);

        let accepted = fixture.ui.handle_command(CMD_CLOSE_UI, None);

        assert_eq!(accepted.result, CMD_RESULT_OK);
        assert_eq!(accepted.detail, "");
        assert_eq!(fixture.state(), UiState::Closing);
        assert!(
            !fixture
                .trace
                .borrow()
                .iter()
                .any(|call| call == "window.close"),
            "CLOSE_UI must ack before Phase B destroys the window"
        );

        let duplicate = fixture.ui.handle_command(CMD_CLOSE_UI, None);
        assert_eq!(duplicate.result, CMD_RESULT_OK);
        assert_eq!(duplicate.detail, "already-closing");
        assert_eq!(
            unsafe { (*fixture.region.ptr()).evt_seq.load_own() },
            1,
            "duplicate close must not publish a second safepoint"
        );
    }

    #[test]
    fn phase_b_releases_the_plugin_before_closing_the_window() {
        let fixture = Fixture::new("phase-b-order");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);
        assert_eq!(
            fixture.ui.handle_command(CMD_CLOSE_UI, None).result,
            CMD_RESULT_OK
        );
        unsafe { (*fixture.region.ptr()).evt_ack_seq.publish(1) };

        fixture.ui.tick(Duration::from_secs(1));

        assert_eq!(fixture.state(), UiState::Closed);
        let trace = fixture.trace.borrow();
        let release = trace
            .iter()
            .position(|call| call == "endpoint.release(false)")
            .expect("release call");
        let close = trace
            .iter()
            .position(|call| call == "window.close")
            .expect("window close call");
        assert!(release < close);
        assert_eq!(unsafe { (*fixture.region.ptr()).evt_seq.load_own() }, 2);
    }

    #[test]
    fn window_should_close_always_returns_no_and_enters_the_machine() {
        let fixture = Fixture::new("window-close");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);
        let callback = fixture
            .window
            .callback
            .borrow()
            .clone()
            .expect("window callback");

        assert!(!callback());

        assert_eq!(fixture.state(), UiState::Closing);
        assert_eq!(unsafe { (*fixture.region.ptr()).evt_seq.load_own() }, 1);
    }

    #[test]
    fn user_window_resize_reaches_endpoint_and_reentrant_resize_is_deferred() {
        let fixture = Fixture::new("host-resize");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);
        let callback = fixture
            .window
            .resize_callback
            .borrow()
            .clone()
            .expect("window resize callback");
        let first = UiSize {
            width: 700,
            height: 500,
        };
        callback(first);
        assert!(fixture
            .trace
            .borrow()
            .iter()
            .any(|call| call == "endpoint.apply_host_resize(700x500)"));

        let held_by_outer_tick = fixture.ui.core.borrow_mut();
        let deferred = UiSize {
            width: 701,
            height: 501,
        };
        callback(deferred);
        assert_eq!(fixture.ui.pending_host_resize.get(), Some(deferred));
        drop(held_by_outer_tick);

        fixture.ui.tick(Duration::from_secs(1));
        assert_eq!(fixture.ui.pending_host_resize.get(), None);
        assert!(fixture
            .trace
            .borrow()
            .iter()
            .any(|call| call == "endpoint.apply_host_resize(701x501)"));
    }

    #[test]
    fn reentrant_window_should_close_returns_no_and_is_deferred_without_borrow_panic() {
        let fixture = Fixture::new("reentrant-window-close");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);
        assert_eq!(
            fixture.ui.handle_command(CMD_CLOSE_UI, None).result,
            CMD_RESULT_OK
        );
        unsafe { (*fixture.region.ptr()).evt_ack_seq.publish(1) };
        fixture.window.invoke_callback_on_close.set(true);

        fixture.ui.tick(Duration::from_secs(1));

        assert_eq!(fixture.window.close_callback_result.get(), Some(false));
        assert!(
            fixture.ui.pending_window_close.get(),
            "busy delegate entry must be retained for the next non-reentrant tick"
        );
        fixture.ui.tick(Duration::from_secs(2));
        assert!(!fixture.ui.pending_window_close.get());
    }

    #[test]
    fn callback_tick_marshals_plugin_close_and_resize_to_the_main_machine() {
        let fixture = Fixture::new("callbacks");
        assert_eq!(fixture.open().result, CMD_RESULT_OK);
        let requested = UiSize {
            width: 720,
            height: 512,
        };
        fixture.callbacks.set(UiCallbacks {
            closed: Some(true),
            requested_size: Some(requested),
        });

        fixture.ui.tick(Duration::from_secs(1));

        assert_eq!(fixture.state(), UiState::Closing);
        assert_eq!(fixture.window.last_size.get(), Some(requested));
        assert!(fixture
            .trace
            .borrow()
            .iter()
            .any(|call| call == "window.resize(720x512)"));
        assert_eq!(unsafe { (*fixture.region.ptr()).evt_seq.load_own() }, 1);
    }

    /// #628 C15: indexed rack services share one event publisher while retaining independent
    /// windows/state machines. This is the behavioral index -> window registry contract.
    #[test]
    fn c15_indexed_services_keep_multiple_windows_open_and_publish_the_index() {
        let region = TestRegion::new("indexed-multiple");
        let event_hub = UiEventHub::new(region.ptr());
        let make = |index: u32| {
            let trace = Rc::new(RefCell::new(Vec::new()));
            let window = Rc::new(WindowProbe::default());
            let (ui, _main) = UiService::with_window_factory_and_events(
                region.ptr(),
                event_hub.clone(),
                Some(index),
                MockEndpoint {
                    trace: trace.clone(),
                    controls: Rc::new(EndpointControls::default()),
                },
                |_| UiCallbacks::default(),
                Box::new(MockWindowFactory {
                    trace: trace.clone(),
                    probe: window.clone(),
                }),
                Duration::from_secs(10),
            );
            (ui, trace, window)
        };
        let (ui0, trace0, _window0) = make(0);
        let (ui2, trace2, _window2) = make(2);

        assert_eq!(
            ui0.handle_command(CMD_OPEN_UI, Some("zero")).result,
            CMD_RESULT_OK
        );
        assert_eq!(
            ui2.handle_command(CMD_OPEN_UI, Some("two")).result,
            CMD_RESULT_OK
        );
        assert_eq!(
            ui0.handle_command(CMD_OPEN_UI, Some("zero again")).result,
            CMD_RESULT_OK,
            "an indexed re-open is an idempotent no-op"
        );
        assert!(trace0.borrow().iter().any(|call| call == "window.create"));
        assert!(trace2.borrow().iter().any(|call| call == "window.create"));
        assert!(!trace0.borrow().iter().any(|call| call == "window.close"));
        assert!(!trace2.borrow().iter().any(|call| call == "window.close"));

        assert_eq!(ui2.handle_command(CMD_CLOSE_UI, None).result, CMD_RESULT_OK);
        let event_index = orbit_audio_sandbox::transport::evt_slot_index(1);
        let arg = unsafe {
            orbit_audio_sandbox::transport::read_cstr_field(&(*region.ptr()).evt_arg[event_index])
        };
        assert_eq!(arg, Some(r#"{"index":2}"#));
    }
}
