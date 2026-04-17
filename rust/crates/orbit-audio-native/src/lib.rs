//! orbit-audio-native
//!
//! Signal compose audio engine のデスクトップネイティブバックエンド。
//! cpal 経由の音声出力、symphonia による音声ファイルデコード、
//! rubato によるロード時サンプリング周波数変換を提供する。
//!
//! platform-agnostic なコアは [`orbit_audio_core`] を参照。

mod loader;
mod output;
mod resampler;

pub use loader::{load_sample_from_file, load_sample_resampled, LoaderError};
pub use output::{start_default_output, OutputError, OutputStream};
pub use resampler::ResampleError;
