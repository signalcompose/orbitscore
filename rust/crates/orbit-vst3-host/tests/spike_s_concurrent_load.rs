//! Spike S（#628）— **同一プロセスで、片方が audio を処理している最中に別インスタンスを
//! load できるか**。
//!
//! ## なぜこれを測るのか
//!
//! #628 のラック設計は「1 child が N プラグインをホストし、チェーン編集は child 内の
//! prepare-commit で行う」形を採る。その中核は **「新インスタンスを side で構築している間、
//! 旧 stage list は audio スレッドで処理を続ける = 音が途切れない」** という前提である。
//! この前提が成り立てば、#625 の「差し替え中は dry 素通し」という窓が**消える**。
//!
//! 🔴 **この codebase にはその実績が無い。** 現行 child は 1 インスタンス固定で、プラグインを
//! load するのは **READY を publish する前**（= audio がまだ回っていない時）だけだった。
//! DAW の in-process ホスティングでは常套だが、ここでは未検証である。
//!
//! 設計書 `docs/archive/design/628-rack-chain-implementation-design.md` §9-1 が指定した spike。
//!
//! ## 測り方
//!
//! 1. GainOracle を 1 つ load し、`split()` して audio 半分をワーカースレッドで回し続ける
//! 2. その最中に**メインスレッドで 2 つ目**を load する
//! 3. 2 つ目の load が成功し、1 つ目の処理が**止まらず・壊れず**続いたかを見る
//!
//! ## 失敗した場合の縮退（設計書 §9-1）
//!
//! 「APPLY の load 中だけ audio ループを bypass に落とす」へ縮退できる。旧チェーンは止まるが
//! dry にはならず、#625 の窓と同等。**wire・TS 層は影響を受けない**。
//!
//! ## 実行
//!
//! ```sh
//! rust/crates/orbit-vst3-gain-oracle/package-oracle.sh   # GainOracle.vst3 を組む
//! cargo test -p orbit-vst3-host --test spike_s_concurrent_load -- --ignored --nocapture
//! ```

// 🔴 crate 全体が `#![cfg(target_os = "macos")]` なので、テストも同じ cfg で揃える。
// 揃えないと Linux CI（`clippy --all-targets`）で `Vst3EffectProcessor` が解決できず落ちる。
// #622 で直したのと同じクラス（child crate の cfg 不整合）を、main がここで踏んだ。
#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use orbit_vst3_host::Vst3EffectProcessor;

const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK: i32 = 512;

fn oracle_bundle() -> PathBuf {
    // package-oracle.sh の出力先（実測 2026-08-27）
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("target")
        .join("vst3-fixtures")
        .join("GainOracle.vst3")
}

/// Spike S 本体。実バンドルを要するので `#[ignore]`。
#[test]
#[ignore = "spike S (#628): needs GainOracle.vst3 — run package-oracle.sh first"]
fn loading_a_second_instance_does_not_disturb_the_one_already_processing() {
    let bundle = oracle_bundle();
    assert!(
        bundle.exists(),
        "GainOracle.vst3 が無い。先に package-oracle.sh を実行すること: {}",
        bundle.display()
    );

    // 1 つ目を load して audio 半分をワーカーへ渡す。
    let (first, first_info) = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, BLOCK, None)
        .expect("first instance must load before any audio is running");
    println!("[spike] first loaded: {:?}", first_info.name);
    let (mut first_audio, _first_main) = first.split();

    let keep_running = Arc::new(AtomicBool::new(true));
    let blocks_processed = Arc::new(AtomicU64::new(0));
    let processing_faulted = Arc::new(AtomicBool::new(false));

    let stop = keep_running.clone();
    let counter = blocks_processed.clone();
    let faulted = processing_faulted.clone();

    let worker = std::thread::spawn(move || {
        // 既知の入力（0.5 の定数）を流し続け、gain=1.0 の oracle が素通しすることを毎ブロック確認する。
        let mut buffer = vec![0.5f32; (BLOCK as usize) * 2];
        while stop.load(Ordering::Acquire) {
            buffer.iter_mut().for_each(|s| *s = 0.5);
            let ok = first_audio.process_block(&mut buffer);
            if !ok {
                faulted.store(true, Ordering::Release);
                break;
            }
            // gain=1.0 の sample-exact passthrough なので、出力は入力と一致していなければならない。
            if buffer.iter().any(|s| (*s - 0.5).abs() > 1e-6) {
                faulted.store(true, Ordering::Release);
                break;
            }
            counter.fetch_add(1, Ordering::Relaxed);
            std::thread::sleep(Duration::from_micros(200));
        }
    });

    // ワーカーが実際に回り始めるまで待つ（回っていない状態で load しても測定にならない）。
    let spun_up = poll_until(Duration::from_secs(5), || {
        blocks_processed.load(Ordering::Relaxed) > 50
    });
    assert!(
        spun_up,
        "audio ワーカーが回り始めなかった（processed={}, faulted={}）",
        blocks_processed.load(Ordering::Relaxed),
        processing_faulted.load(Ordering::Acquire)
    );

    let before = blocks_processed.load(Ordering::Relaxed);
    println!("[spike] worker is running ({before} blocks). loading second instance now…");

    // 🔴 これが測定対象: 1 つ目が処理中に、同一プロセスで 2 つ目を load する。
    let load_started = Instant::now();
    let second = Vst3EffectProcessor::load(&bundle, SAMPLE_RATE, BLOCK, None);
    let load_took = load_started.elapsed();

    let second_ok = second.is_ok();
    println!("[spike] second load ok={second_ok} took={load_took:?}");

    // 少し回してから止める（load 直後に壊れていないかを見る）。
    std::thread::sleep(Duration::from_millis(200));
    let after = blocks_processed.load(Ordering::Relaxed);

    keep_running.store(false, Ordering::Release);
    worker.join().expect("audio worker thread");

    println!(
        "[spike] blocks before={before} after={after} (delta={}) faulted={}",
        after.saturating_sub(before),
        processing_faulted.load(Ordering::Acquire)
    );

    match second {
        Ok((_second, info)) => println!("[spike] second loaded: {:?}", info.name),
        Err(error) => panic!(
            "second instance failed to load while the first was processing: {error:?} \
             — 設計 §9-1 の縮退（load 中だけ audio を bypass）へ倒す必要がある"
        ),
    }

    assert!(
        !processing_faulted.load(Ordering::Acquire),
        "1 つ目の処理が load 中に壊れた（出力が入力と一致しなくなったか process_block が false）\
         — 設計 §9-1 の縮退が必要"
    );
    assert!(
        after > before,
        "load 中に 1 つ目の処理が停止した（before={before} after={after}）\
         — 設計 §9-1 の縮退が必要"
    );
}

fn poll_until(budget: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}
