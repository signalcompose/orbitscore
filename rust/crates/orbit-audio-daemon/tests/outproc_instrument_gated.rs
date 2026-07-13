//! Issue #420 Part 3b: production daemon → OOP CLAP instrument → real output device の gated test。
//!
//! 前提:
//!   cargo build -p orbit-clap-instrument-child
//!   cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml
//! 実行（owner の実機確認専用）:
//!   cargo test -p orbit-audio-daemon --features outproc-instrument \
//!     --test outproc_instrument_gated -- --ignored --nocapture
//!
//! 実際にスピーカーから 0.25 振幅の sine が鳴るため、実行前に出力デバイスを確認すること。

#![cfg(feature = "outproc-instrument")]

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_instrument::{OutProcInstrumentConfig, PROBE_KEY};

const PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";
/// `plugin_note_on`/`plugin_note_off` take `(key, channel, velocity)`; derive both from the
/// single `PROBE_KEY` the daemon publishes `probe_live_count` for, so this test can't drift out
/// of sync with the probe voice it asserts against.
const PROBE_NOTE_KEY: u8 = PROBE_KEY.key as u8;
const PROBE_NOTE_CHANNEL: u8 = PROBE_KEY.channel as u8;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// 別 crate の binary なので、test executable の sibling binary として解決する。
fn child_exe() -> PathBuf {
    let mut path = std::env::current_exe().expect("current_exe");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.push("orbit-clap-instrument-child");
    path
}

fn test_synth_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib")
}

/// 実機 test の prerequisites を loud に検証し、production 起動用 config を返す。
fn setup_test() -> OutProcInstrumentConfig {
    let config = OutProcInstrumentConfig {
        child_exe: child_exe(),
        plugin: test_synth_dylib(),
        plugin_id: Some(PLUGIN_ID.to_owned()),
        buffer_frames: None,
    };
    assert!(
        config.plugin.exists(),
        "test-synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml`",
        config.plugin.display()
    );
    assert!(
        config.child_exe.exists(),
        "instrument child binary が無い: {} — 先に `cargo build -p orbit-clap-instrument-child`",
        config.child_exe.display()
    );
    config
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

#[test]
#[ignore = "Issue #420 Part 3b: needs a real output device + built instrument child + test-synth dylib"]
fn outproc_instrument_sounds_via_daemon_note_on_off() {
    let (engine, _guard) =
        EngineWrap::start_outproc_instrument(setup_test()).expect("start OOP instrument daemon");

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("send A4 note on");
    let sounded = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.post_peak > 0.01 && stats.fresh > 0 && stats.probe_live_count > 0)
            .unwrap_or(false)
    });
    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0)
        .expect("send A4 note off");
    let note_end_received = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.probe_live_count == 0)
            .unwrap_or(false)
    });

    let stats = engine
        .outproc_instrument_stats()
        .expect("instrument stats available");
    println!("=== Issue #420 Part 3b OOP instrument sound verdict ===");
    println!("post_mix_peak:       {:.5}", stats.post_peak);
    println!("fresh:               {}", stats.fresh);
    println!("probe_live_count:    {}", stats.probe_live_count);
    println!("callback_count:      {}", stats.callback_count);
    println!("respawn_count:       {}", stats.respawn_count);
    println!("child_proc_errors:   {}", stats.child_process_error_count);
    println!("measurement_invalid: {}", stats.measurement_invalid);
    println!("======================================================");

    assert!(
        sounded,
        "note-on 後に instrument が発音または live voice 登録しなかった \
         (post_mix_peak={:.5}, fresh={}, probe_live_count={})",
        stats.post_peak, stats.fresh, stats.probe_live_count
    );
    assert!(
        note_end_received,
        "note-off 後3秒以内に cross-process NOTE_END が host voice bookkeeping へ届かなかった \
         (probe_live_count={})",
        stats.probe_live_count
    );
    assert!(
        !stats.measurement_invalid,
        "child spawn/respawn 失敗で計測無効"
    );
    assert_eq!(
        stats.child_process_error_count, 0,
        "instrument child で process error が発生"
    );
}

#[test]
#[ignore = "Issue #420 Part 3b: SIGKILL test needs a real output device + built child and synth"]
fn outproc_instrument_survives_child_kill_and_sounds_again() {
    let (engine, _guard) =
        EngineWrap::start_outproc_instrument(setup_test()).expect("start OOP instrument daemon");

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("send pre-kill A4 note on");
    let sounded_before = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.post_peak > 0.01 && stats.fresh > 0)
            .unwrap_or(false)
    });
    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0)
        .expect("send pre-kill A4 note off");
    let before = engine
        .outproc_instrument_stats()
        .expect("instrument stats before kill");
    assert!(sounded_before, "kill 前に OOP instrument が発音していない");
    assert!(
        before.current_child_pid != 0,
        "child PID が publish されていない"
    );

    let killed_pid = before.current_child_pid;
    let respawns_before = before.respawn_count;
    let killed = Command::new("kill")
        .arg("-9")
        .arg(killed_pid.to_string())
        .status()
        .expect("kill command");
    assert!(killed.success(), "kill -9 {killed_pid} が失敗");

    let respawned = wait_until(Duration::from_secs(5), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.respawn_count > respawns_before)
            .unwrap_or(false)
    });
    assert!(
        respawned,
        "watchdog が child crash 後 5 秒以内に respawn しなかった"
    );

    // New child を silent state で数 callback 動かし、kill 前の累積 peak と計測位相を分離する。
    std::thread::sleep(Duration::from_millis(200));
    engine.outproc_instrument_reset_post_peak();
    let fresh_after_respawn = engine
        .outproc_instrument_stats()
        .expect("instrument stats after respawn")
        .fresh;

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("send post-respawn A4 note on");
    let sounded_after = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|stats| stats.post_peak > 0.01 && stats.fresh > fresh_after_respawn)
            .unwrap_or(false)
    });
    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0)
        .expect("send post-respawn A4 note off");

    let after = engine
        .outproc_instrument_stats()
        .expect("instrument stats after recovery note");
    println!("=== Issue #420 Part 3b OOP instrument kill verdict ===");
    println!("killed_pid:          {killed_pid}");
    println!("replacement_pid:     {}", after.current_child_pid);
    println!(
        "respawn_count:       {} (before {})",
        after.respawn_count, respawns_before
    );
    println!("post_respawn_peak:   {:.5}", after.post_peak);
    println!(
        "fresh after respawn: {} -> {}",
        fresh_after_respawn, after.fresh
    );
    println!("measurement_invalid: {}", after.measurement_invalid);
    println!("=====================================================");

    assert!(
        sounded_after,
        "respawn 後の新 child で発音が復帰しなかった (peak={:.5}, fresh={} -> {})",
        after.post_peak, fresh_after_respawn, after.fresh
    );
    assert_ne!(
        after.current_child_pid, killed_pid,
        "respawn 後も child PID が変わっていない"
    );
    assert!(!after.measurement_invalid, "respawn 失敗で計測無効");
    assert_eq!(
        after.child_process_error_count, 0,
        "respawn 後の instrument child で process error が発生"
    );
}
