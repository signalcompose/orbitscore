//! γ M1 PR-B Done 証拠: 実 CLAP effect が **隔離 child プロセス**で動き、共有メモリ transport 越しの
//! 出力が in-process と sample-exact に一致することを offline（audio device 不要）で検証する。
//!
//! 検証（設計 doc §5(a)/§6 = audio 正しさ・A/B parity）:
//! - **closed-form oracle**（強い検証）: test-effect は決定論的に *0.5（`EFFECT_GAIN`）するので、OOP child
//!   の出力は `input * 0.5` と完全一致するはず。transport（mmap 往復）と CLAP 処理の**両方**を同時に検証する。
//!   gain 0.5 は 2 の冪なので f32 乗算は誤差ゼロ → `max_abs_diff == 0.0` を期待。
//! - **A/B parity**（設計 §6）: side A = in-process [`ClapEffectProcessor`] / side B = OOP child。両者が
//!   一致 = transport が音響的に透明であることを示す。
//!
//! offline 同期ドライバ（`render_through_child_sync`）は 1-outstanding なので stale は起きない。
//!
//! 実 dylib を要するため `#[ignore]`。事前に test-effect をビルドすること:
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//! 実行:
//!   cargo test -p orbit-clap-effect-child --test effect_parity_gated -- --ignored --nocapture
//!
//! CI backstop は PR-A の gain child parity（clack 非依存・CI 実行可）。本テストは実 CLAP の上乗せ検証。

use std::path::{Path, PathBuf};

use orbit_audio_sandbox::{
    max_abs_diff, render_in_process_gain, render_through_child_sync, CHANNELS, MAX_FRAMES,
};
use orbit_clap_host::ClapEffectProcessor;

/// test-effect が乗算する固定 gain（plugin 側 `EFFECT_GAIN` と一致させること）。
const EFFECT_GAIN: f32 = 0.5;
/// test-effect の CLAP plugin id。
const PLUGIN_ID: &str = "com.signalcompose.clap-test-effect";
/// parity に使うサンプリングレート（test-effect は無視するが activate に必要）。
const SAMPLE_RATE: u32 = 48_000;

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-clap-effect-child）。
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// in-process 参照（side A）: [`ClapEffectProcessor`] で `block_frames` 単位に処理して連結する。
fn render_in_process_effect(dylib: &Path, input: &[f32], block_frames: usize) -> Vec<f32> {
    let (mut effect, _info) = ClapEffectProcessor::load(
        dylib,
        Some(PLUGIN_ID),
        SAMPLE_RATE,
        CHANNELS,
        MAX_FRAMES as u32,
    )
    .expect("load test-effect (side A in-process)");
    let mut out = Vec::with_capacity(input.len());
    for chunk in input.chunks(block_frames * CHANNELS) {
        let mut block = chunk.to_vec();
        assert!(
            effect.process_block(&mut block),
            "side A process_block 成功"
        );
        out.extend_from_slice(&block);
    }
    out
}

/// oracle + A/B parity を `total_frames` / `block_frames` の組で検証する。
/// `total_frames` が `block_frames` の倍数でない場合は最終ブロックが部分長になり
///（最終 `n_frames < block_frames` = 端数ブロック）、child が CLAP に渡すサンプル数が
/// `block_frames` 未満になるケースを実 CLAP で検証する。
fn assert_oop_parity(
    dylib: &Path,
    dylib_str: &str,
    child_exe: &Path,
    total_frames: usize,
    block_frames: usize,
) {
    // ランプ入力で配線ミス（チャンネル入れ替え・オフセットずれ）を検知。
    let input: Vec<f32> = (0..total_frames * CHANNELS)
        .map(|i| (i as f32) * 0.0005 - 0.1)
        .collect();

    // side B: OOP child（隔離プロセス + 共有メモリ transport）。
    let oop = render_through_child_sync(
        child_exe,
        &input,
        block_frames,
        &["--plugin", dylib_str, "--sample-rate", "48000"],
    )
    .expect("OOP child を通して render");
    assert_eq!(oop.len(), input.len(), "OOP 出力長が入力長と一致");

    // closed-form oracle: test-effect = *0.5 なので transport + CLAP を sample-exact で検証。
    let oracle = render_in_process_gain(&input, EFFECT_GAIN);
    assert_eq!(
        max_abs_diff(&oop, &oracle),
        0.0,
        "OOP 出力 == input*{EFFECT_GAIN}（transport + CLAP が sample-exact, {total_frames}f/{block_frames}f）"
    );

    // A/B parity（設計 §6）: in-process side A と OOP side B が一致 = transport は音響的に透明。
    let side_a = render_in_process_effect(dylib, &input, block_frames);
    assert_eq!(
        max_abs_diff(&side_a, &oop),
        0.0,
        "in-process side A == OOP side B（transport 透明, {total_frames}f/{block_frames}f）"
    );
}

#[test]
#[ignore = "γ M1 PR-B: needs a built test-effect dylib (local only)"]
fn real_clap_effect_oop_parity() {
    let dylib = repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib");
    assert!(
        dylib.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml` を実行",
        dylib.display()
    );
    let dylib_str = dylib.to_str().expect("dylib パスは UTF-8");
    let child_exe = Path::new(env!("CARGO_BIN_EXE_orbit-clap-effect-child"));

    let block_frames = 128usize;
    // (1) block 倍数: 4 ブロックちょうど（部分ブロックなし）。
    assert_oop_parity(&dylib, dylib_str, child_exe, block_frames * 4, block_frames);
    // (2) 非倍数: 300 = 128 + 128 + 44 → 最終ブロックが部分長。child の partial-block 経路を実 CLAP で検証。
    assert_oop_parity(&dylib, dylib_str, child_exe, 300, block_frames);
}
