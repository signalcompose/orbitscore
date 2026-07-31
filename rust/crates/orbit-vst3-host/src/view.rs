//! VST3 editor-view endpoint. This module intentionally has no AppKit surface.

use std::cell::Cell;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::rc::Rc;

use orbit_child_ui::{PluginUiEndpoint, UiSize};
use vst3::Steinberg::Vst::{IEditController, IEditControllerTrait, ViewType};
use vst3::Steinberg::{
    kInvalidArgument, kPlatformTypeNSView, tresult, IPlugFrame, IPlugFrameTrait, IPlugView,
    IPlugViewTrait, ViewRect,
};
use vst3::{Class, ComPtr, ComRef, ComWrapper};

use crate::Vst3PluginMain;

#[derive(Default)]
struct PlugFrameState {
    requested_size: Cell<Option<UiSize>>,
}

struct HostPlugFrame {
    state: Rc<PlugFrameState>,
}

impl Class for HostPlugFrame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for HostPlugFrame {
    unsafe fn resizeView(&self, view: *mut IPlugView, new_size: *mut ViewRect) -> tresult {
        let Some(view) = ComRef::from_raw(view) else {
            return kInvalidArgument;
        };
        if new_size.is_null() {
            return kInvalidArgument;
        }
        let Ok(size) = ui_size(*new_size) else {
            return kInvalidArgument;
        };

        // UIH.4b: record the host-side resize and call onSize before returning to the plugin.
        self.state.requested_size.set(Some(size));
        view.onSize(new_size)
    }
}

/// VST3 implementation of the format-independent plugin UI endpoint.
///
/// It owns an extra controller reference so the editor can never outlive the controller object.
/// [`Vst3PluginMain`] additionally releases this endpoint at the very start of its `Drop`, before
/// it calls `IEditController::terminate`.
pub struct Vst3UiEndpoint {
    controller: Option<ComPtr<IEditController>>,
    view: Option<ComPtr<IPlugView>>,
    frame: Option<ComWrapper<HostPlugFrame>>,
    frame_state: Rc<PlugFrameState>,
    attached: bool,
    can_resize: bool,
    _home_thread: PhantomData<Rc<()>>,
}

impl Vst3UiEndpoint {
    pub(crate) fn new(controller: Option<ComPtr<IEditController>>) -> Self {
        Self {
            controller,
            view: None,
            frame: None,
            frame_state: Rc::new(PlugFrameState::default()),
            attached: false,
            can_resize: false,
            _home_thread: PhantomData,
        }
    }

    /// Construct an endpoint around an initialized edit controller.
    ///
    /// This is useful when a host already owns the controller independently of
    /// [`Vst3PluginMain`], including COM-level integration tests.
    pub fn from_controller(controller: ComPtr<IEditController>) -> Self {
        Self::new(Some(controller))
    }

    /// Most recent plugin-originated `IPlugFrame::resizeView` request.
    pub fn requested_size(&self) -> Option<UiSize> {
        self.frame_state.requested_size.get()
    }

    /// Take the most recent plugin-originated resize request.
    pub fn take_requested_size(&self) -> Option<UiSize> {
        self.frame_state.requested_size.take()
    }

    pub(crate) fn release_view(&mut self) {
        if self.attached {
            if let Some(view) = self.view.as_ref() {
                unsafe {
                    let _ = view.removed();
                }
            }
        }
        self.attached = false;
        self.can_resize = false;

        // Keep this explicit: the view must be released before the frame and controller.
        let _ = self.view.take();
        let _ = self.frame.take();
        self.frame_state.requested_size.set(None);
    }

    pub(crate) fn release_controller(&mut self) {
        debug_assert!(self.view.is_none());
        let _ = self.controller.take();
    }

    fn view(&self, operation: &str) -> Result<&ComPtr<IPlugView>, String> {
        self.view
            .as_ref()
            .ok_or_else(|| format!("VST3 UI {operation} failed: editor view is not open"))
    }
}

impl PluginUiEndpoint for Vst3UiEndpoint {
    fn begin_open(&mut self) -> Result<UiSize, String> {
        if self.view.is_some() {
            return Err("VST3 UI open failed: editor view is already open".into());
        }
        let controller = self
            .controller
            .as_ref()
            .ok_or_else(|| "VST3 UI open failed: edit controller is unavailable".to_owned())?;

        // UIH.4 fixes this exact order. In particular, setFrame must precede attached because
        // the plugin may synchronously call resizeView from inside attached.
        let raw_view = unsafe { controller.createView(ViewType::kEditor) };
        let view = unsafe { ComPtr::from_raw(raw_view) }.ok_or_else(|| {
            "VST3 UI open failed: IEditController::createView(\"editor\") returned null".to_owned()
        })?;

        let platform_result = unsafe { view.isPlatformTypeSupported(kPlatformTypeNSView) };
        if !is_ok(platform_result) {
            return Err(format!(
                "VST3 UI open failed: NSView is unsupported ({platform_result})"
            ));
        }

        let frame = ComWrapper::new(HostPlugFrame {
            state: Rc::clone(&self.frame_state),
        });
        let frame_ptr = frame
            .as_com_ref::<IPlugFrame>()
            .expect("HostPlugFrame exposes IPlugFrame")
            .as_ptr();
        let set_frame_result = unsafe { view.setFrame(frame_ptr) };
        if !is_ok(set_frame_result) {
            // The plugin may have retained the frame even when returning an error.
            drop(view);
            drop(frame);
            return Err(format!(
                "VST3 UI open failed: IPlugView::setFrame failed ({set_frame_result})"
            ));
        }

        let can_resize = is_ok(unsafe { view.canResize() });
        let mut rect = ViewRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let get_size_result = unsafe { view.getSize(&mut rect) };
        if !is_ok(get_size_result) {
            drop(view);
            drop(frame);
            return Err(format!(
                "VST3 UI open failed: IPlugView::getSize failed ({get_size_result})"
            ));
        }
        let size = match ui_size(rect) {
            Ok(size) => size,
            Err(detail) => {
                drop(view);
                drop(frame);
                return Err(format!("VST3 UI open failed: {detail}"));
            }
        };

        self.frame_state.requested_size.set(None);
        self.frame = Some(frame);
        self.view = Some(view);
        self.can_resize = can_resize;
        Ok(size)
    }

    fn attach(&mut self, parent: *mut c_void) -> Result<(), String> {
        let parent = NonNull::new(parent)
            .ok_or_else(|| "VST3 UI attach failed: NSView parent is null".to_owned())?;
        if self.attached {
            return Err("VST3 UI attach failed: editor view is already attached".into());
        }
        let view = self.view("attach")?;
        let result = unsafe { view.attached(parent.as_ptr(), kPlatformTypeNSView) };
        if !is_ok(result) {
            return Err(format!(
                "VST3 UI attach failed: IPlugView::attached failed ({result})"
            ));
        }
        self.attached = true;
        Ok(())
    }

    fn release(&mut self, _was_destroyed: bool) {
        self.release_view();
    }

    fn can_resize(&self) -> bool {
        self.can_resize
    }

    fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String> {
        if size.width <= 0 || size.height <= 0 {
            return Err(format!(
                "VST3 UI resize failed: invalid size {}x{}",
                size.width, size.height
            ));
        }
        let view = self.view("resize")?;
        let mut rect = ViewRect {
            left: 0,
            top: 0,
            right: size.width,
            bottom: size.height,
        };
        let result = unsafe { view.onSize(&mut rect) };
        if !is_ok(result) {
            return Err(format!(
                "VST3 UI resize failed: IPlugView::onSize failed ({result})"
            ));
        }
        Ok(())
    }
}

impl Drop for Vst3UiEndpoint {
    fn drop(&mut self) {
        self.release_view();
        self.release_controller();
    }
}

impl PluginUiEndpoint for Vst3PluginMain {
    fn begin_open(&mut self) -> Result<UiSize, String> {
        self.ui_endpoint.begin_open()
    }

    fn attach(&mut self, parent: *mut c_void) -> Result<(), String> {
        self.ui_endpoint.attach(parent)
    }

    fn release(&mut self, was_destroyed: bool) {
        self.ui_endpoint.release(was_destroyed);
    }

    fn can_resize(&self) -> bool {
        self.ui_endpoint.can_resize()
    }

    fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String> {
        self.ui_endpoint.apply_host_resize(size)
    }
}

impl Vst3PluginMain {
    /// Consume the most recent plugin-originated `IPlugFrame::resizeView` request.
    pub fn take_requested_size(&self) -> Option<UiSize> {
        self.ui_endpoint.take_requested_size()
    }
}

fn ui_size(rect: ViewRect) -> Result<UiSize, String> {
    let width = rect
        .right
        .checked_sub(rect.left)
        .ok_or_else(|| "editor width overflowed".to_owned())?;
    let height = rect
        .bottom
        .checked_sub(rect.top)
        .ok_or_else(|| "editor height overflowed".to_owned())?;
    if width <= 0 || height <= 0 {
        return Err(format!("editor returned invalid size {width}x{height}"));
    }
    Ok(UiSize { width, height })
}

fn is_ok(result: tresult) -> bool {
    crate::is_ok(result)
}
