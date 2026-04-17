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
    #[error("resampler construct error: {0}")]
    Construct(#[from] rubato::ResamplerConstructionError),
    #[error("resampler process error: {0}")]
    Process(#[from] rubato::ResampleError),
    #[error("buffer setup error: {0}")]
    Buffer(String),
    #[error("zero-channel sample cannot be resampled")]
    ZeroChannels,
}

/// FFT 処理のチャンクサイズ (frames)。
/// rubato のドキュメントで音声用途の典型値として推奨されている 1024 サンプルを採用。
/// 2 の冪であることが FFT 効率の前提。
const CHUNK_FRAMES: usize = 1024;

/// 遅延と品質のトレードオフ。2 は rubato のドキュメント推奨値。
const SUB_CHUNKS: usize = 2;

/// `sample` を `target_sr` へリサンプリングする。
///
/// - source と target の SR が同じ場合はコピー無しでそのまま返す
/// - ゼロチャンネルの不正サンプルは SR 比較より先にエラー
pub fn resample_to(sample: Sample, target_sr: u32) -> Result<Sample, ResampleError> {
    if sample.channels == 0 {
        return Err(ResampleError::ZeroChannels);
    }
    if sample.sample_rate == target_sr {
        return Ok(sample);
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
    )?;

    let out_len = resampler.process_all_needed_output_len(in_frames);
    let mut out_data = vec![0.0f32; out_len * channels];

    let input = InterleavedSlice::new(sample.as_slice(), channels, in_frames)
        .map_err(|e| ResampleError::Buffer(e.to_string()))?;
    let mut output = InterleavedSlice::new_mut(&mut out_data, channels, out_len)
        .map_err(|e| ResampleError::Buffer(e.to_string()))?;

    let (_, nbr_out) = resampler.process_all_into_buffer(&input, &mut output, in_frames, None)?;

    // 実際に書き込まれた frames 分だけに切り詰め、余剰キャパシティも解放。
    // このあと `Sample::new` で `Arc<Vec<f32>>` に包まれると shrink できなくなるため、
    // 共有前のここが唯一の縮小機会。
    out_data.truncate(nbr_out * channels);
    out_data.shrink_to_fit();

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

    #[test]
    fn zero_channel_sample_with_same_sr_also_returns_error() {
        // channels チェックが SR 比較より先に動くことを確認
        let s = Sample::new(vec![], 48_000, 0);
        assert!(matches!(
            resample_to(s, 48_000),
            Err(ResampleError::ZeroChannels)
        ));
    }

    /// サイン波で信号品質を検証する。DC だけのテストでは
    /// FFT 処理が壊れていても通ってしまうため、周波数成分を持つ信号で
    /// RMS が概ね保たれることを確認する。
    #[test]
    fn sine_wave_rms_is_preserved_through_resampling() {
        use std::f32::consts::TAU;

        let sr_in: u32 = 44_100;
        let sr_out: u32 = 48_000;
        let freq: f32 = 1_000.0;
        let channels: u16 = 2;
        let in_frames = sr_in as usize;

        let data: Vec<f32> = (0..in_frames * channels as usize)
            .map(|i| {
                let frame = i / channels as usize;
                (TAU * freq * frame as f32 / sr_in as f32).sin() * 0.5
            })
            .collect();

        let rms_in: f32 = (data.iter().map(|x| x * x).sum::<f32>() / data.len() as f32).sqrt();

        let s = Sample::new(data, sr_in, channels);
        let r = resample_to(s, sr_out).unwrap();

        let rms_out: f32 = (r.data.iter().map(|x| x * x).sum::<f32>() / r.data.len() as f32).sqrt();
        let db_diff = 20.0 * (rms_out / rms_in).log10();
        assert!(
            db_diff.abs() < 0.5,
            "RMS diff {db_diff:.3} dB outside ±0.5 dB (in={rms_in:.4}, out={rms_out:.4})"
        );
    }
}
