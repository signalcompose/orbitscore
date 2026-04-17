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
    #[error("scheduler mutex poisoned (a previous thread panicked while holding the lock)")]
    Poisoned,
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

    /// サンプルをスケジュールする。制御スレッドから呼ぶ想定。
    /// スケジューラの Mutex が poisoned 状態の場合はエラーを返し、呼び出し側に
    /// 障害を伝える（サイレントに無視しない）。
    pub fn schedule(&self, start_sec: f64, sample: Sample) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        s.schedule(ScheduledSample::new(start_sec, sample));
        Ok(())
    }

    /// 指定ゲインでサンプルをスケジュールする。
    pub fn schedule_with_gain(
        &self,
        start_sec: f64,
        gain: f32,
        sample: Sample,
    ) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        s.schedule(ScheduledSample::new(start_sec, sample).with_gain(gain));
        Ok(())
    }

    /// オーディオコールバックから呼び出される。`out` は interleaved f32。
    ///
    /// リアルタイムスレッドで呼ばれるため `try_lock` を用い、ロック競合時は
    /// 無音（silent drop）を返してコールバックを即時完了させる。将来的には
    /// lock-free ringbuffer に置き換える余地あり（Phase 2）。
    pub fn render(&self, out: &mut [f32]) {
        match self.inner.try_lock() {
            Ok(mut s) => s.render(out),
            Err(_) => {
                for x in out.iter_mut() {
                    *x = 0.0;
                }
            }
        }
    }

    /// 現在の出力ストリーム時刻（秒）を返す。
    /// ロック取得に失敗した場合は `None` を返し、呼び出し側がストリーム開始直後の
    /// `Some(0.0)` と区別できるようにする。
    pub fn now_sec(&self) -> Option<f64> {
        self.inner.try_lock().ok().map(|s| s.now_sec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_then_render_writes_nonzero() {
        let engine = Engine::new(48_000, 2);
        let sample = Sample::new(vec![0.5f32; 200], 48_000, 2);
        engine.schedule(0.0, sample).expect("schedule");

        let mut buf = vec![0.0f32; 400];
        engine.render(&mut buf);
        assert!(buf.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn now_sec_returns_some_zero_at_start() {
        let engine = Engine::new(48_000, 2);
        assert_eq!(engine.now_sec(), Some(0.0));
    }
}
