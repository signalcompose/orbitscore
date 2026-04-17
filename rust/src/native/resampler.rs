//! Offline sample rate conversion using `rubato`.
//!
//! ロード時に Project SR へ一度だけ変換する用途を想定している。
//! 再生時（リアルタイム）の変換は行わない。

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use thiserror::Error;

use crate::core::Sample;

#[derive(Error, Debug)]
pub enum ResampleError {
    #[error("resampler init error: {0}")]
    Init(String),
    #[error("resampler process error: {0}")]
    Process(String),
    #[error("zero-channel sample cannot be resampled")]
    ZeroChannels,
}

/// チャンクサイズ (frames). オフライン処理なのでそこそこ大きめで可。
/// rubato は内部でこのサイズ単位で FFT 処理する。
const CHUNK_FRAMES: usize = 1024;
/// 遅延と品質のトレードオフ。2 は rubato のドキュメント推奨値。
const SUB_CHUNKS: usize = 2;

/// `sample` を `target_sr` へリサンプリングする。
///
/// source と target の SR が同じ場合はコピー無しでそのまま返す。
pub fn resample_to(sample: Sample, target_sr: u32) -> Result<Sample, ResampleError> {
    if sample.sample_rate == target_sr {
        return Ok(sample);
    }
    if sample.channels == 0 {
        return Err(ResampleError::ZeroChannels);
    }

    let channels = sample.channels as usize;
    let in_frames = sample.frames();

    // rubato 2.0 の高品質 FFT リサンプラ。オフライン処理には FixedSync::Both が適切。
    let mut resampler = Fft::<f32>::new(
        sample.sample_rate as usize,
        target_sr as usize,
        CHUNK_FRAMES,
        SUB_CHUNKS,
        channels,
        FixedSync::Both,
    )
    .map_err(|e| ResampleError::Init(e.to_string()))?;

    let out_len = resampler.process_all_needed_output_len(in_frames);
    let mut out_data = vec![0.0f32; out_len * channels];

    let input = InterleavedSlice::new(&sample.data[..], channels, in_frames)
        .map_err(|e| ResampleError::Init(e.to_string()))?;
    let mut output = InterleavedSlice::new_mut(&mut out_data, channels, out_len)
        .map_err(|e| ResampleError::Init(e.to_string()))?;

    let (_nbr_in, nbr_out) = resampler
        .process_all_into_buffer(&input, &mut output, in_frames, None)
        .map_err(|e| ResampleError::Process(e.to_string()))?;

    // 実際に書き込まれた frames 分だけに切り詰める
    out_data.truncate(nbr_out * channels);

    Ok(Sample::new(out_data, target_sr, sample.channels))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_sample_rate_passes_through() {
        let s = Sample::new(vec![0.1f32; 200], 48_000, 2);
        let r = resample_to(s.clone(), 48_000).unwrap();
        assert_eq!(r.sample_rate, 48_000);
        assert_eq!(r.frames(), s.frames());
    }

    #[test]
    fn upsample_44100_to_48000_preserves_duration() {
        // 1 秒分の 44.1kHz ステレオ
        let in_frames = 44_100;
        let data = vec![0.1f32; in_frames * 2];
        let s = Sample::new(data, 44_100, 2);
        let r = resample_to(s, 48_000).unwrap();

        assert_eq!(r.sample_rate, 48_000);
        assert_eq!(r.channels, 2);
        // 持続時間が ±5ms 以内で保たれること
        assert!((r.duration_secs() - 1.0).abs() < 0.005);
        // 期待フレーム数付近（48000 ±小誤差）
        let expected = 48_000;
        let diff = (r.frames() as i64 - expected as i64).abs();
        assert!(
            diff < 100,
            "frames {} too far from {}",
            r.frames(),
            expected
        );
    }

    #[test]
    fn downsample_96000_to_48000_halves_frames() {
        let in_frames = 96_000;
        let data = vec![0.1f32; in_frames];
        let s = Sample::new(data, 96_000, 1);
        let r = resample_to(s, 48_000).unwrap();

        assert_eq!(r.sample_rate, 48_000);
        assert_eq!(r.channels, 1);
        let expected = 48_000;
        let diff = (r.frames() as i64 - expected as i64).abs();
        assert!(
            diff < 100,
            "frames {} too far from {}",
            r.frames(),
            expected
        );
    }

    #[test]
    fn zero_channel_sample_returns_error() {
        let s = Sample::new(vec![], 48_000, 0);
        assert!(matches!(
            resample_to(s, 44_100),
            Err(ResampleError::ZeroChannels)
        ));
    }
}
