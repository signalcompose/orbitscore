//! トランスポート系コマンドの dispatch（#888 子 2・session.rs 第 3 束）。
//!
//! 🔴 **アーム本体は 1 行も書き換えていない。** `handle_command` の単一 `match` から
//! `PlayAt` / `Stop` / `StopAll` / `PluginAllNotesOff` / `SetGlobalGain` のアームを
//! `dispatch_plugin.rs` と同じ形（該当しなければ `None`）で切り出した。
//! 理由は同じく、単一 match がファイル分割だけでは閾値 500 を満たせないこと。

#[allow(unused_imports)]
use super::*;

/// トランスポート系のコマンドを処理する。該当しない method は `None`。
pub(super) async fn handle_transport_command(
    id: &str,
    method: &str,
    params: &Value,
    engine: &Arc<EngineWrap>,
    tx: &mpsc::Sender<String>,
) -> Option<Value> {
    Some(match method {
        // NoteOn / NoteOff（"PluginNoteOn" / "PluginNoteOff"）は関数先頭の `plugin_note_spec`
        // ディスパッチで処理済みなので、ここには到達しない。event ring 経由の送出（bounded retry・
        // #400）、key/channel 検証・spawn_blocking・応答整形の実体は `handle_plugin_note` を参照。
        // plugin 未ロード時のエラー応答（`CLAP_NOT_LOADED`・#405）と残存レース（Issue #410）の
        // 開示は `handle_plugin_note` の doc comment を参照。
        "PlayAt" => {
            let time_sec = param_f64(params, "time_sec", 0.0);
            let gain = param_f64(params, "gain", 1.0) as f32;
            if gain < 0.0 {
                return Some(err(
                    id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "gain must be >= 0"),
                ));
            }
            // pan は [-1.0, 1.0]。範囲外は reject せず core 側で clamp（protocol 仕様: UX 優先）。
            // 省略時は 0.0（中央）。
            let pan = param_f64(params, "pan", 0.0) as f32;
            // offset_sec / duration_sec は再生領域（chop の slice）。負値は reject、
            // 省略時はそれぞれ 0.0（先頭 / offset 以降すべて）。サンプル端 clamp は core。
            let offset_sec = param_f64(params, "offset_sec", 0.0);
            let duration_sec = param_f64(params, "duration_sec", 0.0);
            if offset_sec < 0.0 {
                return Some(err(
                    id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "offset_sec must be >= 0"),
                ));
            }
            if duration_sec < 0.0 {
                return Some(err(
                    id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "duration_sec must be >= 0"),
                ));
            }
            // rate は varispeed（省略時 1.0 = 自然尺）。pan と同じく非致命的 param なので reject
            // せず core 側で 1.0 に丸める（<=0/非有限。誤った無音化や逆走を起こさない）。
            let rate = param_f64(params, "rate", 1.0);
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
            let bus = match parse_bus_param(params) {
                Ok(bus) => bus,
                Err(message) => {
                    return Some(err(id, ProtocolError::new("MALFORMED_REQUEST", message)))
                }
            };
            #[cfg(feature = "outproc-effect")]
            if playat_bus_and_channel_both_set(&bus, &channel) {
                return Some(err(
                    id,
                    ProtocolError::new(
                        "MALFORMED_REQUEST",
                        "PlayAt 'bus' and 'channel' cannot both be set",
                    ),
                ));
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

                        ok(id, json!({"play_id": handle.play_id}))
                    }
                    Err(e) => err(id, wrap_err_to_protocol(&e)),
                },
                None => err(
                    id,
                    ProtocolError::new("MALFORMED_REQUEST", "missing 'sample_id' param"),
                ),
            }
        }
        "Stop" => match params.get("play_id").and_then(|v| v.as_str()) {
            Some(pid) => match engine.stop(pid) {
                Ok(true) => ok(id, json!({"play_id": pid, "status": "stopped"})),
                Ok(false) => ok(id, json!({"play_id": pid, "status": "not_found"})),
                Err(e) => err(id, wrap_err_to_protocol(&e)),
            },
            None => err(
                id,
                ProtocolError::new("MALFORMED_REQUEST", "missing 'play_id' param"),
            ),
        },
        // 全アクティブ再生の即時停止（hard-stop-all）。respawn / stopAll で in-flight voice
        // （varispeed の長尺 slice 含む）を断つ。停止件数を返す（冪等・空でも ok）。
        "StopAll" => match engine.stop_all() {
            Ok(n) => ok(id, json!({"stopped": n})),
            Err(e) => err(id, wrap_err_to_protocol(&e)),
        },
        "PluginAllNotesOff" => {
            let engine = engine.clone();
            match tokio::task::spawn_blocking(move || engine.plugin_all_notes_off()).await {
                Ok(Ok(summary)) => ok(
                    id,
                    json!({
                        "released": summary.released,
                        "stale": summary.stale,
                        "failed": summary.failed,
                    }),
                ),
                Ok(Err(error)) => err(id, wrap_err_to_protocol(&error)),
                Err(error) => err(id, ProtocolError::new("INTERNAL_ERROR", error.to_string())),
            }
        }
        "SetGlobalGain" => {
            let value = params.get("value").and_then(|v| v.as_f64()).unwrap_or(1.0);
            let ramp_sec = params
                .get("ramp_sec")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if value < 0.0 {
                return Some(err(
                    id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "value must be >= 0"),
                ));
            }
            if ramp_sec < 0.0 {
                return Some(err(
                    id,
                    ProtocolError::new("PARAM_OUT_OF_RANGE", "ramp_sec must be >= 0"),
                ));
            }
            match engine.set_global_gain(value as f32, ramp_sec) {
                Ok(()) => ok(id, json!({"status": "accepted"})),
                Err(e) => err(id, wrap_err_to_protocol(&e)),
            }
        }
        _ => return None,
    })
}
