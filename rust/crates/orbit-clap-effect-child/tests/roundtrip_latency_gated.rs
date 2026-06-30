//! γ M1 PR-C: out-of-process effect の **steady-state viability probe**（device 不要・dylib のみ）。
//!
//! 実 CLAP child + 共有メモリ transport の 1 ブロック round-trip 実測時間を、32/64/128f の buffer period
//! と比較し、候補B pipelined 設計の steady-state stale 余裕を **デジタル領域で**特徴づける（実 audio
//! device 不要・耳も不要）。SLOTS（pipeline 深さ）の最終決定は本来 gated 実機の stale 率
//! （`orbit-audio-daemon` の `outproc_effect_gated.rs`）が根拠だが、本 probe は「child が締切に対し
//! どれだけ余裕で間に合うか」をオフラインで定量予測する補助根拠（owner 要望で記録・2026-06-30）。
//!
//! ## 捕捉できないもの（重要）
//! 実 RT audio callback 下の **OS スケジューラ preemption（tail）**。本 probe は競合の無い offline
//! busy-loop なので preemption を再現しない → 出る数値は **best-case round-trip（下限）**。実 RT の
//! occasional stale tail（spike #351 で 32f ≈ 0.45%）は gated 実機 RUN が担当する。
//!
//! ## 解釈
//! pipelined（候補B）では child は 1 ブロック period 丸ごとの処理時間を持つ。round-trip << period なら
//! steady-state では child が毎回はるかに余裕で間に合う = `SLOTS=2` で stale ≈ 0 が期待できる、という
//! デジタル根拠になる。実測（dev machine・2026-06-30）: 32f ≈ 3.8us / 64f ≈ 5.8us = 締切の 1/170 前後。
//!
//! 実 dylib を要するため `#[ignore]`（local 実行）:
//!   cargo build -p orbit-clap-effect-child
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//!   cargo test -p orbit-clap-effect-child --test roundtrip_latency_gated -- --ignored --nocapture

use std::path::{Path, PathBuf};
use std::time::Instant;

use orbit_audio_sandbox::{render_through_child_sync, CHANNELS};

const SAMPLE_RATE_HZ: f64 = 48_000.0;
/// 実機計測で round-trip は締切の 1/170 前後だった。負荷下でも余裕が出るよう **>10x**（= round-trip が
/// 締切の 1/10 未満）を sanity floor とする。これを割るなら同期設計の前提（child は 1 period で十分間に合う）
/// が崩れており SLOTS を増やしても本質的に苦しい — その判断材料を offline で出す。
const MIN_MARGIN: f64 = 10.0;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// `child_exe` 越しに `num_blocks` 個の `frames`-block を同期処理し、1 ブロックあたりの平均 round-trip
/// （µs）を返す。spawn コストを除くため 1 回 warm してから計測する。
fn measure_per_block_us(
    child_exe: &Path,
    dylib_str: &str,
    frames: usize,
    num_blocks: usize,
) -> f64 {
    let input = vec![0.05f32; frames * CHANNELS * num_blocks];
    let args = ["--plugin", dylib_str, "--sample-rate", "48000"];
    // warm（spawn + plugin load コストを計測から除外）。
    let _ = render_through_child_sync(child_exe, &input, frames, &args).expect("warm render");
    let t0 = Instant::now();
    let _ = render_through_child_sync(child_exe, &input, frames, &args).expect("measured render");
    t0.elapsed().as_micros() as f64 / num_blocks as f64
}

#[test]
#[ignore = "γ M1 PR-C: needs a built test-effect dylib (local only)"]
fn outproc_effect_roundtrip_under_deadline() {
    let dylib = repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib");
    assert!(
        dylib.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`",
        dylib.display()
    );
    let dylib_str = dylib.to_str().expect("dylib パスは UTF-8");
    let child_exe = Path::new(env!("CARGO_BIN_EXE_orbit-clap-effect-child"));

    println!("=== γ M1 PR-C OOP effect round-trip viability (offline・best-case) ===");
    for &frames in &[32usize, 64usize, 128usize] {
        let per_block_us = measure_per_block_us(child_exe, dylib_str, frames, 4000);
        let period_us = frames as f64 / SAMPLE_RATE_HZ * 1e6;
        let margin = period_us / per_block_us;
        println!(
            "[{frames}f] round-trip ≈ {per_block_us:.2}us | period {period_us:.2}us | margin {margin:.1}x"
        );
        // best-case round-trip が締切の 1/10 未満であること（= SLOTS=2 の steady-state viability の下限）。
        assert!(
            margin > MIN_MARGIN,
            "[{frames}f] round-trip {per_block_us:.2}us が締切 {period_us:.2}us に対し余裕不足 \
             (margin {margin:.1}x < {MIN_MARGIN}x) — 同期前提が崩れている。SLOTS では本質解決しない可能性"
        );
    }
    println!("=> steady-state は SLOTS=2 で stale≈0 が期待できる（実 RT preemption tail は gated 実機が担当）");
    println!("====================================================================");
}
