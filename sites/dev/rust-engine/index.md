---
title: "RE-1. daemon アーキテクチャ概観"
chapter-id: "RE-1"
verified-against: f23eb5d
verified-at: "2026-09-11"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡で、2026-09-05 に #649 PR-O2（[#754](https://github.com/signalcompose/orbitscore/pull/754)）の master ライン導入まで、2026-09-06 に #779 の起動時 shm sweep（[#784](https://github.com/signalcompose/orbitscore/pull/784)）まで、2026-09-08 に #611 PR-O3a（[#811](https://github.com/signalcompose/orbitscore/pull/811)）の直行デバイスラインまで、2026-09-10 に #611 PR-O3b（[#824](https://github.com/signalcompose/orbitscore/pull/824)）の `SetBusLine` wire 契約と master line の 2 本立てまで、2026-09-10 に #502 の SC 削除（[#833](https://github.com/signalcompose/orbitscore/pull/833)）で確定した「LinkAudio egress は出荷ビルドに入っていない」まで、2026-09-11 に #611 PR-O4 の前半（[#834](https://github.com/signalcompose/orbitscore/pull/834)）の `pan` op・mono デバイス宛先・再 publish の seed まで追従しました。code が真実、本ページはその時点の理解の snapshot に過ぎません。

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
さらに 2026-09-06 に、**最初の shm を作る前に**死亡した旧 daemon の共有メモリを回収する段（0.5）が
入りました（#779）。この順序は「自分の PID の残骸を消してよい」という規則の正当性要件です。

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

起動失敗時は逆に stderr に 1 行 JSON（`{"ready":false,"error":{...}}`）を書いて非ゼロ exit code
で終了します。TS 側は stdout/stderr のどちらの 1 行 JSON かで起動成否を判定する契約です。

ここで気をつけたいのは step 1 の `start_engine_with_device_switch()` です。`cpal::Stream` は
`!Send` なので tokio の async task には持ち込めません。そこで `EngineWrap::start()` を
「audio owner thread」という専用 OS thread の上で呼び、その thread が `StreamGuard` を生涯所有します
（ランタイムの device 切替 `SelectAudioDevice` もこの thread に `mpsc` で委譲されます・#484 D2）。

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
// rust/crates/orbit-audio-daemon/src/session.rs:994-1021
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

`method` の dispatch は `handle_command` が担います。`PluginNoteOn`/`PluginNoteOff` のような
plugin note 系 method は `plugin_note_spec` という純関数を「唯一の判定箇所」として先に分離してから
match に落とす設計です（2 箇所で同じ文字列集合を独立管理すると drift するという教訓が反映されています）。

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:1610-1637
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
arm は次のとおりです（`cfg` 列は feature で分岐する arm。`SetBusLine` の行だけ 2026-09-10 の
#611 PR-O3b で足しました）。

| method | 役割 | 備考 |
|---|---|---|
| `Ping` | 疎通確認（`"pong"`） | |
| `ListAudioDevices` | cpal の output device 列挙 | #484 D1・`spawn_blocking` |
| `SelectAudioDevice` | ランタイム device 切替 | #484 D2・audio owner thread へ委譲。#661 で候補を先に probe する |
| `GetStatus` | daemon/protocol version・sample rate・`render_contentions` 等 | #661 で `output`（実際に鳴っているデバイスと縮退の履歴）と `callback`（生存カウンタ）が加わった |
| `LoadSample` / `UnloadSample` | audio file の登録 / 解除 | |
| `RegisterLinkAudioChannel` / `SetLinkTempo` | LinkAudio egress | 🔴 feature `link-audio` は **default off** で、出荷ビルドでは有効化していない。無効なら `LINK_AUDIO_UNAVAILABLE`（能力の欠落）を返し、TS 側は 1 回だけ warn して hardware で続行する。詳細は下の「LinkAudio egress は出荷ビルドに入っていない」 |
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
| `SetBusLine` | 1 本の bus の**順序付き audio line を全置換** | #611 PR-O3b・`outproc-effect` build のみ（無効なら `UNSUPPORTED`）。**TS に呼び出し元はまだありません** |
| `SetSourceRouting` | instrument source → bus の実行時ルーティング | `outproc-effect,outproc-instrument` build のみ |
| `InjectFault` | kill-test 用の panic 注入 | `ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ |
| `PluginNoteOn` / `PluginNoteOff` | instrument への note | `plugin_note_spec` 経由（match の外） |

`SetGlobalGain` の行の「#643 で修正」は、WORK_LOG 6.415 に記録された「master fader が instrument に
効いていなかった」不具合の修正を指します。同じ command が RE-4 で扱う capture E2E で捕まった、
という経緯は [`capture-verification`](/rust-engine/capture-verification) 章で触れます。

### LinkAudio egress は出荷ビルドに入っていない

`RegisterLinkAudioChannel` / `SetLinkTempo` の 2 つは、表の中で唯一「wire には居るが出荷ビルドでは
一度も成功しない」command です。egress の実体は GPL 隔離 crate `orbit-link-audio` で、daemon 側は
optional dependency として feature `link-audio` の裏に括られています。

```toml
// rust/crates/orbit-audio-daemon/Cargo.toml:18-23
[features]
# 🔴 GPL feature。**default off**。有効化すると Ableton Link(GPL-2.0-or-later)が
# 依存グラフに入る。permissive な engine core はこの feature に依存しない。
# rtrb は permissive(MIT/Apache)だが、reg-ring producer 型を名指すのは link-audio 経路のみ
# なので feature に括る（default ビルドの依存グラフを増やさない）。
link-audio = ["dep:orbit-link-audio", "dep:rtrb"]
```

そして出荷ビルドはこの feature を有効化していません。同梱バイナリを作る 1 行はこうです。

```bash
// scripts/copy-daemon-bin.sh:108-108
    && cargo build --release -p orbit-audio-daemon --features outproc-effect,outproc-instrument \
```

`.github/workflows/release.yml:88` も同じ feature 集合で、`link-audio` はどちらにも入っていません。
つまり **`.vsix` に同梱される daemon には egress が存在しません**。

なぜ有効化しないかは、feature のコメントがそのまま理由になっています。有効化すると
Ableton Link（GPL-2.0-or-later）が出荷バイナリの依存グラフに入り、`rust/deny.toml` の
「default graph は GPL-free」不変条件が崩れます。これは SuperCollider（GPL の scsynth 同梱）を
#502 で削除した理由と同じ問題です。**有効化は「そう決める」ことであって、まだ決まっていません。**

無効なビルドで `RegisterLinkAudioChannel` を受けた daemon は `LINK_AUDIO_UNAVAILABLE` を返します。
これは **能力の欠落**を表すコードで、実行時の失敗を表す `LINK_AUDIO_RUNTIME` や daemon の死とは
区別されます。前者だけを TS 側が握り潰して hardware で続行し、後者は呼び出し元へ伝播します。
警告を出すのは **channel 登録の 1 箇所だけ**で、`scheduleEvent` / `scheduleSliceEvent` は同じ gap を
見ても警告しません（登録経路を唯一の権威として扱う）。仕様側の記述は
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §8.1 / §8.1.3 にあります。

🔴 **ただし、この「hardware へフォールバックして 1 回 warn する」は実機で確認されていません。**
gated E2E の側に、正反対の実測が記録されています。

```ts
// tests/e2e/orbitstudio-mcp-gated.spec.ts:5388-5394
  // **A comment is not evidence of implementation behavior** — main's real run found
  // capture RMS = 0 for `d645Live` and NO `LINK_AUDIO_UNAVAILABLE`/gap-warning marker in
  // get_log at all, meaning the assumed fallback does not actually happen (or does not
  // happen the way the comment describes). Capture-based proof was DROPPED for this
  // reason — under `global.linkAudio()`, EVERY audio sequence's dispatch is either
  // `skip` or `link` (never a real, capturable `hardware` dispatch — mixing is
  // disallowed by design), so there is no way to hear `d645Live` here without
```

つまり 2026-09-04 の実機では **音が出ず（capture RMS = 0）、警告も出ていません**。さらにこの
コメントは「`global.linkAudio()` 下では dispatch は `skip` か `link` のどちらかで、capture できる
`hardware` dispatch には**決してならない**（混在は設計上禁止）」と述べており、これは §8.1 の
「hardware へ出る」と正面から食い違います。**どちらが正しいかは本ページでは決めません。**

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

孤児化するのはプロセスだけではありません。`Drop` が走らないと shm ファイルの削除も走らないので、
`$TMPDIR` に out-of-process 用の共有メモリが残ります。これを起動時に回収するのが上の段 0.5
（#779）で、判定規則と「なぜ 0 には収束しないのか」は
[RE-2](/rust-engine/oop-children) の「起動時の孤児 shm 回収」節で扱います。

ちなみに panic hook 自身も #605 で書き換えられています。stderr が壊れている状況で `eprintln!` を
使うと panic hook の中で panic して `process::abort()` に落ち、client が exit code 1 ではなく
SIGABRT を見てしまう — そのため `write_line_best_effort` を使う形になっています（`main.rs:64-74`）。

## リアルタイム audio callback

音の実体は `orbit-audio-native` crate の cpal callback から出ます。2026-07-17 時点では callback 本体が
`render_block` という 1 関数でしたが、2026-09-01 時点では 2 層になっています。

1. `render_shared_block` — cpal のクロージャから直接呼ばれる入口。`RenderState`（insert bus・
   instrument source・master ライン等）を `Mutex` の `try_lock` で取り、取れなければ
   **zero-fill して `record_render_contention` を数える**（RT thread で block しないため）。
2. `render_block_with_sources` — lock が取れたときの本体。従来の `render_block` は `#[cfg(test)]` の
   薄い wrapper として残っています。

`RenderState` を `Mutex` に入れているのは、`SelectAudioDevice`（#484 D2）で cpal stream を作り直しても
callback 側の状態を引き継ぐためです（`OutputStream::render_state` のコメント参照）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:885-891
pub struct RenderState {
    link: Option<LinkEgress>,
    insert_buses: Vec<InsertBusStage>,
    sources: Vec<SourceSlot>,
    transport: BlockTransport,
    master: MasterLine,
}
```

```rust
// rust/crates/orbit-audio-native/src/output.rs:1761-1798
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

`try_lock` が外れた回数は `StreamStats` に積まれ、`GetStatus` の `render_contentions` として読めます。
「lock が取れない = 音が 1 block 落ちる」という設計判断は明示的なもので、後述の contention は
自己修復します（次の block で戻る）。

本体の `render_block_with_sources` は、engine render → **master ライン（ラック → gain）** →
**デバイス配置** → **直行デバイスラインの合流** → capture tap → callback 所要時間の記録、
という順に進みます。中ほどの 2 段は
#649 PR-O2（[#754](https://github.com/signalcompose/orbitscore/pull/754)）で入ったもので、それ以前は
「engine render → master post-processor → capture tap」の 3 段でした。`master.post`/`capture`/`cb_stats`
がそれぞれ独立した opt-in であることは変わりませんが、ビット同一の条件は
**「ラックが無く、master gain が既定の 1.0 のまま、かつデバイスが 2ch」** に読み替えます
（デバイス配置の段が増えたぶん、2ch 以外では配置のコストが常に乗ります）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:1846-1932
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
        let ramp = master.advance_gain(frames);
        // gain == 1.0 は IEEE754 の乗算恒等元で bit 一致を崩さない（`x * 1.0 == x`）。分岐は
        // 「未使用 gain 経路に per-sample 乗算コストを払わない」ための最適化であり、O0 golden の
        // bit 一致は乗算そのものではなく `gain_current` が初期値 1.0 のまま変化しないことに由来する
        // （`SetGlobalGain` を一度も呼ばない譜面では target=current=1.0 が恒常的に成立する）。
        apply_ramped_gain(&mut master.buffer[..bs], ENGINE_CHANNELS, ramp);
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

### 直行デバイスライン — master を通さない出口

`direct_device_buffer` と `direct_device_written` の 2 つは
#611 PR-O3a（[#811](https://github.com/signalcompose/orbitscore/pull/811)）で入りました。バスの
line program が `OutputDest::Device { left, right }` を持つとき、その音は
**master ライン（ラック → gain）を通さずに、デバイスの指定チャンネルへ直接**出ます。
master.buffer は常に 2ch なので、デバイス幅のバッファをもう 1 枚用意しないと行き先が無い、
というのがこのバッファの理由です。

```rust
// rust/crates/orbit-audio-native/src/output.rs:2312-2316
struct DeviceLineBuffer<'a> {
    samples: &'a mut [f32],
    channels: usize,
    wrote: bool,
}
```

`wrote` が効いています。`add_to_device` は **最初の書き込みのときだけ** バッファ全体を
`fill(0.0)` するので、誰も Device 宛てを持っていない block では zero-fill のコストが
一切かかりません。呼び出し側もそれを見て、`direct_device_written` が `false` なら
最後の `add_scaled` ごと飛ばします。「使われていない経路には per-block のコストを払わない」
という、`place_master_into_device` で `hw` を zero-fill しない判断と同じ方針です。

この束の時点では `LineProgram::legacy`（= 旧 `SetBusRouting` の変換先）は `Master` と `Bus` しか
生成しないので、production でこの経路が踏まれることはありません。RT が実行できる形にだけして
おいて、出口を実際に生やすのは DSL 表面を変える次の束、という段取りです
（[SC-2](/signal-chain/mixer-audio-line#line-program-—-出口を「命令列」として持つ-611-pr-o3a) 参照）。

### master ライン — engine の内部幅は常に 2ch

引用したコードで目を引くのは、`render_engine_with_sources` に渡している幅が
`output_channels` ではなく定数の `2` になっている点でしょう。#649 PR-O2 以降、engine から
バスグラフまでの内部処理は**デバイスが何チャンネルであっても常に 2ch** で完結します。
その幅は名前付きの定数として公開されています。

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

デバイス幅が現れるのは出口の 1 箇所だけです。`place_master_into_device` が 2ch の
`master.buffer` をデバイス幅の `hw` へ写します。

```rust
// rust/crates/orbit-audio-native/src/output.rs:2002-2026
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

3 通りの分岐がそれぞれ意味を持っています。mono は L+R を 0.5 でマージ（相関した信号を
足してもクリップしない）、2ch は幅が一致するので `copy_from_slice`、3ch 以上は ch0/1 に置いて
**余剰チャンネルをこの関数が 0 で埋めます**。呼び出し側が `hw` を事前に zero-fill しないのは、
この関数が `hw` の全要素を書き切るからで、先に 0 を書くと RT コールバックで毎ブロック二重に
store することになります。

もうひとつの変更は master gain の適用点です。`MasterLine` は master ラック（旧 `post`）と
gain を 1 つの構造体にまとめ、**ラック → gain** の順を固定します。gain は control（`SetGlobalGain`）が
atomic に書いた目標値へ、block ごとに寄せていく形です。返り値は #859（2026-09-11）以降
スカラーではなく `LineRamp` で、**その block の中でどのフレームにどの値を掛けるか**を持ちます。

```rust
// rust/crates/orbit-audio-native/src/output.rs:871-881
    /// 1 block 分ランプを進め、その block に適用する ramp を返す（設計 §5.3 `ramp()`）。
    /// `current += (target - current) * min(1, frames / ramp_frames)`。RT: atomic load 1 回 +
    /// 算術のみ（alloc/lock/syscall なし）。
    #[inline]
    fn advance_gain(&mut self, frames: usize) -> LineRamp {
        let target = f32::from_bits(self.gain_target.load(Ordering::Relaxed));
        advance_line_ramp(&mut self.gain_current, target, frames, self.ramp_frames)
    }
}

/// Mutable callback state which must survive a cpal stream rebuild (notably
```

`ramp_frames` は 5 ms 相当のフレーム数で、`MasterLine::new` が sample_rate から**構築時に**
算出します（RT では割り算の分母として使うだけです）。**block 終端の値**は block が ramp より
長ければ `frac` が 1.0 に飽和して 1 回で目標へ到達し、短ければ何 block かかけて寄っていきます。

🔴 **block 終端だけを見ていると読み違えます**（#859・2026-09-11 に修正）。この式は長らく
「その block 全体に掛けるスカラー 1 個」として使われており、`ramp_frames` が 240（5 ms @48k）
なのに実機のブロック長が **512** だったため、`frac` が常に 1.0 に飽和して **ランプが 1 ブロックで
完了**していました（= ブロック境界の段差）。いまは `LineRamp::at(frame)` が
`start + step × frame` を返し、`step` は `(target − start) / ramp_frames` なので、
**ランプは block 長ではなく `ramp_frames` サンプルかけて進みます**。512 frame の block なら
先頭 240 frame が補間で、残りは `end` を保持します。**`at(frames)` は旧式の値とビット一致する**
ので、block 終端を見ている既存の golden は動きません。

ここで押さえておきたいのは、**production の乗算経路がこの 1 本になった**という点です。
`orbit_audio_core::Engine::set_global_gain`（core の scheduler ramp）は daemon から呼ばれなくなり、
`EngineWrap::set_global_gain` は `MasterLine` の目標値へ atomic store するだけになりました。
🔴 **#611 PR-O3b は、ここを master line へ写しませんでした**（2026-09-09・レビューで裁定）。
写すと `LineProgram::new` が ramp を毎回 unity から始めるため、`global.gain()` を 2 回以上呼ぶと
**直前の実効ゲインから目標へ寄る代わりに一度 1.0 へ跳ね上がる** — 可聴のポップになります。
設計 611 §4.2 の「**意味を変えない形で**写す」を満たせないので、写しは
**TS が `global.gain()` を `SetBusLine("master", …)` へ切り替える PR-O4 と同時**に、
§5.1 の「再 publish 時に実効値を引き継ぐ機構」とセットで入れます。

🔴 **2026-09-11 時点の現在地**: そのうち**後者（§5.1 の機構）だけが先に入りました**。
#611 PR-O4 の前半（[#834](https://github.com/signalcompose/orbitscore/pull/834)）が
`LineProgram::with_seeds` と `line_republish_seeds` を足し、`SetBusLine` の再 publish が
旧 program の実効値から続くようになっています（[SC-2](/signal-chain/mixer-audio-line) の
「再 publish は実効ゲインを引き継ぐ」節）。**`set_global_gain` 自体はまだ写していません** —
下の引用のとおり atomic を 1 つ store するだけで、line-program installer を呼びません。
残っているのは TS 側の切り替え（後半の束 `611-output-line`）で、そのとき
`LineControl::current_gains()` の doc が名指ししている直列化の契約
（`rust/crates/orbit-audio-native/src/output.rs:1254-1293`）を新たに満たす必要があります。

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9741-9750
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

wire（`SetGlobalGain`）の `ramp_sec` は互換のため受け取り続けますが、native 側は固定の
~5 ms ランプしか持たないので**値は使われません**。この順序の変更が signal chain 側から
どう見えるかは [SC-2](/signal-chain/mixer-audio-line) で扱います。

### `SetBusLine`: ライン全体を一度に差し替える wire

#611 PR-O3b で、コマンド表に `SetBusLine` という arm が 1 つ増えました。旧 `SetBusRouting` が
「output 先と send 群」という**固定の枠**を埋めるのに対し、`SetBusLine` は
`{ bus, line: [op, op, …] }` という**順序付きの op 列そのもの**を送り、その bus の line を丸ごと
置き換えます。op は `rack`（ラックを通す）・`gain`（線形ゲイン）・`pan`（ステレオ位置）・
`output`（出口）の 4 種で、配列順がそのまま signal 順になります。

`pan` は PR-O3b の時点では wire にも無く、型として存在する `LineOp::Pan` を
`validate_line_program` が「RT 未配線」を理由に拒否していました。#611 PR-O4 の前半
（[#834](https://github.com/signalcompose/orbitscore/pull/834)）でその両方が外れ、`-1..=1` の
`pan` op が wire に足されて RT でも実行されます。バス上の pan 則は素の等パワーではなく
`√2 · equal_power_pan(p)` で、理由（発音側が center で既に `1/√2` を掛けている）は
[SC-2](/signal-chain/mixer-audio-line) の「`Pan` — バス上の等パワー・パンニング」節にあります。

検証は 2 段に分かれていて、ここが読むときの勘所です。**JSON の形**（`op` の綴り・`rack` の重複・
`gain` の範囲・`dest` の形）は session 層の `parse_set_bus_line_params` が見て、
**名前から RT index への解決**（bus 名が実在するか・forward-only か）は topology を持つ
`EngineWrap::set_bus_line` が見ます。デバイスチャンネルの範囲だけは実際の出力幅を知る必要があるので、
dispatch が `engine.output_channels()` を渡して間に挟まります。

```rust
// rust/crates/orbit-audio-daemon/src/session.rs:2659-2674
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

面白いのは、`set_bus_line` が**検証を全部通してから一度だけ publish する**点です。2 番目の op が
不正なら 1 番目の op も反映されません。旧 `SetBusRouting` が「output と sends をまとめて送る」形に
なっていたのも同じ動機で、部分適用された中間状態を RT に見せないためでした。

宛先（`dest`）は `master` / `bus` / `device` / `render` / `link` の 5 種が wire 上に定義されて
いますが、受理されるのは前 3 つだけです。`render` は登記簿（`DeclareRender`）がまだ無いので
すべて未登録として弾かれ、`link` は RT が Link 出口を実行できないので `LINK_AUDIO_UNAVAILABLE` に
なります。どちらも「規則が違う」のではなく「規則を今日の状態に当てはめた結果」だと、
コード側のコメントが明示しています。

`device` の `channels` は、PR-O3b では 2 要素（L/R）固定でした。#611 PR-O4 の前半
（[#834](https://github.com/signalcompose/orbitscore/pull/834)）で **1 要素（mono）も受理**する
ようになり、形の検証は `matches!(channels.len(), 1 | 2)`、範囲の検証は「`left` は
`1..=output_channels`・`right` があるときだけ 0 でないこと・`left` と異なること」に変わりました。
要素数が 0 個や 3 個以上なら `MALFORMED_REQUEST`、形は正しいが範囲外なら `PARAM_OUT_OF_RANGE`
です（`rust/crates/orbit-audio-daemon/src/session.rs:3916-3954` の
`set_bus_line_wire_rejects_device_channel_arity_and_mono_out_of_range` が両方を固定しています）。

もう 1 つ、`SetBusRouting` との違いで押さえておきたいのが**宛先の kind 制約**です。
`SetBusRouting` は「output 先は sum bus のみ・send 先は aux bus のみ」を検証して拒否しますが、
`set_bus_line` の `bus` 宛ては forward-only（後段の index であること）しか見ておらず、
**kind では制限しません**。これは設計 611 の裁定（循環だけを拒否し kind では縛らない）に沿った
振る舞いで、`set_bus_line_accepts_a_forward_aux_destination`
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:3349-3371`）がそれを固定しています。

### master line の 2 本立て

`SetBusLine` は `bus: "master"` も受け取ります。ただし master は named bus の外側にいるので、
publish 先は `MasterLine` が持つ専用の `LineSlot` です。ここで気をつけたいのは、
**publish されたかどうかを別の一方通行フラグで持っている**という点です。

```rust
// rust/crates/orbit-audio-native/src/output.rs:800-810
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

このフラグが `false` の間、RT は上で見た固定の互換経路（ラック → gain → デバイス配置）を通ります。
`true` になって初めて `execute_master_line` が呼ばれ、publish された op 列を順に実行します。

```rust
// rust/crates/orbit-audio-native/src/output.rs:1935-1952
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

分岐が 2 本ある理由は、既存の出力を**ビット単位で**変えないためです。`else` 側の中身は
PR-O3b の前と 1 命令も違わないので、O0 golden（`OUTPUT_LINE_GOLDENS`）は 1 つも動きません。

ここから 1 つ帰結が出てきます。`execute_master_line` の `LineOp::Gain` は **program に書かれた値**を
読むので、master line が publish された後は `MasterLine::advance_gain`（`SetGlobalGain` が書く
atomic を読む関数）が呼ばれません。つまり publish 後の `SetGlobalGain` は、誰も読まない atomic を
更新するだけになります。PR-O3b の単体テスト `set_global_gain_only_updates_the_compatibility_atomic`
（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:3286-3309`）は、まさにこの
「`SetGlobalGain` は master program を publish し直さない」ことを固定しています。
2 つのゲイン経路が繋がるのは、TS の `global.gain()` が `SetBusLine("master", …)` へ切り替わる
PR-O4 で、再 publish 時に実効値を引き継ぐ機構と同時です。

engine render 部分の `render_engine_with_sources` は、instrument source（OOP instrument の出力を
`BlockSource` として持つ `SourceSlot`）と insert bus の有無で
4 通りに分かれます。source も active bus も無ければ、従来の `render_engine` に落ちます。

```rust
// rust/crates/orbit-audio-native/src/output.rs:2030-2071
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

`build_stream` はこの `render_shared_block` を cpal の `build_output_stream` クロージャから直接
呼びます。サンプルフォーマット（`F32`/`I16`/`I32`）ごとに 3 通りのクロージャがあり、`F32` 以外は
事前確保した scratch buffer に render してから量子化します（RT hot path でのヒープ確保を
避けるため、scratch buffer は 1 秒分をあらかじめ確保しています）。

```rust
// rust/crates/orbit-audio-native/src/output.rs:3224-3241
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

この「未使用時はビット同一」という設計原則は、[RE-3](/rust-engine/insert-bus) で扱う insert bus 経路や、
[RE-4](/rust-engine/capture-verification) の `ORBIT_CAPTURE_WAV` capture seam にも一貫して適用されています。

daemon 全体のアーキテクチャ確定（楽器=in-process・effects/3rd-party=out-of-process sandbox）の
背景は `docs/development/POST_2.0_MASTER_PLAN.html` に記載があります。

> 楽器（サンプラー/audio DSL）= in-process（crown jewel）／ effects + 3rd-party =
> out-of-process sandboxed plugin ／ audio DSL ⊇ pitch DSL

## 出力デバイスの生存確認 — 先に probe し、捨てる stream は pause する

`orbitscore.audioDevice` にデバイス名を書くと**音が一切出なくなる**（エラーも警告も出ない）という
不具合が #661 で報告されました。cpal の `build_output_stream` は成功を返すのに、そのデバイスの
コールバックが一度も走らない、という状態があり得ます。stream が「作れた」ことは「鳴る」ことを
意味しない、というのがこの節の出発点です。

対策は 2 段です。1 つめは、**デバイスを確定する前に捨ててよい probe stream で生存確認をする**こと。

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

probe を**実 stream より前に**置いているのは順序の都合です。実 stream を先に作ってから dead と
判定すると、`insert_buses` / `sources` が既に `RenderState` へ move されていて回収できません。
カウンタが probe 専用なのも同じ用心で、`StreamStats` を借りると 1 Hz ticker の callback 数が
「実 stream が存在する前」に膨らんでしまいます。

2 つめが、上のコードのコメントが名指ししている **cpal 0.15.3 の参照循環**です。捨てるはずの
stream を drop しただけではコールバックが止まらないので、`OutputStream` は `Drop` でも明示的に
`pause()` します。

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

これを外すとどうなるかは実機で測れます。名指し起動から host 既定へ切り替えたときの実測
callbacks/s は、`pause()` が 2 箇所とも生きていれば 94（期待値 93.8）、両方外すと **188**
になります。旧ストリームが生き続けて、新旧 2 本が同時に回っている状態です（PR #748 の実測表）。

面白いのは、**縮退のポリシーが起動経路とライブ切替経路で逆になる**ところです。ここは型で
分けられています。

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

起動時に縮退するのは「設定を書いたら無音になる」を防ぐため、ライブ切替で縮退しないのは
「演奏中のタイプミスで音が内蔵スピーカーへ移らない」ためです。同じ「デバイスが使えない」でも
利用者が困る方向が逆なので、扱いも逆になります。`bool` の位置引数ではなく enum にしてあるのは、
取り違えてもコンパイルが通ってしまう形を避けるためだと doc コメントに書かれています。

失敗したときに利用者へ何を見せるかは protocol 側のエラーコードで分かれます。表は
`docs/research/ENGINE_DAEMON_PROTOCOL.md` の「`SelectAudioDevice` の失敗コード」節にあり、
エディタはその「音は鳴っているか」列を見て `Restart Engine` を出すかどうかを決めています
（`packages/vscode-extension/src/engine-view.ts` の `SELECT_AUDIO_DEVICE_ERRORS`）。

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

- `EngineWrap::apply_device_switch` の内側 — probe を通ったあとの cpal stream 再構築と `RenderState` の引き継ぎ
- `StreamStats` 1 Hz ticker が発火する `DaemonError` の一覧（`protocol.rs:86-161` のエラーコード群）と、それぞれの観測点
- `RenderScore`（#598 P2）の offline render 経路
- `forward_plugin_ui_events` の lag 処理（loss-sensitive な close/safepoint frame をどう扱うか）

## Sources

- `rust/crates/orbit-audio-daemon/src/main.rs:1-265` — daemon エントリポイント。boot シーケンス（CLI 引数 → audio owner thread → WebSocket bind → ready line 出力 → accept loop）と panic hook（#605）、既知の shutdown ギャップ（#448）
- `rust/crates/orbit-audio-daemon/src/server.rs:1-79` — WebSocket accept loop（`bind_localhost` / `serve` / `handle_connection`）
- `rust/crates/orbit-audio-daemon/src/protocol.rs:1-195` — wire protocol の型定義（`Handshake` / `Command` / `OkResponse` / `ErrorResponse` / `Event` / エラーコード定数）。契約の正本は `docs/research/ENGINE_DAEMON_PROTOCOL.md`
- `rust/crates/orbit-audio-daemon/src/session.rs:691-718,1272-2372` — `session::run`（handshake・writer task・UI event 転送）と `handle_command` の match arm（コマンド表の出典）
- `rust/crates/orbit-audio-native/src/output.rs:254-260,581-618,662-750,1513-1556` — `RenderState` / `render_shared_block` / `render_block_with_sources` / `render_engine_with_sources` / `build_stream`
- `rust/crates/orbit-audio-native/src/output.rs:682-688,700-754,1253-1277` — `ENGINE_CHANNELS` / `MasterLine`（ラック → gain）/ `place_master_into_device`（#649 PR-O2）
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:9741-9750` — `EngineWrap::set_global_gain`（PR-O3b では **atomic のみ**。master line への写しは PR-O4 と同時・`ramp_sec` は wire 互換のみ）
- `rust/crates/orbit-audio-native/src/output.rs:1926-1930,1932-1985` — `DeviceLineBuffer` / `add_to_device`（直行デバイスライン・#611 PR-O3a）
- `rust/crates/orbit-audio-daemon/src/session.rs:306-361,2633-2648` — `parse_set_bus_line_params`（wire 形の検証）と `SetBusLine` の dispatch arm（#611 PR-O3b）
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs:6753-6906` — `EngineWrap::set_bus_line`（名前 → RT index の解決・全検証後に一度だけ publish）
- `rust/crates/orbit-audio-native/src/output.rs:739-759,1783-1841` — `MasterLine.line` / `explicit_line` / `execute_master_line`（#611 PR-O3b）
- `packages/engine/src/audio/rust-engine/daemon-client.ts:86-97,715-718` — `WireDest` / `WireLineOp` / `DaemonClient.setBusLine`（呼び出し元は PR-O4）
- PR [#811](https://github.com/signalcompose/orbitscore/pull/811) — 束 O-wire（line program 化・互換維持）
- PR [#824](https://github.com/signalcompose/orbitscore/pull/824) — 束 O-wire-b（`SetBusLine` の wire 契約・DSL からは呼ばない）
- [`docs/design/611-output-line-design.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/design/611-output-line-design.md) §5.2-5.5 — master ライン・内部幅 2ch・core master gain を production から外す設計正本
- [`docs/development/POST_2.0_MASTER_PLAN.html`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/POST_2.0_MASTER_PLAN.html) — engine-first ロードマップとアーキ確定（楽器=in-process／effects+3rd-party=out-of-process sandbox）
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 / 6.262 — capture peak の実測記録
- [`docs/archive/WORK_LOG_2026-08.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-08.md) 6.415 — master fader 不具合（#643）
- `rust/crates/orbit-audio-daemon/src/outproc_shm_sweep.rs:167-196` — `sweep_orphaned_outproc_shm`（段 0.5 が呼ぶ薄い殻・`tracing::info!` 1 行の要約）
- Issue [#448](https://github.com/signalcompose/orbitscore/issues/448) — daemon の graceful-shutdown ギャップと `ParentWatch` 対策
- Issue [#779](https://github.com/signalcompose/orbitscore/issues/779) / PR [#784](https://github.com/signalcompose/orbitscore/pull/784) — 起動時の孤児 shm 回収（段 0.5）
- Issue [#484](https://github.com/signalcompose/orbitscore/issues/484) — audio device の列挙・選択・ランタイム切替（D1 / D2 / D3）
- Issue [#605](https://github.com/signalcompose/orbitscore/issues/605) — panic hook の best-effort stderr 化
