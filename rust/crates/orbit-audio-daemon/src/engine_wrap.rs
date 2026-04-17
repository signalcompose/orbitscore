//! Engine + ロード済みサンプル / 再生管理の wrapper。
//!
//! PoC 簡略化のため `Arc<Mutex>` ベース。lock-free 化は Phase 1b-2 以降で検討。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use orbit_audio_core::{Engine, Sample};
use orbit_audio_native::{
    load_sample_resampled, start_default_output, LoaderError, OutputError, OutputStream,
    ResampleError,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum WrapError {
    #[error("audio output init failed: {0}")]
    Output(#[from] OutputError),
    #[error("loader error: {0}")]
    Loader(#[from] LoaderError),
    #[error("resample error: {0}")]
    Resample(#[from] ResampleError),
    #[error("sample not found: {0}")]
    SampleNotFound(String),
    #[error("scheduler error: {0}")]
    Scheduler(String),
}

/// 共有可能なエンジン wrapper。
///
/// `cpal::Stream` は `!Send` のため、ここには持ち込まない。
/// [`start`] が返す [`StreamGuard`] を main 側で alive に保つ責務。
pub struct EngineWrap {
    engine: Engine,
    sample_rate: u32,
    channels: u16,
    samples: Mutex<HashMap<String, Sample>>,
    started_at: std::time::Instant,
    active_play_count: std::sync::atomic::AtomicUsize,
}

/// `cpal::Stream` を保持する guard。drop されるとストリーム停止。`!Send`。
pub struct StreamGuard(#[allow(dead_code)] pub(crate) OutputStream);

impl EngineWrap {
    /// Engine とストリーム guard を起動する。
    /// guard は caller（通常は main）が drop されるまで保持すること。
    pub fn start() -> Result<(Arc<Self>, StreamGuard), WrapError> {
        let (engine, stream) = start_default_output()?;
        let sample_rate = stream.sample_rate;
        let channels = stream.channels;
        let wrap = Arc::new(Self {
            engine,
            sample_rate,
            channels,
            samples: Mutex::new(HashMap::new()),
            started_at: std::time::Instant::now(),
            active_play_count: std::sync::atomic::AtomicUsize::new(0),
        });
        Ok((wrap, StreamGuard(stream)))
    }

    pub fn uptime_sec(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }

    /// 現在は daemon 起動からの累積 `PlayAt` 回数を返す。
    /// Phase 1b-1 時点では Stop / 再生完了イベントが未実装のため、
    /// 減算は行わず単調増加する（Phase 1b-2 で実時間の active 数に移行予定）。
    pub fn active_play_count(&self) -> usize {
        self.active_play_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn output_sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn output_channels(&self) -> u16 {
        self.channels
    }

    /// ファイルをロードし sample_id を返す。
    pub fn load_sample(&self, path: PathBuf) -> Result<LoadedSample, WrapError> {
        let sample = load_sample_resampled(&path, self.sample_rate)?;
        let id = format!("s-{}", short_uuid());
        let info = LoadedSample {
            sample_id: id.clone(),
            frames: sample.frames(),
            channels: sample.channels,
            sample_rate: sample.sample_rate,
        };
        self.lock_samples()?.insert(id, sample);
        Ok(info)
    }

    pub fn unload_sample(&self, sample_id: &str) -> Result<(), WrapError> {
        if self.lock_samples()?.remove(sample_id).is_some() {
            Ok(())
        } else {
            Err(WrapError::SampleNotFound(sample_id.to_string()))
        }
    }

    /// sample を現在時刻 + offset でスケジュール。
    ///
    /// `time_sec` は daemon 起動からの経過秒（Engine transport 基準）。
    /// 戻り値にサンプル再生時間を含めるので、呼び出し側は PlayEnded を
    /// 遅延送信するためのタイマーを組める。
    pub fn play_at(
        &self,
        sample_id: &str,
        time_sec: f64,
        gain: f32,
    ) -> Result<PlayHandle, WrapError> {
        let sample = self
            .lock_samples()?
            .get(sample_id)
            .cloned()
            .ok_or_else(|| WrapError::SampleNotFound(sample_id.to_string()))?;
        let duration_sec = sample.duration_secs();
        self.engine
            .schedule_with_gain(time_sec, gain, sample)
            .map_err(|e| WrapError::Scheduler(e.to_string()))?;
        self.active_play_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(PlayHandle {
            play_id: format!("p-{}", short_uuid()),
            sample_id: sample_id.to_string(),
            start_sec: time_sec,
            duration_sec,
        })
    }

    /// 読み取り専用カウンタ。Phase 1b-2 で Stop 実装後に poisoned 検出もしたいため
    /// 現状は Result ではなく fallback（poisoned 時は 0 を返す）で返却する。
    pub fn loaded_sample_count(&self) -> usize {
        match self.samples.lock() {
            Ok(guard) => guard.len(),
            Err(_) => 0,
        }
    }

    #[allow(dead_code)]
    pub fn now_sec(&self) -> Option<f64> {
        self.engine.now_sec()
    }

    /// `samples` Mutex を poisoned-safe に取得する。
    /// poisoned 時は `WrapError::Scheduler` に変換して呼び出し側に明示的に通知する。
    fn lock_samples(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Sample>>, WrapError> {
        self.samples
            .lock()
            .map_err(|_| WrapError::Scheduler("samples mutex poisoned".to_string()))
    }
}

pub struct LoadedSample {
    pub sample_id: String,
    pub frames: usize,
    pub channels: u16,
    pub sample_rate: u32,
}

pub struct PlayHandle {
    pub play_id: String,
    pub sample_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}
