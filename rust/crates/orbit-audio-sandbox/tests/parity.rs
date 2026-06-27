//! A/B parity 統合テスト(γ M1 検証 (a) audio 正しさ・CI 実行可)。
//!
//! out-of-process の gain child を実際に spawn し、共有メモリ越しに同期処理した出力が、
//! in-process gain 参照と **sample-exact** に一致することを確認する。これで transport
//! (mmap + SPSC handshake + slot index)+ child round-trip が end-to-end に健全であることを、
//! audio device 無し(CI)で証明する。gain は決定論的な f32 乗算なので両側 bit 一致するはず。

use std::path::PathBuf;

use orbit_audio_sandbox::{
    max_abs_diff, render_in_process_gain, render_through_child_sync, CHANNELS,
};

/// cargo がビルドした gain child binary の path。
fn child_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_sandbox-effect-child"))
}

/// 決定論的なテスト信号(複数 block にまたがる傾斜 + 符号変化)。
fn make_signal(total_frames: usize) -> Vec<f32> {
    (0..total_frames * CHANNELS)
        .map(|i| {
            // -0.9..0.9 を行き来する決定論波形(block 境界をまたいで連続)。
            let t = i as f32;
            0.9 * ((t * 0.013).sin())
        })
        .collect()
}

#[test]
fn out_of_process_gain_matches_in_process_sample_exact() {
    let gain = 0.5f32;
    // block 境界をまたぐよう、block_frames の整数倍でないフレーム数も含める。
    for &(total_frames, block_frames) in &[(64, 64), (256, 64), (300, 64), (512, 128)] {
        let input = make_signal(total_frames);
        let reference = render_in_process_gain(&input, gain);
        let gain_arg = gain.to_string();
        let through_child =
            render_through_child_sync(&child_exe(), &input, block_frames, &["--gain", &gain_arg])
                .expect("child round-trip 成功");

        assert_eq!(
            through_child.len(),
            reference.len(),
            "出力長一致(total={total_frames}, block={block_frames})"
        );
        let diff = max_abs_diff(&through_child, &reference);
        assert_eq!(
            diff, 0.0,
            "out-of-process gain は in-process と sample-exact 一致(total={total_frames}, block={block_frames}, diff={diff})"
        );
    }
}

#[test]
fn out_of_process_unity_gain_is_passthrough() {
    let input = make_signal(128);
    let through_child = render_through_child_sync(&child_exe(), &input, 64, &["--gain", "1.0"])
        .expect("child round-trip 成功");
    let diff = max_abs_diff(&through_child, &input);
    assert_eq!(diff, 0.0, "gain=1.0 は入力をそのまま返す(diff={diff})");
}
