---
title: "RE-1. Daemon Architecture Overview"
chapter-id: "RE-1"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: This page is a snapshot of the author's reading as of 2026-07-17. The code is the
> source of truth; this page is only a snapshot of that understanding at that point in time.

# RE-1. Daemon Architecture Overview

OrbitScore's sound ultimately comes out of `orbit-audio-daemon` (Rust), a separate process. The
TS-side engine (`packages/engine`) is just a client that sends it commands over WebSocket. This
chapter surveys the daemon process structure, the boundary with the TS engine (the wire
protocol), the boot-to-teardown lifecycle, and the skeleton of the cpal real-time audio callback.

## The boundary with the TS engine: WebSocket wire protocol

On startup, the daemon claims an audio device, binds a WebSocket listener to a free localhost
port, and writes that port number to stdout as a single line of JSON. The TS side reads this
line to connect.

```rust
// main.rs:72-110
async fn run() -> Result<(), i32> {
    // 1. Engine を起動（audio device 取得）
    let (engine, _stream_guard) = match EngineWrap::start() {
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

Once the connection is established, the daemon first sends a handshake frame. After that, it
follows a request/response model: it receives a `Command` of shape `{id, method, params}` from
the TS side and returns either an `OkResponse` (`{id, result}`) or an `ErrorResponse`
(`{id, error}`). In addition, it can proactively push one-way `Event`s that have no `id`
(`PlayStarted` / `PlayEnded` / `StreamStats` / `DaemonError`, etc.).

```rust
// protocol.rs:11-61
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

The comment at the top of the module states that the contract's source of truth is
`docs/research/ENGINE_DAEMON_PROTOCOL.md` — this module only defines the serialize/deserialize
types (`protocol.rs:1-4`).

`method` dispatch is handled by `handle_command` in `session.rs`. Beyond simple methods like
`"Ping"` / `"GetStatus"`, plugin-note methods such as `PluginNoteOn`/`PluginNoteOff` are first
split off through a pure function, `plugin_note_spec`, kept as the single point of truth, before
falling through to the match — reflecting a lesson learned that keeping the same string set in
two independently-maintained places drifts.

```rust
// session.rs:668-697
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
```

## Boot-to-teardown lifecycle

`server::serve` is the accept loop: for every connection it spawns an independent task that
hands off to `session::run`.

```rust
// server.rs:24-70
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
// main.rs:19-28
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

The comment explains the primary defense against this daemon-side shutdown gap lives on the
child side (`ParentWatch`, which lets a child detect its parent's death on its own) — covered in
the RE-2 chapter.

## The real-time audio callback (`render_block`)

The actual sound comes from the cpal callback in the `orbit-audio-native` crate. The callback
body is consolidated into a single function, `render_block`, which branches into one of two
paths depending on whether any insert bus is active (a bit-identical legacy path, or an
insert-bus path), then runs the optional CLAP master-bus post-processor and the optional capture
tap (only active when `ORBIT_CAPTURE_WAV` is set).

```rust
// output.rs:226-278
/// 1 callback 分の処理（計測 + engine render + master-bus post-processor）。
///
/// 手順: (1) callback 開始時刻を取る（`cb_stats` 有り時のみ）→ (2) [`render_engine`] で engine
/// （+ LinkAudio egress）を render → (3) `post` 有りなら hardware sum を in-place 変換（CLAP
/// effect/instrument・Issue #340）→ (4) `capture` 有りなら **post 適用後の最終 `hw`** を WAV 用
/// ring へ読み取り専用 tap（#307）→ (5) callback 所要時間を記録。`post`/`capture`/`cb_stats` は
/// 各々独立の opt-in 分岐で、すべて None なら従来経路とビット同一。`capture` は `hw` を読むだけ
/// なので有効でも出力サンプルは不変（tap であって mutation ではない）。
#[inline]
#[allow(clippy::too_many_arguments)] // callback state is kept as independent opt-in seams.
fn render_block(
    engine: &Engine,
    link: &mut Option<LinkEgress>,
    insert_buses: &mut [InsertBusStage],
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
    if !insert_buses
        .iter()
        .any(|bus| bus.active.load(Ordering::Relaxed))
    {
        render_engine(engine, link, output_channels, hw);
    } else {
        render_engine_with_insert_buses(engine, link, insert_buses, output_channels, hw);
    }

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

`build_stream` calls this `render_block` directly from cpal's `build_output_stream` closure.
There are three closures, one per sample format (`F32`/`I16`/`I32`); the non-`F32` variants run
`render_block` into a pre-allocated scratch buffer before quantizing (the scratch buffer is
pre-sized for one second up front, avoiding heap allocation on the RT hot path).

```rust
// output.rs:667-686
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    render_block(
                        &engine,
                        &mut link,
                        &mut insert_buses,
                        &mut post,
                        &mut capture,
                        &cb_stats,
                        out_ch,
                        data,
                    )
                },
                make_err_fn(),
                None,
            )
            .map_err(|e| OutputError::BuildStream(e.to_string()))?,
```

`post`/`capture`/`cb_stats` are each designed as independent opt-in branches; the invariant
stated explicitly in the `render_block` comment is that when all three are `None`, the code path
is bit-identical to the plain hardware-only path. This "bit-identical when unused" design
principle also applies consistently to the OOP effect/instrument insert-bus path (RE-2) and the
`ORBIT_CAPTURE_WAV` capture seam.

The overall architecture decision behind the daemon (instruments = in-process; effects/3rd-party
= out-of-process sandbox) is recorded in `docs/development/POST_2.0_MASTER_PLAN.html`:

> 楽器（サンプラー/audio DSL）= in-process（crown jewel）／ effects + 3rd-party =
> out-of-process sandboxed plugin ／ audio DSL ⊇ pitch DSL
>
> (Instruments (sampler / audio DSL) = in-process (crown jewel) / effects + 3rd-party =
> out-of-process sandboxed plugin / audio DSL ⊇ pitch DSL)

## Try it: boot the daemon and play a single note (capture peak verification)

Setting the `ORBIT_CAPTURE_WAV` environment variable when starting the daemon activates the
capture tap in `render_block` (see the code above), writing the final post-processed hardware
samples out to a WAV file. Procedure (assuming a distribution-configuration release daemon +
`cli-audio.js`):

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture-test.wav node cli-audio.js path/to/single-note.orbs
```

**Expected value**: the capture peak should match the known amplitude of the played waveform
(e.g. around 1.0 for a sine at gain=1.0), but this value was **not run or verified in this
agent's working environment** (a sandbox without a real audio device). Therefore no concrete peak
number is given here — it is explicitly marked **unverified**. To confirm on real hardware, see
the capture-seam-related entries in `docs/development/WORK_LOG.md` (the 6.24x series) and the
Try-it in the PH-1 chapter (capture peak = 0.25000, confirmed per WORK_LOG 6.258) for the same
kind of procedure.

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-124` — daemon entry point. Boot sequence (start engine → bind WebSocket → emit ready line → accept loop), panic hook, known shutdown gap (#448)
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop (`bind_localhost` / `serve` / `handle_connection`)
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-193` — wire protocol type definitions (`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / error code constants). Contract source of truth: `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:108-126,668-705` — handshake send, `handle_command` dispatch structure
- `rust/crates/orbit-audio-native/src/output.rs:226-278,640-686` — `render_block` (RT callback body) and `build_stream` (cpal stream construction, per-sample-format closures)
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first roadmap and architecture decision (instruments = in-process / effects + 3rd-party = out-of-process sandbox)
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) — capture seam and cutover #108 implementation records
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon graceful-shutdown gap and the `ParentWatch` countermeasure
