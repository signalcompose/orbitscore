//! Analysis: 捕捉した PCM から客観量を抽出する純粋関数群（= Scoreboard / Checker）。
//!
//! ここは Golden Reference Model 側であり、core レンダラ（DUT）の render 補助
//! （`equal_power_pan` / `resolve_slice_region` 等）を **import しない**。同じ式を
//! 共有すると同一バグが両側に乗り差分が消えるため、pan は `atan2` で独立に逆算し、
//! 期待値はテストフィクスチャ側に直書きする。

use crate::capture::CapturedAudio;

/// pan 逆算の許容（pan 単位、[-1,1] スケール）。#308 CI gate 案 `±0.05`。
pub const PAN_TOLERANCE: f32 = 0.05;

/// レベル/ゲイン差の許容（dBFS）。#308 CI gate 案 `±0.5 dBFS`、resampler test の
/// ±0.5 dB 前例にも一致。
pub const GAIN_DB_TOLERANCE: f32 = 0.5;

/// 無音判定の floor（dBFS）。本レンダラの領域外は厳密 0.0 だが、研究 §6 の
/// noise floor に倣い文書化された閾値として残す。
pub const SILENCE_FLOOR_DB: f32 = -90.0;

/// `[start_frame, end_frame)` の 1 チャンネル RMS。`end_frame` は frames で clamp。
/// 区間が空なら 0.0。誤差蓄積を避けるため f64 で積算する。
pub fn region_rms(audio: &CapturedAudio, ch: usize, start_frame: usize, end_frame: usize) -> f32 {
    let chs = audio.channels.max(1) as usize;
    if ch >= chs {
        return 0.0;
    }
    let end = end_frame.min(audio.frames());
    if start_frame >= end {
        return 0.0;
    }
    let mut acc = 0.0f64;
    for f in start_frame..end {
        let v = audio.data[f * chs + ch] as f64;
        acc += v * v;
    }
    (acc / (end - start_frame) as f64).sqrt() as f32
}

/// 1 チャンネル全体の RMS。
pub fn channel_rms(audio: &CapturedAudio, ch: usize) -> f32 {
    region_rms(audio, ch, 0, audio.frames())
}

/// `[start_frame, end_frame)` の 1 チャンネル peak（絶対値の最大）。
pub fn region_peak(audio: &CapturedAudio, ch: usize, start_frame: usize, end_frame: usize) -> f32 {
    let chs = audio.channels.max(1) as usize;
    if ch >= chs {
        return 0.0;
    }
    let end = end_frame.min(audio.frames());
    if start_frame >= end {
        return 0.0; // 空区間（region_rms と同じく明示的に 0.0 を返す）
    }
    let mut peak = 0.0f32;
    for f in start_frame..end {
        peak = peak.max(audio.data[f * chs + ch].abs());
    }
    peak
}

/// 1 チャンネル全体の peak（絶対値の最大）。
pub fn channel_peak(audio: &CapturedAudio, ch: usize) -> f32 {
    region_peak(audio, ch, 0, audio.frames())
}

/// 線形振幅 → dBFS（`20·log10`）。`x <= 0` は `-inf`。
pub fn linear_to_db(x: f32) -> f32 {
    if x <= 0.0 {
        f32::NEG_INFINITY
    } else {
        20.0 * x.log10()
    }
}

/// 2 つの線形 RMS のレベル差を dB で返す（`20·log10(a / b)`）。
/// per-slice gain の「スライス間 dB 差」検証に使う。`b <= 0` は `+inf`、
/// `a <= 0` は `-inf`。
pub fn db_difference(a: f32, b: f32) -> f32 {
    if b <= 0.0 {
        return f32::INFINITY;
    }
    if a <= 0.0 {
        return f32::NEG_INFINITY;
    }
    20.0 * (a / b).log10()
}

/// 等パワー pan 則を L/R RMS から **独立に逆算** する（レンダラの `cos`/`sin` に対し
/// こちらは `atan2`）。戻り値は pan ∈ [-1, 1]。
///
/// レンダラ側の定義: `L = cos(angle)`, `R = sin(angle)`, `angle ∈ [0, π/2]`,
/// `pan01 = angle / (π/2)`, `pan = 2·pan01 − 1`。よって `angle = atan2(R, L)`。
///
/// 両者 0（無音）は `atan2(0, 0) = 0` → pan = −1 を返すが、無音区間に対して
/// 呼ぶことは想定しない（呼び出し側で RMS が floor 以上であることを確認すること）。
pub fn pan_from_lr_rms(l_rms: f32, r_rms: f32) -> f32 {
    let angle = r_rms.atan2(l_rms); // 非負 RMS なら [0, π/2]
    let pan01 = angle / std::f32::consts::FRAC_PI_2;
    (pan01 * 2.0 - 1.0).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_audio(data: Vec<f32>, channels: u16) -> CapturedAudio {
        CapturedAudio::new(data, channels, 48_000)
    }

    #[test]
    fn region_rms_of_constant_equals_that_constant() {
        // 定数 0.5 の mono → RMS は 0.5。
        let a = mk_audio(vec![0.5f32; 100], 1);
        assert!((channel_rms(&a, 0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn region_rms_windows_and_clamps() {
        // frame 0..5 が 1.0、5..10 が 0.0 の mono。窓 [0,5) は 1.0、[5,10) は 0.0。
        let mut data = vec![1.0f32; 5];
        data.extend(vec![0.0f32; 5]);
        let a = mk_audio(data, 1);
        assert!((region_rms(&a, 0, 0, 5) - 1.0).abs() < 1e-6);
        assert!(region_rms(&a, 0, 5, 10).abs() < 1e-6);
        // end が frames を超えても clamp して panic しない。
        assert!((region_rms(&a, 0, 0, 999) - (5.0f32 / 10.0).sqrt()).abs() < 1e-6);
    }

    #[test]
    fn channel_peak_picks_max_abs() {
        // L = [0.2, -0.9], R = [0.1, 0.3] interleaved。
        let a = mk_audio(vec![0.2, 0.1, -0.9, 0.3], 2);
        assert!((channel_peak(&a, 0) - 0.9).abs() < 1e-6);
        assert!((channel_peak(&a, 1) - 0.3).abs() < 1e-6);
    }

    #[test]
    fn pan_inversion_hits_known_anchors() {
        let k = std::f32::consts::FRAC_1_SQRT_2; // 中央の左右ゲイン
        // hard-left: R=0 → pan -1。
        assert!((pan_from_lr_rms(1.0, 0.0) - (-1.0)).abs() < 1e-5);
        // hard-right: L=0 → pan +1。
        assert!((pan_from_lr_rms(0.0, 1.0) - 1.0).abs() < 1e-5);
        // center: L=R=1/√2 → pan 0。
        assert!(pan_from_lr_rms(k, k).abs() < 1e-5);
        // pan -0.5 → angle π/8 → L=cos(π/8), R=sin(π/8)。
        let l = (std::f32::consts::PI / 8.0).cos();
        let r = (std::f32::consts::PI / 8.0).sin();
        assert!((pan_from_lr_rms(l, r) - (-0.5)).abs() < 1e-5);
    }

    #[test]
    fn db_difference_matches_known_ratios() {
        // 2 倍 → +6.02 dB。
        assert!((db_difference(1.0, 0.5) - 6.0206).abs() < 1e-3);
        // 同値 → 0 dB。
        assert!(db_difference(0.3, 0.3).abs() < 1e-5);
        // -6 dB ≈ 0.5 倍。
        assert!((db_difference(0.5, 1.0) - (-6.0206)).abs() < 1e-3);
    }

    #[test]
    fn linear_to_db_handles_zero_and_unity() {
        assert!((linear_to_db(1.0)).abs() < 1e-5); // 0 dBFS
        assert_eq!(linear_to_db(0.0), f32::NEG_INFINITY);
        assert!((linear_to_db(0.5) - (-6.0206)).abs() < 1e-3);
    }
}
