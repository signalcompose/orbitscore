//! orbitscore-engine
//!
//! Rust 実装の OrbitScore オーディオエンジン（PoC）。
//!
//! モジュール構成:
//! - [`core`]: プラットフォーム非依存の DSP / スケジューラ
//! - [`native`]: cpal 経由のデスクトップ音声 I/O（feature = "native"）
//! - [`wasm`]: wasm-bindgen + AudioWorklet（feature = "wasm"、予約）

pub mod core;

#[cfg(feature = "native")]
pub mod native;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use core::{Engine, EngineError, Sample, ScheduledSample};
