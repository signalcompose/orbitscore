//! Audio backend 抽象化。
//!
//! 本番では [`CpalBackend`] が cpal 経由で既定出力デバイスを開く。
//! integration test では [`StubBackend`] を用いて audio device なしで
//! `EngineWrap` と同等の wiring を行い、WebSocket protocol を検証する。
//!
//! runtime branching (`#[cfg(test)]` や bool flag) は導入しない。trait dispatch で
//! DI を表現する。

use std::any::Any;
use std::sync::Arc;

use orbit_audio_core::Engine;
use orbit_audio_native::{start_default_output, OutputStream, StreamStats};

use crate::engine_wrap::WrapError;

/// backend 起動結果。`guard` は cpal::Stream 等を alive に保つための不透明ハンドル。
pub struct BackendStarted {
    pub engine: Engine,
    pub sample_rate: u32,
    pub channels: u16,
    pub stats: Arc<StreamStats>,
    pub guard: Box<dyn Any + Send>,
}

/// audio backend を起動するための trait。
pub trait AudioBackend {
    fn start(self) -> Result<BackendStarted, WrapError>;
}

/// 本番用: cpal 既定出力デバイスに繋ぐ。
pub struct CpalBackend;

impl AudioBackend for CpalBackend {
    fn start(self) -> Result<BackendStarted, WrapError> {
        let (engine, stream, stats) = start_default_output()?;
        let sample_rate = stream.sample_rate;
        let channels = stream.channels;
        Ok(BackendStarted {
            engine,
            sample_rate,
            channels,
            stats,
            guard: Box::new(StreamHolder(stream)),
        })
    }
}

/// cpal の `Stream` は `!Send` だが、`StreamHolder` として `Send` な `Box<dyn Any + Send>`
/// に詰めるために wrap する。
///
/// `Stream` 自体は `!Send` なので、本来 `Box<dyn Any + Send>` には入らない。
/// production では `CpalBackend::start()` を実行したスレッドでそのまま保持する
/// 前提（main thread）。test backend の guard は `()` を入れるため問題ない。
///
/// 注意: `Stream` を別スレッドへ move すると UB になる。本実装では
/// `BackendStarted.guard` は即座に `main` / test thread に保持され、
/// await 越しに move されない設計。
struct StreamHolder(#[allow(dead_code)] OutputStream);

// SAFETY: production では `StreamHolder` は `main` thread に保持され続ける
// （`_stream_guard` 変数で alive に保つ）ため、スレッド越境は発生しない。
// `Any + Send` 境界を通すためだけの unsafe impl。
unsafe impl Send for StreamHolder {}

/// test 用: audio device を開かず `Engine` のみ構築する。
///
/// - sample_rate / channels はテスト固定値（48 kHz / 2ch）
/// - stats は default（xruns=0, device_lost=false）で初期化。
///   test はこの stats に対して直接 `record_xrun` / `record_device_lost` を呼んで
///   DaemonError event を駆動する。
/// - guard は `()` を入れる（alive に保つべき資源は無い）
pub struct StubBackend {
    pub sample_rate: u32,
    pub channels: u16,
}

impl Default for StubBackend {
    fn default() -> Self {
        Self {
            sample_rate: 48_000,
            channels: 2,
        }
    }
}

impl AudioBackend for StubBackend {
    fn start(self) -> Result<BackendStarted, WrapError> {
        let engine = Engine::new(self.sample_rate, self.channels);
        let stats = Arc::new(StreamStats::default());
        Ok(BackendStarted {
            engine,
            sample_rate: self.sample_rate,
            channels: self.channels,
            stats,
            guard: Box::new(()),
        })
    }
}
