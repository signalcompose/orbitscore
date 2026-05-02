# OrbitScore Development Work Log - 2026-04 Archive

**Archive Period**: 2026-04
**Note**: This is an archived version of the work log. For recent work, see [../development/WORK_LOG.md](../development/WORK_LOG.md)

---

### 6.63 Issue #107: orbit-audio-daemon fatal DaemonError (April 18, 2026)

**Date**: April 18, 2026
**Status**: ✅ COMPLETE (Phase 1b-6: fatal DaemonError — DEVICE_LOST / FATAL_PANIC)
**Branch**: `107-daemon-fatal-errors`
**Issue**: #107

**Work Content**: Phase 1b の最終 scope として protocol v0.1 の `DaemonError severity=fatal` 2 経路を実装し、daemon 側の Phase 1b 完了。

**実装**:
- `StreamStats` に `device_lost: AtomicBool` を追加、`record_device_lost()` / snapshot 拡張
- `make_err_fn` の closure で `cpal::StreamError` を variant で振り分け: `DeviceNotAvailable` → `record_device_lost`、`BackendSpecific` → `record_xrun`
- `session.rs` stats_task 1 Hz ticker に device_lost 検知ブロックを xrun より前に挿入、1 回だけ fatal DaemonError (`DEVICE_LOST`) 発火
- `main.rs` に `install_fatal_panic_hook()`: panic 時に DaemonError wire format を stderr に 1 行出力し `process::exit(1)` で確実終了。`StartupError { ready: false }` は pre-ready 失敗専用なので意図的に使わない
- unit test 4 件追加（device_lost atomic 2件 + err_fn variant dispatch 2件）
- 既存 test（stream_stats_starts_at_zero / record_xrun_increments_only_xruns）を device_lost フィールド込みに更新

**設計上の既知トレードオフ** (プランで合意、scope 外):
- 複数 client 同時接続時は各 session が独立に DEVICE_LOST を発火する（broadcast registry は将来拡張）
- audio thread での DeviceNotAvailable から tokio 側 1 Hz tick 観測まで最大 1 秒の検知遅延（fatal としては許容）

**検証**:
- cargo build / clippy --workspace --all-targets -D warnings clean
- cargo test --workspace: core 14 / native 16 / daemon 1 smoke = 31 pass
- FATAL_PANIC は panic hook が process-global のため unit test では単離困難。Issue #117（統合テスト基盤）で対応

---

### 6.62 Issue #107: orbit-audio-daemon Stop 個別停止実装 (April 18, 2026)

**Date**: April 18, 2026
**Status**: ✅ COMPLETE (Phase 1b-5: per-play Stop)
**Branch**: `107-daemon-stop`
**Issue**: #107

**Work Content**: これまで常に `not_found` を返す no-op だった `Stop` コマンドを実装。`Scheduler::stop(play_id)` で events から対象を削除、`Engine` / `EngineWrap` 経由で daemon session が呼び出す。protocol v0.1 の `stopped` / `not_found` 返却を満たす。

**実装**:
- `ScheduledSample` / `ActiveSample` に `play_id: Option<String>` を追加
- `Scheduler::stop(&str) -> bool` で events retain 経由の削除
- `Engine::schedule_with_play_id` / `Engine::stop` を公開
- `EngineWrap::play_at` は生成した `play_id` を `schedule_with_play_id` 経由で渡す
- `EngineWrap::stop(play_id) -> Result<bool, _>` を追加
- `Stop` handler を実装に置き換え、`play_id` 欠落を `MALFORMED_REQUEST` で返却

**テスト**:
- scheduler: 一致 id で削除 / 未知 id で no-op — 2 件追加
- 既存 12 native / 14 core / 1 daemon smoke 全 pass
- clippy clean

**スコープ外**:
- `already_stopped` 状態の区別（履歴追跡が必要、現状は `not_found` にまとめる）
- DaemonError severity=fatal (panic hook / device lost)

---

### 6.61 Issue #107: orbit-audio-daemon SetGlobalGain 実装 (April 18, 2026)

**Date**: April 18, 2026
**Status**: ✅ COMPLETE (Phase 1b-4: SetGlobalGain with ramp)
**Branch**: `107-global-gain`
**Issue**: #107

**Work Content**: これまで `accepted` を返すだけの no-op だった `SetGlobalGain` コマンドを実装。`Scheduler` に master gain + 線形ランプ機能を追加し、Engine / EngineWrap / session.rs を経由して protocol v0.1 仕様を満たすようにした。

**実装**:
- `orbit-audio-core::Scheduler` に `global_gain` / `target_gain` / `ramp_frames_remaining` を追加、`set_global_gain(value, ramp_frames)` を公開
- `render` 末尾で混合済み出力にマスターゲインを後適用（per-frame 線形ランプ、allocation 無し）
- `Engine::set_global_gain(value, ramp_sec)` で秒 → frames 変換を担当
- `EngineWrap::set_global_gain` 経由で daemon session がそのまま呼べる
- `SetGlobalGain` handler を実装に置き換え、`ramp_sec` バリデーション（負値エラー）を追加

**テスト**:
- scheduler: 即時セット / 線形ランプ後に target 到達 / 負値クランプ — 3 件追加
- 既存 12 native tests / 11 core tests 全て pass
- clippy clean

**非対応（次フェーズ）**:
- 個別 Stop 実装（Scheduler に play_id 追跡が必要）
- DaemonError severity=fatal（panic hook / device lost 検出）

---

### 6.60 Issue #107: orbit-audio-daemon Phase 1b-3 StreamStats / DaemonError (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE (Phase 1b-3: StreamStats 1 Hz + DaemonError warning path)
**Branch**: `107-daemon-stream-events`
**Issue**: #107（Phase 1b-3 の一部）

**Work Content**: orbit-audio-daemon に StreamStats イベントの 1 Hz 周期送信と、cpal `err_fn` からの xrun 検知を経由する DaemonError (severity=warning, code=STREAM_XRUN) 通知を実装。Phase 1b-2 で導入した mpsc writer task 経路を再利用し、接続ごとに ticker task を起動する。

**実装**:
- `orbit-audio-native/src/output.rs` に `StreamStats { xruns, buffer_underruns }` atomic counter を追加、`start_default_output` の戻り値を `(Engine, OutputStream, Arc<StreamStats>)` に拡張
- `err_fn` を factory 化し xrun 発生時に atomic increment
- `engine_wrap.rs` に `stream_stats_snapshot()` を追加
- `session.rs` に 1 Hz ticker task を追加。前回値と比較して xrun 増分があれば DaemonError warning を先に送出、続けて StreamStats を送出
- session 終了時に `stats_task.abort()` で cleanup

**スコープ外（次フェーズ）**:
- `cpu_load` 実測（現状は 0.0 stub、コールバック timing 計測基盤が未整備）
- `buffer_underruns` の個別集計（cpal `StreamError` が underrun を区別しないため 0 stub）
- DaemonError severity=fatal（DEVICE_LOST / FATAL_PANIC） — panic hook と cpal device lost 検出が必要

**検証**:
- `cargo build --workspace` clean
- `cargo test -p orbit-audio-daemon` 1 pass（smoke test）
- 既存 PlayStarted/PlayEnded 経路への影響なし

---

### 6.59 Issue #107: orbit-audio-daemon Phase 1b-2 events (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE (Phase 1b-2 小スコープ: PlayStarted / PlayEnded events)
**Branch**: `107-daemon-events`
**Issue**: #107（Phase 1b-2 の一部）

**Work Content**: orbit-audio-daemon に Phase 1 event 発行を追加。`PlayStarted` を PlayAt 応答直後に送り、`PlayEnded` を `start_sec + duration_sec` で遅延送信する。writer task 分離構造 (mpsc) で、今後の StreamStats / DaemonError も同一経路で発行可能になった。

**設計変更**:
- session.rs を reader / writer 2 task 構造にリファクタ (`tokio::sync::mpsc` で合流)
- PlayHandle に `sample_id` / `start_sec` / `duration_sec` を追加
- `schedule_play_ended` ヘルパで遅延送信タスクを spawn
- back pressure 用 channel capacity = 128

**Changes**:
- `rust/crates/orbit-audio-daemon/src/session.rs` を mpsc ベースに書き換え
- `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` PlayHandle 拡張

**検証**:
- cargo check / clippy / fmt / test clean、18 tests pass 継続
- WebSocket 往復は smoke test と手動検証

**非対応（将来）**:
- StreamStats 1 Hz: 同じ mpsc 経路で追加可能、Phase 1b-3 で実装
- DaemonError 経路: cpal err_fn からの通知経路が必要
- 個別 Stop / SetGlobalGain の実動作: Engine API 追加が必要
- lock-free ringbuf 化

---

### 6.58 Issue #107: orbit-audio-daemon Phase 1b-1 (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE (Phase 1b-1 スコープ)
**Branch**: `107-orbit-audio-daemon`
**Issue**: #107（Epic #105 の Phase 1b-1）

**Work Content**: IPC protocol v0.1 を実装する WebSocket daemon バイナリ `orbit-audio-daemon` を新設。Phase 1b-1 の範囲で Core commands を実装し、起動シーケンス（stdout ready line + stderr 失敗通知 + handshake frame）を protocol 仕様通りに整備。

**実装 commands**:
- `Ping` / `GetStatus`
- `LoadSample` / `UnloadSample` / `PlayAt` / `Stop` / `SetGlobalGain`

**Stack**:
- `tokio` 1.x multi-thread runtime
- `tokio-tungstenite` 0.24 WebSocket server
- `serde` / `serde_json` でメッセージ型
- `uuid` で sample_id / play_id 生成
- `tracing` で構造化ログ (stderr に出力)

**設計メモ**:
- `cpal::Stream` は `!Send` のため、`EngineWrap` からは分離し `StreamGuard` として main 側で alive に保持
- 1 接続 = 1 tokio task。Engine は `Arc<Mutex>` 共有
- 起動失敗時は stderr に 1 行 JSON + 非ゼロ exit で通知

**Changes**:
- `rust/crates/orbit-audio-daemon/` 新規 crate（bin target）
  - `src/main.rs`: tokio runtime + startup sequence
  - `src/server.rs`: accept loop
  - `src/session.rs`: 1 接続のメッセージディスパッチ
  - `src/engine_wrap.rs`: Engine + sample 管理 (Mutex-based)
  - `src/protocol.rs`: Command/Response/Event/Error 型
  - `tests/smoke.rs`: daemon 起動と ready line 出力の smoke test
- `rust/Cargo.toml`: workspace members に追加、tokio/serde/uuid/tracing を `[workspace.dependencies]` に集約
- `rust/README.md`: crate 一覧と Quick start に daemon を追加

**検証**:
- `cargo check --workspace --all-targets` clean
- `cargo clippy --workspace --all-targets -- -D warnings` clean
- `cargo fmt --all --check` clean
- `cargo test --workspace`: 18 passed (core 8 + native 9 + daemon smoke 1)

**非対応**（Phase 1b-2 以降）:
- Events (PlayStarted / PlayEnded / StreamStats / DaemonError) 発行
- 個別 play の Stop 実装（現状は常に `not_found` 返却）
- SetGlobalGain の実動作（accepted を返すが no-op）
- lock-free ringbuf 化

---

### 6.57 Issue #93: Engine Daemon IPC Protocol Design (Phase 1b 設計) (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `93-engine-daemon-ipc-protocol`
**Issue**: #93（Epic #105 の Phase 1b 設計）

**Work Content**: TypeScript 側 app layer と Rust 側 audio daemon を繋ぐ IPC プロトコル（v0.1 draft）を設計。`docs/research/ENGINE_DAEMON_PROTOCOL.md` として文書化。後続の #107 (daemon 実装) / #108 (TS client) の契約となる。

**設計の骨子**:
- トランスポート: WebSocket over localhost（`127.0.0.1` bind、認証なし）
- エンコーディング: UTF-8 JSON（バイナリフレーム不使用）
- メッセージ型: Command / Response / Event の 3 トリプル
- Phase 1 必須 commands: LoadSample / UnloadSample / PlayAt / Stop / SetGlobalGain / GetStatus / Ping
- Phase 1 events: PlayStarted / PlayEnded / StreamStats / DaemonError
- Phase 2 予約: Plugin / MIDI Event 型（定義のみ、実装は後続 Issue）
- MCP との関係性を整理（将来のブリッジ方針を明記）

**Changes**:
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` 新規作成（12 セクション）
- `docs/core/INDEX.md` に新規ドキュメントへのリンク追加

**非変更**:
- 実装コード一切なし（100% 設計文書）
- DSL / interpreter / musical timing 不変

**次のステップ**:
- Issue #107（orbit-audio-daemon binary 実装、本 protocol を実装）
- Issue #108（TS rust-engine client、本 protocol のクライアント）

---

### 6.56 Issue #106: Rust Cargo workspace split (Phase 1a) (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `106-rust-workspace-split`
**Issue**: #106（Epic #105 の Phase 1a）

**Work Content**: 単一 crate `orbitscore-engine` を Cargo workspace に再構成。`orbit-audio-core` を platform-agnostic な独立 crate として切り出し、将来の plugin 分離や他プロダクト転用の土台を作る。

**構成**:
```
rust/
├── Cargo.toml (workspace root)
└── crates/
    ├── orbit-audio-core/       (prev src/core)
    ├── orbit-audio-native/     (prev src/native + examples)
    └── orbit-audio-wasm/       (prev src/wasm、スタブ)
```

**Changes**:
- ワークスペース化: 旧 `rust/Cargo.toml` を `[workspace]` root に、各 crate 配下に独立した `Cargo.toml`
- モジュール再配置: `src/core/` → `crates/orbit-audio-core/src/`、他も同様
- 例の移設: `examples/poc_play.rs` → `crates/orbit-audio-native/examples/`
- use 文更新: `crate::core::...` → `orbit_audio_core::...`
- 旧 feature flag（native / wasm / 相互排他の compile_error）は crate 分割により不要となり削除
- `rust/Cargo.lock` は再生成

**検証**:
- `cargo check --workspace --all-targets` clean
- `cargo clippy --workspace --all-targets -- -D warnings` clean
- `cargo test --workspace --lib`: 17 passed (core 8 + native 9)
- `cargo build --release` 成功
- `cargo run --example poc_play` で実機再生 OK

**非変更**:
- DSL / interpreter / musical timing（TypeScript 側）は一切触らず
- Rust コードのロジックは変更なし（機械的リファクタのみ）

**次のステップ**:
- Issue #93（IPC プロトコル設計）
- Issue #107（orbit-audio-daemon バイナリ）
- Issue #108（TS rust-engine client）

---

### 6.55 Issue #100: Sample rate conversion on load via rubato (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `100-sample-rate-conversion`
**Issue**: #100

**Work Content**: PoC #91 で明示された既知の制限「サンプリング周波数変換 (SRC) なし」を解消。rubato 2.0 を使って**ロード時**に Project SR へ一度だけ変換する方式（Pro Tools / Logic Pro 方式）を採用。再生時（リアルタイム）は従来通り 1:1 マッピングで低レイテンシを維持。

**追加モジュール**:
- `rust/src/native/resampler.rs` (新規)
  - `resample_to(sample, target_sr)` — rubato の FftFixedSync::Both で高品質変換
  - `ResampleError` (Init / Process / ZeroChannels)

**API 追加**:
- `rust/src/native/loader.rs`: `load_sample_resampled(path, target_sr)` を公開
  - ソース SR と target_sr が一致する場合はコピーせずそのまま返す
  - 異なる場合のみ resampler を呼ぶ

**依存追加**:
- `rubato = "2"` (optional, native feature)
- `audioadapter-buffers = "3"` (optional, native feature)

**テスト追加** (4 件、合計 12 tests):
- same_sample_rate_passes_through — パススルーの確認
- upsample_44100_to_48000_preserves_duration — 持続時間 ±5ms
- downsample_96000_to_48000_halves_frames — フレーム数半減
- zero_channel_sample_returns_error — 不正入力の早期エラー

**example 更新**:
- `poc_play.rs` が `load_sample_resampled(path, stream.sample_rate)` を使用
- 異なる SR の WAV を渡しても正しいピッチ・テンポで再生できる

**ドキュメント**:
- `rust/README.md` Known Limitations から SRC 項目を削除
- WORK_LOG に本エントリ追加

**検証**:
- cargo check / clippy -D warnings / fmt --check すべて clean
- cargo test --lib: 12 passed, 0 failed
- PoC (examples/poc_play) 動作確認 OK

---

### 6.54 Issue #91: Rust audio engine proof of concept (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE（PoC スコープ）
**Branch**: `91-rust-engine-poc`
**Issue**: #91

**Work Content**: `rust/` 配下に単一 crate `orbitscore-engine` を新設し、`cpal` + `symphonia` による最小の「WAV ロード → 時間軸スケジュール → デスクトップ再生」PoC を実装。WASM 対応（将来の "OrbitScore Lite" ウェブ版）を Cargo features で day 1 から意識。

**ディレクトリ構成**:
```
rust/
├── Cargo.toml              # features: default=native, wasm は予約
├── rust-toolchain.toml     # stable + rustfmt + clippy
├── .gitignore              # target/
├── README.md
├── src/
│   ├── lib.rs
│   ├── core/               # Engine / Sample / Scheduler（プラットフォーム非依存）
│   ├── native/             # cpal + symphonia（feature = "native"）
│   └── wasm/               # wasm-bindgen スタブ（feature = "wasm"、予約）
└── examples/
    └── poc_play.rs         # cargo run --example poc_play -- <wav>...
```

**検証結果**:
- kick.wav / snare.wav を 500ms 間隔でラウンドロビン再生（6 秒間）
- `cargo check --all-targets` / `cargo clippy -- -D warnings` / `cargo fmt --check` すべて clean
- 初回フルビルド 約17秒、インクリメンタル 0.3 秒
- 実機の 36ch オーディオインターフェース環境でも動作（デバイス config に合わせて Engine を自動構築する API 設計）

**重要な設計判断**:
- **後から分離可能な構造**: `rust/` ディレクトリを独立 Cargo workspace としてまとめ、将来 `signalcompose/orbitscore-engine` として分離できる。ただしスピード優先で当面は monorepo。
- **WASM 対応予約**: `feature = "wasm"` を Cargo で定義し、`src/wasm/` をスタブで用意。`cpal` / `symphonia` は `dep:` プレフィックスで optional 化。
- **デバイス config 追従**: `start_default_output() -> (Engine, OutputStream)` が cpal のデバイス config に合わせて Engine を構築する。呼び出し側は config ミスマッチを意識しない。

**成果物**:
- `rust/` crate 一式
- `docs/research/RUST_POC_FINDINGS.md` — 所感レポート

**結論**: Rust 化は技術的に十分現実的。Phase 2（本実装）に進める地固めが完了。

---

### 6.53 Issue #97: Align test count references and link Rust migration research issues (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `97-update-test-count-docs`
**Issue**: #97

**Work Content**: 複数ドキュメントで古い「225 passed」と記載されていたが、実測値は **220 passed, 23 skipped, 243 total = 90.5%**。現状に合わせて修正。併せて Rust 移行計画に Research Issue 群（#91-#96）へのリンクを追加。

**テスト数更新**:
- `CLAUDE.md` L121, L128
- `README.md` L233
- `docs/testing/TESTING_GUIDE.md` L4 (+ Last Updated を 2026-04-17 に), L71
- `docs/development/IMPLEMENTATION_PLAN.md` L45
- `docs/planning/RUST_ENGINE_MIGRATION_PLAN.md` L59

**Rust 移行計画の進捗反映**:
- `docs/planning/RUST_ENGINE_MIGRATION_PLAN.md` §7「次のアクション」を更新
  - 完了項目（PR #88 ライセンス、PR #90 Dependabot）にチェック
  - Research Issue #91-#96 へのリンクを追加
  - 組織タスク（Rust 経験者確保、メールセットアップ）を追記

**新規作成 Research Issues**:
- #91: spike: Rust audio engine proof of concept
- #92: research: time-stretch DSP library selection for Rust engine
- #93: design: engine daemon IPC protocol
- #94: design: Tauri standalone application architecture
- #95: research: VST3 and CLAP plugin hosting in Rust
- #96: design: LLM agent integration architecture

**Tests**: 220 passed, 23 skipped（変更なし、docs のみ更新）

---

### 6.52 Issue #89: Fix Dependabot vulnerabilities, excluding supercolliderjs-related (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `89-fix-dependabot-safe-vulns`
**Issue**: #89

**Work Content**: `npm audit fix`（非 `--force`）で安全に解消できる脆弱性を修正。SuperCollider 関連（`@supercollider/*`, `supercolliderjs` 配下の `js-yaml` 等）は将来的に Rust エンジンへ置換予定のため、意図的にスキップ。

**結果**:
- 修正前: 22 脆弱性（1 low, 11 moderate, 10 high）
- 修正後: 10 脆弱性（すべて moderate）
  - `js-yaml`（SC 経由、Rust 移行で解決予定）
  - `esbuild`（vitest 経由、dev 依存のみ）
- **High 深刻度 10 件すべて解消**
- Low / 一部 Moderate も解消（brace-expansion, flatted, immutable, jws, lodash, minimatch, picomatch, qs, rollup, underscore, undici, yaml 等）

**Changes**:
- `package-lock.json` のみ更新（346 insertions, 295 deletions）
- `package.json` は変更なし（宣言依存の breaking change は発生せず）

**Tests**: 220 passed | 23 skipped（main 側と同数、リグレッションなし）

**補足観察**:
- 既存ドキュメント（CLAUDE.md, README.md, TESTING_GUIDE.md, IMPLEMENTATION_PLAN.md 等）の「225 passed」記述は現状と一致していない（実測値は 220 passed）。別 Issue で統一検討。

---

### 6.51 Issue #87: Adopt Signal compose Fair Trade License (April 17, 2026)

**Date**: April 17, 2026
**Status**: ✅ COMPLETE
**Branch**: `87-adopt-fair-trade-license`
**Issue**: #87

**Work Content**: ソースコードのライセンスを MIT から Signal compose Source-Available License v1.0 へ切り替え。将来の商用展開（Steam / App Store 販売）戦略に合わせた Fair Trade 型ライセンスを採用。

**採用条項**:
- Apache License 2.0 をベースに
- Commons Clause（他者による再販制限）
- Fair Revenue Clause（年商 $250K 超は要商用ライセンス、買い切りモデル、料金は問い合わせベース）
- Academic Exception（学生・教職員は常に無償）

**Changes**:
- `LICENSE` を MIT から Signal compose Source-Available License v1.0 へ書き換え
- `package.json` の `license` を `"SEE LICENSE IN LICENSE"` に更新、`author` を `Signal compose Inc.` に変更
- `README.md` のライセンスセクションを新規ライセンスに合わせて更新（条項サマリー、連絡先、パッケージ製品との区別を明記）
- `.claude/license.local.md` に連絡先メール（license@signalcompose.com）を保存
- `docs/planning/RUST_ENGINE_MIGRATION_PLAN.md` を新規作成（Rust サウンドエンジン移行計画と戦略ロードマップ）
- `docs/core/INDEX.md` に新規プラン文書へのリンクを追加

**重要な区別**:
- ソースコード: Signal compose Source-Available License v1.0
- 完成ソフトウェア（Steam / App Store / Gumroad 販売）: 別途 EULA で配布

**連絡先**: license@signalcompose.com（メールアドレスのセットアップは別途対応予定）

---

### 6.46 Fix pre-edit-check.sh hook protocol violation (April 18, 2026)

#### 背景
`.claude/hooks/pre-edit-check.sh` の main ブランチ block 時に Claude Code が "No stderr output" エラーを表示し、親切なブロック理由が user に到達していなかった (Issue #119)。

#### 原因
1. Shell スタイル block (`exit 2`) なのに理由を stdout に `{"error":"..."}` 独自 schema で出していた。exit 2 は stderr を期待するため stdout は捨てられ、Claude Code から見ると「exit 2 で block、stderr 空」状態だった
2. notification 分岐で `<<'EOF'` (quoted heredoc) を使っていたため `${CURRENT_BRANCH}` が展開されずリテラル文字列のまま埋め込まれていた

#### 修正
- main block は Claude Code 公式 JSON schema (`hookSpecificOutput.permissionDecision=deny` + `permissionDecisionReason`) + `exit 0` に変更。jq (fallback: python3) で JSON escape
- notification heredoc は `<<EOF` に変更して変数展開を有効化
- 3 シナリオ (main / 非 issue ブランチ / issue ブランチ) で動作検証済み

**Branch**: `119-fix-pre-edit-check-hook-protocol`

---

### 6.47 Daemon integration test infrastructure (April 19, 2026)

#### 背景
Phase 1b (#107) で daemon 側 protocol 実装は完了したが、protocol 経路は cpal の実 audio device に依存していたため、CI 上で end-to-end テストが行えず、PR #113-118 で追加した挙動の回帰を手動検証に頼っていた (Issue #117)。

#### 設計
- **`AudioBackend` trait** を `orbit-audio-daemon/src/backend.rs` に新設
  - `CpalBackend` (本番): `start_default_output()` を薄くラップ
  - `StubBackend` (テスト): Engine のみ構築、audio callback 無し、stats は default
- **binary → lib + bin 分離**: `src/lib.rs` でモジュールを公開し integration test から参照可能に
- **`EngineWrap::start_with<B: AudioBackend>`** 追加。本番の `start()` は backwards-compat のため `StreamGuard` 版を据置
- **`StreamStats::record_xrun` / `record_device_lost` を `#[doc(hidden)] pub` に昇格**: rustdoc には露出させず integration test から xrun / device_lost を直接駆動できるように
- **TCP loopback + TestDaemon harness**: `Drop` で `serve_handle.abort()` し runtime 終了ハングを防ぐ

#### テストケース (tests/protocol.rs, 10 件)
1. handshake_frame_is_sent
2. play_at_then_play_started_and_play_ended (kick.wav 利用)
3. stop_suppresses_play_ended (PR #116 回帰)
4. stop_without_play_id_returns_malformed_request
5. stop_unknown_id_returns_not_found
6. set_global_gain_accepts
7. set_global_gain_rejects_negative
8. stream_stats_ticks_at_1hz
9. daemon_error_warning_on_xrun
10. daemon_error_fatal_on_device_lost

虚時間 (`tokio::test(start_paused = true)` + `tokio::time::advance`) で 1 Hz ticker / PlayEnded 遅延を進める。`advance_and_yield` ヘルパーで複数回 `yield_now().await` を挟み spawn task を駆動する。PlayStarted が reply より先に mpsc に乗る仕様に対応するため `recv_reply_with_events` ヘルパーで event を保持しつつ reply を待つ。

#### 検証
- `cargo test --workspace`: 全テスト green（protocol test 10/10 含む）
- `cargo clippy --workspace --all-targets -- -D warnings`: warning ゼロ
- Flakiness チェック: 5 回連続 pass

**Branch**: `117-daemon-integration-tests`

---

### 6.48 Daemon mutex poison silent-failure logging (April 19, 2026)

#### 背景
PR #121 の pr-review-team (silent-failure-hunter) で指摘された `EngineWrap` の 2 メソッドが mutex poison 時にサイレントで fallback 値を返していた問題 (Issue #122)。post-mortem 時に原因特定できるよう `tracing::warn!` を追加。

#### 修正
- `take_play_ended_suppressed`: poison 時は Stop で止めた play_id でも PlayEnded が漏れる旨を warn log
- `loaded_sample_count`: poison 時は GetStatus で「サンプル未ロード」に見える旨を warn log

#### 非目標
- `active_play_count` は `Engine::active_count()` が contention (None) と poison を区別しない仕様で、contention は正常発生しうるため log なしのまま。API 分離は別 Issue 推奨
- poison 再現 unit test: panic 意図的誘発が必要で過剰、目視 review で log 存在確認

**Branch**: `122-daemon-mutex-poison-logging`

---

### 6.49 Rust engine client — Phase 1 scaffold (April 19, 2026)

#### 背景
Issue #108 (TS 側 audio engine の SuperCollider → Rust daemon 置換) の Phase 1。完了条件 7 項目を 1 PR でやると巨大化するので、最小動作 (DaemonClient + feature flag 土台 + 単体テスト) に絞る。

#### 設計
- `packages/engine/src/audio/rust-engine/` 新設 (Phase 2 で adapter を入れる土台)
- `DaemonClient` class: `child_process.spawn` + `ws` + handshake + request/response 多重化 + event stream
- daemon バイナリ解決: `options.daemonPath` → `ORBIT_AUDIO_DAEMON_PATH` → `rust/target/{release,debug}/orbit-audio-daemon`
- protocol v0.1 type 定義 (`protocol-types.ts`) を Rust `protocol.rs` の mirror として置く
- handshake 検出は `connectWebSocket` より前に resolver を配置する二段構えで open→message の race を回避

#### テスト
- `tests/audio/rust-engine/mock-daemon-server.ts`: `ws.WebSocketServer` で handshake + hardcoded method handlers
- `daemon-client.spec.ts` 8 ケース: handshake / LoadSample / PlayAt / Stop / SetGlobalGain / error response / event emit / quit
- 実 daemon spawn は CI audio device 不在のため integration test (別 PR) に回す

#### 非目標 (Phase 2+)
- `AudioEngine + Scheduler` を満たす `RustEngineAdapter` 実装
- `interpreter-v2.ts:27` の `new SuperColliderPlayer()` hardcode 解消
- `ORBITSCORE_ENGINE=rust` を default にする切替
- BufferManager / EventScheduler の bufnum → sample_id refactor

#### 検証
- `npm test`: 228 passed / 23 skipped (従来 220 + 新規 8 = 228、回帰なし)
- `npm run lint`: auto-fix 後 warning 1 のみ（既存、本 PR 外）
- `npm run build`: TS build + dist copy 成功

**Branch**: `108-ts-rust-engine-client-phase1`

#### Retrospective (April 19, 2026)

**Auditor (5 principles)**:
- DDD / TDD / DRY / ISSUE: PASS
- PROCESS: PARTIAL → README.md / CLAUDE.md の test count 表記を 220 → 230 に更新して解消

**Researcher (Phase 2 に向けた学び)**:
- DaemonClient を AudioEngine/Scheduler と疎結合に保ったことで mock test が容易になった。Phase 2 は adapter 層で bind する
- handshake race 回避のために `handshakeResolver` を `connectWebSocket` より先に配置する pattern は、EventEmitter 属 listener の pre-placement 原則として再利用可能
- mock-daemon-server.ts は protocol 進化に追従させ続ける必要がある。`PROTOCOL_VERSION` による misalignment 検出が保険になる
- `ws.off('message', handler)` + `this.ws = null` の listener cleanup pattern は Phase 2 の長期稼働 scheduler 統合時にも適用する
- `startPromise` single-flight は `quit()` にも同等の検討が必要（並列 quit 対策）

**simplify phase で修正した 3 件 (commit 510d1a6)**:
- `request()` を stringly-typed string から `CommandMethod` union 型に絞り compile 時型安全を強化
- `mock-daemon-server.ts` の未登録 method error code を `MALFORMED_REQUEST` → `UNKNOWN_METHOD` に変更
- ws/stderr listener の close 時 detach で GC 阻害回避

### April 20, 2026 — PR #124 追加 review 対応

#### 背景
PR #124 (Rust daemon client Phase 1) の claude-review で指摘された追加事項への対応。
CI (prettier) が fail していたのも同時に修正。

#### 変更内容
- `protocol-types.ts`: `CommandMethod` union を複数行フォーマットに修正 (prettier CI fail 解消)
- `protocol-types.ts`: `StartupErrorLine` の JSDoc を stderr → stdout に訂正 (実装整合)
- `mock-daemon-server.ts`: `protocol_version` を `'0.1'` リテラルから `PROTOCOL_VERSION` import に変更し、drift 検出を可能に
- `daemon-client.ts`: `doStart` を try/catch で包み、`cleanupAfterStartFailure` で `this.child` / `this.ws` / `handshakeResolver` / `pending` を確実に回収するよう修正 (複数 reviewer Critical 一致項目)
- `errors.ts`: `DaemonConnectionError` を追加。ws close 系の generic Error 2 箇所を置換
- `daemon-client.ts`: `wsUrlOverride` option に `@internal` JSDoc を付与し production 誤用を防止
- `index.ts`: `DaemonConnectionError` を public export

#### 検証
- `npm test`: 230 passed / 23 skipped (回帰なし)
- `npm run lint`: error 0 (既存 warning 1 のみ)

#### 残項目 (別 Issue に分離)
- setTimeout(r, 20) の flaky risk → deterministic な waitFor 化
- request() timeout (daemon ハング時の client 永久 pending)
- ws.close() 完了待機 (Phase 2 adapter 実装時)
- getStatus() テスト未カバー

**Branch**: `108-ts-rust-engine-client-phase1`

### April 21, 2026 — Issue #133 scsynth standalone 検証 (Epic #131 Phase 1)

#### 背景
Epic #131 (v1.0 ICMC Ready) Phase 1 の前提調査。SC.app を別 install せず
scsynth バイナリ単体を `.vsix` に同梱する戦略 (Sonic Pi パターン) の実現性を
primary-source で確認するタスク。

#### 変更内容
- `docs/research/SCSYNTH_STANDALONE.md` 新規作成 (170 行、日本語)
  - scsynth 3.14.1 (Homebrew cask) を `/tmp` に抽出して OSC 通信・SynthDef load・
    WAV 再生まで動作確認した結果を記録
  - 最小 bundle 構成: scsynth 1.5 MB + non-supernova plugins 5.1 MB +
    libsndfile.dylib 4.9 MB + libfftw3f.dylib 1.6 MB = ~13 MB
  - 必須起動フラグ: `-u <port> -i 0` (input disable で sample rate mismatch crash 回避)
  - GPL-3.0 aggregation 観点の合規性 (Sonic Pi 先例) を明文化
  - Fallback 策と実装時の注意点を整理
- `docs/research/scripts/scsynth-standalone-boot.js` 追加 (reproduction 用)
- `docs/research/scripts/scsynth-standalone-playback.js` 追加 (同)

#### 検証
- scsynth standalone 起動 / OSC `/status` reply / `/d_recv` SynthDef load /
  `/b_allocRead` WAV load / `/s_new` synth 起動 + `/n_end` 自動終了まで PASS
- 3 回の iteration で silent-failure-hunter 指摘を解消:
  - decodeAddr bounds check, socket handler try/catch,
  - `/d_recv` vs `/b_allocRead` の `/done` 判定を明示 flag 化
- 5 commit (b379bd5 → 847db3e) で docs + scripts + robust 化を反復

#### 後続
- #134: minimum plugin set 決定 (全量同梱 vs non-supernova 限定)
- #135: codesign / notarize pipeline 設計
- #136: `packages/vscode-extension` への bundle 配置と path resolution 切替
- #139: LICENSE.GPL-3.0 と NOTICE 配置

#### Retrospective (April 21, 2026)

**Auditor (5 principles)**:
- DDD / TDD / DRY / ISSUE: PASS
- PROCESS: 本エントリ追加により PASS

**Researcher 推奨**:
- CLAUDE.md Quick Reference に scsynth 操作フラグ (`-i 0`) / 非致命 boot
  warning を追記する (後続 issue で検討)
- #136 実装時は scripts/\*.js を CI 検証ゲートとして活用

**Branch**: `133-scsynth-standalone-verify`

### April 23, 2026 — Issue #134 + #135 scsynth bundle research (Epic #131 Phase 1)

#### 背景
Epic #131 (v1.0 ICMC Ready) Phase 1 の前提調査 2 件を 1 PR で完了。
- #134: `.vsix` に同梱する scsynth plugin / dylib の最適セット決定
- #135: 同梱 scsynth binary の codesign / notarize pipeline 設計

下流 #136 (bundle 実装)、#137 (CI publish)、#138 (cold-install smoke test)、
#139 (LICENSE/NOTICE) の意思決定資料として整備。

#### 変更内容
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` 新規作成 (~310 行、日本語)
  - non-supernova plugin 26 ファイル全同梱 (5.1 MB) + libsndfile.dylib (4.9 MB) +
    scsynth 本体 (1.5 MB) = bundle 合計 **~11.5 MB** に確定
  - libfftw3f.dylib は全 26 plugin で未使用 (otool 実測) → 同梱対象から除外
  - 抽出 script (Homebrew cask default / SC.app fallback、fail-fast 検証付き)
  - Cold-install verification checklist (11 項目) + 失敗時診断フロー + timeout 目安
  - SC version update policy (Major/Minor で re-extract、Patch 据え置き)
- `docs/research/CODESIGN_PIPELINE.md` 新規作成 (~350 行、日本語)
  - SC 3.14.1 scsynth の `codesign -dv` 実測結果を引用 (team HE5VJFE9E4 署名済)
  - **決定: 再署名 / 再 notarize 不要** — SC 公式 signature を流用
  - `spctl --type exec` rejected は policy mismatch、実運用の Gatekeeper 判定は
    VS Code 親プロセス経由 spawn で問題なし (#138 で実測予定)
  - GitHub Actions workflow 骨子 (macos-14、VSCE_PAT のみ必須、Apple secret 不要)
  - CI assertion 成功基準テーブル (#138 向け)
  - Fallback plan (SC 側 signature 失効時の自前署名手順)

#### 重要な発見
- **Apple Developer ID 取得不要**: SC 公式が既に Apple Dev ID 署名 + hardened
  runtime + notarize 済、全 binary (scsynth / libsndfile / plugin .scx) が
  team HE5VJFE9E4 で統一
- **bundle サイズ 11.5 MB**: 当初想定 (~30 MB) より 3 倍コンパクト
- **libfftw3f 不要**: FFT_UGens は Accelerate.framework 経由

#### 検証
- scsynth / libsndfile / plugin の codesign -dv で signature 全実測
- 26 non-supernova plugin の libfftw3f 依存を otool で全検証
- `spctl --assess` / `xcrun stapler validate` で Gatekeeper / notarize 挙動確認
- 3 回の iteration で pipeline-review findings を解消:
  - /simplify (3 agents) で cross-ref / fallback trim / Last-verified header
  - /code:pr-review-team iter 1: extraction fail-fast / post-package verify /
    Gatekeeper context / cold-install checklist / CI assertion criteria
  - /code:pr-review-team iter 2: timeout budgets + 診断フロー追加
  - iter 3: c=i=0 収束達成

#### Retrospective (April 23, 2026)

**Auditor (5 principles)**:
- DDD / TDD / ISSUE: PASS
- DRY: PARTIAL → 本 WORK_LOG entry で整合 + MANIFEST↔CODESIGN cross-ref 対称化は後続 PR で
- PROCESS: 本 entry 追加により PASS

**Researcher 推奨 (次スプリント)**:
- #136 (extract script) が critical path、2-3h 見込で優先着手
- #140 (VitePress scaffold) を並行開始 (docs 10+ ファイルの navigation 整備)
- #137 (CI workflow) を #136 実装と並行で draft (`act` でローカル検証可)

**Branch**: `134-135-scsynth-bundle-research`

---

## Archived Work

Older work logs have been moved to the archive:
- [WORK_LOG_2025-09.md](./archive/WORK_LOG_2025-09.md) - September 2025 work
