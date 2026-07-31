#![cfg(target_os = "macos")]

//! Kontakt の **state 復元**を実機で押さえる gated probe（#606）。
//!
//! 動機: `instrument(..., "states/strings.state")` を指定すると child が READY を
//! 発行せず 120s でタイムアウトする一方、state 無しでは READY が出る、という
//! 対照実験の結果があった。`Vst3InstrumentProcessor::load` は
//! `publish_child_ready` より**前**に走り、その時点で **CFRunLoop はまだ回っていない**
//! （`orbit-vst3-instrument-child/src/main.rs`: load → READY → `run_child`）。
//!
//! このテストは daemon / child / shm をすべて外し、**`load` + state だけ**を
//! 同じ「runloop の無いスレッド」から叩く。ハングが再現すれば原因は host 側の
//! state 適用に確定し、再現しなければ child 固有の環境要因に絞れる。
//!
//! ゲート: `ORBIT_GATED_KONTAKT_STATE=1` かつ `ORBIT_KONTAKT_STATE_FILE` が
//! 実在すること。未設定なら loud skip（通常の `cargo test` を壊さない）。

use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use orbit_vst3_host::Vst3InstrumentProcessor;

const SAMPLE_RATE: f64 = 48_000.0;
const FRAMES: i32 = 512;

/// child 側の `CHILD_READY_TIMEOUT` と同じ桁で待つ。これを超えたら
/// 「遅い」ではなく「進んでいない」と判定する。
const HANG_THRESHOLD: Duration = Duration::from_secs(90);

fn gated_env() -> Option<(PathBuf, PathBuf)> {
    if std::env::var("ORBIT_GATED_KONTAKT_STATE").ok().as_deref() != Some("1") {
        eprintln!(
            "ORBIT_GATED_KONTAKT_STATE != 1; loud skip (実機 Kontakt と state ファイルが要る)"
        );
        return None;
    }
    let bundle = PathBuf::from(
        std::env::var("ORBIT_KONTAKT_BUNDLE")
            .unwrap_or_else(|_| "/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3".to_string()),
    );
    let Ok(state) = std::env::var("ORBIT_KONTAKT_STATE_FILE") else {
        eprintln!("ORBIT_KONTAKT_STATE_FILE 未設定; loud skip");
        return None;
    };
    let state = PathBuf::from(state);
    if !bundle.exists() {
        eprintln!("{} が無い; loud skip", bundle.display());
        return None;
    }
    if !state.exists() {
        eprintln!("{} が無い; loud skip", state.display());
        return None;
    }
    Some((bundle, state))
}

/// `load` を別スレッドで走らせ、**戻ってきたかどうか**だけを測る。
///
/// `load` 自体が返らない可能性を測るテストなので、呼び出しスレッドを
/// join してはいけない（join すると測定側ごとハングする）。チャネルの
/// タイムアウト受信で「返らなかった」を観測し、スレッドは leak させる
/// ——プロセス終了時に落ちる。
fn load_with_timeout(
    bundle: PathBuf,
    state: Option<Vec<u8>>,
    limit: Duration,
) -> Option<(Duration, Result<(), String>)> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let started = Instant::now();
        let outcome = Vst3InstrumentProcessor::load(
            &bundle,
            SAMPLE_RATE,
            FRAMES,
            state.as_deref(),
        )
        .map(|(processor, info)| {
            // `info` を読んでから drop する。drop 自体が固まる経路も
            // 測定対象なので、成功時も経過時間は送信後に測らない。
            eprintln!(
                "loaded: is_effect={} audio_outputs={}",
                info.is_effect, info.audio_outputs
            );
            drop(processor);
        })
        .map_err(|error| error.to_string());
        let _ = tx.send((started.elapsed(), outcome));
    });
    rx.recv_timeout(limit).ok()
}

/// 対照(B): state 無しでの load は返る。**(A) の判定に意味を持たせるための対照**で、
/// これが返らないなら原因は state ではない。
#[test]
fn kontakt_loads_without_state() {
    let Some((bundle, _)) = gated_env() else {
        return;
    };
    let Some((elapsed, outcome)) = load_with_timeout(bundle, None, HANG_THRESHOLD) else {
        panic!(
            "対照(B) が {HANG_THRESHOLD:?} 以内に返らなかった。state 以前の問題であり、\
             このテストが切り分けようとしている仮説（state 復元が原因）は成立しない"
        );
    };
    outcome.unwrap_or_else(|error| panic!("state 無しの load が失敗: {error}"));
    eprintln!("(B) state 無し: {elapsed:?} で load 完了");
}

/// 本命(A): state 付きの load が返るか。返らなければ
/// `apply_state_chunks`（= `IComponent::setState`）以降が
/// **runloop の無いスレッドで進めない**ことの一次証拠になる。
#[test]
fn kontakt_loads_with_saved_state() {
    let Some((bundle, state_path)) = gated_env() else {
        return;
    };
    let bytes = std::fs::read(&state_path)
        .unwrap_or_else(|error| panic!("state ファイルが読めない {}: {error}", state_path.display()));
    assert!(
        !bytes.is_empty(),
        "state ファイルが空 — 復元の検証にならない"
    );
    eprintln!("(A) state {} bytes を適用して load", bytes.len());

    let Some((elapsed, outcome)) = load_with_timeout(bundle, Some(bytes), HANG_THRESHOLD) else {
        panic!(
            "🔴 (A) state 付き load が {HANG_THRESHOLD:?} 以内に返らなかった。\
             daemon / child / shm を外しても再現する = 原因は host 側の state 適用にある。\
             別ターミナルから `sample <このプロセスの pid>` でブロック地点を採取すること"
        );
    };
    outcome.unwrap_or_else(|error| panic!("state 付きの load が失敗: {error}"));
    eprintln!("(A) state 付き: {elapsed:?} で load 完了");
}
