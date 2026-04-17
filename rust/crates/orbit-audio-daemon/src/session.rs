//! 1 WebSocket 接続あたりのメッセージループ。
//!
//! writer task と reader task を分離した構造:
//! - reader: WebSocket 受信 → Command dispatch → Response を mpsc へ送る
//! - writer: mpsc から受信 → WebSocket へ書き込む
//! - 遅延イベント (PlayEnded 等) も mpsc で writer に合流する
//!
//! これにより、handle_command の非同期待ち中にもイベントを送れる。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::warn;

use crate::engine_wrap::{EngineWrap, WrapError};
use crate::protocol::{Command, ErrorResponse, Event, Handshake, OkResponse, ProtocolError};

/// writer task のキュー容量。過大に積まれると back pressure をかける。
const EVENT_CHANNEL_CAPACITY: usize = 128;

const EVENT_PLAY_STARTED: &str = "PlayStarted";
const EVENT_PLAY_ENDED: &str = "PlayEnded";
const EVENT_STREAM_STATS: &str = "StreamStats";
const EVENT_DAEMON_ERROR: &str = "DaemonError";

const ERROR_SEVERITY_WARNING: &str = "warning";
const ERROR_CODE_STREAM_XRUN: &str = "STREAM_XRUN";

/// StreamStats の送出間隔。protocol 仕様で 1 Hz 固定。
const STREAM_STATS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

pub async fn run(
    ws: WebSocketStream<TcpStream>,
    engine: Arc<EngineWrap>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::channel::<String>(EVENT_CHANNEL_CAPACITY);

    // 最初の handshake フレーム
    write
        .send(Message::Text(to_json_or_fallback(&Handshake::current())))
        .await?;

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // StreamStats 1 Hz ticker。mpsc の送信が失敗（= writer/reader 終了）した
    // 時点で自然に exit する。reader 側が閉じる tx の clone を持つため、
    // session が終わると tx が全て drop され、この task も最後は送信失敗で抜ける。
    let stats_task = {
        let tx = tx.clone();
        let engine = engine.clone();
        tokio::spawn(async move {
            // 1 Hz 固定仕様に合わせ、最初の tick も INTERVAL 後に揃える
            // （tokio::time::interval のデフォルトは即時発火）。
            let start = tokio::time::Instant::now() + STREAM_STATS_INTERVAL;
            let mut ticker = tokio::time::interval_at(start, STREAM_STATS_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_xruns: u64 = 0;
            loop {
                ticker.tick().await;
                let snapshot = engine.stream_stats_snapshot();
                let now_sec = engine.transport_or_uptime_sec();

                if snapshot.xruns > last_xruns {
                    let warn_evt = Event::new(
                        EVENT_DAEMON_ERROR,
                        json!({
                            "severity": ERROR_SEVERITY_WARNING,
                            "code": ERROR_CODE_STREAM_XRUN,
                            "message": format!(
                                "buffer underrun or stream error occurred ({} total)",
                                snapshot.xruns
                            ),
                        }),
                    );
                    if tx.send(to_json_or_fallback(&warn_evt)).await.is_err() {
                        break;
                    }
                    last_xruns = snapshot.xruns;
                }

                let stats_evt = Event::new(
                    EVENT_STREAM_STATS,
                    json!({
                        // cpu_load: audio callback の計測基盤が未整備のため 0.0 固定。
                        "cpu_load": 0.0,
                        "xruns": snapshot.xruns,
                        "buffer_underruns": snapshot.buffer_underruns,
                        "now_sec": now_sec,
                    }),
                );
                if tx.send(to_json_or_fallback(&stats_evt)).await.is_err() {
                    break;
                }
            }
        })
    };

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                warn!("websocket recv error: {e}");
                break;
            }
        };

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) => {
                // split 後は read/write が分離しており auto-Pong は走らない。
                // プロトコル上は application 層 method="Ping" を keepalive に使う想定で、
                // ws-layer Ping は現状未サポート (Phase 1c で write 経由の Pong 対応検討)。
                continue;
            }
            _ => continue,
        };

        let cmd: Command = match serde_json::from_str(&text) {
            Ok(c) => c,
            Err(e) => {
                let err = ErrorResponse {
                    id: String::new(),
                    error: ProtocolError::new("MALFORMED_REQUEST", e.to_string()),
                };
                if tx.send(to_json_or_fallback(&err)).await.is_err() {
                    warn!("MALFORMED_REQUEST reply send failed; closing session");
                    break;
                }
                continue;
            }
        };

        let method = cmd.method.clone();
        let reply = handle_command(cmd, &engine, &tx).await;
        if tx.send(to_json_or_fallback(&reply)).await.is_err() {
            warn!("reply send failed for method={method}; closing session");
            break;
        }
    }

    // stats_task は自身の tx clone を保持するため、drop(tx) では exit しない。
    // abort してから join を待ち、cancelled 以外の終了（panic 等）があれば warn する。
    stats_task.abort();
    match stats_task.await {
        Ok(()) => {}
        Err(e) if e.is_cancelled() => {}
        Err(e) => warn!("stats task terminated abnormally: {e}"),
    }
    drop(tx);
    if let Err(e) = writer_task.await {
        warn!("writer task terminated abnormally: {e}");
    }
    Ok(())
}

/// 固定スキーマの型をシリアライズするヘルパー。
///
/// 我々が扱う型（Handshake / OkResponse / ErrorResponse / Value）では
/// シリアライズ失敗は理論上起こり得ないが、将来の型追加で予期せぬ
/// Serialize 実装が混ざっても tokio task が silent panic しないよう
/// 明示的な fallback エラー JSON を返す。
fn to_json_or_fallback<T: serde::Serialize>(v: &T) -> String {
    match serde_json::to_string(v) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to serialize response: {e}");
            format!(
                r#"{{"id":"","error":{{"code":"INTERNAL_ERROR","message":"response serialization failed: {}"}}}}"#,
                e.to_string().replace('"', "\\\"")
            )
        }
    }
}

/// Command を dispatch し、Response JSON を組み立てる。
///
/// `tx` は event 送信用チャンネル（PlayEnded 等の遅延通知に使う）。
async fn handle_command(
    cmd: Command,
    engine: &Arc<EngineWrap>,
    tx: &mpsc::Sender<String>,
) -> Value {
    let Command { id, method, params } = cmd;
    match method.as_str() {
        "Ping" => ok(&id, Value::String("pong".to_string())),
        "GetStatus" => {
            let status = json!({
                "daemon_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": "0.1",
                "output_sample_rate": engine.output_sample_rate(),
                "output_channels": engine.output_channels(),
                "loaded_samples": engine.loaded_sample_count(),
                "active_plays": engine.active_play_count(),
                "uptime_sec": engine.uptime_sec(),
            });
            ok(&id, status)
        }
        "LoadSample" => match params.get("path").and_then(|p| p.as_str()) {
            Some(path_str) => {
                // ファイル I/O + symphonia decode + rubato SRC は CPU/IO ブロッキング。
                // tokio ワーカーを塞がないよう spawn_blocking で隔離する。
                let engine = engine.clone();
                let path = std::path::PathBuf::from(path_str);
                let loaded = tokio::task::spawn_blocking(move || engine.load_sample(path)).await;
                match loaded {
                    Ok(Ok(info)) => ok(
                        &id,
                        json!({
                            "sample_id": info.sample_id,
                            "frames": info.frames,
                            "channels": info.channels,
                            "sample_rate": info.sample_rate,
                        }),
                    ),
                    Ok(Err(e)) => err(&id, wrap_err_to_protocol(&e)),
                    Err(join_err) => err(
                        &id,
                        ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                    ),
                }
            }
            None => err(
                &id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'path' param"),
            ),
        },
        "UnloadSample" => match params.get("sample_id").and_then(|p| p.as_str()) {
            Some(sid) => match engine.unload_sample(sid) {
                Ok(()) => ok(&id, json!({"status": "unloaded"})),
                Err(e) => err(&id, wrap_err_to_protocol(&e)),
            },
            None => err(
                &id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'sample_id' param"),
            ),
        },
        "PlayAt" => {
            let time_sec = params
                .get("time_sec")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let gain = params
                .get("gain")
                .and_then(|v| v.as_f64())
                .map(|x| x as f32)
                .unwrap_or(1.0);
            if gain < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "gain must be >= 0"),
                );
            }
            match params.get("sample_id").and_then(|v| v.as_str()) {
                Some(sid) => match engine.play_at(sid, time_sec, gain) {
                    Ok(handle) => {
                        // 遅延タスクを先に spawn して await コストを避ける
                        schedule_play_ended(
                            tx.clone(),
                            engine.clone(),
                            handle.play_id.clone(),
                            handle.start_sec,
                            handle.duration_sec,
                        );

                        let started_evt = Event::new(
                            EVENT_PLAY_STARTED,
                            json!({
                                "play_id": handle.play_id,
                                "sample_id": sid,
                                "time_sec": handle.start_sec,
                            }),
                        );
                        if tx.send(to_json_or_fallback(&started_evt)).await.is_err() {
                            warn!(
                                "PlayStarted event drop: writer gone (play_id={})",
                                handle.play_id
                            );
                        }

                        ok(&id, json!({"play_id": handle.play_id}))
                    }
                    Err(e) => err(&id, wrap_err_to_protocol(&e)),
                },
                None => err(
                    &id,
                    ProtocolError::new("MALFORMED_REQUEST", "missing 'sample_id' param"),
                ),
            }
        }
        "Stop" => {
            // 現状 Engine は個別 play 停止 API を持たないため常に not_found を返す (Phase 1b-2 で実装)。
            let pid = params.get("play_id").and_then(|v| v.as_str()).unwrap_or("");
            ok(&id, json!({"play_id": pid, "status": "not_found"}))
        }
        "SetGlobalGain" => {
            let value = params.get("value").and_then(|v| v.as_f64()).unwrap_or(1.0);
            let ramp_sec = params
                .get("ramp_sec")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if value < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "value must be >= 0"),
                );
            }
            if ramp_sec < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "ramp_sec must be >= 0"),
                );
            }
            match engine.set_global_gain(value as f32, ramp_sec) {
                Ok(()) => ok(&id, json!({"status": "accepted"})),
                Err(e) => err(&id, wrap_err_to_protocol(&e)),
            }
        }
        other => err(
            &id,
            ProtocolError::new("MALFORMED_REQUEST", format!("unknown method: {other}")),
        ),
    }
}

/// PlayEnded event を遅延発行するタスクを spawn する。
///
/// 現在の transport 時刻を基準に `start_sec + duration_sec` まで待機し、
/// mpsc 経由で writer task に送る。コネクションが閉じていたら silently drop。
fn schedule_play_ended(
    tx: mpsc::Sender<String>,
    engine: Arc<EngineWrap>,
    play_id: String,
    start_sec: f64,
    duration_sec: f64,
) {
    tokio::spawn(async move {
        let now = engine.transport_or_uptime_sec();
        let delay = (start_sec + duration_sec - now).max(0.0);
        if delay > 0.0 {
            tokio::time::sleep(std::time::Duration::from_secs_f64(delay)).await;
        }
        let ended_at_sec = start_sec + duration_sec;
        let evt = Event::new(
            EVENT_PLAY_ENDED,
            json!({
                "play_id": play_id,
                "ended_at_sec": ended_at_sec,
            }),
        );
        let _ = tx.send(to_json_or_fallback(&evt)).await;
    });
}

fn ok(id: &str, result: Value) -> Value {
    // OkResponse は String/Value のみ含む固定スキーマ。
    // シリアライズ失敗はプログラマエラー (新フィールドの Serialize 実装不備) として
    // expect で早期失敗させ、"null" をクライアントに silent 送信する事態を避ける。
    serde_json::to_value(OkResponse {
        id: id.to_string(),
        result,
    })
    .expect("OkResponse must be serializable")
}

fn err(id: &str, error: ProtocolError) -> Value {
    serde_json::to_value(ErrorResponse {
        id: id.to_string(),
        error,
    })
    .expect("ErrorResponse must be serializable")
}

fn wrap_err_to_protocol(e: &WrapError) -> ProtocolError {
    use orbit_audio_native::LoaderError as L;
    match e {
        WrapError::SampleNotFound(sid) => {
            ProtocolError::new("SAMPLE_NOT_FOUND", format!("sample_id not found: {sid}"))
        }
        WrapError::Loader(L::Io(io)) if io.kind() == std::io::ErrorKind::NotFound => {
            ProtocolError::new("SAMPLE_NOT_FOUND", io.to_string())
        }
        WrapError::Loader(L::Unsupported) => {
            ProtocolError::new("UNSUPPORTED_FORMAT", "unsupported audio format")
        }
        WrapError::Loader(L::Decode(s)) => ProtocolError::new("FILE_DECODE_ERROR", s.clone()),
        WrapError::Loader(L::Io(io)) => ProtocolError::new("INTERNAL_ERROR", io.to_string()),
        WrapError::Loader(L::Resample(r)) => ProtocolError::new("RESAMPLE_ERROR", r.to_string()),
        WrapError::Resample(r) => ProtocolError::new("RESAMPLE_ERROR", r.to_string()),
        WrapError::Output(o) => ProtocolError::new("DEVICE_CONFIG_ERROR", o.to_string()),
        WrapError::Scheduler(msg) => ProtocolError::new("INTERNAL_ERROR", msg.clone()),
    }
}
