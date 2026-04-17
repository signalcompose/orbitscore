//! Engine: Scheduler と sample ローダを束ねた上位 API。
//!
//! Phase 2 以降で DSL interpreter と接続する想定。PoC では
//! 「サンプルをロードして、時刻指定でスケジュールする」だけを提供する。

use std::sync::{Arc, Mutex};

use thiserror::Error;

use super::scheduler::{ScheduledSample, Scheduler};
use super::Sample;

#[derive(Error, Debug)]
pub enum EngineError {
    #[error("sample decode error: {0}")]
    Decode(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// 共有可能なエンジンハンドル。
///
/// オーディオコールバック（リアルタイムスレッド）と制御スレッドで共有するため、
/// 内部状態は `Mutex` でガードする。将来は lock-free ringbuf などに置き換える余地あり。
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Mutex<Scheduler>>,
}

impl Engine {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Scheduler::new(sample_rate, channels))),
        }
    }

    /// サンプルをスケジュールする。
    pub fn schedule(&self, start_sec: f64, sample: Sample) {
        if let Ok(mut s) = self.inner.lock() {
            s.schedule(ScheduledSample::new(start_sec, sample));
        }
    }

    /// 指定ゲインでサンプルをスケジュールする。
    pub fn schedule_with_gain(&self, start_sec: f64, gain: f32, sample: Sample) {
        if let Ok(mut s) = self.inner.lock() {
            s.schedule(ScheduledSample::new(start_sec, sample).with_gain(gain));
        }
    }

    /// オーディオコールバックから呼び出される。`out` は interleaved f32。
    pub fn render(&self, out: &mut [f32]) {
        if let Ok(mut s) = self.inner.lock() {
            s.render(out);
        } else {
            for x in out.iter_mut() {
                *x = 0.0;
            }
        }
    }

    /// 現在の出力ストリーム時刻（秒）
    pub fn now_sec(&self) -> f64 {
        self.inner.lock().map(|s| s.now_sec()).unwrap_or(0.0)
    }
}
