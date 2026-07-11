use std::path::PathBuf;
use std::process::Command;

use orbit_audio_sandbox::{
    max_abs_diff, render_in_process_gain, render_through_child_sync, CHANNELS, MAX_FRAMES,
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
    PathBuf::from(env!("CARGO_BIN_EXE_orbit-vst3-effect-child"))
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
        let through_child = render_through_child_sync(
            &child_exe(),
            &input,
            block_frames,
            &["--plugin", plugin, "--sample-rate", SAMPLE_RATE],
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
