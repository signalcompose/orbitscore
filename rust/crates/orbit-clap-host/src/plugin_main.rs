use clack_host::prelude::PluginInstance;

use crate::controller::ClapHostError;
use crate::host::OrbitClapHost;

/// Main（home）スレッド側を CLAP effect / instrument で共有する。
///
/// `!Send`（[`PluginInstance`] を含む）。state 操作（`[main-thread]` 契約）を担い、
/// audio 側が先に drop された後、唯一の Arc 所有者として実 teardown を home スレッドで
/// 走らせる。
pub struct ClapPluginMain {
    pub(crate) instance: PluginInstance<OrbitClapHost>,
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
}
