---
title: "RE-1. Daemon Architecture Overview"
chapter-id: "RE-1"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

# RE-1. Daemon Architecture Overview

OrbitScore's sound ultimately comes out of `orbit-audio-daemon` (Rust), a separate process. The
TS-side engine (`packages/engine`) is just a client that sends it commands over WebSocket. This
chapter surveys the daemon process structure, the boundary with the TS engine (the wire
protocol), the boot-to-teardown lifecycle, and the skeleton of the cpal real-time audio callback.

This chapter was first written on 2026-07-17 and re-read against commit `69dc968` on 2026-09-01.
In between, the daemon absorbed plugin UI (#474 / #633), replacement (#618 / #625), effect racks
(#628) and the mixer (#643), so both the command table and the shape of the callback changed
considerably.

## The boundary with the TS engine: WebSocket wire protocol

On startup, the daemon claims an audio device, binds a WebSocket listener to a free localhost
port, and writes that port number to stdout as a single line of JSON. The TS side reads this
line to connect. Let us look at `run()`. Compared with the 2026-07-17 version, the CLI handling for
`--list-audio-devices` / `--audio-device` (#484 D1 / D3) was added at the top, and engine startup
is delegated to a dedicated thread.

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

On startup failure, the daemon instead writes a single line of JSON to stderr
(`{"ready":false,"error":{...}}`) and exits with a non-zero code. The TS side determines
startup success or failure by which stream produced the one-line JSON.

A point to note here is step 1, `start_engine_with_device_switch()`. `cpal::Stream` is `!Send`,
so it cannot be carried into a tokio async task. `EngineWrap::start()` is therefore called on a
dedicated OS thread (the "audio owner thread"), which owns the `StreamGuard` for its lifetime
(the runtime device switch `SelectAudioDevice` is also delegated to this thread through an
`mpsc` channel — #484 D2).

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

Once the connection is established, the daemon first sends a handshake frame. After that, it
follows a request/response model: it receives a `Command` of shape `{id, method, params}` from
the TS side and returns either an `OkResponse` (`{id, result}`) or an `ErrorResponse`
(`{id, error}`). In addition, it can proactively push one-way `Event`s that have no `id`
(`PlayStarted` / `PlayEnded` / `StreamStats` / `DaemonError`, plus the `PluginUiClosed` family
introduced by #474). `PROTOCOL_VERSION` is `"0.2"`.

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

The comment at the top of the module states that the contract's source of truth is
`docs/research/ENGINE_DAEMON_PROTOCOL.md` — this module only defines the serialize/deserialize
types (`protocol.rs:1-4`).

## The session: handshake → writer task → forwarding UI events

One connection is handled by `session::run`. After sending the handshake, it spawns a writer task
that drains an `mpsc` channel. Since #474 there is one more task: it bridges the plugin UI events
(`PluginUiClosed` and friends) broadcast by the watchdog threads into the session's writer queue.

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:737-764
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
```

`method` dispatch is handled by `handle_command`. Plugin-note methods such as
`PluginNoteOn`/`PluginNoteOff` are first split off through a pure function, `plugin_note_spec`,
kept as the single point of truth, before falling through to the match — reflecting a lesson
learned that keeping the same string set in two independently-maintained places drifts.

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:1335-1362
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

### The command list (from the match arms of `handle_command`)

`Command` is a struct carrying `method: String`; it is not a Rust enum. The "list of commands"
is therefore whatever arms exist in `session.rs`'s `match method.as_str()`. As of 2026-09-01 the
arms are as follows (the notes column mentions the arms gated by a feature `cfg`).

| method | role | notes |
|---|---|---|
| `Ping` | liveness check (`"pong"`) | |
| `ListAudioDevices` | enumerate cpal output devices | #484 D1, runs under `spawn_blocking` |
| `SelectAudioDevice` | runtime device switch | #484 D2, delegated to the audio owner thread |
| `GetStatus` | daemon/protocol version, sample rate, `render_contentions`, etc. | |
| `LoadSample` / `UnloadSample` | register / release an audio file | |
| `RegisterLinkAudioChannel` / `SetLinkTempo` | LinkAudio egress | |
| `LoadPlugin` | attach a plugin (`role` / `bus` / `instance` / `state`) | the in-process build requires `role` |
| `ApplyEffectChain` | prepare-commit application of a whole rack (chain) | #628, `mode: diff / rebuild` |
| `ReplacePlugin` | replace a slot's tenant | #618 (instrument) / #625 (effect) |
| `UnloadPlugin` | remove an effect insert | `role='effect'` only |
| `GetPluginState` | save plugin state (sidecar file) | outproc builds only |
| `RenderScore` | offline render | `NOT_IMPLEMENTED` (#598 P2) |
| `OpenPluginUI` / `ClosePluginUI` / `AckUiSafepoint` | plugin UI windows | #474 / #633 |
| `PlayAt` / `Stop` / `StopAll` | schedule / stop playback | `PlayAt` accepts a `bus` tag |
| `SetGlobalGain` | master gain (with ramp) | fixed in #643 so it also affects instruments |
| `SetBusRouting` | runtime routing insert → sum/aux | `outproc-effect` builds only |
| `SetSourceRouting` | runtime routing instrument source → bus | `outproc-effect,outproc-instrument` builds only |
| `InjectFault` | panic injection for kill tests | only with `ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` |
| `PluginNoteOn` / `PluginNoteOff` | notes to an instrument | via `plugin_note_spec` (outside the match) |

The "fixed in #643" note on the `SetGlobalGain` row refers to the defect recorded in WORK_LOG
6.415: the master fader was not affecting instruments. That the very same command was caught by
the capture E2E is discussed in the [`capture-verification`](/en/rust-engine/capture-verification)
chapter.

## Boot-to-teardown lifecycle

`server::serve` is the accept loop: for every connection it spawns an independent task that
hands off to `session::run`.

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

The teardown side has a known gap, documented in a comment referencing Issue #448. This daemon
has no SIGTERM/SIGINT handler, and its panic hook calls `process::exit(1)` directly, so under
either a normal client-side `SIGTERM → SIGKILL` stop or a panic, the `Drop` impls of
`InstrumentChildSupervisor` / `EffectChildSupervisor` (which send `CONTROL_QUIT` to
out-of-process children) never run, and the child processes can be orphaned.

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

The primary defense against this daemon-side shutdown gap lives on the child side
(`ParentWatch`, which lets a child detect its parent's death on its own) — covered in the
[RE-2](/en/rust-engine/oop-children) chapter.

Incidentally, the panic hook itself was rewritten in #605. If stderr is broken, an `eprintln!`
inside the hook panics again, the recursion detector calls `process::abort()`, and the client
sees SIGABRT instead of exit code 1 — so the hook now writes through `write_line_best_effort`
(`main.rs:64-74`).

## The real-time audio callback

The actual sound comes from the cpal callback in the `orbit-audio-native` crate. On 2026-07-17
the callback body was a single function, `render_block`; as of 2026-09-01 it has two layers.

1. `render_shared_block` — the entry point called directly from the cpal closure. It takes the
   `RenderState` (insert buses, instrument sources, the master post-processor, …) through a
   `Mutex` `try_lock`; if the lock is unavailable it **zero-fills the block and counts a
   `record_render_contention`** (so the RT thread never blocks).
2. `render_block_with_sources` — the body that runs once the lock is held. The old `render_block`
   survives only as a thin `#[cfg(test)]` wrapper.

`RenderState` lives behind a `Mutex` so that the callback state can be carried over when
`SelectAudioDevice` (#484 D2) rebuilds the cpal stream (see the comment on
`OutputStream::render_state`).

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

The number of failed `try_lock`s accumulates in `StreamStats` and can be read as
`render_contentions` from `GetStatus`. "No lock means one dropped block" is a deliberate design
choice, and the contention is self-healing (the next block recovers).

The body, `render_block_with_sources`, proceeds in order: engine render → master post-processor →
capture tap → record the callback duration. `post`/`capture`/`cb_stats` are each independent
opt-ins, and the invariant that the path is bit-identical to the legacy path when all are `None`
still stands.

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

The engine-render part, `render_engine_with_sources`, splits four ways depending on whether there
are instrument sources (`SourceSlot`s that hold an OOP instrument's output as a `BlockSource`)
and whether any insert bus is active. With no
source and no active bus it falls back to the legacy `render_engine`.

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

`build_stream` calls this `render_shared_block` directly from cpal's `build_output_stream`
closure. There are three closures, one per sample format (`F32`/`I16`/`I32`); the non-`F32`
variants render into a pre-allocated scratch buffer before quantizing (the scratch buffer is
pre-sized for one second up front, avoiding heap allocation on the RT hot path).

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

This "bit-identical when unused" design principle also applies consistently to the insert-bus
path covered in [RE-3](/en/rust-engine/insert-bus) and the `ORBIT_CAPTURE_WAV` capture seam in
[RE-4](/en/rust-engine/capture-verification).

The overall architecture decision behind the daemon (instruments = in-process; effects/3rd-party
= out-of-process sandbox) is recorded in `docs/development/POST_2.0_MASTER_PLAN.html`:

> 楽器（サンプラー/audio DSL）= in-process（crown jewel）／ effects + 3rd-party =
> out-of-process sandboxed plugin ／ audio DSL ⊇ pitch DSL
>
> (Instruments (sampler / audio DSL) = in-process (crown jewel) / effects + 3rd-party =
> out-of-process sandboxed plugin / audio DSL ⊇ pitch DSL)

## Try it: boot the daemon and play a single note (capture peak verification)

Setting the `ORBIT_CAPTURE_WAV` environment variable when starting the daemon activates the
capture tap in `render_block_with_sources` (see the code above), writing the final post-processed
hardware samples out to a WAV file. Procedure (assuming a distribution-configuration release
daemon + `cli-audio.js`):

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture-test.wav node cli-audio.js path/to/single-note.orbs
```

**Expected value (verified on real hardware, 2026-07-17)**: playing
`test-assets/audio/sine_880.wav` (a sine of amplitude 1.0) once yields a measured capture-WAV
peak of **0.70711** (= 1.0 × the equal-power center-pan gain √0.5; the engine applies
equal-power panning, so a mono asset's capture peak is its amplitude × √0.5). For the plugin
oracles, clap-test-synth's known amplitude 0.25 is observed as exactly **0.25000** in the
capture (WORK_LOG 6.258 / 6.262 — also matching the gated tests' `post_mix_peak` stats,
i.e. two independent measurement paths agreeing at the same tap point). These figures are the
2026-07-17 measurements; they were not re-run during the 2026-09-01 re-read.

## Next exploration candidates

- The implementation of `SelectAudioDevice` (`EngineWrap::apply_device_switch`) — rebuilding the cpal stream and carrying `RenderState` across
- The full list of `DaemonError`s fired by the `StreamStats` 1 Hz ticker (the error-code constants in `protocol.rs:86-161`) and where each is observed
- The `RenderScore` (#598 P2) offline render path
- Lag handling in `forward_plugin_ui_events` (how loss-sensitive close/safepoint frames are treated)

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-265` — daemon entry point. Boot sequence (CLI args → audio owner thread → bind WebSocket → emit ready line → accept loop), panic hook (#605), known shutdown gap (#448)
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop (`bind_localhost` / `serve` / `handle_connection`)
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-195` — wire protocol type definitions (`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / error code constants). Contract source of truth: `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:691-718,1272-2372` — `session::run` (handshake, writer task, UI event forwarding) and the `handle_command` match arms (source of the command table)
- `rust/crates/orbit-audio-native/src/output.rs:254-260,581-618,662-750,1513-1556` — `RenderState` / `render_shared_block` / `render_block_with_sources` / `render_engine_with_sources` / `build_stream`
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first roadmap and architecture decision (instruments = in-process / effects + 3rd-party = out-of-process sandbox)
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 / 6.262 — capture peak measurements
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 — the master fader defect (#643)
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon graceful-shutdown gap and the `ParentWatch` countermeasure
- Issue [#484](https://github.com/signalcompose/orbitscore/issues/484) — audio device enumeration, selection and runtime switching (D1 / D2 / D3)
- Issue [#605](https://github.com/signalcompose/orbitscore/issues/605) — best-effort stderr in the panic hook
