//! orbitscore-engine
//!
//! Rust 実装の OrbitScore オーディオエンジン（PoC）。
//!
//! モジュール構成:
//! - [`core`]: プラットフォーム非依存の DSP / スケジューラ
//! - [`native`]: cpal 経由のデスクトップ音声 I/O（feature = "native"）
//! - [`wasm`]: wasm-bindgen + AudioWorklet（feature = "wasm"、予約）

// `native` と `wasm` は異なるオーディオ I/O バックエンドを前提とするため、
// 同時に有効化することは意図していない。誤った feature 組み合わせを早期検出する。
#[cfg(all(feature = "native", feature = "wasm"))]
compile_error!("features `native` and `wasm` are mutually exclusive");

pub mod core;

#[cfg(feature = "native")]
pub mod native;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use core::{Engine, EngineError, Sample, ScheduledSample};
