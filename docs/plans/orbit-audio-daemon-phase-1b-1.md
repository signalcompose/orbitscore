# Plan: orbit-audio-daemon Phase 1b-1 (scaffold + core commands)

**対象 Issue**: [#107](https://github.com/signalcompose/orbitscore/issues/107)
**Epic**: [#105](https://github.com/signalcompose/orbitscore/issues/105)
**前提**: PR #110 (workspace split) + PR #111 (protocol spec) merged
**想定 effort**: medium
**スコープ**: 1 cycle で Phase 1b-1 を完結。Events / Stats は別 cycle (1b-2)

---

## 1. 目的

`docs/research/ENGINE_DAEMON_PROTOCOL.md` で定義した IPC protocol v0.1 のうち、**サンプル再生に必要な最小 command 集合**を実装する WebSocket daemon バイナリを新設する。

---

## 2. 参照

- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — 実装契約（必読）
- `docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md` — 責務境界
- `rust/crates/orbit-audio-native/` — 既存の音声 I/O 層（再利用）

---

## 3. スコープ

### 含む (Phase 1b-1)

- `rust/crates/orbit-audio-daemon/` 新規 crate（binary）
- `tokio` + `tokio-tungstenite` の async WebSocket server
- Startup シーケンス:
  - free port bind, stdout に `{"ready": true, "port": ..., "protocol_version": "0.1"}` 出力
  - 失敗時 stderr + 非ゼロ exit
- Handshake フレーム送出
- 以下の Phase 1 commands を実装:
  - `Ping` → `"pong"`
  - `GetStatus` → 基本情報
  - `LoadSample { path }` → sample_id（orbit-audio-native::load_sample_resampled を使用）
  - `UnloadSample { sample_id }`
  - `PlayAt { time_sec, sample_id, gain?, pan? }` → play_id
  - `Stop { play_id }` → status
  - `SetGlobalGain { value, ramp_sec? }`
- Engine 起動 (orbit-audio-native::start_default_output)
- エラー型を protocol の code に mapping
- 最小 smoke test（内部 WS クライアントで往復確認）

### 含まない（別 cycle で）

- Events (PlayStarted / PlayEnded / StreamStats / DaemonError) — Phase 1b-2
- lock-free ringbuf 化（Phase 1b-1 は Mutex 経由で OK）
- Plugin 関連 command（Phase 2）
- TypeScript 側 client（Issue #108）

---

## 4. 完了条件

- [ ] `rust/crates/orbit-audio-daemon/` 新規 crate（`[[bin]]` target）
- [ ] `cargo check --workspace --all-targets` clean
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean
- [ ] `cargo fmt --all --check` clean
- [ ] `cargo test --workspace --lib` 既存 17 tests 維持 + 新規 smoke test
- [ ] `cargo build --release --bin orbit-audio-daemon` 成功
- [ ] 手動動作確認:
  - daemon 起動 → stdout ready line 出力
  - WebSocket 接続 → handshake frame 受信
  - `Ping` コマンド → `"pong"` Response
  - `LoadSample` + `PlayAt` コマンドで実機再生
- [ ] workspace `Cargo.toml` の `members` に追加

---

## 5. 実装方針

### Crate 構成

```
rust/crates/orbit-audio-daemon/
├── Cargo.toml
└── src/
    ├── main.rs          # main: tokio runtime, cli, 起動シーケンス
    ├── server.rs        # WebSocket accept loop
    ├── protocol.rs      # Command / Response / Event / Error の型
    ├── session.rs       # 1 接続あたりの処理
    └── engine_wrap.rs   # orbit-audio-native + 状態管理
```

### 依存

```toml
[dependencies]
orbit-audio-core = { path = "../orbit-audio-core" }
orbit-audio-native = { path = "../orbit-audio-native" }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "io-util", "net"] }
tokio-tungstenite = "0.24"
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
uuid = { version = "1", features = ["v4"] }
thiserror = { workspace = true }
tracing = { version = "0.1" }
tracing-subscriber = { version = "0.3" }
```

workspace.dependencies への `serde` / `serde_json` / `uuid` / `tracing` / `tracing-subscriber` 追加も必要。

### Command / Response のシリアライズ

- `#[derive(Serialize, Deserialize)]` + `#[serde(tag = "method", content = "params")]` で Command 判別
- UUID は `uuid::Uuid::new_v4().to_string()`（`id` マッチに使用）

### State

- `Engine` と `loaded_samples: HashMap<SampleId, Sample>` と `active_plays: HashMap<PlayId, ActivePlay>` を Arc<Mutex> で wrap（PoC の簡略化）
- TS 側 CLose 時にクリーンアップ（drop_all samples / stop_all plays）

### エラーマッピング

```rust
impl From<ResampleError> for ProtocolError {
    fn from(e: ResampleError) -> Self { ... RESAMPLE_ERROR ... }
}

impl From<LoaderError> for ProtocolError {
    // IO -> FILE_DECODE_ERROR or SAMPLE_NOT_FOUND（std::io::ErrorKind::NotFound 判定）
    // Decode -> FILE_DECODE_ERROR
    // Unsupported -> UNSUPPORTED_FORMAT
    // Resample(e) -> e 経由
}
```

### 動作確認の smoke test

`tests/smoke.rs` に integration test を配置。`tokio::main` で daemon を起動し、別タスクで WS クライアント接続、Ping を送って pong を受け取る。

---

## 6. DDD / ドキュメント更新

- [ ] `rust/README.md` の crate 一覧に `orbit-audio-daemon` を追加
- [ ] `docs/development/WORK_LOG.md` に 6.58 エントリを追加
- [ ] `docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md` Cargo workspace 節を実態に合わせて更新

**DSL 仕様への言及はしない**（実装を真実とする方針）。

---

## 7. 検証項目

- [ ] `cargo check --workspace --all-targets` clean
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean
- [ ] `cargo fmt --all --check` clean
- [ ] `cargo test --workspace`: 既存 17 tests + 新規 smoke test 通過
- [ ] `cargo build --release --bin orbit-audio-daemon` 成功
- [ ] 手動: `cargo run --bin orbit-audio-daemon` → stdout ready → wscat でチェック
- [ ] 手動: LoadSample + PlayAt で実機音出し

---

## 8. 非目標（重要な再確認）

- **Events (PlayStarted / PlayEnded / StreamStats / DaemonError) は未実装**（Phase 1b-2）
- **lock-free ringbuf 化は未実装**（Phase 1b-2 以降で必要になったとき）
- **DSL / interpreter / musical timing 不変**
- **TS クライアントは別 Issue #108**
- **Plugin 関連 command は Phase 2**

---

## 9. リスク

- `tokio-tungstenite` の version 選定。`0.24` で tokio `1` 系との互換性確認
- Audio callback (`cpal`) と WebSocket async runtime の cohabitation: cpal の callback は OS スレッドで動くので tokio 非依存、engine 状態を Arc<Mutex> で共有すれば問題なし
- `serde` の `#[serde(tag = "method")]` バリアント数が多いと macro 展開が長くなる → 問題になれば手書き impl に切替

---

## 10. 次のステップ（本 PR merge 後）

- Phase 1b-2: Events + StreamStats 実装
- Phase 1b-3: Issue #108 の TS client 着手
