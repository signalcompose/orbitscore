//! Native module: cpal を介したデスクトップ音声 I/O と symphonia 経由の
//! ファイルデコード。
//!
//! この層は `cfg(feature = "native")` でのみ有効。WASM ビルドでは含まれない。

mod loader;
mod output;

pub use loader::{load_sample_from_file, LoaderError};
pub use output::{start_default_output, OutputError, OutputStream};
