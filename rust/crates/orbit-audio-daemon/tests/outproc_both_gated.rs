//! both-role OOP の実機 gated test。instrument の add-mix を effect の serial insert が加工する順を
//! daemon の単一 callback で検証する。CI は `--no-run` の compile contract のみを持つ。

#![cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]

mod gated_common;
use gated_common::{child_exe, repo_path, wait_until};

use std::time::Duration;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};
use orbit_audio_daemon::outproc_instrument::{OutProcInstrumentConfig, PROBE_KEY};

const EFFECT_GAIN: f32 = 0.5;
const PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";
const PROBE_NOTE_KEY: u8 = PROBE_KEY.key as u8;
const PROBE_NOTE_CHANNEL: u8 = PROBE_KEY.channel as u8;

fn setup_test() -> (OutProcEffectConfig, OutProcInstrumentConfig) {
    let effect = OutProcEffectConfig {
        format: PluginFormat::Clap,
        child_exe: child_exe("orbit-clap-effect-child"),
        plugin: Some(repo_path(
            "rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib",
        )),
        plugin_id: None,
        buffer_frames: None,
    };
    let instrument = OutProcInstrumentConfig {
        child_exe: child_exe("orbit-clap-instrument-child"),
        plugin: Some(repo_path(
            "rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib",
        )),
        plugin_id: Some(PLUGIN_ID.to_owned()),
        buffer_frames: None,
        // 単一 child の both-build 検証なので slot pool は最小の 1（#540 P1）。
        slots: 1,
    };
    let effect_plugin = effect
        .plugin
        .as_ref()
        .expect("gated config has an effect plugin");
    assert!(effect_plugin.exists(), "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`", effect_plugin.display());
    assert!(
        effect.child_exe.exists(),
        "effect child binary が無い: {} — 先に `cargo build -p orbit-clap-effect-child`",
        effect.child_exe.display()
    );
    let instrument_plugin = instrument
        .plugin
        .as_ref()
        .expect("gated config has an instrument plugin");
    assert!(instrument_plugin.exists(), "test-synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml`", instrument_plugin.display());
    assert!(
        instrument.child_exe.exists(),
        "instrument child binary が無い: {} — 先に `cargo build -p orbit-clap-instrument-child`",
        instrument.child_exe.display()
    );
    (effect, instrument)
}

#[test]
#[ignore = "both-role OOP: needs a real output device + built effect/instrument children and test dylibs (local only)"]
fn both_roles_attach_in_instrument_then_effect_order() {
    let (effect_cfg, instrument_cfg) = setup_test();
    let synth_path = instrument_cfg
        .plugin
        .clone()
        .expect("gated config has an instrument plugin");
    let synth_id = instrument_cfg.plugin_id.clone();
    let effect_path = effect_cfg
        .plugin
        .clone()
        .expect("gated config has an effect plugin");
    let (engine, _guard) = EngineWrap::start_outproc_both(effect_cfg, instrument_cfg)
        .expect("start both-role OOP daemon");

    engine
        .load_outproc_instrument_plugin(synth_path, synth_id, None, None)
        .expect("attach test-synth to instrument slot");
    engine
        .load_outproc_effect_plugin(effect_path, None, None)
        .expect("attach test-effect to effect slot");

    engine
        .plugin_note_on(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.8, None)
        .expect("send probe note on");
    let instrument_live = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_instrument_stats()
            .map(|s| s.fresh > 0 && s.probe_live_count > 0)
            .unwrap_or(false)
    });
    // post_peak まで待つ: OOP effect は SLOTS=2 の pipeline で出力が 1 ブロック遅れる。
    // fresh/dry だけで先へ進むと、音の最初のブロックを入力した直後（post はまだ
    // silence-primed の前段出力）に note-off → stats 読みになる race がある（#434 S2 の
    // 起動位相シフトで顕在化・機構は従来から存在）。
    let effect_fresh = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_effect_stats()
            .map(|s| s.fresh > 0 && s.dry_peak > 0.01 && s.post_peak > 0.01)
            .unwrap_or(false)
    });
    engine
        .plugin_note_off(PROBE_NOTE_KEY, PROBE_NOTE_CHANNEL, 0.0, None)
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
