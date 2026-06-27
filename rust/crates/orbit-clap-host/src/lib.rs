//! `orbit-clap-host` — OrbitScore daemon 向け in-process CLAP plugin hosting library。
//!
//! `orbit-clap-spike` で実証済みの CLAP hosting を production library crate に移植。
//! daemon が [`ClapHost`] を専用スレッド上で保持し、[`PostProcessor`] seam 経由で
//! cpal callback に統合する（Issue #340・A0 §4.1）。
//!
//! ## 使い方
//!
//! 1. [`new_clap_host`] を呼ぶ → `(Box<dyn PostProcessor>, ClapHostParts)` を取得。
//! 2. `Box<dyn PostProcessor>` を native stream に渡す。
//! 3. `ClapHostParts` の情報を使って専用スレッドで [`ClapHost`] を構築する。
//! 4. [`ClapHost::load_plugin`] でプラグインをロードし、`InstallMsg` を install ring に push する。
//! 5. [`ClapHost::pump`] を定期的に呼ぶ（CLAP main-thread callback 処理）。

mod buffers;
mod config;
mod controller;
mod discovery;
mod effect;
mod events;
mod host;
mod processor;

pub use controller::{ClapHost, ClapHostError, LoadedPluginInfo};
pub use discovery::DiscoveryError;
pub use effect::ClapEffectProcessor;
pub use events::{make_event_ring, PluginEvent, PluginEventConsumer, PluginEventProducer};
pub use orbit_audio_native::PostProcessor;
pub use processor::{ClapPostProcessor, ClapProcessorStats, InstallMsg};

use processor::InstallConsumer;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

/// `new_clap_host` が返す制御側の部品。daemon が plugin の load / install と
/// note event 送信に使う。
pub struct ClapHostParts {
    /// install ring の producer 側（制御スレッドが `InstallMsg` を push する）。
    pub install_tx: rtrb::Producer<InstallMsg>,
    /// CLAP processor 統計（daemon が読む）。
    pub stats: Arc<ClapProcessorStats>,
    /// 制御スレッド → plugin への note event producer（daemon が push する）。
    pub event_producer: PluginEventProducer,
    /// hot-install 用の callback_requested フラグ（`ClapHost::new` に clone して渡す）。
    pub callback_requested: Arc<AtomicBool>,
    /// バッファリサイズカウンタ（`ClapHost::new` に clone して渡す・daemon がモニタリングに使う）。
    pub resize_count: Arc<AtomicU64>,
    /// carry-forward #1: teardown 要求フラグ（daemon → audio thread）。daemon は stream を drop する
    /// **前に** これを立て、`teardown_done` が立つまで待つ（audio thread で stop_processing を済ませる）。
    pub teardown_requested: Arc<AtomicBool>,
    /// carry-forward #1: teardown 完了フラグ（audio thread → daemon）。callback が stop_processing を
    /// 終えると立つ。daemon はこれを待ってから stream を drop する。
    pub teardown_done: Arc<AtomicBool>,
}

/// audio thread に渡す `Box<dyn PostProcessor>` と制御側部品を一括生成する。
///
/// # Arguments
/// * `event_ring_capacity` — note event ring のスロット数（通常 1024）。
/// * `install_ring_capacity` — hot-install ring のスロット数（通常 1）。
///
/// # Returns
/// `(processor, parts)` — processor は native stream に渡し、parts は制御スレッドが使う。
pub fn new_clap_host(
    event_ring_capacity: usize,
    install_ring_capacity: usize,
) -> (Box<dyn PostProcessor>, ClapHostParts) {
    let (event_producer, event_consumer) = make_event_ring(event_ring_capacity);
    let (install_tx, install_rx): (rtrb::Producer<InstallMsg>, InstallConsumer) =
        rtrb::RingBuffer::new(install_ring_capacity);
    let stats = ClapProcessorStats::new();
    let callback_requested = Arc::new(AtomicBool::new(false));
    let resize_count = Arc::new(AtomicU64::new(0));
    let teardown_requested = Arc::new(AtomicBool::new(false));
    let teardown_done = Arc::new(AtomicBool::new(false));

    let processor = ClapPostProcessor::new(
        event_consumer,
        install_rx,
        stats.clone(),
        event_ring_capacity,
        teardown_requested.clone(),
        teardown_done.clone(),
    );

    let parts = ClapHostParts {
        install_tx,
        stats,
        event_producer,
        callback_requested,
        resize_count,
        teardown_requested,
        teardown_done,
    };

    (Box::new(processor), parts)
}
