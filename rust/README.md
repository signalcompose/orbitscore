# orbitscore-engine (Rust)

Rust 実装の OrbitScore オーディオエンジン。

## Status

**Phase 1 / PoC** — Issue #91 に紐づく技術検証。API・構造は未確定。

## Layout

```
rust/
├── Cargo.toml
├── src/
│   ├── lib.rs         # モジュールルート
│   ├── core/          # プラットフォーム非依存の DSP / スケジューラ
│   ├── native/        # cpal 経由のネイティブ音声 I/O (feature = "native")
│   └── wasm/          # wasm-bindgen + AudioWorklet グルー (feature = "wasm")
└── examples/
    └── poc_play.rs    # WAV ロード + スケジュール再生の最小サンプル
```

### Feature flags

| feature | 依存 | 用途 |
|---|---|---|
| `native` (default) | `cpal`, `symphonia` | デスクトップ音声出力 |
| `wasm` | `wasm-bindgen`, `web-sys` | ブラウザ向け AudioWorklet（予約） |

## Quick start

```bash
# デスクトップ PoC
cd rust
cargo run --example poc_play

# WASM 向けビルド（今はスタブのみ）
cargo build --no-default-features --features wasm --target wasm32-unknown-unknown
```

## Design principles

- **Platform-agnostic core**: `core` モジュールは `std` に留め、`cpal` 等を直接使わない
- **Thin adapters**: `native` / `wasm` は core を呼ぶ薄いアダプタに留める
- **Realtime-safe**: オーディオコールバック内で allocation / lock を避ける
- **Separable**: 将来 `signalcompose/orbitscore-engine` として独立リポジトリ化する可能性を踏まえ、外部依存を最小化

## License

Signal compose Source-Available License v1.0 — ルートの [LICENSE](../LICENSE) を参照。

## Related docs

- [docs/planning/RUST_ENGINE_MIGRATION_PLAN.md](../docs/planning/RUST_ENGINE_MIGRATION_PLAN.md) — 全体ロードマップ
- Issue #91: spike: Rust audio engine proof of concept
- Issue #92: research: time-stretch DSP library selection
- Issue #93: design: engine daemon IPC protocol
