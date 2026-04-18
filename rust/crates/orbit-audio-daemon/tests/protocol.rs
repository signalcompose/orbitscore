//! orbit-audio-daemon WebSocket protocol の integration test。
//!
//! 方針:
//! - `StubBackend` で audio device なしに `EngineWrap` を構築
//! - `server::bind_localhost` + `server::serve` を tokio task に乗せ TCP loopback で accept
//! - `tokio::test(flavor = "current_thread", start_paused = true)` で虚時間を操作
//! - 各テスト scope 終了時に `TestDaemon::Drop` が accept loop を abort する
//!
//! `tests/common/mod.rs` のヘルパー経由で Handshake/Command/Event を操作する。

mod common;

use std::time::Duration;

use common::{
    advance_and_yield, next_json, recv_reply_for_id, recv_reply_with_events, send_cmd, TestDaemon,
};
use serde_json::json;

/// 接続直後に daemon が送る handshake フレームの検証。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn handshake_frame_is_sent() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let hs = TestDaemon::recv_handshake(&mut ws).await;
    assert_eq!(hs["type"], "handshake");
    assert_eq!(hs["protocol_version"], "0.1");
    assert!(hs["daemon_version"].is_string());
    assert!(hs["capabilities"].is_array());
}

/// LoadSample → PlayAt → PlayStarted + PlayEnded を受け取れる経路。
///
/// 虚時間を sample duration 分 advance することで schedule された
/// PlayEnded タスクを発火させる。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn play_at_then_play_started_and_play_ended() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // `CARGO_MANIFEST_DIR` 起点で test-assets 内の kick.wav を参照する。
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let wav_path = format!("{manifest_dir}/../../../test-assets/audio/kick.wav");

    send_cmd(&mut ws, "cmd-load", "LoadSample", json!({ "path": wav_path })).await;
    let load_resp = recv_reply_for_id(&mut ws, "cmd-load").await;
    let sample_id = load_resp["result"]["sample_id"]
        .as_str()
        .unwrap_or_else(|| panic!("LoadSample should return sample_id, got: {load_resp}"))
        .to_string();

    send_cmd(
        &mut ws,
        "cmd-play",
        "PlayAt",
        json!({
            "sample_id": sample_id,
            "time_sec": 0.0,
            "gain": 1.0,
        }),
    )
    .await;
    let (_play_resp, early_events) = recv_reply_with_events(&mut ws, "cmd-play").await;
    // PlayStarted は PlayAt 実装上 reply より先に writer mpsc に乗るため
    // early_events に含まれる可能性がある。
    let mut saw_started = early_events.iter().any(|e| e["event"] == "PlayStarted");

    // sample duration を advance。kick.wav は 1 秒未満。
    advance_and_yield(Duration::from_secs(2)).await;

    let mut saw_ended = false;
    for _ in 0..20 {
        if saw_started && saw_ended {
            break;
        }
        let res = tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await;
        match res {
            Ok(msg) => match msg["event"].as_str() {
                Some("PlayStarted") => saw_started = true,
                Some("PlayEnded") => saw_ended = true,
                _ => {}
            },
            Err(_) => break,
        }
    }
    assert!(saw_started, "PlayStarted event missing");
    assert!(saw_ended, "PlayEnded event missing");
}

/// Stop された play_id では PlayEnded が発火しないことを確認する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stop_suppresses_play_ended() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let wav_path = format!("{manifest_dir}/../../../test-assets/audio/kick.wav");
    send_cmd(&mut ws, "l", "LoadSample", json!({ "path": wav_path })).await;
    let load_resp = recv_reply_for_id(&mut ws, "l").await;
    let sample_id = load_resp["result"]["sample_id"]
        .as_str()
        .unwrap_or_else(|| panic!("LoadSample resp missing sample_id: {load_resp}"))
        .to_string();

    send_cmd(
        &mut ws,
        "p",
        "PlayAt",
        json!({ "sample_id": sample_id, "time_sec": 0.0, "gain": 1.0 }),
    )
    .await;
    let play_resp = recv_reply_for_id(&mut ws, "p").await;
    let play_id = play_resp["result"]["play_id"]
        .as_str()
        .unwrap_or_else(|| panic!("PlayAt resp missing play_id: {play_resp}"))
        .to_string();

    send_cmd(&mut ws, "s", "Stop", json!({ "play_id": play_id })).await;
    let stop_resp = recv_reply_for_id(&mut ws, "s").await;
    assert!(
        stop_resp["result"].is_object(),
        "Stop should succeed: {stop_resp}"
    );

    // 残メッセージを消化しつつ、PlayEnded が来ないことを確認
    advance_and_yield(Duration::from_secs(2)).await;

    let mut saw_ended = false;
    for _ in 0..10 {
        let res = tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "PlayEnded" {
                    saw_ended = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(!saw_ended, "PlayEnded should be suppressed after Stop");
}

/// Stop の play_id パラメータ欠落時は MALFORMED_REQUEST。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stop_without_play_id_returns_malformed_request() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(&mut ws, "s", "Stop", json!({})).await;
    let resp = recv_reply_for_id(&mut ws, "s").await;
    assert_eq!(resp["error"]["code"], "MALFORMED_REQUEST");
}

/// Stop の play_id が未知の場合は `result.stopped=false`（エラーではない）を返す。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stop_unknown_id_returns_not_found() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(&mut ws, "s", "Stop", json!({ "play_id": "p-ghost" })).await;
    let resp = recv_reply_for_id(&mut ws, "s").await;
    // 実装は `{"status":"not_found"}` を返す（エラーではなく ok レスポンス）。
    assert_eq!(
        resp["result"]["status"], "not_found",
        "unknown play_id should yield status=not_found, got: {resp}"
    );
}

/// SetGlobalGain は正の値を受け入れる。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn set_global_gain_accepts() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(
        &mut ws,
        "g",
        "SetGlobalGain",
        json!({ "value": 0.5, "ramp_sec": 0.0 }),
    )
    .await;
    let resp = recv_reply_for_id(&mut ws, "g").await;
    assert!(resp["result"].is_object(), "got: {resp}");
}

/// SetGlobalGain は負の値を拒否する (PARAM_OUT_OF_RANGE)。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn set_global_gain_rejects_negative() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(
        &mut ws,
        "g",
        "SetGlobalGain",
        json!({ "value": -0.1, "ramp_sec": 0.0 }),
    )
    .await;
    let resp = recv_reply_for_id(&mut ws, "g").await;
    assert_eq!(resp["error"]["code"], "PARAM_OUT_OF_RANGE");
}

/// StreamStats は 1 Hz で発火する。2 tick advance で 2 件以上受信できる。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stream_stats_ticks_at_1hz() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // ticker は接続直後の INTERVAL 経過後に初回発火。2 tick を安定して観測するため
    // 5 秒分 advance する。各 advance 後に yield_now を複数回挟んで ticker task を駆動する。
    let mut stats_count = 0;
    for _ in 0..8 {
        advance_and_yield(Duration::from_secs(1)).await;
        // 蓄積された event を drain。各 tick 後に最大 5 件まで読み取る。
        for _ in 0..5 {
            let res = tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await;
            match res {
                Ok(msg) => {
                    if msg["event"] == "StreamStats" {
                        stats_count += 1;
                    }
                }
                Err(_) => break,
            }
        }
        if stats_count >= 2 {
            break;
        }
    }
    assert!(
        stats_count >= 2,
        "expected at least 2 StreamStats events after 5s advance, got {stats_count}"
    );
}

/// xrun が記録されると DaemonError (severity=warning, code=STREAM_XRUN) が発火する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_xrun() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から xrun を記録（StreamStats の record_xrun を直接呼ぶ）
    daemon.stats.record_xrun();

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut saw_warning = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "STREAM_XRUN"
                {
                    saw_warning = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(saw_warning, "STREAM_XRUN warning event not received");
}

/// device_lost が記録されると DaemonError (severity=fatal, code=DEVICE_LOST) が発火する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_fatal_on_device_lost() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    daemon.stats.record_device_lost();

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut saw_fatal = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "fatal"
                    && msg["data"]["code"] == "DEVICE_LOST"
                {
                    saw_fatal = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(saw_fatal, "DEVICE_LOST fatal event not received");
}
