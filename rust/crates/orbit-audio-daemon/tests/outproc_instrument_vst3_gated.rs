//! Gated real-device coverage for daemon -> VST3 instrument child -> synth oracle.
//!
//! Prerequisites:
//!   cargo build -p orbit-vst3-instrument-child
//! Run:
//!   cargo test -p orbit-audio-daemon --features outproc-instrument \
//!     --test outproc_instrument_vst3_gated -- --ignored --nocapture
//!
//! `ORBIT_INSTRUMENT_CHILD_BIN` may override the default VST3 child path.

#![cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]

mod gated_common;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use gated_common::{child_exe, repo_path, wait_until};
use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_instrument::{OutProcInstrumentConfig, PROBE_KEY};

const PROBE_NOTE_KEY: u8 = PROBE_KEY.key as u8;
const PROBE_NOTE_CHANNEL: u8 = PROBE_KEY.channel as u8;

fn package_oracle() -> PathBuf {
    let script = repo_path("rust/crates/orbit-vst3-synth-oracle/package-oracle.sh");
    let output = Command::new(&script)
        .output()
        .unwrap_or_else(|error| panic!("run {}: {error}", script.display()));
    assert!(
        output.status.success(),
        "VST3 synth oracle packaging failed (status={}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
}

fn setup_test() -> OutProcInstrumentConfig {
    let child_exe = std::env::var_os("ORBIT_INSTRUMENT_CHILD_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| child_exe("orbit-vst3-instrument-child"));
    let plugin = package_oracle();
    assert!(
        child_exe.exists(),
        "VST3 instrument child is missing: {} — run `cargo build -p orbit-vst3-instrument-child`",
        child_exe.display()
    );
    assert!(
        plugin.exists(),
        "VST3 synth oracle bundle is missing: {}",
        plugin.display()
    );
    OutProcInstrumentConfig {
        child_exe,
        plugin: Some(plugin),
        plugin_id: None,
        buffer_frames: None,
    }
}

#[test]
#[ignore = "VST3 Phase1: needs a real output device + built orbit-vst3-instrument-child (local only)"]
fn outproc_vst3_instrument_sounds_at_oracle_amplitude_and_ends_note() {
    let (engine, _guard) = EngineWrap::start_outproc_instrument(setup_test())
        .expect("start OOP VST3 instrument daemon");

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("send A4 note on");
    let sounded = wait_until(Duration::from_secs(10), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.post_peak > 0.01 && stats.fresh > 0 && stats.probe_live_count > 0)
            .unwrap_or(false)
    });
    let sounding = engine
        .outproc_instrument_stats()
        .expect("instrument stats while sounding");
    assert!(
        sounded,
        "VST3 instrument did not produce a fresh audible block"
    );
    assert!(
        (sounding.post_peak - 0.25).abs() <= 0.01,
        "synth peak was {}, expected 0.25 +/- 0.01",
        sounding.post_peak
    );

    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0)
        .expect("send A4 note off");
    // VST3 has no plugin NOTE_END callback. `orbit-vst3-instrument-child` synthesizes NOTE_END
    // when it forwards NoteOff, so this verifies host bookkeeping rather than plugin feedback.
    let note_end_received = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.probe_live_count == 0)
            .unwrap_or(false)
    });
    let stats = engine.outproc_instrument_stats().expect("instrument stats");
    println!("=== VST3 OOP instrument oracle verdict ===");
    println!("post_mix_peak:       {:.5}", stats.post_peak);
    println!("fresh:               {}", stats.fresh);
    println!("probe_live_count:    {}", stats.probe_live_count);
    println!("child_proc_errors:   {}", stats.child_process_error_count);
    println!("===========================================");
    assert!(
        note_end_received,
        "synthetic VST3 NOTE_END did not clear host voice bookkeeping"
    );
    assert!(
        !stats.measurement_invalid,
        "child spawn/respawn failure invalidated measurement"
    );
    assert_eq!(
        stats.child_process_error_count, 0,
        "VST3 instrument child process error"
    );
    assert_eq!(
        stats.output_note_end_dropped_count, 0,
        "synthetic NOTE_END was dropped"
    );
}

#[test]
#[ignore = "VST3 Phase1: needs a real output device + built orbit-vst3-instrument-child (local only)"]
fn outproc_vst3_instrument_attach_failure_can_retry_with_oracle() {
    let config = setup_test();
    let oracle = config.plugin.clone().expect("oracle plugin");
    let (engine, _guard) =
        EngineWrap::start_outproc_instrument_post_boot(config).expect("start daemon post boot");
    assert!(engine
        .load_outproc_plugin(PathBuf::from("/definitely/not/a/plugin.vst3"), None)
        .is_err());
    engine
        .load_outproc_plugin(oracle, None)
        .expect("retry synth oracle");
    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("note on");
    assert!(wait_until(Duration::from_secs(10), || engine
        .outproc_instrument_stats()
        .map(|stats| stats.fresh > 0 && stats.probe_live_count > 0)
        .unwrap_or(false)));
}

#[test]
#[ignore = "VST3 Phase1: needs a real output device + built orbit-vst3-instrument-child (local only)"]
fn outproc_vst3_instrument_survives_child_kill_and_sounds_again() {
    let (engine, _guard) = EngineWrap::start_outproc_instrument(setup_test())
        .expect("start OOP VST3 instrument daemon");
    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("pre-kill note on");
    assert!(wait_until(Duration::from_secs(10), || engine
        .outproc_instrument_stats()
        .map(|stats| stats.post_peak > 0.01 && stats.fresh > 0)
        .unwrap_or(false)));
    let before = engine
        .outproc_instrument_stats()
        .expect("stats before kill");
    let killed_pid = before.current_child_pid;
    assert_ne!(killed_pid, 0, "child PID was not published");
    Command::new("kill")
        .args(["-9", &killed_pid.to_string()])
        .status()
        .expect("kill command")
        .success()
        .then_some(())
        .expect("kill VST3 child");
    assert!(wait_until(Duration::from_secs(5), || engine
        .outproc_instrument_stats()
        .map(|stats| stats.respawn_count > before.respawn_count)
        .unwrap_or(false)));
    engine.outproc_instrument_reset_post_peak();
    let fresh_before = engine
        .outproc_instrument_stats()
        .expect("post-respawn stats")
        .fresh;
    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("post-respawn note on");
    assert!(wait_until(Duration::from_secs(10), || engine
        .outproc_instrument_stats()
        .map(|stats| stats.post_peak > 0.01 && stats.fresh > fresh_before)
        .unwrap_or(false)));
    let after = engine.outproc_instrument_stats().expect("recovery stats");
    assert_ne!(
        after.current_child_pid, killed_pid,
        "child was not replaced"
    );
    assert!(
        !after.measurement_invalid,
        "respawn invalidated measurement"
    );
    assert_eq!(
        after.child_process_error_count, 0,
        "VST3 child process error"
    );
}
