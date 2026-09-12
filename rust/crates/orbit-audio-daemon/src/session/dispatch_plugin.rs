//! プラグイン系コマンドの dispatch（#888 子 2・session.rs 第 2 束）。
//!
//! 🔴 **これは「純粋な移動」ではない。** `handle_command` の単一 `match` から
//! プラグイン関連のアーム（`LoadPlugin` / `ApplyEffectChain` / `ReplacePlugin` /
//! `UnloadPlugin` / `GetPluginState`）を**別関数へ切り出した**。
//!
//! **なぜ切り出しが要ったか**: `handle_command` は 1,028 コード行の**単一 match 式**で、
//! ファイルを分けても 1 つの式なので #888 の閾値 500 を行数だけでは満たせない
//! （owner 裁定 2026-09-12）。
//!
//! **アーム本体は 1 行も書き換えていない。** 変わったのは
//! (a) この関数のシグネチャ (b) 呼び出し側の 1 行 (c) `match` が
//! `Option<Value>` を返し、該当しなければ `None` で親へ落とす形にしたこと。
//! 🔴 **検算は「既存テストの期待値を 1 つも変えていない」で変わらない。**

#[allow(unused_imports)]
use super::*;

/// プラグイン系のコマンドを処理する。該当しない method は `None` を返し、
/// 呼び出し元（`handle_command`）の `match` に処理を戻す。
pub(super) async fn handle_plugin_command(
    id: &str,
    method: &str,
    params: &Value,
    engine: &Arc<EngineWrap>,
) -> Option<Value> {
    Some(match method {
        // CLAP プラグインをロードして hot-install する。in-process `clap-host` は既存 load path、
        // OOP feature は role を検証して post-boot child attach path へ分岐する。どちらも dlopen を
        // 含みうるため spawn_blocking で tokio worker から隔離する。
        "LoadPlugin" => match params.get("path").and_then(|p| p.as_str()) {
            Some(path_str) => {
                #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
                let clap_role = match clap_role_param(params) {
                    Some(role) => role,
                    None => {
                        return Some(err(
                            id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "in-process LoadPlugin requires role='effect' or role='instrument'",
                            ),
                        ));
                    }
                };
                #[cfg(all(feature = "outproc-effect", not(feature = "outproc-instrument")))]
                if !outproc_role_param_is_valid(params) {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc-effect LoadPlugin requires role='effect'",
                        ),
                    ));
                }
                #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
                if !outproc_role_param_is_valid(params) {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc-instrument LoadPlugin requires role='instrument'",
                        ),
                    ));
                }
                #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
                if !outproc_role_param_is_valid(params) {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "outproc LoadPlugin requires role='effect' or role='instrument'",
                        ),
                    ));
                }

                let engine = engine.clone();
                let path = std::path::PathBuf::from(path_str);
                let plugin_id = params
                    .get("plugin_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                #[cfg(feature = "outproc-effect")]
                let bus = match parse_bus_param(params) {
                    Ok(bus) => bus,
                    Err(message) => {
                        return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                    }
                };
                #[cfg(feature = "outproc-instrument")]
                if bus_param_invalid_for_instrument_role(params) {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "LoadPlugin bus is only valid for role='effect'",
                        ),
                    ));
                }
                // #540 P1: `instance`（role='instrument' 専用・`bus` と対称）。
                #[cfg(feature = "outproc-instrument")]
                if instrument_only_param_misused(params, "instance") {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "LoadPlugin instance is only valid for role='instrument'",
                        ),
                    ));
                }
                #[cfg(feature = "outproc-instrument")]
                let instance = match parse_optional_nonempty_string_param(params, "instance") {
                    Ok(instance) => instance,
                    Err(message) => {
                        return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                    }
                };
                // #562: VST3/CLAP × instrument/effect の全 role で同じ state_path 復元を使う。
                #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
                let state_path = match parse_optional_nonempty_string_param(params, "state_path") {
                    Ok(state_path) => state_path.map(std::path::PathBuf::from),
                    Err(message) => {
                        return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                    }
                };
                // instrument-only build（テスト用構成）は単数互換経路しか持たない。ビルド構成
                // パリティ方針（#542 レビュー）: 尊重できない param を検証後に黙って捨てて
                // `ok` を返さない — この構成が扱えない要求は明示エラーで断る（TS 層は常に
                // instance を送るため、silent 縮退は「2台目が黙って1台に合流」として現れる）。
                #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
                if instance.is_some() || state_path.is_some() {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "OUTPROC_INSTRUMENT_UNAVAILABLE",
                            "this daemon build (outproc-instrument only) supports a single \
                         instrument instance and no state restore; rebuild with \
                         --features outproc-effect,outproc-instrument for per-sequence \
                         instances (LoadPlugin instance/state_path)",
                        ),
                    ));
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
                        id,
                        json!({
                            "plugin_id": info.plugin_id,
                            "plugin_name": info.plugin_name,
                            "note_port_index": info.note_port_index,
                        }),
                    ),
                    Ok(Err(e)) => err(id, wrap_err_to_protocol(&e)),
                    Err(join_err) => err(
                        id,
                        ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                    ),
                }
            }
            None => err(
                id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'path' param"),
            ),
        },
        "ApplyEffectChain" => {
            if params.get("role").and_then(Value::as_str) != Some("effect") {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ApplyEffectChain requires role='effect'",
                    ),
                ));
            }
            if params.get("instance").is_some() {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ApplyEffectChain does not accept an instrument instance",
                    ),
                ));
            }
            let bus = match parse_bus_param(params) {
                Ok(bus) => bus,
                Err(message) => {
                    return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                }
            };
            let mode = match params.get("mode").and_then(Value::as_str) {
                Some(mode @ ("diff" | "rebuild")) => mode.to_owned(),
                _ => {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "ApplyEffectChain requires mode='diff' or mode='rebuild'",
                        ),
                    ))
                }
            };
            let chain_value = match params.get("chain") {
                Some(value @ Value::Array(_)) => value.clone(),
                _ => {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "ApplyEffectChain requires a 'chain' array",
                        ),
                    ))
                }
            };
            let save_dropped_value = match params.get("save_dropped") {
                None => json!([]),
                Some(value @ Value::Array(_)) => value.clone(),
                Some(_) => {
                    return Some(err(
                        id,
                        ProtocolError::new(
                            "MALFORMED_REQUEST",
                            "ApplyEffectChain 'save_dropped' must be an array",
                        ),
                    ))
                }
            };
            #[cfg(feature = "outproc-effect")]
            {
                let mode = match mode.as_str() {
                    "diff" => crate::outproc_effect::ApplyEffectChainMode::Diff,
                    "rebuild" => crate::outproc_effect::ApplyEffectChainMode::Rebuild,
                    _ => unreachable!("mode was validated above"),
                };
                let chain = match serde_json::from_value::<
                    Vec<crate::outproc_effect::EffectChainPlanStage>,
                >(chain_value)
                {
                    Ok(chain) => chain,
                    Err(error) => {
                        return Some(err(
                            id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                format!("invalid ApplyEffectChain chain: {error}"),
                            ),
                        ))
                    }
                };
                let save_dropped = match serde_json::from_value::<
                    Vec<crate::outproc_effect::SaveDroppedStage>,
                >(save_dropped_value)
                {
                    Ok(dropped) => dropped,
                    Err(error) => {
                        return Some(err(
                            id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                format!("invalid ApplyEffectChain save_dropped: {error}"),
                            ),
                        ))
                    }
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.apply_outproc_effect_chain(
                        bus,
                        crate::outproc_effect::EffectChainPlan {
                            chain,
                            save_dropped,
                        },
                        mode,
                    )
                })
                .await
                {
                    Ok(Ok(summary)) => ok(
                        id,
                        json!({
                            "status": "applied",
                            "child_pid": summary.child_pid,
                            "dropped": summary.dropped.into_iter().map(|stage| json!({
                                "prev_index": stage.prev_index,
                                "path": stage.path,
                                "bytes_written": stage.bytes_written,
                            })).collect::<Vec<_>>(),
                        }),
                    ),
                    Ok(Err(error)) => err(id, wrap_err_to_protocol(&error)),
                    Err(error) => err(id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
                }
            }
            #[cfg(not(feature = "outproc-effect"))]
            {
                let _ = (engine, bus, mode, chain_value, save_dropped_value);
                err(
                    id,
                    ProtocolError::new(
                        "OUTPROC_EFFECT_UNAVAILABLE",
                        "ApplyEffectChain requires an outproc-effect daemon build",
                    ),
                )
            }
        }
        // LoadPlugin の Active-reject semantics を変えず、effect / instrument の各 slot を
        // 差し替えるか、Empty な slot を ensure-load する。attach は block しうるため
        // LoadPlugin と同じく spawn_blocking で tokio worker から隔離する。
        "ReplacePlugin" => {
            let Some(role) = params
                .get("role")
                .and_then(Value::as_str)
                .filter(|role| matches!(*role, "effect" | "instrument"))
            else {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ReplacePlugin requires role='effect' or role='instrument'",
                    ),
                ));
            };
            if role == "effect" {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ReplacePlugin(role='effect') is superseded by ApplyEffectChain (#628)",
                    ),
                ));
            }
            let Some(path_str) = params.get("path").and_then(Value::as_str) else {
                return Some(err(
                    id,
                    ProtocolError::new("MALFORMED_REQUEST", "missing 'path' param"),
                ));
            };
            let plugin_id = params
                .get("plugin_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let path = std::path::PathBuf::from(path_str);

            if bus_param_invalid_for_instrument_role(params) {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "ReplacePlugin bus is invalid for role='instrument'",
                    ),
                ));
            }
            let instance = match parse_optional_nonempty_string_param(params, "instance") {
                Ok(instance) => instance,
                Err(message) => {
                    return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                }
            };
            let state_path = match parse_optional_nonempty_string_param(params, "state_path") {
                Ok(state_path) => state_path.map(std::path::PathBuf::from),
                Err(message) => {
                    return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                }
            };
            #[cfg(all(feature = "outproc-instrument", not(feature = "outproc-effect")))]
            if instance.is_some() || state_path.is_some() {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "OUTPROC_INSTRUMENT_UNAVAILABLE",
                        "this daemon build (outproc-instrument only) supports a single \
                         instrument instance and no state restore; rebuild with \
                         --features outproc-effect,outproc-instrument for per-sequence \
                         instances (ReplacePlugin instance/state_path)",
                    ),
                ));
            }
            #[cfg(feature = "outproc-instrument")]
            {
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.replace_outproc_instrument_plugin(path, plugin_id, instance, state_path)
                })
                .await
                {
                    Ok(Ok(info)) => replaced_plugin_ok(id, info),
                    Ok(Err(error)) => err(id, wrap_err_to_protocol(&error)),
                    Err(join_error) => err(
                        id,
                        ProtocolError::new("INTERNAL_ERROR", join_error.to_string()),
                    ),
                }
            }
            #[cfg(not(feature = "outproc-instrument"))]
            {
                let _ = (engine, path, plugin_id, instance, state_path);
                err(
                    id,
                    ProtocolError::new(
                        "OUTPROC_INSTRUMENT_UNAVAILABLE",
                        "ReplacePlugin requires an outproc-instrument daemon build",
                    ),
                )
            }
        }
        // Removes only an effect tenant. Slot and bus/routing bookkeeping stay allocated.
        "UnloadPlugin" => {
            if params.get("role").and_then(Value::as_str) != Some("effect")
                || params.get("instance").is_some()
            {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "UnloadPlugin supports role='effect' in v1",
                    ),
                ));
            }
            err(
                id,
                ProtocolError::new(
                    "MALFORMED_REQUEST",
                    "UnloadPlugin is superseded by ApplyEffectChain (#628)",
                ),
            )
        }
        // #562: 実行中のOOP childから現在stateをsidecarへ保存する。上位層で解決済みの
        // role/bus/instanceを受け、停止判定・single mailbox・atomic renameはEngineWrapに集約する。
        "GetPluginState" => {
            #[cfg(not(any(feature = "outproc-effect", feature = "outproc-instrument")))]
            {
                err(
                    id,
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
                        return Some(err(
                            id,
                            ProtocolError::new(
                                "MALFORMED_REQUEST",
                                "GetPluginState requires a non-empty 'path'",
                            ),
                        ))
                    }
                };
                let target =
                    match parse_plugin_target(params, "GetPluginState", "PLUGIN_STATE_UNAVAILABLE")
                    {
                        Ok(target) => target,
                        Err(error) => return Some(err(id, error)),
                    };
                let chain_index = match chain_path_index(params, "GetPluginState") {
                    Ok(index) => index as usize,
                    Err(error) => return Some(err(id, error)),
                };
                let engine = engine.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    engine.save_outproc_plugin_state(target, chain_index, final_path)
                })
                .await;
                match saved {
                    Ok(Ok(saved)) => ok(
                        id,
                        json!({
                            "path": saved.path,
                            "bytes_written": saved.bytes_written,
                        }),
                    ),
                    Ok(Err(error)) => err(id, wrap_err_to_protocol(&error)),
                    Err(join_error) => err(
                        id,
                        ProtocolError::new("INTERNAL_ERROR", join_error.to_string()),
                    ),
                }
            }
        }
        _ => return None,
    })
}
