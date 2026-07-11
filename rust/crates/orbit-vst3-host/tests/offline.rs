#![cfg(target_os = "macos")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use orbit_vst3_host::Vst3EffectProcessor;

const SAMPLE_RATE: f64 = 48_000.0;
const FRAMES: usize = 512;

#[test]
fn gain_oracle_is_sample_exact() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };

    let (mut processor, info) = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32)
        .unwrap_or_else(|error| {
            panic!("failed to load oracle bundle {}: {error}", bundle.display())
        });
    assert!(info.is_effect, "oracle must be detected as an effect");
    assert_eq!(info.audio_inputs, 1);
    assert_eq!(info.audio_outputs, 1);

    let (input_l, input_r) = known_stereo_input();
    let mut output_l = vec![0.0; FRAMES];
    let mut output_r = vec![0.0; FRAMES];

    processor
        .process_stereo(&input_l, &input_r, &mut output_l, &mut output_r, None)
        .expect("oracle identity process");
    assert_eq!(output_l, input_l, "default gain=1.0 left must be bit-exact");
    assert_eq!(
        output_r, input_r,
        "default gain=1.0 right must be bit-exact"
    );

    output_l.fill(0.0);
    output_r.fill(0.0);
    processor
        .process_stereo(&input_l, &input_r, &mut output_l, &mut output_r, Some(0.5))
        .expect("oracle gain=0.5 process");

    for (index, (actual, input)) in output_l.iter().zip(&input_l).enumerate() {
        assert_eq!(
            actual.to_bits(),
            (*input * 0.5).to_bits(),
            "gain=0.5 left sample {index}"
        );
    }
    for (index, (actual, input)) in output_r.iter().zip(&input_r).enumerate() {
        assert_eq!(
            actual.to_bits(),
            (*input * 0.5).to_bits(),
            "gain=0.5 right sample {index}"
        );
    }
}

// I5(pr-review-team): `process_block`'s guard clauses (non-multiple-of-channels length, scratch
// overflow) return `false` before ever touching COM — untested until now.
#[test]
fn process_block_rejects_non_stereo_length() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _info) = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32)
        .unwrap_or_else(|error| {
            panic!("failed to load oracle bundle {}: {error}", bundle.display())
        });

    // Odd length: not a multiple of DEFAULT_CHANNELS(2).
    let mut data = vec![0.25f32; 3];
    assert!(
        !processor.process_block(&mut data),
        "non-multiple-of-channels length must be rejected"
    );
}

#[test]
fn process_block_rejects_frames_exceeding_scratch() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _info) = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32)
        .unwrap_or_else(|error| {
            panic!("failed to load oracle bundle {}: {error}", bundle.display())
        });

    // FRAMES(512) is the scratch length (max_samples_per_block); one frame beyond that must fail.
    let mut data = vec![0.25f32; (FRAMES + 1) * 2];
    assert!(
        !processor.process_block(&mut data),
        "frame count exceeding scratch length must be rejected"
    );
}

#[test]
fn real_vst3_abi_loads_processes_and_drops() {
    let candidates = real_plugin_candidates();
    if candidates.is_empty() {
        eprintln!("LOUD SKIP: no VST3 bundles found in /Library/Audio/Plug-Ins/VST3");
        return;
    }

    let mut attempts = Vec::new();
    for path in &candidates {
        let output = Command::new(vst3_probe_path()).arg(path).output();
        match output {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                eprintln!("real VST3 ABI test loaded and processed: {}", stdout.trim());
                return;
            }
            Ok(output) => attempts.push(format!(
                "{}: status={} stdout={} stderr={}",
                path.display(),
                output.status,
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => attempts.push(format!(
                "{}: failed to spawn probe: {error}",
                path.display()
            )),
        }
    }

    panic!(
        "STOP gate: no real VST3 plugin could load->setup->process among {} candidates:\n{}",
        candidates.len(),
        attempts.join("\n")
    );
}

fn vst3_probe_path() -> PathBuf {
    option_env!("CARGO_BIN_EXE_vst3_probe")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/vst3_probe")
        })
}

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

fn known_stereo_input() -> (Vec<f32>, Vec<f32>) {
    let left = (0..FRAMES)
        .map(|i| (i as f32 - 128.0) / 512.0)
        .collect::<Vec<_>>();
    let right = (0..FRAMES)
        .map(|i| ((i as f32 * 3.0) - 256.0) / 1024.0)
        .collect::<Vec<_>>();
    (left, right)
}

fn real_plugin_candidates() -> Vec<PathBuf> {
    let root = Path::new("/Library/Audio/Plug-Ins/VST3");
    let preferred = [
        "Vocal Doubler.vst3",
        "Vinyl.vst3",
        "V-Pan.vst3",
        "Relay.vst3",
    ];
    let mut paths = preferred
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.exists())
        .collect::<Vec<_>>();

    if let Ok(entries) = fs::read_dir(root) {
        let mut rest = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("vst3"))
            .filter(|path| !paths.contains(path))
            .collect::<Vec<_>>();
        rest.sort();
        paths.extend(rest);
    }
    paths
}
