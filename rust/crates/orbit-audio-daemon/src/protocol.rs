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
/// LinkAudio egress の ring overflow drop（消費が追いつかず音が落ちた）。WARNING severity。
/// daemon が 1 Hz ticker で aggregate drop 数の増加を検知して発火する（A4-2b-2b）。
pub const ERROR_CODE_LINK_EGRESS_DROP: &str = "LINK_EGRESS_DROP";
/// ロード済み CLAP plugin の `process()` がエラーを返した（出力をスキップし dry 通過した）。
/// WARNING severity。audio thread が cumulative counter に積み、daemon が 1 Hz ticker で増加を
/// 検知して発火する（#340）。effect は dry 素通し / instrument は無音になるため observability で surface。
pub const ERROR_CODE_CLAP_PROCESS_ERROR: &str = "CLAP_PROCESS_ERROR";
/// out-of-process effect child の `process()` がエラーを返した（effect は dry 素通し）。WARNING severity。
/// child が shm の cumulative counter に積み、daemon が 1 Hz ticker で増加を検知して発火する（γ M1 PR-C）。
pub const ERROR_CODE_OUTPROC_EFFECT_ERROR: &str = "OUTPROC_EFFECT_ERROR";
/// out-of-process effect child が crash し watchdog が respawn した。WARNING severity。daemon が 1 Hz
/// ticker で respawn 数の増加を検知して発火する（3rd-party crash は隔離されるが頻発は要調査・γ M1 PR-C）。
pub const ERROR_CODE_OUTPROC_EFFECT_RESPAWN: &str = "OUTPROC_EFFECT_RESPAWN";
/// out-of-process effect の supervise が不能になった（respawn 失敗 / try_wait 連続失敗）= 計測無効。
/// **WARNING** severity（daemon/engine は生存し他の audio は流れるが effect は直前 good block の
/// repeat-previous が出続ける = effect 経路のみ恒久停止）。daemon が 1 Hz ticker で `measurement_invalid`
/// を検知して一度だけ発火する（fire-once・γ M1 PR-C）。
pub const ERROR_CODE_OUTPROC_EFFECT_INVALID: &str = "OUTPROC_EFFECT_INVALID";

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
