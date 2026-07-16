//! VST3 Phase 1 daemon 経路 gated 検証ハーネス（C・Issue #395 実装計画）: out-of-process VST3 effect が
//! production daemon 経由で実機検証される gated テスト。CI は Rust gated 非実行（device なし）→
//! **owner のローカル実機 RUN が唯一の根拠**。
//!
//! 本ファイルは `outproc_effect_gated.rs`（CLAP daemon gated・γ M1 PR-C）の**完全なミラー**。daemon の
//! out-of-process effect supervisor（`orbit-audio-daemon/src/outproc_effect.rs`）は format 非依存
//! （`PluginFormat::Clap` / `PluginFormat::Vst3`）にすでに production 対応済みなので、CLAP 版が検証する
//! supervisor(spawn/watchdog/respawn) + `PipelinedEffectHost`(fresh/stale/stall) + RT callback の性質を
//! そのまま VST3 に対して検証する。CLAP 版との違いは plugin/format 指定のみ（assert 値・tolerance・
//! sleep 時間は CLAP 版を踏襲）。
//!
//! offline 同期 driver 経由の smoke（`orbit-vst3-effect-child/tests/real_plugin_gated.rs`）とは別物で、
//! こちらは daemon supervisor（respawn/watchdog）と RT cpal callback を通す。
//!
//! 4 本:
//! - **C1 parity**: VST3 gain oracle（`orbit-vst3-gain-oracle` = gain=1.0 sample-exact passthrough）を
//!   daemon 経由で挟み、`post/dry ≈ 1.0` を検証する（CLAP 版の EFFECT_GAIN=0.5 parity と同じ構造・中心値
//!   だけ oracle の gain=1.0 に変更）。
//! - **C2 kill-test**: child を SIGKILL → daemon 生存 → watchdog respawn → fresh 処理が復帰する
//!   （plugin 非依存・CLAP 版と同一 assert）。
//! - **C3 stale-rate**: 32/64f の小バッファで stale_pct / callback_max を計測する（CLAP 版と同一 sanity
//!   floor。SLOTS の最終判断は printed verdict を owner が読んで行う）。
//! - **C4 commercial smoke**: `ORBIT_EFFECT_PLUGIN` env で指定した実市販 VST3 プラグインを daemon 経路に
//!   流し、crash-free + respawn 無し + measurement_invalid でない + child_process_error_count==0 を
//!   確認する（既知 gain が無いので parity assert はしない）。env 未指定は loud skip。
//!
//! 前提（実行前にビルドすること）:
//!   cargo build -p orbit-vst3-effect-child
//!   （C1/C2/C3 は VST3 gain oracle を `orbit-vst3-gain-oracle/package-oracle.sh` で自動 package する
//!   ので事前ビルド不要。C4 は `ORBIT_EFFECT_PLUGIN` に実プラグインの .vst3 bundle path を渡す）
//! 実行:
//!   cargo test -p orbit-audio-daemon --features outproc-effect --test outproc_effect_vst3_gated -- --ignored --nocapture
//!
//! device / dylib / child binary が揃わない env（headless CI 等）では owner へ stop&report（手動 fallback）。

#![cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};

/// VST3 gain oracle の固定 gain（`orbit-vst3-gain-oracle` は既定 gain=1.0 の sample-exact
/// passthrough・`oracle_parity.rs` の in-process/OOP 両テストが根拠）。
const ORACLE_GAIN: f32 = 1.0;
/// gain 比の許容幅。CLAP 版（中心 0.5 に対し 0.4..=0.6 = ±20%）と同じ相対マージンを oracle の
/// 中心 1.0 に適用する（resampling / peak 整列ずれの吸収は CLAP 版と同じ理由）。
const RATIO_TOLERANCE: std::ops::RangeInclusive<f32> = (ORACLE_GAIN * 0.8)..=(ORACLE_GAIN * 1.2);
/// RT 健全性の callback 所要時間上限（synth/clap gated と同じ保守的上限 20ms）。
const CALLBACK_MAX_BUDGET_NS: u64 = 20_000_000;

/// child の cold-start（CFBundle load + COM init）を待つ上限。VST3 の起動は CLAP の dlopen より重く、
/// CLAP 版から流用した固定 sleep（800ms/600ms）では child が最初の block を出す前に測定/kill してしまう
/// ことが実機診断（2026-07-10・Opus 非サンドボックス RUN）で判明した。fresh > 0（child が処理した出力を
/// host が実際に読んだ）になるまで poll し、間に合わなければ本当に動いていないとみなして fail させる。
const WARM_UP_TIMEOUT: Duration = Duration::from_secs(10);

/// repo ルート相対パスを解決する（MANIFEST_DIR = rust/crates/orbit-audio-daemon）。
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).join(rel)
}

/// VST3 effect child binary（`orbit-vst3-effect-child`）のパスを解決する。
///
/// 別 crate の binary なので `CARGO_BIN_EXE_*` は使えない（CLAP 版 `child_exe()` と同じ理由）。test
/// 実行ファイル（`target/<profile>/deps/<name>-<hash>`）の祖先から sibling binary を導く
/// （profile 非依存）。
fn vst3_child_exe() -> PathBuf {
    let mut p = std::env::current_exe().expect("current_exe");
    p.pop(); // test exe 名を除く → deps/
    if p.ends_with("deps") {
        p.pop(); // deps/ を除く → target/<profile>/
    }
    p.push("orbit-vst3-effect-child");
    p
}

/// `orbit-vst3-gain-oracle/package-oracle.sh` を実行して `GainOracle.vst3` bundle を組み立て、絶対
/// パスを返す（`oracle_parity.rs` の `package_oracle()` と同じスクリプトを同じ呼び方で使う）。
fn package_oracle() -> PathBuf {
    let script = repo_path("rust/crates/orbit-vst3-gain-oracle/package-oracle.sh");
    let output = Command::new(&script).output().unwrap_or_else(|e| {
        panic!(
            "VST3 oracle packaging script 実行失敗 {}: {e}",
            script.display()
        )
    });
    assert!(
        output.status.success(),
        "VST3 oracle packaging 失敗 (status={}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    PathBuf::from(stdout.trim())
}

/// gated 前提（child binary / oracle bundle / 音源）を確認して config と音源 path を返す。揃わなければ
/// panic で loud に止める（CLAP 版 `setup_test` の VST3 ミラー）。
fn setup_test(buffer_frames: Option<u32>) -> (OutProcEffectConfig, PathBuf) {
    let cfg = OutProcEffectConfig {
        format: PluginFormat::Vst3,
        child_exe: vst3_child_exe(),
        plugin: package_oracle(),
        plugin_id: None, // 単一プラグイン bundle なので id 省略可
        buffer_frames,
    };
    let wav = repo_path("test-assets/audio/sine_440.wav");
    assert!(
        cfg.child_exe.exists(),
        "VST3 effect child binary が無い: {} — 先に `cargo build -p orbit-vst3-effect-child`",
        cfg.child_exe.display()
    );
    assert!(
        cfg.plugin.exists(),
        "VST3 gain oracle bundle が無い: {}",
        cfg.plugin.display()
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

/// child が最初の fresh 出力（＝実際に処理済みの block）を host に届けるまで poll する。`WARM_UP_TIMEOUT`
/// 経過しても fresh=0 のままなら false（本当に OOP 経路が動いていない場合はここで検出する）。
fn wait_until_productive(engine: &EngineWrap) -> bool {
    wait_until(WARM_UP_TIMEOUT, || {
        engine
            .outproc_effect_stats()
            .map(|s| s.fresh > 0)
            .unwrap_or(false)
    })
}

// ── C1 parity: OOP VST3 effect が master bus を加工する（post/dry ≈ ORACLE_GAIN）───────────────
#[test]
#[ignore = "VST3 Phase1 C1: needs a real output device + built orbit-vst3-effect-child (local only)"]
fn outproc_effect_vst3_processes_audio_via_daemon() {
    let (cfg, wav) = setup_test(None);
    let (engine, _guard) = EngineWrap::start_outproc_effect(cfg).expect("start OOP effect daemon");
    play_sine(&engine, &wav);
    // child の cold-start（CFBundle load + COM init）を待つ。固定 sleep だと child が最初の block を出す
    // 前に測定してしまうことがある（診断根拠は WARM_UP_TIMEOUT のコメント参照）。
    let productive = wait_until_productive(&engine);
    assert!(
        productive,
        "warm-up timeout（{WARM_UP_TIMEOUT:?}）: child が一度も fresh 出力を出さなかった \
         （OOP 経路が動いていない）"
    );
    // warm-up 中の stall/prime block を測定対象から除外する: peak をリセットし、fresh/callback_count は
    // リセット API が無いのでここで基準点を記録して差分で測る。
    engine.outproc_reset_peaks();
    let baseline = engine.outproc_effect_stats().expect("stats");
    let fresh_before = baseline.fresh;
    let callback_count_before = baseline.callback_count;
    // 安定した測定窓を確保する（多数の callback を集める）。
    std::thread::sleep(Duration::from_millis(1500));

    let s = engine
        .outproc_effect_stats()
        .expect("outproc stats available");
    let cb = engine
        .outproc_callback_stats()
        .expect("callback stats available");
    let fresh_delta = s.fresh.saturating_sub(fresh_before);
    let callback_delta = s.callback_count.saturating_sub(callback_count_before);
    let ratio = if s.dry_peak > 0.0 {
        s.post_peak / s.dry_peak
    } else {
        0.0
    };
    println!("=== VST3 Phase1 C1 OOP effect parity verdict ===");
    println!("dry_peak:            {:.5}", s.dry_peak);
    println!("post_peak:           {:.5}", s.post_peak);
    println!("ratio (post/dry):    {ratio:.5}  (expect ~{ORACLE_GAIN})");
    println!(
        "fresh / stale / stall (cumulative): {} / {} / {}",
        s.fresh, s.stale, s.stall
    );
    println!("fresh_delta (post warm-up):   {fresh_delta}");
    println!("callback_delta (post warm-up): {callback_delta}");
    println!("callback_count:      {}", s.callback_count);
    println!("callback_max_ns:     {}", cb.max_ns);
    println!("callback_p99_ns:     {}", cb.p99_ns);
    println!("respawn_count:       {}", s.respawn_count);
    println!("child_proc_errors:   {}", s.child_process_error_count);
    println!("==================================================");

    assert!(
        !s.measurement_invalid,
        "respawn 失敗で計測無効（child binary を確認）"
    );
    assert!(
        s.dry_peak > 0.01,
        "engine が発音しなかった (dry_peak={:.5})。sample 再生経路を確認",
        s.dry_peak
    );
    // fresh_delta > 0 = warm-up 後、child が処理した出力を host が実際に読んだ
    // （dead child なら stale のみで fresh は増えない）。
    assert!(
        fresh_delta > 0,
        "warm-up 後に fresh 出力を読めていない（OOP 経路が動いていない）"
    );
    // **持続的**に fresh を読めている（測定窓の過半数の callback が fresh）= effect が run 全体で
    // 生きていた（CLAP 版 test-coverage review Important 1 の教訓を踏襲）。warm-up 中の stall は
    // fresh_delta/callback_delta から除外済みなので、この閾値は warm-up の遅さに左右されない。
    assert!(
        fresh_delta > callback_delta / 2 && fresh_delta > 10,
        "fresh が持続していない（fresh_delta={fresh_delta} / callback_delta={callback_delta}）\
         — effect が run 途中で停止した疑い"
    );
    // serial insert の gain 比。余白は resampling / peak 整列のずれを吸収（理論値 ORACLE_GAIN）。
    assert!(
        RATIO_TOLERANCE.contains(&ratio),
        "OOP VST3 effect gain 比が想定外: {ratio:.5}（期待 ~{ORACLE_GAIN}）。\
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

// ── C2 kill-test: child SIGKILL → daemon 生存 → respawn → fresh 処理復帰 ──────────────────────
#[test]
#[ignore = "VST3 Phase1 C2: needs a real output device + built orbit-vst3-effect-child (local only)"]
fn outproc_effect_vst3_survives_child_kill_and_respawns() {
    let (cfg, wav) = setup_test(None);
    let (engine, _guard) = EngineWrap::start_outproc_effect(cfg).expect("start OOP effect daemon");
    play_sine(&engine, &wav);
    // child の cold-start を待つ（固定 sleep だと kill 前に OOP effect がまだ動いていないことがある。
    // 診断根拠は WARM_UP_TIMEOUT のコメント参照）。
    let productive = wait_until_productive(&engine);
    assert!(
        productive,
        "warm-up timeout（{WARM_UP_TIMEOUT:?}）: kill 前に OOP effect が fresh 出力を出さなかった"
    );

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

    // 新 child の cold-start（CFBundle load + COM init）を待つ: respawn 直後の固定 sleep だと新 child が
    // まだ productive になっていないことがある（kill 前と同じ理由・診断根拠は WARM_UP_TIMEOUT 参照）。
    // fresh が respawn 前の基準を超えるまで poll する。
    let recovered = wait_until(WARM_UP_TIMEOUT, || {
        engine
            .outproc_effect_stats()
            .map(|s| s.fresh > fresh_after_respawn)
            .unwrap_or(false)
    });
    // productive を確認した後、gain 比を安定させるため少し追加で block を蓄積する。
    std::thread::sleep(Duration::from_millis(300));
    let s = engine.outproc_effect_stats().expect("stats");
    let ratio = if s.dry_peak > 0.0 {
        s.post_peak / s.dry_peak
    } else {
        0.0
    };
    println!("=== VST3 Phase1 C2 OOP effect kill-test verdict ===");
    println!("killed pid:          {pid}");
    println!(
        "respawn_count:       {} (before {})",
        s.respawn_count, respawns_before
    );
    println!(
        "fresh after respawn: {} -> {}",
        fresh_after_respawn, s.fresh
    );
    println!("ratio (post/dry):    {ratio:.5}  (expect ~{ORACLE_GAIN})");
    println!("measurement_invalid: {}", s.measurement_invalid);
    println!("=====================================================");

    assert!(!s.measurement_invalid, "respawn 失敗で計測無効");
    assert!(
        recovered,
        "respawn 後 warm-up timeout（{WARM_UP_TIMEOUT:?}）以内に fresh 処理が復帰しなかった \
         （新 child の cold-start が間に合わなかった疑い）"
    );
    // 新 child が fresh 出力を生み host が読んだ = repeat-previous でなく実処理が復帰した。
    assert!(
        s.fresh > fresh_after_respawn,
        "respawn 後に fresh 処理が復帰していない（repeat-previous だけでは fresh は増えない）"
    );
    assert!(
        RATIO_TOLERANCE.contains(&ratio),
        "respawn 後の effect gain 比が想定外: {ratio:.5}（期待 ~{ORACLE_GAIN}）"
    );
    // _guard drop で teardown。
}

// ── C3 stale-rate: 32/64f 小バッファの viability 計測 → owner が SLOTS 2 vs 3 を決定 ──────────────
#[test]
#[ignore = "VST3 Phase1 C3: needs a real output device that supports small buffers (local only)"]
fn outproc_effect_vst3_small_buffer_stale_rate() {
    println!(
        "=== VST3 Phase1 C3 OOP effect stale-rate verdict (SLOTS={}) ===",
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

        // sanity floor（catastrophic でないこと）。SLOTS の最終判断は上の数値を owner が読んで行う。
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
        // catastrophic stale（半数以上が間に合わない）は viability 無し。
        assert!(
            stale_pct < 50.0,
            "[{frames}f] stale_pct が壊滅的: {stale_pct:.3}%（SLOTS={} で viability なし）",
            orbit_audio_sandbox::SLOTS
        );
    }
    println!("=================================================================");
}

// ── C4 commercial smoke: 実市販 VST3 プラグインを daemon 経路に流す（env 駆動・owner 実行用）───────
//
// 既知 gain が無いので parity assert はしない。crash-free（respawn 無し）+ measurement_invalid でない +
// child_process_error_count==0 の smoke に限定する。`ORBIT_EFFECT_PLUGIN` 未設定は loud skip。
#[test]
#[ignore = "VST3 Phase1 C4: commercial plugin smoke — set ORBIT_EFFECT_PLUGIN to a real .vst3 bundle + real device (local only)"]
fn outproc_effect_vst3_commercial_plugin_smoke() {
    let Some(plugin_env) = std::env::var_os("ORBIT_EFFECT_PLUGIN") else {
        println!(
            "ORBIT_EFFECT_PLUGIN が未設定 — commercial VST3 smoke test を skip \
             （実 .vst3 bundle の絶対パスを設定して実行すること）"
        );
        return;
    };
    let plugin = PathBuf::from(plugin_env);
    assert!(
        plugin.exists(),
        "ORBIT_EFFECT_PLUGIN のパスが存在しない: {}",
        plugin.display()
    );
    let child_exe = vst3_child_exe();
    assert!(
        child_exe.exists(),
        "VST3 effect child binary が無い: {} — 先に `cargo build -p orbit-vst3-effect-child`",
        child_exe.display()
    );
    let wav = repo_path("test-assets/audio/sine_440.wav");
    assert!(wav.exists(), "音源 WAV が無い: {}", wav.display());

    let cfg = OutProcEffectConfig {
        format: PluginFormat::Vst3,
        child_exe,
        plugin: plugin.clone(),
        plugin_id: std::env::var("ORBIT_EFFECT_PLUGIN_ID").ok(),
        buffer_frames: None,
    };

    let (engine, _guard) = EngineWrap::start_outproc_effect(cfg).unwrap_or_else(|e| {
        panic!(
            "start OOP effect daemon 失敗（plugin={}）: {e}",
            plugin.display()
        )
    });
    play_sine(&engine, &wav);
    // 市販プラグインは load/warm-up がさらに重い可能性があるため、固定 sleep 単体ではなく fresh 出力が
    // 出るまで poll してから測定窓を追加する（parity は assert しないので timeout 自体は fail させず、
    // loud に記録するだけに留める — crash-free / measurement_invalid のチェックは以降も続行する）。
    let productive = wait_until_productive(&engine);
    if !productive {
        println!(
            "[C4] warm-up timeout（{WARM_UP_TIMEOUT:?}）内に fresh 出力を確認できなかった \
             — plugin load が重い可能性（parity は assert しないため以降の crash-free チェックは続行する）"
        );
    }
    std::thread::sleep(Duration::from_millis(500));

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
    println!(
        "=== VST3 Phase1 C4 commercial plugin smoke verdict: {} ===",
        plugin.display()
    );
    println!("dry_peak:            {:.5}", s.dry_peak);
    println!("post_peak:           {:.5}", s.post_peak);
    println!("ratio (post/dry):    {ratio:.5}  (unknown gain — not asserted)");
    println!(
        "fresh / stale / stall: {} / {} / {}",
        s.fresh, s.stale, s.stall
    );
    println!("callback_count:      {}", s.callback_count);
    println!("callback_max_ns:     {}", cb.max_ns);
    println!("callback_p99_ns:     {}", cb.p99_ns);
    println!("respawn_count:       {}", s.respawn_count);
    println!("child_proc_errors:   {}", s.child_process_error_count);
    println!("measurement_invalid: {}", s.measurement_invalid);
    println!("=====================================================================");

    assert!(
        !s.measurement_invalid,
        "計測無効（respawn 失敗）— plugin load / child spawn を確認（plugin={}）",
        plugin.display()
    );
    assert!(
        s.dry_peak > 0.01,
        "engine が発音しなかった (dry_peak={:.5})。sample 再生経路を確認",
        s.dry_peak
    );
    assert_eq!(
        s.respawn_count,
        0,
        "commercial smoke 中に respawn が発生した = child crash の疑い（plugin={}）",
        plugin.display()
    );
    assert_eq!(
        s.child_process_error_count,
        0,
        "child 側で processing error が計測された（plugin={}）",
        plugin.display()
    );
    assert!(
        cb.max_ns < CALLBACK_MAX_BUDGET_NS,
        "callback max が異常に大きい ({} ns ≈ {:.2} ms) — RT 違反の疑い（plugin={}）",
        cb.max_ns,
        cb.max_ns as f64 / 1e6,
        plugin.display()
    );
    // gain 不明なので post/dry ratio は assert しない（printed verdict を owner が目視確認する）。
    // _guard drop で teardown。
}
