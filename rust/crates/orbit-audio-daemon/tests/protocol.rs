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
use orbit_audio_daemon::protocol::EVENT_STREAM_STATS;
use serde_json::json;

/// 接続直後に daemon が送る handshake フレームの検証。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn handshake_frame_is_sent() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let hs = TestDaemon::recv_handshake(&mut ws).await;
    assert_eq!(hs["type"], "handshake");
    assert_eq!(hs["protocol_version"], "0.2");
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

    send_cmd(
        &mut ws,
        "cmd-load",
        "LoadSample",
        json!({ "path": wav_path }),
    )
    .await;
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

/// PlayAt が `channel`（LinkAudio outputChannel・#209）フィールドを **wire 経由**で受理し、
/// session.rs の解析（`params["channel"]` → `engine.play_at(... channel)`）がエラーにならず
/// 再生が成立することを pin する（A4-2b-1）。channel 名のキー typo / 解析漏れは、core/harness
/// テストが session 層を bypass するため silent に通る（rate と同型の wire 経路ガード）。実 routing
/// は core の render_multi / render_offline_channel テストで検証する（A4-2b-1 では egress 未配線で
/// hardware fallback のため、live ws 経路から routing は観測できない）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn play_at_with_channel_is_accepted() {
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
        json!({
            "sample_id": sample_id,
            "time_sec": 0.0,
            "gain": 1.0,
            "channel": "ch1",
        }),
    )
    .await;
    let (play_resp, early_events) = recv_reply_with_events(&mut ws, "p").await;
    assert!(
        play_resp["result"]["play_id"].is_string(),
        "PlayAt with channel should succeed: {play_resp}"
    );

    let mut saw_started = early_events.iter().any(|e| e["event"] == "PlayStarted");
    advance_and_yield(Duration::from_secs(2)).await;
    for _ in 0..20 {
        if saw_started {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await {
            Ok(msg) if msg["event"] == "PlayStarted" => saw_started = true,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert!(saw_started, "PlayStarted missing for channel-tagged PlayAt");
}

/// PlayAt の duration_sec が負値の場合は PARAM_OUT_OF_RANGE で拒否する。
/// engine_wrap は負 duration を `if duration_sec > 0.0 { .. } else { 0 }` で「0 = 全体再生」へ
/// 潰すため、protocol 層のこの拒否は冗長な防御ではなく load-bearing（無言の全体再生を防ぐ）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn play_at_rejects_negative_duration_sec() {
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
        json!({
            "sample_id": sample_id,
            "time_sec": 0.0,
            "gain": 1.0,
            "duration_sec": -0.5,
        }),
    )
    .await;
    let resp = recv_reply_for_id(&mut ws, "p").await;
    assert_eq!(
        resp["error"]["code"], "PARAM_OUT_OF_RANGE",
        "negative duration_sec should be rejected, got: {resp}"
    );
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

    // sample duration を確実に超える時間（kick.wav は 1 秒未満なので 5 秒）まで
    // 虚時間を進める。これにより自然発火の PlayEnded 遅延 task は確定的に
    // 完了し、抑制ロジックが効いていれば PlayEnded event は writer mpsc に
    // 流れない。
    advance_and_yield(Duration::from_secs(5)).await;

    let mut saw_ended = false;
    for _ in 0..20 {
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

/// StopAll は全アクティブ再生（発音中 + 開始待機中）を停止し件数を返す（hard-stop-all・#319）。
/// 冪等: 空に対しては 0 を返す。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stop_all_clears_scheduled_plays() {
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

    // 未来時刻に 2 voice をスケジュール（transport 未到達でも scheduler に開始待機で居る）。
    for (id, t) in [("p1", 10.0), ("p2", 11.0)] {
        send_cmd(
            &mut ws,
            id,
            "PlayAt",
            json!({ "sample_id": sample_id, "time_sec": t, "gain": 1.0 }),
        )
        .await;
        let _ = recv_reply_for_id(&mut ws, id).await;
    }

    send_cmd(&mut ws, "sa", "StopAll", json!({})).await;
    let resp = recv_reply_for_id(&mut ws, "sa").await;
    assert_eq!(
        resp["result"]["stopped"].as_u64(),
        Some(2),
        "StopAll should clear both scheduled voices: {resp}"
    );

    // 冪等: 2 回目は 0。
    send_cmd(&mut ws, "sa2", "StopAll", json!({})).await;
    let resp2 = recv_reply_for_id(&mut ws, "sa2").await;
    assert_eq!(
        resp2["result"]["stopped"].as_u64(),
        Some(0),
        "second StopAll should be idempotent (0): {resp2}"
    );
}

/// PluginAllNotesOff は台帳が空なら冪等に `{released:0, stale:0, failed:0}` を返す。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn plugin_all_notes_off_is_idempotent_when_ledger_is_empty() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(&mut ws, "pano-empty", "PluginAllNotesOff", json!({})).await;
    let resp = recv_reply_for_id(&mut ws, "pano-empty").await;
    assert_eq!(resp["result"]["released"].as_u64(), Some(0), "{resp}");
    assert_eq!(resp["result"]["stale"].as_u64(), Some(0), "{resp}");
    assert_eq!(resp["result"]["failed"].as_u64(), Some(0), "{resp}");
}

/// test backend には OOP instrument の送り先が無い。注入した台帳 entry は stale として
/// 数えられ、RPC 後には解放済み集合として台帳から除去される。
#[cfg(feature = "outproc-instrument")]
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn plugin_all_notes_off_reports_injected_missing_destination_as_stale() {
    let daemon = TestDaemon::start().await;
    daemon
        .engine
        .inject_active_plugin_note("missing-instance", 3, 64)
        .expect("inject active note");
    assert_eq!(
        daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes"),
        1
    );

    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;
    send_cmd(&mut ws, "pano-stale", "PluginAllNotesOff", json!({})).await;
    let resp = recv_reply_for_id(&mut ws, "pano-stale").await;
    assert_eq!(resp["result"]["released"].as_u64(), Some(0), "{resp}");
    assert_eq!(resp["result"]["stale"].as_u64(), Some(1), "{resp}");
    assert_eq!(resp["result"]["failed"].as_u64(), Some(0), "{resp}");
    assert_eq!(
        daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes"),
        0
    );
}

/// engine process の異常終了に相当する WebSocket drop では RPC を送れない。session の
/// read loop 終了そのものが同じ all-notes-off 配送関数を起動し、台帳を解放する。
#[cfg(feature = "outproc-instrument")]
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn dropping_session_drains_active_plugin_note_ledger() {
    let daemon = TestDaemon::start().await;
    daemon
        .engine
        .inject_active_plugin_note("disconnected-engine", 0, 60)
        .expect("inject active note");
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;
    drop(ws);

    for _ in 0..100 {
        if daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes")
            == 0
        {
            break;
        }
        advance_and_yield(Duration::from_millis(10)).await;
    }
    assert_eq!(
        daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes"),
        0,
        "session disconnect must trigger PluginAllNotesOff"
    );
}

/// 台帳は daemon 全 session で共有される。補助的な 2 本目の接続が切れても、主 session が
/// 生きている間は note を解放せず、最後の session 切断だけを異常終了 trigger にする。
#[cfg(feature = "outproc-instrument")]
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn disconnecting_one_of_two_sessions_keeps_active_note_ledger() {
    let daemon = TestDaemon::start().await;
    daemon
        .engine
        .inject_active_plugin_note("multi-session", 0, 60)
        .expect("inject active note");

    let mut primary = daemon.connect().await;
    let _primary_hs = TestDaemon::recv_handshake(&mut primary).await;
    let mut secondary = daemon.connect().await;
    let _secondary_hs = TestDaemon::recv_handshake(&mut secondary).await;

    drop(secondary);
    for _ in 0..10 {
        advance_and_yield(Duration::from_millis(10)).await;
    }
    assert_eq!(
        daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes"),
        1,
        "disconnecting a secondary session must not release the shared ledger"
    );

    drop(primary);
    for _ in 0..100 {
        if daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes")
            == 0
        {
            break;
        }
        advance_and_yield(Duration::from_millis(10)).await;
    }
    assert_eq!(
        daemon
            .engine
            .active_plugin_note_count()
            .expect("count notes"),
        0,
        "the last session disconnect must trigger PluginAllNotesOff"
    );
}

/// PlayAt の `rate` が **wire 経由**（`session.rs` の `param_f64("rate")` → `engine.play_at`）で
/// 出力尺に効くことを、PlayEnded の `ended_at_sec`（= start_sec + 出力尺）で検証する（#319）。
/// オフライン harness は `wrap.play_at` を直接呼んで session 層を bypass するため、`"rate"` キーの
/// typo / forward 漏れは全 golden が rate=1.0（既定値）で silent に通る。本テストが唯一その経路を
/// 通す。サンプルを rate=2.0 で発音し、出力尺が自然尺の半分（= LoadSample の frames/sample_rate / 2）
/// になることを確認する（rate が wire を通らず default=1.0 に落ちると自然尺のままで fail）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn play_at_rate_halves_play_ended_time() {
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
    // 自然尺 D = frames / sample_rate（出力 SR に変換済みのロード値）。
    let frames = load_resp["result"]["frames"].as_f64().expect("frames");
    let sr = load_resp["result"]["sample_rate"]
        .as_f64()
        .expect("sample_rate");
    let natural_sec = frames / sr;

    // rate=2.0 で発音 → 出力尺は natural_sec / 2、ended_at_sec = start(0) + natural_sec/2。
    send_cmd(
        &mut ws,
        "p",
        "PlayAt",
        json!({ "sample_id": sample_id, "time_sec": 0.0, "gain": 1.0, "rate": 2.0 }),
    )
    .await;
    let pid = recv_reply_for_id(&mut ws, "p").await["result"]["play_id"]
        .as_str()
        .unwrap_or_else(|| panic!("PlayAt resp missing play_id"))
        .to_string();

    // kick.wav は 1 秒未満。PlayEnded が発火するまで虚時間を進める（単一イベント収集は
    // stop_suppresses_play_ended と同型で並列実行でも安定）。
    advance_and_yield(Duration::from_secs(3)).await;

    let mut ended_at = None;
    for _ in 0..40 {
        match tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await {
            Ok(msg) if msg["event"] == "PlayEnded" && msg["data"]["play_id"] == pid.as_str() => {
                ended_at = msg["data"]["ended_at_sec"].as_f64();
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let ended_at = ended_at.unwrap_or_else(|| panic!("PlayEnded not received for rate=2.0 voice"));
    let expected = natural_sec / 2.0;
    // rate=2.0 の出力尺は自然尺の半分。rate が wire を通らず 1.0 に落ちると natural_sec のままで
    // fail する（expected の 2 倍 = 明確に許容外）。
    assert!(
        (ended_at - expected).abs() < 0.02,
        "rate=2.0 ended_at should be natural/2: ended_at={ended_at}, expected={expected} \
         (natural={natural_sec}); rate が wire を通っていない可能性"
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

    // ticker は接続直後の INTERVAL 経過後に初回発火。最大 8 秒分 1 秒刻みで
    // advance し、2 tick 観測できた時点で break する（早期終了前提）。
    let mut stats_count = 0;
    for _ in 0..8 {
        advance_and_yield(Duration::from_secs(1)).await;
        // 蓄積された event を drain。各 tick 後に最大 5 件まで読み取る。
        for _ in 0..5 {
            let res = tokio::time::timeout(Duration::from_millis(100), next_json(&mut ws)).await;
            match res {
                Ok(msg) => {
                    if msg["event"] == EVENT_STREAM_STATS {
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

/// LinkAudio egress drop が増えると DaemonError (severity=warning, code=LINK_EGRESS_DROP) が発火する。
/// xrun と同じ 1 Hz ticker 経路。StubBackend は実 `LinkAudioControl` を持たないため、`link_egress_drops_arc`
/// の **本番経路から分離した注入 seam**（本番常に 0）でこの event を driver する（`record_xrun` のように
/// 本番と同一 counter を書く xrun seam とは異なる）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_link_egress_drop() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から egress drop を注入（1 Hz ticker が link_egress_ring_drops の増加を検知して発火）。
    daemon
        .engine
        .link_egress_drops_arc()
        .fetch_add(512, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "LINK_EGRESS_DROP"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("LINK_EGRESS_DROP warning event not received");
    // message は累積 drop 数（512）を含む = daemon_error_event の format! が壊れていないこと。
    assert!(
        message.contains("512"),
        "LINK_EGRESS_DROP message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**（last_link_drops が据え置かれること）。
    // 再発火すると 1 Hz で warn が溢れる回帰になる。StreamStats は流れるが LINK_EGRESS_DROP は来ない。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError" && msg["data"]["code"] == "LINK_EGRESS_DROP" {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "LINK_EGRESS_DROP must not re-fire without additional drops (latch regression)"
    );
}

/// CLAP plugin の process() エラーが増えると DaemonError (severity=warning, code=CLAP_PROCESS_ERROR) が
/// 発火する（#340）。LINK_EGRESS_DROP と同じ 1 Hz ticker 経路。integration test は plugin をロードしない
/// ため、`clap_process_errors_arc` の **本番経路から分離した注入 seam**（本番常に 0）でこの event を
/// driver する。clap-host feature の有無に依らず駆動できる（stub 経路も注入分を反映するため）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_clap_process_error() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から process error を注入（1 Hz ticker が clap_process_error_count の増加を検知して発火）。
    daemon
        .engine
        .clap_process_errors_arc()
        .fetch_add(3, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "CLAP_PROCESS_ERROR"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("CLAP_PROCESS_ERROR warning event not received");
    // message は累積 error 数（3）を含む = daemon_error_event の format! が壊れていないこと。
    assert!(
        message.contains('3'),
        "CLAP_PROCESS_ERROR message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**（last_clap_errors が据え置かれること）。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError" && msg["data"]["code"] == "CLAP_PROCESS_ERROR" {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "CLAP_PROCESS_ERROR must not re-fire without additional drops (latch regression)"
    );
}

/// OOP effect の frames_clamped が増えると DaemonError (severity=warning,
/// code=OUTPROC_EFFECT_FRAMES_CLAMPED) が発火する（#404 / #406）。LINK_EGRESS_DROP・
/// CLAP_PROCESS_ERROR と同じ 1 Hz ticker 経路。integration test は outproc child process を spawn
/// しない（default feature build には `outproc-effect` が無い）ため、`outproc_frames_clamped_arc`
/// の **本番経路から分離した注入 seam**（本番常に 0）でこの event を driver する（`outproc_health`
/// が consolidated accessor としてこの注入分を frames_clamped に合算する・#406 /simplify）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_outproc_frames_clamped() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から frames_clamped を注入（1 Hz ticker が outproc_health() の増加を検知して発火）。
    daemon
        .engine
        .outproc_frames_clamped_arc()
        .fetch_add(7, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_EFFECT_FRAMES_CLAMPED"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message =
        warning_message.expect("OUTPROC_EFFECT_FRAMES_CLAMPED warning event not received");
    // message は累積 clamp 数（7）を含む = daemon_error_event の format! が壊れていないこと。
    assert!(
        message.contains('7'),
        "OUTPROC_EFFECT_FRAMES_CLAMPED message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**
    // （last_outproc_frames_clamped が据え置かれること）。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "OUTPROC_EFFECT_FRAMES_CLAMPED"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "OUTPROC_EFFECT_FRAMES_CLAMPED must not re-fire without additional clamps (latch regression)"
    );

    // re-arm: 追加注入されると latch が再度開き、更新済みの累積値（7+5=12）で再発火すること
    // （#406 pr-test-analyzer finding 4: 「fire-once + no-refire」だけでなく「2 回目の注入で
    // 再発火し累積が更新されること」も検証する）。
    daemon
        .engine
        .outproc_frames_clamped_arc()
        .fetch_add(5, std::sync::atomic::Ordering::Relaxed);
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut rearmed_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_EFFECT_FRAMES_CLAMPED"
                {
                    rearmed_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let rearmed_message = rearmed_message
        .expect("OUTPROC_EFFECT_FRAMES_CLAMPED did not re-fire after second injection");
    assert!(
        rearmed_message.contains("12"),
        "re-armed OUTPROC_EFFECT_FRAMES_CLAMPED message should carry the updated cumulative total (12), got: {rearmed_message}"
    );
}

/// OOP instrument の output-event overflow（M2 §4.2 output 方向・dropped counter）が増えると
/// DaemonError (severity=warning, code=OUTPROC_INSTRUMENT_OUTPUT_DROPPED) が発火する（#420 PR #422
/// round 2）。OUTPROC_EFFECT_FRAMES_CLAMPED と同じ 1 Hz ticker 経路・同じ注入 seam 設計: integration
/// test は instrument child process を spawn しない（default feature build には `outproc-instrument`
/// が無い）ため、`outproc_instrument_output_dropped_arc` の **本番経路から分離した注入 seam**
/// （本番常に 0）でこの event を driver する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_outproc_instrument_output_dropped() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から dropped を注入（1 Hz ticker が outproc_instrument_health() の増加を検知して
    // 発火）。
    daemon
        .engine
        .outproc_instrument_output_dropped_arc()
        .fetch_add(7, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_OUTPUT_DROPPED"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message =
        warning_message.expect("OUTPROC_INSTRUMENT_OUTPUT_DROPPED warning event not received");
    // message は累積 dropped 数（7）を含む = daemon_error_event の format! が壊れていないこと。
    assert!(
        message.contains('7'),
        "OUTPROC_INSTRUMENT_OUTPUT_DROPPED message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**
    // （last_outproc_instrument_output_dropped が据え置かれること）。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_OUTPUT_DROPPED"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "OUTPROC_INSTRUMENT_OUTPUT_DROPPED must not re-fire without additional drops (latch regression)"
    );

    // re-arm: 追加注入されると latch が再度開き、更新済みの累積値（7+5=12）で再発火すること。
    daemon
        .engine
        .outproc_instrument_output_dropped_arc()
        .fetch_add(5, std::sync::atomic::Ordering::Relaxed);
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut rearmed_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_OUTPUT_DROPPED"
                {
                    rearmed_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let rearmed_message = rearmed_message
        .expect("OUTPROC_INSTRUMENT_OUTPUT_DROPPED did not re-fire after second injection");
    assert!(
        rearmed_message.contains("12"),
        "re-armed OUTPROC_INSTRUMENT_OUTPUT_DROPPED message should carry the updated cumulative total (12), got: {rearmed_message}"
    );
}

/// OOP instrument child の `process()` エラーが増えると DaemonError (severity=warning,
/// code=OUTPROC_INSTRUMENT_ERROR) が発火する（#420 PR #422 round 3）。CLAP_PROCESS_ERROR /
/// OUTPROC_EFFECT_ERROR と同じ 1 Hz ticker 経路・同じ注入 seam 設計: integration test は instrument
/// child process を spawn しないため、`outproc_instrument_child_errors_arc` の **本番経路から分離
/// した注入 seam**（本番常に 0）でこの event を driver する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_outproc_instrument_child_error() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から child process() error を注入（1 Hz ticker が outproc_instrument_health() の増加を
    // 検知して発火）。
    daemon
        .engine
        .outproc_instrument_child_errors_arc()
        .fetch_add(7, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_ERROR"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("OUTPROC_INSTRUMENT_ERROR warning event not received");
    assert!(
        message.contains('7'),
        "OUTPROC_INSTRUMENT_ERROR message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_ERROR"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "OUTPROC_INSTRUMENT_ERROR must not re-fire without additional errors (latch regression)"
    );

    // re-arm: 追加注入されると latch が再度開き、更新済みの累積値（7+5=12）で再発火すること。
    daemon
        .engine
        .outproc_instrument_child_errors_arc()
        .fetch_add(5, std::sync::atomic::Ordering::Relaxed);
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut rearmed_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_ERROR"
                {
                    rearmed_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let rearmed_message =
        rearmed_message.expect("OUTPROC_INSTRUMENT_ERROR did not re-fire after second injection");
    assert!(
        rearmed_message.contains("12"),
        "re-armed OUTPROC_INSTRUMENT_ERROR message should carry the updated cumulative total (12), got: {rearmed_message}"
    );
}

/// OOP instrument child の crash → respawn が増えると DaemonError (severity=warning,
/// code=OUTPROC_INSTRUMENT_RESPAWN) が発火する（#420 PR #422 round 3）。
/// OUTPROC_INSTRUMENT_ERROR と同じ 1 Hz ticker 経路・同じ注入 seam 設計。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_outproc_instrument_respawn() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    daemon
        .engine
        .outproc_instrument_respawns_arc()
        .fetch_add(2, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_RESPAWN"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("OUTPROC_INSTRUMENT_RESPAWN warning event not received");
    assert!(
        message.contains('2'),
        "OUTPROC_INSTRUMENT_RESPAWN message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_RESPAWN"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "OUTPROC_INSTRUMENT_RESPAWN must not re-fire without additional respawns (latch regression)"
    );

    // re-arm: 追加注入されると latch が再度開き、更新済みの累積値（2+5=7）で再発火すること。
    daemon
        .engine
        .outproc_instrument_respawns_arc()
        .fetch_add(5, std::sync::atomic::Ordering::Relaxed);
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut rearmed_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_RESPAWN"
                {
                    rearmed_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let rearmed_message =
        rearmed_message.expect("OUTPROC_INSTRUMENT_RESPAWN did not re-fire after second injection");
    assert!(
        rearmed_message.contains('7'),
        "re-armed OUTPROC_INSTRUMENT_RESPAWN message should carry the updated cumulative total (7), got: {rearmed_message}"
    );
}

/// OOP instrument の watchdog が計測を諦める（`measurement_invalid`）と DaemonError
/// (severity=warning, code=OUTPROC_INSTRUMENT_INVALID) が **fire-once** で発火する（#420 PR #422
/// round 3）。恒久 bool フラグなので LATCH/RE-ARM ではなく「一度だけ発火し、以後は true のままでも
/// 再発火しない」ことを検証する（OUTPROC_EFFECT_INVALID と同じ意味論）。integration test は
/// instrument child process を spawn しないため、`outproc_instrument_measurement_invalid_arc`
/// の **本番経路から分離した注入 seam**（本番常に false）でこの event を driver する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_outproc_instrument_invalid() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    daemon
        .engine
        .outproc_instrument_measurement_invalid_arc()
        .store(true, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_INVALID"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("OUTPROC_INSTRUMENT_INVALID warning event not received");
    assert!(
        message.contains("frozen"),
        "OUTPROC_INSTRUMENT_INVALID message should describe the frozen instrument state, got: {message}"
    );

    // fire-once: flag は true のまま据え置かれるが、次 tick 以降は再発火しない。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "OUTPROC_INSTRUMENT_INVALID"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "OUTPROC_INSTRUMENT_INVALID must not re-fire once already reported (fire-once regression)"
    );
}

/// engine lock contention（try_lock の WouldBlock）が増えると
/// DaemonError (severity=warning, code=ENGINE_LOCK_CONTENTION) が発火する（#401）。
/// LINK_EGRESS_DROP/CLAP_PROCESS_ERROR と同じ 1 Hz ticker 経路。`engine_lock_contention_arc` の
/// **本番と同一 counter に直接書く注入 seam**（`Engine::contention_count_arc` の delegate）で
/// この event を driver する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_engine_lock_contention() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から lock contention を注入（1 Hz ticker が engine_lock_contention_count の増加を検知）。
    daemon
        .engine
        .engine_lock_contention_arc()
        .fetch_add(7, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "ENGINE_LOCK_CONTENTION"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("ENGINE_LOCK_CONTENTION warning event not received");
    // message は累積カウント（7）と self-heals の説明を含む = WouldBlock（一時競合）専用の
    // メッセージであり、恒久障害（poisoned）のメッセージと混同していないこと。
    assert!(
        message.contains('7'),
        "ENGINE_LOCK_CONTENTION message should carry the running total, got: {message}"
    );
    assert!(
        message.contains("self-heals"),
        "WouldBlock contention message should claim self-healing, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても再発火しない。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError" && msg["data"]["code"] == "ENGINE_LOCK_CONTENTION"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "ENGINE_LOCK_CONTENTION must not re-fire without additional contention (latch regression)"
    );
}

/// engine の scheduler mutex が poisoned と判定されると
/// DaemonError (severity=fatal, code=ENGINE_LOCK_POISONED) が発火する（#401）。DEVICE_LOST と同じ
/// fire-once の恒久障害クラス。実際に Mutex を panic で poison させる代わりに、
/// `engine_lock_poisoned_arc`（`Engine::poisoned_arc` の delegate）で直接フラグを注入する
/// （`Engine` 側の genuine-poison 検証は `orbit-audio-core::engine::tests` の
/// `poisoned_flag_sets_on_render_lock_poison_distinct_from_contention_count` が担う）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_fatal_on_engine_lock_poisoned() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    daemon
        .engine
        .engine_lock_poisoned_arc()
        .store(true, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut fatal_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "fatal"
                    && msg["data"]["code"] == "ENGINE_LOCK_POISONED"
                {
                    fatal_message = Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = fatal_message.expect("ENGINE_LOCK_POISONED fatal event not received");
    // poisoned は恒久障害なので "self-heals" を名乗ってはいけない
    // （ENGINE_LOCK_CONTENTION の WARNING メッセージと取り違えていないこと）。
    assert!(
        !message.contains("self-heals"),
        "poisoned message must not claim self-healing, got: {message}"
    );
    assert!(
        message.contains("restart"),
        "poisoned message should say audio is down until restart, got: {message}"
    );

    // fire-once: フラグを立てたまま次 tick へ進めても再発火しない（device_lost_reported と同じ latch）。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError" && msg["data"]["code"] == "ENGINE_LOCK_POISONED" {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "ENGINE_LOCK_POISONED must not re-fire once latched (fire-once regression)"
    );
}

/// contention（WouldBlock）と poisoned が同一 tick で両方成立した場合、
/// ENGINE_LOCK_CONTENTION (warning) と ENGINE_LOCK_POISONED (fatal) の両方が配信され、
/// かつ `session.rs` のティッカーループが poisoned/FATAL チェックを contention/WARNING
/// チェックより先に実行する実装順序（#401）どおり、FATAL が先に届くことを検証する
/// （WS client がイベントを順番に処理する前提のため、存在確認だけでなく到着順も pin する）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_both_contention_and_poisoned_fire_same_tick_fatal_first() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 同一 tick 内で両方の条件を成立させる。
    daemon
        .engine
        .engine_lock_contention_arc()
        .fetch_add(3, std::sync::atomic::Ordering::Relaxed);
    daemon
        .engine
        .engine_lock_poisoned_arc()
        .store(true, std::sync::atomic::Ordering::Relaxed);

    advance_and_yield(Duration::from_millis(1_100)).await;

    // StreamStats 等の他イベントを読み飛ばしつつ、ENGINE_LOCK_POISONED と
    // ENGINE_LOCK_CONTENTION の DaemonError が届いた順序を記録する。
    let mut order: Vec<String> = Vec::new();
    for _ in 0..12 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError" {
                    if let Some(code) = msg["data"]["code"].as_str() {
                        if code == "ENGINE_LOCK_POISONED" || code == "ENGINE_LOCK_CONTENTION" {
                            order.push(code.to_string());
                        }
                    }
                }
                if order.len() == 2 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    assert_eq!(
        order,
        vec![
            "ENGINE_LOCK_POISONED".to_string(),
            "ENGINE_LOCK_CONTENTION".to_string(),
        ],
        "both events must be delivered, with FATAL (poisoned) arriving before WARNING \
         (contention) — session.rs's ticker checks poisoned before contention, got: {order:?}"
    );
}

/// in-process CLAP event ring への bounded retry が力尽きた（真の event 喪失）回数が増えると
/// DaemonError (severity=warning, code=PLUGIN_EVENT_RING_OVERFLOW) が発火する（#400/#402）。
/// LINK_EGRESS_DROP / CLAP_PROCESS_ERROR と同じ 1 Hz ticker + dedup latch 経路。この counter は
/// producer 側を別スレッドへ outsource しないので `_arc()` 型の注入 seam ではなく
/// `plugin_event_ring_overflow_inject` で直接加算する（`EngineWrap` 側の doc 参照）。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn daemon_error_warning_on_plugin_event_ring_overflow() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    // 外部から ring overflow を注入（1 Hz ticker が plugin_event_ring_overflow_count の増加を検知
    // して発火）。
    daemon.engine.plugin_event_ring_overflow_inject(7);

    advance_and_yield(Duration::from_millis(1_100)).await;

    let mut warning_message: Option<String> = None;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["severity"] == "warning"
                    && msg["data"]["code"] == "PLUGIN_EVENT_RING_OVERFLOW"
                {
                    warning_message =
                        Some(msg["data"]["message"].as_str().unwrap_or("").to_string());
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let message = warning_message.expect("PLUGIN_EVENT_RING_OVERFLOW warning event not received");
    // message は累積 overflow 数（7）を含む = daemon_error_event の format! が壊れていないこと。
    assert!(
        message.contains('7'),
        "PLUGIN_EVENT_RING_OVERFLOW message should carry the running total, got: {message}"
    );

    // latch: 追加注入なしで次 tick へ進めても **再発火しない**（last_plugin_event_ring_overflow が
    // 据え置かれること）。再発火すると 1 Hz で warn が溢れる回帰になる。
    advance_and_yield(Duration::from_millis(1_100)).await;
    let mut refired = false;
    for _ in 0..6 {
        let res = tokio::time::timeout(Duration::from_millis(50), next_json(&mut ws)).await;
        match res {
            Ok(msg) => {
                if msg["event"] == "DaemonError"
                    && msg["data"]["code"] == "PLUGIN_EVENT_RING_OVERFLOW"
                {
                    refired = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        !refired,
        "PLUGIN_EVENT_RING_OVERFLOW must not re-fire without additional overflow (latch regression)"
    );
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

/// UnloadSample は happy path でサンプルを解放でき、二重 unload はエラー。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn unload_sample_happy_then_unknown() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let wav_path = format!("{manifest_dir}/../../../test-assets/audio/kick.wav");
    send_cmd(&mut ws, "l", "LoadSample", json!({ "path": wav_path })).await;
    let load_resp = recv_reply_for_id(&mut ws, "l").await;
    let sid = load_resp["result"]["sample_id"]
        .as_str()
        .unwrap()
        .to_string();

    send_cmd(&mut ws, "u1", "UnloadSample", json!({ "sample_id": sid })).await;
    let resp1 = recv_reply_for_id(&mut ws, "u1").await;
    assert!(
        resp1["result"].is_object(),
        "first unload should succeed: {resp1}"
    );

    // 既に解放済みの sample_id を再度 unload するとエラー応答になる。
    send_cmd(&mut ws, "u2", "UnloadSample", json!({ "sample_id": sid })).await;
    let resp2 = recv_reply_for_id(&mut ws, "u2").await;
    assert!(
        resp2["error"].is_object(),
        "second unload should fail: {resp2}"
    );
}

/// PlayAt に未ロードの sample_id を渡すとエラー応答を返す。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn play_at_unknown_sample_id_errors() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(
        &mut ws,
        "p",
        "PlayAt",
        json!({ "sample_id": "s-ghost", "time_sec": 0.0, "gain": 1.0 }),
    )
    .await;
    let resp = recv_reply_for_id(&mut ws, "p").await;
    assert!(
        resp["error"].is_object(),
        "unknown sample_id should yield error: {resp}"
    );
}

/// SetGlobalGain は負の `ramp_sec` を拒否する。
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn set_global_gain_rejects_negative_ramp() {
    let daemon = TestDaemon::start().await;
    let mut ws = daemon.connect().await;
    let _hs = TestDaemon::recv_handshake(&mut ws).await;

    send_cmd(
        &mut ws,
        "g",
        "SetGlobalGain",
        json!({ "value": 1.0, "ramp_sec": -0.1 }),
    )
    .await;
    let resp = recv_reply_for_id(&mut ws, "g").await;
    assert_eq!(resp["error"]["code"], "PARAM_OUT_OF_RANGE");
}
