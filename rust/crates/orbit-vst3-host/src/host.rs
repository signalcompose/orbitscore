//! VST3 ホストの実装を主題ごとに分けたモジュール群（#888 子 3）。

mod effect;
mod events;
mod instrument;
mod interfaces;
mod probe;
mod setup;

#[allow(unused_imports)]
pub(crate) use effect::*;
#[allow(unused_imports)]
pub(crate) use events::*;
#[allow(unused_imports)]
pub(crate) use instrument::*;
#[allow(unused_imports)]
pub(crate) use interfaces::*;
#[allow(unused_imports)]
pub(crate) use probe::*;
#[allow(unused_imports)]
pub(crate) use setup::*;

pub use effect::{Vst3EffectProcessor, Vst3InstrumentAudio, Vst3InstrumentProcessor};
pub use probe::probe_factory_descriptors;
pub use probe::{probe_plugin, ProbeResult};
