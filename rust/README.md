# orbit-audio (Rust workspace)

Signal compose の汎用 Rust audio engine ワークスペース。OrbitScore のサウンドエンジン
として利用するほか、将来的には他の音声プロダクト / OSS 公開の基盤となる。

## Status

**Phase 1a 完了** — Cargo workspace 分離済み。Phase 1b（IPC daemon）は Issue [#107](https://github.com/signalcompose/orbitscore/issues/107) で進行予定。

## Layout

```
rust/
├── Cargo.toml                  # workspace root
├── rust-toolchain.toml         # stable + rustfmt + clippy
└── crates/
    ├── orbit-audio-core/       # platform-agnostic DSP / scheduler
    ├── orbit-audio-native/     # cpal + symphonia + rubato (desktop)
    │   └── examples/poc_play.rs
    ├── orbit-audio-wasm/       # wasm-bindgen + AudioWorklet (スタブ)
    └── orbit-audio-daemon/     # binary: WebSocket IPC server (protocol v0.1)
        └── tests/smoke.rs      # startup smoke test
```

### Crate 責務

| Crate | 役割 |
|---|---|
| `orbit-audio-core` | 秒ベースの `Engine` / `Scheduler` / `Sample`。OS / ファイル I/O 非依存 |
| `orbit-audio-native` | `cpal` 経由の出力、`symphonia` デコーダ、`rubato` による SRC |
| `orbit-audio-wasm` | 将来 (Phase 3) の AudioWorklet バインディング用スタブ |
| `orbit-audio-daemon` | WebSocket IPC server。TS client と接続して Phase 1 commands を実行 |

`orbit-audio-core` はプラットフォーム非依存で、他のバックエンドから共通利用できる。

## Quick start

```bash
cd rust

# 全クレートのチェック / テスト
cargo check --workspace --all-targets
cargo test --workspace --lib
cargo clippy --workspace --all-targets -- -D warnings

# デスクトップ PoC 再生
cargo run --example poc_play -- ../test-assets/audio/kick.wav ../test-assets/audio/snare.wav

# WASM スタブビルド
cargo build -p orbit-audio-wasm --target wasm32-unknown-unknown

# Daemon 起動（Phase 1b-1 時点では Ping / LoadSample / PlayAt / Stop / GetStatus / SetGlobalGain 実装済み）
cargo run --bin orbit-audio-daemon
```

## Known Limitations (Phase 1)

- **タイムストレッチなし** — Phase 2 で検討（Issue [#92](https://github.com/signalcompose/orbitscore/issues/92)）
- **モノラル → マルチチャンネル展開は最終チャンネル複製のみ** — pan law や空間音響は Phase 2 以降
- **`Mutex` ベースの同期** — 本実装でロックフリー化を検討
- **WASM 未検証** — スタブのみ。実機 wasm ビルドは Phase 3

## Design principles

- **Core は platform / DSL / musical time を知らない**（秒ベース命令のみ）
- **Plugin host は generic MIDI Event を受ける**（DSL 不知）
- **Realtime-safe**: オーディオコールバック内で allocation / lock を避ける
- **公開可能な境界**: `orbit-audio-core` は将来 crates.io 公開候補

## License

Signal compose Source-Available License v1.0 — ルートの [LICENSE](../LICENSE) を参照。

## Related docs

- [docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md](../docs/planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md) — 3 層分離アーキテクチャ方針
- [docs/planning/RUST_ENGINE_MIGRATION_PLAN.md](../docs/planning/RUST_ENGINE_MIGRATION_PLAN.md) — 全体ロードマップ
- [docs/research/RUST_POC_FINDINGS.md](../docs/research/RUST_POC_FINDINGS.md) — PoC 所感
