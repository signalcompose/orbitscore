//! capture 経路を通す統合テスト: onset 検出と末尾 fade 線形性。
//!
//! レンダラを実際に動かして PCM を捕捉し、`detect_onset_threshold` と
//! `fade_slope_is_linear` が正しく動くことを確認する。
//! 実 WAV は使わず、合成 `Sample` のみ使用（test-assets 非依存）。

use orbit_audio_core::{Sample, ScheduledSample, Scheduler};
use orbit_audio_verify::{capture, detect_onset_threshold, fade_slope_is_linear};

const SR: u32 = 48_000;
const CHANNELS: u16 = 2;
/// block_frames は 512（実 cpal callback を模す粒度）。
const BLOCK: usize = 512;

// ─── テスト 1: onset 検出（block 境界をまたぐ位置） ─────────────────────────

/// 定数振幅 1.0 の mono slice を block 境界をまたぐフレーム（600）に置き、
/// capture → detect_onset_threshold がその開始フレームを検出できることを確認する。
///
/// 本レンダラは attack フェードを持たないため、開始フレームからいきなり定常振幅に
/// 達する。hard-left（pan=-1）でL チャンネルがそのまま 1.0 になる。
/// 閾値 0.5 < 1.0 なので正確に frame=600 で検出できる。
#[test]
fn onset_threshold_detects_exact_start_across_block_boundary() {
    // 開始フレーム 600 は BLOCK=512 をまたぐ（512 の倍数ではない）。
    let start_frame = 600usize;
    let slice_len = 300usize;
    let total_frames = start_frame + slice_len + 200;

    let sample = Sample::new(vec![1.0f32; slice_len], SR, 1);
    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(start_frame as f64 / SR as f64, sample)
            .with_pan(-1.0) // hard-left: L=1.0, R=0.0
            .with_region(0, slice_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    // L チャンネル（ch=0）で onset を検出する。閾値 0.5。
    let onset = detect_onset_threshold(&cap, 0, 0.5);
    assert_eq!(
        onset,
        Some(start_frame),
        "onset を正確に検出できるはず。検出フレーム={onset:?}"
    );

    // スタート前は無音。
    assert!(
        cap.at(start_frame - 1, 0).abs() < 1e-6,
        "開始フレームの直前は無音のはず"
    );
}

// ─── テスト 2: 末尾 fade の線形性（capture 経由） ────────────────────────────

/// 定数振幅 1.0 の mono slice を hard-left でスケジュール → capture。
/// 末尾 fade 窓の L 値列を取り出し `fade_slope_is_linear` が true になることを確認。
///
/// fade_frames の算出式（scheduler.rs の実装と同じ式、期待値を手計算で直書き）:
///   slice_len = 1000 フレーム
///   out_dur_sec = 1000 / 48000 ≈ 0.02083 s
///   fade_sec = min(0.02083 * 0.04, 0.008) = min(0.000833..., 0.008) = 0.000833...
///   fade_frames = round(0.000833... * 48000) = round(40.0) = 40 フレーム
///
/// fade 窓の L 値は本体 1.0 から始まり線形に下がる（厳密に 0 には達しない点に注意:
/// 末尾は 1/40 = 0.025 で終わる）。`fade_slope_is_linear` は linearity を slope の
/// 線形性で判定し、終端値が 0 かどうかは問わない。
#[test]
fn fade_tail_captured_in_l_channel_is_linear() {
    let slice_len = 1000usize;

    // 手計算 fade_frames（GRM 独立性: scheduler.rs を import せず直書き）。
    // slice_len=1000, sr=48000:
    //   fade_sec = min(1000/48000 * 0.04, 0.008) = min(0.00083333, 0.008) = 0.00083333
    //   fade_frames = round(0.00083333 * 48000) = round(40.0) = 40
    let fade_frames: usize = 40;

    let start_frame = 100usize;
    let total_frames = start_frame + slice_len + 200;

    let sample = Sample::new(vec![1.0f32; slice_len], SR, 1);
    let mut s = Scheduler::new(SR, CHANNELS);
    s.schedule(
        ScheduledSample::new(start_frame as f64 / SR as f64, sample)
            .with_pan(-1.0) // hard-left: L=1.0, R=0.0
            .with_region(0, slice_len),
    );

    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK);

    // fade 開始フレーム（出力時間軸）= start_frame + (slice_len - fade_frames)
    let fade_abs_start = start_frame + (slice_len - fade_frames);

    // fade 窓の L 値列を取り出す（|値|）。
    let envelope: Vec<f32> = (fade_abs_start..start_frame + slice_len)
        .map(|f| cap.at(f, 0).abs())
        .collect();

    assert_eq!(
        envelope.len(),
        fade_frames,
        "fade 窓の長さが一致するはず"
    );

    // body（fade 前）は定常 1.0 であることを確認（body 窓の先頭を数点）。
    let body_check = cap.at(start_frame, 0).abs();
    assert!(
        (body_check - 1.0).abs() < 1e-5,
        "body の振幅は 1.0 のはず: {body_check}"
    );

    // fade 先頭値は 1.0 付近（線形 1→1/40 の最初）。
    assert!(
        envelope[0] > 0.9,
        "fade 先頭値は本体振幅に近いはず: {}",
        envelope[0]
    );

    // 線形性の判定。tolerance = 0.05（5% 正規化 RMSE）。
    assert!(
        fade_slope_is_linear(&envelope, 0.05),
        "末尾 fade は線形であるはず。最初={:.4} 末尾={:.4}",
        envelope.first().unwrap_or(&0.0),
        envelope.last().unwrap_or(&0.0),
    );

    // 末尾値が実際に下降していることを確認する。定数列（slope=0）も「線形」と判定される
    // ため、fade_slope_is_linear だけでは「fade を落とさず定常 1.0 を出す」回帰を捕まえ
    // られない。線形 release の最終フレーム env = (slice_len - (slice_len-1)) / fade_frames
    // = 1/fade_frames = 1/40 = 0.025（手計算直書き・GRM 独立）。
    let terminal = *envelope.last().expect("fade 窓は非空のはず");
    let expected_terminal = 1.0 / fade_frames as f32;
    assert!(
        (terminal - expected_terminal).abs() < 0.01,
        "fade 末尾値が期待値外: expected ≈ {expected_terminal:.4}, got {terminal:.4}"
    );
}
