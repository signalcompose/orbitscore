//! Protocol v0.1 message types.
//!
//! 契約は `docs/research/ENGINE_DAEMON_PROTOCOL.md` を唯一の真実とする。
//! 本モジュールは JSON シリアライズ / デシリアライズのための型だけを定義。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "0.1";
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Handshake フレーム（接続後に daemon が最初に送る）。
#[derive(Debug, Serialize)]
pub struct Handshake {
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub protocol_version: &'static str,
    pub daemon_version: &'static str,
    pub capabilities: Vec<&'static str>,
}

impl Handshake {
    pub fn current() -> Self {
        Self {
            type_: "handshake",
            protocol_version: PROTOCOL_VERSION,
            daemon_version: DAEMON_VERSION,
            capabilities: vec!["playback", "src"],
        }
    }
}

/// Client → Daemon の command。
#[derive(Debug, Deserialize)]
pub struct Command {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Daemon → Client の response（成功）。
#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub id: String,
    pub result: serde_json::Value,
}

/// Daemon → Client の response（失敗）。
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub id: String,
    pub error: ProtocolError,
}

#[derive(Debug, Serialize)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ProtocolError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }
}

// Event / error code constants. Shared across session and panic-hook paths so the
// wire schema is produced from a single source.
pub const EVENT_DAEMON_ERROR: &str = "DaemonError";
pub const EVENT_STREAM_STATS: &str = "StreamStats";
pub const EVENT_PLAY_STARTED: &str = "PlayStarted";
pub const EVENT_PLAY_ENDED: &str = "PlayEnded";

pub const ERROR_SEVERITY_WARNING: &str = "warning";
pub const ERROR_SEVERITY_FATAL: &str = "fatal";

pub const ERROR_CODE_STREAM_XRUN: &str = "STREAM_XRUN";
pub const ERROR_CODE_DEVICE_LOST: &str = "DEVICE_LOST";
pub const ERROR_CODE_FATAL_PANIC: &str = "FATAL_PANIC";

/// Daemon → Client の event（通知、id なし）。
#[derive(Debug, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub event: &'static str,
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(event: &'static str, data: serde_json::Value) -> Self {
        Self {
            type_: "event",
            event,
            data,
        }
    }
}

/// 起動失敗時に stderr に出力する 1 行 JSON。
#[derive(Debug, Serialize)]
pub struct StartupError {
    pub ready: bool,
    pub error: ProtocolError,
}

/// 起動成功時に stdout に出力する 1 行 JSON。
#[derive(Debug, Serialize)]
pub struct StartupReady {
    pub ready: bool,
    pub port: u16,
    pub protocol_version: &'static str,
}
