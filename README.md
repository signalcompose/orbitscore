# OrbitScore

**Audio-based live coding DSL for modern music production**

オーディオファイルの操作を中心とした新しい音楽制作用DSL。タイムストレッチ、ピッチシフト、リアルタイムトランスポート制御を統合。

> ⚠️ **Migration Notice**: The project is migrating from MIDI-based to audio-based DSL. See [INSTRUCTION_ORBITSCORE_DSL.md](docs/INSTRUCTION_ORBITSCORE_DSL.md) for the new specification.

## 核心的特徴 (New Audio-Based DSL)

### 🎵 Audio Processing

- **Audio File Support**: WAV, AIFF, MP3, MP4 playback
- **Time-Stretching**: Tempo adjustment with pitch preservation
- **Audio Slicing**: `.chop(n)` to divide files into equal parts
- **Pitch Shifting**: `.fixpitch(n)` for independent pitch control

### ⚡ Live Coding Features

- **Editor Integration**: Execute commands with Cmd+Enter
- **Transport Commands**: `global.run()`, `loop()`, `mute()`, etc.
- **Real-time Control**: Bar-quantized transport with look-ahead
- **Polymeter Support**: Independent sequence timing

### 🔧 Technical Features

- **48kHz/24bit Audio**: High-quality audio output
- **DAW Integration**: VST/AU plugin for routing (planned)
- **VS Code Extension**: Syntax highlighting and live execution
- **macOS Optimized**: CoreAudio integration

## 現在の実装状況

### 📦 Legacy MIDI-Based Implementation (Deprecated)

The previous MIDI-based implementation (Phases 1-10) is now deprecated but preserved for research purposes.

### 🚧 New Audio-Based Implementation

| Phase | Status | Progress | Description |
|-------|--------|----------|-------------|
| **Phase 1-3** | ✅ Complete | 100% | Parser, Interpreter, Transport System |
| **Phase 4** | ✅ Complete | 100% | VS Code Extension (Syntax, Commands, IntelliSense) |
| **Phase 5** | ✅ Complete | 100% | Audio Playback Verification (Sox Integration) |
| **Phase 6** | ✅ Complete | 100% | Live Coding Workflow (All Issues Resolved) |
| **Phase 7** | ✅ Complete | 100% | **SuperCollider Integration (0-2ms Latency!)** |
| **Git Workflow** | ✅ Complete | 100% | **Development Environment Setup (Branch Protection, Worktree, BugBot)** |
| **Phase 8** | 📝 Next | 0% | Polymeter Testing & Advanced Features |
| **Phase 9** | 📝 Planned | 0% | DAW Plugin Development |

**Current Status**: Audio Playback Testing in progress (Issue #61) 🎧

**Phase 7 Achievements**:
- ✅ **SuperCollider audio engine** (replaced sox)
- ✅ **0-2ms latency** (was 140-150ms)
- ✅ 48kHz/24bit audio output via scsynth
- ✅ 3-track synchronization
- ✅ **Chop functionality** (8-beat hihat with closed/open)
- ✅ Buffer preloading and management
- ✅ Graceful lifecycle (SIGTERM → server.quit())
- ✅ Live coding ready in Cursor

**Phase 6 Achievements** (Foundation):
- ✅ Persistent engine process with REPL
- ✅ Two-phase workflow (definitions on save, execution via Cmd+Enter)
- ✅ Individual track control (`.run()`, `.loop()`, `.stop()`)
- ✅ Live sequence addition without restart
- ✅ Explicit scheduler control (no auto-start)
- ✅ **Polymeter support** (independent time signatures per sequence)

See [WORK_LOG.md](docs/WORK_LOG.md#615-phase-6-completion-january-5-2025) for detailed resolution notes.

## 技術スタック

### 現行（Audio-Based）
- TypeScript
- VS Code Extension API
- **SuperCollider** (scsynth + supercolliderjs)
- OSC (Open Sound Control)

### 旧実装（Deprecated / 未実装）
- ~~CoreMIDI (@julusian/midi)~~ - Legacy, 未実装
- ~~macOS IAC Bus~~ - Legacy, 未実装

## プロジェクト構造

```
orbitscore/
├── packages/
│   ├── engine/          # DSLエンジン（Audio-Based）
│   │   ├── src/
│   │   │   ├── parser/       # パーサ実装
│   │   │   ├── interpreter/  # インタープリタ（v2）
│   │   │   ├── core/         # Global & Sequence
│   │   │   ├── audio/        # SuperCollider統合
│   │   │   ├── timing/       # タイミング計算
│   │   │   └── cli/          # CLIインターフェース
│   │   ├── dist/             # ビルド出力
│   │   └── supercollider/    # SynthDef定義
│   └── vscode-extension/     # VS Code拡張
│       ├── src/              # 拡張機能ソース
│       ├── syntaxes/         # シンタックス定義
│       └── engine/           # バンドルされたエンジン
├── docs/                     # ドキュメント
│   ├── WORK_LOG.md          # 開発履歴
│   ├── PROJECT_RULES.md     # プロジェクトルール
│   ├── INSTRUCTION_ORBITSCORE_DSL.md  # DSL仕様
│   └── ...
├── tests/                    # テストスイート
│   ├── parser/              # パーサテスト
│   ├── interpreter/         # インタープリタテスト
│   ├── audio/               # オーディオ処理テスト
│   ├── core/                # Global & Sequenceテスト
│   └── timing/              # タイミング計算テスト
├── examples/
│   └── *.osc                # サンプルファイル
└── README.md                # このファイル
```

## 開発状況

### 完了フェーズ（Audio-Based実装）

詳細は [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) を参照

- ✅ **Phase 1-3** - Parser, Interpreter, Transport System
- ✅ **Phase 4** - VS Code Extension (Syntax, Commands, IntelliSense)
- ✅ **Phase 5** - Audio Playback Verification
- ✅ **Phase 6** - Live Coding Workflow
- ✅ **Phase 7** - SuperCollider Integration (0-2ms Latency)

### 旧完了フェーズ（MIDI-Based / Deprecated）

<details>
<summary>旧フェーズ（参考用）</summary>

- ✅ **Phase 1** - パーサ実装
- ✅ **Phase 2** - Pitch/Bend変換（度数→MIDIノート+PitchBend、octave/octmul/detune/MPE）
- ✅ **Phase 3** - スケジューラ + Transport（リアルタイム再生、Loop/Jump、Mute/Solo）
- ✅ **Phase 4** - VS Code拡張（シンタックスハイライト、Cmd+Enter実行、Transport UI）
- ✅ **Phase 5** - MIDI出力実装（CoreMIDI / IAC Bus）

</details>

## 📚 Documentation

プロジェクトのドキュメントは [`docs/`](docs/) フォルダに整理されています：

- 📏 [PROJECT_RULES.md](docs/core/PROJECT_RULES.md) - プロジェクトルール（必読）
- 📝 [WORK_LOG.md](docs/development/WORK_LOG.md) - 開発履歴
- 🎵 [INSTRUCTION_ORBITSCORE_DSL.md](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) - 言語仕様（単一信頼情報源）
- 📖 [USER_MANUAL.md](docs/core/USER_MANUAL.md) - ユーザーマニュアル
- 🗺️ [IMPLEMENTATION_PLAN.md](docs/development/IMPLEMENTATION_PLAN.md) - 実装計画
- 🧪 [TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md) - テストガイド
- 📚 [INDEX.md](docs/core/INDEX.md) - ドキュメント索引（全体構造）

## 実装済み機能（Audio-Based v3.0）

### Parser & Interpreter

- ✅ グローバル設定（`GLOBAL`, `tempo()`, `beat()`, `audioPath()`）
- ✅ シーケンス設定（`global.seq`, `beat()`, `length()`, `audio()`）
- ✅ パターン定義（`play()`, `chop()`）
- ✅ メソッドチェーン構文

### Audio Engine (SuperCollider)

- ✅ オーディオファイル再生（WAV, AIFF, MP3, MP4）
- ✅ Ultra-low latency（0-2ms）
- ✅ Time-stretching（テンポ調整）
- ✅ Chop機能（オーディオスライシング）
- ✅ Buffer管理とプリロード

### Transport & Timing

- ✅ リアルタイムスケジューリング
- ✅ Polymeter対応（シーケンス毎に独立した拍子）
- ✅ Global transport: `global.start()`, `global.stop()`
- ✅ Sequence control: `RUN()`, `LOOP()`, `MUTE()` (Unidirectional Toggle)
- ✅ Bar-quantized execution

### VS Code Extension

- ✅ シンタックスハイライト（Audio DSL v3.0）
- ✅ Cmd+Enter実行
- ✅ エンジン制御コマンド
- ✅ リアルタイムフィードバック

<details>
<summary>旧実装済み機能（MIDI-Based / Deprecated）</summary>

### パーサ (Phase 1)

- ✅ グローバル設定（key, tempo, meter, randseed）
- ✅ シーケンス設定（bus, channel, meter, tempo, octave, etc.）
- ✅ イベント（和音、単音、休符）
- ✅ 音価構文（@U0.5, @2s, @25%2bars, @[3:2]\*U1）

### Pitch/Bend変換 (Phase 2)

- ✅ 度数→MIDIノート変換（0=休符, 1=C, 2=C#...12=B）
- ✅ オクターブ/detune処理
- ✅ PitchBend計算（bendRange対応）
- ✅ MPEチャンネル割当

### スケジューラ (Phase 3)

- ✅ リアルタイム再生（LookAhead=50ms, Tick=5ms）
- ✅ Shared/Independent メーター
- ✅ Transport（Loop/Jump）小節頭クオンタイズ
- ✅ Mute/Solo機能
- ✅ 窓ベースNoteOff管理

</details>

## テスト

```bash
npm test
```

**229/248 tests passing (92.3%)**:

- Parser: ✅ Complete (50 tests)
- Audio Engine: ✅ Complete (9 tests)
- Timing Calculator: ✅ Complete (10 tests)
- Interpreter: ✅ Complete (83 tests)
- DSL v3.0: ✅ Complete (56 tests)
- Setting Sync: ✅ Complete (19 tests)
- Live Coding Workflow: ✅ Verified (manual testing)

**Note**: 19 tests skipped (SuperCollider integration tests require local environment).

## 使い方

### 前提条件

- macOS
- Node.js
- VS Code

### インストール

```bash
npm install
npm run build
```

### ビルドコマンド

```bash
# 通常ビルド（増分ビルド）
npm run build

# クリーンビルド（全ファイルを再コンパイル）
npm run build:clean
```

**注意**: 初回ビルド時や、TypeScriptの増分ビルドで問題が発生した場合は `npm run build:clean` を実行してください。

**VSCode Extension専用ビルド**:
```bash
cd packages/vscode-extension
npm run build          # 増分ビルド
npm run build:clean    # クリーンビルド
```

### ~~MIDIポート設定~~ (未実装)

> ⚠️ **Note**: MIDI機能は現在未実装です。本プロジェクトはオーディオベースのDSLに移行しました。以下の説明は旧仕様（Deprecated）です。

<details>
<summary>旧MIDI仕様（参考用）</summary>

- デフォルトで `IAC Driver Bus 1` に接続しますが、`.env` に `ORBITSCORE_MIDI_PORT="Your IAC Bus"` を指定すると上書きできます。
- 各シーケンスの `bus "..."` 設定を解析し、最初に検出したIAC Bus名を優先してオープンします。
- 複数バスを定義する場合は、実行時に警告が表示されます（現状は最初のバスを利用）。

</details>

### DSLの基本構文（Audio-Based v3.0）

```osc
// グローバル設定
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")  // オーディオファイルのベースパス

// グローバル起動
global.start()

// キックシーケンス
var kick = init global.seq
kick.beat(4 by 4).length(1)
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

// スネアシーケンス
var snare = init global.seq
snare.beat(4 by 4).length(1)
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)

// Transport control
LOOP(kick)
RUN(snare)
```

<details>
<summary>旧MIDI構文（参考用 / Deprecated）</summary>

```osc
# グローバル設定
key C
tempo 120
meter 4/4 shared
randseed 42

# シーケンス（ピアノ）
sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 5/4 independent
  tempo 132
  octave 4.0
  octmul 1.0
  bendRange 2

  # イベント
  (1@U0.5, 5@U1, 8@U0.25)  0@U0.5  3@2s  12@25%2bars
}
```

</details>

### VS Code拡張

1. 拡張機能のビルド:

```bash
cd packages/vscode-extension
npm install
npm run build
```

2. VS Codeにインストール:
   - `Cmd+Shift+P` → "Developer: Install Extension from Location..."
   - `packages/vscode-extension`フォルダを選択

3. 使用方法:
   - `.osc`ファイルを開く
   - `Cmd+Enter`で選択範囲を実行
   - Transport Panelでループ/ジャンプ制御

## ライセンス

ISC

## 貢献

プロジェクトへの貢献を歓迎します。詳細は `INSTRUCTIONS_NEW_DSL.md` と `IMPLEMENTATION_PLAN.md` をご覧ください。
