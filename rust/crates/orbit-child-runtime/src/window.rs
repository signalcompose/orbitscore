//! AppKit-owned plugin editor window shell.

use std::cell::Cell;
use std::ffi::c_void;
use std::rc::Rc;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowDelegate, NSWindowStyleMask};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use orbit_child_ui::UiSize;

use crate::ui_service::{WindowCloseCallback, WindowFactory, WindowHandle, WindowResizeCallback};

struct WindowDelegateIvars {
    close_callback: WindowCloseCallback,
    resize_callback: WindowResizeCallback,
    programmatic_resize: Rc<Cell<bool>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The delegate is main-thread-only
    // and owns only a Rust callback with a 'static lifetime.
    #[unsafe(super = NSObject)]
    #[name = "OrbitChildRuntimeWindowDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = WindowDelegateIvars]
    struct WindowDelegate;

    // SAFETY: NSObjectProtocol adds no extra invariants.
    unsafe impl NSObjectProtocol for WindowDelegate {}

    // SAFETY: The implementation is main-thread confined and uses the generated signature.
    unsafe impl NSWindowDelegate for WindowDelegate {
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, _sender: &NSWindow) -> bool {
            // The callback enters (or defers entry into) the close state machine. AppKit
            // never owns destruction: every callback path returns NO, and Phase B later
            // calls NSWindow::close directly.
            (self.ivars().close_callback)()
        }

        #[unsafe(method(windowWillResize:toSize:))]
        fn window_will_resize(&self, sender: &NSWindow, frame_size: NSSize) -> NSSize {
            if !self.ivars().programmatic_resize.get() {
                let frame = NSRect::new(NSPoint::ZERO, frame_size);
                let content = sender.contentRectForFrameRect(frame).size;
                if let (Some(width), Some(height)) = (
                    logical_dimension(content.width),
                    logical_dimension(content.height),
                ) {
                    (self.ivars().resize_callback)(UiSize { width, height });
                }
            }
            frame_size
        }
    }
);

impl WindowDelegate {
    fn new(
        mtm: MainThreadMarker,
        close_callback: WindowCloseCallback,
        resize_callback: WindowResizeCallback,
        programmatic_resize: Rc<Cell<bool>>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WindowDelegateIvars {
            close_callback,
            resize_callback,
            programmatic_resize,
        });
        // SAFETY: NSObject's designated initializer has the generated signature.
        unsafe { msg_send![super(this), init] }
    }
}

/// Host-owned AppKit window containing a plugin editor NSView.
pub struct WindowShell {
    window: Option<Retained<NSWindow>>,
    delegate: Option<Retained<WindowDelegate>>,
    programmatic_resize: Rc<Cell<bool>>,
    window_number: u32,
}

impl WindowShell {
    pub fn new(
        size: UiSize,
        can_resize: bool,
        close_callback: impl Fn() -> bool + 'static,
    ) -> Result<Self, String> {
        Self::new_with_callbacks(size, can_resize, Rc::new(close_callback), Rc::new(|_| {}))
    }

    fn new_with_callbacks(
        size: UiSize,
        can_resize: bool,
        close_callback: WindowCloseCallback,
        resize_callback: WindowResizeCallback,
    ) -> Result<Self, String> {
        if size.width <= 0 || size.height <= 0 {
            return Err(format!(
                "plugin UI window creation failed: invalid size {}x{}",
                size.width, size.height
            ));
        }
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "plugin UI window creation must run on the main thread".to_owned())?;
        let mut style = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable;
        if can_resize {
            style |= NSWindowStyleMask::Resizable;
        }
        let content_rect = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(size.width as f64, size.height as f64),
        );
        // SAFETY: releasedWhenClosed is disabled immediately below, so the Retained owner
        // remains authoritative until this shell calls close and drops it.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                content_rect,
                style,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        let programmatic_resize = Rc::new(Cell::new(false));
        let delegate = WindowDelegate::new(
            mtm,
            close_callback,
            resize_callback,
            programmatic_resize.clone(),
        );
        window.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        window.center();
        window.makeKeyAndOrderFront(None);
        let window_number = u32::try_from(window.windowNumber())
            .map_err(|_| "plugin UI window number does not fit u32".to_owned())?;

        Ok(Self {
            window: Some(window),
            delegate: Some(delegate),
            programmatic_resize,
            window_number,
        })
    }

    /// Opaque NSView pointer passed to the format-specific endpoint.
    pub fn content_view(&self) -> *mut c_void {
        self.window
            .as_ref()
            .and_then(|window| window.contentView())
            .map_or(std::ptr::null_mut(), |view| {
                Retained::as_ptr(&view).cast_mut().cast()
            })
    }

    /// Apply the daemon-rendered receiver/index title to the host window.
    pub fn set_title(&mut self, title: &str) -> Result<(), String> {
        let window = self
            .window
            .as_ref()
            .ok_or_else(|| "plugin UI window title failed: window is closed".to_owned())?;
        window.setTitle(&NSString::from_str(title));
        Ok(())
    }

    /// Apply a plugin-requested logical content size to the host window.
    pub fn resize(&mut self, size: UiSize) -> Result<(), String> {
        if size.width <= 0 || size.height <= 0 {
            return Err(format!(
                "plugin UI window resize failed: invalid size {}x{}",
                size.width, size.height
            ));
        }
        let window = self
            .window
            .as_ref()
            .ok_or_else(|| "plugin UI window resize failed: window is closed".to_owned())?;
        self.programmatic_resize.set(true);
        window.setContentSize(NSSize::new(size.width as f64, size.height as f64));
        self.programmatic_resize.set(false);
        Ok(())
    }

    /// Close without consulting `windowShouldClose`; Phase B already authorized destruction.
    pub fn close(&mut self) {
        let Some(window) = self.window.take() else {
            return;
        };
        window.setDelegate(None);
        window.close();
        self.delegate = None;
    }

    /// CoreGraphics window number used only for independent gated verification.
    #[doc(hidden)]
    pub fn window_number(&self) -> u32 {
        self.window_number
    }
}

impl Drop for WindowShell {
    fn drop(&mut self) {
        self.close();
    }
}

impl WindowHandle for WindowShell {
    fn content_view(&self) -> *mut c_void {
        self.content_view()
    }

    fn set_title(&mut self, title: &str) -> Result<(), String> {
        self.set_title(title)
    }

    fn resize(&mut self, size: UiSize) -> Result<(), String> {
        self.resize(size)
    }

    fn close(&mut self) {
        self.close();
    }
}

pub(crate) struct AppKitWindowFactory;

impl WindowFactory for AppKitWindowFactory {
    fn create(
        &mut self,
        size: UiSize,
        can_resize: bool,
        close_callback: WindowCloseCallback,
        resize_callback: WindowResizeCallback,
    ) -> Result<Box<dyn WindowHandle>, String> {
        WindowShell::new_with_callbacks(size, can_resize, close_callback, resize_callback)
            .map(|window| Box::new(window) as Box<dyn WindowHandle>)
    }
}

fn logical_dimension(value: f64) -> Option<i32> {
    (value.is_finite() && value > 0.0 && value <= i32::MAX as f64).then(|| value.round() as i32)
}
