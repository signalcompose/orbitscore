---
title: "RE-1. Daemon Architecture Overview"
chapter-id: "RE-1"
verified-against: 183b612
verified-at: "2026-09-10"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01, brought up to the master line introduced by #649 PR-O2 ([#754](https://github.com/signalcompose/orbitscore/pull/754)) on 2026-09-05, and to the startup shm sweep of #779 ([#784](https://github.com/signalcompose/orbitscore/pull/784)) on 2026-09-06, and to the direct device line of #611 PR-O3a ([#811](https://github.com/signalcompose/orbitscore/pull/811)) on 2026-09-08, and to the `SetBusLine` wire contract and the two master line paths of #611 PR-O3b ([#824](https://github.com/signalcompose/orbitscore/pull/824)) on 2026-09-10. The code is the truth; this page is only a snapshot of understanding at that time.

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
is delegated to a dedicated thread. On 2026-09-06 a further stage (0.5) was added that reclaims
shared memory left behind by dead daemons **before the first shm is created** (#779); that ordering
is what makes the "delete leftovers carrying my own PID" rule sound.

```rust
// rust/crates/orbit-audio-daemon/src/main.rs:78-136
async fn run() -> Result<(), i32> {
    // -1. `--list-audio-devices`（#484 D3）: cpal 列挙のみ行い stdout に JSON 一覧を出して即 exit
    // する軽量モード。stream は開かない（ハングリスクを避ける・上の `resolve_output_device` の
    // Aggregate デバイス probe 回避コメント参照）。通常起動（WebSocket listener bind・accept loop）
    // には進まない。
    if has_list_audio_devices_flag(std::env::args().skip(1)) {
        return run_list_audio_devices();
    }

    // 0. CLI と gated fault env を一度だけ typed options に解決する。device 名を process-global env
    // へ書き戻さないため、並行する owner thread も同じ immutable 値を受け取る。
    let startup_options = StartupOptions::from_env();

    // 0.5. この daemon が最初の shm を作る前に、死亡した旧 daemon の shm を回収する。
    orbit_audio_daemon::outproc_shm_sweep::sweep_orphaned_outproc_shm();

    // 1. Engine を起動（audio device 取得）。ランタイム device switch（#484 D2）に備え、実際の
    // `EngineWrap::start()` 呼び出しと `StreamGuard` の生存管理を専用 OS thread（"audio owner
    // thread"）へ委譲する — `cpal::Stream` は `!Send` なので、以降 tokio worker 間を自由に飛び回る
    // 通常の async task にはハンドルを一切持ち込めない。
    let engine = match start_engine_with_device_switch(startup_options) {
        Ok(e) => e,
        Err(e) => {
            report_startup_failure(ProtocolError::new("DEVICE_CONFIG_ERROR", e.to_string()));
            return Err(1);
        }
    };
    let output = engine.stream_config_snapshot();
    if let Some(reason) = &output.fallback_reason {
        tracing::warn!(
            "audio device fallback: requested {:?} -> using {:?}: {}",
            output.device_requested,
            output.device_name,
            reason
        );
    }
    tracing::info!(
        "audio output {:?} @ {} Hz x {}ch (first callback {} ms)",
        output.device_name,
        output.sample_rate,
        output.channels,
        output.first_callback_ms
    );

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
// rust/crates/orbit-audio-daemon/src/main.rs:152-163
/// ランタイム device switch（#484 D2）: `EngineWrap::start()`（cpal I/O・`cpal::Stream` は `!Send`）を
/// 専用 OS thread（"audio owner thread"）上で実行し、その thread に `StreamGuard` を生涯所有させる。
/// 呼び出し元（`run()`・tokio 上の async fn）は `Arc<EngineWrap>`（`Send + Sync`）だけを受け取る。
///
/// 以後の `SelectAudioDevice` RPC は `EngineWrap::select_audio_device` → `mpsc` 経由でこの thread に
/// 委譲され、この thread が [`EngineWrap::apply_device_switch`] で実際の cpal `Device`/`Stream` 差し替え
/// を行う。thread は `switch_rx` が close する（= `engine.device_switch_tx` を保持する最後の `Arc`
/// が drop される）まで無期限に生存し、`_guard`（`StreamGuard`）を握り続ける — 既存の「`main()` の
/// ローカル変数が daemon プロセス終了まで guard を握る」という寿命モデルと同一。
fn start_engine_with_device_switch(
    startup_options: StartupOptions,
) -> Result<Arc<EngineWrap>, WrapError> {
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
// rust/crates/orbit-audio-daemon/src/session.rs:986-1013
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
// rust/crates/orbit-audio-daemon/src/session.rs:1602-1629
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
arms are as follows (the notes column mentions the arms gated by a feature `cfg`; only the
`SetBusLine` row was added later, by #611 PR-O3b on 2026-09-10).

| method | role | notes |
|---|---|---|
| `Ping` | liveness check (`"pong"`) | |
| `ListAudioDevices` | enumerate cpal output devices | #484 D1, runs under `spawn_blocking` |
| `SelectAudioDevice` | runtime device switch | #484 D2, delegated to the audio owner thread; #661 probes the candidate first |
| `GetStatus` | daemon/protocol version, sample rate, `render_contentions`, etc. | #661 added `output` (the device actually playing, plus the fallback history) and `callback` (the liveness counter) |
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
| `SetBusLine` | **replace one bus's whole ordered audio line** | #611 PR-O3b, `outproc-effect` builds only (otherwise `UNSUPPORTED`). **No TS caller sends it yet** |
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

Processes are not the only thing left orphaned. When `Drop` does not run, neither does the removal
of the shm file, so the shared memory used for out-of-process children stays behind in `$TMPDIR`.
Stage 0.5 above is what reclaims it at startup (#779); the decision rules, and why the count does
not converge on zero, are covered in the "Reclaiming orphaned shm at startup" section of
[RE-2](/en/rust-engine/oop-children).

Incidentally, the panic hook itself was rewritten in #605. If stderr is broken, an `eprintln!`
inside the hook panics again, the recursion detector calls `process::abort()`, and the client
sees SIGABRT instead of exit code 1 — so the hook now writes through `write_line_best_effort`
(`main.rs:64-74`).

## The real-time audio callback

The actual sound comes from the cpal callback in the `orbit-audio-native` crate. On 2026-07-17
the callback body was a single function, `render_block`; as of 2026-09-01 it has two layers.

1. `render_shared_block` — the entry point called directly from the cpal closure. It takes the
   `RenderState` (insert buses, instrument sources, the master line, …) through a
   `Mutex` `try_lock`; if the lock is unavailable it **zero-fills the block and counts a
   `record_render_contention`** (so the RT thread never blocks).
2. `render_block_with_sources` — the body that runs once the lock is held. The old `render_block`
   survives only as a thin `#[cfg(test)]` wrapper.

`RenderState` lives behind a `Mutex` so that the callback state can be carried over when
`SelectAudioDevice` (#484 D2) rebuilds the cpal stream (see the comment on
`OutputStream::render_state`).

```rust
// rust/crates/orbit-audio-native/src/output.rs:834-840
pub struct RenderState {
    link: Option<LinkEgress>,
    insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    transport: BlockTransport,
    master: MasterLine,
}
```

```rust
// rust/crates/orbit-audio-native/src/output.rs:1654-1691
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
    stats.record_callback((hw.len() / output_channels) as u32);
    match state.try_lock() {
        Ok(mut state) => {
            let RenderState {
                link,
                insert_buses,
                sources,
                transport,
                master,
            } = &mut *state;
            render_block_with_sources(
                engine,
                link,
                insert_buses,
                sources,
                transport,
                master,
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
```

The number of failed `try_lock`s accumulates in `StreamStats` and can be read as
`render_contentions` from `GetStatus`. "No lock means one dropped block" is a deliberate design
choice, and the contention is self-healing (the next block recovers).

The body, `render_block_with_sources`, proceeds in order: engine render → **the master line (rack
→ gain)** → **device placement** → **merging the direct device line** → capture tap → record the
callback duration. The two middle
stages arrived with #649 PR-O2 ([#754](https://github.com/signalcompose/orbitscore/pull/754));
before that the sequence was the three stages "engine render → master post-processor → capture
tap". `master.post`/`capture`/`cb_stats` are still each independent opt-ins, but the
bit-identical condition now reads **"no rack, master gain still at its default of 1.0, and a 2ch
device"** — with the placement stage added, anything other than 2ch always pays for the
placement.

```rust
// rust/crates/orbit-audio-native/src/output.rs:1739-1829
fn render_block_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    master: &mut MasterLine,
    capture: &mut Option<RingTapSink>,
    cb_stats: &Option<Arc<CallbackTimeStats>>,
    output_channels: usize,
    hw: &mut [f32],
) {
    // Instant::now() は macOS では mach_absolute_time（lock/alloc なし）= RT 許容。A0 §6 に基づき
    // production RT 監視を callback-duration ベースにするための計測（cb_stats 有り時のみ）。
    let t0 = cb_stats.as_ref().map(|_| Instant::now());

    // engine（+ bus graph）は常に 2ch で完結する（設計 §5.5 row 1・3）。`master.buffer` が core の
    // 「hardware_out」を受ける — デバイス幅（`output_channels`／`hw`）とは無関係。buffer は起動時に
    // 事前確保済み（`start_output_inner`）なので RT では resize しない。
    let frames = hw.len() / output_channels;
    let bs = frames * 2;
    debug_assert!(
        master.buffer.len() >= bs,
        "master buffer too short: {} < {bs}",
        master.buffer.len()
    );
    debug_assert!(master.direct_device_buffer.len() >= hw.len());
    let direct_device_written = {
        let mut device = DeviceLineBuffer {
            samples: &mut master.direct_device_buffer[..hw.len()],
            channels: output_channels,
            wrote: false,
        };
        render_engine_with_sources_impl(
            engine,
            link,
            insert_buses,
            sources,
            transport,
            2,
            &mut master.buffer[..bs],
            Some(&mut device),
        );
        device.wrote
    };

    if master.explicit_line.load(Ordering::Acquire) {
        execute_master_line(master, frames, output_channels, hw);
    } else {
        // SetBusLine 未使用時は従来の固定 master 経路を保ち、既存出力を bit 単位で変えない。
        // この分岐の中身は PR-O3b の前と 1 命令も変えていない（変えると O0 golden が動く）。
        if let Some(p) = master.post.as_mut() {
            p.process(&mut master.buffer[..bs]);
        }
        let g = master.advance_gain(frames);
        // g == 1.0 は IEEE754 の乗算恒等元で bit 一致を崩さない（`x * 1.0 == x`）。分岐は
        // 「未使用 gain 経路に per-sample 乗算コストを払わない」ための最適化であり、O0 golden の
        // bit 一致は乗算そのものではなく `gain_current` が初期値 1.0 のまま変化しないことに由来する
        // （`SetGlobalGain` を一度も呼ばない譜面では target=current=1.0 が恒常的に成立する）。
        if g != 1.0 {
            for s in master.buffer[..bs].iter_mut() {
                *s *= g;
            }
        }
        // デバイス配置（設計 §5.3・row 6）: master.buffer（2ch）を hw（デバイス幅）の ch{0,1} へ置く。
        // 2ch デバイスなら memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。3ch 以上は ch2 以降が
        // 無音で残る — この分岐の Device 出口は master 固定 program の 1 本のみで、複数出口は
        // `execute_master_line`（上の分岐）と PR-O4 以降の DSL 表面が持つ。
        //
        // 🔴 ここで `hw` を全域 zero-fill しない。`place_master_into_device` が **hw の全要素を
        // 書き切る**ので、1ch / 2ch（＝今日検証されている構成すべて）では書いた直後に全部上書きされ、
        // RT コールバックで**毎ブロック二重に store する**ことになる（64 frames × 2ch なら
        // 約 96,000 store/秒の無駄）。余剰チャンネルの 0 埋めは配置関数の責務に閉じた。
        place_master_into_device(&master.buffer[..bs], frames, output_channels, hw);
    }
    if direct_device_written {
        add_scaled(hw, &master.direct_device_buffer[..hw.len()], 1.0);
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

### The direct device line — an output that skips the master

`direct_device_buffer` and `direct_device_written` arrived with #611 PR-O3a
([#811](https://github.com/signalcompose/orbitscore/pull/811)). When a bus's line program carries
an `OutputDest::Device { left, right }`, that sound goes **straight to the named device channels,
without passing through the master line (rack → gain)**. `master.buffer` is always 2ch, so without
a second buffer at device width there would be nowhere for it to land — that is the reason this
buffer exists.

```rust
// rust/crates/orbit-audio-native/src/output.rs:2133-2137
struct DeviceLineBuffer<'a> {
    samples: &'a mut [f32],
    channels: usize,
    wrote: bool,
}
```

`wrote` is doing the work. `add_to_device` calls `fill(0.0)` over the whole buffer **only on the
first write**, so a block in which nobody addresses a Device pays no zero-fill cost at all. The
caller reads the same flag and, when `direct_device_written` is `false`, skips the final
`add_scaled` entirely. It is the same policy as the decision not to zero-fill `hw` in
`place_master_into_device`: an unused path pays nothing per block.

As of this bundle, `LineProgram::legacy` (the translation target of the old `SetBusRouting`)
generates only `Master` and `Bus`, so production never takes this path. The shape RT can execute is
in place; actually growing the output belongs to the next bundle, which changes the DSL surface
(see [SC-2](/en/signal-chain/mixer-audio-line#the-line-program-—-the-output-as-a-sequence-of-operations-611-pr-o3a)).

### The master line — the engine is always 2ch inside

The striking detail in the code above is that the width handed to
`render_engine_with_sources` is the literal `2`, not `output_channels`. Since #649 PR-O2,
everything from the engine through the bus graph runs at **exactly two channels no matter how
many the device has**. That width is published as a named constant.

```rust
// rust/crates/orbit-audio-native/src/output.rs:691-697
/// engine 内部のチャンネル幅。**デバイス幅とは無関係に常に 2**（設計 §5.5）。
///
/// events / feeds / stages / master.buffer はすべてこの幅で扱い、デバイス幅への変換は
/// `place_master_into_device` の 1 箇所だけで行う。デバイス幅（`StreamConfig.channels`）を
/// engine バッファの解釈に使うと、8ch デバイスで frame 数が 1/4 になって音が化ける
/// （#611 本文の実害がこれ）。
pub const ENGINE_CHANNELS: usize = 2;
```

The device width appears in exactly one place: `place_master_into_device`, which maps the 2ch
`master.buffer` onto the device-width `hw`.

```rust
// rust/crates/orbit-audio-native/src/output.rs:1903-1927
fn place_master_into_device(buf: &[f32], frames: usize, device_channels: usize, hw: &mut [f32]) {
    match device_channels {
        0 => {}
        // mono デバイス: L+R を 0.5 でマージ（相関信号でクリップしない・設計 §2.2 Q-611-5 と同じ法則）。
        1 => {
            for frame in 0..frames {
                hw[frame] = (buf[frame * 2] + buf[frame * 2 + 1]) * 0.5;
            }
        }
        // 2ch は幅が一致するので memcpy 相当（O0-1/O0-2 の bit 一致はここで成立）。
        2 => hw[..frames * 2].copy_from_slice(&buf[..frames * 2]),
        // 3ch 以上: ch0/1 に置き、**余剰チャンネルはここで 0 にする**（Device 出口は master の
        // 1 本だけなので、残りは無音が正しい）。
        _ => {
            for frame in 0..frames {
                let base = frame * device_channels;
                hw[base] = buf[frame * 2];
                hw[base + 1] = buf[frame * 2 + 1];
                for extra in &mut hw[base + 2..base + device_channels] {
                    *extra = 0.0;
                }
            }
        }
    }
}
```

Each of the three arms carries its own meaning. Mono merges L+R at 0.5 (so correlated signals
do not clip); 2ch matches in width and becomes a `copy_from_slice`; three or more channels place
ch0/1 and **let this function zero the surplus channels**. The caller deliberately does not
pre-zero `hw`, because this function writes every element of it — filling zeros first would mean
storing twice per block in the RT callback.

The other change is where the master gain is applied. `MasterLine` groups the master rack (the
old `post`) and the gain into one struct and fixes the order as **rack → gain**. The gain moves
toward the target the control side (`SetGlobalGain`) wrote atomically, one block at a time.

```rust
// rust/crates/orbit-audio-native/src/output.rs:820-830
    /// 1 block 分ランプを進め、その block に適用する gain を返す（設計 §5.3 `ramp()`）。
    /// `current += (target - current) * min(1, frames / ramp_frames)`。RT: atomic load 1 回 +
    /// 算術のみ（alloc/lock/syscall なし）。
    #[inline]
    fn advance_gain(&mut self, frames: usize) -> f32 {
        let target = f32::from_bits(self.gain_target.load(Ordering::Relaxed));
        advance_ramped_gain(&mut self.gain_current, target, frames, self.ramp_frames)
    }
}

/// Mutable callback state which must survive a cpal stream rebuild (notably
```

`ramp_frames` is the frame count for 5 ms, computed **at construction time** by
`MasterLine::new` from the sample rate (the RT path only uses it as a divisor). When a block is
longer than the ramp, `frac` saturates at 1.0 and the target is reached in one step; when it is
shorter, the value approaches the target over several blocks.

The point worth holding onto is that **production now has exactly one multiplication path**.
`orbit_audio_core::Engine::set_global_gain` (the core scheduler ramp) is no longer called from
the daemon, and `EngineWrap::set_global_gain` only stores into the `MasterLine` target.
🔴 **#611 PR-O3b deliberately did *not* copy this into the master line** (ruled during review on 2026-09-09).
Copying it would make `LineProgram::new` restart every ramp at unity, so calling `global.gain()` twice would
**jump to 1.0 before settling** instead of gliding from the previous effective gain — an audible pop. That
fails design 611 §4.2's "copy it *without changing its meaning*", so the copy lands in **PR-O4**, together
with the §5.1 mechanism that carries the effective gain across a republish.

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9744-9753
    /// マスターゲインを設定する。PR-O3b では従来どおり atomic だけを更新し、RT 専有の
    /// `gain_current` を呼び出し間で連続させる。master line への写しは、TS の
    /// `global.gain()` を `SetBusLine("master", …)` へ切り替え、再 publish 時に実効値を引き継ぐ
    /// PR-O4 と同時に入れる。`orbit_audio_core::Engine::set_global_gain`（core の scheduler ramp）は
    /// production から呼ばない（`docs/design/611-output-line-design.md` §4.2/§5.1）。`ramp_sec` は
    /// wire 互換のため受け続けるが、native 側は構築時に確定した固定 ~5ms/block のランプを使う。
    pub fn set_global_gain(&self, value: f32, _ramp_sec: f64) -> Result<(), WrapError> {
        self.master_gain.store(value.to_bits(), Ordering::Relaxed);
        Ok(())
    }
```

The wire still accepts `ramp_sec` on `SetGlobalGain` for compatibility, but the native side only
has the fixed ~5 ms ramp, so **the value is not used**. How this reordering looks from the signal
chain side is covered in [SC-2](/en/signal-chain/mixer-audio-line).

### `SetBusLine`: replacing a whole line in one shot

#611 PR-O3b added one more arm to the command table: `SetBusLine`. Where the old `SetBusRouting`
fills in a **fixed frame** ("one output target plus a set of sends"), `SetBusLine` sends
`{ bus, line: [op, op, …] }` — **the ordered op sequence itself** — and replaces that bus's line
wholesale. There are three ops: `rack` (run the rack), `gain` (linear gain) and `output` (an
exit), and the array order is the signal order.

Validation is split across two layers, which is the thing worth noticing when reading it. The
**JSON shape** (spelling of `op`, a duplicated `rack`, the range of `gain`, the shape of `dest`)
is checked by `parse_set_bus_line_params` in the session layer, while **resolving names to RT
indices** (does the bus exist, is the reference forward-only) is checked by
`EngineWrap::set_bus_line`, which owns the topology. Only the device channel range needs to know
the actual output width, so the dispatch sits in between and passes `engine.output_channels()`.

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:2651-2666
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
```

What is interesting here is that `set_bus_line` **runs every check first and publishes exactly
once**. If the second op is invalid, the first op is not applied either. The old `SetBusRouting`
took the "send the output and all sends together" shape for the same reason: never let the RT side
observe a partially applied intermediate state.

Five destination kinds are defined on the wire — `master` / `bus` / `device` / `render` / `link` —
but only the first three are accepted. `render` is rejected as unregistered because the registry
(`DeclareRender`) does not exist, and `link` returns `LINK_AUDIO_UNAVAILABLE` because the RT side
cannot execute a Link exit. The code comments are explicit that neither is a different rule: both
are the same §4.1 rule applied to the state of the tree as it stands.

One more difference from `SetBusRouting` is worth holding onto: the **kind constraint on
destinations**. `SetBusRouting` validates and rejects unless "the output target is a sum bus and
send targets are aux buses", whereas `set_bus_line` only checks forward-only-ness (the target must
be a later index) for a `bus` destination and **does not constrain the kind**. That matches the
ruling in design 611 (reject cycles only, do not constrain by kind), and
`set_bus_line_accepts_a_forward_aux_destination`
(`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:3262-3284`) pins the behaviour down.

### Two master line paths

`SetBusLine` also accepts `bus: "master"`. Since master sits outside the named bus topology,
though, the publication target is a dedicated `LineSlot` owned by `MasterLine`. The point to watch
is that **whether a publication has happened is held in a separate one-way flag**.

```rust
// rust/crates/orbit-audio-native/src/output.rs:748-758
    /// control が master program を **一度でも publish したか**（不可逆）。`line` の中身からは
    /// 導出できない（RT で既定値と深い比較をすることになり、かつ「既定と同じ program を明示的に
    /// publish した」場合を区別できない）。
    ///
    /// 名前は「明示的な line が入ったか」の意であり、`SetGlobalGain` の atomic 更新では変わらない。
    ///
    /// 🔴 **いつこの分岐を消せるか**: PR-O4 で TS の `global.gain()` が
    /// `SetBusLine("master", …)` を送る新表面へ切り替わり、その経路が実機で確かめられ、PR-O6 で
    /// 旧 `SetBusRouting` 系が撤去された後。そこで固定互換経路と本フラグを同時に削り、
    /// `execute_master_line` の 1 本にできる見込みである。
    explicit_line: Arc<AtomicBool>,
```

While that flag is `false`, the RT side runs the fixed compatibility path seen above (rack → gain →
device placement). Only once it is `true` does `execute_master_line` get called and run the
published op sequence in order.

```rust
// rust/crates/orbit-audio-native/src/output.rs:1832-1849
fn execute_master_line(
    master: &mut MasterLine,
    frames: usize,
    output_channels: usize,
    hw: &mut [f32],
) {
    let bs = frames * ENGINE_CHANNELS;
    let program_ptr = master.line.load();
    // SAFETY: publication retains replaced programs for two completed RT generations. This
    // generation is completed only after the whole master program has executed.
    let program = unsafe { &*program_ptr };
    let mut device = DeviceLineBuffer {
        samples: hw,
        channels: output_channels,
        wrote: false,
    };
    for (op_index, op) in program.ops.iter().enumerate() {
        match *op {
```

The reason there are two branches at all is to keep the existing output **bit-identical**. The
body of the `else` side does not differ by a single instruction from before PR-O3b, so none of the
O0 goldens (`OUTPUT_LINE_GOLDENS`) move.

One consequence follows from this. `LineOp::Gain` inside `execute_master_line` reads **the value
written in the program**, so once a master line has been published, `MasterLine::advance_gain`
(the function that reads the atomic `SetGlobalGain` writes) is never called. In other words, a
`SetGlobalGain` after publication only updates an atomic nobody reads. The PR-O3b unit test
`set_global_gain_only_updates_the_compatibility_atomic`
(`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:3286-3309`) pins exactly that: `SetGlobalGain`
does not republish the master program. The two gain paths are joined in PR-O4, when TS's
`global.gain()` switches over to `SetBusLine("master", …)`, together with the mechanism that
carries the effective value across a re-publication.

The engine-render part, `render_engine_with_sources`, splits four ways depending on whether there
are instrument sources (`SourceSlot`s that hold an OOP instrument's output as a `BlockSource`)
and whether any insert bus is active. With no
source and no active bus it falls back to the legacy `render_engine`.

```rust
// rust/crates/orbit-audio-native/src/output.rs:1931-1972
fn render_engine_with_sources(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
) {
    render_engine_with_sources_impl(
        engine,
        link,
        buses,
        sources,
        transport,
        output_channels,
        hw,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn render_engine_with_sources_impl(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    buses: &mut [InsertBusStage],
    sources: &mut [SourceSlot],
    transport: &mut BlockTransport,
    output_channels: usize,
    hw: &mut [f32],
    device: Option<&mut DeviceLineBuffer<'_>>,
) {
    let frames = hw.len() / output_channels;

    if sources.is_empty() {
        if buses.iter().any(|bus| bus.active.load(Ordering::Relaxed)) {
            render_engine_with_insert_buses_and_source_outputs(
                engine,
                link,
                buses,
                &[],
                &[],
```

`build_stream` calls this `render_shared_block` directly from cpal's `build_output_stream`
closure. There are three closures, one per sample format (`F32`/`I16`/`I32`); the non-`F32`
variants render into a pre-allocated scratch buffer before quantizing (the scratch buffer is
pre-sized for one second up front, avoiding heap allocation on the RT hot path).

```rust
// rust/crates/orbit-audio-native/src/output.rs:3027-3044
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    if suppress_callback {
                        data.fill(0.0);
                        return;
                    }
                    render_shared_block(
                        &engine,
                        &render_state,
                        &mut capture,
                        &cb_stats,
                        out_ch,
                        data,
                        &callback_stats,
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

## Output-device liveness — probe first, and pause every stream you throw away

Issue #661 reported that writing a device name into `orbitscore.audioDevice` made **all sound
disappear**, with no error and no warning. cpal's `build_output_stream` can return success on a
device whose callback then never runs even once. That a stream "could be built" does not mean it
will play — that is the starting point of this section.

The countermeasure has two parts. The first is to **check liveness on a throwaway probe stream
before committing to the device**.

```rust
// rust/crates/orbit-audio-native/src/output.rs:505-539
fn probe_output_device(
    live: &LiveOutputDevice,
    suppress_callback: bool,
) -> Result<Option<u64>, OutputError> {
    // This counter is deliberately probe-local. Reusing StreamStats would inflate the ticker's
    // callback count before the real stream exists.
    let callbacks = Arc::new(AtomicU64::new(0));
    let callback_counter = callbacks.clone();
    let stream = live
        .device
        .build_output_stream_raw(
            &live.config,
            live.sample_format,
            move |data, _| {
                data.bytes_mut().fill(0);
                if !suppress_callback {
                    callback_counter.fetch_add(1, Ordering::Relaxed);
                }
            },
            |_| {},
            None,
        )
        .map_err(|e| OutputError::BuildStream(e.to_string()))?;
    if let Err(error) = stream.play() {
        let _ = stream.pause();
        drop(stream);
        return Err(OutputError::PlayStream(error.to_string()));
    }
    let result = confirm_callback_counter(&callbacks, 0, FIRST_CALLBACK_DEADLINE);
    // cpal 0.15.3 can retain named streams through a reference cycle. Explicit pause is therefore
    // required before every probe stream is dropped.
    let _ = stream.pause();
    drop(stream);
    Ok(result)
}
```

The probe has to come **before** the real stream for an ordering reason: if the real stream were
built first and only then judged dead, `insert_buses` and `sources` would already have been moved
into `RenderState` and could not be recovered. The probe-local counter is the same kind of caution
— borrowing `StreamStats` would inflate the 1 Hz ticker's callback count before the real stream
even exists.

The second part is the **reference cycle in cpal 0.15.3** that the comment above names. Dropping a
stream you meant to discard does not stop its callbacks, so `OutputStream` pauses explicitly in
`Drop` as well.

```rust
// rust/crates/orbit-audio-native/src/output.rs:676-682
impl Drop for OutputStream {
    fn drop(&mut self) {
        // cpal 0.15.3 retains named CoreAudio streams through a reference cycle. Dropping the
        // wrapper alone does not stop callbacks; pause must happen before field destruction.
        let _ = self._stream.pause();
    }
}
```

What happens without it is measurable on real hardware. Switching from a named device to the host
default gives 94 callbacks/s (expected 93.8) while both `pause()` calls are in place, and **188**
once both are removed — the old stream stays alive and two streams run at once (measurements in
PR #748).

What is interesting is that the **fallback policy is inverted between the startup path and the
live-switch path**. That distinction is carried by a type.

```rust
// rust/crates/orbit-audio-native/src/output.rs:335-342
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceFallbackPolicy {
    /// 起動経路。利用者を無音のまま放置しないので host 既定へ縮退して起動を成功させる。
    FallBackToHostDefault,
    /// ライブ切替経路。縮退せず `DeviceUnavailable` / `StreamDead` を返し、呼び出し側が
    /// **いま鳴っているデバイスをそのまま使い続ける**。
    RejectAndKeepCurrent,
}
```

Startup falls back so that writing a setting can never leave the user in silence; a live switch
refuses to fall back so that a typo mid-performance can never move the sound to the built-in
speakers. The same "device is unusable" condition hurts the user in opposite directions, so it is
handled in opposite ways. The doc comment explains that this is an enum rather than a positional
`bool` precisely because a swapped `true`/`false` would still compile.

What the user is shown on failure is decided by the protocol error codes. The table lives in the
"`SelectAudioDevice` の失敗コード" section of `docs/research/ENGINE_DAEMON_PROTOCOL.md`, and the
editor reads its "is sound still playing" column to decide whether to offer `Restart Engine`
(`SELECT_AUDIO_DEVICE_ERRORS` in `packages/vscode-extension/src/engine-view.ts`).

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

- The inside of `EngineWrap::apply_device_switch` — rebuilding the cpal stream once the probe has passed, and carrying `RenderState` across
- The full list of `DaemonError`s fired by the `StreamStats` 1 Hz ticker (the error-code constants in `protocol.rs:86-161`) and where each is observed
- The `RenderScore` (#598 P2) offline render path
- Lag handling in `forward_plugin_ui_events` (how loss-sensitive close/safepoint frames are treated)

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-265` — daemon entry point. Boot sequence (CLI args → audio owner thread → bind WebSocket → emit ready line → accept loop), panic hook (#605), known shutdown gap (#448)
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop (`bind_localhost` / `serve` / `handle_connection`)
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-195` — wire protocol type definitions (`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / error code constants). Contract source of truth: `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:691-718,1272-2372` — `session::run` (handshake, writer task, UI event forwarding) and the `handle_command` match arms (source of the command table)
- `rust/crates/orbit-audio-native/src/output.rs:254-260,581-618,662-750,1513-1556` — `RenderState` / `render_shared_block` / `render_block_with_sources` / `render_engine_with_sources` / `build_stream`
- `rust/crates/orbit-audio-native/src/output.rs:682-688,700-754,1253-1277` — `ENGINE_CHANNELS` / `MasterLine` (rack → gain) / `place_master_into_device` (#649 PR-O2)
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9479-9488` — `EngineWrap::set_global_gain` (PR-O3b keeps it **atomic-only**; the copy into the master line lands in PR-O4; `ramp_sec` kept for wire compatibility only)
- `rust/crates/orbit-audio-native/src/output.rs:1926-1930,1932-1985` — `DeviceLineBuffer` / `add_to_device` (the direct device line, #611 PR-O3a)
- `rust/crates/orbit-audio-daemon/src/session.rs:306-361,2633-2648` — `parse_set_bus_line_params` (wire-shape validation) and the `SetBusLine` dispatch arm (#611 PR-O3b)
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:6753-6906` — `EngineWrap::set_bus_line` (name → RT index resolution, published exactly once after every check)
- `rust/crates/orbit-audio-native/src/output.rs:739-759,1783-1841` — `MasterLine.line` / `explicit_line` / `execute_master_line` (#611 PR-O3b)
- `packages/engine/src/audio/rust-engine/daemon-client.ts:86-96,715-718` — `WireDest` / `WireLineOp` / `DaemonClient.setBusLine` (the caller arrives in PR-O4)
- PR [#811](https://github.com/signalcompose/orbitscore/pull/811) — bundle O-wire (line-program conversion, compatibility preserved)
- PR [#824](https://github.com/signalcompose/orbitscore/pull/824) — bundle O-wire-b (the `SetBusLine` wire contract; the DSL never calls it)
- [`docs/design/611-output-line-design.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/design/611-output-line-design.md) §5.2-5.5 — design source of truth for the master line, the 2ch internal width, and taking the core master gain out of production
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first roadmap and architecture decision (instruments = in-process / effects + 3rd-party = out-of-process sandbox)
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 / 6.262 — capture peak measurements
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 — the master fader defect (#643)
- `rust/crates/orbit-audio-daemon/src/outproc_shm_sweep.rs:167-196` — `sweep_orphaned_outproc_shm` (the thin shell stage 0.5 calls, plus its one-line `tracing::info!` summary)
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon graceful-shutdown gap and the `ParentWatch` countermeasure
- Issue [#779](https://github.com/signalcompose/orbitscore/issues/779) / PR [#784](https://github.com/signalcompose/orbitscore/pull/784) — reclaiming orphaned shm at startup (stage 0.5)
- Issue [#484](https://github.com/signalcompose/orbitscore/issues/484) — audio device enumeration, selection and runtime switching (D1 / D2 / D3)
- Issue [#605](https://github.com/signalcompose/orbitscore/issues/605) — best-effort stderr in the panic hook
