//! #304 chop 領域の遡及検証テスト。
//!
//! 2 つの観点を検証する:
//! 1. **領域 on/off（実 WAV）**: `arpeggio_c.wav` を使い、`.with_region(offset, len)` で
//!    指定した窓に信号があり、窓外（slice 終端以降）が厳密に無音であることを確認する。
//! 2. **offset 同定（合成 ramp）**: frame 値 = frame 番号の mono ramp `Sample` を使い、
//!    `.with_region(offset, len)` で読まれる source フレームが `offset+local` と一致する
//!    ことを直接確認する（正しいオフセットを読んだ証拠）。
//!
//! GRM 独立性: `resolve_slice_region` / `equal_power_pan` を import しない。
//! 期待値（領域境界フレーム、ramp 値、dB floor）はすべてテスト側に手計算で直書き。

use orbit_audio_core::{Sample, ScheduledSample, Scheduler};
use orbit_audio_native::load_sample_resampled;
use orbit_audio_verify::{capture, region_rms};

const SR: u32 = 48_000;
const CHANNELS: u16 = 2;
const BLOCK: usize = 512;

// ─── テスト 1: 実 WAV で領域 on/off を確認 ────────────────────────────────────

/// `arpeggio_c.wav` (1.0s, 48kHz 想定) を `.with_region(offset, len)` でスケジュールし、
/// 指定領域に信号があり、slice 終端以降の出力が厳密に 0 に近いことを確認する。
///
/// 手計算した境界フレーム（GRM 独立性: `resolve_slice_region` 非使用）:
///   SR = 48_000 Hz
///   region_offset = 0.25 s × 48_000 = 12_000 フレーム
///   region_len    = 0.25 s × 48_000 = 12_000 フレーム
///   slice 終端（出力時間軸）= schedule_start + region_len = 0 + 12_000 = 12_000
///   領域外 = frame 12_000 以降は厳密に 0.0
#[test]
fn region_has_signal_and_outside_is_silent() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-assets/audio/arpeggio_c.wav"
    );
    let sample = load_sample_resampled(path, SR).expect("arpeggio_c.wav のロードに失敗");
    assert!(sample.frames() >= 48_000, "arpeggio_c.wav は 1.0s 以上必要");

    // 手計算: 0.25 s × 48000 = 12000 フレーム
    let region_offset: usize = 12_000;
    let region_len: usize = 12_000;
    let schedule_start: usize = 0;

    let total_frames = schedule_start + region_len + 6_000; // 終端後 6000 フレームを捕捉

    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(schedule_start as f64 / SR as f64, sample)
            .with_pan(0.0) // 中央パン
            .with_region(region_offset, region_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    // 領域内（body 窓）: 先頭と末尾の fade を避けた本体で信号があることを確認。
    // conservative margin として開始 256 フレーム後〜終端 256 フレーム前。
    let body_start = schedule_start + 256;
    let body_end = schedule_start + region_len - 256;
    let body_rms_l = region_rms(&cap, 0, body_start, body_end);
    let body_rms_r = region_rms(&cap, 1, body_start, body_end);
    assert!(
        body_rms_l > 1e-3 || body_rms_r > 1e-3,
        "領域内に信号が必要。L_RMS={body_rms_l:.5}, R_RMS={body_rms_r:.5}"
    );

    // 領域外（slice 終端以降）: 本レンダラは加算のみで、終わったイベントからは
    // 何も書き込まれない → 厳密に 0.0。RMS < 1e-5 で確認。
    let after_start = schedule_start + region_len; // = 12_000
    let after_end = total_frames;
    let after_rms_l = region_rms(&cap, 0, after_start, after_end);
    let after_rms_r = region_rms(&cap, 1, after_start, after_end);
    assert!(
        after_rms_l < 1e-5,
        "領域外の L は無音のはず。RMS={after_rms_l:.6}"
    );
    assert!(
        after_rms_r < 1e-5,
        "領域外の R は無音のはず。RMS={after_rms_r:.6}"
    );
}

// ─── テスト 2: 合成 ramp で offset 同定 ──────────────────────────────────────

/// frame 値 = frame 番号の mono ramp サンプルを `.with_region(offset, len)` でスケジュール。
/// capture 後、本体（fade 前）の L 値が source の `offset + local_pos` に一致することを
/// フレームごとに直接確認する。
///
/// 手計算した値（GRM 独立性: `resolve_slice_region` 非使用）:
///   total_src_frames = 10_000
///   region_offset    = 2_000
///   region_len       = 1_000
///   schedule_start   = 200 フレーム（BLOCK=512 の倍数ではない）
///   hard-left: L = source[offset + local] × 1.0, R = 0.0
///
///   fade_frames（手計算）:
///     out_dur_sec = 1000 / 48000 ≈ 0.020833 s
///     fade_sec    = min(0.020833 * 0.04, 0.008) = min(0.000833, 0.008) = 0.000833
///     fade_frames = round(0.000833 * 48000) = round(40.0) = 40
///   本体窓: local_pos 0 〜 (region_len - fade_frames - 1) = 0 〜 959
///   本体内での検証: local_pos = 0, 1, 2（先頭数点で十分）
#[test]
fn region_offset_is_correctly_applied_with_ramp_sample() {
    // frame 値 = frame 番号の mono ramp
    let total_src_frames = 10_000usize;
    let ramp_data: Vec<f32> = (0..total_src_frames).map(|i| i as f32).collect();
    let sample = Sample::new(ramp_data, SR, 1);

    // 手計算パラメータ
    let region_offset: usize = 2_000;
    let region_len: usize = 1_000;
    let schedule_start: usize = 200; // BLOCK=512 の倍数でない → block またぎを通す

    // 手計算 fade_frames: region_len=1000, SR=48000
    //   fade_sec = min(1000/48000 * 0.04, 0.008) = 0.000833...
    //   fade_frames = round(40.0) = 40
    let fade_frames: usize = 40;
    let body_end_local = region_len - fade_frames; // 960

    let total_frames = schedule_start + region_len + 200;

    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(schedule_start as f64 / SR as f64, sample)
            .with_pan(-1.0) // hard-left: L = source 値そのまま
            .with_region(region_offset, region_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    // 本体先頭 3 フレームを検証（正しいオフセットを読んだ証拠）。
    // 出力フレーム (schedule_start + local_pos) の L 値 =
    //   source[region_offset + local_pos] = region_offset + local_pos
    for local_pos in 0..3usize {
        let out_frame = schedule_start + local_pos;
        let expected_l = (region_offset + local_pos) as f32;
        let actual_l = cap.at(out_frame, 0);
        assert!(
            (actual_l - expected_l).abs() < 1e-3,
            "local_pos={local_pos}: expected L={expected_l}, actual L={actual_l}"
        );
        // hard-left なので R は 0。
        let actual_r = cap.at(out_frame, 1);
        assert!(
            actual_r.abs() < 1e-6,
            "hard-left なので R は 0 のはず。actual R={actual_r}"
        );
    }

    // 本体末尾（fade 直前）でも同様に確認。
    let local_pos_check = body_end_local - 1; // 959
    let out_frame_check = schedule_start + local_pos_check;
    let expected_l_check = (region_offset + local_pos_check) as f32;
    let actual_l_check = cap.at(out_frame_check, 0);
    assert!(
        (actual_l_check - expected_l_check).abs() < 1e-3,
        "fade 直前 local_pos={local_pos_check}: expected L={expected_l_check}, actual L={actual_l_check}"
    );

    // slice 終端後（schedule_start + region_len 以降）は無音。
    let after_frame = schedule_start + region_len + 50;
    assert!(
        cap.at(after_frame, 0).abs() < 1e-6,
        "領域外フレーム {after_frame} の L は 0 のはず"
    );
}
