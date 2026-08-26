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
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::warn;

#[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
use crate::engine_wrap::ClapPluginRole;
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
use crate::engine_wrap::PluginStateTarget;
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

/// Wire-level plugin destination shared by GetPluginState/UI requests and RenderScore chains.
/// Feature availability is intentionally checked only when converting this vocabulary to the
/// live engine's PluginStateTarget; manifest validation must remain available in every build.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PluginTargetVocabulary {
    Effect { bus: Option<String> },
    Instrument { instance: String },
}

fn parse_plugin_target_vocabulary(
    params: &Value,
    method: &str,
) -> Result<PluginTargetVocabulary, ProtocolError> {
    match params.get("role").and_then(Value::as_str) {
        Some("effect") => {
            if params.get("instance").is_some() {
                return Err(ProtocolError::new(
                    "MALFORMED_REQUEST",
                    format!("{method} instance is only valid for role='instrument'"),
                ));
            }
            let bus = parse_bus_param(params)
                .map_err(|message| ProtocolError::new("MALFORMED_REQUEST", message))?;
            Ok(PluginTargetVocabulary::Effect { bus })
        }
        Some("instrument") => {
            if params.get("bus").is_some() {
                return Err(ProtocolError::new(
                    "MALFORMED_REQUEST",
                    format!("{method} bus is only valid for role='effect'"),
                ));
            }
            let instance = parse_optional_nonempty_string_param(params, "instance")
                .map_err(|message| ProtocolError::new("MALFORMED_REQUEST", message))?
                .ok_or_else(|| {
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        format!("{method} role='instrument' requires 'instance'"),
                    )
                })?;
            Ok(PluginTargetVocabulary::Instrument { instance })
        }
        _ => Err(ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} requires role='effect' or role='instrument'"),
        )),
    }
}

/// `SetBusRouting` params から `(seq_bus, output, sends)` を取り出す純関数（#459/#453 M2）。
/// - `seq_bus`: 必須の非空文字列。
/// - `output`: 省略/`null` = `None`（output target には触れない）。非空文字列以外は拒否。
/// - `sends`: 省略/`null` = 空配列。`[{bus: string, gain: number}]` の配列以外・要素の型不正は拒否。
#[cfg(feature = "outproc-effect")]
#[allow(clippy::type_complexity)]
fn parse_set_bus_routing_params(
    params: &Value,
) -> Result<(String, Option<String>, Vec<(String, f32)>), &'static str> {
    let seq_bus = match params.get("seq_bus") {
        Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
        _ => return Err("'seq_bus' must be a non-empty string"),
    };
    let output = match params.get("output") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => return Err("'output' must be a non-empty string or null"),
    };
    let sends = match params.get("sends") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let bus = match item.get("bus") {
                    Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
                    _ => return Err("'sends[].bus' must be a non-empty string"),
                };
                let gain = match item.get("gain").and_then(Value::as_f64) {
                    Some(g) => g as f32,
                    None => return Err("'sends[].gain' must be a number"),
                };
                out.push((bus, gain));
            }
            out
        }
        _ => return Err("'sends' must be an array"),
    };
    Ok((seq_bus, output, sends))
}

/// PlayAt の `bus`（per-sequence insert routing・PH.2b・#434 S3）と `channel`（LinkAudio
/// routing・#209）の同時指定を検出する純関数。両者は core 上は同じ routing tag フィールド
/// （`ScheduledSample.channel`）を共有するため、同時指定は意味が一意に決まらず拒否する。
#[cfg(feature = "outproc-effect")]
fn playat_bus_and_channel_both_set(bus: &Option<String>, channel: &Option<String>) -> bool {
    bus.is_some() && channel.is_some()
}

/// role='instrument' と 'bus' の同時指定を検出する純関数（'bus' は effect 専用）。
fn bus_param_invalid_for_instrument_role(params: &Value) -> bool {
    params.get("role").and_then(Value::as_str) == Some("instrument") && params.get("bus").is_some()
}

/// 任意・非空文字列 param の共通パーサ（`instance` #540 P1 / `state_path` #540 P2）。
/// 欠如は `Ok(None)`（互換: 単数時代の "default" 扱い）。空文字列・非文字列は `Err`
/// （`parse_bus_param` と同じ「黙って壊さない」方針）。
fn parse_optional_nonempty_string_param(
    params: &Value,
    field: &'static str,
) -> Result<Option<String>, String> {
    match params.get(field) {
        None => Ok(None),
        // trim 判定は `parse_bus_param` と対称（空白のみの値を「非空」として通さない）。
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(format!("'{field}' must be a non-empty string")),
        Some(_) => Err(format!("'{field}' must be a string")),
    }
}

/// role='instrument' 専用 param（現在は `instance`）が他 role の宣言に紛れ込んだかの
/// 判定（`bus` が role='effect' 専用なのと対称）。黙って無視せず MALFORMED で弾くために使う。
#[cfg(feature = "outproc-instrument")]
fn instrument_only_param_misused(params: &Value, field: &str) -> bool {
    params.get("role").and_then(Value::as_str) != Some("instrument") && params.get(field).is_some()
}

/// GetPluginState and all three UI requests share this single role/bus/instance resolver.
/// UI requests place the vocabulary under `target`; GetPluginState's established wire shape is
/// top-level, so callers pass the relevant object rather than duplicating the role match.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn parse_plugin_target(
    params: &Value,
    method: &str,
    _unavailable_code: &'static str,
) -> Result<PluginStateTarget, ProtocolError> {
    match parse_plugin_target_vocabulary(params, method)? {
        PluginTargetVocabulary::Effect { bus: _bus } => {
            #[cfg(not(feature = "outproc-effect"))]
            return Err(ProtocolError::new(
                _unavailable_code,
                format!("{method} role='effect' requires outproc-effect"),
            ));
            #[cfg(feature = "outproc-effect")]
            {
                Ok(PluginStateTarget::Effect { bus: _bus })
            }
        }
        PluginTargetVocabulary::Instrument {
            instance: _instance,
        } => {
            #[cfg(not(feature = "outproc-instrument"))]
            return Err(ProtocolError::new(
                _unavailable_code,
                format!("{method} role='instrument' requires outproc-instrument"),
            ));
            #[cfg(feature = "outproc-instrument")]
            {
                Ok(PluginStateTarget::Instrument {
                    instance: _instance,
                })
            }
        }
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn ui_target_object<'a>(params: &'a Value, method: &str) -> Result<&'a Value, ProtocolError> {
    params.get("target").ok_or_else(|| {
        ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} requires a 'target' object"),
        )
    })
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn ui_index(params: &Value, method: &str) -> Result<u64, ProtocolError> {
    params.get("index").and_then(Value::as_u64).ok_or_else(|| {
        ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} requires a non-negative integer 'index'"),
        )
    })
}

#[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
fn plugin_ui_unavailable(id: &str, method: &str) -> Value {
    err(
        id,
        ProtocolError::new(
            "PLUGIN_UI_UNAVAILABLE",
            format!("{method} requires outproc-effect or outproc-instrument"),
        ),
    )
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn resolve_ui_target_and_index(
    params: &Value,
    method: &str,
) -> Result<(PluginStateTarget, u64), ProtocolError> {
    let target = resolve_ui_target(params, method)?;
    let index = ui_index(params, method)?;
    Ok((target, index))
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
fn resolve_ui_target(params: &Value, method: &str) -> Result<PluginStateTarget, ProtocolError> {
    let target_params = ui_target_object(params, method)?;
    parse_plugin_target(target_params, method, "PLUGIN_UI_UNAVAILABLE")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScoreSample {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScorePlugin {
    plugin: String,
    plugin_id: Option<String>,
    target: Value,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScoreBus {
    name: String,
    chain: Vec<RenderScorePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScoreMaster {
    chain: Vec<RenderScorePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScoreEvent {
    start_sec: f64,
    sample: String,
    gain: f64,
    pan: f64,
    offset_sec: f64,
    duration_sec: f64,
    rate: f64,
    bus: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderScoreManifest {
    sample_rate: u32,
    duration_sec: f64,
    block_frames: u32,
    samples: Vec<RenderScoreSample>,
    buses: Vec<RenderScoreBus>,
    master: Option<RenderScoreMaster>,
    events: Vec<RenderScoreEvent>,
    out_dir: String,
}

fn render_score_error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("MALFORMED_REQUEST", message)
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

/// 宣言名の一意性を検査して登録する。samples / buses が同じ規約を共有する
/// （3つ目の宣言種別が増えても同じ形を複製しない）。
fn insert_unique<'a>(
    seen: &mut std::collections::HashSet<&'a str>,
    name: &'a str,
    location: &str,
) -> Result<(), ProtocolError> {
    if !seen.insert(name) {
        return Err(render_score_error(format!(
            "{location}.name duplicates '{name}'"
        )));
    }
    Ok(())
}

fn canonical_render_bus(value: &str) -> bool {
    value
        .parse::<u8>()
        .ok()
        .filter(|number| (1..=16).contains(number))
        .is_some_and(|number| value == number.to_string())
}

fn validate_render_plugin(
    plugin: &RenderScorePlugin,
    containing_bus: Option<&str>,
    location: &str,
) -> Result<(), ProtocolError> {
    if !nonempty(&plugin.plugin) || !std::path::Path::new(&plugin.plugin).is_absolute() {
        return Err(render_score_error(format!(
            "{location}.plugin must be a non-empty absolute path"
        )));
    }
    if plugin.plugin_id.as_deref().is_some_and(|id| !nonempty(id)) {
        return Err(render_score_error(format!(
            "{location}.plugin_id must be a non-empty string"
        )));
    }
    if let Some(state) = &plugin.state {
        if !nonempty(state) || !std::path::Path::new(state).is_absolute() {
            return Err(render_score_error(format!(
                "{location}.state must be a non-empty absolute path"
            )));
        }
    }

    // This is the same parser used by GetPluginState and UI requests: role/bus/instance is one
    // protocol vocabulary, not a RenderScore-only copy.
    match parse_plugin_target_vocabulary(&plugin.target, "RenderScore")? {
        PluginTargetVocabulary::Effect { bus } => match containing_bus {
            Some(containing) => {
                if bus.as_deref().is_some_and(|target| target != containing) {
                    return Err(render_score_error(format!(
                        "{location}.target.bus must match containing bus '{containing}'"
                    )));
                }
            }
            None if bus.is_some() => {
                return Err(render_score_error(format!(
                    "{location}.target.bus is not valid for the master chain"
                )));
            }
            None => {}
        },
        PluginTargetVocabulary::Instrument { .. } => {
            return Err(render_score_error(format!(
                "{location}.target.role must be 'effect' in a P1 render chain"
            )));
        }
    }
    Ok(())
}

fn validate_render_score_params(params: &Value) -> Result<RenderScoreManifest, ProtocolError> {
    // 🔴 このループを「serde と重複」として消してはいけない（#612 監査）。
    //
    // 8 個中 7 個は `RenderScoreManifest` の非 `Option` フィールドなので、欠落すれば下の
    // `deserialize` が `missing field ...` で弾く（このループはその 7 個については
    // 「位置つきの読みやすい文言を出す」ためのもの）。**しかし `master` だけは
    // `Option<RenderScoreMaster>` であり、serde は欠落を黙って `None` に既定化する。**
    // したがって `master` の必須性は **ここでしか守られていない**。消すと TS 側
    // （`render-score.ts` は 8 個すべてを required 扱い）と乖離し、master 欠落の manifest を
    // daemon だけが受理するようになる。
    const REQUIRED: [&str; 8] = [
        "sample_rate",
        "duration_sec",
        "block_frames",
        "samples",
        "buses",
        "master",
        "events",
        "out_dir",
    ];
    let object = params
        .as_object()
        .ok_or_else(|| render_score_error("RenderScore params must be an object"))?;
    for field in REQUIRED {
        if !object.contains_key(field) {
            return Err(render_score_error(format!(
                "RenderScore.{field} is required"
            )));
        }
    }
    // `&Value` から直接デシリアライズする（`from_value` は所有権を要求するため manifest 全体の
    // deep clone が必要になる — samples / buses / chain / events は数千要素になりうる）。
    let manifest = RenderScoreManifest::deserialize(params)
        .map_err(|error| render_score_error(format!("invalid RenderScore manifest: {error}")))?;

    if manifest.sample_rate == 0 {
        return Err(render_score_error(
            "RenderScore.sample_rate must be a positive integer",
        ));
    }
    if manifest.block_frames == 0 {
        return Err(render_score_error(
            "RenderScore.block_frames must be a positive integer",
        ));
    }
    if !manifest.duration_sec.is_finite() || manifest.duration_sec <= 0.0 {
        return Err(render_score_error(
            "RenderScore.duration_sec must be a positive finite number",
        ));
    }
    if !nonempty(&manifest.out_dir) {
        return Err(render_score_error(
            "RenderScore.out_dir must be a non-empty string",
        ));
    }

    let mut sample_names = std::collections::HashSet::new();
    for (index, sample) in manifest.samples.iter().enumerate() {
        if !nonempty(&sample.name) || !nonempty(&sample.path) {
            return Err(render_score_error(format!(
                "RenderScore.samples[{index}] name/path must be non-empty"
            )));
        }
        insert_unique(
            &mut sample_names,
            &sample.name,
            &format!("RenderScore.samples[{index}]"),
        )?;
    }

    let mut bus_names = std::collections::HashSet::new();
    for (bus_index, bus) in manifest.buses.iter().enumerate() {
        if !canonical_render_bus(&bus.name) {
            return Err(render_score_error(format!(
                "RenderScore.buses[{bus_index}].name must be canonical '1'..'16'"
            )));
        }
        insert_unique(
            &mut bus_names,
            &bus.name,
            &format!("RenderScore.buses[{bus_index}]"),
        )?;
        for (plugin_index, plugin) in bus.chain.iter().enumerate() {
            validate_render_plugin(
                plugin,
                Some(&bus.name),
                &format!("RenderScore.buses[{bus_index}].chain[{plugin_index}]"),
            )?;
        }
    }

    if let Some(master) = &manifest.master {
        for (index, plugin) in master.chain.iter().enumerate() {
            validate_render_plugin(plugin, None, &format!("RenderScore.master.chain[{index}]"))?;
        }
    }

    for (index, event) in manifest.events.iter().enumerate() {
        let location = format!("RenderScore.events[{index}]");
        if !event.start_sec.is_finite()
            || event.start_sec < 0.0
            || event.start_sec >= manifest.duration_sec
        {
            return Err(render_score_error(format!(
                "{location}.start_sec must be within [0, duration_sec)"
            )));
        }
        if !sample_names.contains(event.sample.as_str()) {
            return Err(render_score_error(format!(
                "{location}.sample references undeclared sample '{}'",
                event.sample
            )));
        }
        if !canonical_render_bus(&event.bus) || !bus_names.contains(event.bus.as_str()) {
            return Err(render_score_error(format!(
                "{location}.bus references undeclared render bus '{}'",
                event.bus
            )));
        }
        if !event.gain.is_finite() || !event.pan.is_finite() {
            return Err(render_score_error(format!(
                "{location}.gain/pan must be finite"
            )));
        }
        if !event.offset_sec.is_finite() || event.offset_sec < 0.0 {
            return Err(render_score_error(format!(
                "{location}.offset_sec must be non-negative and finite"
            )));
        }
        if !event.duration_sec.is_finite() || event.duration_sec < 0.0 {
            return Err(render_score_error(format!(
                "{location}.duration_sec must be non-negative and finite"
            )));
        }
        if !event.rate.is_finite() || event.rate <= 0.0 {
            return Err(render_score_error(format!(
                "{location}.rate must be positive and finite"
            )));
        }
    }

    Ok(manifest)
}

/// Err を `Box` に包むのは `clippy::result_large_err` 対応（CI の stable clippy 1.98 で発火）。
/// `tungstenite::Error` は外部 crate の型で 136 バイトあり、こちらでは小さくできない。
/// error 経路は cold path なので 1 回のアロケーションは実質無償。
pub async fn run(
    ws: WebSocketStream<TcpStream>,
    engine: Arc<EngineWrap>,
) -> Result<(), Box<tokio_tungstenite::tungstenite::Error>> {
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

    // Watchdog threads publish into one daemon-internal tokio broadcast. This subscriber only
    // adapts it to the session's existing WS writer queue; no child IPC or engine connection is
    // added. Lag is loud because these close/safepoint frames are loss-sensitive.
    let ui_event_task = {
        let tx = tx.clone();
        let events = engine.subscribe_plugin_ui_events();
        tokio::spawn(forward_plugin_ui_events(events, tx))
    };

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
            let mut last_link_drops: u64 = 0;
            let mut last_clap_errors: u64 = 0;
            let mut last_outproc_errors: u64 = 0;
            let mut last_outproc_respawns: u64 = 0;
            let mut last_outproc_frames_clamped: u64 = 0;
            // per-bus effect health の watermark（#461 review Critical: bus child の異常が
            // ticker に出ない穴）。key = bus 名。
            let mut last_bus_errors: std::collections::HashMap<String, u64> =
                std::collections::HashMap::new();
            let mut last_bus_respawns: std::collections::HashMap<String, u64> =
                std::collections::HashMap::new();
            let mut bus_invalid_reported: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut last_bus_frames_clamped: std::collections::HashMap<String, u64> =
                std::collections::HashMap::new();
            let mut last_unroutable_events: u64 = 0;
            let mut last_outproc_instrument_output_dropped: u64 = 0;
            let mut last_outproc_instrument_errors: u64 = 0;
            let mut last_outproc_instrument_respawns: u64 = 0;
            let mut last_outproc_instrument_decode_errors: u64 = 0;
            let mut last_engine_lock_contention: u64 = 0;
            let mut last_plugin_event_ring_overflow: u64 = 0;
            let mut outproc_invalid_reported = false;
            let mut outproc_instrument_invalid_reported = false;
            let mut device_lost_reported = false;
            let mut engine_lock_poisoned_reported = false;
            loop {
                ticker.tick().await;
                let snapshot = engine.stream_stats_snapshot();
                let now_sec = engine.transport_or_uptime_sec();

                // fatal を warning より先に送り、client が最終イベントとして確実に観測できる順序にする。
                if snapshot.device_lost && !device_lost_reported {
                    let fatal_evt = daemon_error_event(
                        ERROR_SEVERITY_FATAL,
                        ERROR_CODE_DEVICE_LOST,
                        "audio device disappeared".to_string(),
                    );
                    if tx.send(to_json_or_fallback(&fatal_evt)).await.is_err() {
                        break;
                    }
                    device_lost_reported = true;
                }

                // Engine 内部 Mutex が RT 競合で poisoned と判定された（#401）。`device_lost` と同じ
                // 恒久障害クラス（`clear_poison()` を呼ぶ箇所が無く同一プロセス生存中は回復しない —
                // render は恒久 zero-fill、schedule/stop 等の制御系 API も以降ずっとエラーを返す）
                // なので FATAL・fire-once。"self-heals" と言い切る `ENGINE_LOCK_CONTENTION` の
                // WARNING メッセージとは異なり、poisoned は自己修復しないことを明示する。
                if engine.engine_lock_poisoned() && !engine_lock_poisoned_reported {
                    let fatal_evt = daemon_error_event(
                        ERROR_SEVERITY_FATAL,
                        ERROR_CODE_ENGINE_LOCK_POISONED,
                        "engine scheduler mutex poisoned by a panicking thread; audio output is \
                         permanently down until daemon restart"
                            .to_string(),
                    );
                    if tx.send(to_json_or_fallback(&fatal_evt)).await.is_err() {
                        break;
                    }
                    engine_lock_poisoned_reported = true;
                }

                if snapshot.xruns > last_xruns {
                    let warn_evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_STREAM_XRUN,
                        format!(
                            "buffer underrun or stream error occurred ({} total)",
                            snapshot.xruns
                        ),
                    );
                    if tx.send(to_json_or_fallback(&warn_evt)).await.is_err() {
                        break;
                    }
                    last_xruns = snapshot.xruns;
                }

                // LinkAudio egress の ring overflow drop（音が落ちた）を非 RT で surface（A4-2b-2b）。
                // RT callback が drop を atomic counter に積み、consumer を含め hot path は log しない
                // ので、ここで増加を検知して WARNING event を出す（feature 無効時 / drop なしは 0 のまま
                // 発火しない）。
                let link_drops = engine.link_egress_ring_drops();
                if link_drops > last_link_drops {
                    let drop_evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_LINK_EGRESS_DROP,
                        format!(
                            "LinkAudio egress dropped samples ({link_drops} total interleaved); \
                             consumer fell behind — audio gaps on Link",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&drop_evt)).await.is_err() {
                        break;
                    }
                    last_link_drops = link_drops;
                }

                // ロード済み CLAP plugin の process() エラー（#340）を非 RT で surface。RT callback が
                // 失敗時に出力配線をスキップ（effect=dry 素通し / instrument=無音）して atomic counter に
                // 積むので、ここで増加を検知して WARNING を出す（clap 無効 / エラーなしは 0 のまま発火しない）。
                let clap_errors = engine.clap_process_error_count();
                if clap_errors > last_clap_errors {
                    let clap_evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_CLAP_PROCESS_ERROR,
                        format!(
                            "CLAP plugin process() failed ({clap_errors} total); output skipped \
                             — effect passes dry, instrument is silent",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&clap_evt)).await.is_err() {
                        break;
                    }
                    last_clap_errors = clap_errors;
                }

                // Engine 内部 Mutex の RT 競合（try_lock が WouldBlock → silent zero-fill）を非 RT で
                // surface（#401）。lock-free 化は別 Issue で defer 済みの既存判断のまま、発生の
                // 可視化のみ追加。WouldBlock は自己修復する障害（次のブロックで復帰）だが 32/64f
                // 小バッファ性能ゴール下ではライブコマンド頻度に比例して発生確率が上がる。
                // 恒久障害（Poisoned）はこのカウンタに含めない — 上の ENGINE_LOCK_POISONED FATAL 参照。
                let engine_lock_contention = engine.engine_lock_contention_count();
                if engine_lock_contention > last_engine_lock_contention {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_ENGINE_LOCK_CONTENTION,
                        format!(
                            "engine lock contention ({engine_lock_contention} total); a block \
                             was silently zero-filled — this self-heals next block",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_engine_lock_contention = engine_lock_contention;
                }

                // in-process CLAP event ring への push が bounded retry の末に力尽きた（真の event
                // 喪失）を非 RT で surface（#400）。通常は 0 のまま推移する health signal。
                let plugin_event_overflow = engine.plugin_event_ring_overflow_count();
                if plugin_event_overflow > last_plugin_event_ring_overflow {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_PLUGIN_EVENT_RING_OVERFLOW,
                        format!(
                            "plugin event ring overflowed after bounded retry ({plugin_event_overflow} \
                             total); a NoteOn/NoteOff was lost",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_plugin_event_ring_overflow = plugin_event_overflow;
                }

                // out-of-process effect の health（γ M1 PR-C）を非 RT で surface。child の process() エラー
                // / crash→respawn / supervise 不能（計測無効）/ frames_clamped（#404）を 1 Hz ticker で
                // 検知して event を出す（CLAP 経路と同設計。outproc 無効 / 異常なしは (0,0,false,0) のまま
                // 発火しない）。4 signal を 1 回の try_lock + snapshot にまとめて読む（#406 /simplify:
                // 個別 accessor だと同一 mutex を同一 tick 内で複数回 lock し、かつ同一スナップショットを
                // 観測する保証がなくなる）。
                let (outproc_errors, outproc_respawns, outproc_invalid, outproc_frames_clamped) =
                    engine.outproc_health();
                if outproc_errors > last_outproc_errors {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_EFFECT_ERROR,
                        format!(
                            "out-of-process effect child process() failed ({outproc_errors} total); \
                             effect passes dry",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_errors = outproc_errors;
                }
                if outproc_respawns > last_outproc_respawns {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_EFFECT_RESPAWN,
                        format!(
                            "out-of-process effect child crashed and was respawned \
                             ({outproc_respawns} total); 3rd-party crash isolated",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_respawns = outproc_respawns;
                }
                // 計測無効は恒久状態なので fire-once（daemon は生存・effect 経路のみ frozen）。
                if outproc_invalid && !outproc_invalid_reported {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_EFFECT_INVALID,
                        "out-of-process effect supervisor gave up (respawn/try_wait failed); \
                         effect frozen at last block (repeat-previous) — restart daemon or fix plugin"
                            .to_string(),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    outproc_invalid_reported = true;
                }

                // OOP effect の block が MAX_FRAMES を超えて clamp された累積回数を非 RT で
                // surface（#404）。カウンタ自体は既存だったが ticker 未配線だったため追加。#406 で
                // outproc_health() に統合済み（上で destructure 済みの値をそのまま使う）。
                if outproc_frames_clamped > last_outproc_frames_clamped {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED,
                        format!(
                            "out-of-process effect block exceeded MAX_FRAMES and was clamped \
                             ({outproc_frames_clamped} total); tail of an oversized block was \
                             silenced",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_frames_clamped = outproc_frames_clamped;
                }

                // per-bus OOP effect（seq.effect() の insert bus・#434/#461）の health を master と
                // 同じ 4 signal で surface する。error code は master と共有し、message の bus 名で
                // 区別する（コード乱発を避ける）。
                for (bus, (errors, respawns, invalid, clamped)) in
                    engine.outproc_effect_bus_health()
                {
                    let last = last_bus_errors.entry(bus.clone()).or_insert(0);
                    if errors > *last {
                        let evt = daemon_error_event(
                            ERROR_SEVERITY_WARNING,
                            ERROR_CODE_OUTPROC_EFFECT_ERROR,
                            format!(
                                "out-of-process effect child process() failed on bus '{bus}' \
                                 ({errors} total); that sequence's insert passes dry",
                            ),
                        );
                        if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                            break;
                        }
                        *last = errors;
                    }
                    let last = last_bus_respawns.entry(bus.clone()).or_insert(0);
                    if respawns > *last {
                        let evt = daemon_error_event(
                            ERROR_SEVERITY_WARNING,
                            ERROR_CODE_OUTPROC_EFFECT_RESPAWN,
                            format!(
                                "out-of-process effect child crashed and was respawned on bus \
                                 '{bus}' ({respawns} total); 3rd-party crash isolated",
                            ),
                        );
                        if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                            break;
                        }
                        *last = respawns;
                    }
                    if invalid && !bus_invalid_reported.contains(&bus) {
                        let evt = daemon_error_event(
                            ERROR_SEVERITY_WARNING,
                            ERROR_CODE_OUTPROC_EFFECT_INVALID,
                            format!(
                                "out-of-process effect supervisor gave up on bus '{bus}' \
                                 (respawn/try_wait failed); that insert is frozen — restart \
                                 daemon or fix plugin",
                            ),
                        );
                        if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                            break;
                        }
                        bus_invalid_reported.insert(bus.clone());
                    }
                    let last = last_bus_frames_clamped.entry(bus).or_insert(0);
                    if clamped > *last {
                        let evt = daemon_error_event(
                            ERROR_SEVERITY_WARNING,
                            ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED,
                            format!(
                                "out-of-process effect block exceeded MAX_FRAMES and was \
                                 clamped on a seq bus ({clamped} total)",
                            ),
                        );
                        if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                            break;
                        }
                        *last = clamped;
                    }
                }

                // 未登録 named target（insert bus / LinkAudio channel）へ tag された event の
                // retain を surface する（#461 review: comment-only だった core のハザードに
                // 観測点を配線・frames_clamped の前例と同じ「既存 counter → ticker 追配線」）。
                let unroutable = engine.unroutable_event_count();
                if unroutable > last_unroutable_events {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_UNROUTABLE_EVENTS,
                        format!(
                            "{unroutable} scheduled event(s) are tagged to an unknown \
                             bus/channel and will never play (declared-before-tag order \
                             violated, or a name typo); they are retained until Stop",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_unroutable_events = unroutable;
                }

                // out-of-process instrument の全 health signal（child-process 系: respawn/計測無効/
                // child process() エラー + output-event overflow 系: dropped/spilled/note_end_dropped）
                // を非 RT で surface（#420 PR #422 round 3）。round 2 までは output-event overflow
                // のみ配線済みで、effect 側の OUTPROC_EFFECT_ERROR/_RESPAWN/_INVALID に相当する
                // instrument 側 signal が daemon health 経路に無く、instrument-only build で恒久
                // respawn 失敗が client に一切見えないまま audio が固まりうる欠落があった
                // （code-reviewer round 3 re-review 指摘）。6 signal を 1 回の
                // `outproc_instrument_health()` 呼び出し（1 try_lock + 1 snapshot）にまとめて読む
                // （advisor 指摘: 本来ここと下の output-event overflow ブロックを別 accessor で
                // 呼ぶと同一 tick 内で同じ `outproc_instrument` mutex を 2 回 try_lock してしまい、
                // #406 で effect 側が consolidate 済みの二重ロック anti-pattern を再導入することに
                // なる）。
                let (
                    outproc_instrument_errors,
                    outproc_instrument_respawns,
                    outproc_instrument_invalid,
                    outproc_instrument_dropped,
                    outproc_instrument_spilled,
                    outproc_instrument_note_end_dropped,
                    outproc_instrument_decode_errors,
                ) = engine.outproc_instrument_health();
                // input 方向の decode 失敗 / 未対応 NeutralEvent variant（該当イベントは無音で
                // 消える）。output overflow とは別枠の WARNING（#421 round 2 residual）。
                if outproc_instrument_decode_errors > last_outproc_instrument_decode_errors {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_INSTRUMENT_EVENT_DECODE,
                        format!(
                            "out-of-process instrument dropped undecodable/unsupported input \
                             events ({outproc_instrument_decode_errors} total); those events \
                             are silently lost to the plugin",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_instrument_decode_errors = outproc_instrument_decode_errors;
                }
                if outproc_instrument_errors > last_outproc_instrument_errors {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_INSTRUMENT_ERROR,
                        format!(
                            "out-of-process instrument child process() failed \
                             ({outproc_instrument_errors} total); instrument is silent",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_instrument_errors = outproc_instrument_errors;
                }
                if outproc_instrument_respawns > last_outproc_instrument_respawns {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_INSTRUMENT_RESPAWN,
                        format!(
                            "out-of-process instrument child crashed and was respawned \
                             ({outproc_instrument_respawns} total); 3rd-party crash isolated",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_instrument_respawns = outproc_instrument_respawns;
                }
                // 計測無効は恒久状態なので fire-once（daemon は生存・instrument 経路のみ frozen）。
                if outproc_instrument_invalid && !outproc_instrument_invalid_reported {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_INSTRUMENT_INVALID,
                        "out-of-process instrument supervisor gave up (respawn/try_wait failed); \
                         instrument frozen at last block (repeat-previous) — restart daemon or \
                         fix plugin"
                            .to_string(),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    outproc_instrument_invalid_reported = true;
                }

                // out-of-process instrument の出力方向（M2 §4.2）event overflow health（#420 PR #422
                // round 2 で追加済み — round 1 で追加済みの output-event overflow counter 群
                // (dropped/spilled/note_end_dropped) が watchdog にはミラーされていたが daemon health
                // 経路への配線が欠けており stuck-note class の regression が無音のまま埋もれていた・
                // silent-failure-hunter 指摘）。真の loss signal（dropped の増加）のみを WARNING
                // トリガにし、無損失な spilled と NoteEnd 喪失（stuck-note リスク）を示す
                // note_end_dropped は message の文脈情報として含める（spilled 単独の WARNING はノイズ
                // になるため見送り・advisor 判断）。値は上の `outproc_instrument_health()` 呼び出しで
                // 既に destructure 済み（round 3 で 1 accessor に統合・二重ロック回避）。
                if outproc_instrument_dropped > last_outproc_instrument_output_dropped {
                    let evt = daemon_error_event(
                        ERROR_SEVERITY_WARNING,
                        ERROR_CODE_OUTPROC_INSTRUMENT_OUTPUT_DROPPED,
                        format!(
                            "out-of-process instrument output event overflow: \
                             {outproc_instrument_dropped} dropped total \
                             ({outproc_instrument_note_end_dropped} were NoteEnd -- stuck-note \
                             risk), {outproc_instrument_spilled} spilled (no loss, 1-block delay)",
                        ),
                    );
                    if tx.send(to_json_or_fallback(&evt)).await.is_err() {
                        break;
                    }
                    last_outproc_instrument_output_dropped = outproc_instrument_dropped;
                }

                let stats_evt = Event::new(
                    EVENT_STREAM_STATS,
                    json!({
                        // cpu_load: audio callback の計測基盤が未整備のため 0.0 固定。
                        "cpu_load": 0.0,
                        "xruns": snapshot.xruns,
                        "buffer_underruns": snapshot.buffer_underruns,
                        // D2: RenderState try_lock 競合（デバイス切替中の zero-fill）の観測面。
                        // 定常時は 0 のはず — 増え続けるなら切替以外の contention を疑う。
                        "render_contentions": snapshot.render_contentions,
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
    ui_event_task.abort();
    match ui_event_task.await {
        Ok(()) => {}
        Err(e) if e.is_cancelled() => {}
        Err(e) => warn!("plugin UI event task terminated abnormally: {e}"),
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

/// SetLinkTempo の bpm 上限（sanity bound）。Ableton Link の実用上限近辺。musical な厳密ゲートではなく、
/// `f64::MAX` 等が `beat_per_frame` を `+Inf` に飛ばして beat 計算を壊すのを防ぐ防御的キャップ。
const MAX_LINK_BPM: f64 = 999.0;

/// SetLinkTempo の bpm を検証する（pure）。NaN / ±Inf / 非正値を弾き、`MAX_LINK_BPM` で上限を課す。
/// 下限は付けない（遅い tempo を弾かない）。
fn validate_bpm(bpm: f64) -> bool {
    bpm.is_finite() && bpm > 0.0 && bpm <= MAX_LINK_BPM
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

    // PluginNoteOn/PluginNoteOff dispatch は `plugin_note_spec` を single source of truth として
    // その外側でチェックする（method match の中に "PluginNoteOn" | "PluginNoteOff" literal を
    // 別途置くと、同じ文字列集合が2箇所で独立に保守されてしまい、どちらか一方だけ更新された場合に
    // 検出できない・#402 pr-review-team iteration 3 収束指摘: silent-failure-hunter/
    // pr-test-analyzer/code-reviewer）。`plugin_note_spec` が `None` を返す method はここを
    // 素通りして下の match に落ちる。
    if let Some(spec) = plugin_note_spec(&method) {
        return handle_plugin_note(
            &id,
            &params,
            engine,
            spec.default_velocity,
            spec.status,
            spec.call,
        )
        .await;
    }

    match method.as_str() {
        "Ping" => ok(&id, Value::String("pong".to_string())),
        // cpal の output device 列挙（#484 D1）。host 列挙は環境によっては軽くブロックしうるため
        // LoadSample と同様 spawn_blocking で tokio ワーカーを塞がない。`direction` は将来の入力
        // デバイス列挙（v1 スコープ外）向けの予約フィールドで、v1 は "output" 固定。
        "ListAudioDevices" => {
            let listed = tokio::task::spawn_blocking(orbit_audio_native::list_output_devices).await;
            match listed {
                Ok(Ok(devices)) => {
                    let devices: Vec<Value> = devices
                        .into_iter()
                        .map(|d| {
                            json!({
                                "name": d.name,
                                "isDefault": d.is_default,
                                "maxOutputChannels": d.max_output_channels,
                                "defaultSampleRate": d.default_sample_rate,
                                "direction": d.direction,
                            })
                        })
                        .collect();
                    ok(&id, json!({ "devices": devices }))
                }
                Ok(Err(e)) => err(&id, ProtocolError::new("DEVICE_ENUM_ERROR", e.to_string())),
                Err(join_err) => err(
                    &id,
                    ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                ),
            }
        }
        // ランタイムのオーディオデバイス切替（#484 D2）。`device` 省略 / 空文字列 = システム既定へ
        // 縮退（`ListAudioDevices` と同じ wire 規約）。cpal I/O を伴うため `ListAudioDevices` と同様
        // spawn_blocking で隔離する（実処理は audio owner thread へさらに委譲される・
        // `EngineWrap::select_audio_device` 参照）。
        "SelectAudioDevice" => {
            let device = params
                .get("device")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            let engine = engine.clone();
            let switched =
                tokio::task::spawn_blocking(move || engine.select_audio_device(device)).await;
            match switched {
                Ok(Ok(device)) => ok(&id, json!({ "ok": true, "device": device })),
                Ok(Err(e)) => err(&id, wrap_err_to_protocol(&e)),
                Err(join_err) => err(
                    &id,
                    ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                ),
            }
        }
        "GetStatus" => {
            let status = json!({
                "daemon_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": crate::protocol::PROTOCOL_VERSION,
                "output_sample_rate": engine.output_sample_rate(),
                "output_channels": engine.output_channels(),
                "loaded_samples": engine.loaded_sample_count(),
                "active_plays": engine.active_play_count(),
                "uptime_sec": engine.uptime_sec(),
                "render_contentions": engine.stream_stats_snapshot().render_contentions,
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
        // LinkAudio outputChannel を登録する（A4-2b-2・#209）。feature `link-audio` 無効ビルドでは
        // engine 側 stub が LINK_AUDIO_UNAVAILABLE を返す（command 自体は feature 非依存に保つ）。
        "RegisterLinkAudioChannel" => match params.get("channel").and_then(|p| p.as_str()) {
            Some(name) if !name.is_empty() => match engine.register_link_audio_channel(name) {
                Ok(()) => ok(&id, json!({"status": "registered", "channel": name})),
                Err(e) => err(&id, wrap_err_to_protocol(&e)),
            },
            _ => err(
                &id,
                ProtocolError::new("MALFORMED_REQUEST", "missing or empty 'channel' param"),
            ),
        },
        // LinkAudio tempo leader: global.tempo() を Link セッションに push する（PR3・#333）。
        // set_link_tempo は内部で captureAppSessionState（非RT・block しうる）を呼ぶので、LoadSample と
        // 同様 spawn_blocking で tokio ワーカーを塞がない（set_tempo=app-state path は audio スレッド以外で
        // 実行する Link 制約も満たす）。feature 無効ビルドは engine stub が LINK_AUDIO_UNAVAILABLE を返し
        // TS は warn-once で握り潰す。
        "SetLinkTempo" => match params.get("bpm").and_then(|p| p.as_f64()) {
            Some(bpm) if validate_bpm(bpm) => {
                let engine = engine.clone();
                let res = tokio::task::spawn_blocking(move || engine.set_link_tempo(bpm)).await;
                match res {
                    Ok(Ok(())) => ok(&id, json!({"status": "tempo_set", "bpm": bpm})),
                    Ok(Err(e)) => err(&id, wrap_err_to_protocol(&e)),
                    Err(join_err) => err(
                        &id,
                        ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                    ),
                }
            }
            _ => err(
                &id,
                ProtocolError::new(
                    "MALFORMED_REQUEST",
                    "missing or out-of-range 'bpm' param (0 < bpm <= 999)",
                ),
            ),
        },
        // CLAP プラグインをロードして hot-install する。in-process `clap-host` は既存 load path、
        // OOP feature は role を検証して post-boot child attach path へ分岐する。どちらも dlopen を
        // 含みうるため spawn_blocking で tokio worker から隔離する。
        "LoadPlugin" => match params.get("path").and_then(|p| p.as_str()) {
            Some(path_str) => {
                #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
                let clap_role = match clap_role_param(&params) {
                    Some(role) => role,
                    None => {
                        return err(
                            &id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "in-process LoadPlugin requires role='effect' or role='instrument'",
                            ),
                        );
                    }
                };
                #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
                if !outproc_role_param_is_valid(&params) {
                    return err(
                        &id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc-effect LoadPlugin requires role='effect'",
                        ),
                    );
                }
                #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
                if !outproc_role_param_is_valid(&params) {
                    return err(
                        &id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc-instrument LoadPlugin requires role='instrument'",
                        ),
                    );
                }
                #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
                if !outproc_role_param_is_valid(&params) {
                    return err(
                        &id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc LoadPlugin requires role='effect' or role='instrument'",
                        ),
                    );
                }

                let engine = engine.clone();
                let path = std::path::PathBuf::from(path_str);
                let plugin_id = params
                    .get("plugin_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                #[cfg(feature = "outproc-effect")]
                let bus = match parse_bus_param(&params) {
                    Ok(bus) => bus,
                    Err(message) => {
                        return err(&id, ProtocolError::new("MALFORMED_REQUEST", message))
                    }
                };
                #[cfg(feature = "outproc-instrument")]
                if bus_param_invalid_for_instrument_role(&params) {
                    return err(
                        &id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "LoadPlugin bus is only valid for role='effect'",
                        ),
                    );
                }
                // #540 P1: `instance`（role='instrument' 専用・`bus` と対称）。
                #[cfg(feature = "outproc-instrument")]
                if instrument_only_param_misused(&params, "instance") {
                    return err(
                        &id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "LoadPlugin instance is only valid for role='instrument'",
                        ),
                    );
                }
                #[cfg(feature = "outproc-instrument")]
                let instance = match parse_optional_nonempty_string_param(&params, "instance") {
                    Ok(instance) => instance,
                    Err(message) => {
                        return err(&id, ProtocolError::new("MALFORMED_REQUEST", message))
                    }
                };
                // #562: VST3/CLAP × instrument/effect の全 role で同じ state_path 復元を使う。
                #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
                let state_path = match parse_optional_nonempty_string_param(&params, "state_path") {
                    Ok(state_path) => state_path.map(std::path::PathBuf::from),
                    Err(message) => {
                        return err(&id, ProtocolError::new("MALFORMED_REQUEST", message))
                    }
                };
                // instrument-only build（テスト用構成）は単数互換経路しか持たない。ビルド構成
                // パリティ方針（#542 レビュー）: 尊重できない param を検証後に黙って捨てて
                // `ok` を返さない — この構成が扱えない要求は明示エラーで断る（TS 層は常に
                // instance を送るため、silent 縮退は「2台目が黙って1台に合流」として現れる）。
                #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
                if instance.is_some() || state_path.is_some() {
                    return err(
                        &id,
                        ProtocolError::new(
                            "OUTPROC_INSTRUMENT_UNAVAILABLE",
                            "this daemon build (outproc-instrument only) supports a single \
                             instrument instance and no state restore; rebuild with \
                             --features outproc-effect,outproc-instrument for per-sequence \
                             instances (LoadPlugin instance/state_path)",
                        ),
                    );
                }
                #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
                let params_role = params
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let res = tokio::task::spawn_blocking(move || {
                    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
                    {
                        #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
                        {
                            match params_role.as_deref() {
                                Some("effect") => engine.load_outproc_effect_plugin_with_state(
                                    path, plugin_id, bus, state_path,
                                ),
                                Some("instrument") => engine.load_outproc_instrument_plugin(
                                    path, plugin_id, instance, state_path,
                                ),
                                _ => unreachable!("role was validated before spawn_blocking"),
                            }
                        }
                        #[cfg(not(all(
                            feature = "outproc-effect",
                            feature = "outproc-instrument"
                        )))]
                        #[cfg(feature = "outproc-effect")]
                        {
                            engine.load_outproc_effect_plugin_with_state(
                                path, plugin_id, bus, state_path,
                            )
                        }
                        #[cfg(all(
                            feature = "outproc-instrument",
                            not(feature = "outproc-effect")
                        ))]
                        {
                            engine.load_outproc_plugin(path, plugin_id)
                        }
                    }
                    #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
                    {
                        engine.load_plugin(path, plugin_id, clap_role)
                    }
                })
                .await;
                match res {
                    Ok(Ok(info)) => ok(
                        &id,
                        json!({
                            "plugin_id": info.plugin_id,
                            "plugin_name": info.plugin_name,
                            "note_port_index": info.note_port_index,
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
        // #618: LoadPlugin の Active-reject semantics を変えず、instrument 専用の ensure
        // command として差し替えを明示する。PR-1 では TS caller はまだ存在しない。
        "ReplacePlugin" => {
            if params.get("role").and_then(Value::as_str) != Some("instrument") {
                return err(
                    &id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ReplacePlugin requires role='instrument'",
                    ),
                );
            }
            let Some(path_str) = params.get("path").and_then(Value::as_str) else {
                return err(
                    &id,
                    ProtocolError::new("MALFORMED_REQUEST", "missing 'path' param"),
                );
            };
            if bus_param_invalid_for_instrument_role(&params) {
                return err(
                    &id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ReplacePlugin bus is invalid for role='instrument'",
                    ),
                );
            }
            let instance = match parse_optional_nonempty_string_param(&params, "instance") {
                Ok(instance) => instance,
                Err(message) => return err(&id, ProtocolError::new("MALFORMED_REQUEST", message)),
            };
            let state_path = match parse_optional_nonempty_string_param(&params, "state_path") {
                Ok(state_path) => state_path.map(std::path::PathBuf::from),
                Err(message) => return err(&id, ProtocolError::new("MALFORMED_REQUEST", message)),
            };
            let plugin_id = params
                .get("plugin_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let path = std::path::PathBuf::from(path_str);

            #[cfg(feature = "outproc-instrument")]
            {
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.replace_outproc_instrument_plugin(path, plugin_id, instance, state_path)
                })
                .await
                {
                    Ok(Ok(info)) => ok(
                        &id,
                        json!({
                            "plugin_id": info.plugin_id,
                            "plugin_name": info.plugin_name,
                            "note_port_index": info.note_port_index,
                        }),
                    ),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(join_error) => err(
                        &id,
                        ProtocolError::new("INTERNAL_ERROR", join_error.to_string()),
                    ),
                }
            }
            #[cfg(not(feature = "outproc-instrument"))]
            {
                let _ = (engine, path, plugin_id, instance, state_path);
                err(
                    &id,
                    ProtocolError::new(
                        "OUTPROC_INSTRUMENT_UNAVAILABLE",
                        "ReplacePlugin requires an outproc-instrument daemon build",
                    ),
                )
            }
        }
        // #562: 実行中のOOP childから現在stateをsidecarへ保存する。上位層で解決済みの
        // role/bus/instanceを受け、停止判定・single mailbox・atomic renameはEngineWrapに集約する。
        "GetPluginState" => {
            #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
            {
                err(
                    &id,
                    ProtocolError::new(
                        "PLUGIN_STATE_UNAVAILABLE",
                        "GetPluginState requires outproc-effect or outproc-instrument",
                    ),
                )
            }
            #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
            {
                let final_path = match params
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                {
                    Some(path) => std::path::PathBuf::from(path),
                    None => {
                        return err(
                            &id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "GetPluginState requires a non-empty 'path'",
                            ),
                        )
                    }
                };
                let target = match parse_plugin_target(
                    &params,
                    "GetPluginState",
                    "PLUGIN_STATE_UNAVAILABLE",
                ) {
                    Ok(target) => target,
                    Err(error) => return err(&id, error),
                };
                let engine = engine.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    engine.save_outproc_plugin_state(target, final_path)
                })
                .await;
                match saved {
                    Ok(Ok(saved)) => ok(
                        &id,
                        json!({
                            "path": saved.path,
                            "bytes_written": saved.bytes_written,
                        }),
                    ),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(join_error) => err(
                        &id,
                        ProtocolError::new("INTERNAL_ERROR", join_error.to_string()),
                    ),
                }
            }
        }
        // #598 P1: accept the complete self-contained manifest and validate every reference.
        // Rendering itself starts in P2, so a valid request is deliberately loud rather than a
        // false success that could make a caller wait for files that will never be produced.
        "RenderScore" => match validate_render_score_params(&params) {
            Ok(_) => err(
                &id,
                ProtocolError::new(
                    "NOT_IMPLEMENTED",
                    "RenderScore manifest accepted; offline rendering is implemented in #598 P2",
                ),
            ),
            Err(error) => err(&id, error),
        },
        "OpenPluginUI" => {
            #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
            {
                plugin_ui_unavailable(&id, "OpenPluginUI")
            }
            #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
            {
                let (target, index) = match resolve_ui_target_and_index(&params, "OpenPluginUI") {
                    Ok(target_and_index) => target_and_index,
                    Err(error) => return err(&id, error),
                };
                let window_title = match params
                    .get("windowTitle")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                {
                    Some(title) => title.to_owned(),
                    None => {
                        return err(
                            &id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "OpenPluginUI requires a non-empty 'windowTitle'",
                            ),
                        )
                    }
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.open_outproc_plugin_ui(target, index, window_title)
                })
                .await
                {
                    Ok(Ok(())) => ok(&id, json!({"status": "opened"})),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(error) => err(&id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
                }
            }
        }
        "ClosePluginUI" => {
            #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
            {
                plugin_ui_unavailable(&id, "ClosePluginUI")
            }
            #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
            {
                let (target, index) = match resolve_ui_target_and_index(&params, "ClosePluginUI") {
                    Ok(target_and_index) => target_and_index,
                    Err(error) => return err(&id, error),
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.close_outproc_plugin_ui(target, index)
                })
                .await
                {
                    // This is explicitly Phase A acceptance, never close completion.
                    Ok(Ok(())) => ok(&id, json!({"status": "accepted"})),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(error) => err(&id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
                }
            }
        }
        "AckUiSafepoint" => {
            #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
            {
                plugin_ui_unavailable(&id, "AckUiSafepoint")
            }
            #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
            {
                let target = match resolve_ui_target(&params, "AckUiSafepoint") {
                    Ok(target) => target,
                    Err(error) => return err(&id, error),
                };
                let generation = match params.get("generation").and_then(Value::as_u64) {
                    Some(generation) => generation,
                    None => {
                        return err(
                            &id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "AckUiSafepoint requires integer 'generation'",
                            ),
                        )
                    }
                };
                let evt_seq = match params.get("evt_seq").and_then(Value::as_u64) {
                    Some(evt_seq) => evt_seq,
                    None => {
                        return err(
                            &id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "AckUiSafepoint requires integer 'evt_seq'",
                            ),
                        )
                    }
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.ack_outproc_ui_safepoint(target, generation, evt_seq)
                })
                .await
                {
                    Ok(Ok(())) => ok(&id, json!({"status": "acked"})),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(error) => err(&id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
                }
            }
        }
        // NoteOn / NoteOff（"PluginNoteOn" / "PluginNoteOff"）は関数先頭の `plugin_note_spec`
        // ディスパッチで処理済みなので、ここには到達しない。event ring 経由の送出（bounded retry・
        // #400）、key/channel 検証・spawn_blocking・応答整形の実体は `handle_plugin_note` を参照。
        // plugin 未ロード時のエラー応答（`CLAP_NOT_LOADED`・#405）と残存レース（Issue #410）の
        // 開示は `handle_plugin_note` の doc comment を参照。
        "PlayAt" => {
            let time_sec = param_f64(&params, "time_sec", 0.0);
            let gain = param_f64(&params, "gain", 1.0) as f32;
            if gain < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "gain must be >= 0"),
                );
            }
            // pan は [-1.0, 1.0]。範囲外は reject せず core 側で clamp（protocol 仕様: UX 優先）。
            // 省略時は 0.0（中央）。
            let pan = param_f64(&params, "pan", 0.0) as f32;
            // offset_sec / duration_sec は再生領域（chop の slice）。負値は reject、
            // 省略時はそれぞれ 0.0（先頭 / offset 以降すべて）。サンプル端 clamp は core。
            let offset_sec = param_f64(&params, "offset_sec", 0.0);
            let duration_sec = param_f64(&params, "duration_sec", 0.0);
            if offset_sec < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "offset_sec must be >= 0"),
                );
            }
            if duration_sec < 0.0 {
                return err(
                    &id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "duration_sec must be >= 0"),
                );
            }
            // rate は varispeed（省略時 1.0 = 自然尺）。pan と同じく非致命的 param なので reject
            // せず core 側で 1.0 に丸める（<=0/非有限。誤った無音化や逆走を起こさない）。
            let rate = param_f64(&params, "rate", 1.0);
            // channel（LinkAudio outputChannel・#209）。daemon は mode-agnostic:
            // Some(name) = 当該 Link channel への routing tag / None or 空文字 = hardware sum。
            // hardware-vs-Link の mode 判定は TS 側（Sequence.resolveDispatchChannel）が解決済で、
            // wire に乗る channel 名はそのまま routing tag になる。空文字/欠如は None に coerce
            // （channel 名は ASCII alnum+`-`+`_` 規則で空は不正）。A4-2b-1 では event に tag する
            // のみで、実 LinkAudio egress（rtrb + GPL consumer）は A4-2b-2。
            let channel = params
                .get("channel")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            // bus（per-sequence insert routing・PH.2b・#434 S3）。'channel'（LinkAudio）とは
            // 別 wire param。core の routing tag は単一フィールド（`ScheduledSample.channel`）
            // を再利用するが、LinkAudio と plugin hosting は v1 で排他ビルドのため
            // 実運用上どちらか一方しか有効にならない。同時指定は明示エラーで開示する。
            #[cfg(feature = "outproc-effect")]
            let bus = match parse_bus_param(&params) {
                Ok(bus) => bus,
                Err(message) => return err(&id, ProtocolError::new("MALFORMED_REQUEST", message)),
            };
            #[cfg(feature = "outproc-effect")]
            if playat_bus_and_channel_both_set(&bus, &channel) {
                return err(
                    &id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "PlayAt 'bus' and 'channel' cannot both be set",
                    ),
                );
            }
            #[cfg(feature = "outproc-effect")]
            let channel = bus.or(channel);
            match params.get("sample_id").and_then(|v| v.as_str()) {
                Some(sid) => match engine.play_at(
                    sid,
                    time_sec,
                    gain,
                    pan,
                    offset_sec,
                    duration_sec,
                    rate,
                    channel,
                ) {
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
        "Stop" => match params.get("play_id").and_then(|v| v.as_str()) {
            Some(pid) => match engine.stop(pid) {
                Ok(true) => ok(&id, json!({"play_id": pid, "status": "stopped"})),
                Ok(false) => ok(&id, json!({"play_id": pid, "status": "not_found"})),
                Err(e) => err(&id, wrap_err_to_protocol(&e)),
            },
            None => err(
                &id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'play_id' param"),
            ),
        },
        // 全アクティブ再生の即時停止（hard-stop-all）。respawn / stopAll で in-flight voice
        // （varispeed の長尺 slice 含む）を断つ。停止件数を返す（冪等・空でも ok）。
        "StopAll" => match engine.stop_all() {
            Ok(n) => ok(&id, json!({"stopped": n})),
            Err(e) => err(&id, wrap_err_to_protocol(&e)),
        },
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
        // 実行時 mixer routing 切替（#459/#453 M2）: sum bus への output / aux bus への send を
        // 非 RT で設定する。`SetBusRouting` は `outproc-effect` feature 専用（insert/sum/aux bus
        // 機構自体がその feature の産物・`build_effect_bus_stages` 参照）。
        #[cfg(feature = "outproc-effect")]
        "SetBusRouting" => match parse_set_bus_routing_params(&params) {
            Ok((seq_bus, output, sends)) => {
                match engine.set_bus_routing(&seq_bus, output.as_deref(), &sends) {
                    Ok(()) => ok(&id, json!({"status": "accepted"})),
                    Err(e) => err(&id, wrap_err_to_protocol(&e)),
                }
            }
            Err(message) => err(&id, ProtocolError::new("MALFORMED_REQUEST", message)),
        },
        #[cfg(not(feature = "outproc-effect"))]
        "SetBusRouting" => err(
            &id,
            ProtocolError::new(
                "UNSUPPORTED",
                "SetBusRouting requires the outproc-effect build (mixer bus graph)",
            ),
        ),
        // gated な fault 注入（recovery floor / #300 の kill-test 専用・単一動作なので unit コマンド）。
        // ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1 のときだけ受理する（既定では出荷時に無効）。
        // daemon を panic させ、main.rs の panic hook 経由で stderr に DaemonError を出し exit(1)
        // する = TS supervisor が検出すべき clean-exit 経路。C-ABI segfault / SIGKILL（panic hook
        // 素通りの hard-death）は外部 kill で別途試す（supervisor から見れば ws drop に収束するので
        // daemon 内に segfault コマンドは不要）。将来 fault 種を増やすなら param を by-design で足す。
        "InjectFault" => {
            if std::env::var("ORBIT_DAEMON_ALLOW_FAULT_INJECTION").as_deref() != Ok("1") {
                return err(
                    &id,
                    ProtocolError::new("MALFORMED_REQUEST", "fault injection not enabled"),
                );
            }
            panic!("orbit-audio-daemon: injected panic for recovery-floor kill-test")
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
        WrapError::OutProcInstrumentUnavailable(msg) => {
            ProtocolError::new("OUTPROC_INSTRUMENT_UNAVAILABLE", msg.clone())
        }
        WrapError::OutProcInstrument(msg) => {
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

    #[tokio::test]
    async fn replace_plugin_explicitly_rejects_every_non_instrument_role() {
        let (engine, _guard) = EngineWrap::start_with(crate::backend::StubBackend::default())
            .expect("stub backend starts");
        let (tx, _rx) = mpsc::channel(1);
        for (case, role) in [("effect", Some("effect")), ("missing", None)] {
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
                "ReplacePlugin requires role='instrument'"
            );
        }
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
                    "target": {"role": "effect", "bus": "lead", "index": 2},
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
