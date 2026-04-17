# Audio Engine Core Architecture

**ステータス**: 設計方針確定（実装は段階的）
**最終更新**: 2026-04-17
**関連 Issue**: Epic [#105](https://github.com/signalcompose/orbitscore/issues/105)

---

## 1. 背景と動機

PR #99 / #103 で Rust audio engine の PoC を構築した結果、全機能が単一 crate に入った形になった。今後の拡張（プラグインホスト、Web 版、他プロダクトへの転用）を見据え、**責務を層で分離**する必要がある。

加えて、Signal compose の戦略として **音声スタックを OrbitScore 専用ではなく「汎用 Rust audio engine」として育て、他プロダクト・OSS 貢献・商用プロダクトの基盤とする**ことを目指す。

---

## 2. 目標アーキテクチャ（最終形）

```
┌──────────────────────────────────────────────┐
│ App Layer (OrbitScore)                         │
│  ├─ VS Code Extension                          │
│  ├─ DSL parser / interpreter                   │
│  ├─ Musical timing (BPM / 拍子 / polymeter)    │
│  ├─ Project management                         │
│  └─ LLM agent / UI                             │
└──────────────┬───────────────────────────────┘
               │ IPC (WebSocket + JSON-RPC)
┌──────────────▼───────────────────────────────┐
│ Plugins (Rust, 差し替え可能)                   │
│  ├─ VST3 / CLAP host                           │
│  ├─ MIDI I/O                                   │
│  ├─ Time-stretch wrapper (rubberband/SoundTouch)│
│  └─ Third-party Node impls                     │
├──────────────────────────────────────────────┤
│ Audio Engine Core (Rust, 汎用)                 │
│  ├─ Audio I/O (cpal / AudioWorklet)            │
│  ├─ Audio graph (Node trait + bus routing)    │
│  ├─ Sample-accurate scheduler                  │
│  ├─ Sample management (load, mix, SRC)         │
│  ├─ Parameter system (automation, timed set)   │
│  ├─ Realtime-safe primitives (lock-free)       │
│  └─ Built-in Node types (SamplePlayer, Bus等)  │
└──────────────────────────────────────────────┘
```

**橋渡しは "層" ではなく "プロトコル"**: IPC は Core のコマンド型を JSON-RPC on WebSocket で配線する薄い通信路。

---

## 3. 責務の分離原則

### Core は以下を「知らない」

- DSL の構文 / 意味論
- Musical time (BPM / 拍子 / ポリリズム)
- ファイル形式（`.osc` 等）
- ネットワーク / IPC（デーモン化の詳細）
- UI / エディタ

### Core が扱うのは以下のみ

- **秒（または sample 単位）** の時刻軸
- 入出力バッファとオーディオグラフ
- Node trait によるノード抽象
- `LoadSample` / `PlayAt` / `ConnectNode` 等の **命令**

### Plugins は Core の Node trait を実装

- VST3 host / CLAP host も「Node の一種」
- MIDI I/O も Node として graph に繋がる
- サードパーティ拡張も同じ trait を通る

### App（TypeScript）の責務

- DSL parse
- Musical timing → 秒変換
- Note 列 → MIDI Event 列への展開
- UI（VS Code 拡張、将来は Tauri）
- プロジェクトファイル管理

---

## 4. DSL → MIDI 変換の方針

### ソフトシンセ / VST エフェクト利用時の流れ

```
TS engine:
  DSL パース
  ↓ musical timing 適用（BPM → 秒）
  ↓ Note sequence → 時刻付き MIDI Event 列
  ↓ IPC メッセージ生成
       ├─ LoadPlugin { path }
       ├─ PluginMidiEvent { plugin_id, time_sec, event }
       └─ PluginParam { plugin_id, param_id, value }

Rust plugin host:
  MIDI Event を sample-accurate に plugin へ
  Plugin が audio を生成
  Audio graph の bus に合流
  → 出力
```

### 重要な契約

- **Plugin host は MIDI Event を受け取る**（DSL を知らない）
- **TS interpreter が DSL → MIDI 変換を担う**
- **業界標準の MIDI を IPC メッセージにする**ことで、Plugin 層の universality を確保

---

## 5. Musical timing はどこに置くか

### 結論: **Phase 1〜2 は TypeScript 側に残す**

既存の `packages/engine/` には BPM / 拍子 / polymeter / polytempo / seamless parameter update 等の musical timing ロジックが実装済み。既存テストも通過。**これを活かす**のが合理的。

### Rust に移す判断タイミング

- Web / WASM 版の開発着手時（TS が動かない環境）
- または複数のフロント（standalone / web / plugin 版）が同じ timing を使う必要が出た時

この時点で初めて `orbit-music-timing` crate を切り出す。それまでは TS 側に留める。

### 今の layering

```
Phase 1〜2:
  [TS: DSL + interpreter + musical timing]
         ↓ IPC (秒ベース)
  [Rust: audio-core + plugins]

Phase 3 以降（Web 版着手時に検討）:
  [TS or WASM: DSL + interpreter]
         ↓
  [Rust: orbit-music-timing] ← ここで独立 crate 化
         ↓
  [Rust: audio-core + plugins]
```

---

## 6. フェーズ別移行計画

### Phase 1a: Cargo workspace 再構成
- 現 `rust/` 単一 crate → 複数 crate に分割
- `orbit-audio-core` / `orbit-audio-native` / `orbit-audio-wasm`
- Issue [#106](https://github.com/signalcompose/orbitscore/issues/106)

### Phase 1b: IPC ブリッジ
- IPC プロトコル設計（Issue [#93](https://github.com/signalcompose/orbitscore/issues/93)）
- `orbit-audio-daemon` binary（Issue [#107](https://github.com/signalcompose/orbitscore/issues/107)）
- TS 側の rust-engine client（Issue [#108](https://github.com/signalcompose/orbitscore/issues/108)）
- SuperCollider 経路を段階的に置き換え

### Phase 2: プラグイン段階投入
- Time-stretch（Issue [#92](https://github.com/signalcompose/orbitscore/issues/92)）
- VST3 / CLAP plugin host（Issue [#95](https://github.com/signalcompose/orbitscore/issues/95)）
- MIDI I/O plugin

### Phase 3: スタンドアローン / Web 拡張
- Tauri standalone（Issue [#94](https://github.com/signalcompose/orbitscore/issues/94)）
- LLM agent 統合（Issue [#96](https://github.com/signalcompose/orbitscore/issues/96)）
- Web 版（WAM 対応、ここで musical timing の Rust 化検討）

---

## 7. Cargo workspace 構造（提案）

```
rust/
├── Cargo.toml (workspace root)
└── crates/
    ├── orbit-audio-core/       # platform-agnostic, publishable
    ├── orbit-audio-native/     # cpal backend + symphonia + SRC
    ├── orbit-audio-wasm/       # wasm-bindgen + AudioWorklet
    ├── orbit-audio-daemon/     # binary with WebSocket server
    ├── orbit-audio-midi/       # MIDI I/O plugin (Phase 2)
    ├── orbit-audio-vst3/       # VST3 host plugin (Phase 2)
    ├── orbit-audio-clap/       # CLAP host plugin (Phase 2)
    └── orbit-audio-timestretch/# rubberband/soundtouch wrapper (Phase 2)
```

### 公開戦略

- `orbit-audio-core`: **MIT / Apache 2.0** で OSS 公開候補（Rust audio コミュニティ貢献）
- Plugins: 各 crate のライセンスに従う（LGPL の SoundTouch 等は別 crate で隔離）
- `orbit-audio-daemon` / `orbitscore-app`: **Signal compose Source-Available License**（商用戦略）

---

## 8. Plugin Host の MIDI Event 契約

```rust
pub enum MidiEvent {
    NoteOn { channel: u8, pitch: u8, velocity: u8 },
    NoteOff { channel: u8, pitch: u8, velocity: u8 },
    CC { channel: u8, controller: u8, value: u8 },
    PitchBend { channel: u8, value: i16 },
    ProgramChange { channel: u8, program: u8 },
    Aftertouch { channel: u8, value: u8 },
    // 必要に応じ拡張
}

pub trait MidiSink: Node {
    fn handle_midi(&mut self, time_sec: f64, event: MidiEvent);
}
```

この trait を VST3 host / CLAP host / MIDI I/O plugin / 将来のカスタム DSP が**統一的に実装**する。IPC 越しの command はこの形をそのままシリアライズしたもの。

---

## 9. 非目標（本設計で扱わない）

- **DSL 仕様変更**: 実装を真とする。本ドキュメントでは DSL 具体論を書かない
- **musical timing の Rust 化**: Phase 1〜2 では TS 側に留める
- **TS engine の既存テスト 220+ を壊すこと**: 既存動作を保ちながら置き換える
- **特定のシンセや DAW との密結合**: Plugin 層は汎用 MIDI Event を契約とする
- **リアルタイム MIDI 入力の完全サポート**: まずは内部生成 MIDI から着手（外部入力は MIDI I/O plugin で追加）

---

## 10. Open Questions（Phase 進行中に解決）

- cpal の audio callback と WebSocket 受信スレッド間の lock-free 通信方式（`ringbuf` or `rtrb`）
- Plugin の process() 呼び出し周期と、MIDI event のサンプル精度 alignment 手法
- Time-stretch の商用ライセンス判断（Rubberband vs SoundTouch vs 独自）
- daemon プロセスのライフサイクル管理（VS Code extension から子プロセス管理）
- `orbit-audio-core` を crates.io に公開するタイミング / 命名の最終決定

---

## 11. 参考

- [docs/planning/RUST_ENGINE_MIGRATION_PLAN.md](./RUST_ENGINE_MIGRATION_PLAN.md) - 全体ロードマップ
- [docs/research/RUST_POC_FINDINGS.md](../research/RUST_POC_FINDINGS.md) - PoC 所感
- [docs/research/ENGINE_DAEMON_PROTOCOL.md](../research/ENGINE_DAEMON_PROTOCOL.md) - IPC プロトコル仕様 (v0.1 draft)
- [Epic #105](https://github.com/signalcompose/orbitscore/issues/105)
- Node trait の設計参考: JUCE AudioProcessor, Web Audio API AudioNode
