//! #606: **サンプラーを複数 instance 同時に attach できるか**を実機で押さえる gated test。
//!
//! ## 症状（2026-08-01・Soundcinema の 6 声編成で発見）
//!
//! `seq.instrument("Kontakt 8.vst3", "<state>")` を 6 声ぶん宣言すると、child は 6 本
//! spawn されるのに **state を復元できるのは 4 本まで**で、残りは
//! **daemon のタイムアウトログも kill ログもクラッシュレポートも無しに消える**。
//! 別のラウンドでは 2 本で止まった — **本数は可変**であり、固定の上限ではない。
//!
//! ## 既に潰した仮説（同じ道を歩まないための記録）
//!
//! | 仮説 | 反証 |
//! |---|---|
//! | instrument slot pool の枯渇 | 枯渇時は `instrument slot pool exhausted` を返す。silent と矛盾。既定 8 slot |
//! | メモリ不足 | 物理 32GB・swap 使用 0。child は RSS ~1GB |
//! | Kontakt 側のプロセス数制限 | `kontakt_state_gated` の probe を **6 プロセス同時**に走らせて全部 4.36s で成功 |
//! | plugin state の破損 | 同 probe で単体 4.3s で復元成功 |
//! | instance 名の衝突による child 再利用 | engine は `plugin:<seqName>` を渡すので seq ごとに一意 |
//!
//! 残る容疑は **daemon の attach 経路（spawn〜READY 待ち〜supervisor）**。この test は
//! engine / extension / MCP をすべて外して daemon だけを駆動するので、再現すれば
//! daemon 側に確定し、再現しなければ engine 側の投入シーケンスに絞れる。
//!
//! ## ゲート
//!
//! `ORBIT_GATED_KONTAKT_MULTI=1` + `ORBIT_KONTAKT_STATE_FILE`。実出力デバイスが要る。

#![cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]

mod gated_common;
use gated_common::{child_exe, repo_path};

use std::path::PathBuf;

use orbit_audio_daemon::engine_wrap::EngineWrap;
use orbit_audio_daemon::outproc_effect::{OutProcEffectConfig, PluginFormat};
use orbit_audio_daemon::outproc_instrument::OutProcInstrumentConfig;

/// 作品の編成（piano 1 + strings 5 + gong 1）に合わせた声部数。
/// 4 本で止まる症状を跨ぐために、既定 slot 数（8）以下でかつ 4 より大きくする。
const INSTANCES: usize = 6;

fn gated_config() -> Option<(OutProcEffectConfig, OutProcInstrumentConfig, PathBuf)> {
    if std::env::var("ORBIT_GATED_KONTAKT_MULTI").ok().as_deref() != Some("1") {
        eprintln!("ORBIT_GATED_KONTAKT_MULTI != 1; loud skip");
        return None;
    }
    let plugin = PathBuf::from(
        std::env::var("ORBIT_KONTAKT_BUNDLE")
            .unwrap_or_else(|_| "/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3".to_string()),
    );
    let Ok(state) = std::env::var("ORBIT_KONTAKT_STATE_FILE").map(PathBuf::from) else {
        eprintln!("ORBIT_KONTAKT_STATE_FILE 未設定; loud skip");
        return None;
    };
    if !plugin.exists() || !state.exists() {
        eprintln!("Kontakt か state ファイルが無い; loud skip");
        return None;
    }

    let effect = OutProcEffectConfig {
        format: PluginFormat::Clap,
        child_exe: child_exe("orbit-clap-effect-child"),
        plugin: Some(repo_path(
            "rust-spike/clap-test-effect/target/debug/libclap_test_effect.dylib",
        )),
        plugin_id: None,
        buffer_frames: None,
    };
    let instrument = OutProcInstrumentConfig {
        child_exe: child_exe("orbit-vst3-instrument-child"),
        plugin: Some(plugin),
        plugin_id: None,
        buffer_frames: None,
        // 既定と同じ 8。「slot が足りない」を原因から外すため INSTANCES より大きく取る。
        slots: 8,
    };
    Some((effect, instrument, state))
}

/// 6 instance を順に attach し、**どこで落ちるか**を全件ぶん報告する。
///
/// 1 件目の失敗で `expect` して止めない — 「4 本目までは通る」という症状の形
/// （何本目で・どんなエラーで落ちるか）が、原因の切り分けそのものだから。
#[test]
#[ignore = "#606: needs a real output device + Kontakt + a saved state (local only)"]
fn kontakt_attaches_across_many_instances() {
    let Some((effect_cfg, instrument_cfg, state)) = gated_config() else {
        return;
    };
    let plugin = instrument_cfg
        .plugin
        .clone()
        .expect("gated config has a plugin");

    let (engine, _guard) = EngineWrap::start_outproc_both(effect_cfg, instrument_cfg)
        .expect("start both-role OOP daemon");

    let mut outcomes = Vec::with_capacity(INSTANCES);
    for i in 0..INSTANCES {
        let instance = format!("plugin:voice{i}");
        let started = std::time::Instant::now();
        let result = engine.load_outproc_instrument_plugin(
            plugin.clone(),
            None,
            Some(instance.clone()),
            Some(state.clone()),
        );
        let elapsed = started.elapsed();
        match &result {
            Ok(_) => eprintln!("  [{i}] {instance}: OK ({elapsed:?})"),
            Err(error) => eprintln!("  [{i}] {instance}: FAILED ({elapsed:?}) — {error}"),
        }
        outcomes.push((instance, result.map(|_| ()).map_err(|e| e.to_string())));
    }

    let failed: Vec<_> = outcomes
        .iter()
        .filter_map(|(name, result)| result.as_ref().err().map(|error| (name, error)))
        .collect();
    assert!(
        failed.is_empty(),
        "🔴 {}/{INSTANCES} instance の attach が失敗した。\
         daemon だけで再現するので原因は engine 側ではなく attach 経路にある。\
         失敗した instance: {:#?}",
        failed.len(),
        failed
    );
}

/// 上の逐次版が全件通ったので、次の容疑は**同時性**。
///
/// engine は DSL の宣言部を 1 回の評価でまとめて投入するため、`LoadPlugin` が
/// **並行に飛ぶ**。slot 割当は mutex 下だが READY 待ちは意図的にロック外
/// （`engine_wrap.rs` の「他の LoadPlugin を待たせない」設計）なので、
/// 同時 attach でしか出ないレースがここに残りうる。
///
/// 逐次版が green でこれが red なら、原因は**同時 attach**に確定する。
#[test]
#[ignore = "#606: needs a real output device + Kontakt + a saved state (local only)"]
fn kontakt_attaches_when_all_instances_arrive_at_once() {
    let Some((effect_cfg, instrument_cfg, state)) = gated_config() else {
        return;
    };
    let plugin = instrument_cfg
        .plugin
        .clone()
        .expect("gated config has a plugin");

    let (engine, _guard) = EngineWrap::start_outproc_both(effect_cfg, instrument_cfg)
        .expect("start both-role OOP daemon");

    let handles: Vec<_> = (0..INSTANCES)
        .map(|i| {
            let engine = engine.clone();
            let plugin = plugin.clone();
            let state = state.clone();
            std::thread::spawn(move || {
                let instance = format!("plugin:voice{i}");
                let started = std::time::Instant::now();
                let result = engine.load_outproc_instrument_plugin(
                    plugin,
                    None,
                    Some(instance.clone()),
                    Some(state),
                );
                let elapsed = started.elapsed();
                match &result {
                    Ok(_) => eprintln!("  [{i}] {instance}: OK ({elapsed:?})"),
                    Err(error) => eprintln!("  [{i}] {instance}: FAILED ({elapsed:?}) — {error}"),
                }
                (instance, result.map(|_| ()).map_err(|e| e.to_string()))
            })
        })
        .collect();

    let outcomes: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().expect("attach thread did not panic"))
        .collect();

    let failed: Vec<_> = outcomes
        .iter()
        .filter_map(|(name, result)| result.as_ref().err().map(|error| (name, error)))
        .collect();
    assert!(
        failed.is_empty(),
        "🔴 同時 attach で {}/{INSTANCES} が失敗した（逐次版は全件成功）。\
         原因は同時性にある。失敗した instance: {:#?}",
        failed.len(),
        failed
    );
}
