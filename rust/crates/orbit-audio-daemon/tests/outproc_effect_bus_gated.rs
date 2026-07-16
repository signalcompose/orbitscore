//! Issue #434 S2: named insert bus 経由の OOP effect が実機 daemon 上で bus-tagged 再生のみを
//! 加工し、untagged 再生を素通しすることを検証する gated test（設計・受け入れ監査対応の一部）。
//!
//! `outproc_effect_gated.rs`（master-bus 単一 effect）と同じセットアップパターンを踏襲し、bus 対応
//! 差分のみを追加する:
//! - master-bus 経路は `ORBIT_EFFECT_BUSES` 未設定（bus 0 個）でも `start_outproc_effect_post_boot` を
//!   通す。bus 1 個を登録するにはこの env を **プロセス起動前**にセットする必要がある（`from_env` は
//!   起動時に一度だけ読む）。`std::env::set_var` は他テストと競合するため、本ファイルは
//!   `--test-threads=1` 前提で実行する（ファイル冒頭のコマンド参照）。
//! - gain oracle（test-effect .clap・EFFECT_GAIN 定数）を `load_outproc_effect_plugin(path, None,
//!   Some("fx1"))` で bus "fx1" に直接 LoadPlugin する（`session.rs` の LoadPlugin WS 経路は通さず
//!   `EngineWrap` を直接叩く）。
//! - bus tag 付き `play_at(..., Some("fx1".into()))` は "fx1" bus の post-processor（gain oracle）を
//!   通り、`outproc_effect_bus_stats("fx1")` の `post_peak/dry_peak ≈ EFFECT_GAIN` で検証する。
//! - bus tag なし（`None`）の再生は bus を経由せず master へ素通しされるので、bus 側 `fresh` カウンタが
//!   増えないことで確認する。
//!
//! 前提（実行前にビルドすること）:
//!   cargo build -p orbit-clap-effect-child
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//! 実行（bus 用 env を先に固定し、他テストとの set_var 競合を避けるため単一スレッドで実行）:
//!   ORBIT_EFFECT_BUSES=fx1 cargo test -p orbit-audio-daemon --features outproc-effect \
//!     --test outproc_effect_bus_gated -- --ignored --nocapture --test-threads=1
//!
//! device / dylib / child binary が揃わない env（headless CI 等）では owner へ stop&report（手動 fallback）。

#![cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]

mod gated_common;
use gated_common::{child_exe, repo_path, wait_until};

use std::path::{Path, PathBuf};
use std::time::Duration;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};

/// test-effect が乗算する固定 gain（`outproc_effect_gated.rs` と同一値）。
const EFFECT_GAIN: f32 = 0.5;
const BUS_NAME: &str = "fx1";

fn test_effect_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib")
}

/// gated 前提を確認して config と音源 path を返す。bus 無し（plugin 未 attach のまま起動 →
/// bus へ post-boot attach）で `EngineWrap` を起動する。
fn setup_test() -> (OutProcEffectConfig, PathBuf) {
    let cfg = OutProcEffectConfig {
        format: PluginFormat::Clap,
        child_exe: child_exe("orbit-clap-effect-child"),
        plugin: None,
        plugin_id: None,
        buffer_frames: None,
    };
    let dylib = test_effect_dylib();
    let wav = repo_path("test-assets/audio/sine_440.wav");
    assert!(
        dylib.exists(),
        "test-effect dylib が無い: {} — 先に `cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml`",
        dylib.display()
    );
    assert!(
        cfg.child_exe.exists(),
        "effect child binary が無い: {} — 先に `cargo build -p orbit-clap-effect-child`",
        cfg.child_exe.display()
    );
    assert!(wav.exists(), "音源 WAV が無い: {}", wav.display());
    (cfg, wav)
}

fn play_sine(engine: &EngineWrap, wav: &Path, bus: Option<String>) {
    let sample = engine
        .load_sample(wav.to_path_buf())
        .expect("load sine sample");
    let onset = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(&sample.sample_id, onset, 1.0, 0.0, 0.0, 0.0, 1.0, bus)
        .expect("play sine");
}

fn gain_ratio(dry_peak: f32, post_peak: f32) -> f32 {
    if dry_peak > 0.0 {
        post_peak / dry_peak
    } else {
        0.0
    }
}

// ── bus-tagged 再生は bus の effect を通り、untagged 再生は素通しする ─────────────────────────
#[test]
#[ignore = "#434 S2: needs ORBIT_EFFECT_BUSES=fx1 set before process start + a real output device + built child binary + test-effect dylib (local only)"]
fn outproc_effect_bus_processes_tagged_playback_and_passes_untagged_through() {
    assert_eq!(
        std::env::var("ORBIT_EFFECT_BUSES").as_deref(),
        Ok(BUS_NAME),
        "run with `ORBIT_EFFECT_BUSES={BUS_NAME}` set before the test binary starts \
         (env is read once at `start_outproc_effect_post_boot`, not settable from inside a test)"
    );

    let (cfg, wav) = setup_test();
    let (engine, _guard) =
        EngineWrap::start_outproc_effect_post_boot(cfg).expect("start OOP effect daemon");

    // gain oracle を bus "fx1" に直接 attach（LoadPlugin WS 経路の `bus` param と同じ内部呼び出し）。
    let dylib = test_effect_dylib();
    engine
        .load_outproc_effect_plugin(dylib, None, Some(BUS_NAME.to_owned()))
        .expect("attach gain oracle to bus");

    // untagged 再生: master へ直行し bus を経由しない。
    play_sine(&engine, &wav, None);
    // bus-tagged 再生: bus "fx1" の effect を経由する。
    play_sine(&engine, &wav, Some(BUS_NAME.to_owned()));

    assert!(
        wait_until(Duration::from_secs(3), || engine
            .outproc_effect_bus_stats(BUS_NAME)
            .map(|s| s.fresh > 0)
            .unwrap_or(false)),
        "bus '{BUS_NAME}' が fresh 処理を報告しない（child spawn / bus routing を確認）"
    );
    std::thread::sleep(Duration::from_millis(600));

    let bus = engine
        .outproc_effect_bus_stats(BUS_NAME)
        .expect("bus stats available");
    let bus_ratio = gain_ratio(bus.dry_peak, bus.post_peak);

    println!("=== #434 S2 bus routing verdict ===");
    println!(
        "bus '{BUS_NAME}': dry_peak={:.5} post_peak={:.5} ratio={:.5} fresh={} (expect ~{EFFECT_GAIN})",
        bus.dry_peak, bus.post_peak, bus_ratio, bus.fresh
    );
    println!("=====================================");

    assert!(!bus.measurement_invalid, "bus の respawn 失敗で計測無効");
    assert!(
        bus.dry_peak > 0.01,
        "bus tagged 再生が bus へ届いていない (dry_peak={:.5})",
        bus.dry_peak
    );
    // serial insert の gain 比。余白は resampling / peak 整列のずれを吸収（理論値 EFFECT_GAIN）。
    assert!(
        (0.4..=0.6).contains(&bus_ratio),
        "bus effect の gain 比が想定外: {bus_ratio:.5}（期待 ~{EFFECT_GAIN}）。\
         bus routing / attach を確認"
    );
    // untagged 再生の「素通し」を master stats では検証できない: master effect slot は
    // plugin 未 attach（engaged=false）だと安全弁の early return で stats を一切更新しない設計
    // （outproc_effect.rs の process 冒頭・#431）。そこで bus/master の経路分離は
    // **bus 側の dry_peak が tagged 再生1本分のピークに一致すること**で検証する:
    // untagged が誤って bus に流入していれば、同時再生の重なりで dry_peak が
    // 1本分（sine 1.0 × equal-power √0.5 ≈ 0.707）を有意に超える。
    // untagged 音の bit-level 素通し自体は orbit-audio-native の unit
    // （render_block_one_bus_applies_effect_then_sums の untagged 検証）と S3 の
    // capture E2E が担う。
    assert!(
        bus.dry_peak <= 0.75,
        "bus dry_peak が tagged 1本分を超えている（untagged の bus への漏れ込み疑い）: {:.5}",
        bus.dry_peak
    );
    // _guard drop で teardown（bus / master 両方の watchdog 停止 → QUIT → reap → unlink）。
    // panic / UB なく完了することを検証。
}

// ── StreamGuard drop 後、bus child プロセスも master child と同様に回収されること ────────────────
#[test]
#[ignore = "#434 S2: needs ORBIT_EFFECT_BUSES=fx1 set before process start + a real output device + built child binary + test-effect dylib (local only)"]
fn outproc_effect_bus_child_is_reaped_on_stream_guard_drop() {
    assert_eq!(
        std::env::var("ORBIT_EFFECT_BUSES").as_deref(),
        Ok(BUS_NAME),
        "run with `ORBIT_EFFECT_BUSES={BUS_NAME}` set before the test binary starts"
    );

    let (cfg, _wav) = setup_test();
    let (engine, guard) =
        EngineWrap::start_outproc_effect_post_boot(cfg).expect("start OOP effect daemon");
    engine
        .load_outproc_effect_plugin(test_effect_dylib(), None, Some(BUS_NAME.to_owned()))
        .expect("attach gain oracle to bus");

    let bus_pid = wait_until(Duration::from_secs(3), || {
        engine
            .outproc_effect_bus_stats(BUS_NAME)
            .map(|s| s.current_child_pid != 0)
            .unwrap_or(false)
    });
    assert!(
        bus_pid,
        "bus child が起動しなかった（PID が publish されない）"
    );
    let pid = engine
        .outproc_effect_bus_stats(BUS_NAME)
        .expect("bus stats")
        .current_child_pid;

    drop(guard);
    drop(engine);

    // teardown 完了後は child プロセスが存在しない（`kill -0` は生存確認のみで signal を送らない）。
    let reaped = wait_until(Duration::from_secs(3), || {
        !std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .expect("kill -0 実行")
            .success()
    });
    assert!(
        reaped,
        "StreamGuard drop 後も bus child (pid {pid}) が生存している（teardown 未完了）"
    );
}
