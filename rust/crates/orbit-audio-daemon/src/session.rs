//! 1 WebSocket 接続あたりのメッセージループ。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::warn;

use crate::engine_wrap::{EngineWrap, WrapError};
use crate::protocol::{Command, ErrorResponse, Event, Handshake, OkResponse, ProtocolError};

pub async fn run(
    ws: WebSocketStream<TcpStream>,
    engine: Arc<EngineWrap>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let (mut write, mut read) = ws.split();

    // 最初の handshake フレーム送信
    let handshake_json = serde_json::to_string(&Handshake::current()).unwrap();
    write.send(Message::Text(handshake_json)).await?;

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
            Message::Ping(p) => {
                write.send(Message::Pong(p)).await?;
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
                let s = serde_json::to_string(&err).unwrap();
                write.send(Message::Text(s)).await?;
                continue;
            }
        };

        let reply = handle_command(cmd, &engine).await;
        let s = serde_json::to_string(&reply).unwrap();
        write.send(Message::Text(s)).await?;
    }

    Ok(())
}

/// Command を dispatch し、Response JSON を組み立てる。
async fn handle_command(cmd: Command, engine: &Arc<EngineWrap>) -> Value {
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
                    Ok(handle) => ok(&id, json!({"play_id": handle.play_id})),
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
            // 現状 Engine は global gain を持たないため、受理するが no-op (Phase 1b-2 で実装)。
            let value = params.get("value").and_then(|v| v.as_f64()).unwrap_or(1.0);
            if value < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "value must be >= 0"),
                );
            }
            ok(&id, json!({"status": "accepted"}))
        }
        other => err(
            &id,
            ProtocolError::new("MALFORMED_REQUEST", format!("unknown method: {other}")),
        ),
    }
}

fn ok(id: &str, result: Value) -> Value {
    serde_json::to_value(OkResponse {
        id: id.to_string(),
        result,
    })
    .unwrap()
}

fn err(id: &str, error: ProtocolError) -> Value {
    serde_json::to_value(ErrorResponse {
        id: id.to_string(),
        error,
    })
    .unwrap()
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

/// Stream stats 通知（Phase 1b-2 で定期送信を実装、現状はヘルパのみ提供）。
#[allow(dead_code)]
pub fn make_stream_stats_event(now_sec: f64) -> Event {
    Event::new(
        "StreamStats",
        json!({
            "cpu_load": 0.0,
            "xruns": 0,
            "buffer_underruns": 0,
            "now_sec": now_sec,
        }),
    )
}
