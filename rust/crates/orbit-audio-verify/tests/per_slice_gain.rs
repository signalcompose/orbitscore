//! #304 per-slice gain の遡及検証テスト。
//!
//! 同一 source・同一 slice 長・同一 pan（中央）で、**線形 gain** だけ変えた 2 イベントを
//! 別時間窓にスケジュール → capture → 各 body 窓の RMS → `db_difference` が
//! 期待 dB 差と `GAIN_DB_TOLERANCE`(±0.5dB) 以内で一致することを確認する。
//!
//! GRM 独立性: `equal_power_pan` / `resolve_slice_region` を import しない。
//! 期待 dB 差は `20·log10(gain_b / gain_a)` を手計算で直書き。
//!
//! 設計上の注意:
//! - gain は**線形値**で指令する（dB↔linear 変換はここでしない）。
//! - 期待 dB = 20·log10(0.5 / 1.0) = 20·log10(0.5) ≈ -6.0206 dB（手計算直書き）。
//! - 両イベントで source・slice_len・pan が同一なので、gain 比がそのまま RMS 比になる。
//!   中央パン（等パワー -3dB）は両 ch 等倍に掛かるので RMS 比には現れない。
//! - body 窓は onset 直後と末尾 fade を除外する（fade_frames を手計算で求めて窓を決定）。

use orbit_audio_core::{Sample, ScheduledSample, Scheduler};
use orbit_audio_verify::{capture, db_difference, region_rms, GAIN_DB_TOLERANCE};

const SR: u32 = 48_000;
const CHANNELS: u16 = 2;
const BLOCK: usize = 512;

// ─── per-slice gain テスト ─────────────────────────────────────────────────────

/// gain 1.0 と gain 0.5 のイベントを別時間窓に置き、
/// body RMS の dB 差が ≈ -6.0206 dB になることを確認する。
///
/// 手計算した各定数（GRM 独立性: scheduler.rs の関数を non-import）:
///
/// source: 定数 1.0 の mono 5000 フレーム（両イベントで同一クローン）
/// slice_len = 5000 フレーム
/// pan = 0.0（中央）
///
/// fade_frames の手計算（slice_len=5000, SR=48000）:
///   out_dur_sec = 5000 / 48000 ≈ 0.10417 s
///   fade_sec    = min(0.10417 * 0.04, 0.008) = min(0.004167, 0.008) = 0.004167 s
///   fade_frames = round(0.004167 * 48000) = round(200.0) = 200 フレーム
///
/// body 窓: onset 後 256 フレーム〜終端 256 フレーム前（conservative margin）
///   body_start = schedule_start + 256
///   body_end   = schedule_start + slice_len - 256
///
/// 期待 dB 差（手計算直書き）:
///   gain_a = 1.0, gain_b = 0.5
///   expected_db = 20 * log10(0.5 / 1.0) = 20 * log10(0.5) ≈ -6.0206 dB
///   db_difference(rms_b, rms_a) = 20 * log10(rms_b / rms_a) ≈ -6.0206 dB
#[test]
fn per_slice_gain_ratio_is_reflected_in_rms_db_difference() {
    // 定数 1.0 の mono source（両イベントで同一素材を使う）。
    let slice_len = 5_000usize;
    let source = Sample::new(vec![1.0f32; slice_len], SR, 1);

    // イベント A: gain=1.0, 開始フレーム 1000（BLOCK=512 の倍数でない）
    let start_a: usize = 1_000;
    let gain_a: f32 = 1.0;

    // イベント B: gain=0.5, 開始フレーム 10000（A と重ならない）
    let start_b: usize = 10_000;
    let gain_b: f32 = 0.5;

    // 期待 dB 差（手計算直書き）: 20 * log10(0.5 / 1.0) ≈ -6.0206 dB
    let expected_db: f32 = -6.0206;

    let total_frames = start_b + slice_len + 1_000;

    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(start_a as f64 / SR as f64, source.clone())
            .with_gain(gain_a)
            .with_pan(0.0)
            .with_region(0, slice_len),
    );
    s.schedule(
        ScheduledSample::new(start_b as f64 / SR as f64, source.clone())
            .with_gain(gain_b)
            .with_pan(0.0)
            .with_region(0, slice_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    // body 窓（conservative margin: onset +256 / 終端 -256）。
    // この margin は fade_frames=200 より十分大きいため fade の影響を除外できる。
    let body_margin = 256usize;
    let body_a_start = start_a + body_margin;
    let body_a_end = start_a + slice_len - body_margin;
    let body_b_start = start_b + body_margin;
    let body_b_end = start_b + slice_len - body_margin;

    // L チャンネル RMS（中央パンなので L も R も等倍。L だけで比較）。
    let rms_a = region_rms(&cap, 0, body_a_start, body_a_end);
    let rms_b = region_rms(&cap, 0, body_b_start, body_b_end);

    // 両イベントに信号がある（無音に db_difference を当てない）。
    assert!(
        rms_a > 1e-3,
        "イベント A に信号が必要。rms_a={rms_a:.5}"
    );
    assert!(
        rms_b > 1e-3,
        "イベント B に信号が必要。rms_b={rms_b:.5}"
    );

    // dB 差: db_difference(rms_b, rms_a) = 20·log10(rms_b / rms_a)
    // gain_b=0.5 なので rms_b < rms_a → 負の値になる（expected_db ≈ -6.02 dB）。
    let measured_db = db_difference(rms_b, rms_a);
    assert!(
        (measured_db - expected_db).abs() <= GAIN_DB_TOLERANCE,
        "dB 差が期待値外。expected={expected_db:.4} dB, measured={measured_db:.4} dB, \
         tolerance=±{GAIN_DB_TOLERANCE} dB"
    );
}

/// gain 1.0 と gain 2.0 のイベントを別時間窓に置き、
/// body RMS の dB 差が ≈ +6.0206 dB になることを確認する（逆方向の検証）。
///
/// 期待 dB 差（手計算直書き）: 20 * log10(2.0 / 1.0) ≈ +6.0206 dB
#[test]
fn per_slice_gain_double_is_plus_6db() {
    let slice_len = 5_000usize;
    let source = Sample::new(vec![1.0f32; slice_len], SR, 1);

    let start_a: usize = 1_000;
    let gain_a: f32 = 1.0;

    let start_b: usize = 10_000;
    let gain_b: f32 = 2.0;

    // 期待 dB 差（手計算直書き）: 20 * log10(2.0 / 1.0) ≈ +6.0206 dB
    let expected_db: f32 = 6.0206;

    let total_frames = start_b + slice_len + 1_000;

    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(start_a as f64 / SR as f64, source.clone())
            .with_gain(gain_a)
            .with_pan(0.0)
            .with_region(0, slice_len),
    );
    s.schedule(
        ScheduledSample::new(start_b as f64 / SR as f64, source.clone())
            .with_gain(gain_b)
            .with_pan(0.0)
            .with_region(0, slice_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    let body_margin = 256usize;
    let rms_a = region_rms(&cap, 0, start_a + body_margin, start_a + slice_len - body_margin);
    let rms_b = region_rms(&cap, 0, start_b + body_margin, start_b + slice_len - body_margin);

    assert!(rms_a > 1e-3, "イベント A に信号が必要。rms_a={rms_a:.5}");
    assert!(rms_b > 1e-3, "イベント B に信号が必要。rms_b={rms_b:.5}");

    // db_difference(rms_b, rms_a) = 20·log10(rms_b / rms_a) ≈ +6.0206 dB
    let measured_db = db_difference(rms_b, rms_a);
    assert!(
        (measured_db - expected_db).abs() <= GAIN_DB_TOLERANCE,
        "dB 差が期待値外。expected={expected_db:.4} dB, measured={measured_db:.4} dB, \
         tolerance=±{GAIN_DB_TOLERANCE} dB"
    );
}
