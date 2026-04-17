# Plan: Rust Audio Workspace Split (Phase 1a)

**対象 Issue**: [#106](https://github.com/signalcompose/orbitscore/issues/106)
**Epic**: [#105](https://github.com/signalcompose/orbitscore/issues/105)
**前提**: PR #99, #103 がマージされた状態の main
**想定 effort**: medium
**想定 dev-cycle**: 1 cycle で完結

---

## 1. 目的

単一 crate `orbitscore-engine` に入っている Rust コードを **Cargo workspace** に再構成し、`orbit-audio-core` を platform-agnostic な独立 crate として切り出す。将来のプラグイン分離・他プロダクト転用・OSS 公開の**土台**を作る。

**本プランは純粋な構造リファクタであり、新機能の追加は一切行わない。**

---

## 2. 参照すべきドキュメント

作業前に必ず目を通す:

- [docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md) — 全体設計方針と責務分離原則
- [docs/planning/RUST_ENGINE_MIGRATION_PLAN.md](../planning/RUST_ENGINE_MIGRATION_PLAN.md) — 段階的ロードマップ
- `rust/` の現状コード（17 tests + PoC example が動く状態）

---

## 3. スコープ

### 含む

- `rust/` を Cargo workspace に再構成
- 3 crates に分割:
  - `rust/crates/orbit-audio-core/` — 現 `src/core/` 相当（platform-agnostic）
  - `rust/crates/orbit-audio-native/` — 現 `src/native/` 相当（cpal + symphonia + rubato）
  - `rust/crates/orbit-audio-wasm/` — 現 `src/wasm/` 相当（スタブ）
- `rust/Cargo.toml` を workspace root に（`[workspace]` セクション）
- 各 crate の `Cargo.toml` を適切な dependencies 記述で構成
- 既存の features (`native` / `wasm`) のポリシーは workspace 全体で整合性を保つ形に移行
- `rust/examples/poc_play.rs` を `orbit-audio-native` の examples へ移設
- `rust/target/` gitignore / `rust/Cargo.lock` は workspace 共通で 1 箇所
- `rust-toolchain.toml` は workspace root に維持

### 含まない（Phase 1b 以降）

- 新機能の追加
- daemon binary crate の新設
- IPC / WebSocket の実装
- TS 側の変更
- DSL / interpreter / musical timing の改修
- プラグイン host 実装
- crates.io への公開

---

## 4. 完了条件

- [ ] `rust/crates/orbit-audio-core/` が作成され、core モジュール相当が移設されている
- [ ] `rust/crates/orbit-audio-native/` が作成され、native モジュールと poc_play example が移設されている
- [ ] `rust/crates/orbit-audio-wasm/` が作成され、wasm スタブが移設されている
- [ ] `rust/Cargo.toml` が workspace root として機能（`[workspace]` members 定義）
- [ ] `cargo check --workspace --all-targets` が全て成功
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` が成功
- [ ] `cargo fmt --check` が成功
- [ ] `cargo test --workspace --lib` で既存 17 tests が全部通る
- [ ] `cd rust && cargo run --example poc_play -- ../test-assets/audio/kick.wav ../test-assets/audio/snare.wav` が動作（実機再生）
- [ ] `cargo build --release` 成功

---

## 5. 実装手順（推奨シーケンス）

1. ブランチ `106-rust-workspace-split` を作成
2. `rust/Cargo.toml` を workspace root に変換（メンバー定義のみ）
3. `rust/crates/orbit-audio-core/` を作成し `src/core/` を移設
4. `rust/crates/orbit-audio-native/` を作成し `src/native/` を移設（`orbit-audio-core` に依存）
5. `rust/crates/orbit-audio-wasm/` を作成し `src/wasm/` を移設（`orbit-audio-core` に依存）
6. `examples/poc_play.rs` を `crates/orbit-audio-native/examples/` に移動
7. 旧 `rust/src/`, `rust/Cargo.toml` の残骸を整理
8. `cargo check` / `clippy` / `fmt` / `test` / `run --example` をすべて確認
9. PoC を実機再生で動作確認

### crate 命名ポリシー

- パッケージ名は **`orbit-audio-*`** 形式（ハイフン区切り）
- Rust 内モジュール名は **`orbit_audio_*`**（snake_case 自動変換）
- version は初期 `0.0.1` に揃える
- license は `LicenseRef-Signal-compose-FairTrade-1.0`
- description は Signal compose 由来の汎用 audio crate である旨を明記

### feature flag 方針

- `orbit-audio-core`: 基本は `no_std` 志向だが、まずは `std` ありで spawn。feature なし
- `orbit-audio-native`: cpal / symphonia / rubato / audioadapter-buffers を直接 require（optional ではなく必須依存）
- `orbit-audio-wasm`: wasm-bindgen / web-sys を直接 require
- **旧 `native` / `wasm` feature flag は crate 分割によって不要になるため削除**
- 旧 `lib.rs` の `compile_error!` は不要になる（crate 単位で選ぶようになるため）

---

## 6. DDD / ドキュメント更新項目

実装 PR に含めるべき更新:

- [ ] `rust/README.md` を **ワークスペース全体の overview** に刷新
  - 各 crate の役割と依存関係
  - 主要コマンド（`cargo test --workspace` 等）
  - 既存の Known Limitations は維持
- [ ] `docs/development/WORK_LOG.md` に 6.56 エントリ追加（作業内容）
- [ ] `docs/planning/RUST_ENGINE_MIGRATION_PLAN.md` Phase 1 section の進捗更新（Phase 1a 完了にチェック）
- [ ] `docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md` の「Cargo workspace 構造」セクションを実装実態に合わせて調整
- [ ] `CLAUDE.md` の Development Commands 欄に `cargo` 系コマンド（workspace）を追加（任意、対象的なら）

**DSL 仕様については本プランでは言及しない**。実装を唯一の真実とする方針。

---

## 7. 検証項目（PR 作成前チェックリスト）

- [ ] `cargo check --workspace --all-targets` clean
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean
- [ ] `cargo fmt --check` clean
- [ ] `cargo test --workspace --lib`: 17 passed（PoC / #100 SRC の tests 合計）
- [ ] `cargo build --release` 成功
- [ ] `cd rust && cargo run --example poc_play -- ../test-assets/audio/kick.wav ../test-assets/audio/snare.wav` で音が出る
- [ ] `git diff main..HEAD` を確認し、移設以外の意図しない変更がないこと
- [ ] `cargo tree --workspace` で依存が正しく解決されているか確認

---

## 8. リスクと注意点

- **Cargo.lock の差し替え**: workspace 化で lock の構造が変わる。再生成すると依存バージョンがズレる可能性があるので、既存の pin を極力維持する
- **feature flag の消滅**: 旧 `native` / `wasm` features 前提のビルドスクリプトやドキュメントが残っていないか要確認
- **path dependency**: crate 間依存は **`{ path = "../orbit-audio-core" }`** を使う（未公開段階なので version 指定不可）
- **example の path**: `test-assets/audio/*.wav` への相対パスが `crates/orbit-audio-native/examples/` からだと変わる。poc_play.rs 内の相対パス or README のコマンド例を調整

---

## 9. 非目標（重要な再確認）

- DSL 仕様への言及は一切行わない（間違いの元になる）
- musical timing は触らない（TS 側に残す）
- 新規 Rust コードを書かない（リファクタのみ）
- daemon / IPC 実装は **Phase 1b (#107) で別途**

---

## 10. 次のステップ（本 PR 完了後）

1. PR マージ後に Epic #105 のチェックリストを更新
2. Issue #106 クローズ
3. Phase 1b に進む場合: Issue #93 → #107 → #108 の順で着手

---

## 11. 参考

- [Epic #105](https://github.com/signalcompose/orbitscore/issues/105)
- [Issue #106](https://github.com/signalcompose/orbitscore/issues/106) ← 本プランが対応する Issue
- [docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md)
- [Cargo workspace 公式ドキュメント](https://doc.rust-lang.org/cargo/reference/workspaces.html)
