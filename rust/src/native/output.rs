//! cpal を使った既定出力デバイスへのストリーム設定。

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use thiserror::Error;

use crate::core::Engine;

#[derive(Error, Debug)]
pub enum OutputError {
    #[error("no default output device found")]
    NoDevice,
    #[error("no supported output config")]
    NoConfig,
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
pub fn start_default_output() -> Result<(Engine, OutputStream), OutputError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
    let supported = device
        .default_output_config()
        .map_err(|_| OutputError::NoConfig)?;

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let sample_rate = config.sample_rate.0;
    let channels = config.channels;

    let engine = Engine::new(sample_rate, channels);
    let stream = build_stream(&device, &config, sample_format, engine.clone())?;
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
    ))
}

fn build_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    engine: Engine,
) -> Result<Stream, OutputError> {
    let err_fn = |err| eprintln!("stream error: {err}");
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| engine.render(data),
                err_fn,
                None,
            )
            .map_err(|e| OutputError::BuildStream(e.to_string()))?,
        SampleFormat::I16 => {
            // scratch はクロージャキャプチャ側で保持し、コールバック内で
            // resize のみ行う。これにより realtime スレッドでのヒープ確保を避ける。
            let mut scratch: Vec<f32> = Vec::new();
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        for x in buf.iter_mut() {
                            *x = 0.0;
                        }
                        engine.render(buf);
                        for (i, s) in buf.iter().enumerate() {
                            data[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        SampleFormat::U16 => {
            let mut scratch: Vec<f32> = Vec::new();
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        if scratch.len() < data.len() {
                            scratch.resize(data.len(), 0.0);
                        }
                        let buf = &mut scratch[..data.len()];
                        for x in buf.iter_mut() {
                            *x = 0.0;
                        }
                        engine.render(buf);
                        for (i, s) in buf.iter().enumerate() {
                            let v = (s.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32;
                            data[i] = v as u16;
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| OutputError::BuildStream(e.to_string()))?
        }
        _ => return Err(OutputError::NoConfig),
    };
    Ok(stream)
}
