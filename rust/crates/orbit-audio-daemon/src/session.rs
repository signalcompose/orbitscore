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
    ERROR_CODE_CLAP_PROCESS_ERROR, ERROR_CODE_DEVICE_LOST, ERROR_CODE_ENGINE_LOCK_CONTENTION,
    ERROR_CODE_ENGINE_LOCK_POISONED, ERROR_CODE_LINK_EGRESS_DROP, ERROR_CODE_OUTPROC_EFFECT_ERROR,
    ERROR_CODE_OUTPROC_EFFECT_FRAMES_CLAMPED, ERROR_CODE_OUTPROC_EFFECT_INVALID,
    ERROR_CODE_OUTPROC_EFFECT_RESPAWN, ERROR_CODE_OUTPROC_INSTRUMENT_OUTPUT_DROPPED,
    ERROR_CODE_PLUGIN_EVENT_RING_OVERFLOW, ERROR_CODE_STREAM_XRUN, ERROR_SEVERITY_FATAL,
    ERROR_SEVERITY_WARNING, EVENT_DAEMON_ERROR, EVENT_PLAY_ENDED, EVENT_PLAY_STARTED,
    EVENT_STREAM_STATS,
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
            let mut last_outproc_errors: u64 = 0;
            let mut last_outproc_respawns: u64 = 0;
            let mut last_outproc_frames_clamped: u64 = 0;
            let mut last_outproc_instrument_output_dropped: u64 = 0;
            let mut last_engine_lock_contention: u64 = 0;
            let mut last_plugin_event_ring_overflow: u64 = 0;
            let mut outproc_invalid_reported = false;
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

                // out-of-process instrument の出力方向（M2 §4.2）event overflow health を非 RT で
                // surface（#420 PR #422 round 2）。round 1 で追加済みの output-event overflow counter
                // 群（dropped/spilled/note_end_dropped）が watchdog にはミラーされていたが、daemon
                // health 経路への配線が欠けており、stuck-note class の regression が無音のまま埋もれ
                // ていた（silent-failure-hunter 指摘）。真の loss signal（dropped の増加）のみを
                // WARNING トリガにし、無損失な spilled と NoteEnd 喪失（stuck-note リスク）を示す
                // note_end_dropped は message の文脈情報として含める（spilled 単独の WARNING はノイズ
                // になるため見送り・advisor 判断）。
                let (
                    outproc_instrument_dropped,
                    outproc_instrument_spilled,
                    outproc_instrument_note_end_dropped,
                ) = engine.outproc_instrument_output_health();
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

/// `PluginNoteOn`/`PluginNoteOff` の配線（`default_velocity`/`status`/`call`）。
struct PluginNoteSpec {
    default_velocity: f64,
    status: &'static str,
    call: fn(&EngineWrap, u8, u8, f64) -> Result<(), WrapError>,
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
    call: fn(&EngineWrap, u8, u8, f64) -> Result<(), WrapError>,
) -> Value {
    match params.get("key").and_then(|v| v.as_u64()) {
        Some(k) if k <= 127 => match parse_midi_channel(params) {
            Ok(channel) => {
                // velocity は CLAP 期待レンジ 0.0..=1.0 に clamp する（範囲外は plugin 挙動が
                // 未定義になるため）。
                let velocity = param_f64(params, "velocity", default_velocity).clamp(0.0, 1.0);
                let engine = engine.clone();
                let res =
                    tokio::task::spawn_blocking(move || call(&engine, k as u8, channel, velocity))
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
                EngineWrap::plugin_note_on
                    as fn(&EngineWrap, u8, u8, f64) -> Result<(), WrapError>
            ),
            "PluginNoteOn は EngineWrap::plugin_note_on を呼ぶこと（NoteOff と入れ替わっていないこと）"
        );

        let off = plugin_note_spec("PluginNoteOff").expect("PluginNoteOff has a spec");
        assert!(
            std::ptr::fn_addr_eq(
                off.call,
                EngineWrap::plugin_note_off
                    as fn(&EngineWrap, u8, u8, f64) -> Result<(), WrapError>
            ),
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
}
