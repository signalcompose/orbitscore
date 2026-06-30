//! γ M1 PR-C Done 証拠（Issue #359）: out-of-process effect が production daemon 経由で実機検証される
//! gated テスト。CI は Rust gated 非実行（device なし）→ **owner のローカル実機 RUN が唯一の根拠**。
//!
//! 3 本（設計 doc §5/§6）:
//! - **parity**: OOP effect（隔離 child の実 CLAP）が master bus を加工する（`post/dry ≈ test-effect gain`）。
//! - **kill-test**: child を SIGKILL → daemon 生存 → watchdog respawn → fresh 処理が復帰する。
//! - **stale-rate**: 32/64f の小バッファで stale_pct / callback_max を計測 → **owner が SLOTS 2 vs 3 を決定**。
//!
//! 前提（実行前にビルドすること）:
//!   cargo build -p orbit-clap-effect-child
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//! 実行:
//!   cargo test -p orbit-audio-daemon --features outproc-effect --test outproc_effect_gated -- --ignored --nocapture
//!
//! device / dylib / child binary が揃わない env（headless CI 等）では owner へ stop&report（手動 fallback）。
//!
//! ## SLOTS 決定の運用（設計 §3-2 / §5-c）
//! `orbit_audio_sandbox::SLOTS`（現 2）を変えるだけで pipeline 深さが切り替わる。stale-rate テストの
//! 出力（stale_pct）を見て、32/64f で stale が許容外なら `SLOTS=3` にして **再ビルド + 再 RUN** する
//! （cross-process は same-build determinism なので両プロセスが再コンパイルされる）。本テストの assert は
//! 「catastrophic でない」sanity floor で、SLOTS の最終判断は printed verdict を owner が読んで行う。

#![cfg(feature = "outproc-effect")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::OutProcEffectConfig;

/// test-effect が乗算する固定 gain（plugin 側 `EFFECT_GAIN` と一致させること）。
const EFFECT_GAIN: f32 = 0.5;
/// RT 健全性の callback 所要時間上限（synth/clap gated と同じ保守的上限 20ms）。
const CALLBACK_MAX_BUDGET_NS: u64 = 20_000_000;

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-audio-daemon）。
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// effect child binary（`orbit-clap-effect-child`）のパスを解決する。
///
/// 別 crate の binary なので `CARGO_BIN_EXE_*` は使えない。test 実行ファイル
/// （`target/<profile>/deps/<name>-<hash>`）の祖先から sibling binary を導く（profile 非依存）。
fn child_exe() -> PathBuf {
    let mut p = std::env::current_exe().expect("current_exe");
    p.pop(); // test exe 名を除く → deps/
    if p.ends_with("deps") {
        p.pop(); // deps/ を除く → target/<profile>/
    }
    p.push("orbit-clap-effect-child");
    p
}

/// test-effect の .clap dylib（standalone crate なので独自 target/debug 配下）。
fn test_effect_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib")
}

/// gated 前提（dylib / child binary / 音源）を確認して config と音源 path を返す。揃わなければ panic で
/// loud に止める。各 test の共通セットアップ（dylib/child の二重解決と prereq 重複を 1 箇所に集約）。
fn setup_test(buffer_frames: Option<u32>) -> (OutProcEffectConfig, PathBuf) {
    let cfg = OutProcEffectConfig {
        child_exe: child_exe(),
        plugin: test_effect_dylib(),
        plugin_id: None, // 単一プラグイン bundle なので id 省略可
        buffer_frames,
    };
    let wav = repo_path("test-assets/audio/sine_440.wav");
    assert!(
        cfg.plugin.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`",
        cfg.plugin.display()
    );
    assert!(
        cfg.child_exe.exists(),
        "effect child binary が無い: {} — 先に `cargo build -p orbit-clap-effect-child`",
        cfg.child_exe.display()
    );
    assert!(wav.exists(), "音源 WAV が無い: {}", wav.display());
    (cfg, wav)
}

/// sine を 1 つ再生する（一定振幅 → dry/post peak 比が安定する）。
fn play_sine(engine: &EngineWrap, wav: &Path) {
    let sample = engine
        .load_sample(wav.to_path_buf())
        .expect("load sine sample");
    let onset = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(&sample.sample_id, onset, 1.0, 0.0, 0.0, 0.0, 1.0, None)
        .expect("play sine");
}

/// `cond` が真になるまで（または timeout まで）20ms 間隔で poll する。真で抜けたら true。
fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    cond()
}

// ── parity: OOP effect が master bus を加工する（post/dry ≈ EFFECT_GAIN）─────────────────────
#[test]
#[ignore = "γ M1 PR-C: needs a real output device + built child binary + test-effect dylib (local only)"]
fn outproc_effect_processes_audio_via_daemon() {
    let (cfg, wav) = setup_test(None);
    let (engine, _guard) = EngineWrap::start_outproc_effect(cfg).expect("start OOP effect daemon");
    play_sine(&engine, &wav);
    // child spawn + hot path 安定 + 多数の callback を待つ。
    std::thread::sleep(Duration::from_millis(800));

    let s = engine
        .outproc_effect_stats()
        .expect("outproc stats available");
    let cb = engine
        .outproc_callback_stats()
        .expect("callback stats available");
    let ratio = if s.dry_peak > 0.0 {
        s.post_peak / s.dry_peak
    } else {
        0.0
    };
    println!("=== γ M1 PR-C OOP effect parity verdict ===");
    println!("dry_peak:            {:.5}", s.dry_peak);
    println!("post_peak:           {:.5}", s.post_peak);
    println!("ratio (post/dry):    {ratio:.5}  (expect ~{EFFECT_GAIN})");
    println!(
        "fresh / stale / stall: {} / {} / {}",
        s.fresh, s.stale, s.stall
    );
    println!("callback_count:      {}", s.callback_count);
    println!("callback_max_ns:     {}", cb.max_ns);
    println!("callback_p99_ns:     {}", cb.p99_ns);
    println!("respawn_count:       {}", s.respawn_count);
    println!("child_proc_errors:   {}", s.child_process_error_count);
    println!("==========================================");

    assert!(
        !s.measurement_invalid,
        "respawn 失敗で計測無効（child binary を確認）"
    );
    assert!(
        s.dry_peak > 0.01,
        "engine が発音しなかった (dry_peak={:.5})。sample 再生経路を確認",
        s.dry_peak
    );
    // fresh > 0 = child が処理した出力を host が実際に読んだ（dead child なら stale のみで fresh=0）。
    assert!(
        s.fresh > 0,
        "child から fresh 出力を読めていない（OOP 経路が動いていない）"
    );
    // serial insert の gain 比。余白は resampling / peak 整列のずれを吸収（理論値 EFFECT_GAIN）。
    assert!(
        (0.4..=0.6).contains(&ratio),
        "OOP effect gain 比が想定外: {ratio:.5}（期待 ~{EFFECT_GAIN}）。\
         child の effect 適用 / transport 配線を確認"
    );
    assert!(s.callback_count > 0, "audio callback が回っていない");
    assert!(
        cb.max_ns < CALLBACK_MAX_BUDGET_NS,
        "callback max が異常に大きい ({} ns ≈ {:.2} ms) — RT 違反の疑い",
        cb.max_ns,
        cb.max_ns as f64 / 1e6
    );
    // _guard drop で teardown（watchdog 停止 → QUIT → reap → unlink）。panic / UB なく完了することを検証。
}

// ── kill-test: child SIGKILL → daemon 生存 → respawn → fresh 処理復帰 ─────────────────────────
#[test]
#[ignore = "γ M1 PR-C: needs a real output device + built child binary + test-effect dylib (local only)"]
fn outproc_effect_survives_child_kill_and_respawns() {
    let (cfg, wav) = setup_test(None);
    let (engine, _guard) = EngineWrap::start_outproc_effect(cfg).expect("start OOP effect daemon");
    play_sine(&engine, &wav);
    std::thread::sleep(Duration::from_millis(600));

    // kill 前: effect が動いていること（fresh 処理 + gain 比）を確認。
    let before = engine.outproc_effect_stats().expect("stats");
    assert!(before.fresh > 0, "kill 前に OOP effect が動いていない");
    let pid = before.current_child_pid;
    assert!(pid != 0, "child PID が publish されていない");
    let respawns_before = before.respawn_count;

    // child を SIGKILL（C-ABI segfault 相当の異常終了を模す）。
    let killed = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status()
        .expect("kill コマンド実行");
    assert!(killed.success(), "kill -9 {pid} が失敗");

    // watchdog が異常終了を検知して respawn するのを待つ（poll 20ms + spawn）。
    let respawned = wait_until(Duration::from_secs(5), || {
        engine
            .outproc_effect_stats()
            .map(|s| s.respawn_count > respawns_before)
            .unwrap_or(false)
    });
    assert!(
        respawned,
        "watchdog が child crash 後に respawn しなかった（daemon 生存 + respawn を確認）"
    );

    // respawn 後の fresh 処理復帰を **新規** に計測する: peak をリセットし fresh の基準を取る。
    engine.outproc_reset_peaks();
    let fresh_after_respawn = engine.outproc_effect_stats().unwrap().fresh;

    // 新 child が多数 block を処理するのを待つ。
    std::thread::sleep(Duration::from_millis(600));
    let s = engine.outproc_effect_stats().expect("stats");
    let ratio = if s.dry_peak > 0.0 {
        s.post_peak / s.dry_peak
    } else {
        0.0
    };
    println!("=== γ M1 PR-C OOP effect kill-test verdict ===");
    println!("killed pid:          {pid}");
    println!(
        "respawn_count:       {} (before {})",
        s.respawn_count, respawns_before
    );
    println!(
        "fresh after respawn: {} -> {}",
        fresh_after_respawn, s.fresh
    );
    println!("ratio (post/dry):    {ratio:.5}  (expect ~{EFFECT_GAIN})");
    println!("measurement_invalid: {}", s.measurement_invalid);
    println!("=============================================");

    assert!(!s.measurement_invalid, "respawn 失敗で計測無効");
    // 新 child が fresh 出力を生み host が読んだ = repeat-previous でなく実処理が復帰した（advisor）。
    assert!(
        s.fresh > fresh_after_respawn,
        "respawn 後に fresh 処理が復帰していない（repeat-previous だけでは fresh は増えない）"
    );
    assert!(
        (0.4..=0.6).contains(&ratio),
        "respawn 後の effect gain 比が想定外: {ratio:.5}（期待 ~{EFFECT_GAIN}）"
    );
    // _guard drop で teardown。
}

// ── stale-rate: 32/64f 小バッファの viability 計測 → owner が SLOTS 2 vs 3 を決定 ────────────────
#[test]
#[ignore = "γ M1 PR-C: needs a real output device that supports small buffers (local only)"]
fn outproc_effect_small_buffer_stale_rate() {
    println!(
        "=== γ M1 PR-C OOP effect stale-rate verdict (SLOTS={}) ===",
        orbit_audio_sandbox::SLOTS
    );
    for &frames in &[64u32, 32u32] {
        let (cfg, wav) = setup_test(Some(frames));
        let (engine, _guard) = match EngineWrap::start_outproc_effect(cfg) {
            Ok(x) => x,
            Err(e) => {
                // device が当該バッファをサポートしない場合は skip（loud に記録）。
                println!("[{frames}f] start 失敗（device が非対応の可能性）: {e} — skip");
                continue;
            }
        };
        play_sine(&engine, &wav);
        // 多数の callback を集める（小バッファでは callback 頻度が高い）。
        std::thread::sleep(Duration::from_secs(2));

        let s = engine.outproc_effect_stats().expect("stats");
        let cb = engine.outproc_callback_stats().expect("cb stats");
        let total = s.fresh + s.stale;
        let stale_pct = if total > 0 {
            s.stale as f64 / total as f64 * 100.0
        } else {
            0.0
        };
        println!(
            "[{frames}f] fresh={} stale={} stall={} stale_pct={stale_pct:.3}% \
             cb_max={}ns cb_p99={}ns respawn={} invalid={}",
            s.fresh, s.stale, s.stall, cb.max_ns, cb.p99_ns, s.respawn_count, s.measurement_invalid
        );

        // sanity floor（catastrophic でないこと）。SLOTS の最終判断は上の数値を owner が読んで行う:
        // stale_pct が許容外なら SLOTS=3 にして再ビルド + 再 RUN（本ファイル冒頭の運用メモ参照）。
        assert!(
            !s.measurement_invalid,
            "[{frames}f] 計測無効（respawn 失敗）"
        );
        assert!(
            total > 0,
            "[{frames}f] callback が回っていない（fresh+stale=0）"
        );
        assert!(
            cb.max_ns < CALLBACK_MAX_BUDGET_NS,
            "[{frames}f] callback max が RT budget 超過: {} ns ≈ {:.2} ms",
            cb.max_ns,
            cb.max_ns as f64 / 1e6
        );
        // catastrophic stale（半数以上が間に合わない）は viability 無し → SLOTS を上げても本質的に苦しい
        // ことを示す floor。実用閾は printed stale_pct を見て owner が判断する。
        assert!(
            stale_pct < 50.0,
            "[{frames}f] stale_pct が壊滅的: {stale_pct:.3}%（SLOTS={} で viability なし）",
            orbit_audio_sandbox::SLOTS
        );
    }
    println!("==========================================================");
}
