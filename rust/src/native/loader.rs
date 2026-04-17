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

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| LoaderError::Decode(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();

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

        append_interleaved(&mut samples, decoded);
    }

    Ok(Sample::new(samples, sample_rate, channels))
}

fn append_interleaved(out: &mut Vec<f32>, buffer: AudioBufferRef) {
    match buffer {
        AudioBufferRef::F32(buf) => {
            let frames = buf.frames();
            let channels = buf.spec().channels.count();
            for f in 0..frames {
                for c in 0..channels {
                    out.push(buf.chan(c)[f]);
                }
            }
        }
        AudioBufferRef::S16(buf) => {
            let frames = buf.frames();
            let channels = buf.spec().channels.count();
            for f in 0..frames {
                for c in 0..channels {
                    out.push(buf.chan(c)[f] as f32 / i16::MAX as f32);
                }
            }
        }
        AudioBufferRef::S32(buf) => {
            let frames = buf.frames();
            let channels = buf.spec().channels.count();
            for f in 0..frames {
                for c in 0..channels {
                    out.push(buf.chan(c)[f] as f32 / i32::MAX as f32);
                }
            }
        }
        AudioBufferRef::U8(buf) => {
            let frames = buf.frames();
            let channels = buf.spec().channels.count();
            for f in 0..frames {
                for c in 0..channels {
                    let s = buf.chan(c)[f];
                    out.push((s as f32 - 128.0) / 128.0);
                }
            }
        }
        _ => {
            // 他のフォーマットは必要になったら追加する
        }
    }
}
