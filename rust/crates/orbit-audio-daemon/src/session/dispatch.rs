//! Command の dispatch（#888 子 2・session.rs 第 2 束）。
//!
//! 🔴 **これは純粋な移動である。** `handle_command` をそのまま移した。
//! wire のコマンドを受けて `EngineWrap` を呼び、Response JSON を組み立てる本体。

#[allow(unused_imports)]
use super::*;

/// Command を dispatch し、Response JSON を組み立てる。
///
/// `tx` は event 送信用チャンネル（PlayEnded 等の遅延通知に使う）。
pub(super) async fn handle_command(
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

    // 🔴 プラグイン系のアームは `dispatch_plugin.rs` へ切り出した（#888 子 2）。
    // 単一 match が 1,028 コード行あり、ファイルを分けるだけでは閾値 500 を満たせないため。
    // 該当しない method は `None` が返り、下の `match` がそのまま処理する。
    if let Some(response) = handle_plugin_command(&id, method.as_str(), &params, engine).await {
        return response;
    }
    // 🔴 トランスポート系のアームも同じ理由で `dispatch_transport.rs` へ（#888 子 2）。
    if let Some(response) =
        handle_transport_command(&id, method.as_str(), &params, engine, tx).await
    {
        return response;
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
            let engine_for_switch = engine.clone();
            let switched =
                tokio::task::spawn_blocking(move || engine_for_switch.select_audio_device(device))
                    .await;
            match switched {
                Ok(Ok(device)) => {
                    let output = engine.stream_config_snapshot();
                    ok(
                        &id,
                        json!({
                            "ok": true,
                            "device": device,
                            "device_requested": output.device_requested,
                            "device_fell_back": output.device_fell_back,
                            "fallback_reason": output.fallback_reason,
                            "first_callback_ms": output.first_callback_ms,
                            "sample_rate": output.sample_rate,
                            "channels": output.channels,
                        }),
                    )
                }
                Ok(Err(e)) => err(&id, wrap_err_to_protocol(&e)),
                Err(join_err) => err(
                    &id,
                    ProtocolError::new("INTERNAL_ERROR", join_err.to_string()),
                ),
            }
        }
        "GetStatus" => {
            let stream_config = engine.stream_config_snapshot();
            let stream_stats = engine.stream_stats_snapshot();
            let status = json!({
                "daemon_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": crate::protocol::PROTOCOL_VERSION,
                "output_sample_rate": stream_config.sample_rate,
                "output_channels": stream_config.channels,
                "loaded_samples": engine.loaded_sample_count(),
                "active_plays": engine.active_play_count(),
                "uptime_sec": engine.uptime_sec(),
                "render_contentions": stream_stats.render_contentions,
                "output": {
                    "device_name": stream_config.device_name,
                    "sample_rate": stream_config.sample_rate,
                    "channels": stream_config.channels,
                    "device_requested": stream_config.device_requested,
                    "device_fell_back": stream_config.device_fell_back,
                    "fallback_reason": stream_config.fallback_reason,
                    "first_callback_ms": stream_config.first_callback_ms,
                    "last_switch_failure": stream_config.last_switch_failure,
                },
                "callback": { "count": stream_stats.callbacks, "alive": engine.callback_alive(), "last_frames": stream_stats.last_frames },
            });
            #[cfg(feature = "outproc-instrument")]
            {
                let mut status = status;
                // 🔴 診断は縮退する。台帳が読めない（poison）ことを理由に GetStatus 全体を失敗させると、
                // デバイス・レート・uptime・render_contentions まで**異常時にこそ**失われる。
                // この項目を足した目的（stop 後に台帳が空かを外から確認できるようにする）からしても、
                // 読めない時は件数だけ null にして理由をログへ出すのが正しい。
                status["active_plugin_notes"] = match engine.active_plugin_note_count() {
                    Ok(count) => json!(count),
                    Err(error) => {
                        error!("GetStatus could not read the active plugin note ledger: {error}");
                        serde_json::Value::Null
                    }
                };
                ok(&id, status)
            }
            #[cfg(not(feature = "outproc-instrument"))]
            {
                ok(&id, status)
            }
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
                let window = match ui_window(&params, "OpenPluginUI") {
                    Ok(window) => window,
                    Err(error) => return err(&id, error),
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.open_outproc_plugin_ui(target, index, window_title, Some(window))
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
                let window = match ui_window(&params, "ClosePluginUI") {
                    Ok(window) => window,
                    Err(error) => return err(&id, error),
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.close_outproc_plugin_ui(target, index, Some(window))
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
                let index = match chain_path_index(&params, "AckUiSafepoint") {
                    Ok(index) => index,
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
                let window = match ui_window(&params, "AckUiSafepoint") {
                    Ok(window) => window,
                    Err(error) => return err(&id, error),
                };
                let engine = engine.clone();
                match tokio::task::spawn_blocking(move || {
                    engine.ack_outproc_ui_safepoint(
                        target,
                        index,
                        Some(window),
                        generation,
                        evt_seq,
                    )
                })
                .await
                {
                    Ok(Ok(())) => ok(&id, json!({"status": "acked"})),
                    Ok(Err(error)) => err(&id, wrap_err_to_protocol(&error)),
                    Err(error) => err(&id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
                }
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
        #[cfg(feature = "outproc-effect")]
        "SetBusLine" => match parse_set_bus_line_params(&params) {
            Ok((bus, line)) => {
                if let Err(error) =
                    validate_set_bus_line_device_channels(&line, engine.output_channels())
                {
                    err(&id, error)
                } else {
                    match engine.set_bus_line(&bus, &line) {
                        Ok(()) => ok(&id, json!({"status": "accepted"})),
                        Err(error) => err(&id, wrap_err_to_protocol(&error)),
                    }
                }
            }
            Err(error) => err(&id, error),
        },
        #[cfg(not(feature = "outproc-effect"))]
        "SetBusLine" => err(
            &id,
            ProtocolError::new(
                "UNSUPPORTED",
                "SetBusLine requires the outproc-effect build (mixer bus graph)",
            ),
        ),
        #[cfg(all(feature = "outproc-effect", feature = "outproc-instrument"))]
        "SetSourceRouting" => match parse_set_source_routing_params(&params) {
            Ok((source, unit, target)) => match engine.set_source_routing(&source, unit, target) {
                Ok(()) => ok(&id, json!({"status": "accepted"})),
                Err(e) => err(&id, wrap_err_to_protocol(&e)),
            },
            Err(message) => err(&id, ProtocolError::new("MALFORMED_REQUEST", message)),
        },
        #[cfg(not(all(feature = "outproc-effect", feature = "outproc-instrument")))]
        "SetSourceRouting" => err(
            &id,
            ProtocolError::new(
                "UNSUPPORTED",
                "SetSourceRouting requires the outproc-effect,outproc-instrument build",
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
