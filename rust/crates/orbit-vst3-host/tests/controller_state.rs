#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::OnceLock;

use orbit_vst3_host::{Vst3EffectProcessor, Vst3InstrumentProcessor};

const SAMPLE_RATE: f64 = 48_000.0;
const FRAMES: usize = 512;
const CONTROLLER_STATE: &[u8] = b"ORBIT-CONTROLLER";
const GAIN_PROCESSOR_CID: &[u8; 32] = b"6E33225254224A00AA69301AF318797D";

fn package_gain_oracle() -> Option<PathBuf> {
    static BUNDLE: OnceLock<Option<PathBuf>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../orbit-vst3-gain-oracle/package-oracle.sh");
            let output = Command::new(script).output().ok()?;
            if !output.status.success() {
                eprintln!(
                    "gain oracle packaging failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                return None;
            }
            Some(PathBuf::from(
                String::from_utf8_lossy(&output.stdout).trim(),
            ))
        })
        .clone()
}

fn scenario_file(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "orbit-vst3-controller-{}-{label}",
        std::process::id()
    ))
}

fn run_scenario(name: &str, controller_mode: &str, single_component: bool) -> Output {
    let bundle = package_gain_oracle().expect("package gain oracle before isolated scenario");
    let trace = scenario_file(&format!("{name}-trace"));
    let observed = scenario_file(&format!("{name}-observed"));
    let _ = std::fs::remove_file(&trace);
    let _ = std::fs::remove_file(&observed);
    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    command
        .arg("--exact")
        .arg("controller_scenario_helper")
        .arg("--nocapture")
        .env("ORBIT_VST3_CONTROLLER_TEST_SCENARIO", name)
        .env("ORBIT_VST3_CONTROLLER_TEST_BUNDLE", bundle)
        .env("ORBIT_VST3_GAIN_CONTROLLER_STATE", controller_mode)
        .env("ORBIT_VST3_GAIN_STATE_TRACE_FILE", &trace)
        .env("ORBIT_VST3_GAIN_CONTROLLER_SET_STATE_FILE", &observed);
    if single_component {
        command.env("ORBIT_VST3_GAIN_SINGLE_COMPONENT", "1");
    }
    command
        .output()
        .expect("spawn isolated controller scenario")
}

fn assert_scenario_passed(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "isolated scenario failed\nstdout:\n{}\nstderr:\n{stderr}",
        stdout
    );
    assert!(
        stdout.contains("1 passed"),
        "isolated scenario did not run exactly one helper test\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    stderr
}

#[test]
fn controller_state_is_stored_restored_and_applied_in_sdk_order() {
    let output = run_scenario("round-trip", "known", false);
    assert_scenario_passed(&output);
}

#[test]
fn controller_get_state_not_implemented_returns_none_without_notice() {
    let output = run_scenario("not-implemented", "not-implemented", false);
    let stderr = assert_scenario_passed(&output);
    assert!(!stderr.contains("IEditController::getState for plugin"));
}

#[test]
fn controller_get_state_failure_returns_none_and_notifies_once_per_instance() {
    let output = run_scenario("failure", "failure", false);
    let stderr = assert_scenario_passed(&output);
    assert_eq!(
        stderr
            .matches("IEditController::getState for plugin")
            .count(),
        1,
        "notice must be emitted only once per instance: {stderr}"
    );
    assert!(stderr.contains("Gain (vst3-rs example plugin)"));
    assert!(stderr.contains("INFO [orbit-vst3-host]"));
}

#[test]
fn controller_get_state_failure_notifies_again_when_result_changes() {
    let output = run_scenario("failure-changing", "failure-changing", false);
    let stderr = assert_scenario_passed(&output);
    assert_eq!(
        stderr
            .matches("IEditController::getState for plugin")
            .count(),
        2,
        "each distinct consecutive result must be observable: {stderr}"
    );
}

#[test]
fn controller_get_state_failure_notifies_again_after_success() {
    let output = run_scenario("failure-success-failure", "failure-success-failure", false);
    let stderr = assert_scenario_passed(&output);
    assert_eq!(
        stderr
            .matches("IEditController::getState for plugin")
            .count(),
        2,
        "a success must clear failure-notice suppression: {stderr}"
    );
}

#[test]
fn controller_get_state_success_returns_some() {
    let output = run_scenario("success", "known", false);
    assert_scenario_passed(&output);
}

#[test]
fn single_component_matching_component_state_still_stores_cont_chunk() {
    let output = run_scenario("single-component-same-state", "same-as-component", true);
    assert_scenario_passed(&output);
}

#[test]
fn controller_scenario_helper() {
    let Ok(scenario) = std::env::var("ORBIT_VST3_CONTROLLER_TEST_SCENARIO") else {
        return;
    };
    let bundle = PathBuf::from(
        std::env::var_os("ORBIT_VST3_CONTROLLER_TEST_BUNDLE")
            .expect("parent passes packaged oracle bundle"),
    );
    let trace_path = PathBuf::from(std::env::var_os("ORBIT_VST3_GAIN_STATE_TRACE_FILE").unwrap());
    let observed_path =
        PathBuf::from(std::env::var_os("ORBIT_VST3_GAIN_CONTROLLER_SET_STATE_FILE").unwrap());
    let load = || {
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, None)
            .expect("load gain oracle")
            .0
    };

    match scenario.as_str() {
        "round-trip" => {
            let processor = load();
            let state = processor.capture_state().expect("capture state");
            assert_eq!(&state[8..40], GAIN_PROCESSOR_CID);
            let chunks = orbit_vst3_preset::parse(&state).unwrap().unwrap();
            assert_eq!(chunks.controller, Some(CONTROLLER_STATE));
            drop(processor);

            std::fs::write(&trace_path, b"").expect("clear trace before restore");
            let restored =
                Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&state))
                    .expect("restore captured container")
                    .0;
            assert_eq!(std::fs::read(&observed_path).unwrap(), CONTROLLER_STATE);
            let calls = std::fs::read_to_string(&trace_path).unwrap();
            let restore_calls = calls
                .lines()
                .skip_while(|call| *call != "component.setState")
                .collect::<Vec<_>>();
            assert_eq!(
                restore_calls,
                [
                    "component.setState",
                    "controller.setComponentState",
                    "controller.setState"
                ]
            );
            drop(restored);
        }
        "not-implemented" | "success" => {
            let processor = load();
            let state = processor.capture_state().expect("capture state");
            let chunks = orbit_vst3_preset::parse(&state).unwrap().unwrap();
            if scenario == "success" {
                assert_eq!(chunks.controller, Some(CONTROLLER_STATE));
            } else {
                assert_eq!(chunks.controller, None);
            }
        }
        "failure" | "failure-changing" => {
            let processor = load();
            for _ in 0..2 {
                let state = processor
                    .capture_state()
                    .expect("component-only capture succeeds");
                assert_eq!(
                    orbit_vst3_preset::parse(&state)
                        .unwrap()
                        .unwrap()
                        .controller,
                    None
                );
            }
        }
        "failure-success-failure" => {
            let processor = load();
            let expected = [None, Some(CONTROLLER_STATE), None];
            for expected_controller in expected {
                let state = processor
                    .capture_state()
                    .expect("component-only capture succeeds");
                assert_eq!(
                    orbit_vst3_preset::parse(&state)
                        .unwrap()
                        .unwrap()
                        .controller,
                    expected_controller
                );
            }
        }
        "single-component-same-state" => {
            let processor = load();
            let state = processor.capture_state().expect("capture single component");
            let chunks = orbit_vst3_preset::parse(&state).unwrap().unwrap();
            assert_eq!(chunks.controller, Some(chunks.component));
            let trace = std::fs::read_to_string(&trace_path).unwrap();
            assert_eq!(
                trace
                    .lines()
                    .filter(|line| *line == "component.getState")
                    .count(),
                1
            );
            assert_eq!(
                trace
                    .lines()
                    .filter(|line| *line == "controller.getState")
                    .count(),
                1
            );
        }
        other => panic!("unknown controller scenario {other}"),
    }
}

#[test]
fn raw_effect_state_is_restored_through_apply_state_bytes() {
    let bundle = package_gain_oracle().expect("package gain oracle for raw effect restore");
    let raw = orbit_vst3_gain_oracle::encode_state(0.25);
    let (mut processor, _) =
        Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&raw)).unwrap();
    let input = vec![0.8; FRAMES];
    let mut left = vec![0.0; FRAMES];
    let mut right = vec![0.0; FRAMES];
    processor
        .process_stereo(&input, &input, &mut left, &mut right, None)
        .unwrap();
    assert!(left
        .iter()
        .all(|sample| sample.to_bits() == 0.2f32.to_bits()));
}

#[test]
fn raw_instrument_state_is_restored_through_apply_state_bytes() {
    let bundle = orbit_vst3_synth_oracle::package_bundle()
        .expect("package synth oracle for raw instrument restore");
    let raw = orbit_vst3_synth_oracle::encode_state(7);
    let (mut processor, _) =
        Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&raw)).unwrap();
    processor.push_note_on(0, 69, 0.8, 0);
    let mut audio = Vec::new();
    for _ in 0..16 {
        let mut block = vec![0.0; FRAMES * 2];
        assert!(processor.process_block(&mut block));
        audio.extend(block.into_iter().step_by(2));
    }
    let crossings = audio
        .windows(2)
        .enumerate()
        .filter_map(|(index, pair)| (pair[0] <= 0.0 && pair[1] > 0.0).then_some(index + 1))
        .collect::<Vec<_>>();
    let measured = SAMPLE_RATE * (crossings.len() - 1) as f64
        / (crossings.last().unwrap() - crossings.first().unwrap()) as f64;
    let expected = orbit_vst3_synth_oracle::voice_frequency_hz(69, 7) as f64;
    assert!((measured - expected).abs() / expected < 0.02);
}

#[test]
fn effect_container_class_id_match_is_case_insensitive() {
    let bundle = package_gain_oracle().expect("package gain oracle for class ID restore");
    let mut state = orbit_vst3_preset::build(
        &[
            0x6E, 0x33, 0x22, 0x52, 0x54, 0x22, 0x4A, 0x00, 0xAA, 0x69, 0x30, 0x1A, 0xF3, 0x18,
            0x79, 0x7D,
        ],
        &orbit_vst3_gain_oracle::encode_state(0.25),
        None,
    );
    state[8..40].make_ascii_lowercase();
    Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&state))
        .expect("lowercase spelling of the matching class ID must load");
}

#[test]
fn effect_container_for_another_class_reports_both_ids() {
    let bundle = package_gain_oracle().expect("package gain oracle for class ID rejection");
    let state = orbit_vst3_preset::build(
        &[0xAA; 16],
        &orbit_vst3_gain_oracle::encode_state(0.25),
        None,
    );
    let error = match Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&state)) {
        Ok(_) => panic!("another class ID must be rejected"),
        Err(error) => error.to_string(),
    };
    assert!(
        error.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        "{error}"
    );
    assert!(
        error.contains("6E33225254224A00AA69301AF318797D"),
        "{error}"
    );
}

#[test]
fn instrument_container_for_another_class_reports_both_ids() {
    let bundle = orbit_vst3_synth_oracle::package_bundle()
        .expect("package synth oracle for class ID rejection");
    let state =
        orbit_vst3_preset::build(&[0xAA; 16], &orbit_vst3_synth_oracle::encode_state(7), None);
    let error =
        match Vst3InstrumentProcessor::load(&bundle, SAMPLE_RATE, FRAMES as i32, Some(&state)) {
            Ok(_) => panic!("another class ID must be rejected"),
            Err(error) => error.to_string(),
        };
    assert!(
        error.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        "{error}"
    );
    assert!(
        error.contains("4D16F7A1C14B4D4DA292B0D8A331C421"),
        "{error}"
    );
}
