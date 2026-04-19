//! Audio backend 抽象化。
//!
//! 本番では [`EngineWrap::start`] が `orbit_audio_native::start_default_output` を
//! 直接呼ぶため trait 経由ではない。本モジュールの [`AudioBackend`] は
//! integration test から audio device 無しで `EngineWrap` を立ち上げるための
//! [`StubBackend`] を導入するためだけに存在する。
//!
//! runtime branching (`#[cfg(test)]` や bool flag) は導入しない。trait dispatch で
//! DI を表現する。

use std::any::Any;
use std::sync::Arc;

use orbit_audio_core::Engine;
use orbit_audio_native::StreamStats;

use crate::engine_wrap::WrapError;

/// backend 起動結果。`guard` は実装依存の alive 保持用ハンドル（test では `Box<()>`）。
pub struct BackendStarted {
    pub engine: Engine,
    pub sample_rate: u32,
    pub channels: u16,
    pub stats: Arc<StreamStats>,
    pub guard: Box<dyn Any + Send>,
}

/// audio backend を起動するための trait。
///
/// 現状の実装は [`StubBackend`] のみ。本番の cpal 経路は
/// [`crate::engine_wrap::EngineWrap::start`] が直接呼び出す（`cpal::Stream` は
/// `!Send` で `Box<dyn Any + Send>` に包めないため）。
pub trait AudioBackend {
    fn start(self) -> Result<BackendStarted, WrapError>;
}

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
