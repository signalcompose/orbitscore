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
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tracing::warn;

use crate::engine_wrap::{EngineWrap, WrapError};
use crate::protocol::{
    Command, ErrorResponse, Event, Handshake, OkResponse, ProtocolError,
    ERROR_CODE_CLAP_PROCESS_ERROR, ERROR_CODE_DEVICE_LOST, ERROR_CODE_LINK_EGRESS_DROP,
    ERROR_CODE_STREAM_XRUN, ERROR_SEVERITY_FATAL, ERROR_SEVERITY_WARNING, EVENT_DAEMON_ERROR,
    EVENT_PLAY_ENDED, EVENT_PLAY_STARTED, EVENT_STREAM_STATS,
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

pub async fn run(
    ws: WebSocketStream<TcpStream>,
    engine: Arc<EngineWrap>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
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
            let mut device_lost_reported = false;
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

                let stats_evt = Event::new(
                    EVENT_STREAM_STATS,
                    json!({
                        // cpu_load: audio callback の計測基盤が未整備のため 0.0 固定。
                        "cpu_load": 0.0,
                        "xruns": snapshot.xruns,
                        "buffer_underruns": snapshot.buffer_underruns,
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
    match method.as_str() {
        "Ping" => ok(&id, Value::String("pong".to_string())),
        "GetStatus" => {
            let status = json!({
                "daemon_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": "0.1",
                "output_sample_rate": engine.output_sample_rate(),
                "output_channels": engine.output_channels(),
                "loaded_samples": engine.loaded_sample_count(),
                "active_plays": engine.active_play_count(),
                "uptime_sec": engine.uptime_sec(),
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
        // CLAP プラグインをロードして hot-install する（Issue #340・feature `clap-host`）。discovery +
        // dlopen + activate は重いので LoadSample と同様 spawn_blocking で tokio ワーカーを塞がない。
        // feature 無効ビルドは engine stub が CLAP_UNAVAILABLE を返す（command は feature 非依存）。
        "LoadPlugin" => match params.get("path").and_then(|p| p.as_str()) {
            Some(path_str) => {
                let engine = engine.clone();
                let path = std::path::PathBuf::from(path_str);
                let plugin_id = params
                    .get("plugin_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let res =
                    tokio::task::spawn_blocking(move || engine.load_plugin(path, plugin_id)).await;
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
        // ロード済み CLAP プラグインへ NoteOn / NoteOff を送る（event ring 経由・非ブロッキング）。
        // 注意: plugin 未ロード時（LoadPlugin 前 / load 失敗後）も protocol 層では成功応答を返すが、
        // audio thread は plugin が無ければ event を drain して捨てる（fire-and-forget ring の設計上、
        // ロード状態の同期確認は cross-thread round-trip が要るため行わない）。pre-load note は黙って落ちる。
        // velocity は CLAP 期待レンジ 0.0..=1.0 に clamp する（範囲外は plugin 挙動が未定義になるため）。
        "PluginNoteOn" => match params.get("key").and_then(|v| v.as_u64()) {
            Some(k) if k <= 127 => match parse_midi_channel(&params) {
                Ok(channel) => {
                    let velocity = param_f64(&params, "velocity", 0.8).clamp(0.0, 1.0);
                    match engine.plugin_note_on(k as u8, channel, velocity) {
                        Ok(()) => ok(&id, json!({"status": "note_on", "key": k})),
                        Err(e) => err(&id, wrap_err_to_protocol(&e)),
                    }
                }
                Err(e) => err(&id, e),
            },
            _ => err(
                &id,
                ProtocolError::new(
                    "MALFORMED_REQUEST",
                    "missing or out-of-range 'key' (0..=127)",
                ),
            ),
        },
        "PluginNoteOff" => match params.get("key").and_then(|v| v.as_u64()) {
            Some(k) if k <= 127 => match parse_midi_channel(&params) {
                Ok(channel) => {
                    let velocity = param_f64(&params, "velocity", 0.0).clamp(0.0, 1.0);
                    match engine.plugin_note_off(k as u8, channel, velocity) {
                        Ok(()) => ok(&id, json!({"status": "note_off", "key": k})),
                        Err(e) => err(&id, wrap_err_to_protocol(&e)),
                    }
                }
                Err(e) => err(&id, e),
            },
            _ => err(
                &id,
                ProtocolError::new(
                    "MALFORMED_REQUEST",
                    "missing or out-of-range 'key' (0..=127)",
                ),
            ),
        },
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
