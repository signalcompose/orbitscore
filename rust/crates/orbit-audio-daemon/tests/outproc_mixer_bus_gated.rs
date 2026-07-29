//! Issue #459/#453 M2: mixer graph（insert + sum + aux）を実機 daemon 上で組み合わせ、
//! `SetBusRouting`（`EngineWrap::set_bus_routing`）で実行時に配線した経路が gain oracle を通じて
//! 検証できることを確認する gated test（骨格・#459/#453 M2 の依頼元が実機 RUN を担当する）。
//!
//! セットアップ:
//! - insert bus 1 個（`ORBIT_EFFECT_BUSES=seq-bus-0`）・sum bus 1 個（`ORBIT_SUM_BUS_POOL=1` →
//!   `sum-bus-0`）・aux bus 1 個（`ORBIT_AUX_BUS_POOL=1` → `aux-bus-0`）を起動前に env 固定する
//!   （`outproc_effect_bus_gated.rs` と同じ制約: env は `build_effect_bus_stages` が起動時に一度
//!   だけ読むため、プロセス起動前に固定し `--test-threads=1` で実行する）。
//! - 各 bus に gain oracle（test-effect .clap・`EFFECT_GAIN` 定数）を `load_outproc_effect_plugin`
//!   で attach する。
//! - `engine.set_bus_routing("seq-bus-0", Some("sum-bus-0"), &[("aux-bus-0".into(), 0.5)])` で
//!   insert bus の output を sum へ、send を aux へ実行時に配線する（M2 の核心 = `SetBusRouting` が
//!   非 RT で atomic を書き換え、次 callback から反映される・`orbit_audio_native::output` の
//!   `routing_override_retargets_output_from_master_to_bus_on_next_callback` /
//!   `send_gain_override_applies_from_the_correct_slot_on_next_callback` unit test と対になる
//!   実機検証）。
//! - closed-form oracle: insert bus 通過後の gain は `EFFECT_GAIN`（0.5）。sum bus 通過後は
//!   さらに `EFFECT_GAIN` を掛けた `EFFECT_GAIN^2 = 0.25`（sum 自身にも gain oracle を attach する
//!   ため）。aux 経由の send は insert 後・send gain（0.5）適用後にさらに aux 自身の gain oracle を
//!   経由するので `EFFECT_GAIN * 0.5 * EFFECT_GAIN = 0.125`。
//!
//! 前提（実行前にビルドすること）:
//!   cargo build -p orbit-clap-effect-child
//!   cargo build --manifest-path rust-spike/clap-test-effect/Cargo.toml
//! 実行（bus 用 env を先に固定し、他テストとの set_var 競合を避けるため単一スレッドで実行）:
//!   ORBIT_EFFECT_BUSES=seq-bus-0 ORBIT_SUM_BUS_POOL=1 ORBIT_AUX_BUS_POOL=1 \
//!     cargo test -p orbit-audio-daemon --features outproc-effect \
//!     --test outproc_mixer_bus_gated -- --ignored --nocapture --test-threads=1
//!
//! device / dylib / child binary が揃わない env（headless CI 等）では owner へ stop&report
//! （手動 fallback）。本ファイルは #459/#453 M2 の依頼で **compile まで**を成功条件とし、実機
//! RUN 自体は依頼元が行う。

#![cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]

mod gated_common;
use gated_common::{child_exe, repo_path, wait_until};

use std::path::PathBuf;
use std::time::Duration;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};

/// test-effect が乗算する固定 gain（`outproc_effect_bus_gated.rs` と同一値）。
const EFFECT_GAIN: f32 = 0.5;
const SEQ_BUS: &str = "seq-bus-0";
const SUM_BUS: &str = "sum-bus-0";
const AUX_BUS: &str = "aux-bus-0";

fn test_effect_dylib() -> PathBuf {
    repo_path("rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib")
}

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

fn assert_env(name: &str, expected: &str) {
    assert_eq!(
        std::env::var(name).as_deref(),
        Ok(expected),
        "run with `{name}={expected}` set before the test binary starts \
         (env is read once at `build_effect_bus_stages`, not settable from inside a test)"
    );
}

// ── insert → sum(output) / aux(send) の実行時配線が gain oracle の closed-form に一致する ──────
#[test]
#[ignore = "#459/#453 M2: needs ORBIT_EFFECT_BUSES=seq-bus-0 ORBIT_SUM_BUS_POOL=1 ORBIT_AUX_BUS_POOL=1 set before process start + a real output device + built child binary + test-effect dylib (local only)"]
fn set_bus_routing_wires_insert_to_sum_output_and_aux_send() {
    assert_env("ORBIT_EFFECT_BUSES", SEQ_BUS);
    assert_env("ORBIT_SUM_BUS_POOL", "1");
    assert_env("ORBIT_AUX_BUS_POOL", "1");

    let (cfg, wav) = setup_test();
    let (engine, _guard) =
        EngineWrap::start_outproc_effect_post_boot(cfg).expect("start OOP effect daemon");

    let dylib = test_effect_dylib();
    for bus in [SEQ_BUS, SUM_BUS, AUX_BUS] {
        engine
            .load_outproc_effect_plugin(dylib.clone(), None, Some(bus.to_owned()))
            .unwrap_or_else(|e| panic!("attach gain oracle to bus '{bus}': {e}"));
    }

    // M2 の核心: 非 RT で insert(seq-bus-0) の output を sum(sum-bus-0) へ、send を aux(aux-bus-0)
    // へ実行時に配線する。
    engine
        .set_bus_routing(SEQ_BUS, Some(SUM_BUS), &[(AUX_BUS.to_owned(), 0.5)])
        .expect("SetBusRouting must accept sum output + aux send");

    let sample = engine.load_sample(wav).expect("load sine sample");
    let onset = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(
            &sample.sample_id,
            onset,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            Some(SEQ_BUS.to_owned()),
        )
        .expect("play sine tagged to seq-bus-0");

    assert!(
        wait_until(Duration::from_secs(3), || engine
            .outproc_effect_bus_stats(SUM_BUS)
            .map(|s| s.fresh > 0)
            .unwrap_or(false)),
        "sum bus '{SUM_BUS}' が fresh 処理を報告しない（routing / attach を確認）"
    );
    std::thread::sleep(Duration::from_millis(600));

    let seq_stats = engine
        .outproc_effect_bus_stats(SEQ_BUS)
        .expect("seq bus stats available");
    let sum_stats = engine
        .outproc_effect_bus_stats(SUM_BUS)
        .expect("sum bus stats available");
    let aux_stats = engine
        .outproc_effect_bus_stats(AUX_BUS)
        .expect("aux bus stats available");

    println!("=== #459/#453 M2 mixer routing verdict ===");
    println!(
        "seq: dry={:.5} post={:.5} | sum: dry={:.5} post={:.5} | aux: dry={:.5} post={:.5}",
        seq_stats.dry_peak,
        seq_stats.post_peak,
        sum_stats.dry_peak,
        sum_stats.post_peak,
        aux_stats.dry_peak,
        aux_stats.post_peak,
    );
    println!("============================================");

    assert!(
        !seq_stats.measurement_invalid,
        "seq bus の respawn 失敗で計測無効"
    );
    assert!(
        !sum_stats.measurement_invalid,
        "sum bus の respawn 失敗で計測無効"
    );
    assert!(
        !aux_stats.measurement_invalid,
        "aux bus の respawn 失敗で計測無効"
    );

    // closed-form oracle: sum は insert(gain)×sum(gain) = EFFECT_GAIN^2。aux は
    // insert(gain)×send(0.5)×aux(gain) = EFFECT_GAIN × 0.5 × EFFECT_GAIN。
    let expected_sum_ratio = EFFECT_GAIN * EFFECT_GAIN;
    let expected_aux_ratio = EFFECT_GAIN * 0.5 * EFFECT_GAIN;
    let sum_ratio = if sum_stats.dry_peak > 0.0 {
        sum_stats.post_peak / sum_stats.dry_peak
    } else {
        0.0
    };
    // sum bus の dry_peak は「sum に流れ込んだ (insert 後の) signal」なので、seq bus 自体の
    // post_peak/dry_peak 比（= EFFECT_GAIN 単体）とは別に、直接 hardware sum 経路の比較として
    // sum_stats.post_peak と seq_stats.dry_peak（元の raw playback peak）の比で
    // `expected_sum_ratio` を検証する（余白は resampling / peak 整列のずれを吸収）。
    let _ = sum_ratio; // 参考値として算出のみ（実機オラクルの主判定は次行）。
    assert!(
        seq_stats.dry_peak > 0.01,
        "insert bus に音が届いていない (dry_peak={:.5})",
        seq_stats.dry_peak
    );
    assert!(
        (expected_sum_ratio - 0.1..=expected_sum_ratio + 0.1)
            .contains(&(sum_stats.post_peak / seq_stats.dry_peak.max(1e-6))),
        "sum 経路の gain 比が想定外（期待 ~{expected_sum_ratio:.5}）"
    );
    assert!(
        (expected_aux_ratio - 0.1..=expected_aux_ratio + 0.1)
            .contains(&(aux_stats.post_peak / seq_stats.dry_peak.max(1e-6))),
        "aux send 経路の gain 比が想定外（期待 ~{expected_aux_ratio:.5}）"
    );
}

// ── sum バス発の send（sum → aux）+ aux リターンが実機で信号を運ぶ（#587） ──────────────────
//
// 上のテストの send 源は insert bus（seq-bus-0）。#587 の E2E（PR #585）が使うのは
// **sum バス発の send**（`autoSnapshotSum.autoSnapshotAux(1).master`）で、この形の send を
// 実機で pin するテストはこれまで存在しなかった（`set_bus_routing` は source 非依存の実装だが、
// 実装の同型性はテストの代わりにならない — #587 診断）。トポロジは E2E と同型:
//   seq(insert) → sum(output) / sum → aux(send 1.0) / aux → master(return)
// aux バスの dry_peak が「sum の post-insert 信号 × send 1.0」に一致すれば、
// **sum 発 send の送達**と **aux stage への到達**が bus 単位の実測で証明される。
#[test]
#[ignore = "#587: needs ORBIT_EFFECT_BUSES=seq-bus-0 ORBIT_SUM_BUS_POOL=1 ORBIT_AUX_BUS_POOL=1 set before process start + a real output device + built child binary + test-effect dylib (local only)"]
fn set_bus_routing_wires_sum_send_to_aux_and_return() {
    assert_env("ORBIT_EFFECT_BUSES", SEQ_BUS);
    assert_env("ORBIT_SUM_BUS_POOL", "1");
    assert_env("ORBIT_AUX_BUS_POOL", "1");

    let (cfg, wav) = setup_test();
    let (engine, _guard) =
        EngineWrap::start_outproc_effect_post_boot(cfg).expect("start OOP effect daemon");

    let dylib = test_effect_dylib();
    for bus in [SEQ_BUS, SUM_BUS, AUX_BUS] {
        engine
            .load_outproc_effect_plugin(dylib.clone(), None, Some(bus.to_owned()))
            .unwrap_or_else(|e| panic!("attach gain oracle to bus '{bus}': {e}"));
    }

    // E2E（PR #585）と同型の配線。send 源が sum バスである点が上のテストとの唯一の違い。
    engine
        .set_bus_routing(SEQ_BUS, Some(SUM_BUS), &[])
        .expect("SetBusRouting must accept seq → sum output");
    engine
        .set_bus_routing(SUM_BUS, Some("master"), &[(AUX_BUS.to_owned(), 1.0)])
        .expect("SetBusRouting must accept a sum-source send to aux");
    engine
        .set_bus_routing(AUX_BUS, Some("master"), &[])
        .expect("SetBusRouting must accept the aux return to master");

    let sample = engine.load_sample(wav).expect("load sine sample");
    let onset = engine.transport_or_uptime_sec() + 0.1;
    engine
        .play_at(
            &sample.sample_id,
            onset,
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            Some(SEQ_BUS.to_owned()),
        )
        .expect("play sine tagged to seq-bus-0");

    assert!(
        wait_until(Duration::from_secs(3), || engine
            .outproc_effect_bus_stats(AUX_BUS)
            .map(|s| s.fresh > 0)
            .unwrap_or(false)),
        "aux bus '{AUX_BUS}' が fresh 処理を報告しない（sum 発 send の routing / attach を確認）"
    );
    std::thread::sleep(Duration::from_millis(600));

    let seq_stats = engine
        .outproc_effect_bus_stats(SEQ_BUS)
        .expect("seq bus stats available");
    let aux_stats = engine
        .outproc_effect_bus_stats(AUX_BUS)
        .expect("aux bus stats available");

    println!("=== #587 sum-source send verdict ===");
    println!(
        "seq: dry={:.5} post={:.5} | aux: dry={:.5} post={:.5}",
        seq_stats.dry_peak, seq_stats.post_peak, aux_stats.dry_peak, aux_stats.post_peak,
    );
    println!("====================================");

    assert!(
        !seq_stats.measurement_invalid,
        "seq bus の respawn 失敗で計測無効"
    );
    assert!(
        !aux_stats.measurement_invalid,
        "aux bus の respawn 失敗で計測無効"
    );
    assert!(
        seq_stats.dry_peak > 0.01,
        "insert bus に音が届いていない (dry_peak={:.5})",
        seq_stats.dry_peak
    );

    // closed-form oracle: aux の dry は insert(gain) × sum insert(gain) × send(1.0) = EFFECT_GAIN^2。
    // aux の post はさらに aux 自身の gain oracle を掛けた EFFECT_GAIN^3。
    let expected_aux_dry = EFFECT_GAIN * EFFECT_GAIN;
    let expected_aux_post = EFFECT_GAIN * EFFECT_GAIN * EFFECT_GAIN;
    assert!(
        (expected_aux_dry - 0.1..=expected_aux_dry + 0.1)
            .contains(&(aux_stats.dry_peak / seq_stats.dry_peak.max(1e-6))),
        "sum 発 send が aux に届いていない（dry 比の期待 ~{expected_aux_dry:.5}・実測 {:.5}）",
        aux_stats.dry_peak / seq_stats.dry_peak.max(1e-6)
    );
    assert!(
        (expected_aux_post - 0.1..=expected_aux_post + 0.1)
            .contains(&(aux_stats.post_peak / seq_stats.dry_peak.max(1e-6))),
        "aux insert が send 信号を処理していない（post 比の期待 ~{expected_aux_post:.5}・実測 {:.5}）",
        aux_stats.post_peak / seq_stats.dry_peak.max(1e-6)
    );
}
