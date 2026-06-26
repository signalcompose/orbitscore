//! PR2 Done 証拠（Issue #340）: CLAP **effect** プラグイン（serial insert）が production daemon
//! 経由で audio を **加工**することを実機で検証する gated テスト。
//!
//! 検証対象（PR2 = effect topology）:
//! - engine が render したサンプル（sine_440.wav）の出力を、effect プラグインの **audio 入力**へ
//!   de-interleave して流し（`set_input_from_interleaved`）、その出力で hardware sum を **上書き**する
//!   （`replace_cpal_buffer`、serial insert）。
//! - effect は固定 gain 0.5（`EFFECT_GAIN`）を乗算する。よって two-phase の post-mix peak 比が
//!   ≈ 0.5 になれば、入力配線（de-interleave）と出力配線（replace）が両方機能している。
//!   入力が無音だと peak=0、replace でなく add-mix だと比≈1.5 になり、いずれも検知できる。
//! - RT 健全性 = **callback-duration ベース**（A0 §6: CoreAudio+cpal は xrun 不発火）。
//!
//! 実 output device を要するため `#[ignore]`。事前に test-effect dylib をビルドすること:
//!   cargo build --manifest-path ../../../rust-spike/clap-test-effect/Cargo.toml
//! 実行:
//!   cargo test -p orbit-audio-daemon --features clap-host --test clap_effect_gated -- --ignored --nocapture
//!
//! device / install が成立しない env（headless CI 等）では owner へ stop&report（手動 fallback）。

#![cfg(feature = "clap-host")]

use std::path::PathBuf;
use std::time::Duration;

use orbit_audio_daemon::engine_wrap::EngineWrap;

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-audio-daemon）。
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// test-effect が乗算する固定 gain（plugin 側 `EFFECT_GAIN` と一致させること）。
const EFFECT_GAIN: f32 = 0.5;

#[test]
#[ignore = "clap-host PR2: needs a real output device + built test-effect dylib (local only)"]
fn effect_processes_audio_via_daemon() {
    // test-effect dylib（standalone crate なので独自 target/debug 配下）。
    let effect = repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib");
    assert!(
        effect.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml` を実行",
        effect.display()
    );
    // 音源: 1 秒 mono sine @ 48k（一定振幅 → peak 比が安定する）。
    let wav = repo_path("test-assets/audio/sine_440.wav");
    assert!(wav.exists(), "音源 WAV が無い: {}", wav.display());

    // 実 cpal stream + 専用 plugin-host thread を起動（clap-host 版 start）。
    let (engine, _guard) = EngineWrap::start().expect("start engine with clap host");
    let sample = engine.load_sample(wav).expect("load sine sample");

    // ── Phase A: plugin 無し baseline ───────────────────────────────────────────────
    // plugin 未ロードでも PostProcessor seam は engine 出力を素通しし post_peak を測る。
    let onset = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(&sample.sample_id, onset, 1.0, 0.0, 0.0, 0.0, 1.0, None)
        .expect("play sine (baseline)");
    std::thread::sleep(Duration::from_millis(500));
    let baseline = engine.clap_post_peak();
    assert!(
        baseline > 0.01,
        "engine が baseline で発音しなかった (post_mix_peak={baseline:.5})。sample 再生経路を確認"
    );

    // ── Phase B: effect ロード（serial insert）───────────────────────────────────────
    // 単一プラグインなので id=None。
    let info = engine
        .load_plugin(effect.clone(), None)
        .expect("load test-effect plugin");
    assert_eq!(
        info.plugin_id, "com.signalcompose.clap-test-effect",
        "ロードされた plugin id が一致する"
    );
    // hot-install が audio thread に着地するまで待つ（以降の callback は effect を適用する）。
    std::thread::sleep(Duration::from_millis(250));
    // 残留 baseline 再生を止め、peak を 0 にしてから effected 再生を測る（fetch_max の汚染除去）。
    engine.stop_all().expect("stop residual playback");
    engine.clap_reset_post_peak();

    let onset2 = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(&sample.sample_id, onset2, 1.0, 0.0, 0.0, 0.0, 1.0, None)
        .expect("play sine (effected)");
    std::thread::sleep(Duration::from_millis(500));
    let effected = engine.clap_post_peak();

    // callback-duration（A0 §6: RT 健全性は xrun でなく callback 実測時間で測る）。
    let cb = engine
        .clap_callback_stats()
        .expect("callback stats available with clap host");

    let ratio = effected / baseline;
    println!("=== clap-host PR2 effect verdict ===");
    println!("baseline_peak:       {baseline:.5}");
    println!("effected_peak:       {effected:.5}");
    println!("ratio (eff/base):    {ratio:.5}  (expect ~{EFFECT_GAIN})");
    println!("callback_count:      {}", cb.callback_count);
    println!("callback_min_ns:     {}", cb.min_ns);
    println!("callback_mean_ns:    {}", cb.mean_ns);
    println!("callback_p99_ns:     {}", cb.p99_ns);
    println!("callback_max_ns:     {}", cb.max_ns);
    println!("===================================");

    // effect が音を加工した（無音でない = 入力配線が機能）。
    assert!(
        effected > 0.01,
        "effect 出力が無音 (effected_peak={effected:.5})。set_input_from_interleaved の入力配線を確認"
    );
    // serial insert の gain 比。replace でなく add-mix だと ~1.5、入力無音だと ~0 になる。
    // 余白は resampling / peak サンプル整列のずれを吸収（理論値 0.5）。
    assert!(
        (0.4..=0.6).contains(&ratio),
        "effect gain 比が想定外: {ratio:.5}（期待 ~{EFFECT_GAIN}）。\
         add-mix（~1.5）や入力無音（~0）でないか、replace/de-interleave 配線を確認"
    );
    // callback が実際に回った。
    assert!(cb.callback_count > 0, "audio callback が回っていない");
    // RT 健全性: callback max が budget 内（synth gated と同じ保守的上限 20ms）。
    assert!(
        cb.max_ns < 20_000_000,
        "callback max が異常に大きい ({} ns ≈ {:.2} ms) — RT 違反の疑い",
        cb.max_ns,
        cb.max_ns as f64 / 1e6
    );

    // _guard drop で teardown（carry-forward #1）が走る。panic / UB なく完了することを検証。
}
