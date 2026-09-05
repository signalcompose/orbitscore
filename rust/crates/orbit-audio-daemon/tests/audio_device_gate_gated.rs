//! #661 output-device callback liveness gate (real-device gated tests).
//!
//! Run explicitly on a machine with a working output device:
//! `cargo test -p orbit-audio-daemon --test audio_device_gate_gated -- --ignored --nocapture`

use std::time::Duration;

use orbit_audio_daemon::engine_wrap::{EngineWrap, StartupOptions, WrapError};
use orbit_audio_native::{
    list_output_devices, OutputError, OutputFault, StreamLivenessPhase, FIRST_CALLBACK_DEADLINE,
};

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

fn assert_startup_fails_with_stream_dead(
    fault: OutputFault,
    expected_phase: StreamLivenessPhase,
    panic_message: &str,
) {
    let error = match EngineWrap::start_with_options(options(Some(named_default_output()), fault)) {
        Err(error) => error,
        Ok(_) => panic!("{panic_message}"),
    };
    assert!(matches!(
        error,
        WrapError::Output(OutputError::StreamDead { phase, .. }) if phase == expected_phase
    ));
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
    assert_startup_fails_with_stream_dead(
        OutputFault::DeadAllProbes,
        StreamLivenessPhase::Probe,
        "all dead probes must fail startup",
    );
}

#[test]
#[ignore = "needs a real audio output device"]
fn c4_dead_real_stream_fails_without_a_second_fallback() {
    assert_startup_fails_with_stream_dead(
        OutputFault::DeadRealStream,
        StreamLivenessPhase::RealStream,
        "a dead real stream must fail its postcondition",
    );
}

#[test]
#[ignore = "needs a real audio output device"]
fn c5_failed_switch_keeps_the_old_stream_advancing_during_probe() {
    let (engine, mut guard) =
        EngineWrap::start_with_options(options(None, OutputFault::DeadProbeRequested))
            .expect("initial default stream must start");

    // Observe the shared real-stream counter from another thread while apply_device_switch blocks
    // for the injected 3 s dead probe. The probe has its own counter, so every advance here comes
    // from the old stream. A pause-before-probe mutation creates roughly 30 stagnant 100 ms windows.
    let observed_engine = engine.clone();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    let observer = std::thread::spawn(move || {
        let mut previous = observed_engine.stream_stats_snapshot().callbacks;
        let mut samples = 0_u32;
        let mut consecutive_stagnant = 0_u32;
        let mut max_stagnant = 0_u32;
        while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
            stop_rx.recv_timeout(Duration::from_millis(100))
        {
            let callbacks = observed_engine.stream_stats_snapshot().callbacks;
            samples += 1;
            if callbacks == previous {
                consecutive_stagnant += 1;
                max_stagnant = max_stagnant.max(consecutive_stagnant);
            } else {
                consecutive_stagnant = 0;
            }
            previous = callbacks;
        }
        (samples, max_stagnant)
    });

    let error = engine
        .apply_device_switch(&mut guard, Some(named_default_output()))
        .expect_err("the requested switch probe is injected dead");
    stop_tx.send(()).expect("stop callback observer");
    let (samples, max_stagnant) = observer.join().expect("join callback observer");
    assert!(matches!(
        error,
        WrapError::Output(OutputError::StreamDead {
            phase: StreamLivenessPhase::Probe,
            ..
        })
    ));
    assert!(
        samples >= 20,
        "dead probe returned before its 3 s deadline: {samples}"
    );
    assert!(
        max_stagnant < 5,
        "old stream stalled during probe for at least 500 ms: max_stagnant={max_stagnant}"
    );
    let output = engine.stream_config_snapshot();
    assert!(
        output
            .last_switch_failure
            .as_deref()
            .is_some_and(|reason| reason.contains("produced no callback")),
        "failed switch reason was not retained: {output:?}"
    );
}

#[test]
#[ignore = "needs a real audio output device"]
// 🔴 この検査が捕まえるのは「**古いストリームを止める防御が全部消えたこと**」である。
//
// 止める経路は 2 つあり、**互いに冗長**:
//   (a) `EngineWrap::apply_device_switch` の `guard.stream.pause()?`
//   (b) `OutputStream` の `impl Drop` の `pause()`
//
// main が実機で測った（2026-09-05・`--audio-device <既定の名前>` → host 既定へ切替）:
//
// | 変異 | callbacks/s | 本テスト |
// |---|---|---|
// | 変異なし | 94（= sample_rate / last_frames） | ok |
// | (a) だけ削除 | 94（(b) が効く） | ok ← **正しい** |
// | (b) だけ削除 | 94（(a) が効く） | ok ← **正しい** |
// | **(a)(b) 両方削除** | **190** | **FAILED** ✅ |
//
// つまり **片方を消してもここは緑のまま**。「C-6 が (a) を守っている」と読んではいけない。
//
// 二重になる理由は cpal 0.15.3 の参照循環（`macos/mod.rs` の `add_disconnect_listener` が
// `stream.clone()` を closure に move し、その listener を同じ `StreamInner` に格納する）で、
// **`Drop` だけではコールバックが止まらない**。listener が付くのは `!is_default` のときだけで、
// `host.devices()` 由来の Device は**既定デバイスであっても `is_default: false`**。
//
// 🔴 期待値を `sample_rate / last_frames` から導いてはいけない（初版がそうだった）。
// `last_frames` は最後に走ったコールバックが書くので、分子と分母が同じ方向へ動いて
// **自己相殺**し、両方削除しても緑のままだった。切替の**前**に実測した率と比べること。
fn c6_successful_named_to_default_switch_has_one_callback_rate() {
    let named = named_default_output();
    let (engine, mut guard) =
        EngineWrap::start_with_options(options(Some(named), OutputFault::None))
            .expect("named stream must start");

    std::thread::sleep(Duration::from_millis(250));
    let before_start = engine.stream_stats_snapshot().callbacks;
    std::thread::sleep(Duration::from_secs(1));
    let before_end = engine.stream_stats_snapshot().callbacks;
    let before_rate = before_end - before_start;
    assert!(before_rate > 0, "named stream produced no callbacks");

    engine
        .apply_device_switch(&mut guard, None)
        .expect("switch to host default must succeed");
    let after_start = engine.stream_stats_snapshot().callbacks;
    std::thread::sleep(Duration::from_secs(1));
    let after = engine.stream_stats_snapshot();
    assert!(after.last_frames > 0, "no callback frame size recorded");
    let after_rate = after.callbacks - after_start;
    assert!(
        after_rate as f64 >= before_rate as f64 * 0.70
            && after_rate as f64 <= before_rate as f64 * 1.30,
        "callback rate changed after device switch: before_rate={before_rate}, after_rate={after_rate}, stats={after:?}"
    );
}
