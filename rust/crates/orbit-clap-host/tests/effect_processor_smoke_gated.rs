//! γ M1 PR-B 基礎検証: [`ClapEffectProcessor`] の single-thread ライフサイクルを実プラグインで証明する。
//!
//! daemon の CLAP host は activate=main / process=audio の **別スレッド**構成（spike も cpal callback で
//! process する）。γ child は 1 スレッドで load → process → drop を直列実行するため、この single-thread
//! モデルが実 plugin（clack + test-effect）で成立することを child crate を建てる**前に**確かめる。
//!
//! 検証内容:
//! - `load`（PluginInstance::new + activate + start_processing）→ `process_block` → drop
//!   （stop_processing → deactivate）を全て同一スレッドで実行して panic しない。
//! - effect が固定 gain 0.5（`EFFECT_GAIN`）を乗算する（出力 ≈ 0.5 × 入力）。
//!
//! 実 dylib を要するため `#[ignore]`。事前に test-effect をビルドすること:
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//! 実行:
//!   cargo test -p orbit-clap-host --test effect_processor_smoke_gated -- --ignored --nocapture

use std::path::PathBuf;

use orbit_clap_host::ClapEffectProcessor;

/// test-effect が乗算する固定 gain（plugin 側 `EFFECT_GAIN` と一致させること）。
const EFFECT_GAIN: f32 = 0.5;
/// test-effect の CLAP plugin id。
const PLUGIN_ID: &str = "com.signalcompose.clap-test-effect";
/// test-synth の CLAP plugin id（audio input 0 / output 1 = instrument）。
const SYNTH_PLUGIN_ID: &str = "com.signalcompose.clap-test-synth";

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-clap-host）。
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

#[test]
#[ignore = "γ M1 PR-B: needs a built test-effect dylib (local only)"]
fn effect_processor_single_thread_lifecycle() {
    let dylib = repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib");
    assert!(
        dylib.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml` を実行",
        dylib.display()
    );

    // load → process → drop を同一スレッドで直列実行する（single-thread モデル）。
    let (mut effect, info) = ClapEffectProcessor::load(&dylib, Some(PLUGIN_ID), 48_000, 2, 512)
        .expect("load test-effect as ClapEffectProcessor");
    assert_eq!(info.plugin_id, PLUGIN_ID, "ロードした plugin id が一致");

    // 既知の入力（128 frames stereo）。一定振幅でなくランプにして配線ミスを検知しやすくする。
    let frames = 128usize;
    let input: Vec<f32> = (0..frames * 2).map(|i| (i as f32) * 0.001 - 0.05).collect();
    let mut data = input.clone();

    let ok = effect.process_block(&mut data);
    assert!(ok, "plugin.process() が成功する");

    for (i, (&out, &inp)) in data.iter().zip(input.iter()).enumerate() {
        let expected = inp * EFFECT_GAIN;
        assert!(
            (out - expected).abs() < 1e-6,
            "sample {i}: out={out} expected={expected}（gain {EFFECT_GAIN} 配線）"
        );
    }

    // drop（stop_processing → deactivate を同一スレッドで）で panic しないこと。
    drop(effect);
}

// γ M1 PR-C carry-forward ②: `process_block_core` の **instrument(add-mix) 分岐**を offline で検証する。
// PR-B は effect(overwrite) 分岐しか踏まなかった。共有カーネルの add-mix 経路が回帰しないよう、audio
// input を持たない synth（test-synth）を `ClapEffectProcessor` に load して `has_audio_input()=false`
// → add-mix 分岐に入れる。note を送らない（空イベント）ので synth 出力は silence（Voice は inactive で
// `buf.fill(0.0)`）。よって add-mix なら `data += silence` で dry 信号が保存される。もし effect(overwrite)
// 分岐に誤って入ると data が無音化される — この差で add-mix 分岐の成立を distinguishing に確認する。
#[test]
#[ignore = "γ M1 PR-C carry-forward ②: needs a built test-synth dylib (local only)"]
fn instrument_branch_add_mixes_dry_signal() {
    let dylib = repo_path("rust-spike/clap-test-synth/target/debug/libclap_test_synth.dylib");
    assert!(
        dylib.exists(),
        "test-synth dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-synth/Cargo.toml` を実行",
        dylib.display()
    );

    let (mut synth, info) =
        ClapEffectProcessor::load(&dylib, Some(SYNTH_PLUGIN_ID), 48_000, 2, 512)
            .expect("load test-synth as ClapEffectProcessor");
    assert_eq!(
        info.plugin_id, SYNTH_PLUGIN_ID,
        "ロードした plugin id が一致"
    );

    // 非ゼロの dry 信号。note を送らないので synth は silence を出す → add-mix なら dry が保存される。
    let frames = 128usize;
    let dry = 0.7f32;
    let mut data = vec![dry; frames * 2];

    let ok = synth.process_block(&mut data);
    assert!(ok, "plugin.process() が成功する");

    // add-mix の証拠: dry 信号が保存される（silence を足すだけ）。overwrite 分岐なら ~0 になる。
    for (i, &out) in data.iter().enumerate() {
        assert!(
            (out - dry).abs() < 1e-4,
            "sample {i}: out={out} expected≈{dry}。add-mix なら dry 保存、~0 なら effect(overwrite) 分岐の誤り"
        );
    }

    drop(synth);
}
