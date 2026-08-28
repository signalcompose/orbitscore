use clack_extensions::gui::PluginGui;
use clack_extensions::params::{ParamInfoBuffer, PluginParams};
use clack_host::prelude::PluginInstance;
use orbit_child_ui::UiSize;

use crate::controller::ClapHostError;
use crate::host::{OrbitClapHost, OrbitHostShared};

/// Main（home）スレッド側を CLAP effect / instrument で共有する。
///
/// `!Send`（[`PluginInstance`] を含む）。state 操作（`[main-thread]` 契約）を担い、
/// audio 側が先に drop された後、唯一の Arc 所有者として実 teardown を home スレッドで
/// 走らせる。
pub struct ClapPluginMain {
    pub(crate) instance: PluginInstance<OrbitClapHost>,
    pub(crate) plugin_gui: Option<PluginGui>,
    pub(crate) gui_attached: bool,
    pub(crate) gui_can_resize: bool,
}

impl ClapPluginMain {
    /// ホストしているプラグインの state を吸い上げる（契約は [`crate::state::capture_state`]）。
    pub fn capture_state(&mut self) -> Result<Vec<u8>, ClapHostError> {
        crate::state::capture_state(&mut self.instance)
    }

    /// 保存済み state を適用する（契約は [`crate::state::apply_state_bytes`]）。
    pub fn apply_state_bytes(&mut self, bytes: &[u8]) -> Result<(), ClapHostError> {
        crate::state::apply_state_bytes(&mut self.instance, bytes)
    }

    /// Resolve a CLAP parameter by its public UTF-8 name on the plugin home thread.
    pub fn parameter_id_by_name(&mut self, name: &str) -> Option<u32> {
        let mut plugin = self.instance.plugin_handle();
        let params = plugin.get_extension::<PluginParams>()?;
        let mut buffer = ParamInfoBuffer::new();
        (0..params.count(&mut plugin)).find_map(|index| {
            let info = params.get_info(&mut plugin, index, &mut buffer)?;
            (info.name == name.as_bytes()).then_some(info.id.get())
        })
    }

    /// Consume the most recent thread-safe CLAP `closed(was_destroyed)` callback.
    pub fn take_closed(&self) -> Option<bool> {
        self.instance
            .access_shared_handler(OrbitHostShared::take_closed)
    }

    /// Consume the most recent thread-safe CLAP `request_resize` callback.
    pub fn take_requested_size(&self) -> Option<UiSize> {
        self.instance
            .access_shared_handler(OrbitHostShared::take_requested_size)
    }
}
