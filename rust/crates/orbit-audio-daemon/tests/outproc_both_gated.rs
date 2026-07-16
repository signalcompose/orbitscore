//! both-role OOP の実機 gated test。instrument の add-mix を effect の serial insert が加工する順を
//! daemon の単一 callback で検証する。CI は `--no-run` の compile contract のみを持つ。

#![cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};
use orbit_audio_daemon::outproc_instrument::{OutProcInstrumentConfig, PROBE_KEY};

const EFFECT_GAIN: f32 = 0.5;
const PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";
const PROBE_NOTE_KEY: u8 = PROBE_KEY.key as u8;
const PROBE_NOTE_CHANNEL: u8 = PROBE_KEY.channel as u8;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

fn child_exe(name: &str) -> PathBuf {
    let mut path = std::env::current_exe().expect("current_exe");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.push(name);
    path
}

fn setup_test() -> (OutProcEffectConfig, OutProcInstrumentConfig) {
    let effect = OutProcEffectConfig {
        format: PluginFormat::Clap,
        child_exe: child_exe("orbit-clap-effect-child"),
        plugin: repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib"),
        plugin_id: None,
        buffer_frames: None,
    };
    let instrument = OutProcInstrumentConfig {
        child_exe: child_exe("orbit-clap-instrument-child"),
        plugin: repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib"),
        plugin_id: Some(PLUGIN_ID.to_owned()),
        buffer_frames: None,
    };
    assert!(effect.plugin.exists(), "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`", effect.plugin.display());
    assert!(
        effect.child_exe.exists(),
        "effect child binary が無い: {} — 先に `cargo build -p orbit-clap-effect-child`",
        effect.child_exe.display()
    );
    assert!(instrument.plugin.exists(), "test-synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml`", instrument.plugin.display());
    assert!(
        instrument.child_exe.exists(),
        "instrument child binary が無い: {} — 先に `cargo build -p orbit-clap-instrument-child`",
        instrument.child_exe.display()
    );
    (effect, instrument)
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
#[ignore = "both-role OOP: needs a real output device + built effect/instrument children and test dylibs (local only)"]
fn both_roles_attach_in_instrument_then_effect_order() {
    let (effect_cfg, instrument_cfg) = setup_test();
    let synth_path = instrument_cfg.plugin.clone();
    let synth_id = instrument_cfg.plugin_id.clone();
    let effect_path = effect_cfg.plugin.clone();
    let (engine, _guard) = EngineWrap::start_outproc_both(effect_cfg, instrument_cfg)
        .expect("start both-role OOP daemon");

    engine
        .load_outproc_instrument_plugin(synth_path, synth_id)
        .expect("attach test-synth to instrument slot");
    engine
        .load_outproc_effect_plugin(effect_path, None)
        .expect("attach test-effect to effect slot");

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8)
        .expect("send probe note on");
    let instrument_live = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|s| s.fresh > 0 && s.probe_live_count > 0)
            .unwrap_or(false)
    });
    let effect_fresh = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_effect_stats()
            .map(|s| s.fresh > 0 && s.dry_peak > 0.01)
            .unwrap_or(false)
    });
    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0)
        .expect("send probe note off");

    let instrument = engine.outproc_instrument_stats().expect("instrument stats");
    let effect = engine.outproc_effect_stats().expect("effect stats");
    let ratio = if effect.dry_peak > 0.0 {
        effect.post_peak / effect.dry_peak
    } else {
        0.0
    };
    println!("both OOP: instrument fresh={} live={} post_peak={:.5}; effect fresh={} dry={:.5} post={:.5} ratio={ratio:.5}", instrument.fresh, instrument.probe_live_count, instrument.post_peak, effect.fresh, effect.dry_peak, effect.post_peak);
    assert!(
        instrument_live,
        "instrument の fresh/probe_live_count が note-on 後に立たなかった (fresh={}, live={})",
        instrument.fresh, instrument.probe_live_count
    );
    assert!(
        effect_fresh,
        "effect が instrument の非無音出力を fresh 処理しなかった (fresh={}, dry_peak={:.5})",
        effect.fresh, effect.dry_peak
    );
    assert!(
        !instrument.measurement_invalid,
        "instrument child の計測が無効"
    );
    assert!(!effect.measurement_invalid, "effect child の計測が無効");
    // effect の dry は composite 内で instrument add-mix 後の buffer、post はその serial insert 後なので、
    // 単体 effect の sine 入力と同じ post/dry 契約がそのまま成立する。
    assert!(
        (0.4..=0.6).contains(&ratio),
        "effect の post/dry gain 比が想定外: {ratio:.5}（期待 ~{EFFECT_GAIN}）"
    );
}
