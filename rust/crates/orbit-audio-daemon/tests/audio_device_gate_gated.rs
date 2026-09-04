//! #661 output-device callback liveness gate (real-device gated tests).
//!
//! Run explicitly on a machine with a working output device:
//! `cargo test -p orbit-audio-daemon --test audio_device_gate_gated -- --ignored --nocapture`

use std::time::Duration;

use orbit_audio_daemon::engine_wrap::{EngineWrap, StartupOptions, WrapError};
use orbit_audio_native::{list_output_devices, OutputError, OutputFault, FIRST_CALLBACK_DEADLINE};

fn named_default_output() -> String {
    let devices = list_output_devices().expect("enumerate output devices");
    devices
        .iter()
        .find(|device| device.is_default)
        .or_else(|| devices.first())
        .map(|device| device.name.clone())
        .expect("at least one output device")
}

fn options(device_name: Option<String>, fault: OutputFault) -> StartupOptions {
    StartupOptions { device_name, fault }
}

#[test]
#[ignore = "needs a real audio output device"]
fn c1_normal_device_is_live_without_fallback() {
    let (engine, _guard) = EngineWrap::start_with_options(StartupOptions::default())
        .expect("normal output must start");
    let output = engine.stream_config_snapshot();
    assert!(!output.device_fell_back, "{output:?}");
    assert!(
        output.first_callback_ms < FIRST_CALLBACK_DEADLINE.as_millis() as u64,
        "{output:?}"
    );
    let before = engine.stream_stats_snapshot().callbacks;
    std::thread::sleep(Duration::from_millis(250));
    assert!(engine.stream_stats_snapshot().callbacks > before);
}

#[test]
#[ignore = "needs a real audio output device"]
fn c2_dead_requested_probe_falls_back_to_a_live_default() {
    let requested = named_default_output();
    let (engine, _guard) = EngineWrap::start_with_options(options(
        Some(requested.clone()),
        OutputFault::DeadProbeRequested,
    ))
    .expect("default-unit fallback must start");
    let output = engine.stream_config_snapshot();
    assert_eq!(output.device_requested.as_deref(), Some(requested.as_str()));
    assert!(output.device_fell_back, "{output:?}");
    assert!(
        output
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("no callback")),
        "{output:?}"
    );
    let before = engine.stream_stats_snapshot().callbacks;
    std::thread::sleep(Duration::from_millis(250));
    assert!(engine.stream_stats_snapshot().callbacks > before);
}

#[test]
#[ignore = "needs a real audio output device"]
fn c3_all_dead_probes_fail_startup() {
    let error = match EngineWrap::start_with_options(options(
        Some(named_default_output()),
        OutputFault::DeadAllProbes,
    )) {
        Err(error) => error,
        Ok(_) => panic!("all dead probes must fail startup"),
    };
    assert!(matches!(
        error,
        WrapError::Output(OutputError::StreamDead { .. })
    ));
}

#[test]
#[ignore = "needs a real audio output device"]
fn c4_dead_real_stream_fails_without_a_second_fallback() {
    let error = match EngineWrap::start_with_options(options(
        Some(named_default_output()),
        OutputFault::DeadRealStream,
    )) {
        Err(error) => error,
        Ok(_) => panic!("a dead real stream must fail its postcondition"),
    };
    assert!(matches!(
        error,
        WrapError::Output(OutputError::StreamDead { .. })
    ));
}

#[test]
#[ignore = "needs a real audio output device"]
fn c5_failed_switch_resumes_the_old_stream() {
    let (engine, mut guard) =
        EngineWrap::start_with_options(options(None, OutputFault::DeadProbeRequested))
            .expect("initial default stream must start");
    let before = engine.stream_stats_snapshot().callbacks;
    let error = engine
        .apply_device_switch(&mut guard, Some(named_default_output()))
        .expect_err("the requested switch probe is injected dead");
    assert!(matches!(
        error,
        WrapError::Output(OutputError::StreamDead { .. })
    ));
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        engine.stream_stats_snapshot().callbacks > before,
        "old stream did not resume after failed switch"
    );
}

#[test]
#[ignore = "needs a real audio output device"]
fn c6_successful_named_to_default_switch_has_one_callback_rate() {
    let named = named_default_output();
    let (engine, mut guard) =
        EngineWrap::start_with_options(options(Some(named), OutputFault::None))
            .expect("named stream must start");
    engine
        .apply_device_switch(&mut guard, None)
        .expect("switch to host default must succeed");
    let output = engine.stream_config_snapshot();
    let before = engine.stream_stats_snapshot().callbacks;
    std::thread::sleep(Duration::from_secs(1));
    let after = engine.stream_stats_snapshot();
    assert!(after.last_frames > 0, "no callback frame size recorded");
    let expected = output.sample_rate as f64 / after.last_frames as f64;
    let actual = (after.callbacks - before) as f64;
    assert!(
        actual >= expected * 0.70 && actual <= expected * 1.30,
        "callback rate must be single-stream: actual={actual}, expected={expected}, stats={after:?}"
    );
}
