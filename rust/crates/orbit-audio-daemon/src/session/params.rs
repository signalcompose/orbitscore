//! wire パラメータの解析と検証（#888 子 2・session.rs 第 1 束）。
//!
//! 🔴 **これは純粋な移動である。** `session.rs` の wire パラメータを解析・検証する
//! 自由関数群をそのまま移した。本文は 1 行も書き換えていない。
//!
//! 可視性は**定義側の cfg と一致させる**こと。親と兄弟から名前で参照されるので
//! `pub(super)` + 親側の `use` が要る（`pub(super)` は可視性を上げるだけで
//! 名前をスコープへ持ち込まない）。

#[allow(unused_imports)]
use super::*;

/// Wire-level plugin destination shared by GetPluginState/UI requests and RenderScore chains.
/// Feature availability is intentionally checked only when converting this vocabulary to the
/// live engine's PluginStateTarget; manifest validation must remain available in every build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PluginTargetVocabulary {
    Effect { bus: Option<String> },
    Instrument { instance: String },
}

pub(super) fn parse_plugin_target_vocabulary(
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
pub(super) fn parse_set_bus_routing_params(
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

#[cfg(feature = "outproc-effect")]
pub(super) fn set_bus_line_malformed(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("MALFORMED_REQUEST", message)
}

/// `SetBusLine` の一方通行 wire shape を完全に検証してから engine 用 vocabulary を返す。
#[cfg(feature = "outproc-effect")]
pub(super) fn parse_set_bus_line_params(
    params: &Value,
) -> Result<(String, Vec<BusLineOp>), ProtocolError> {
    let bus = match params.get("bus") {
        Some(Value::String(bus)) if !bus.trim().is_empty() => bus.clone(),
        _ => return Err(set_bus_line_malformed("'bus' must be a non-empty string")),
    };
    let items = params
        .get("line")
        .and_then(Value::as_array)
        .ok_or_else(|| set_bus_line_malformed("'line' must be an array"))?;
    let mut line = Vec::with_capacity(items.len());
    let mut rack_seen = false;
    for item in items {
        let op = item
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| set_bus_line_malformed("'line[].op' must be a string"))?;
        match op {
            "rack" => {
                if rack_seen {
                    return Err(set_bus_line_malformed(
                        "'line' may contain at most one rack op",
                    ));
                }
                rack_seen = true;
                line.push(BusLineOp::Rack);
            }
            "gain" => {
                let gain = parse_set_bus_line_gain(item, "line[].gain")?;
                line.push(BusLineOp::Gain(gain));
            }
            "pan" => {
                line.push(BusLineOp::Pan(parse_set_bus_line_pan(item)?));
            }
            "output" => {
                let gain = parse_set_bus_line_gain(item, "line[].gain")?;
                let thru = item
                    .get("thru")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| set_bus_line_malformed("'line[].thru' must be a boolean"))?;
                let dest =
                    parse_set_bus_line_dest(item.get("dest").ok_or_else(|| {
                        set_bus_line_malformed("'line[].dest' must be an object")
                    })?)?;
                if bus == "master" && matches!(dest, BusLineDest::Master | BusLineDest::Bus(_)) {
                    return Err(set_bus_line_malformed(
                        "the master line cannot target master or a bus",
                    ));
                }
                line.push(BusLineOp::Output { dest, thru, gain });
            }
            _ => {
                return Err(set_bus_line_malformed(
                    "'line[].op' must be one of rack, gain, pan, or output",
                ));
            }
        }
    }
    Ok((bus, line))
}

/// `parse_set_bus_line_gain` と**同じ形**にそろえてある（取得と検証を 1 関数に持つ・
/// match アームは 1 行で呼ぶだけ）。`/simplify` simplification の指摘（2026-09-11）: 同じ役割の
/// 数値フィールド検証が 2 通りの分割で並存すると、次に 3 つ目を足す人がどちらを踏襲すべきか
/// 判断できない。
///
/// エラーコードだけは `gain`（`MALFORMED_REQUEST`）と揃えず `PARAM_OUT_OF_RANGE` のまま残す
/// — 範囲外は「形が壊れている」のではなく「値が範囲外」で、device channels の範囲外検証も
/// 同じコードを使っている。`gain` 側を寄せるかどうかは既存挙動を巻き込むので本 PR では触らない。
#[cfg(feature = "outproc-effect")]
pub(super) fn parse_set_bus_line_pan(item: &Value) -> Result<f32, ProtocolError> {
    let pan = item
        .get("pan")
        .and_then(Value::as_f64)
        .ok_or_else(|| set_bus_line_malformed("'line[].pan' must be a number"))?;
    if !pan.is_finite() || !(-1.0..=1.0).contains(&pan) {
        return Err(ProtocolError::new(
            "PARAM_OUT_OF_RANGE",
            "'line[].pan' must be finite and within -1..=1",
        ));
    }
    Ok(pan as f32)
}

#[cfg(feature = "outproc-effect")]
pub(super) fn parse_set_bus_line_gain(item: &Value, field: &str) -> Result<f32, ProtocolError> {
    let gain = item
        .get("gain")
        .and_then(Value::as_f64)
        .ok_or_else(|| set_bus_line_malformed(format!("'{field}' must be a number")))?;
    if !gain.is_finite() || gain < 0.0 || gain > f32::MAX as f64 {
        return Err(set_bus_line_malformed(format!(
            "'{field}' must be finite and >= 0"
        )));
    }
    Ok(gain as f32)
}

#[cfg(feature = "outproc-effect")]
pub(super) fn parse_set_bus_line_dest(dest: &Value) -> Result<BusLineDest, ProtocolError> {
    let kind = dest
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| set_bus_line_malformed("'line[].dest.kind' must be a string"))?;
    match kind {
        "master" => Ok(BusLineDest::Master),
        "bus" => match dest.get("name") {
            Some(Value::String(name)) if !name.trim().is_empty() => {
                Ok(BusLineDest::Bus(name.clone()))
            }
            _ => Err(set_bus_line_malformed(
                "'line[].dest.name' must be a non-empty string",
            )),
        },
        "device" => {
            let channels = dest
                .get("channels")
                .and_then(Value::as_array)
                .filter(|channels| matches!(channels.len(), 1 | 2))
                .ok_or_else(|| {
                    set_bus_line_malformed(
                        "'line[].dest.channels' must be a one- or two-element integer array",
                    )
                })?;
            let channel = |index: usize| {
                channels[index]
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        set_bus_line_malformed(
                            "'line[].dest.channels' must contain non-negative integers",
                        )
                    })
            };
            Ok(BusLineDest::Device {
                left: channel(0)?,
                right: (channels.len() == 2).then(|| channel(1)).transpose()?,
            })
        }
        // DeclareRender（PR-R2）の登記簿がまだ無いため、今日の render id はすべて未登録。
        "render" => Err(set_bus_line_malformed(
            "'line[].dest.id' names an unregistered render destination",
        )),
        "link" => match dest.get("channel") {
            Some(Value::String(channel)) if !channel.trim().is_empty() => {
                Ok(BusLineDest::Link(channel.clone()))
            }
            _ => Err(set_bus_line_malformed(
                "'line[].dest.channel' must be a non-empty string",
            )),
        },
        _ => Err(set_bus_line_malformed(
            "'line[].dest.kind' must be one of master, bus, device, render, or link",
        )),
    }
}

#[cfg(feature = "outproc-effect")]
pub(super) fn validate_set_bus_line_device_channels(
    line: &[BusLineOp],
    output_channels: u16,
) -> Result<(), ProtocolError> {
    for op in line {
        let BusLineOp::Output {
            dest: BusLineDest::Device { left, right },
            ..
        } = op
        else {
            continue;
        };
        if *left == 0
            || *left > output_channels as usize
            || right.is_some_and(|right| {
                right == 0 || right == *left || right > output_channels as usize
            })
        {
            return Err(ProtocolError::new(
                "PARAM_OUT_OF_RANGE",
                format!(
                    "device channels must be within 1..={output_channels} and distinct when stereo, got left={left}, right={right:?}"
                ),
            ));
        }
    }
    Ok(())
}

/// `SetSourceRouting` の wire shape を検証する。`source` は内容を解釈せず、そのまま opaque key
/// として返す。`target` は none / master / named insert bus の明示 3 値だけを受理する。
#[cfg(any(test, all(feature = "outproc-effect", feature = "outproc-instrument")))]
pub(super) fn parse_set_source_routing_params(
    params: &Value,
) -> Result<(String, u32, SourceRoutingTarget), &'static str> {
    let source = match params.get("source") {
        Some(Value::String(source)) if !source.trim().is_empty() => source.clone(),
        _ => return Err("'source' must be a non-empty string"),
    };
    let unit = params
        .get("unit")
        .and_then(Value::as_u64)
        .and_then(|unit| u32::try_from(unit).ok())
        .ok_or("'unit' must be an unsigned 32-bit integer")?;
    let target = match params.get("target").and_then(Value::as_object) {
        Some(target) => match target.get("kind").and_then(Value::as_str) {
            Some("none") if target.len() == 1 => SourceRoutingTarget::None,
            Some("master") if target.len() == 1 => SourceRoutingTarget::Master,
            Some("bus") if target.len() == 2 => match target.get("name") {
                Some(Value::String(name)) if !name.trim().is_empty() => {
                    SourceRoutingTarget::Bus(name.clone())
                }
                _ => return Err("'target.name' must be a non-empty string for kind 'bus'"),
            },
            _ => return Err("'target' must be exactly {kind:'none'}, {kind:'master'}, or {kind:'bus',name:string}"),
        },
        None => return Err("'target' must be an object with an explicit routing kind"),
    };
    Ok((source, unit, target))
}
