#![cfg(target_os = "macos")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use orbit_vst3_host::{
    Vst3EffectProcessor, Vst3HostError, Vst3InstrumentProcessor, Vst3ProcessMode,
};

const SAMPLE_RATE: f64 = 48_000.0;
const FRAMES: usize = 512;

#[test]
fn gain_oracle_is_sample_exact() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };

    let (mut processor, info) =
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load oracle bundle {}: {error}", bundle.display()),
        );
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

#[test]
fn offline_mode_reaches_effect_setup_and_process_data() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _) = Vst3EffectProcessor::load_with_process_mode(
        &bundle,
        SAMPLE_RATE,
        FRAMES as i32,
        None,
        Vst3ProcessMode::Offline,
    )
    .expect("load effect in offline mode");
    let mut data = vec![0.25; FRAMES * 2];
    assert!(
        processor.process_block(&mut data),
        "oracle rejects a setup/process mode mismatch"
    );
    assert!(
        data.iter().all(|sample| *sample == -0.25),
        "offline mode must reach the effect oracle as kOffline"
    );
}

#[test]
fn effect_state_round_trip_restores_the_live_gain() {
    use orbit_vst3_gain_oracle::{encode_state, STATE_LEN};

    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let (input_l, input_r) = known_stereo_input();
    let mut output_l = vec![0.0; FRAMES];
    let mut output_r = vec![0.0; FRAMES];
    let (mut changed, _) = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None)
        .expect("load effect before state capture");
    changed
        .process_stereo(&input_l, &input_r, &mut output_l, &mut output_r, Some(0.25))
        .expect("set observable oracle gain");
    let state = changed.capture_state().expect("capture live effect state");
    assert_eq!(state, encode_state(0.25));
    assert_eq!(state.len(), STATE_LEN);
    drop(changed);

    output_l.fill(0.0);
    output_r.fill(0.0);
    let (mut restored, _) =
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&state))
            .expect("restore effect state before activation");
    restored
        .process_stereo(&input_l, &input_r, &mut output_l, &mut output_r, None)
        .expect("process with restored gain");
    for (actual, input) in output_l.iter().zip(&input_l) {
        assert_eq!(actual.to_bits(), (*input * 0.25).to_bits());
    }

    let corrupt = b"not-an-effect-state";
    assert!(Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(corrupt)).is_err());
}

#[test]
fn synth_oracle_sounds_then_silences_on_note_off() {
    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, info) =
        Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load synth oracle {}: {error}", bundle.display()),
        );
    assert!(!info.is_effect, "oracle must be detected as an instrument");
    assert_eq!(info.audio_inputs, 0);
    assert_eq!(info.audio_outputs, 1);

    processor.push_note_on(0, 69, 0.8, 0);
    let mut audio = vec![0.0; FRAMES * 2];
    assert!(processor.process_block(&mut audio));
    audio.fill(0.0);
    assert!(processor.process_block(&mut audio));
    let peak = audio
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    assert!(
        (peak - 0.25).abs() <= 0.01,
        "synth peak was {peak}, expected 0.25 +/- 0.01"
    );

    processor.push_note_off(0, 69, 0.0, 0);
    audio.fill(0.0);
    assert!(processor.process_block(&mut audio));
    assert!(processor.process_block(&mut audio));
    assert!(
        audio.iter().all(|sample| *sample == 0.0),
        "note-off must return output to silence"
    );
}

#[test]
fn offline_mode_reaches_instrument_setup_and_process_data() {
    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _) = Vst3InstrumentProcessor::load_with_process_mode(
        &bundle,
        SAMPLE_RATE,
        FRAMES as i32,
        None,
        Vst3ProcessMode::Offline,
    )
    .expect("load instrument in offline mode");
    processor.push_note_on(0, 69, 0.8, 0);
    let mut data = vec![0.0; FRAMES * 2];
    assert!(
        processor.process_block(&mut data),
        "oracle rejects a setup/process mode mismatch"
    );
    let peak = data.iter().copied().map(f32::abs).fold(0.0, f32::max);
    assert!(
        (peak - 0.125).abs() <= 0.01,
        "offline mode must reach the synth oracle as kOffline; peak={peak}"
    );
}

#[test]
fn instrument_loader_rejects_gain_effect_oracle() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let error = match Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None) {
        Ok(_) => panic!("effect oracle must not load as an instrument"),
        Err(error) => error,
    };
    assert!(matches!(error, Vst3HostError::NotInstrument { .. }));
}

// I5(pr-review-team): `process_block`'s guard clauses (non-multiple-of-channels length, scratch
// overflow) return `false` before ever touching COM — untested until now.
#[test]
fn process_block_rejects_non_stereo_length() {
    let Some(bundle) = package_oracle() else {
        eprintln!("VST3 oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _info) =
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load oracle bundle {}: {error}", bundle.display()),
        );

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
    let (mut processor, _info) =
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load oracle bundle {}: {error}", bundle.display()),
        );

    // FRAMES(512) is the scratch length (max_samples_per_block); one frame beyond that must fail.
    let mut data = vec![0.25f32; (FRAMES + 1) * 2];
    assert!(
        !processor.process_block(&mut data),
        "frame count exceeding scratch length must be rejected"
    );
}

// Mirror of process_block_rejects_non_stereo_length / process_block_rejects_frames_exceeding_scratch
// for Vst3InstrumentProcessor (Fix 1: guard early-returns must clear queued input events so a
// rejected block's note doesn't leak into the next successful block at a stale sample offset).
#[test]
fn instrument_process_block_rejects_non_stereo_length() {
    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _info) =
        Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load synth oracle {}: {error}", bundle.display()),
        );

    processor.push_note_on(0, 69, 0.8, 0);
    // Odd length: not a multiple of DEFAULT_CHANNELS(2).
    let mut data = vec![0.0f32; 3];
    assert!(
        !processor.process_block(&mut data),
        "non-multiple-of-channels length must be rejected"
    );

    // The queued note must not leak into the next (valid, silent) block.
    let mut audio = vec![0.0f32; FRAMES * 2];
    assert!(
        processor.process_block(&mut audio),
        "valid block after a rejected block must succeed"
    );
    let peak = audio
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(peak, 0.0, "rejected block's queued note must not sound");
}

#[test]
fn instrument_process_block_rejects_frames_exceeding_scratch() {
    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };
    let (mut processor, _info) =
        Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None).unwrap_or_else(
            |error| panic!("failed to load synth oracle {}: {error}", bundle.display()),
        );

    processor.push_note_on(0, 69, 0.8, 0);
    // FRAMES(512) is the scratch length (max_samples_per_block); one frame beyond that must fail.
    let mut data = vec![0.0f32; (FRAMES + 1) * 2];
    assert!(
        !processor.process_block(&mut data),
        "frame count exceeding scratch length must be rejected"
    );

    // The queued note must not leak into the next (valid, silent) block.
    let mut audio = vec![0.0f32; FRAMES * 2];
    assert!(
        processor.process_block(&mut audio),
        "valid block after a rejected block must succeed"
    );
    let peak = audio
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(peak, 0.0, "rejected block's queued note must not sound");
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
    static ORACLE: OnceLock<Option<PathBuf>> = OnceLock::new();
    ORACLE
        .get_or_init(|| run_package_script("orbit-vst3-gain-oracle"))
        .clone()
}

fn package_synth_oracle() -> Option<PathBuf> {
    // package 手順は oracle 自身が持つ（`orbit-vst3-instrument-child` の配線テストとの共有）。
    orbit_vst3_synth_oracle::package_bundle()
}

/// `crates/<crate_dir>/package-oracle.sh` を実行して bundle の絶対パスを得る（失敗は loud skip）。
fn run_package_script(crate_dir: &str) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest_dir
        .parent()
        .expect("crate has parent")
        .join(crate_dir)
        .join("package-oracle.sh");
    let output = Command::new(&script).output().ok()?;
    if !output.status.success() {
        eprintln!(
            "{crate_dir} packaging failed: status={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }
    Some(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
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

/// 実測した基本周波数（ゼロ交差の平均間隔から求める・単調な正弦波前提）。
///
/// 期待値は **仕様の式**（`orbit_vst3_synth_oracle::voice_frequency_hz`）から導出し、
/// 実装が出した値と付き合わせない（E2E_HARNESS_SPEC の改ざん耐性）。
fn measured_frequency_hz(interleaved_stereo: &[f32], sample_rate: f64) -> f64 {
    // 左チャンネルのみを見る。正 → 負 の交差回数から周期を数える。
    let left: Vec<f32> = interleaved_stereo.iter().step_by(2).copied().collect();
    let mut crossings = 0usize;
    let mut first = None;
    let mut last = 0usize;
    for i in 1..left.len() {
        if left[i - 1] <= 0.0 && left[i] > 0.0 {
            if first.is_none() {
                first = Some(i);
            }
            last = i;
            crossings += 1;
        }
    }
    let first = first.expect("no upward zero crossing found — signal is silent?");
    assert!(crossings >= 2, "need at least 2 crossings, got {crossings}");
    let periods = (crossings - 1) as f64;
    let samples = (last - first) as f64;
    sample_rate * periods / samples
}

/// 🔴 #555 + #553: **ループ通し**（記録 → 再起動 → 同じ音）をデバイス不要で検証する。
///
/// 「宣言 → 音色を変える → **記録** → 終了 → **再起動** → 同じ音で鳴る」の中核。
/// UI もデバイスも使わず、**周波数の解析だけで判定**する（無人・改ざん耐性）。
#[test]
fn state_round_trip_reproduces_the_same_pitch() {
    use orbit_vst3_synth_oracle::{encode_state, voice_frequency_hz};

    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };

    const KEY: i16 = 69;
    const OFFSET: i32 = 7; // 完全5度上。既定(0)と明確に違う音になる。
                           // 周波数測定に十分な長さを取る（512 frames では 440Hz が数周期しか入らない）。
    const RENDER_BLOCKS: usize = 16;

    let render = |state: Option<&[u8]>| -> (Vec<f32>, Vst3InstrumentProcessor) {
        let (mut processor, _info) =
            Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, state)
                .unwrap_or_else(|error| panic!("failed to load synth oracle: {error}"));
        processor.push_note_on(0, KEY, 0.8, 0);
        let mut all = Vec::new();
        for _ in 0..RENDER_BLOCKS {
            let mut audio = vec![0.0; FRAMES * 2];
            assert!(processor.process_block(&mut audio));
            all.extend_from_slice(&audio);
        }
        (all, processor)
    };

    // ── 1. 既定（offset 0）で鳴らす。基準になる音。
    let (baseline_audio, _baseline) = render(None);
    let baseline_hz = measured_frequency_hz(&baseline_audio, SAMPLE_RATE);
    let expected_baseline = voice_frequency_hz(KEY, 0) as f64;
    assert!(
        (baseline_hz - expected_baseline).abs() / expected_baseline < 0.02,
        "baseline {baseline_hz:.1}Hz != 仕様式 {expected_baseline:.1}Hz"
    );

    // ── 2. 「音色を変える」= state を適用して起動する。音が変わることを確認する。
    let shifted_state = encode_state(OFFSET);
    let (shifted_audio, shifted) = render(Some(&shifted_state));
    let shifted_hz = measured_frequency_hz(&shifted_audio, SAMPLE_RATE);
    let expected_shifted = voice_frequency_hz(KEY, OFFSET) as f64;
    assert!(
        (shifted_hz - expected_shifted).abs() / expected_shifted < 0.02,
        "shifted {shifted_hz:.1}Hz != 仕様式 {expected_shifted:.1}Hz"
    );
    assert!(
        (shifted_hz - baseline_hz).abs() / baseline_hz > 0.1,
        "state を変えたのに音が変わっていない（{shifted_hz:.1}Hz vs {baseline_hz:.1}Hz）— \
         これでは復元の成否を音で判定できない"
    );

    // ── 3. 「記録」= 実行中インスタンスから state を吸い上げる（#555 の capture_state）。
    let recorded = shifted
        .capture_state()
        .expect("capture_state must return the live plugin state");
    assert!(!recorded.is_empty(), "記録した state が空");

    // ── 4. 「再起動」= 記録した state で新しいインスタンスを起こす。
    let (restored_audio, _restored) = render(Some(&recorded));
    let restored_hz = measured_frequency_hz(&restored_audio, SAMPLE_RATE);

    // ── 5. 「同じ音で鳴る」。
    assert!(
        (restored_hz - shifted_hz).abs() / shifted_hz < 0.02,
        "復元後 {restored_hz:.1}Hz が記録前 {shifted_hz:.1}Hz と一致しない — ループが閉じていない"
    );
    assert!(
        (restored_hz - expected_shifted).abs() / expected_shifted < 0.02,
        "復元後 {restored_hz:.1}Hz が仕様式 {expected_shifted:.1}Hz と一致しない"
    );
}

/// #555: `capture_state()` が **chunk を過不足なく**取り出すことを押さえる。
///
/// ⚠️ **このテストは「空 chunk を Err にする」分岐を検証していない。** oracle は常に
/// 非空を返すため、その経路を踏めない（`bytes.is_empty()` を消す変異はこのテストでは
/// 殺せないことを実測で確認済み）。**空チェックは現時点で無防備**であり、それを
/// 塞ぐにはモック plugin（getState が何も書かない）が要る。
///
/// 本テストが実際に守るのは **取りこぼしと余剰**: 長さを仕様の `STATE_LEN` に固定するので、
/// stream 読み出しがバイトを落とす／余計に足す変異は red になる。
#[test]
fn capture_state_returns_exactly_the_oracle_state_length() {
    let Some(bundle) = package_synth_oracle() else {
        eprintln!("VST3 synth oracle build failed; loud skip for this machine");
        return;
    };
    let (processor, _info) =
        Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None)
            .unwrap_or_else(|error| panic!("failed to load synth oracle: {error}"));

    let captured = processor
        .capture_state()
        .expect("oracle always produces a non-empty chunk");
    assert_eq!(
        captured.len(),
        orbit_vst3_synth_oracle::STATE_LEN,
        "oracle の state 長が仕様の STATE_LEN と一致しない — \
         capture_state が chunk を取りこぼしているか余分に足している"
    );
}
