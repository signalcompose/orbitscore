//! Native module: cpal を介したデスクトップ音声 I/O と symphonia 経由の
//! ファイルデコード。
//!
//! この層は `cfg(feature = "native")` でのみ有効。WASM ビルドでは含まれない。

mod loader;
mod output;
mod resampler;

pub use loader::{load_sample_at, load_sample_from_file, LoaderError};
pub use output::{start_default_output, OutputError, OutputStream};
pub use resampler::{resample_to, ResampleError};
