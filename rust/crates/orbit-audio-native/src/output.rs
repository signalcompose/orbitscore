//! cpal を使った既定出力デバイスへのストリーム設定。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use thiserror::Error;

use orbit_audio_core::Engine;

/// cpal ストリームから得られる稼働統計。
///
/// err_fn は audio スレッドから呼ばれるため atomic で更新する。
/// `buffer_underruns` は cpal の `StreamError` が underrun を個別に示さないため
/// 常に 0。将来 backend-specific な判別ができるようになれば増分経路を追加する。
///
/// `device_lost` は `cpal::StreamError::DeviceNotAvailable` を受け取った際に
/// true にセットされ、上位 (daemon session) が 1 Hz ticker で polling して
/// fatal DaemonError イベントを発火するためのフラグ。一度 true になったら
/// 現 stream は回復不能なので、set 後の再初期化は scope 外。
#[derive(Debug, Default)]
pub struct StreamStats {
    xruns: AtomicU64,
    buffer_underruns: AtomicU64,
    device_lost: AtomicBool,
}

impl StreamStats {
    pub fn snapshot(&self) -> StreamStatsSnapshot {
        StreamStatsSnapshot {
            xruns: self.xruns.load(Ordering::Relaxed),
            buffer_underruns: self.buffer_underruns.load(Ordering::Relaxed),
            device_lost: self.device_lost.load(Ordering::Relaxed),
        }
    }

    fn record_xrun(&self) {
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }

    fn record_device_lost(&self) {
        self.device_lost.store(true, Ordering::Relaxed);
    }

    /// cpal::StreamError を variant で振り分けて atomic を更新する。
    /// audio thread から呼ばれるので blocking I/O を避け atomic 操作のみ。
    /// make_err_fn と test helper の両方がこれを参照するため、
    /// dispatch ロジックの drift 防止に single-source として機能する。
    fn record_error(&self, err: &cpal::StreamError) {
        match err {
            cpal::StreamError::DeviceNotAvailable => self.record_device_lost(),
            cpal::StreamError::BackendSpecific { .. } => self.record_xrun(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StreamStatsSnapshot {
    pub xruns: u64,
    pub buffer_underruns: u64,
    pub device_lost: bool,
}

#[derive(Error, Debug)]
pub enum OutputError {
    #[error("no default output device found")]
    NoDevice,
    #[error("no supported output config: {0}")]
    NoConfig(String),
    #[error("cpal build stream error: {0}")]
    BuildStream(String),
    #[error("cpal play stream error: {0}")]
    PlayStream(String),
}

/// 生きている間はストリームを保持する RAII ハンドル。
pub struct OutputStream {
    _stream: Stream,
    pub sample_rate: u32,
    pub channels: u16,
}

/// 既定の出力デバイスを使い、デバイス config に合う [`Engine`] とストリームを
/// 同時に初期化する。呼び出し側は config ミスマッチを意識しなくてよい。
pub fn start_default_output() -> Result<(Engine, OutputStream, Arc<StreamStats>), OutputError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
    let supported = device
        .default_output_config()
        .map_err(|e| OutputError::NoConfig(e.to_string()))?;

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let sample_rate = config.sample_rate.0;
    let channels = config.channels;

    let stats = Arc::new(StreamStats::default());
    let engine = Engine::new(sample_rate, channels);
    let stream = build_stream(&device, &config, sample_format, engine.clone(), stats.clone())?;
    stream
        .play()
        .map_err(|e| OutputError::PlayStream(e.to_string()))?;

    Ok((
        engine,
        OutputStream {
            _stream: stream,
            sample_rate,
            channels,
        },
        stats,
    ))
}

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    engine: Engine,
    stats: Arc<StreamStats>,
) -> Result<Stream, OutputError> {
    let make_err_fn = || {
        // 上位 (daemon session) が StreamStats / DaemonError 経由で可視化する責務を持つ。
        let stats = stats.clone();
        move |err: cpal::StreamError| stats.record_error(&err)
    };

    /// scratch バッファを事前に 1 秒分確保してクロージャにムーブするヘルパー。
    /// cpal のコールバック buffer_size は通常数百フレームなので十分余裕がある。
    /// リアルタイムコールバック初回でのヒープ確保を回避する。
    fn scratch_with_capacity(config: &StreamConfig) -> Vec<f32> {
        vec![0.0; (config.sample_rate.0 as usize) * (config.channels as usize)]
    }

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| engine.render(data),
                make_err_fn(),
                None,
            )
            .map_err(|e| OutputError::BuildStream(e.to_string()))?,
        SampleFormat::I16 => {
            // バッファのゼロクリアは engine.render() 内の Scheduler::render で行うため省略。
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        engine.render(buf);
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    make_err_fn(),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        SampleFormat::I32 => {
            // 一部の Linux (ALSA) 環境で出力デフォルトになるため対応。
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i32], _| {
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        engine.render(buf);
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i32::MAX as f32) as i32;
                        }
                    },
                    make_err_fn(),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        SampleFormat::U16 => {
            let mut scratch = scratch_with_capacity(config);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        engine.render(buf);
                        for (i, s) in buf.iter().enumerate() {
                            let v = (s.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32;
                            data[i] = v as u16;
                        }
                    },
                    make_err_fn(),
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        other => {
            return Err(OutputError::NoConfig(format!(
                "unsupported sample format: {other:?}"
            )))
        }
    };
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cpal::BackendSpecificError;

    #[test]
    fn stream_stats_starts_at_zero() {
        let stats = StreamStats::default();
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 0);
        assert_eq!(snap.buffer_underruns, 0);
        assert!(!snap.device_lost);
    }

    #[test]
    fn record_xrun_increments_only_xruns() {
        let stats = StreamStats::default();
        stats.record_xrun();
        stats.record_xrun();
        stats.record_xrun();
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 3);
        assert_eq!(snap.buffer_underruns, 0);
        assert!(!snap.device_lost);
    }

    #[test]
    fn snapshot_is_monotonic() {
        let stats = StreamStats::default();
        let s1 = stats.snapshot();
        stats.record_xrun();
        let s2 = stats.snapshot();
        assert!(s2.xruns > s1.xruns);
    }

    #[test]
    fn record_device_lost_sets_flag() {
        let stats = StreamStats::default();
        assert!(!stats.snapshot().device_lost);
        stats.record_device_lost();
        assert!(stats.snapshot().device_lost);
    }

    #[test]
    fn device_lost_and_xrun_are_independent() {
        let stats = StreamStats::default();
        stats.record_xrun();
        let after_xrun = stats.snapshot();
        assert_eq!(after_xrun.xruns, 1);
        assert!(!after_xrun.device_lost);

        stats.record_device_lost();
        let after_lost = stats.snapshot();
        assert_eq!(after_lost.xruns, 1, "record_device_lost must not touch xruns");
        assert!(after_lost.device_lost);
    }

    #[test]
    fn record_error_dispatches_device_not_available_as_device_lost() {
        let stats = StreamStats::default();
        stats.record_error(&cpal::StreamError::DeviceNotAvailable);
        let snap = stats.snapshot();
        assert!(snap.device_lost);
        assert_eq!(snap.xruns, 0);
    }

    #[test]
    fn record_error_dispatches_backend_specific_as_xrun() {
        let stats = StreamStats::default();
        stats.record_error(&cpal::StreamError::BackendSpecific {
            err: BackendSpecificError {
                description: "transient underrun".to_string(),
            },
        });
        let snap = stats.snapshot();
        assert_eq!(snap.xruns, 1);
        assert!(!snap.device_lost);
    }
}
