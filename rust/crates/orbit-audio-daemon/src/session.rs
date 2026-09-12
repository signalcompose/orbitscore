//! 1 WebSocket 接続あたりのメッセージループ。
//!
//! writer task と reader task を分離した構造:
//! - reader: WebSocket 受信 → Command dispatch → Response を mpsc へ送る
//! - writer: mpsc から受信 → WebSocket へ書き込む
//! - 遅延イベント (PlayEnded 等) も mpsc で writer に合流する
//!
//! これにより、handle_command の非同期待ち中にもイベントを送れる。

use std::sync::Arc;

mod dispatch;
mod dispatch_plugin;
mod dispatch_transport;
mod params;
mod params_plugin;
mod run_loop;
#[allow(unused_imports)]
use dispatch::*;
#[allow(unused_imports)]
use dispatch_plugin::*;
#[allow(unused_imports)]
use dispatch_transport::*;
#[allow(unused_imports)]
use params::*;
#[allow(unused_imports)]
use params_plugin::*;
pub use run_loop::run;
#[allow(unused_imports)]
use run_loop::*;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::{error, warn};

#[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
use crate::engine_wrap::ClapPluginRole;
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use crate::engine_wrap::PluginStateTarget;
#[cfg(any(test, all(feature = "outproc-effect", feature = "outproc-instrument")))]
use crate::engine_wrap::SourceRoutingTarget;
#[cfg(feature = "outproc-effect")]
use crate::engine_wrap::{BusLineDest, BusLineOp};
use crate::engine_wrap::{EngineWrap, PluginUiEvent, WrapError};
use crate::protocol::{
    Command, ErrorResponse, Event, Handshake, OkResponse, ProtocolError,
    ERROR_CODE_CLAP_PROCESS_ERROR, ERROR_CODE_DEVICE_LOST, ERROR_CODE_ENGINE_LOCK_CONTENTION,
    ERROR_CODE_ENGINE_LOCK_POISONED, ERROR_CODE_LINK_EGRESS_DROP, ERROR_CODE_OUTPROC_EFFECT_ERROR,
    ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED, ERROR_CODE_OUTPROC_EFFECT_INVALID,
    ERROR_CODE_OUTPROC_EFFECT_RESPAWN, ERROR_CODE_OUTPROC_INSTRUMENT_ERROR,
    ERROR_CODE_OUTPROC_INSTRUMENT_EVENT_DECODE, ERROR_CODE_OUTPROC_INSTRUMENT_INVALID,
    ERROR_CODE_OUTPROC_INSTRUMENT_OUTPUT_DROPPED, ERROR_CODE_OUTPROC_INSTRUMENT_RESPAWN,
    ERROR_CODE_PLUGIN_EVENT_RING_OVERFLOW, ERROR_CODE_STREAM_XRUN, ERROR_CODE_UNROUTABLE_EVENTS,
    ERROR_SEVERITY_FATAL, ERROR_SEVERITY_WARNING, EVENT_DAEMON_ERROR, EVENT_PLAY_ENDED,
    EVENT_PLAY_STARTED, EVENT_PLUGIN_UI_CLOSED, EVENT_PLUGIN_UI_CLOSED_BY_RESPAWN,
    EVENT_PLUGIN_UI_CLOSE_DONE, EVENT_STREAM_STATS,
};

/// writer task のキュー容量。過大に積まれると back pressure をかける。
const EVENT_CHANNEL_CAPACITY: usize = 128;

/// StreamStats の送出間隔。protocol 仕様で 1 Hz 固定。
const STREAM_STATS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
const ERROR_CODE_STREAM_CALLBACK_DEAD: &str = "STREAM_CALLBACK_DEAD";
const ERROR_CODE_STREAM_CALLBACK_STALLED: &str = "STREAM_CALLBACK_STALLED";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CallbackHealthEvent {
    Dead,
    StalledWarning,
    StalledFatal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CallbackHealthUpdate {
    alive: bool,
    event: Option<CallbackHealthEvent>,
}

/// 1 Hz ticker 専用の callback 生存状態。GetStatus 呼び出しごとの時間窓は作らない。
struct CallbackLiveness {
    previous_count: u64,
    ever_ran: bool,
    dead_reported: bool,
    consecutive_stalled_ticks: u8,
}

impl CallbackLiveness {
    fn new(initial_count: u64) -> Self {
        Self {
            previous_count: initial_count,
            ever_ran: initial_count > 0,
            dead_reported: false,
            consecutive_stalled_ticks: 0,
        }
    }

    fn observe(&mut self, count: u64) -> CallbackHealthUpdate {
        let alive = count != self.previous_count;
        self.previous_count = count;
        if alive {
            self.ever_ran = true;
            self.consecutive_stalled_ticks = 0;
            return CallbackHealthUpdate { alive, event: None };
        }
        let event = if !self.ever_ran {
            if self.dead_reported {
                None
            } else {
                self.dead_reported = true;
                Some(CallbackHealthEvent::Dead)
            }
        } else {
            self.consecutive_stalled_ticks = self.consecutive_stalled_ticks.saturating_add(1);
            match self.consecutive_stalled_ticks {
                1 => Some(CallbackHealthEvent::StalledWarning),
                2 => Some(CallbackHealthEvent::StalledFatal),
                _ => None,
            }
        };
        CallbackHealthUpdate { alive, event }
    }
}

/// `EVENT_DAEMON_ERROR` を共通形（severity / code / message の3フィールド）で構築する。
/// 1 Hz ticker の fatal(device_lost) / warning(xrun) / warning(link egress drop) が共有する。
fn daemon_error_event(severity: &str, code: &str, message: String) -> Event {
    Event::new(
        EVENT_DAEMON_ERROR,
        json!({
            "severity": severity,
            "code": code,
            "message": message,
        }),
    )
}

fn plugin_ui_protocol_event(event: PluginUiEvent) -> Event {
    match event {
        PluginUiEvent::Closed {
            target,
            generation,
            evt_seq,
        } => Event::new(
            EVENT_PLUGIN_UI_CLOSED,
            json!({
                "target": target,
                "generation": generation,
                "evt_seq": evt_seq,
            }),
        ),
        PluginUiEvent::CloseDone { target, completion } => Event::new(
            EVENT_PLUGIN_UI_CLOSE_DONE,
            json!({
                "target": target,
                "completion": completion.as_str(),
            }),
        ),
        PluginUiEvent::ClosedByRespawn { target } => Event::new(
            EVENT_PLUGIN_UI_CLOSED_BY_RESPAWN,
            json!({ "target": target }),
        ),
    }
}

async fn forward_plugin_ui_events(
    mut events: tokio::sync::broadcast::Receiver<PluginUiEvent>,
    tx: mpsc::Sender<String>,
) {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(skipped, "plugin UI WebSocket subscriber lagged");
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        };
        if tx
            .send(to_json_or_fallback(&plugin_ui_protocol_event(event)))
            .await
            .is_err()
        {
            break;
        }
    }
}

#[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
fn outproc_role_param_is_valid(params: &Value) -> bool {
    params.get("role").and_then(Value::as_str) == Some("effect")
}

/// in-process build の LoadPlugin にはこの PR 前は role 概念がなかった。単一 slot を安全に保護するため
/// role は現在必須であり、省略する client は明示的に拒否する。
#[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
fn clap_role_param(params: &Value) -> Option<ClapPluginRole> {
    match params.get("role").and_then(Value::as_str) {
        Some("effect") => Some(ClapPluginRole::Effect),
        Some("instrument") => Some(ClapPluginRole::Instrument),
        _ => None,
    }
}

#[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
fn outproc_role_param_is_valid(params: &Value) -> bool {
    params.get("role").and_then(Value::as_str) == Some("instrument")
}

#[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
fn outproc_role_param_is_valid(params: &Value) -> bool {
    matches!(
        params.get("role").and_then(Value::as_str),
        Some("effect" | "instrument")
    )
}

/// LoadPlugin params から `bus` を取り出す純関数。`None` は無指定（master bus）、`Ok(Some(_))` は
/// non-empty 文字列。空文字列や非文字列型は `Err` として拒否する。
fn parse_bus_param(params: &Value) -> Result<Option<String>, &'static str> {
    match params.get("bus") {
        None => Ok(None),
        Some(Value::String(bus)) if !bus.trim().is_empty() => Ok(Some(bus.clone())),
        Some(_) => Err("'bus' must be a non-empty string"),
    }
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

/// SetLinkTempo の bpm 上限（sanity bound）。Ableton Link の実用上限近辺。musical な厳密ゲートではなく、
/// `f64::MAX` 等が `beat_per_frame` を `+Inf` に飛ばして beat 計算を壊すのを防ぐ防御的キャップ。
const MAX_LINK_BPM: f64 = 999.0;

/// SetLinkTempo の bpm を検証する（pure）。NaN / ±Inf / 非正値を弾き、`MAX_LINK_BPM` で上限を課す。
/// 下限は付けない（遅い tempo を弾かない）。
fn validate_bpm(bpm: f64) -> bool {
    bpm.is_finite() && bpm > 0.0 && bpm <= MAX_LINK_BPM
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
        // Stop 命令で停止された play_id なら PlayEnded を送出しない。
        // Stop 応答 + PlayEnded の二重通知を避け、protocol の意味論を保つ。
        if engine.take_play_ended_suppressed(&play_id) {
            return;
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

/// `params` から f64 を取り出す（欠落 / 非数値は `default`）。PlayAt の time/gain/pan/
/// offset/duration 抽出が同一の `get().and_then(as_f64).unwrap_or()` 定型だったのを集約する。
fn param_f64(params: &Value, key: &str, default: f64) -> f64 {
    params.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
}

/// `channel` param を MIDI channel（0..=15）として取り出す。欠如 / 非数値は 0。範囲外は
/// `MALFORMED_REQUEST`（`key` の 0..=127 検証と対称・out-of-range を silent truncation しない）。
fn parse_midi_channel(params: &Value) -> Result<u8, ProtocolError> {
    match params.get("channel").and_then(|v| v.as_u64()) {
        None => Ok(0),
        Some(c) if c <= 15 => Ok(c as u8),
        Some(_) => Err(ProtocolError::new(
            "MALFORMED_REQUEST",
            "'channel' must be 0..=15",
        )),
    }
}

/// PluginNoteOn/Off の engine 呼び出し（key, channel, velocity, instance — #540 P1）。
type PluginNoteCall = fn(&EngineWrap, u8, u8, f64, Option<String>) -> Result<(), WrapError>;

/// `PluginNoteOn`/`PluginNoteOff` の配線（`default_velocity`/`status`/`call`）。
struct PluginNoteSpec {
    default_velocity: f64,
    status: &'static str,
    call: PluginNoteCall,
}

/// `method` 文字列から [`PluginNoteSpec`] を解決する single source of truth。`handle_command` 冒頭の
/// dispatch（`"PluginNoteOn"`/`"PluginNoteOff"` を判定する唯一の箇所）と、下のテスト
/// `plugin_note_spec_*` の両方がここを参照する（#402 pr-test-analyzer 指摘・iteration 2〜3）。
/// `"PluginNoteOn"`/`"PluginNoteOff"` 以外は `None`。
fn plugin_note_spec(method: &str) -> Option<PluginNoteSpec> {
    match method {
        "PluginNoteOn" => Some(PluginNoteSpec {
            default_velocity: 0.8,
            status: "note_on",
            call: EngineWrap::plugin_note_on,
        }),
        "PluginNoteOff" => Some(PluginNoteSpec {
            default_velocity: 0.0,
            status: "note_off",
            call: EngineWrap::plugin_note_off,
        }),
        _ => None,
    }
}

/// `PluginNoteOn`/`PluginNoteOff` の共通本体（key/channel 検証・spawn_blocking・応答整形が
/// 完全に同型なので集約する・#402 レビュー指摘）。`call` は `EngineWrap::plugin_note_on`/
/// `plugin_note_off` を渡す。
///
/// plugin 未ロード時（LoadPlugin 前 / load 失敗後）は `call`（`push_plugin_event` 経由）が事前に
/// `CLAP_NOT_LOADED`("no plugin loaded") エラーを返す（#405・嘘の成功応答を防ぐ。ロード成功後の
/// 精密な非同期状態〔hot-unload 等〕までは追わない — 現状そのような機構が無いため）。
/// 残存課題（Issue #410）: このガードは「LoadPlugin の応答成功」しか検知できない。応答成功〜
/// audio thread への実インストールの間の狭い window では、ガードは通過するが note が無音のまま
/// ドレインされる同種の false-success が残りうる（cross-thread ack の実装は #405/#407 では
/// 意図的に scope 外とした）。
async fn handle_plugin_note(
    id: &str,
    params: &Value,
    engine: &Arc<EngineWrap>,
    default_velocity: f64,
    status: &'static str,
    call: PluginNoteCall,
) -> Value {
    match params.get("key").and_then(|v| v.as_u64()) {
        Some(k) if k <= 127 => match parse_midi_channel(params) {
            Ok(channel) => {
                // velocity は CLAP 期待レンジ 0.0..=1.0 に clamp する（範囲外は plugin 挙動が
                // 未定義になるため）。
                let velocity = param_f64(params, "velocity", default_velocity).clamp(0.0, 1.0);
                // #540 P1: instance で slot pool の宛先を選ぶ（欠如は互換の "default"）。
                let instance = match parse_optional_nonempty_string_param(params, "instance") {
                    Ok(instance) => instance,
                    Err(message) => {
                        return err(id, ProtocolError::new("MALFORMED_REQUEST", message))
                    }
                };
                let engine = engine.clone();
                let res = tokio::task::spawn_blocking(move || {
                    call(&engine, k as u8, channel, velocity, instance)
                })
                .await;
                match res {
                    Ok(Ok(())) => ok(id, json!({"status": status, "key": k})),
                    Ok(Err(e)) => err(id, wrap_err_to_protocol(&e)),
                    Err(join_err) => err(
                        id,
                        ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                    ),
                }
            }
            Err(e) => err(id, e),
        },
        _ => err(
            id,
            ProtocolError::new(
                "MALFORMED_REQUEST",
                "missing or out-of-range 'key' (0..=127)",
            ),
        ),
    }
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

#[cfg(feature = "outproc-instrument")]
fn replaced_plugin_ok(id: &str, info: crate::engine_wrap::ReplacedPluginSummary) -> Value {
    ok(
        id,
        json!({
            "plugin_id": info.plugin.plugin_id,
            "plugin_name": info.plugin.plugin_name,
            "note_port_index": info.plugin.note_port_index,
            "quarantined_slot": info.quarantined_slot,
        }),
    )
}

fn err(id: &str, error: ProtocolError) -> Value {
    serde_json::to_value(ErrorResponse {
        id: id.to_string(),
        error,
    })
    .expect("ErrorResponse must be serializable")
}

/// `OutputError` のうち、利用者が行動を変えられるものだけを protocol code へ写す。
/// **コード表はここ 1 箇所だけ**。actionable でないものは `None` を返し、呼び出し元が
/// `DEVICE_CONFIG_ERROR` へ落とす。
///
/// 🔴 `SwitchRecoveryFailed` を `primary` のコードへ畳まないのは意図的。畳むと
/// 「元の出力を継続します」という `AUDIO_DEVICE_STREAM_DEAD` の文言が、**継続できていない**
/// 事象に付く（2026-09-05 の監査で発覚）。取れる手が違う（再起動しかない）ので別コードにする。
fn actionable_output_error_code(output: &orbit_audio_native::OutputError) -> Option<&'static str> {
    use orbit_audio_native::OutputError as O;
    match output {
        O::StreamDead { .. } => Some(crate::protocol::ERROR_CODE_AUDIO_DEVICE_STREAM_DEAD),
        O::SampleRateMismatch { .. } => {
            Some(crate::protocol::ERROR_CODE_AUDIO_DEVICE_RATE_MISMATCH)
        }
        O::DeviceUnavailable { .. } => Some(crate::protocol::ERROR_CODE_AUDIO_DEVICE_UNAVAILABLE),
        O::SwitchRecoveryFailed { .. } => {
            Some(crate::protocol::ERROR_CODE_AUDIO_DEVICE_SWITCH_RECOVERY_FAILED)
        }
        _ => None,
    }
}

pub(crate) fn wrap_err_to_protocol(e: &WrapError) -> ProtocolError {
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
        // 🔴 コード表は `actionable_output_error_code` の 1 箇所だけ。以前はここに直接 3 アーム +
        // `SwitchRecoveryFailed.primary` 用に同じ 3 アームが並んでいて、新しい actionable な
        // `OutputError` を足す人が**片方だけ更新して黙って `DEVICE_CONFIG_ERROR` に落ちる**形だった。
        //
        // メッセージは常に `OutputError` の Display を使う（`WrapError::Output` の
        // 「audio output init failed: 」は切替経路では嘘になる）。
        WrapError::Output(o) => ProtocolError::new(
            actionable_output_error_code(o).unwrap_or("DEVICE_CONFIG_ERROR"),
            o.to_string(),
        ),
        WrapError::Scheduler(msg) => ProtocolError::new("INTERNAL_ERROR", msg.clone()),
        // feature-gap（TS は warn-once で握り潰す）と runtime 失敗（TS は rethrow）を別コードにする。
        WrapError::LinkAudioUnavailable(msg) => {
            ProtocolError::new("LINK_AUDIO_UNAVAILABLE", msg.clone())
        }
        WrapError::LinkAudio(msg) => ProtocolError::new("LINK_AUDIO_RUNTIME", msg.clone()),
        // CLAP も LinkAudio と同様 feature-gap（UNAVAILABLE）と runtime 失敗を別コードにする。
        WrapError::ClapUnavailable(msg) => ProtocolError::new("CLAP_UNAVAILABLE", msg.clone()),
        WrapError::Clap(msg) => ProtocolError::new("CLAP_RUNTIME", msg.clone()),
        WrapError::ClapCrossRoleRejected(msg) => {
            ProtocolError::new("CLAP_CROSS_ROLE_REJECTED", msg.clone())
        }
        // 未ロード（LoadPlugin 未送信 / 失敗後）は feature-gap でも汎用 runtime エラーでもない専用
        // コード（#405）。TS 層が「まだロードしていない」ことを actionable に判定できるようにする。
        WrapError::ClapNotLoaded(msg) => ProtocolError::new("CLAP_NOT_LOADED", msg.clone()),
        // OOP effect も同様 feature-gap（UNAVAILABLE）と runtime 失敗を別コードにする（γ M1 PR-C）。
        WrapError::OutProcEffectUnavailable(msg) => {
            ProtocolError::new("OUTPROC_EFFECT_UNAVAILABLE", msg.clone())
        }
        WrapError::OutProcEffect(msg) => ProtocolError::new("OUTPROC_EFFECT_RUNTIME", msg.clone()),
        // APPLY の確定拒否と、timeout / child lifecycle を跨いで daemon 登記を確認できない
        // 結果を分離する専用コード（#405 の CLAP_NOT_LOADED と同じく TS 層が actionable に判定）。
        WrapError::OutProcEffectUncertain(msg) => {
            ProtocolError::new("OUTPROC_EFFECT_UNCERTAIN", msg.clone())
        }
        WrapError::OutProcEffectRequest(msg) => {
            ProtocolError::new("MALFORMED_REQUEST", msg.clone())
        }
        WrapError::OutProcInstrumentUnavailable(msg) => {
            ProtocolError::new("OUTPROC_INSTRUMENT_UNAVAILABLE", msg.clone())
        }
        WrapError::OutProcInstrument(msg) | WrapError::OutProcInstrumentStale(msg) => {
            ProtocolError::new("OUTPROC_INSTRUMENT_RUNTIME", msg.clone())
        }
        WrapError::OutProcAttachFailed(msg) => {
            ProtocolError::new("OUTPROC_ATTACH_FAILED", msg.clone())
        }
        WrapError::OutProcSlotClosed(msg) => ProtocolError::new("OUTPROC_SLOT_CLOSED", msg.clone()),
        WrapError::PluginStateTarget(msg) => {
            ProtocolError::new("PLUGIN_STATE_TARGET_ERROR", msg.clone())
        }
        WrapError::PluginStateNotReady(msg) => {
            ProtocolError::new("PLUGIN_STATE_NOT_READY", msg.clone())
        }
        WrapError::PluginStateTimeout(msg) => {
            ProtocolError::new("PLUGIN_STATE_TIMEOUT", msg.clone())
        }
        WrapError::PluginStateUnsupported(msg) => {
            ProtocolError::new("PLUGIN_STATE_UNSUPPORTED", msg.clone())
        }
        WrapError::PluginStateChildExited(msg) => {
            ProtocolError::new("PLUGIN_STATE_CHILD_EXITED", msg.clone())
        }
        WrapError::PluginStateProtocol(msg) => {
            ProtocolError::new("PLUGIN_STATE_PROTOCOL_ERROR", msg.clone())
        }
        WrapError::PluginStateIo(msg) => ProtocolError::new("PLUGIN_STATE_IO_ERROR", msg.clone()),
        WrapError::PluginUiUnavailable(msg) => {
            ProtocolError::new("PLUGIN_UI_UNAVAILABLE", msg.clone())
        }
        WrapError::PluginUiTarget(msg) => ProtocolError::new("PLUGIN_UI_TARGET_ERROR", msg.clone()),
        WrapError::PluginUiProtocol(msg) => {
            ProtocolError::new("PLUGIN_UI_PROTOCOL_ERROR", msg.clone())
        }
        WrapError::PluginUiCommand(msg) => {
            ProtocolError::new("PLUGIN_UI_COMMAND_ERROR", msg.clone())
        }
        // ランタイム device switch（`SelectAudioDevice`・#484 D2）が実行できない状態
        // （capture 有効中の明示拒否・audio owner thread 未生存 = test backend 等）。
        WrapError::AudioDeviceSwitchUnavailable(msg) => {
            ProtocolError::new("AUDIO_DEVICE_SWITCH_UNAVAILABLE", msg.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "outproc-instrument")]
    #[tokio::test]
    async fn get_status_reports_active_plugin_note_count() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        engine
            .inject_active_plugin_note("plugin:status", 2, 64)
            .expect("inject active note");
        let (tx, _rx) = mpsc::channel(1);

        let response = handle_command(
            Command {
                id: "status-notes".into(),
                method: "GetStatus".into(),
                params: json!({}),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["result"]["active_plugin_notes"], 1);
    }

    #[test]
    fn callback_liveness_uses_tick_deltas_and_escalates_a_continuous_stall() {
        let mut health = CallbackLiveness::new(10);
        assert_eq!(
            health.observe(11),
            CallbackHealthUpdate {
                alive: true,
                event: None
            }
        );
        assert_eq!(
            health.observe(11),
            CallbackHealthUpdate {
                alive: false,
                event: Some(CallbackHealthEvent::StalledWarning)
            }
        );
        assert_eq!(
            health.observe(11),
            CallbackHealthUpdate {
                alive: false,
                event: Some(CallbackHealthEvent::StalledFatal)
            }
        );
        assert_eq!(
            health.observe(11),
            CallbackHealthUpdate {
                alive: false,
                event: None
            }
        );
        assert_eq!(
            health.observe(12),
            CallbackHealthUpdate {
                alive: true,
                event: None
            }
        );
        assert_eq!(
            health.observe(12),
            CallbackHealthUpdate {
                alive: false,
                event: Some(CallbackHealthEvent::StalledWarning)
            }
        );
    }

    #[test]
    fn callback_liveness_reports_never_started_once_as_fatal() {
        let mut health = CallbackLiveness::new(0);
        assert_eq!(
            health.observe(0),
            CallbackHealthUpdate {
                alive: false,
                event: Some(CallbackHealthEvent::Dead)
            }
        );
        assert_eq!(
            health.observe(0),
            CallbackHealthUpdate {
                alive: false,
                event: None
            }
        );
        assert_eq!(
            health.observe(1),
            CallbackHealthUpdate {
                alive: true,
                event: None
            }
        );
    }

    #[tokio::test]
    async fn get_status_adds_effective_output_callback_state_and_last_switch_failure() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend {
            sample_rate: 96_000,
            channels: 6,
        })
        .expect("stub backend starts");
        engine.stream_stats_arc().record_callback(384);
        engine.set_callback_alive(true);
        engine
            .record_device_switch_failure_for_test("Rejected Output", "simulated callback timeout");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "status".into(),
                method: "GetStatus".into(),
                params: json!({}),
            },
            &engine,
            &tx,
        )
        .await;
        let result = &response["result"];
        assert_eq!(result["output_sample_rate"], 96_000);
        assert_eq!(result["output_channels"], 6);
        assert_eq!(result["output"]["device_name"], "test audio backend");
        assert_eq!(result["output"]["sample_rate"], 96_000);
        assert_eq!(result["output"]["channels"], 6);
        assert_eq!(result["output"]["device_requested"], Value::Null);
        assert_eq!(result["output"]["device_fell_back"], false);
        assert_eq!(result["output"]["fallback_reason"], Value::Null);
        assert_eq!(result["output"]["first_callback_ms"], 0);
        assert_eq!(
            result["output"]["last_switch_failure"],
            "audio device switch unavailable: simulated callback timeout"
        );
        assert_eq!(result["callback"]["count"], 1);
        assert_eq!(result["callback"]["alive"], true);
        assert_eq!(result["callback"]["last_frames"], 384);
    }

    #[test]
    fn set_source_routing_parses_all_three_explicit_targets() {
        assert_eq!(
            parse_set_source_routing_params(&json!({
                "source": "opaque:source/key",
                "unit": 7,
                "target": {"kind": "bus", "name": "seq-bus-3"}
            })),
            Ok((
                "opaque:source/key".to_owned(),
                7,
                SourceRoutingTarget::Bus("seq-bus-3".to_owned())
            ))
        );
        assert_eq!(
            parse_set_source_routing_params(&json!({
                "source": "opaque:source/key",
                "unit": 0,
                "target": {"kind": "none"}
            })),
            Ok(("opaque:source/key".to_owned(), 0, SourceRoutingTarget::None))
        );
        assert_eq!(
            parse_set_source_routing_params(&json!({
                "source": "opaque:source/key",
                "unit": 1,
                "target": {"kind": "master"}
            })),
            Ok((
                "opaque:source/key".to_owned(),
                1,
                SourceRoutingTarget::Master
            ))
        );
    }

    #[test]
    fn set_source_routing_rejects_missing_or_malformed_fields() {
        for params in [
            json!({"unit": 0, "target": null}),
            json!({"source": " ", "unit": 0, "target": null}),
            json!({"source": "source", "target": null}),
            json!({"source": "source", "unit": -1, "target": null}),
            json!({"source": "source", "unit": 1.5, "target": null}),
            json!({"source": "source", "unit": 4294967296_u64, "target": null}),
            json!({"source": "source", "unit": 0}),
            json!({"source": "source", "unit": 0, "target": " "}),
            json!({"source": "source", "unit": 0, "target": "seq-bus-0"}),
            json!({"source": "source", "unit": 0, "target": {"kind": "bus", "name": " "}}),
            json!({"source": "source", "unit": 0, "target": {"kind": "none", "name": "extra"}}),
            json!({"source": "source", "unit": 0, "target": {"kind": "unknown"}}),
        ] {
            assert!(
                parse_set_source_routing_params(&params).is_err(),
                "malformed params must be rejected: {params}"
            );
        }
    }

    #[cfg(not(all(feature = "outproc-effect", feature = "outproc-instrument")))]
    #[tokio::test]
    async fn set_source_routing_reports_unsupported_without_both_build_features() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "route-source".into(),
                method: "SetSourceRouting".into(),
                params: json!({"source": "source", "unit": 0, "target": null}),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "UNSUPPORTED");
    }

    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    #[tokio::test]
    async fn set_source_routing_valid_wire_shape_reaches_the_feature_boundary() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "route-source".into(),
                method: "SetSourceRouting".into(),
                params: json!({
                    "source": "opaque:source/key",
                    "unit": 0,
                    "target": {"kind": "none"}
                }),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "OUTPROC_INSTRUMENT_UNAVAILABLE");
    }

    #[tokio::test]
    async fn apply_effect_chain_wire_parses_the_v03_shape_and_rejects_non_effect_role() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);

        let applied = handle_command(
            Command {
                id: "apply-empty".into(),
                method: "ApplyEffectChain".into(),
                params: json!({
                    "role": "effect",
                    "mode": "diff",
                    "chain": [],
                    "save_dropped": []
                }),
            },
            &engine,
            &tx,
        )
        .await;
        // StubBackend intentionally has no outproc slots. Reaching this feature error proves the
        // complete v0.3 request shape parsed and was dispatched instead of being rejected.
        assert_eq!(applied["error"]["code"], "OUTPROC_EFFECT_UNAVAILABLE");

        let wrong_role = handle_command(
            Command {
                id: "apply-instrument".into(),
                method: "ApplyEffectChain".into(),
                params: json!({
                    "role": "instrument",
                    "mode": "diff",
                    "chain": []
                }),
            },
            &engine,
            &tx,
        )
        .await;
        assert_eq!(wrong_role["error"]["code"], "MALFORMED_REQUEST");
        assert_eq!(
            wrong_role["error"]["message"],
            "ApplyEffectChain requires role='effect'"
        );
    }

    #[tokio::test]
    async fn d12_retired_effect_replace_and_unload_report_apply_effect_chain() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);

        let effect_response = handle_command(
            Command {
                id: "replace-effect".into(),
                method: "ReplacePlugin".into(),
                params: json!({
                    "path": "/plugins/new.clap",
                    "role": "effect",
                    "bus": "seq-bus-0"
                }),
            },
            &engine,
            &tx,
        )
        .await;
        assert_eq!(effect_response["error"]["code"], "MALFORMED_REQUEST");
        assert!(effect_response["error"]["message"]
            .as_str()
            .expect("retirement message")
            .contains("superseded by ApplyEffectChain"));

        let effect_instance_response = handle_command(
            Command {
                id: "replace-effect-instance".into(),
                method: "ReplacePlugin".into(),
                params: json!({
                    "path": "/plugins/new.clap",
                    "role": "effect",
                    "instance": "plugin:lead"
                }),
            },
            &engine,
            &tx,
        )
        .await;
        assert_eq!(
            effect_instance_response["error"]["message"],
            "ReplacePlugin(role='effect') is superseded by ApplyEffectChain (#628)"
        );

        for (case, role) in [("missing", None), ("unknown", Some("unknown"))] {
            let mut params = json!({"path": "/plugins/new.clap"});
            if let Some(role) = role {
                params["role"] = json!(role);
            }
            let response = handle_command(
                Command {
                    id: format!("replace-{case}"),
                    method: "ReplacePlugin".into(),
                    params,
                },
                &engine,
                &tx,
            )
            .await;
            assert_eq!(response["error"]["code"], "MALFORMED_REQUEST");
            assert_eq!(
                response["error"]["message"],
                "ReplacePlugin requires role='effect' or role='instrument'"
            );
        }

        let unload_effect = handle_command(
            Command {
                id: "unload-effect".into(),
                method: "UnloadPlugin".into(),
                params: json!({"role": "effect", "bus": "seq-bus-0"}),
            },
            &engine,
            &tx,
        )
        .await;
        assert_eq!(unload_effect["error"]["code"], "MALFORMED_REQUEST");
        assert!(unload_effect["error"]["message"]
            .as_str()
            .expect("retirement message")
            .contains("superseded by ApplyEffectChain"));

        for (case, role) in [("missing", None), ("instrument", Some("instrument"))] {
            let mut params = json!({});
            if let Some(role) = role {
                params["role"] = json!(role);
            }
            let response = handle_command(
                Command {
                    id: format!("unload-{case}"),
                    method: "UnloadPlugin".into(),
                    params,
                },
                &engine,
                &tx,
            )
            .await;
            assert_eq!(response["error"]["code"], "MALFORMED_REQUEST");
            assert_eq!(
                response["error"]["message"],
                "UnloadPlugin supports role='effect' in v1"
            );
        }
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    #[test]
    fn d15_chain_path_rejects_nested_or_empty_paths_and_defaults_to_zero() {
        assert_eq!(
            chain_path_index(&json!({}), "GetPluginState").expect("default path"),
            0
        );
        assert_eq!(
            chain_path_index(&json!({"chain_path": [1]}), "OpenPluginUI").expect("flat path"),
            1
        );
        for path in [json!([]), json!([0, 1])] {
            let error = chain_path_index(&json!({"chain_path": path}), "GetPluginState")
                .expect_err("non-flat path must fail");
            assert_eq!(error.code, "MALFORMED_REQUEST");
            assert!(error.message.contains("chain_path"));
        }
    }

    #[tokio::test]
    async fn replace_plugin_handler_rejects_bus_for_instrument_role() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "replace-instrument-bus".into(),
                method: "ReplacePlugin".into(),
                params: json!({
                    "path": "/plugins/new.clap",
                    "role": "instrument",
                    "bus": "master"
                }),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "MALFORMED_REQUEST");
        assert_eq!(
            response["error"]["message"],
            "ReplacePlugin bus is invalid for role='instrument'"
        );
    }

    #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
    #[tokio::test]
    async fn replace_plugin_instrument_only_rejects_unsupported_instance_and_state() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);

        for (case, extra) in [
            ("instance", json!({"instance": "plugin:lead"})),
            ("state", json!({"state_path": "/states/new.state"})),
        ] {
            let mut params = json!({
                "path": "/plugins/new.clap",
                "role": "instrument"
            });
            params
                .as_object_mut()
                .expect("params object")
                .extend(extra.as_object().expect("extra object").clone());
            let response = handle_command(
                Command {
                    id: format!("replace-instrument-only-{case}"),
                    method: "ReplacePlugin".into(),
                    params,
                },
                &engine,
                &tx,
            )
            .await;

            assert_eq!(response["error"]["code"], "OUTPROC_INSTRUMENT_UNAVAILABLE");
            assert_eq!(
                response["error"]["message"],
                "this daemon build (outproc-instrument only) supports a single instrument \
                 instance and no state restore; rebuild with --features \
                 outproc-effect,outproc-instrument for per-sequence instances \
                 (ReplacePlugin instance/state_path)"
            );
        }
    }

    #[cfg(feature = "outproc-instrument")]
    #[test]
    fn replace_plugin_success_response_reports_slot_quarantine() {
        let response = replaced_plugin_ok(
            "replace-quarantined",
            crate::engine_wrap::ReplacedPluginSummary {
                plugin: crate::engine_wrap::LoadedPluginSummary {
                    plugin_id: "com.example.new".into(),
                    plugin_name: Some("New Plugin".into()),
                    note_port_index: 3,
                },
                quarantined_slot: true,
            },
        );

        assert_eq!(response["result"]["plugin_id"], "com.example.new");
        assert_eq!(response["result"]["plugin_name"], "New Plugin");
        assert_eq!(response["result"]["note_port_index"], 3);
        assert_eq!(response["result"]["quarantined_slot"], true);
    }

    #[tokio::test]
    async fn replace_plugin_instrument_payload_reaches_the_feature_boundary() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "replace-instrument".into(),
                method: "ReplacePlugin".into(),
                params: json!({
                    "path": "/plugins/new.clap",
                    "plugin_id": "com.example.new",
                    "role": "instrument",
                    "instance": "plugin:lead",
                    "state_path": "/states/new.state"
                }),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "OUTPROC_INSTRUMENT_UNAVAILABLE");
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("outproc"));
    }

    fn valid_render_score() -> Value {
        json!({
            "sample_rate": 48000,
            "duration_sec": 12.0,
            "block_frames": 128,
            "samples": [{"name": "kick", "path": "/score/audio/kick.wav"}],
            "buses": [{
                "name": "1",
                "chain": [{
                    "plugin": "/plugins/Glue.vst3",
                    "plugin_id": "com.example.glue",
                    "target": {"role": "effect", "bus": "1"},
                    "state": "/score/states/glue.state"
                }]
            }],
            "master": {"chain": []},
            "events": [{
                "start_sec": 0.25,
                "sample": "kick",
                "gain": 0.8,
                "pan": -0.25,
                "offset_sec": 0.0,
                "duration_sec": 0.5,
                "rate": 1.0,
                "bus": "1"
            }],
            "out_dir": "/score/render"
        })
    }

    /// 🔴 wire 契約の**単一の正本**。`packages/engine` が実際に出す payload そのもので、
    /// TS 側（`tests/audio/rust-engine/render-score.spec.ts`）が
    /// `serializeRenderScore(createRenderScore(...))` の出力と**同一であることを assert** する。
    ///
    /// 下の [`valid_render_score`] は「フィールドを落とす／不正値にする」変異の**素材**であって、
    /// engine が出す形の正本ではない（手書きのコピーなので、engine 側の rename に追従しない）。
    const ENGINE_WIRE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/render-score-manifest.json");

    /// engine が**実際に出す** manifest を daemon が受理することの証明。
    ///
    /// 動機（2026-08-01・main の変異検証で発見）: TS 側の round-trip と Rust 側の検証は
    /// 互いを見ていなかった。`out_dir` を **TS 側だけ**一貫して `outDir` にリネームする変異が
    /// **TS 19 passed / Rust 4 passed** で生き残り、engine が daemon の受け付けない payload を
    /// 出す状態が両側緑のまま成立した。この test はその経路を塞ぐ。
    #[test]
    fn render_score_accepts_the_manifest_the_engine_emits() {
        let value: Value =
            serde_json::from_str(ENGINE_WIRE_FIXTURE).expect("shared wire fixture is valid JSON");
        validate_render_score_params(&value).expect(
            "daemon must accept the exact payload packages/engine emits — \
             if this fails, the TS and Rust wire contracts have diverged \
             (see tests/fixtures/render-score-manifest.json)",
        );
    }

    #[test]
    fn render_score_accepts_complete_manifest_and_rejects_field_drop() {
        validate_render_score_params(&valid_render_score()).expect("complete manifest");

        let mut dropped = valid_render_score();
        dropped.as_object_mut().expect("object").remove("events");
        let error = validate_render_score_params(&dropped).expect_err("events is required");
        assert_eq!(error.code, "MALFORMED_REQUEST");
        assert!(error.message.contains("events"));
    }

    /// 🔴 `master` の必須性は手書きの `REQUIRED` ループでしか守られていない（#612 監査）。
    ///
    /// `RenderScoreManifest::master` は `Option<_>` なので、serde は欠落を黙って `None` に
    /// 既定化する。他 7 フィールドは非 `Option` で serde が弾くが、`master` だけは
    /// **ループを消すと欠落した manifest を daemon が受理してしまう** — TS 側
    /// （`render-score.ts` は 8 個すべて required）と乖離し、wire 契約が片側で緩む。
    ///
    /// 実証（2026-08-01）: `REQUIRED` から `"master"` を外す変異は、この test を足す前は
    /// **6 passed のまま生き残った**。
    #[test]
    fn render_score_requires_master_which_serde_would_default_to_none() {
        let mut without_master = valid_render_score();
        without_master
            .as_object_mut()
            .expect("object")
            .remove("master");

        let error = validate_render_score_params(&without_master).expect_err(
            "master の欠落は拒否されなければならない — serde は Option を None に既定化するので、\
             REQUIRED ループを消すとここが通ってしまい TS 側の契約と乖離する",
        );
        assert_eq!(error.code, "MALFORMED_REQUEST");
        assert!(
            error.message.contains("master"),
            "unexpected message: {}",
            error.message
        );
    }

    /// 重複した宣言名を拒否する（2026-08-01・TS 側の同型変異が生き残ったため両側に追加）。
    /// 重複を許すと events の参照先が「どちらが勝つか」= manifest の解釈依存になり、
    /// レンダ結果が宣言順に silent に依存する。
    #[test]
    fn render_score_rejects_duplicate_sample_and_bus_names() {
        let mut duplicate_sample = valid_render_score();
        duplicate_sample["samples"] = json!([
            {"name": "kick", "path": "/score/audio/kick.wav"},
            {"name": "kick", "path": "/score/audio/other.wav"}
        ]);
        let error =
            validate_render_score_params(&duplicate_sample).expect_err("duplicate sample name");
        assert!(
            error.message.contains("duplicates 'kick'"),
            "unexpected message: {}",
            error.message
        );

        let mut duplicate_bus = valid_render_score();
        duplicate_bus["buses"] = json!([
            {"name": "1", "chain": []},
            {"name": "1", "chain": []}
        ]);
        let error = validate_render_score_params(&duplicate_bus).expect_err("duplicate bus name");
        assert!(
            error.message.contains("duplicates '1'"),
            "unexpected message: {}",
            error.message
        );
    }

    #[test]
    fn render_score_checks_event_and_chain_bus_names_against_declarations() {
        let mut bad_event = valid_render_score();
        bad_event["events"][0]["bus"] = json!("2");
        let error = validate_render_score_params(&bad_event).expect_err("undeclared event bus");
        assert!(error.message.contains("undeclared render bus '2'"));

        let mut bad_chain = valid_render_score();
        bad_chain["buses"][0]["chain"][0]["target"]["bus"] = json!("2");
        let error = validate_render_score_params(&bad_chain).expect_err("mismatched chain bus");
        assert!(error.message.contains("must match containing bus '1'"));
    }

    #[test]
    fn render_score_and_get_plugin_state_share_target_vocabulary() {
        let target = json!({"role": "instrument", "instance": "plugin:lead"});
        assert_eq!(
            parse_plugin_target_vocabulary(&target, "GetPluginState").expect("state vocabulary"),
            parse_plugin_target_vocabulary(&target, "RenderScore").expect("render vocabulary")
        );

        let mut relative_state = valid_render_score();
        relative_state["buses"][0]["chain"][0]["state"] = json!("states/glue.state");
        let error = validate_render_score_params(&relative_state).expect_err("absolute state path");
        assert!(error.message.contains("absolute path"));
    }

    #[tokio::test]
    async fn valid_render_score_is_accepted_then_reports_not_implemented() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "render-p1".into(),
                method: "RenderScore".into(),
                params: valid_render_score(),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "NOT_IMPLEMENTED");
        assert!(response["error"]["message"]
            .as_str()
            .expect("message")
            .contains("P2"));
    }

    #[test]
    fn plugin_ui_events_use_the_existing_websocket_event_frame_schema() {
        use crate::engine_wrap::{PluginUiCompletion, PluginUiTarget};

        let target = PluginUiTarget {
            role: "effect",
            bus: Some("lead".into()),
            instance: None,
            window: Some(99),
            index: 2,
        };
        let closed = serde_json::to_value(plugin_ui_protocol_event(PluginUiEvent::Closed {
            target: target.clone(),
            generation: 7,
            evt_seq: 11,
        }))
        .expect("serialize closed event");
        assert_eq!(
            closed,
            json!({
                "type": "event",
                "event": "PluginUiClosed",
                "data": {
                    "target": {"role": "effect", "bus": "lead", "window": 99, "index": 2},
                    "generation": 7,
                    "evt_seq": 11,
                },
            })
        );

        let done = serde_json::to_value(plugin_ui_protocol_event(PluginUiEvent::CloseDone {
            target: target.clone(),
            completion: PluginUiCompletion::SafepointCompleted,
        }))
        .expect("serialize done event");
        assert_eq!(done["event"], "PluginUiCloseDone");
        assert_eq!(done["data"]["completion"], "safepoint-completed");

        let respawn =
            serde_json::to_value(plugin_ui_protocol_event(PluginUiEvent::ClosedByRespawn {
                target,
            }))
            .expect("serialize respawn event");
        assert_eq!(respawn["event"], "PluginUiClosedByRespawn");
        assert_eq!(respawn["data"]["target"]["index"], 2);
    }

    #[tokio::test]
    async fn plugin_ui_broadcast_subscriber_merges_into_session_writer_queue() {
        use crate::engine_wrap::PluginUiTarget;

        let (events, receiver) = tokio::sync::broadcast::channel(4);
        let (tx, mut rx) = mpsc::channel(4);
        let forwarder = tokio::spawn(forward_plugin_ui_events(receiver, tx));
        events
            .send(PluginUiEvent::ClosedByRespawn {
                target: PluginUiTarget {
                    role: "instrument",
                    bus: None,
                    instance: Some("plugin:lead".into()),
                    window: None,
                    index: 3,
                },
            })
            .expect("publish internal UI event");

        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("writer queue receive deadline")
            .expect("writer queue remains open");
        let frame: Value = serde_json::from_str(&frame).expect("valid event JSON");
        assert_eq!(frame["event"], "PluginUiClosedByRespawn");
        assert_eq!(frame["data"]["target"]["instance"], "plugin:lead");
        assert_eq!(frame["data"]["target"]["index"], 3);

        drop(events);
        forwarder
            .await
            .expect("forwarder exits when broadcast closes");
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    #[test]
    fn plugin_state_and_ui_requests_share_one_target_resolver() {
        #[cfg(feature = "outproc-effect")]
        let params = json!({"role": "effect", "bus": "lead"});
        #[cfg(all(not(feature = "outproc-effect"), feature = "outproc-instrument"))]
        let params = json!({"role": "instrument", "instance": "plugin:lead"});

        let state = parse_plugin_target(&params, "GetPluginState", "PLUGIN_STATE_UNAVAILABLE")
            .expect("state target");
        let ui = parse_plugin_target(&params, "OpenPluginUI", "PLUGIN_UI_UNAVAILABLE")
            .expect("UI target");
        assert_eq!(state, ui);
    }

    #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
    #[test]
    fn inprocess_load_plugin_requires_a_known_role() {
        assert_eq!(
            clap_role_param(&json!({"role": "effect"})),
            Some(ClapPluginRole::Effect)
        );
        assert_eq!(
            clap_role_param(&json!({"role": "instrument"})),
            Some(ClapPluginRole::Instrument)
        );
        assert_eq!(clap_role_param(&json!({})), None);
        assert_eq!(clap_role_param(&json!({"role": "unknown"})), None);
    }

    #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
    #[test]
    fn outproc_effect_load_plugin_accepts_only_effect_role() {
        assert!(outproc_role_param_is_valid(&json!({"role": "effect"})));
        assert!(!outproc_role_param_is_valid(&json!({"role": "instrument"})));
        assert!(!outproc_role_param_is_valid(&json!({})));
    }

    #[cfg(not(feature = "outproc-effect"))]
    #[tokio::test]
    async fn set_bus_line_wire_feature_gap_is_unsupported() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "set-bus-line-feature-gap".into(),
                method: "SetBusLine".into(),
                params: json!({"bus": "master", "line": []}),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "UNSUPPORTED");
    }

    #[cfg(feature = "outproc-effect")]
    fn assert_set_bus_line_parse_code(params: Value, expected: &str) {
        let error = parse_set_bus_line_params(&params).expect_err("request must be rejected");
        eprintln!("set_bus_line validation code={}", error.code);
        assert_eq!(error.code, expected);
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_bus_must_be_a_nonempty_string() {
        assert_set_bus_line_parse_code(json!({"bus": "", "line": []}), "MALFORMED_REQUEST");
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_line_ops_and_gains_must_have_the_contract_shape() {
        for params in [
            json!({"bus": "seq-bus-0", "line": {}}),
            json!({"bus": "seq-bus-0", "line": [{"op": "pan", "value": 0.0}]}),
            json!({"bus": "seq-bus-0", "line": [{"op": "gain", "gain": -0.1}]}),
            json!({"bus": "seq-bus-0", "line": [{"op": "gain", "gain": 1e100}]}),
            json!({"bus": "seq-bus-0", "line": [{"op": "output", "dest": {"kind": "master"}, "thru": false, "gain": "loud"}]}),
        ] {
            assert_set_bus_line_parse_code(params, "MALFORMED_REQUEST");
        }
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_rack_may_appear_at_most_once() {
        assert_set_bus_line_parse_code(
            json!({"bus": "seq-bus-0", "line": [{"op": "rack"}, {"op": "rack"}]}),
            "MALFORMED_REQUEST",
        );
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_device_channels_must_be_distinct_and_in_range() {
        for channels in [[1, 1], [0, 2], [1, 3]] {
            let (_, line) = parse_set_bus_line_params(&json!({
                "bus": "seq-bus-0",
                "line": [{"op": "output", "dest": {"kind": "device", "channels": channels}, "thru": false, "gain": 1.0}]
            }))
            .expect("shape is valid before device-capacity validation");
            let error = validate_set_bus_line_device_channels(&line, 2)
                .expect_err("device channel pair must be distinct and in range");
            eprintln!("set_bus_line validation code={}", error.code);
            assert_eq!(error.code, "PARAM_OUT_OF_RANGE");
        }
    }

    /// 設計 §11 PR-A1 が「新規 6 件」として挙げた検証のうち、**2 件が実装後に照合されないまま
    /// 残っていた**（`/code:pr-review-team` の test-analyzer・2026-09-11）。前回の Fable 監査が
    /// 3 件を埋めた**その一段外側**である。列挙は一段手前で止まる。
    ///
    /// (a) `channels` の要素数が 1 でも 2 でもない形（0 個 / 3 個以上）の拒否
    ///     — `parse_set_bus_line_dest` の `matches!(channels.len(), 1 | 2)`
    /// (b) **mono** の `left` が出力チャンネル数を超える場合の拒否
    ///     — `validate_set_bus_line_device_channels` の `*left > output_channels`
    ///     （既存テストは stereo ペアしか通しておらず、`right: None` の枝に到達していなかった）
    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_rejects_device_channel_arity_and_mono_out_of_range() {
        // (a) 要素数の形。ここは shape の誤りなので MALFORMED_REQUEST。
        for channels in [json!([]), json!([1, 2, 3]), json!([1, 2, 3, 4])] {
            let error = parse_set_bus_line_params(&json!({
                "bus": "seq-bus-0",
                "line": [{"op": "output", "dest": {"kind": "device", "channels": channels},
                          "thru": false, "gain": 1.0}]
            }))
            .expect_err("only one- or two-element channel arrays are a valid shape");
            eprintln!("arity {channels} -> {}", error.code);
            assert_eq!(error.code, "MALFORMED_REQUEST");
        }

        // (b) mono の範囲。形は正しいので capacity 検証まで進み、そこで範囲外になる。
        let (_, mono_over) = parse_set_bus_line_params(&json!({
            "bus": "seq-bus-0",
            "line": [{"op": "output", "dest": {"kind": "device", "channels": [5]},
                      "thru": false, "gain": 1.0}]
        }))
        .expect("a one-element array is a valid shape");
        let error = validate_set_bus_line_device_channels(&mono_over, 2)
            .expect_err("a mono channel past the device's capacity must reject");
        eprintln!("mono [5] on 2ch -> {}", error.code);
        assert_eq!(error.code, "PARAM_OUT_OF_RANGE");

        // mono の下限（0 は 1-based では不正）も同じ枝で拒否される。
        let (_, mono_zero) = parse_set_bus_line_params(&json!({
            "bus": "seq-bus-0",
            "line": [{"op": "output", "dest": {"kind": "device", "channels": [0]},
                      "thru": false, "gain": 1.0}]
        }))
        .expect("a one-element array is a valid shape");
        assert_eq!(
            validate_set_bus_line_device_channels(&mono_zero, 2)
                .expect_err("channel 0 is not a valid 1-based channel")
                .code,
            "PARAM_OUT_OF_RANGE"
        );
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_accepts_mono_device_and_rejects_pan_out_of_range() {
        let (_, line) = parse_set_bus_line_params(&json!({
            "bus": "seq-bus-0",
            "line": [{"op": "output", "dest": {"kind": "device", "channels": [3]}, "thru": false, "gain": 1.0}]
        }))
        .expect("one device channel is a valid mono destination");
        validate_set_bus_line_device_channels(&line, 3).expect("channel 3 is in range");
        assert!(matches!(
            &line[0],
            BusLineOp::Output {
                dest: BusLineDest::Device {
                    left: 3,
                    right: None
                },
                ..
            }
        ));

        let (_, duplicate) = parse_set_bus_line_params(&json!({
            "bus": "seq-bus-0",
            "line": [{"op": "output", "dest": {"kind": "device", "channels": [3, 3]}, "thru": false, "gain": 1.0}]
        }))
        .expect("duplicate channels pass shape parsing");
        let duplicate_error = validate_set_bus_line_device_channels(&duplicate, 3)
            .expect_err("a stereo pair must be distinct");
        assert_eq!(duplicate_error.code, "PARAM_OUT_OF_RANGE");

        assert_set_bus_line_parse_code(
            json!({"bus": "seq-bus-0", "line": [{"op": "pan", "pan": 1.5}]}),
            "PARAM_OUT_OF_RANGE",
        );
        // 🔴 旧版は `validate_set_bus_line_pan(f64::NAN)` を直接叩いて `!pan.is_finite()` の枝を
        // 検査していた。しかし**非有限の pan は wire から到達できない**（2026-09-11 実測）:
        // JSON に NaN / Infinity のリテラルは無く、`serde_json` は `1e400` を
        // `Error("number out of range")` として **parse 時点で拒否**する。
        // 到達できない入力でガードを検査しない — 実際に来る形（数値でない）を固定する。
        // `is_finite` のガード自体は防御として残す（型が保証していないため）。
        let nan_error = parse_set_bus_line_pan(&json!({"op": "pan", "pan": "loud"}))
            .expect_err("a non-numeric pan must reject");
        eprintln!(
            "mono=[3] accepted; duplicate={} pan(1.5)=PARAM_OUT_OF_RANGE pan(\"loud\")={}",
            duplicate_error.code, nan_error.code
        );
        assert_eq!(nan_error.code, "MALFORMED_REQUEST");
    }

    /// #611 束 A 監査（Fable Important #1）: 既存の pan wire テストは形の不正（否定側）しか見ておらず、
    /// `..._contract_shape` の `{"op": "pan", "value": 0.0}` も MALFORMED（"pan" キーが無い形）を
    /// 見ているだけで、受理された値の中身までは検査していない。`item.get("pan")` を
    /// `item.get("value")` 等に取り違えても全テストが緑のまま通り得るので、肯定側を固定する:
    /// 受理された `BusLineOp::Pan` の中身が JSON の `pan` 値と一致すること。
    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_pan_op_is_parsed_with_its_own_value() {
        let (_, line) = parse_set_bus_line_params(&json!({
            "bus": "seq-bus-0",
            "line": [{"op": "pan", "pan": 0.25}]
        }))
        .expect("a pan op with a valid value must be accepted");
        match line.as_slice() {
            [BusLineOp::Pan(pan)] => {
                assert!((*pan - 0.25).abs() <= 1e-6, "parsed pan={pan}, want 0.25");
            }
            other => panic!("expected a single BusLineOp::Pan, got {other:?}"),
        }
    }

    #[cfg(feature = "outproc-effect")]
    #[tokio::test]
    async fn set_bus_line_wire_dispatch_accepts_a_complete_line() {
        let engine = crate::engine_wrap::test_wrap_with_three_stage_topology();
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "set-bus-line-accepted".into(),
                method: "SetBusLine".into(),
                params: json!({
                    "bus": "seq-bus-0",
                    "line": [
                        {"op": "rack"},
                        {"op": "gain", "gain": 0.5},
                        {"op": "output", "dest": {"kind": "master"}, "thru": false, "gain": 1.0}
                    ]
                }),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["result"]["status"], "accepted");
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_render_destination_is_unregistered_today() {
        assert_set_bus_line_parse_code(
            json!({"bus": "seq-bus-0", "line": [{"op": "output", "dest": {"kind": "render", "id": "stem"}, "thru": false, "gain": 1.0}]}),
            "MALFORMED_REQUEST",
        );
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn set_bus_line_wire_master_rejects_master_and_bus_destinations() {
        for dest in [
            json!({"kind": "master"}),
            json!({"kind": "bus", "name": "sum-bus-0"}),
        ] {
            assert_set_bus_line_parse_code(
                json!({"bus": "master", "line": [{"op": "output", "dest": dest, "thru": false, "gain": 1.0}]}),
                "MALFORMED_REQUEST",
            );
        }
    }

    #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
    #[test]
    fn outproc_instrument_load_plugin_accepts_only_instrument_role() {
        assert!(outproc_role_param_is_valid(&json!({"role": "instrument"})));
        assert!(!outproc_role_param_is_valid(&json!({"role": "effect"})));
        assert!(!outproc_role_param_is_valid(&json!({})));
    }

    #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
    #[test]
    fn outproc_both_load_plugin_accepts_both_roles_and_rejects_invalid_role() {
        assert!(outproc_role_param_is_valid(&json!({"role": "effect"})));
        assert!(outproc_role_param_is_valid(&json!({"role": "instrument"})));
        assert!(!outproc_role_param_is_valid(&json!({"role": "invalid"})));
        assert!(!outproc_role_param_is_valid(&json!({})));
    }

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn parse_bus_param_accepts_absent_and_trims_nothing_but_rejects_blank_or_non_string() {
        assert_eq!(parse_bus_param(&json!({})), Ok(None));
        assert_eq!(
            parse_bus_param(&json!({"bus": "fx1"})),
            Ok(Some("fx1".to_owned()))
        );
        assert!(parse_bus_param(&json!({"bus": ""})).is_err());
        assert!(parse_bus_param(&json!({"bus": "   "})).is_err());
        assert!(parse_bus_param(&json!({"bus": 1})).is_err());
    }

    // PlayAt の 'bus'（PH.2b insert routing）と 'channel'（LinkAudio routing）は同じ core routing
    // tag フィールドを共有するため同時指定を拒否する（#434 S3）。
    #[cfg(feature = "outproc-effect")]
    #[test]
    fn playat_bus_and_channel_both_set_flags_only_the_combination() {
        assert!(playat_bus_and_channel_both_set(
            &Some("seq-bus-0".to_owned()),
            &Some("link-ch".to_owned())
        ));
        assert!(!playat_bus_and_channel_both_set(
            &Some("seq-bus-0".to_owned()),
            &None
        ));
        assert!(!playat_bus_and_channel_both_set(
            &None,
            &Some("link-ch".to_owned())
        ));
        assert!(!playat_bus_and_channel_both_set(&None, &None));
    }

    #[cfg(feature = "outproc-instrument")]
    #[test]
    fn bus_param_invalid_for_instrument_role_flags_only_the_combination() {
        assert!(bus_param_invalid_for_instrument_role(
            &json!({"role": "instrument", "bus": "fx1"})
        ));
        assert!(!bus_param_invalid_for_instrument_role(
            &json!({"role": "instrument"})
        ));
        assert!(!bus_param_invalid_for_instrument_role(
            &json!({"role": "effect", "bus": "fx1"})
        ));
    }

    // #540 P1（#542 レビュー test-gap）: instrument 専用 param の role 誤用判定を pin
    // （bus_param_invalid_for_instrument_role の対称テスト）。
    #[cfg(feature = "outproc-instrument")]
    #[test]
    fn instrument_only_param_misused_flags_only_the_combination() {
        let field = "instance";
        assert!(
            instrument_only_param_misused(&json!({"role": "effect", field: "x"}), field),
            "'{field}' on role=effect must be flagged"
        );
        assert!(
            !instrument_only_param_misused(&json!({"role": "instrument", field: "x"}), field),
            "'{field}' on role=instrument is the valid combination"
        );
        assert!(
            !instrument_only_param_misused(&json!({"role": "effect"}), field),
            "absent '{field}' must not be flagged"
        );
    }

    // #540 P1/P2（#542 レビュー test-gap）: 任意・非空文字列 param パーサの境界を pin。
    // 空文字列・空白のみ（parse_bus_param と対称の trim 判定）・非文字列は Err、欠如は Ok(None)。
    #[test]
    fn parse_optional_nonempty_string_param_boundaries() {
        for field in ["instance", "state_path"] {
            assert_eq!(
                parse_optional_nonempty_string_param(&json!({}), field),
                Ok(None),
                "absent '{field}' is Ok(None) (single-instrument compat)"
            );
            assert_eq!(
                parse_optional_nonempty_string_param(&json!({field: "plugin:kick"}), field),
                Ok(Some("plugin:kick".to_string()))
            );
            assert!(parse_optional_nonempty_string_param(&json!({field: ""}), field).is_err());
            assert!(
                parse_optional_nonempty_string_param(&json!({field: "  "}), field).is_err(),
                "whitespace-only '{field}' must be rejected (trim parity with parse_bus_param)"
            );
            assert!(parse_optional_nonempty_string_param(&json!({field: 7}), field).is_err());
        }
    }

    // LinkAudio エラーの protocol code 分割を pin（TS は UNAVAILABLE のみ握り潰し RUNTIME は rethrow）。
    #[test]
    fn link_audio_unavailable_maps_to_unavailable_code() {
        let e = WrapError::LinkAudioUnavailable("built without feature".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "LINK_AUDIO_UNAVAILABLE");
    }

    #[test]
    fn link_audio_runtime_maps_to_runtime_code() {
        let e = WrapError::LinkAudio("channel limit reached".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "LINK_AUDIO_RUNTIME");
    }

    #[test]
    fn audio_device_liveness_errors_map_to_actionable_codes() {
        let primary = orbit_audio_native::OutputError::StreamDead {
            device: "USB Audio".into(),
            waited_ms: 3_000,
            phase: orbit_audio_native::StreamLivenessPhase::Probe,
        };
        let dead = WrapError::Output(primary);
        assert_eq!(
            wrap_err_to_protocol(&dead).code,
            crate::protocol::ERROR_CODE_AUDIO_DEVICE_STREAM_DEAD
        );
        let mismatch = WrapError::Output(orbit_audio_native::OutputError::SampleRateMismatch {
            device: "USB Audio".into(),
            device_rate: 44_100,
            engine_rate: 48_000,
        });
        assert_eq!(
            wrap_err_to_protocol(&mismatch).code,
            crate::protocol::ERROR_CODE_AUDIO_DEVICE_RATE_MISMATCH
        );

        let recovery = WrapError::Output(orbit_audio_native::OutputError::SwitchRecoveryFailed {
            primary: Box::new(orbit_audio_native::OutputError::StreamDead {
                device: "USB Audio".into(),
                waited_ms: 3_000,
                phase: orbit_audio_native::StreamLivenessPhase::RealStream,
            }),
            resume: Box::new(orbit_audio_native::OutputError::PlayStream(
                "resume refused".into(),
            )),
        });
        let protocol = wrap_err_to_protocol(&recovery);
        // 🔴 `primary` のコードへ畳まない。畳むと「元の出力を継続します」という
        // `AUDIO_DEVICE_STREAM_DEAD` の UI 文言が、継続できていない事象に付く。
        assert_eq!(
            protocol.code,
            crate::protocol::ERROR_CODE_AUDIO_DEVICE_SWITCH_RECOVERY_FAILED
        );
        assert!(protocol
            .message
            .contains("produced no callback within 3000 ms"));
        assert!(protocol.message.contains("resume refused"));

        // F4（owner 裁定 2026-09-05）で新設した経路。ここが落ちると利用者は
        // `DEVICE_CONFIG_ERROR` しか受け取れず、エディタは「元の出力を継続します」を出せない。
        let unavailable = WrapError::Output(orbit_audio_native::OutputError::DeviceUnavailable {
            requested: "NoSuchDevice".into(),
            reason: "not found (available: [])".into(),
        });
        let protocol = wrap_err_to_protocol(&unavailable);
        assert_eq!(
            protocol.code,
            crate::protocol::ERROR_CODE_AUDIO_DEVICE_UNAVAILABLE
        );
        assert!(protocol.message.contains("NoSuchDevice"));
        // 切替では何も init していないので、この前置は載ってはいけない。
        assert!(
            !protocol.message.contains("audio output init failed"),
            "{}",
            protocol.message
        );
    }

    // CLAP エラーの protocol code 分割を pin（LinkAudio と同様: feature-gap=UNAVAILABLE /
    // runtime 失敗=RUNTIME。TS 層が両者を区別して扱うので drift させない・#340）。
    #[test]
    fn clap_unavailable_maps_to_unavailable_code() {
        let e = WrapError::ClapUnavailable("built without feature".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "CLAP_UNAVAILABLE");
    }

    #[test]
    fn clap_runtime_maps_to_runtime_code() {
        let e = WrapError::Clap("plugin event ring full".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "CLAP_RUNTIME");
    }

    #[test]
    fn clap_cross_role_rejection_maps_to_dedicated_code() {
        let e = WrapError::ClapCrossRoleRejected("single slot".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "CLAP_CROSS_ROLE_REJECTED");
    }

    // 未ロードは feature-gap / 汎用 runtime エラーのどちらとも別コードにする（#405）。
    #[test]
    fn clap_not_loaded_maps_to_not_loaded_code() {
        let e = WrapError::ClapNotLoaded("no plugin loaded (send LoadPlugin first)".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "CLAP_NOT_LOADED");
    }

    #[test]
    fn outproc_effect_uncertain_maps_to_actionable_code() {
        let e = WrapError::OutProcEffectUncertain("apply mailbox timed out".into());
        assert_eq!(wrap_err_to_protocol(&e).code, "OUTPROC_EFFECT_UNCERTAIN");
    }

    #[test]
    fn outproc_instrument_errors_map_to_distinct_protocol_codes() {
        let unavailable = WrapError::OutProcInstrumentUnavailable("not configured".into());
        assert_eq!(
            wrap_err_to_protocol(&unavailable).code,
            "OUTPROC_INSTRUMENT_UNAVAILABLE"
        );
        let runtime = WrapError::OutProcInstrument("note ring full".into());
        assert_eq!(
            wrap_err_to_protocol(&runtime).code,
            "OUTPROC_INSTRUMENT_RUNTIME"
        );
    }

    #[test]
    fn outproc_attach_failure_and_closed_slot_have_distinct_protocol_codes() {
        assert_eq!(
            wrap_err_to_protocol(&WrapError::OutProcAttachFailed("retry".into())).code,
            "OUTPROC_ATTACH_FAILED"
        );
        assert_eq!(
            wrap_err_to_protocol(&WrapError::OutProcSlotClosed("closed".into())).code,
            "OUTPROC_SLOT_CLOSED"
        );
    }

    // PluginNoteOn/Off の channel 検証: 欠如→0、0..=15 受理、範囲外は MALFORMED（key と対称）。
    #[test]
    fn parse_midi_channel_defaults_accepts_and_rejects() {
        assert_eq!(parse_midi_channel(&json!({})).unwrap(), 0, "欠如→0");
        assert_eq!(parse_midi_channel(&json!({"channel": 0})).unwrap(), 0);
        assert_eq!(parse_midi_channel(&json!({"channel": 15})).unwrap(), 15);
        assert_eq!(
            parse_midi_channel(&json!({"channel": 16}))
                .unwrap_err()
                .code,
            "MALFORMED_REQUEST",
            "16 は範囲外"
        );
        assert_eq!(
            parse_midi_channel(&json!({"channel": 256}))
                .unwrap_err()
                .code,
            "MALFORMED_REQUEST",
            "256 は as u8 で 0 に truncation せず弾く"
        );
    }

    // SetLinkTempo の bpm 検証（PT-2 / CR-2）: musical な値は受理、garbage は弾く。
    #[test]
    fn validate_bpm_accepts_musical_range_rejects_garbage() {
        // 受理: 一般的な範囲 + 遅い tempo（下限を付けないので 20 も valid）+ 上限ちょうど。
        assert!(validate_bpm(120.0));
        assert!(validate_bpm(20.0));
        assert!(validate_bpm(MAX_LINK_BPM));
        // 棄却: 非正値・NaN・±Inf・上限超過（Inf 伝播 / beat_per_frame overflow を防ぐ）。
        assert!(!validate_bpm(0.0));
        assert!(!validate_bpm(-1.0));
        assert!(!validate_bpm(f64::NAN));
        assert!(!validate_bpm(f64::INFINITY));
        assert!(!validate_bpm(f64::NEG_INFINITY));
        assert!(!validate_bpm(MAX_LINK_BPM + 1.0));
        assert!(!validate_bpm(f64::MAX));
    }

    // #402 pr-test-analyzer 指摘（iteration 2）: `handle_command` 冒頭の `"PluginNoteOn"`/
    // `"PluginNoteOff"` dispatch 自体（このテストではなく `plugin_note_spec` 経由の literal/
    // fn-pointer 配線）がコピペで入れ替わっていないことを pin する。`handle_command` を実際に
    // 呼んで response を比較する手は使えない: StubBackend では `call`（実
    // `EngineWrap::plugin_note_on`/`plugin_note_off`）が
    // clap 未初期化で即 `ClapUnavailable` に落ちるため、velocity/status は response に一切現れず、
    // PluginNoteOn/PluginNoteOff の応答が常に同一になってしまう（response 差分では検出不能）。
    // そのため `handle_command` が単一の真実源として参照する `plugin_note_spec` を直接 pin する。
    #[test]
    fn plugin_note_spec_maps_default_velocity_and_status() {
        let on = plugin_note_spec("PluginNoteOn").expect("PluginNoteOn has a spec");
        assert_eq!(on.default_velocity, 0.8, "NoteOn の既定 velocity");
        assert_eq!(on.status, "note_on");

        let off = plugin_note_spec("PluginNoteOff").expect("PluginNoteOff has a spec");
        assert_eq!(off.default_velocity, 0.0, "NoteOff の既定 velocity");
        assert_eq!(off.status, "note_off");

        assert!(
            plugin_note_spec("Ping").is_none(),
            "PluginNoteOn/Off 以外は None"
        );
    }

    // fn-pointer の取り違え（`call` フィールドが逆の `EngineWrap` メソッドを指す）を pin する。
    // `#[cfg(not(feature = "clap-host"))]` ビルドでは `plugin_note_on`/`plugin_note_off` の stub 本体が
    // バイト同一（同じ `ClapUnavailable` を返すだけ）なため、コンパイラの identical code folding で
    // 同一アドレスに畳まれ得るため、fn-pointer 比較が意味を持たない。よってこのテストは `clap-host` 有効
    // ビルド限定（本体が `push_plugin_event` に異なる `PluginEvent` variant を渡すため区別できる）。
    #[cfg(feature = "clap-host")]
    #[test]
    fn plugin_note_spec_dispatches_to_correct_engine_method() {
        let on = plugin_note_spec("PluginNoteOn").expect("PluginNoteOn has a spec");
        assert!(
            std::ptr::fn_addr_eq(
                on.call,
                EngineWrap::plugin_note_on as PluginNoteCall
            ),
            "PluginNoteOn は EngineWrap::plugin_note_on を呼ぶこと（NoteOff と入れ替わっていないこと）"
        );

        let off = plugin_note_spec("PluginNoteOff").expect("PluginNoteOff has a spec");
        assert!(
            std::ptr::fn_addr_eq(off.call, EngineWrap::plugin_note_off as PluginNoteCall),
            "PluginNoteOff は EngineWrap::plugin_note_off を呼ぶこと"
        );
    }

    // #402 pr-test-analyzer: handle_plugin_note の fn-pointer dispatch（call fn / default_velocity /
    // status 文字列の組み合わせ）が PluginNoteOn/PluginNoteOff の `plugin_note_spec` 間で
    // 入れ替わっていないことを pin する。実 `EngineWrap::plugin_note_on`/`plugin_note_off` を
    // 使うと（test backend では `clap: None` のため）常に ClapUnavailable で早期リターンし
    // velocity が観測できないので、
    // `call` fn だけを capture 用に差し替える（velocity の解決 = `param_f64(..., default_velocity)`
    // は `call` を呼ぶ前に handle_plugin_note 内部で完結するため、この capture が唯一の観測手段）。
    #[tokio::test]
    async fn handle_plugin_note_forwards_correct_default_velocity_and_status() {
        use std::sync::atomic::{AtomicU64, Ordering};

        static CAPTURED_VELOCITY_BITS: AtomicU64 = AtomicU64::new(0);

        fn capture_velocity(
            _engine: &EngineWrap,
            _key: u8,
            _channel: u8,
            velocity: f64,
            _instance: Option<String>,
        ) -> Result<(), WrapError> {
            CAPTURED_VELOCITY_BITS.store(velocity.to_bits(), Ordering::SeqCst);
            Ok(())
        }

        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let params = json!({"key": 60});

        // "PluginNoteOn" 配線: default_velocity=0.8 / status="note_on"（handle_command 参照）。
        let resp_on =
            handle_plugin_note("id-on", &params, &engine, 0.8, "note_on", capture_velocity).await;
        assert_eq!(
            f64::from_bits(CAPTURED_VELOCITY_BITS.load(Ordering::SeqCst)),
            0.8,
            "PluginNoteOn: velocity 省略時は NoteOn 自身の既定 0.8 に解決されること（NoteOff の \
             既定と入れ替わっていないこと）"
        );
        assert_eq!(resp_on["result"]["status"], "note_on");

        // "PluginNoteOff" 配線: default_velocity=0.0 / status="note_off"。
        let resp_off = handle_plugin_note(
            "id-off",
            &params,
            &engine,
            0.0,
            "note_off",
            capture_velocity,
        )
        .await;
        assert_eq!(
            f64::from_bits(CAPTURED_VELOCITY_BITS.load(Ordering::SeqCst)),
            0.0,
            "PluginNoteOff: velocity 省略時は NoteOff 自身の既定 0.0 に解決されること"
        );
        assert_eq!(resp_off["result"]["status"], "note_off");
    }

    // #402 pr-test-analyzer: handle_plugin_note の spawn_blocking join-error 分岐
    // (`Err(join_err) => ProtocolError::new("INTERNAL_ERROR", ...)`) は、このPR以前は
    // PluginNoteOn/Off が同期実行だったため存在しなかった失敗経路。call fn 内 panic → JoinError →
    // INTERNAL_ERROR mapping を pin する。
    #[tokio::test]
    async fn handle_plugin_note_maps_spawn_blocking_join_error_to_internal_error() {
        fn panicking_call(
            _engine: &EngineWrap,
            _key: u8,
            _channel: u8,
            _velocity: f64,
            _instance: Option<String>,
        ) -> Result<(), WrapError> {
            panic!("orbit-audio-daemon test: simulated panic inside spawn_blocking call fn");
        }

        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let params = json!({"key": 60});

        let resp =
            handle_plugin_note("id-panic", &params, &engine, 0.8, "note_on", panicking_call).await;

        assert_eq!(resp["error"]["code"], "INTERNAL_ERROR");
    }

    #[test]
    fn plugin_state_errors_keep_distinct_protocol_codes() {
        let cases = [
            (
                WrapError::PluginStateTarget("target".into()),
                "PLUGIN_STATE_TARGET_ERROR",
            ),
            (
                WrapError::PluginStateNotReady("not ready".into()),
                "PLUGIN_STATE_NOT_READY",
            ),
            (
                WrapError::PluginStateTimeout("timeout".into()),
                "PLUGIN_STATE_TIMEOUT",
            ),
            (
                WrapError::PluginStateUnsupported("unsupported".into()),
                "PLUGIN_STATE_UNSUPPORTED",
            ),
            (
                WrapError::PluginStateChildExited("child exited".into()),
                "PLUGIN_STATE_CHILD_EXITED",
            ),
            (
                WrapError::PluginStateProtocol("protocol".into()),
                "PLUGIN_STATE_PROTOCOL_ERROR",
            ),
            (
                WrapError::PluginStateIo("io".into()),
                "PLUGIN_STATE_IO_ERROR",
            ),
            (
                WrapError::PluginUiUnavailable("unavailable".into()),
                "PLUGIN_UI_UNAVAILABLE",
            ),
            (
                WrapError::PluginUiTarget("target".into()),
                "PLUGIN_UI_TARGET_ERROR",
            ),
            (
                WrapError::PluginUiProtocol("protocol".into()),
                "PLUGIN_UI_PROTOCOL_ERROR",
            ),
            (
                WrapError::PluginUiCommand("command".into()),
                "PLUGIN_UI_COMMAND_ERROR",
            ),
        ];

        for (error, expected_code) in cases {
            assert_eq!(wrap_err_to_protocol(&error).code, expected_code);
        }
    }

    #[cfg(feature = "outproc-effect")]
    #[tokio::test]
    async fn ack_ui_safepoint_command_does_not_require_an_index() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        let response = handle_command(
            Command {
                id: "ack-without-index".into(),
                method: "AckUiSafepoint".into(),
                params: json!({
                    "target": {"role": "effect", "bus": "lead"},
                    "window": 1,
                    "generation": 0,
                    "evt_seq": 1
                }),
            },
            &engine,
            &tx,
        )
        .await;

        assert_eq!(response["error"]["code"], "PLUGIN_UI_UNAVAILABLE");
    }
}
