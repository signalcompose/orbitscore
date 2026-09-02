# orbit-audio (Rust workspace)

Signal compose の汎用 Rust audio engine ワークスペース。OrbitScore のサウンドエンジン
として利用するほか、将来的には他の音声プロダクト / OSS 公開の基盤となる。

## Status

**OrbitScore の既定バックエンド**（cutover #108・2026-07-03、WORK_LOG 6.179）。
`packages/engine/src/audio/create-audio-engine.ts` が `ORBITSCORE_ENGINE` 未設定時に
`orbit-audio-daemon` を選び、SuperCollider 経路は `ORBITSCORE_ENGINE=sc` の opt-out。
`.vsix` には `scripts/copy-daemon-bin.sh` で daemon バイナリと child バイナリが同梱される
（macOS Apple Silicon のみ）。

到達済みの主な機能（2026-08-30 時点・詳細は `docs/development/WORK_LOG.md`）:

- WebSocket IPC daemon（protocol v0.2）・supervision と auto-respawn（#300）
- named-channel routing / sum・aux バスプール / master gain（#322, #453, #459, #643）
- Ableton LinkAudio egress（GPL 隔離 crate、#324〜#333）
- out-of-process plugin children（CLAP / VST3 effect・instrument、shm transport、#348〜#424）
- per-sequence insert bus（#434）・差し替え／削除（#618, #625）・ラック直列チェーン（#628）
- プラグイン UI ホスティング（AppKit runloop、evt ring、per-window pump、#474, #633）
- プラグインカタログ scanner（#463）・同梱標準プラグイン `Gain`（SC.10.8）
- realtime WAV capture seam（`ORBIT_CAPTURE_WAV`、ヘッダ定期 patch #651）・offline 検証 harness

## Layout

```
rust/
├── Cargo.toml                  # workspace root（members は下表）
├── rust-toolchain.toml         # stable + rustfmt + clippy
├── deny.toml                   # cargo-deny（GPL 隔離の gate）
└── crates/
```

### Crate 責務

| Crate | 役割 |
|---|---|
| `orbit-audio-core` | 秒ベースの `Engine` / `Scheduler` / `Sample`。OS / ファイル I/O 非依存 |
| `orbit-audio-native` | `cpal` 出力・`symphonia` デコーダ・`rubato` SRC・insert bus / mixer stage・capture seam |
| `orbit-audio-daemon` | WebSocket IPC server（protocol v0.2）。session / engine_wrap / outproc child 管理 / LinkAudio |
| `orbit-audio-sandbox` | out-of-process 子プロセス transport（file-backed mmap SPSC、evt ring、parent watch） |
| `orbit-audio-verify` | offline capture + PCM アサーション harness（pan / region / gain / onset / fade） |
| `orbit-audio-wasm` | AudioWorklet バインディング用スタブ（未着手） |
| `orbit-clap-host` | in-process CLAP hosting library（#340） |
| `orbit-vst3-host` | in-process VST3 hosting library（#381 Phase 1 production、offline process mode #598） |
| `orbit-clap-effect-child` / `orbit-vst3-effect-child` | OOP effect child（1 プラグイン） |
| `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` | OOP instrument child（note event transport） |
| `orbit-effect-rack-child` | 1 つの child が N ステージ（CLAP / macOS VST3）を直列に回すラック child（#628） |
| `orbit-child-runtime` | child 共通のメインスレッド AppKit runloop + 専用 audio thread（UI ホスティング #474） |
| `orbit-child-ui` | AppKit 非依存のプラグイン UI ライフサイクル状態機械（`Closed` = ドレーン条件） |
| `orbit-plugin-scan` | CLAP / VST3 を走査し `~/.orbitscore/plugin-catalog.json` を書くカタログ scanner（#463） |
| `orbit-std-gain` | 同梱標準 CLAP プラグイン `Gain`（dB 契約は `tests/e2e/rack-chain-gain-expectations.ts` と CI で固定） |
| `orbit-link-audio` | Ableton LinkAudio egress shim（GPL 隔離・feature gate、permissive core は依存しない） |
| `orbit-vst3-gain-oracle` / `orbit-vst3-synth-oracle` | テスト用 oracle プラグイン（gain / 単音 sine synth） |
| `orbit-clap-spike` / `orbit-sandbox-spike` | 設計判断時の spike（verdict は WORK_LOG 6.144〜6.175） |

`orbit-audio-core` はプラットフォーム非依存で、他のバックエンドから共通利用できる。

## Quick start

```bash
cd rust

# 全クレートのチェック / テスト（CI: .github/workflows/rust-ci.yml は ubuntu）
cargo check --workspace --all-targets
cargo test --workspace --lib
cargo clippy --workspace --all-targets -- -D warnings
cargo deny check

# OrbitScore が使う構成で daemon をビルド（実機 gated E2E の pretest と同じ）
cargo build --release -p orbit-audio-daemon --features outproc-effect,outproc-instrument

# 同梱標準プラグインが実機で鳴ることの確認（macOS のみ・CLAUDE.md「マージ前ゲート」）
bash crates/orbit-std-gain/bundle-macos.sh
cargo test -p orbit-effect-rack-child --lib -- --ignored
```

`#[cfg(target_os = "macos")]` のテスト（plugin child / UI / 実機オーディオ）は ubuntu CI では
存在しないため、手元の macOS で回すのが唯一の実行経路（CLAUDE.md 参照）。

## Design principles

- **Core は platform / DSL / musical time を知らない**（秒ベース命令のみ）
- **Plugin host は generic MIDI Event を受ける**（DSL 不知）
- **Realtime-safe**: オーディオコールバック内で allocation / lock を避ける
- **3rd-party プラグインは out-of-process**: クラッシュ隔離と respawn を daemon が担う（in-process host は spike / oracle 用途）
- **GPL は crate 境界で隔離**: `orbit-link-audio` のみが GPL 依存を持ち、`cargo-deny` で gate する
- **公開可能な境界**: `orbit-audio-core` は将来 crates.io 公開候補

## License

Signal compose Source-Available License v1.0 — ルートの [LICENSE](../LICENSE) を参照。
`orbit-link-audio` は GPL 依存を含むため feature gate で隔離されている。

## Related docs

- [docs/development/POST_2.0_MASTER_PLAN.html](../docs/development/POST_2.0_MASTER_PLAN.html) — post-2.0 エンジン計画の正本
- [docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md](../docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md) — RT 統合設計
- [docs/development/POST_2.0_GAMMA_M1_DESIGN.md](../docs/development/POST_2.0_GAMMA_M1_DESIGN.md) / [M2](../docs/development/POST_2.0_GAMMA_M2_DESIGN.md) — out-of-process children / event wire
- [docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md](../docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md) — UI ホスティング仕様
- [docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md](../docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) — ラック / シグナルチェーン仕様（SC.10）
- [docs/research/ENGINE_DAEMON_PROTOCOL.md](../docs/research/ENGINE_DAEMON_PROTOCOL.md) — IPC protocol 草案
- [docs/planning/post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md](../docs/planning/post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md) — 3 層分離アーキテクチャ方針
- dev 学習サイト [Part III: Rust Engine](https://signalcompose.github.io/orbitscore/dev/rust-engine/) — 実装の読解ノート
