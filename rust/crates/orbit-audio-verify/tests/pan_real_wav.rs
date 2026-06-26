//! 実 WAV を end-to-end で捕捉する spine テスト。
//!
//! `test-assets/audio/sine_440.wav`（1ch / 48kHz / 1.0s の純 sine）を実ローダで
//! ロードし、hard-left / center / hard-right の 3 イベントを既知タイムラインに
//! スケジュール → [`capture`] で決定論レンダ → L/R RMS から **独立に** pan を逆算して
//! 指令値と突き合わせる。これが #307 の検証パイプラインの背骨（実 WAV → render →
//! PCM アサート）であり、#304 の pan を耳に依らず裏付ける最初のケース。

use orbit_audio_core::{Sample, ScheduledSample, Scheduler};
use orbit_audio_native::load_sample_resampled;
use orbit_audio_verify::{capture, channel_rms, pan_from_lr_rms, region_rms, PAN_TOLERANCE};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// 実 cpal callback を模す block 粒度。下のイベント開始は意図的にこの倍数から
/// 外し、`dst_offset_frames` の block またぎを通す。
const BLOCK_FRAMES: usize = 512;

fn sine_440() -> Sample {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test-assets/audio/sine_440.wav"
    );
    load_sample_resampled(path, SAMPLE_RATE).expect("load sine_440.wav")
}

/// pan を変えた 3 イベントを別々の時間窓に置いて捕捉する。
/// 各イベント: 開始フレーム / slice 長 4800（0.1s, 44 周期で RMS 安定）。
#[test]
fn pan_is_recoverable_from_real_wav_render() {
    let sample = sine_440();
    assert_eq!(sample.channels, 1, "fixture must be mono");
    assert!(sample.frames() >= 25_000, "fixture too short");

    let slice_len = 4_800usize; // 0.1s
                                // 開始フレームはいずれも BLOCK_FRAMES(512) の倍数ではない（境界またぎを通す）。
                                // 中間値（±0.5）を含めるのが要: ±1/0 だけだと片 ch=0 / L=R となり、等パワー則を
                                // 線形則など他の対称 pan 則から判別できない（どの則でも通ってしまう）。pan=-0.5 では
                                // 等パワー L=cos(π/8)≈0.924 / R=sin(π/8)≈0.383 → atan2 で -0.5、線形則なら ≈-0.59 と
                                // なり PAN_TOLERANCE を超えて落ちる。
    let events = [
        (1_000usize, -1.0f32, -1.0f32), // (start, commanded pan, expected pan) hard-left
        (10_000usize, -0.5f32, -0.5f32), // 中間左（判別の鍵）
        (20_000usize, 0.0f32, 0.0f32),  // center
        (30_000usize, 0.5f32, 0.5f32),  // 中間右（判別の鍵）
        (40_000usize, 1.0f32, 1.0f32),  // hard-right
    ];

    let mut s = Scheduler::new(SAMPLE_RATE, CHANNELS);
    for (start, pan, _) in events {
        s.schedule(
            ScheduledSample::new(start as f64 / SAMPLE_RATE as f64, sample.clone())
                .with_pan(pan)
                .with_region(0, slice_len),
        );
    }

    let total_frames = 46_000usize; // 全イベントを含む
    let cap = capture(&mut s, CHANNELS, total_frames, BLOCK_FRAMES);

    for (start, commanded, expected) in events {
        // body 窓: 開始直後と末尾 fade を避ける。fade_frames = min(0.1s*0.04, 0.008s)*48000
        // = min(0.004s, 0.008s)*48000 = 192 フレーム < 256 マージン。
        // pan は左右で同包絡なので fade は比に効かないが、安全側で本体のみを測る。
        let w_start = start + 256;
        let w_end = start + slice_len - 256;
        let l = region_rms(&cap, 0, w_start, w_end);
        let r = region_rms(&cap, 1, w_start, w_end);
        // 信号があることを確認（無音に pan_from_lr_rms を当てない）。
        assert!(
            l.max(r) > 1e-3,
            "pan={commanded}: window has no signal (L={l}, R={r})"
        );
        let measured = pan_from_lr_rms(l, r);
        assert!(
            (measured - expected).abs() <= PAN_TOLERANCE,
            "commanded pan {commanded} → expected {expected}, measured {measured} (L={l:.5}, R={r:.5})"
        );
    }

    // 念のため: イベント間（5000〜9000）はどのチャンネルも無音。
    let gap_l = region_rms(&cap, 0, 6_000, 9_000);
    let gap_r = region_rms(&cap, 1, 6_000, 9_000);
    assert!(gap_l < 1e-5 && gap_r < 1e-5, "gap must be silent");
    // channel_rms（全体）も呼べる公開 API であることを軽く確認。
    let _ = channel_rms(&cap, 0);
}
