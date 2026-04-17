//! orbit-audio-core
//!
//! Signal compose の汎用オーディオエンジンの **platform-agnostic** なコア。
//! 再生デバイスやファイル I/O には依存せず、以下のみを扱う:
//!
//! - 秒ベースの時刻軸 / スケジューラ
//! - インターリーブ PCM サンプル値型
//! - オーディオコールバックから呼べる同期ミキサー
//!
//! cpal などの OS ネイティブ音声 I/O は [`orbit-audio-native`] crate が、
//! WASM / AudioWorklet は [`orbit-audio-wasm`] crate が担う。

mod engine;
mod sample;
mod scheduler;

pub use engine::{Engine, EngineError};
pub use sample::Sample;
pub use scheduler::{ScheduledSample, Scheduler};
