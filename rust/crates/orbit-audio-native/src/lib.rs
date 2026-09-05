//! orbit-audio-native
//!
//! Signal compose audio engine のデスクトップネイティブバックエンド。
//! cpal 経由の音声出力、symphonia による音声ファイルデコード、
//! rubato によるロード時サンプリング周波数変換を提供する。
//!
//! platform-agnostic なコアは [`orbit_audio_core`] を参照。

mod capture;
mod link_audio_ring;
mod loader;
mod output;
mod post_processor;
mod resampler;

pub use link_audio_ring::{PostMixSink, RingTapSink};
pub use loader::{load_sample_from_file, load_sample_resampled, LoaderError};
pub use output::{
    list_output_devices, rebuild_output_stream, resolve_requested_device_name,
    select_live_output_device, start_default_output, start_default_output_with_clap,
    start_default_output_with_device, start_default_output_with_insert_buses,
    start_default_output_with_insert_buses_and_post,
    start_default_output_with_insert_buses_sources_and_post, start_default_output_with_link_egress,
    start_default_output_with_sources, AudioDeviceInfo, BlockSource, BlockTransport, BusSend,
    BusTarget, DeviceFallback, InsertBusStage, LinkChannelActivate, LiveOutputDevice,
    OutputDeviceRequest, OutputError, OutputFault, OutputStream, RenderState, SourceDest,
    SourceDestCell, SourceSlot, StreamLivenessPhase, StreamStats, StreamStatsSnapshot,
    FIRST_CALLBACK_DEADLINE, MAX_INSERT_BUS_STAGES, MAX_LINK_CHANNELS, MAX_SOURCE_SLOTS,
    MAX_SOURCE_UNITS,
};
pub use post_processor::{CallbackTimeSnapshot, CallbackTimeStats, PostProcessor};
pub use resampler::ResampleError;
