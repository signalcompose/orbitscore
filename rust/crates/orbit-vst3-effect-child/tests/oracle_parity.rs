use std::path::PathBuf;
use std::process::Command;

use std::time::Duration;

use orbit_audio_sandbox::{
    max_abs_diff, render_in_process_gain, render_through_child_sync_with_options,
    warm_up_executable, RenderOptions, CHANNELS, MAX_FRAMES,
};

const SAMPLE_RATE: &str = "48000";

fn package_oracle() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest_dir
        .parent()
        .expect("crate has parent")
        .join("orbit-vst3-gain-oracle")
        .join("package-oracle.sh");
    let output = Command::new(&script).output().ok()?;
    if !output.status.success() {
        eprintln!(
            "oracle packaging failed: status={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(PathBuf::from(stdout.trim()))
}

fn child_exe() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_orbit-vst3-effect-child"));
    // 🔴 #520: ビルドしたての child は初回 spawn で macOS のセキュリティ評価を伴う。
    // 評価コストを first_block_timeout の外へ出す（下の RenderOptions と2段構え）。
    warm_up_executable(&path);
    path
}

fn make_signal(total_frames: usize) -> Vec<f32> {
    (0..total_frames * CHANNELS)
        .map(|i| {
            let t = i as f32;
            0.9 * ((t * 0.013).sin())
        })
        .collect()
}

#[test]
fn vst3_gain_oracle_oop_child_is_sample_exact_passthrough() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let plugin = bundle.to_str().expect("oracle path is UTF-8");

    for &(total_frames, block_frames) in &[(64, 64), (256, 64), (300, 64), (512, 128)] {
        let input = make_signal(total_frames);
        // 🔴 #520: 初回ブロックは child の spawn を含む。macOS は**ビルドしたての実行ファイル**の
        // 初回 spawn でセキュリティ評価を行い、実測で数秒〜24 秒停止することがある
        // （詳細は tests/helpers/spawn-fixture.ts のヘッダ）。既定の 5s だと crash でないのに
        // TimedOut で false-fail する。ここで待つのは検証対象（sample-exact な passthrough か）
        // ではないので、初回だけ裾に耐える値を与える。2 ブロック目以降は既定のまま。
        let (through_child, _stats) = render_through_child_sync_with_options(
            &child_exe(),
            &input,
            block_frames,
            &["--plugin", plugin, "--sample-rate", SAMPLE_RATE],
            RenderOptions {
                first_block_timeout: Duration::from_secs(60),
                ..RenderOptions::default()
            },
        )
        .expect("child round-trip 成功");

        assert_eq!(through_child.len(), input.len());
        let diff = max_abs_diff(&through_child, &input);
        assert_eq!(
            diff, 0.0,
            "default gain=1.0 oracle must be sample-exact passthrough(total={total_frames}, block={block_frames})"
        );
    }
}

#[test]
fn vst3_gain_oracle_in_process_closed_form_remains_exact() {
    let input = make_signal(MAX_FRAMES);
    let reference = render_in_process_gain(&input, 1.0);
    assert_eq!(max_abs_diff(&input, &reference), 0.0);
}
