//! プラグイン / UI / render のパラメータ解析（#888 子 2・session.rs 第 1 束）。
//!
//! 🔴 **これは純粋な移動である。** `params.rs` から分けた。1 ファイルにまとめると
//! **700 コード行**で #888 の閾値 500 を超えるため（設計 §13.9 の制約 1）。

#[allow(unused_imports)]
use super::*;

/// PlayAt の `bus`（per-sequence insert routing・PH.2b・#434 S3）と `channel`（LinkAudio
/// routing・#209）の同時指定を検出する純関数。両者は core 上は同じ routing tag フィールド
/// （`ScheduledSample.channel`）を共有するため、同時指定は意味が一意に決まらず拒否する。
#[cfg(feature = "outproc-effect")]
pub(super) fn playat_bus_and_channel_both_set(
    bus: &Option<String>,
    channel: &Option<String>,
) -> bool {
    bus.is_some() && channel.is_some()
}

/// role='instrument' と 'bus' の同時指定を検出する純関数（'bus' は effect 専用）。
pub(super) fn bus_param_invalid_for_instrument_role(params: &Value) -> bool {
    params.get("role").and_then(Value::as_str) == Some("instrument") && params.get("bus").is_some()
}

/// 任意・非空文字列 param の共通パーサ（`instance` #540 P1 / `state_path` #540 P2）。
/// 欠如は `Ok(None)`（互換: 単数時代の "default" 扱い）。空文字列・非文字列は `Err`
/// （`parse_bus_param` と同じ「黙って壊さない」方針）。
pub(super) fn parse_optional_nonempty_string_param(
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
pub(super) fn instrument_only_param_misused(params: &Value, field: &str) -> bool {
    params.get("role").and_then(Value::as_str) != Some("instrument") && params.get(field).is_some()
}

/// GetPluginState and all three UI requests share this single role/bus/instance resolver.
/// UI requests place the vocabulary under `target`; GetPluginState's established wire shape is
/// top-level, so callers pass the relevant object rather than duplicating the role match.
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn parse_plugin_target(
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
pub(super) fn ui_target_object<'a>(
    params: &'a Value,
    method: &str,
) -> Result<&'a Value, ProtocolError> {
    params.get("target").ok_or_else(|| {
        ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} requires a 'target' object"),
        )
    })
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn chain_path_index(params: &Value, method: &str) -> Result<u64, ProtocolError> {
    let Some(value) = params.get("chain_path") else {
        return Ok(0);
    };
    let Value::Array(path) = value else {
        return Err(ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} 'chain_path' must be an array of non-negative integers"),
        ));
    };
    if path.len() > 1 {
        return Err(ProtocolError::new(
            "MALFORMED_REQUEST",
            "chain_path nesting is staged behind layer()/PDC (SC.10.11); v1 supports one flat stage index",
        ));
    }
    match path.first().and_then(Value::as_u64) {
        Some(index) => Ok(index),
        None => Err(ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} 'chain_path' must contain exactly one non-negative integer"),
        )),
    }
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn ui_window(params: &Value, method: &str) -> Result<u64, ProtocolError> {
    params.get("window").and_then(Value::as_u64).ok_or_else(|| {
        ProtocolError::new(
            "MALFORMED_REQUEST",
            format!("{method} requires integer 'window'"),
        )
    })
}

#[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
pub(super) fn plugin_ui_unavailable(id: &str, method: &str) -> Value {
    err(
        id,
        ProtocolError::new(
            "PLUGIN_UI_UNAVAILABLE",
            format!("{method} requires outproc-effect or outproc-instrument"),
        ),
    )
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn resolve_ui_target_and_index(
    params: &Value,
    method: &str,
) -> Result<(PluginStateTarget, u64), ProtocolError> {
    let target = resolve_ui_target(params, method)?;
    let index = chain_path_index(params, method)?;
    Ok((target, index))
}

#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(super) fn resolve_ui_target(
    params: &Value,
    method: &str,
) -> Result<PluginStateTarget, ProtocolError> {
    let target_params = ui_target_object(params, method)?;
    parse_plugin_target(target_params, method, "PLUGIN_UI_UNAVAILABLE")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenderScoreSample {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenderScorePlugin {
    plugin: String,
    plugin_id: Option<String>,
    target: Value,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenderScoreBus {
    name: String,
    chain: Vec<RenderScorePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenderScoreMaster {
    chain: Vec<RenderScorePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RenderScoreEvent {
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
pub(super) struct RenderScoreManifest {
    sample_rate: u32,
    duration_sec: f64,
    block_frames: u32,
    samples: Vec<RenderScoreSample>,
    buses: Vec<RenderScoreBus>,
    master: Option<RenderScoreMaster>,
    events: Vec<RenderScoreEvent>,
    out_dir: String,
}

pub(super) fn render_score_error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("MALFORMED_REQUEST", message)
}

pub(super) fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

/// 宣言名の一意性を検査して登録する。samples / buses が同じ規約を共有する
/// （3つ目の宣言種別が増えても同じ形を複製しない）。
pub(super) fn insert_unique<'a>(
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

pub(super) fn canonical_render_bus(value: &str) -> bool {
    value
        .parse::<u8>()
        .ok()
        .filter(|number| (1..=16).contains(number))
        .is_some_and(|number| value == number.to_string())
}

pub(super) fn validate_render_plugin(
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

pub(super) fn validate_render_score_params(
    params: &Value,
) -> Result<RenderScoreManifest, ProtocolError> {
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
/// session 登録の RAII ガード。
///
/// 🔴 `disconnect()` を呼ばずに drop された場合でもカウンタを戻す。
/// 戻さないと `connected_sessions` が永久に加算されたままになり、**以後どの session が
/// 切れても最後の砦（`PluginAllNotesOff`）が二度と発火しない** — daemon プロセスが生きている
/// 限りずっと、である。同ファイルの `InstrumentReplacementReservation` と同じ「明示的な
/// 確定 + Drop の安全網」の形。現在の production panic path は daemon の panic hook が unwind 前に
/// process を exit するためここへ到達しないが、将来の早期 return 等の経路に備えて guard は維持する。
pub(super) struct SessionRegistration {
    engine: Arc<EngineWrap>,
    released: bool,
}

impl SessionRegistration {
    pub(super) fn new(engine: Arc<EngineWrap>) -> Self {
        engine.session_connected();
        Self {
            engine,
            released: false,
        }
    }

    /// 明示的な切断。daemon の最後の確立済み session だったかを返す。
    pub(super) fn disconnect(mut self) -> bool {
        self.released = true;
        self.engine.session_disconnected_is_last()
    }
}

impl Drop for SessionRegistration {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        // 現在の daemon panic hook は unwind 前に process を exit するため、panic ではここへ来ない。
        // 将来、明示切断より手前の早期 return 等が追加された場合の安全網としてカウンタだけ戻す。
        // 解放そのものはここでは行わない — Drop は async runtime のスレッド上で走り、
        // `plugin_all_notes_off` は bounded retry で sleep しうるため。この session が最後
        // だった場合その分の音は残るが、**次の session の切断で正しく発火する状態には戻る**。
        let was_last = self.engine.session_disconnected_is_last();
        warn!(
            was_last,
            "session registration dropped without an explicit disconnect; \
             the all-notes-off trigger did not run for this session"
        );
    }
}
