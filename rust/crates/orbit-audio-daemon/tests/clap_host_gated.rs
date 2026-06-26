//! PR1 Done 証拠（Issue #340）: CLAP **synth** プラグインが production daemon 経由で audio を
//! 発音することを実機で検証する gated テスト。
//!
//! 検証対象（PR1 = daemon CLAP hosting infra）:
//! - `EngineWrap::start()`（clap-host 版）が実 cpal stream + 専用 plugin-host thread を起動する。
//! - `load_plugin` が discovery + instantiate + activate + start_processing + install ring push を
//!   専用スレッドで行い、audio thread が hot-install する。
//! - `plugin_note_on/off`（event ring）で synth が発音し、post-mix peak > 0（実発音）。
//! - RT 健全性 = **callback-duration ベース**（A0 §6: CoreAudio+cpal は xrun 不発火 →
//!   "0 xrun" は Done にならない）。callback max を実測して budget 内を示す。
//! - teardown（carry-forward #1）: guard drop で audio thread の stop_processing → stream 停止 →
//!   instance deactivate の順を通す（panic / UB なく完了する）。
//!
//! 実 output device を要するため `#[ignore]`。事前に test-synth dylib をビルドすること:
//!   cargo build --manifest-path ../../../rust-spike/clap-test-synth/Cargo.toml
//! 実行:
//!   cargo test -p orbit-audio-daemon --features clap-host --test clap_host_gated -- --ignored --nocapture
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

#[test]
#[ignore = "clap-host PR1: needs a real output device + built test-synth dylib (local only)"]
fn synth_processes_audio_via_daemon() {
    // test-synth dylib（standalone crate なので独自 target/debug 配下）。
    let synth = repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib");
    assert!(
        synth.exists(),
        "test-synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml` を実行",
        synth.display()
    );

    // 実 cpal stream + 専用 plugin-host thread を起動（clap-host 版 start）。
    let (engine, _guard) = EngineWrap::start().expect("start engine with clap host");

    // プラグインをロード（discovery + activate + install ring push）。単一プラグインなので id=None。
    let info = engine
        .load_plugin(synth.clone(), None)
        .expect("load test-synth plugin");
    assert_eq!(
        info.plugin_id, "com.signalcompose.clap-test-synth",
        "ロードされた plugin id が一致する"
    );

    // hot-install が audio thread に着地するまで待つ（callback が install ring を pop する）。
    std::thread::sleep(Duration::from_millis(200));

    // NoteOn → 少し鳴らす → NoteOff。C4(60)。複数回叩いて持続発音させる。
    for _ in 0..8 {
        engine.plugin_note_on(60, 0, 0.8).expect("plugin note on");
        std::thread::sleep(Duration::from_millis(60));
        engine.plugin_note_off(60, 0, 0.0).expect("plugin note off");
        std::thread::sleep(Duration::from_millis(40));
    }

    // post-mix peak で実発音を確認（synth は 0.25 振幅の sine → peak は 0 より十分大きいはず）。
    let peak = engine.clap_post_peak();

    // callback-duration（A0 §6: RT 健全性は xrun でなく callback 実測時間で測る）。
    let cb = engine
        .clap_callback_stats()
        .expect("callback stats available with clap host");

    println!("=== clap-host PR1 synth verdict ===");
    println!("post_mix_peak:       {peak:.5}");
    println!("callback_count:      {}", cb.callback_count);
    println!("callback_min_ns:     {}", cb.min_ns);
    println!("callback_mean_ns:    {}", cb.mean_ns);
    println!("callback_p99_ns:     {}", cb.p99_ns);
    println!("callback_max_ns:     {}", cb.max_ns);
    println!("===================================");

    // 発音検証: synth が daemon 経由で audio を生成した。
    assert!(
        peak > 0.01,
        "synth が発音しなかった (post_mix_peak={peak:.5})。hot-install / event ring / process 経路を確認"
    );
    // callback が実際に回った。
    assert!(
        cb.callback_count > 0,
        "audio callback が回っていない (callback_count=0)"
    );
    // RT 健全性: callback max が budget 内。CoreAudio 既定 buffer（~512 frame @ 44.1k ≈ 11.6ms、
    // 大きめの device でも数十 ms）に対し、A0 spike の実測は ~10-500µs。RT 違反（alloc/lock/sleep）が
    // あれば数十〜数百 ms に跳ねる。保守的上限 20ms で違反を検知する（実測値は上の出力で確認）。
    assert!(
        cb.max_ns < 20_000_000,
        "callback max が異常に大きい ({} ns ≈ {:.2} ms) — RT 違反の疑い",
        cb.max_ns,
        cb.max_ns as f64 / 1e6
    );

    // _guard が drop されると teardown（carry-forward #1: audio thread で stop_processing →
    // stream 停止 → instance deactivate）が走る。panic / UB なく完了することがここで検証される。
}
