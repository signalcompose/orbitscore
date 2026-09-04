---
title: "RE-1. daemon アーキテクチャ概観"
chapter-id: "RE-1"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-1. daemon アーキテクチャ概観

OrbitScore の音は最終的に `orbit-audio-daemon`（Rust）という独立プロセスが鳴らします。TS 側の
engine（`packages/engine`）はこの daemon に WebSocket 経由でコマンドを送るクライアントに過ぎません。
本章では daemon プロセスの構造、TS engine との境界（wire protocol）、boot〜teardown のライフ
サイクル、そして cpal のリアルタイム audio callback の骨格を鳥瞰します。

この章は 2026-07-17 に一度書いたものを、2026-09-01 の commit `69dc968` に合わせて読み直したものです。
その間に daemon は「plugin UI（#474 / #633）」「差し替え（#618 / #625）」「effect rack（#628）」
「mixer（#643）」を吸収しており、コマンド表と callback の形が大きく変わりました。

## TS engine との境界: WebSocket wire protocol

daemon は起動すると audio device を確保し、localhost の空きポートに WebSocket listener を bind
して、その port 番号を stdout に 1 行 JSON で出力します。TS 側はこの行を読んで接続します。
`run()` を見てみましょう。2026-07-17 時点の版と比べると、先頭に `--list-audio-devices` /
`--audio-device` の CLI 処理（#484 D1 / D3）が増え、Engine の起動が専用スレッドへ委譲されています。

```rust
// rust/crates/orbit-audio-daemon/src/main.rs:78-133
async fn run() -> Result<(), i32> {
    // -1. `--list-audio-devices`（#484 D3）: cpal 列挙のみ行い stdout に JSON 一覧を出して即 exit
    // する軽量モード。stream は開かない（ハングリスクを避ける・上の `resolve_output_device` の
    // Aggregate デバイス probe 回避コメント参照）。通常起動（WebSocket listener bind・accept loop）
    // には進まない。
    if has_list_audio_devices_flag(std::env::args().skip(1)) {
        return run_list_audio_devices();
    }

    // 0. `--audio-device <name>` を解析し、`ORBIT_AUDIO_DEVICE` env へ反映する（#484 D1）。
    // 実際の device 解決（列挙・一致判定・不一致時の縮退警告）は `orbit-audio-native`
    // 側（`resolve_output_device`）が cpal I/O を伴って行う。ここでは env に橋渡しするだけ
    // （`engine_wrap::device_name_from_env` が capture_path_from_env と同じ層分けで読む）。
    apply_audio_device_arg(std::env::args().skip(1));

    // 1. Engine を起動（audio device 取得）。ランタイム device switch（#484 D2）に備え、実際の
    // `EngineWrap::start()` 呼び出しと `StreamGuard` の生存管理を専用 OS thread（"audio owner
    // thread"）へ委譲する — `cpal::Stream` は `!Send` なので、以降 tokio worker 間を自由に飛び回る
    // 通常の async task にはハンドルを一切持ち込めない。
    let engine = match start_engine_with_device_switch() {
        Ok(e) => e,
        Err(e) => {
            report_startup_failure(ProtocolError::new("DEVICE_CONFIG_ERROR", e.to_string()));
            return Err(1);
        }
    };

    // 2. WebSocket listener bind
    let bound = match server::bind_localhost().await {
        Ok(b) => b,
        Err(e) => {
            report_startup_failure(ProtocolError::new("INTERNAL_ERROR", e.to_string()));
            return Err(2);
        }
    };
    let port = bound.addr.port();

    // 3. stdout に ready line を出力（改行 + flush）
    let ready = StartupReady {
        ready: true,
        port,
        protocol_version: PROTOCOL_VERSION,
    };
    let line = serde_json::to_string(&ready).unwrap_or_else(|_| {
        format!(r#"{{"ready":true,"port":{port},"protocol_version":"{PROTOCOL_VERSION}"}}"#)
    });
    println!("{line}");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    tracing::info!("orbit-audio-daemon listening on 127.0.0.1:{port}");

    // 4. accept loop
    server::serve(bound.listener, engine).await;
    Ok(())
}
```

起動失敗時は逆に stderr に 1 行 JSON（`{"ready":false,"error":{...}}`）を書いて非ゼロ exit code
で終了します。TS 側は stdout/stderr のどちらの 1 行 JSON かで起動成否を判定する契約です。

ここで気をつけたいのは step 1 の `start_engine_with_device_switch()` です。`cpal::Stream` は
`!Send` なので tokio の async task には持ち込めません。そこで `EngineWrap::start()` を
「audio owner thread」という専用 OS thread の上で呼び、その thread が `StreamGuard` を生涯所有します
（ランタイムの device 切替 `SelectAudioDevice` もこの thread に `mpsc` で委譲されます・#484 D2）。

```rust
// rust/crates/orbit-audio-daemon/src/main.rs:135-146
/// ランタイム device switch（#484 D2）: `EngineWrap::start()`（cpal I/O・`cpal::Stream` は `!Send`）を
/// 専用 OS thread（"audio owner thread"）上で実行し、その thread に `StreamGuard` を生涯所有させる。
/// 呼び出し元（`run()`・tokio 上の async fn）は `Arc<EngineWrap>`（`Send + Sync`）だけを受け取る。
///
/// 以後の `SelectAudioDevice` RPC は `EngineWrap::select_audio_device` → `mpsc` 経由でこの thread に
/// 委譲され、この thread が [`EngineWrap::apply_device_switch`] で実際の cpal `Device`/`Stream` 差し替え
/// を行う。thread は `switch_rx` が close する（= `engine.device_switch_tx` を保持する最後の `Arc`
/// が drop される）まで無期限に生存し、`_guard`（`StreamGuard`）を握り続ける — 既存の「`main()` の
/// ローカル変数が daemon プロセス終了まで guard を握る」という寿命モデルと同一。
fn start_engine_with_device_switch() -> Result<Arc<EngineWrap>, WrapError> {
    let (switch_tx, switch_rx) = std::sync::mpsc::channel::<DeviceSwitchRequest>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Arc<EngineWrap>, WrapError>>();
```

接続確立後、daemon はまず handshake フレームを送ります。その後は `{id, method, params}` 形式の
`Command` を TS 側から受け、`{id, result}` の `OkResponse` か `{id, error}` の `ErrorResponse`
を返す request/response モデルです。加えて、`id` を持たない一方向の `Event`（`PlayStarted` /
`PlayEnded` / `StreamStats` / `DaemonError` に加え、#474 で入った `PluginUiClosed` 系）を
daemon から能動的に push できます。`PROTOCOL_VERSION` は `"0.2"` です。

```rust
// rust/crates/orbit-audio-daemon/src/protocol.rs:8-61
pub const PROTOCOL_VERSION: &str = "0.2";
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
// ...
/// Handshake フレーム（接続後に daemon が最初に送る）。
#[derive(Debug, Serialize)]
pub struct Handshake {
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub protocol_version: &'static str,
    pub daemon_version: &'static str,
    pub capabilities: Vec<&'static str>,
}

impl Handshake {
    pub fn current() -> Self {
        Self {
            type_: "handshake",
            protocol_version: PROTOCOL_VERSION,
            daemon_version: DAEMON_VERSION,
            capabilities: vec!["playback", "src"],
        }
    }
}

/// Client → Daemon の command。
#[derive(Debug, Deserialize)]
pub struct Command {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Daemon → Client の response（成功）。
#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub id: String,
    pub result: serde_json::Value,
}

/// Daemon → Client の response（失敗）。
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub id: String,
    pub error: ProtocolError,
}

#[derive(Debug, Serialize)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
```

```rust
// rust/crates/orbit-audio-daemon/src/protocol.rs:73-81
// Event / error code constants. Shared across session and panic-hook paths so the
// wire schema is produced from a single source.
pub const EVENT_DAEMON_ERROR: &str = "DaemonError";
pub const EVENT_STREAM_STATS: &str = "StreamStats";
pub const EVENT_PLAY_STARTED: &str = "PlayStarted";
pub const EVENT_PLAY_ENDED: &str = "PlayEnded";
pub const EVENT_PLUGIN_UI_CLOSED: &str = "PluginUiClosed";
pub const EVENT_PLUGIN_UI_CLOSE_DONE: &str = "PluginUiCloseDone";
pub const EVENT_PLUGIN_UI_CLOSED_BY_RESPAWN: &str = "PluginUiClosedByRespawn";
```

契約自体の正本は `docs/research/ENGINE_DAEMON_PROTOCOL.md` で、`protocol.rs` はそのシリアライズ
/デシリアライズ用の型を定義するだけ、とコメントで明言されています（`protocol.rs:1-4`）。

## session: handshake → writer task → UI event の転送

接続 1 本ぶんの処理は `session::run` です。handshake を送ったあと、`mpsc` を受ける writer task を
spawn します。#474 以降はもう 1 本、watchdog thread が broadcast する plugin UI イベント
（`PluginUiClosed` 等）を session の writer queue へ橋渡しする task が増えています。

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:691-718
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
```

`method` の dispatch は `handle_command` が担います。`PluginNoteOn`/`PluginNoteOff` のような
plugin note 系 method は `plugin_note_spec` という純関数を「唯一の判定箇所」として先に分離してから
match に落とす設計です（2 箇所で同じ文字列集合を独立管理すると drift するという教訓が反映されています）。

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:1272-1299
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
```

### コマンド一覧（`handle_command` の match arm から）

`Command` は `method: String` を持つ構造体で、Rust の enum ではありません。したがって「コマンドの
一覧」は `session.rs` の `match method.as_str()` の arm を数えたものになります。2026-09-01 時点で
arm は次のとおりです（`cfg` 列は feature で分岐する arm）。

| method | 役割 | 備考 |
|---|---|---|
| `Ping` | 疎通確認（`"pong"`） | |
| `ListAudioDevices` | cpal の output device 列挙 | #484 D1・`spawn_blocking` |
| `SelectAudioDevice` | ランタイム device 切替 | #484 D2・audio owner thread へ委譲 |
| `GetStatus` | daemon/protocol version・sample rate・`render_contentions` 等 | |
| `LoadSample` / `UnloadSample` | audio file の登録 / 解除 | |
| `RegisterLinkAudioChannel` / `SetLinkTempo` | LinkAudio egress | |
| `LoadPlugin` | plugin の attach（`role` / `bus` / `instance` / `state`） | in-process build は `role` 必須 |
| `ApplyEffectChain` | ラック（チェーン全体）の prepare-commit 適用 | #628・`mode: diff / rebuild` |
| `ReplacePlugin` | slot tenant の差し替え | #618（instrument）/ #625（effect） |
| `UnloadPlugin` | effect insert の削除 | `role='effect'` のみ |
| `GetPluginState` | plugin state の保存（sidecar） | outproc build のみ |
| `RenderScore` | offline render | `NOT_IMPLEMENTED`（#598 P2） |
| `OpenPluginUI` / `ClosePluginUI` / `AckUiSafepoint` | plugin UI window | #474 / #633 |
| `PlayAt` / `Stop` / `StopAll` | 再生のスケジュール / 停止 | `PlayAt` は `bus` tag を取れる |
| `SetGlobalGain` | master gain（ramp 付き） | #643 で instrument にも効くよう修正 |
| `SetBusRouting` | insert → sum/aux の実行時ルーティング | `outproc-effect` build のみ |
| `SetSourceRouting` | instrument source → bus の実行時ルーティング | `outproc-effect,outproc-instrument` build のみ |
| `InjectFault` | kill-test 用の panic 注入 | `ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ |
| `PluginNoteOn` / `PluginNoteOff` | instrument への note | `plugin_note_spec` 経由（match の外） |

`SetGlobalGain` の行の「#643 で修正」は、WORK_LOG 6.415 に記録された「master fader が instrument に
効いていなかった」不具合の修正を指します。同じ command が RE-4 で扱う capture E2E で捕まった、
という経緯は [`capture-verification`](/rust-engine/capture-verification) 章で触れます。

## boot 〜 teardown ライフサイクル

`server::serve` は accept loop で、接続ごとに独立タスクを spawn し `session::run` に処理を渡します。

```rust
// rust/crates/orbit-audio-daemon/src/server.rs:24-70
/// accept loop。各接続ごとに新タスクを spawn し、[`session::run`] で処理する。
///
/// accept エラーはすべて永続化し得るため、短い backoff を挟んで tight spin を防ぐ。
pub async fn serve(listener: TcpListener, engine: Arc<EngineWrap>) {
    use std::io::ErrorKind;
    use tokio::time::{sleep, Duration};

    let mut consecutive_errors: u32 = 0;
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(s) => {
                consecutive_errors = 0;
                s
            }
            Err(e) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                match e.kind() {
                    // リソース枯渇系: 長めに待って諦め条件も設定
                    ErrorKind::OutOfMemory => {
                        tracing::error!("accept fatal (out of memory): {e}, exiting");
                        return;
                    }
                    _ => {
                        warn!("accept error: {e} (consecutive={consecutive_errors})");
                    }
                }
                if consecutive_errors >= 20 {
                    tracing::error!(
                        "accept error persists for {} attempts, exiting",
                        consecutive_errors
                    );
                    return;
                }
                // Tight spin 防止: 100ms backoff
                sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        info!("accepted connection from {peer}");
        let engine_for_task = engine.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, engine_for_task).await {
                warn!("connection closed with error: {e}");
            }
        });
    }
}
```

teardown 側には既知のギャップがコメントで明記されています（Issue #448）。この daemon は
SIGTERM/SIGINT ハンドラを持たず、panic hook も `process::exit(1)` を直接呼ぶため、通常の
client 側 `SIGTERM → SIGKILL` 停止や panic では `InstrumentChildSupervisor` /
`EffectChildSupervisor` の `Drop`（out-of-process child への `CONTROL_QUIT` 送出）が実行されず、
child プロセスが孤児化し得ます。

```rust
// rust/crates/orbit-audio-daemon/src/main.rs:21-30
// 既知事項（#448）: この daemon には SIGTERM/SIGINT ハンドラが無く、`install_fatal_panic_hook`
// の panic hook も `process::exit(1)` を hook 内から直接呼ぶ（unwind が supervisor 保持フレーム
// まで届く前に終了する）。そのため通常の client 側 `SIGTERM → SIGKILL` 停止（daemon-client.ts
// `killChildGracefully`）や panic では、`InstrumentChildSupervisor` / `EffectChildSupervisor` の
// `Drop`（CONTROL_QUIT 送出）が実行されず、out-of-process CLAP/VST3 child が孤児化し得る。
// `server::serve` の accept loop 内タスクが `Arc<EngineWrap>` を clone して保持するため、
// main() のローカル drop だけでは決定論的な shutdown にならず、まとまった graceful-shutdown
// 配線（signal → 全 clone 収束待ち → drop）が必要になる（本 issue のスコープ外・別 issue 向き）。
// 本 issue の本命防御は child 側（[`orbit_audio_sandbox::ParentWatch`]）: どの死に方でも
// child が親の死亡を自力で検知して抜けるため、この daemon 側ギャップの実害を軽減する。
```

この daemon 側 shutdown の穴に対する本命の防御策が child 側の `ParentWatch`（親プロセスの生死を
child 自身が監視する仕組み）で、[RE-2](/rust-engine/oop-children) 章で扱います。

ちなみに panic hook 自身も #605 で書き換えられています。stderr が壊れている状況で `eprintln!` を
使うと panic hook の中で panic して `process::abort()` に落ち、client が exit code 1 ではなく
SIGABRT を見てしまう — そのため `write_line_best_effort` を使う形になっています（`main.rs:64-74`）。

## リアルタイム audio callback

音の実体は `orbit-audio-native` crate の cpal callback から出ます。2026-07-17 時点では callback 本体が
`render_block` という 1 関数でしたが、2026-09-01 時点では 2 層になっています。

1. `render_shared_block` — cpal のクロージャから直接呼ばれる入口。`RenderState`（insert bus・
   instrument source・master post-processor 等）を `Mutex` の `try_lock` で取り、取れなければ
   **zero-fill して `record_render_contention` を数える**（RT thread で block しないため）。
2. `render_block_with_sources` — lock が取れたときの本体。従来の `render_block` は `#[cfg(test)]` の
   薄い wrapper として残っています。

`RenderState` を `Mutex` に入れているのは、`SelectAudioDevice`（#484 D2）で cpal stream を作り直しても
callback 側の状態を引き継ぐためです（`OutputStream::render_state` のコメント参照）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:254-260
pub struct RenderState {
    link: Option<LinkEgress>,
    insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    transport: BlockTransport,
    post: Option<Box<dyn PostProcessor>>,
}
```

```rust
// rust/crates/orbit-audio-native/src/output.rs:581-618
/// 1 callback 分の処理（計測 + engine render + master-bus post-processor）。
#[inline]
fn render_shared_block(
    engine: &Engine,
    state: &Arc<std::sync::Mutex<RenderState>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
    stats: &StreamStats,
) {
    match state.try_lock() {
        Ok(mut state) => {
            let RenderState {
                link,
                insert_buses,
                sources,
                transport,
                post,
            } = &mut *state;
            render_block_with_sources(
                engine,
                link,
                insert_buses,
                sources,
                transport,
                post,
                capture,
                cb_stats,
                output_channels,
                hw,
            )
        }
        Err(_) => {
            hw.fill(0.0);
            stats.record_render_contention();
        }
    }
```

`try_lock` が外れた回数は `StreamStats` に積まれ、`GetStatus` の `render_contentions` として読めます。
「lock が取れない = 音が 1 block 落ちる」という設計判断は明示的なもので、後述の contention は
自己修復します（次の block で戻る）。

本体の `render_block_with_sources` は、engine render → master post-processor → capture tap →
callback 所要時間の記録、という順に進みます。`post`/`capture`/`cb_stats` はそれぞれ独立した
opt-in で、すべて `None` なら従来経路とビット同一、という不変条件はそのまま残っています。

```rust
// rust/crates/orbit-audio-native/src/output.rs:662-707
fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    post: &mut Option<Box<dyn PostProcessor>>,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    // Instant::now() は macOS では mach_absolute_time（lock/alloc なし）= RT 許容。A0 §6 に基づき
    // production RT 監視を callback-duration ベースにするための計測（cb_stats 有り時のみ）。
    let t0 = cb_stats.as_ref().map(|_| Instant::now());

    // active な bus が 1 つも無ければ既存の呼び出し列をそのまま維持する（bit-identical）。
    // 既定 bus プール（全 stage inactive で起動）はここで従来経路に落ちるため、
    // `seq.effect()` 未使用セッションに RT コストを課さない。
    render_engine_with_sources(
        engine,
        link,
        insert_buses,
        sources,
        transport,
        output_channels,
        hw,
    );

    // master-bus post-processor（CLAP）。engine render 済みの hardware sum を in-place 変換。
    if let Some(p) = post.as_mut() {
        p.process(hw);
    }

    // capture seam（#307 realtime）: post 適用後の最終 hw（= device に出る実信号）を WAV へ逃がす
    // 読み取り専用 tap。`RingTapSink::commit` は wait-free / no-alloc（満杯時はあふれを drop カウント）
    // ＝ RT 契約を満たす。off-thread writer が ring を drain する。post の後・計測の内側に置くことで
    // capture コストも callback-duration に含めて監視する。
    if let Some(sink) = capture.as_mut() {
        sink.commit(hw);
    }

    if let (Some(stats), Some(t0)) = (cb_stats, t0) {
        stats.record(t0.elapsed().as_nanos() as u64);
    }
}
```

engine render 部分の `render_engine_with_sources` は、instrument source（OOP instrument の出力を
`BlockSource` として持つ `SourceSlot`）と insert bus の有無で
4 通りに分かれます。source も active bus も無ければ、従来の `render_engine` に落ちます。

```rust
// rust/crates/orbit-audio-native/src/output.rs:709-750
#[inline]
fn render_engine_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
) {
    let frames = hw.len() / output_channels;

    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses(engine, link, buses, output_channels, hw);
        } else {
            render_engine(engine, link, output_channels, hw);
        }
    } else {
        let rendered_units = render_sources(sources, frames, transport);
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                sources,
                &rendered_units,
                output_channels,
                hw,
            );
        } else {
            render_engine_with_source_outputs(
                engine,
                link,
                sources,
                &rendered_units,
                output_channels,
                hw,
            );
        }
    }

```

`build_stream` はこの `render_shared_block` を cpal の `build_output_stream` クロージャから直接
呼びます。サンプルフォーマット（`F32`/`I16`/`I32`）ごとに 3 通りのクロージャがあり、`F32` 以外は
事前確保した scratch buffer に render してから量子化します（RT hot path でのヒープ確保を
避けるため、scratch buffer は 1 秒分をあらかじめ確保しています）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:1539-1556
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    render_shared_block(
                        &engine,
                        &render_state,
                        &mut capture,
                        &cb_stats,
                        out_ch,
                        data,
                        &callback_stats,
                    )
                },
                make_err_fn(stats.clone()),
                None,
            )
```

この「未使用時はビット同一」という設計原則は、[RE-3](/rust-engine/insert-bus) で扱う insert bus 経路や、
[RE-4](/rust-engine/capture-verification) の `ORBIT_CAPTURE_WAV` capture seam にも一貫して適用されています。

daemon 全体のアーキテクチャ確定（楽器=in-process・effects/3rd-party=out-of-process sandbox）の
背景は `docs/development/POST_2.0_MASTER_PLAN.html` に記載があります。

> 楽器（サンプラー/audio DSL）= in-process（crown jewel）／ effects + 3rd-party =
> out-of-process sandboxed plugin ／ audio DSL ⊇ pitch DSL

## Try it: daemon を起動して単音を鳴らす（capture peak 検証）

`ORBIT_CAPTURE_WAV` 環境変数を daemon 起動時に設定すると、`render_block_with_sources` の capture tap
（上記コード参照）が有効化され、post-processor 適用後の最終 hardware サンプルを WAV へ書き出します。
手順（配布構成の release daemon + `cli-audio.js` 前提）:

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture-test.wav node cli-audio.js path/to/single-note.orbs
```

**期待値（実機検証済み・2026-07-17）**: `test-assets/audio/sine_880.wav`（振幅 1.0 の sine）を
1 発再生した capture WAV の実測 peak は **0.70711**（= 1.0 × equal-power pan center の
√0.5。engine は center pan に equal-power gain を掛けるため、モノラル素材の capture peak は
素材振幅 × √0.5 になります）。plugin oracle 系では clap-test-synth の既知振幅 0.25 が capture でも
**0.25000** ちょうどで観測されます（WORK_LOG 6.258 / 6.262・gated テストの stats
`post_mix_peak` とも一致 = 同一 tap 点の相互検証）。この数値は 2026-07-17 の実測で、
2026-09-01 の再読では再実行していません。

## 次の深掘り候補

- `SelectAudioDevice` の実装（`EngineWrap::apply_device_switch`）— cpal stream の再構築と `RenderState` の引き継ぎ
- `StreamStats` 1 Hz ticker が発火する `DaemonError` の一覧（`protocol.rs:86-161` のエラーコード群）と、それぞれの観測点
- `RenderScore`（#598 P2）の offline render 経路
- `forward_plugin_ui_events` の lag 処理（loss-sensitive な close/safepoint frame をどう扱うか）

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-265` — daemon エントリポイント。boot シーケンス（CLI 引数 → audio owner thread → WebSocket bind → ready line 出力 → accept loop）と panic hook（#605）、既知の shutdown ギャップ（#448）
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop（`bind_localhost` / `serve` / `handle_connection`）
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-195` — wire protocol の型定義（`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / エラーコード定数）。契約の正本は `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:691-718,1272-2372` — `session::run`（handshake・writer task・UI event 転送）と `handle_command` の match arm（コマンド表の出典）
- `rust/crates/orbit-audio-native/src/output.rs:254-260,581-618,662-750,1513-1556` — `RenderState` / `render_shared_block` / `render_block_with_sources` / `render_engine_with_sources` / `build_stream`
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first ロードマップとアーキ確定（楽器=in-process／effects+3rd-party=out-of-process sandbox）
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 / 6.262 — capture peak の実測記録
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 — master fader 不具合（#643）
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon の graceful-shutdown ギャップと `ParentWatch` 対策
- Issue [#484](https://github.com/signalcompose/orbitscore/issues/484) — audio device の列挙・選択・ランタイム切替（D1 / D2 / D3）
- Issue [#605](https://github.com/signalcompose/orbitscore/issues/605) — panic hook の best-effort stderr 化
