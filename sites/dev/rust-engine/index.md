---
title: "RE-1. daemon アーキテクチャ概観"
chapter-id: "RE-1"
verified-against: 3983828
verified-at: "2026-07-17"
status: draft
---

> **Note**: 本ページは 2026-07-17 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# RE-1. daemon アーキテクチャ概観

OrbitScore の音は最終的に `orbit-audio-daemon`（Rust）という独立プロセスが鳴らす。TS 側の
engine（`packages/engine`）はこの daemon に WebSocket 経由でコマンドを送るクライアントに過ぎない。
本章では daemon プロセスの構造、TS engine との境界（wire protocol）、boot〜teardown のライフ
サイクル、そして cpal のリアルタイム audio callback の骨格を鳥瞰する。

## TS engine との境界: WebSocket wire protocol

daemon は起動すると audio device を確保し、localhost の空きポートに WebSocket listener を bind
して、その port 番号を stdout に 1 行 JSON で出力する。TS 側はこの行を読んで接続する。

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

起動失敗時は逆に stderr に 1 行 JSON（`{"ready":false,"error":{...}}`）を書いて非ゼロ exit code
で終了する。TS 側は stdout/stderr のどちらの 1 行 JSON かで起動成否を判定する契約になっている。

接続確立後、daemon はまず handshake フレームを送る。その後は `{id, method, params}` 形式の
`Command` を TS 側から受け、`{id, result}` の `OkResponse` か `{id, error}` の `ErrorResponse`
を返す request/response モデル。加えて、`id` を持たない一方向の `Event`（`PlayStarted` /
`PlayEnded` / `StreamStats` / `DaemonError` 等）を daemon から能動的に push できる。

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

契約自体の正本は `docs/research/ENGINE_DAEMON_PROTOCOL.md` で、`protocol.rs` はそのシリアライズ
/デシリアライズ用の型を定義するだけ、とコメントで明言されている（`protocol.rs:1-4`）。

`method` の dispatch は `session.rs` の `handle_command` が担う。`"Ping"` / `"GetStatus"` のような
単純な method に加え、`PluginNoteOn`/`PluginNoteOff` のような plugin note 系 method は
`plugin_note_spec` という純関数を「唯一の判定箇所」として先に分離してから match に落とす設計に
なっている（2 箇所で同じ文字列集合を独立管理すると drift するという教訓が反映されている）。

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

## boot 〜 teardown ライフサイクル

`server::serve` は accept loop で、接続ごとに独立タスクを spawn し `session::run` に処理を渡す。

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

teardown 側には既知のギャップがコメントで明記されている（Issue #448）。この daemon は
SIGTERM/SIGINT ハンドラを持たず、panic hook も `process::exit(1)` を直接呼ぶため、通常の
client 側 `SIGTERM → SIGKILL` 停止や panic では `InstrumentChildSupervisor` /
`EffectChildSupervisor` の `Drop`（out-of-process child への `CONTROL_QUIT` 送出）が実行されず、
child プロセスが孤児化し得る。

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

この daemon 側 shutdown の穴に対する本命の防御策が child 側の `ParentWatch`（親プロセスの生死を
child 自身が監視する仕組み）で、RE-2 章で扱う。

## リアルタイム audio callback（`render_block`）

音の実体は `orbit-audio-native` crate の cpal callback から出る。callback 本体は
`render_block` という 1 関数に集約されており、insert bus の有無で 2 経路（bit-identical な
従来経路 / insert bus 経路）に分岐したあと、CLAP master-bus post-processor（有効時のみ）と
capture tap（`ORBIT_CAPTURE_WAV` 有効時のみ）を通す。

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

`build_stream` はこの `render_block` を cpal の `build_output_stream` クロージャから直接呼ぶ。
サンプルフォーマット（`F32`/`I16`/`I32`）ごとに 3 通りのクロージャがあり、`F32` 以外は事前確保
した scratch buffer に `render_block` を実行してから量子化する（RT hot path でのヒープ確保を
避けるため、scratch buffer は 1 秒分をあらかじめ確保している）。

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

`post`/`capture`/`cb_stats` はすべて独立した opt-in の分岐として設計されており、いずれも
`None` のときは従来（=素の hardware-only）経路とビット同一になる、というのが `render_block`
のコメントで明言された不変条件。この「未使用時はビット同一」という設計原則は、RE-2 で扱う
OOP effect/instrument の insert bus 経路や、`ORBIT_CAPTURE_WAV` capture seam にも一貫して
適用されている。

daemon 全体のアーキテクチャ確定（楽器=in-process・effects/3rd-party=out-of-process sandbox）の
背景は `docs/development/POST_2.0_MASTER_PLAN.html` に記載がある。

> 楽器（サンプラー/audio DSL）= in-process（crown jewel）／ effects + 3rd-party =
> out-of-process sandboxed plugin ／ audio DSL ⊇ pitch DSL

## Try it: daemon を起動して単音を鳴らす（capture peak 検証）

`ORBIT_CAPTURE_WAV` 環境変数を daemon 起動時に設定すると、`render_block` の capture tap
（上記コード参照）が有効化され、post-processor 適用後の最終 hardware サンプルを WAV へ書き出す。
手順（配布構成の release daemon + `cli-audio.js` 前提）:

```bash
ORBIT_CAPTURE_WAV=/tmp/orbit-capture-test.wav node cli-audio.js path/to/single-note.orbs
```

**期待値**: capture peak は再生した波形の既知振幅（例えば sine の gain=1.0 相当なら 1.0
付近）と一致するはずだが、この値は **本エージェントの作業環境（実 audio device が無いサンドボックス）
では実行して検証していない**。したがって具体的な peak 数値はここでは記載せず、**未検証**として
明記する。実機で確認する場合は `docs/development/WORK_LOG.md` の capture seam 関連エントリ
（6.24x 台）と、PH-1 章の Try it（capture peak = 0.25000・WORK_LOG 6.258）を参照して同様の
手順で peak を照合すること。

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-124` — daemon エントリポイント。boot シーケンス（engine 起動 → WebSocket bind → ready line 出力 → accept loop）と panic hook、既知の shutdown ギャップ（#448）
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop（`bind_localhost` / `serve` / `handle_connection`）
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-193` — wire protocol の型定義（`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / エラーコード定数）。契約の正本は `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:108-126,668-705` — handshake 送信、`handle_command` の dispatch 構造
- `rust/crates/orbit-audio-native/src/output.rs:226-278,640-686` — `render_block`（RT callback 本体）と `build_stream`（cpal ストリーム構築、サンプルフォーマット別クロージャ）
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first ロードマップとアーキ確定（楽器=in-process／effects+3rd-party=out-of-process sandbox）
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) — capture seam・cutover #108 の実装記録
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon の graceful-shutdown ギャップと `ParentWatch` 対策
