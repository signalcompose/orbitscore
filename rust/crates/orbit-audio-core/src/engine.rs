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

    /// `play_id` 付きでスケジュールする。後で `stop` で個別停止できる。
    ///
    /// `pan` は [-1.0, 1.0]（0.0 = 中央）。render 時に等パワー則（SC `Pan2` 一致）で
    /// 適用され、範囲外は clamp される。
    /// `slice_start_frame` / `slice_len_frames` は再生領域（`chop` の slice）。
    /// `slice_len_frames == 0` で「offset 以降すべて」。サンプル端で clamp される。
    /// `rate` は varispeed（1.0 = 自然尺・`<=0`/非有限は 1.0 に丸め）。
    /// `channel` は出力先 channel 名（LinkAudio outputChannel・#209）。`None` = 既定
    /// （unrouted / hardware sum）。同名 channel は `render_channel` で加算合成される。
    #[allow(clippy::too_many_arguments)]
    pub fn schedule_with_play_id(
        &self,
        start_sec: f64,
        gain: f32,
        pan: f32,
        slice_start_frame: usize,
        slice_len_frames: usize,
        rate: f64,
        channel: Option<String>,
        play_id: String,
        sample: Sample,
    ) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        s.schedule(
            ScheduledSample::new(start_sec, sample)
                .with_gain(gain)
                .with_pan(pan)
                .with_region(slice_start_frame, slice_len_frames)
                .with_rate(rate)
                .with_channel(channel)
                .with_play_id(play_id),
        );
        Ok(())
    }

    /// `play_id` に一致するアクティブ再生を停止する。true = 停止成功, false = 見つからず。
    pub fn stop(&self, play_id: &str) -> Result<bool, EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        Ok(s.stop(play_id))
    }

    /// 全イベントを即時停止する hard-stop-all。停止件数を返す（respawn / stopAll で使う）。
    pub fn stop_all(&self) -> Result<usize, EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        Ok(s.stop_all())
    }

    /// スケジュール中のイベント数（実時間で active な再生数）。
    /// ロック競合時は `None` を返す。
    pub fn active_count(&self) -> Option<usize> {
        self.inner.try_lock().ok().map(|s| s.active_count())
    }

    /// マスターゲインを設定する。`ramp_sec` が 0 以下なら即時、正なら線形ランプ。
    ///
    /// 正の `ramp_sec` がサブフレーム相当（例: 1/sample_rate 未満）でも、
    /// 呼び出し側の「ランプ要求」意図を尊重して最小 1 フレームのランプとして扱う。
    /// これにより、意図せず即時切替にフォールバックして pop ノイズが乗ることを防ぐ。
    pub fn set_global_gain(&self, value: f32, ramp_sec: f64) -> Result<(), EngineError> {
        let mut s = self.inner.lock().map_err(|_| EngineError::Poisoned)?;
        let ramp_frames = if ramp_sec > 0.0 {
            ((ramp_sec * s.output_sample_rate() as f64).round() as u64).max(1)
        } else {
            0
        };
        s.set_global_gain(value, ramp_frames);
        Ok(())
    }

    /// `try_lock` で Scheduler を借りて `f` を実行する。RT スレッドから呼ばれるため、ロック
    /// 競合時は無音（silent drop）で即時 return する（将来 lock-free ringbuffer 化の余地あり・
    /// Phase 2）。`render` / `render_channel` がこの try-lock + silent-drop 規約を共有する。
    fn with_scheduler(&self, out: &mut [f32], f: impl FnOnce(&mut Scheduler, &mut [f32])) {
        match self.inner.try_lock() {
            // MutexGuard を DerefMut で &mut Scheduler に再借用して closure に渡す。
            Ok(mut s) => f(&mut s, out),
            Err(_) => {
                for x in out.iter_mut() {
                    *x = 0.0;
                }
            }
        }
    }

    /// オーディオコールバックから呼び出される。`out` は interleaved f32。RT 競合時は無音。
    pub fn render(&self, out: &mut [f32]) {
        self.with_scheduler(out, |s, b| s.render(b));
    }

    /// `render` の channel filter 版。指定 channel 名に属する event だけを `out` に加算する
    /// （LinkAudio per-channel tap・#209）。test/scaffolding 用（本番 RT は A4-2b-2 で
    /// [`Scheduler::render_multi`] に移行予定）。本番 hardware `render` と同一 tick で混在させない
    /// こと（[`Scheduler::render_channel`] 参照）。
    #[doc(hidden)]
    pub fn render_channel(&self, out: &mut [f32], channel: &str) {
        self.with_scheduler(out, |s, b| s.render_channel(b, channel));
    }

    /// 本番 RT 用の single-pass multi-buffer render（A4-2b-2）。`hardware_out`（channel=None）と
    /// 各 named channel buffer を 1 パスで埋め transport を 1 回だけ進める
    /// （[`Scheduler::render_multi`]）。RT 競合（try_lock 失敗）時は `render` の silent-drop 規約を
    /// multi-buffer に拡張し、**hardware と全 channel buffer を無音**にする（ramp を多重に進めないため
    /// 単一の try_lock で一括処理する）。
    pub fn render_multi(&self, hardware_out: &mut [f32], channels: &mut [(&str, &mut [f32])]) {
        match self.inner.try_lock() {
            Ok(mut s) => s.render_multi(hardware_out, channels),
            Err(_) => {
                hardware_out.fill(0.0);
                for (_, buf) in channels.iter_mut() {
                    buf.fill(0.0);
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
