//! CLAP Cocoa editor endpoint. This module intentionally has no AppKit surface.

use std::ffi::c_void;
use std::ptr::NonNull;

use clack_extensions::gui::{
    GuiApiType, GuiConfiguration, GuiSize, PluginGui, Window as ClapWindow,
};
use orbit_child_ui::{PluginUiEndpoint, UiSize};

use crate::ClapPluginMain;

const COCOA_EMBEDDED: GuiConfiguration<'static> = GuiConfiguration {
    api_type: GuiApiType::COCOA,
    is_floating: false,
};

impl PluginUiEndpoint for ClapPluginMain {
    fn begin_open(&mut self) -> Result<UiSize, String> {
        if self.plugin_gui.is_some() {
            return Err("CLAP UI open failed: editor GUI is already open".into());
        }

        let mut plugin = self.instance.plugin_handle();
        let gui = plugin
            .get_extension::<PluginGui>()
            .ok_or_else(|| "CLAP UI open failed: plugin has no CLAP GUI extension".to_owned())?;

        if !gui.is_api_supported(&mut plugin, COCOA_EMBEDDED) {
            return Err(
                "CLAP UI open failed: embedded cocoa GUI is unsupported; floating fallback is forbidden"
                    .into(),
            );
        }

        gui.create(&mut plugin, COCOA_EMBEDDED)
            .map_err(|error| format!("CLAP UI open failed: create(cocoa, false): {error}"))?;

        // Cocoa reports logical sizes. CLAP explicitly forbids set_scale for this API.
        let can_resize = gui.can_resize(&mut plugin);
        let size = match gui.get_size(&mut plugin) {
            Some(size) => size,
            None => {
                gui.destroy(&mut plugin);
                return Err("CLAP UI open failed: get_size returned no valid size".into());
            }
        };
        let size = match ui_size(size) {
            Ok(size) => size,
            Err(detail) => {
                gui.destroy(&mut plugin);
                return Err(format!("CLAP UI open failed: {detail}"));
            }
        };

        self.plugin_gui = Some(gui);
        self.gui_attached = false;
        self.gui_can_resize = can_resize;
        Ok(size)
    }

    fn attach(&mut self, parent: *mut c_void) -> Result<(), String> {
        let parent = NonNull::new(parent)
            .ok_or_else(|| "CLAP UI attach failed: NSView parent is null".to_owned())?;
        if self.gui_attached {
            return Err("CLAP UI attach failed: editor GUI is already attached".into());
        }
        let gui = self
            .plugin_gui
            .ok_or_else(|| "CLAP UI attach failed: editor GUI is not open".to_owned())?;
        let mut plugin = self.instance.plugin_handle();

        // SAFETY: The caller owns `parent` and must keep it alive until `release`.
        unsafe { gui.set_parent(&mut plugin, ClapWindow::from_cocoa_nsview(parent.as_ptr())) }
            .map_err(|error| format!("CLAP UI attach failed: set_parent: {error}"))?;
        self.gui_attached = true;
        gui.show(&mut plugin)
            .map_err(|error| format!("CLAP UI attach failed: show: {error}"))
    }

    fn release(&mut self, was_destroyed: bool) {
        let Some(gui) = self.plugin_gui.take() else {
            self.gui_attached = false;
            self.gui_can_resize = false;
            return;
        };
        let mut plugin = self.instance.plugin_handle();
        if !was_destroyed {
            let _ = gui.hide(&mut plugin);
        }
        gui.destroy(&mut plugin);
        self.gui_attached = false;
        self.gui_can_resize = false;
    }

    fn can_resize(&self) -> bool {
        self.gui_can_resize
    }

    fn apply_host_resize(&mut self, size: UiSize) -> Result<(), String> {
        let size = gui_size(size)?;
        let gui = self
            .plugin_gui
            .ok_or_else(|| "CLAP UI resize failed: editor GUI is not open".to_owned())?;
        let mut plugin = self.instance.plugin_handle();
        gui.set_size(&mut plugin, size)
            .map_err(|error| format!("CLAP UI resize failed: set_size: {error}"))
    }
}

impl Drop for ClapPluginMain {
    fn drop(&mut self) {
        self.release(false);
    }
}

fn ui_size(size: GuiSize) -> Result<UiSize, String> {
    let width = i32::try_from(size.width)
        .map_err(|_| format!("editor width {} exceeds i32", size.width))?;
    let height = i32::try_from(size.height)
        .map_err(|_| format!("editor height {} exceeds i32", size.height))?;
    Ok(UiSize { width, height })
}

fn gui_size(size: UiSize) -> Result<GuiSize, String> {
    if size.width <= 0 || size.height <= 0 {
        return Err(format!(
            "CLAP UI resize failed: invalid size {}x{}",
            size.width, size.height
        ));
    }
    Ok(GuiSize {
        width: size.width as u32,
        height: size.height as u32,
    })
}
