//! symphonia を使って音声ファイルをデコードし、[`Sample`] にして返す。

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use thiserror::Error;

use crate::core::Sample;

#[derive(Error, Debug)]
pub enum LoaderError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("unsupported format")]
    Unsupported,
    #[error("resample error: {0}")]
    Resample(#[from] super::resampler::ResampleError),
}

/// 音声ファイルをロードして `target_sr` に合わせてリサンプリングする。
///
/// Pro Tools / Logic Pro 方式に倣い、再生時ではなくロード時に一度だけ
/// 変換することで、再生時のリアルタイム処理を 1:1 マッピングに保つ。
///
/// ソースの SR と target が一致する場合はコピーせずそのまま返す。
pub fn load_sample_at(path: impl AsRef<Path>, target_sr: u32) -> Result<Sample, LoaderError> {
    let raw = load_sample_from_file(path)?;
    if raw.sample_rate == target_sr {
        return Ok(raw);
    }
    Ok(super::resampler::resample_to(raw, target_sr)?)
}

/// 音声ファイルを読み込み、出力サンプルレートに関係なく元のサンプルをそのまま返す。
///
/// 対応形式: WAV / MP3 / AAC / MP4（Cargo.toml の symphonia features 参照）。
pub fn load_sample_from_file(path: impl AsRef<Path>) -> Result<Sample, LoaderError> {
    let file = File::open(path.as_ref())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.as_ref().extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| LoaderError::Decode(e.to_string()))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or(LoaderError::Unsupported)?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or(LoaderError::Unsupported)?;
    let channels = track
        .codec_params
        .channels
        .ok_or(LoaderError::Unsupported)?
        .count() as u16;

    let capacity = track
        .codec_params
        .n_frames
        .map(|f| (f as usize).saturating_mul(channels as usize))
        .unwrap_or(0);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| LoaderError::Decode(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::with_capacity(capacity);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(e) => return Err(LoaderError::Decode(e.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|e| LoaderError::Decode(e.to_string()))?;

        append_interleaved(&mut samples, decoded)?;
    }

    Ok(Sample::new(samples, sample_rate, channels))
}

/// 各 `AudioBuffer<T>` のフレームループ本体を展開するマクロ。
/// 変換式 `$conv` が `T -> f32` の意味を持ち、それ以外はすべて共通。
macro_rules! push_frames {
    ($out:expr, $buf:expr, $conv:expr) => {{
        let frames = $buf.frames();
        let channels = $buf.spec().channels.count();
        for f in 0..frames {
            for c in 0..channels {
                $out.push($conv($buf.chan(c)[f]));
            }
        }
    }};
}

fn append_interleaved(out: &mut Vec<f32>, buffer: AudioBufferRef) -> Result<(), LoaderError> {
    // 24-bit 符号付整数のフルスケール (2^23 - 1)
    const S24_MAX: f32 = 8_388_607.0;

    match buffer {
        AudioBufferRef::F32(buf) => push_frames!(out, buf, |s: f32| s),
        AudioBufferRef::F64(buf) => push_frames!(out, buf, |s: f64| s as f32),
        AudioBufferRef::S16(buf) => push_frames!(out, buf, |s: i16| s as f32 / i16::MAX as f32),
        AudioBufferRef::S24(buf) => {
            push_frames!(out, buf, |s: symphonia::core::sample::i24| {
                s.inner() as f32 / S24_MAX
            })
        }
        AudioBufferRef::S32(buf) => push_frames!(out, buf, |s: i32| s as f32 / i32::MAX as f32),
        AudioBufferRef::U8(buf) => push_frames!(out, buf, |s: u8| (s as f32 - 128.0) / 128.0),
        AudioBufferRef::U16(buf) => {
            push_frames!(out, buf, |s: u16| (s as f32 - 32768.0) / 32768.0)
        }
        other => {
            // U24 / S8 / U32 など、未対応のサンプル型は黙って捨てずに明示エラー。
            return Err(LoaderError::Decode(format!(
                "unsupported sample format: {:?}",
                std::mem::discriminant(&other)
            )));
        }
    }
    Ok(())
}
