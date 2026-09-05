//! Protocol v0.1 message types.
//!
//! 契約は `docs/research/ENGINE_DAEMON_PROTOCOL.md` を唯一の真実とする。
//! 本モジュールは JSON シリアライズ / デシリアライズのための型だけを定義。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "0.2";
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
pub const EVENT_PLUGIN_UI_CLOSED: &str = "PluginUiClosed";
pub const EVENT_PLUGIN_UI_CLOSE_DONE: &str = "PluginUiCloseDone";
pub const EVENT_PLUGIN_UI_CLOSED_BY_RESPAWN: &str = "PluginUiClosedByRespawn";

pub const ERROR_SEVERITY_WARNING: &str = "warning";
pub const ERROR_SEVERITY_FATAL: &str = "fatal";

pub const ERROR_CODE_STREAM_XRUN: &str = "STREAM_XRUN";
pub const ERROR_CODE_DEVICE_LOST: &str = "DEVICE_LOST";
pub const ERROR_CODE_FATAL_PANIC: &str = "FATAL_PANIC";
pub const ERROR_CODE_AUDIO_DEVICE_STREAM_DEAD: &str = "AUDIO_DEVICE_STREAM_DEAD";
pub const ERROR_CODE_AUDIO_DEVICE_RATE_MISMATCH: &str = "AUDIO_DEVICE_RATE_MISMATCH";
/// ライブ切替で要求デバイスが見つからない / 出力できない。**元のデバイスのまま**（owner 裁定 2026-09-05）。
pub const ERROR_CODE_AUDIO_DEVICE_UNAVAILABLE: &str = "AUDIO_DEVICE_UNAVAILABLE";
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
/// OOP effect の block が `MAX_FRAMES`（`orbit-audio-sandbox`）を超えて clamp され、末尾が
/// 無音化された。WARNING severity。カウンタ自体は既に計測されていたが、1 Hz ticker への配線が
/// 欠けていたため追加した（#404）。通常は 0 のまま推移する想定（32/64f 小バッファ運用では
/// 実質到達不能）。
pub const ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED: &str = "OUTPROC_EFFECT_FRAMES_CLAMPED";
/// `Engine` の内部 Mutex が RT `try_lock` で `WouldBlock`（一時競合）を返し silent zero-fill に
/// フォールバックした。WARNING severity。この経路自体は既存の設計判断（lock-free 化は別 Issue で
/// defer 済み）だが、発生を可視化する仕組みが無かったため追加した（#401）。`WouldBlock` は自己修復
/// する障害（次のブロックで復帰）。daemon が 1 Hz ticker で累積カウンタの増加を検知して発火する。
pub const ERROR_CODE_ENGINE_LOCK_CONTENTION: &str = "ENGINE_LOCK_CONTENTION";
/// `Engine` の内部 Mutex が RT `try_lock` で `Poisoned`（別スレッドの panic による永続破損）と
/// 判定された。**FATAL** severity — `DEVICE_LOST` と同様、`clear_poison()` を呼ぶ箇所が無いため
/// 同一プロセス生存中は回復せず、以降の render は恒久的に zero-fill・制御系 API
/// （schedule/stop/stop_all/set_global_gain）も `EngineError::Poisoned` を返し続ける（#401）。
/// `ENGINE_LOCK_CONTENTION`（自己修復する `WouldBlock`）とは意味論が異なるため別コードにする。
/// daemon が 1 Hz ticker でフラグを検知し、`device_lost` と同様 fire-once で発火する。
pub const ERROR_CODE_ENGINE_LOCK_POISONED: &str = "ENGINE_LOCK_POISONED";
/// in-process CLAP event ring への push が bounded retry の末に力尽きた（真の event 喪失）。
/// WARNING severity。control スレッドが cumulative counter に積み、daemon が 1 Hz ticker で
/// 増加を検知して発火する（#400・M2 doc の「溢れても失わない」方針の in-process retrofit）。
pub const ERROR_CODE_PLUGIN_EVENT_RING_OVERFLOW: &str = "PLUGIN_EVENT_RING_OVERFLOW";
/// out-of-process instrument child の output-event overflow（M2 §4.2 output 方向）で真の drop が
/// 発生した（window + child-local spill FIFO の両方が尽きた）。WARNING severity。child が shm の
/// cumulative counter に積み、daemon が 1 Hz ticker で増加を検知して発火する（#420 PR #422 round 2:
/// counter 自体は round 1 で追加済みだったが daemon health 経路への配線が欠けていた）。message には
/// 無損失な `spilled`（1 ブロック遅延のみ）と `note_end_dropped`（NoteEnd 喪失 = stuck-note リスク）も
/// 文脈として含める。
pub const ERROR_CODE_OUTPROC_INSTRUMENT_OUTPUT_DROPPED: &str = "OUTPROC_INSTRUMENT_OUTPUT_DROPPED";
/// out-of-process instrument child の `process()` がエラーを返した（instrument は無音になる）。
/// WARNING severity。child が shm の cumulative counter に積み、daemon が 1 Hz ticker で増加を
/// 検知して発火する。`ERROR_CODE_OUTPROC_EFFECT_ERROR` の instrument 側ミラー（#420 PR #422 round 3:
/// round 2 までは output-event overflow のみ surface しており、child process() 自体のエラー/respawn/
/// 計測無効は無音のまま daemon health 経路に配線されていなかった — code-reviewer round 3 指摘）。
pub const ERROR_CODE_OUTPROC_INSTRUMENT_ERROR: &str = "OUTPROC_INSTRUMENT_ERROR";
/// out-of-process instrument child が crash し watchdog が respawn した。WARNING severity。
/// `ERROR_CODE_OUTPROC_EFFECT_RESPAWN` の instrument 側ミラー（#420 PR #422 round 3）。
pub const ERROR_CODE_OUTPROC_INSTRUMENT_RESPAWN: &str = "OUTPROC_INSTRUMENT_RESPAWN";
/// out-of-process instrument の supervise が不能になった（respawn 失敗 / try_wait 連続失敗）=
/// 計測無効。**WARNING** severity（daemon/engine は生存し他の audio は流れるが instrument は直前
/// good block の repeat-previous が出続ける = instrument 経路のみ恒久停止）。daemon が 1 Hz ticker で
/// `measurement_invalid` を検知して一度だけ発火する（fire-once）。`ERROR_CODE_OUTPROC_EFFECT_INVALID`
/// の instrument 側ミラー（#420 PR #422 round 3）。
pub const ERROR_CODE_OUTPROC_INSTRUMENT_INVALID: &str = "OUTPROC_INSTRUMENT_INVALID";
/// out-of-process instrument child が input event を decode できなかった / 未対応の
/// `NeutralEvent` variant を受けた（該当イベントは無音で消える）。WARNING severity。child が
/// shm の cumulative counter（`event_decode_error_count`）に積み、daemon が 1 Hz ticker で増加を
/// 検知して発火する（#421 pr-review-team round 2: counter の watchdog ミラーは round 1 で追加済み
/// だったが daemon health 経路への配線が欠けており、per-note expression 等の未対応イベント消失が
/// 一切可視化されなかった — silent-failure-hunter 指摘の残余）。
pub const ERROR_CODE_OUTPROC_INSTRUMENT_EVENT_DECODE: &str = "OUTPROC_INSTRUMENT_EVENT_DECODE";
/// named routing tag（insert bus / LinkAudio channel）が render 対象に存在せず、event が
/// 消費されないまま retain され続けている（メモリ増加 + 鳴らない音）。WARNING severity。
/// core の `Scheduler::unroutable_event_count` を 1 Hz ticker が監視して発火する
/// （#461 review: 「宣言前 tag / 名前 typo」の唯一の観測点）。
pub const ERROR_CODE_UNROUTABLE_EVENTS: &str = "UNROUTABLE_EVENTS";

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
