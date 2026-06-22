//! orbit-audio-native
//!
//! Signal compose audio engine のデスクトップネイティブバックエンド。
//! cpal 経由の音声出力、symphonia による音声ファイルデコード、
//! rubato によるロード時サンプリング周波数変換を提供する。
//!
//! platform-agnostic なコアは [`orbit_audio_core`] を参照。

mod link_audio_ring;
mod loader;
mod output;
mod resampler;

pub use link_audio_ring::{PostMixSink, RingTapSink};
pub use loader::{load_sample_from_file, load_sample_resampled, LoaderError};
pub use output::{start_default_output, OutputError, OutputStream, StreamStats, StreamStatsSnapshot};
pub use resampler::ResampleError;
