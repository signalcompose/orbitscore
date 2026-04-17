//! 1 WebSocket 接続あたりのメッセージループ。

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::{info, warn};

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
            Message::Text(t) => t.to_string(),
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

        let reply = handle_command(&cmd, &engine);
        let s = serde_json::to_string(&reply).unwrap();
        write.send(Message::Text(s)).await?;
    }

    Ok(())
}

/// Command を dispatch し、Response JSON を組み立てる。
fn handle_command(cmd: &Command, engine: &Arc<EngineWrap>) -> Value {
    match cmd.method.as_str() {
        "Ping" => ok(&cmd.id, Value::String("pong".to_string())),
        "GetStatus" => {
            let status = json!({
                "daemon_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": "0.1",
                "output_sample_rate": engine.output_sample_rate(),
                "output_channels": engine.output_channels(),
                "loaded_samples": engine.loaded_sample_count(),
                "now_sec": engine.now_sec().unwrap_or(0.0),
            });
            ok(&cmd.id, status)
        }
        "LoadSample" => match cmd.params.get("path").and_then(|p| p.as_str()) {
            Some(path_str) => match engine.load_sample(path_str.into()) {
                Ok(info) => ok(
                    &cmd.id,
                    json!({
                        "sample_id": info.sample_id,
                        "frames": info.frames,
                        "channels": info.channels,
                        "sample_rate": info.sample_rate,
                    }),
                ),
                Err(e) => err(&cmd.id, wrap_err_to_protocol(&e)),
            },
            None => err(
                &cmd.id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'path' param"),
            ),
        },
        "UnloadSample" => match cmd.params.get("sample_id").and_then(|p| p.as_str()) {
            Some(sid) => match engine.unload_sample(sid) {
                Ok(()) => ok(&cmd.id, json!({"status": "unloaded"})),
                Err(e) => err(&cmd.id, wrap_err_to_protocol(&e)),
            },
            None => err(
                &cmd.id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'sample_id' param"),
            ),
        },
        "PlayAt" => {
            let time_sec = cmd
                .params
                .get("time_sec")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let gain = cmd
                .params
                .get("gain")
                .and_then(|v| v.as_f64())
                .map(|x| x as f32)
                .unwrap_or(1.0);
            if gain < 0.0 {
                return err(
                    &cmd.id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "gain must be >= 0"),
                );
            }
            match cmd.params.get("sample_id").and_then(|v| v.as_str()) {
                Some(sid) => match engine.play_at(sid, time_sec, gain) {
                    Ok(handle) => ok(&cmd.id, json!({"play_id": handle.play_id})),
                    Err(e) => err(&cmd.id, wrap_err_to_protocol(&e)),
                },
                None => err(
                    &cmd.id,
                    ProtocolError::new("MALFORMED_REQUEST", "missing 'sample_id' param"),
                ),
            }
        }
        "Stop" => {
            // 現状の Engine は個別 play 停止 API を持たないため、常に idempotent success を返す。
            // Phase 1b-2 で Engine 側に Stop API を追加予定。
            let pid = cmd
                .params
                .get("play_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            ok(&cmd.id, json!({"play_id": pid, "status": "not_found"}))
        }
        "SetGlobalGain" => {
            // 現状の Engine は global gain を持たないため、受理するが no-op。
            // Phase 1b-2 で実装予定。
            let value = cmd
                .params
                .get("value")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            if value < 0.0 {
                return err(
                    &cmd.id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "value must be >= 0"),
                );
            }
            ok(&cmd.id, json!({"status": "accepted"}))
        }
        other => err(
            &cmd.id,
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

#[allow(dead_code)]
pub fn _assert_not_dead<T>(_: T) {}

// sanity: info! を使うのでリンカが warning を出さないよう ref
#[allow(dead_code)]
fn _use_info() {
    info!("touch");
}
