//! WebSocket セッションの主ループ（#888 子 2・session.rs 第 3 束）。
//!
//! 🔴 **これは純粋な移動である。** `run` をそのまま移した。
//! 接続を受け、frame を読み、`handle_command` へ渡し、event を書き戻す本体。

#[allow(unused_imports)]
use super::*;

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
    let session = SessionRegistration::new(engine.clone());

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
            let initial_callbacks = engine.stream_stats_snapshot().callbacks;
            let mut callback_liveness = CallbackLiveness::new(initial_callbacks);
            loop {
                ticker.tick().await;
                let snapshot = engine.stream_stats_snapshot();
                let now_sec = engine.transport_or_uptime_sec();
                let callback_health = callback_liveness.observe(snapshot.callbacks);
                engine.set_callback_alive(callback_health.alive);

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

                if let Some(health_event) = callback_health.event {
                    let (severity, code, message) = match health_event {
                        CallbackHealthEvent::Dead => (ERROR_SEVERITY_FATAL, ERROR_CODE_STREAM_CALLBACK_DEAD, "audio stream callback has never run since stream start".to_string()),
                        CallbackHealthEvent::StalledWarning => (ERROR_SEVERITY_WARNING, ERROR_CODE_STREAM_CALLBACK_STALLED, format!("audio stream callback did not advance during the last tick ({} callbacks total)", snapshot.callbacks)),
                        CallbackHealthEvent::StalledFatal => (ERROR_SEVERITY_FATAL, ERROR_CODE_STREAM_CALLBACK_STALLED, format!("audio stream callback remained stalled for consecutive ticks ({} callbacks total)", snapshot.callbacks)),
                    };
                    let callback_evt = daemon_error_event(severity, code, message);
                    if tx.send(to_json_or_fallback(&callback_evt)).await.is_err() {
                        break;
                    }
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

    // engine が異常終了すると RPC は原理的に届かない。read loop の終了そのものを第二 trigger
    // とする。ただし daemon は複数 session を受理し台帳は共有するため、途中の 1 接続ではなく
    // 最後の確立済み session が切れた時だけ単一配送関数で解放する（#606）。
    if session.disconnect() {
        let release_engine = engine.clone();
        match tokio::task::spawn_blocking(move || release_engine.plugin_all_notes_off()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                error!("plugin all-notes-off after session disconnect failed: {error}")
            }
            // 🔴 JoinError は「解放タスクが panic / cancel して**そもそも試みられていない**」ことを
            // 意味するので、部分的な配送失敗（上の腕）より軽く記録してはいけない。
            Err(error) => {
                error!("plugin all-notes-off task after session disconnect failed: {error}")
            }
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
