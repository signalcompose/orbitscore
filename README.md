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

- **48kHz/24bit Audio**: Professional audio quality
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
| **Phase 7** | 📝 Next | 0% | Advanced Audio Features (Time-stretch, Pitch-shift) |
| **Phase 8** | 📝 Planned | 0% | DAW Plugin Development |

**Current Status**: Phase 6 Complete! Ready for Phase 7 🎉

**Phase 6 Achievements**:
- ✅ Persistent engine process with REPL
- ✅ Two-phase workflow (definitions on save, execution via Cmd+Enter)
- ✅ Individual track control (`.run()`, `.loop()`, `.stop()`)
- ✅ Perfect multi-track synchronization (0-5ms drift)
- ✅ Live sequence addition without restart
- ✅ Explicit scheduler control (no auto-start)
- ✅ Reliable scheduler lifecycle
- ✅ **Polymeter support** (independent time signatures per sequence)

See [WORK_LOG.md](docs/WORK_LOG.md#615-phase-6-completion-january-5-2025) for detailed resolution notes.

## 技術スタック

- TypeScript
- VS Code Extension API
- CoreMIDI (@julusian/midi)
- macOS IAC Bus

## プロジェクト構造

```
orbitscore/
├── packages/
│   ├── engine/          # DSLエンジン
│   │   ├── src/
│   │   │   ├── parser/  # パーサ実装
│   │   │   ├── pitch.ts # Pitch/Bend変換
│   │   │   ├── scheduler.ts # スケジューラ
│   │   │   ├── midi.ts  # MIDI出力
│   │   │   └── cli.ts   # CLIインターフェース
│   │   └── dist/        # ビルド出力
│   └── vscode-extension/ # VS Code拡張
│       ├── src/         # 拡張機能ソース
│       └── syntaxes/    # シンタックス定義
├── docs/                # ドキュメント
│   ├── WORK_LOG.md     # 開発履歴
│   ├── PROJECT_RULES.md # プロジェクトルール
│   └── ...
├── tests/               # テストスイート
│   ├── parser/         # パーサテスト
│   ├── pitch/          # Pitch変換テスト
│   ├── midi/           # CoreMIDIシンクのユニットテスト
│   └── scheduler/      # スケジューラテスト
├── examples/
│   └── demo.osc        # デモファイル
└── README.md           # このファイル
```

## 開発状況

### 完了フェーズ

- ✅ **Phase 1** - パーサ実装
- ✅ **Phase 2** - Pitch/Bend変換（度数→MIDIノート+PitchBend、octave/octmul/detune/MPE）
- ✅ **Phase 3** - スケジューラ + Transport（リアルタイム再生、Loop/Jump、Mute/Solo）
- ✅ **Phase 4** - VS Code拡張（シンタックスハイライト、Cmd+Enter実行、Transport UI）
- ✅ **Phase 5** - MIDI出力実装（CoreMIDI / IAC Bus）

## 📚 Documentation

プロジェクトのドキュメントは [`docs/`](docs/) フォルダに整理されています：

- 📏 [PROJECT_RULES.md](docs/PROJECT_RULES.md) - プロジェクトルール（必読）
- 📝 [WORK_LOG.md](docs/WORK_LOG.md) - 開発履歴
- 🎵 [INSTRUCTIONS_NEW_DSL.md](docs/INSTRUCTIONS_NEW_DSL.md) - 言語仕様
- 🗺️ [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) - 実装計画
- 📚 [INDEX.md](docs/INDEX.md) - ドキュメント索引

## 実装済み機能

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

### VS Code拡張 (Phase 4)

- ✅ シンタックスハイライト
- ✅ Cmd+Enter選択実行
- ✅ Transport UIパネル
- ✅ リアルタイム診断
- ✅ ステータスバー表示

## テスト

```bash
npm test
```

**216/217 tests passing (99.5%)**:

- Parser: ✅ Complete
- Audio Engine: ✅ Complete  
- Timing Calculator: ✅ Complete
- Live Coding Workflow: ✅ Verified (manual testing)

**Note**: Scheduler lifecycle issues have been resolved. All live coding features working correctly.

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

### MIDIポート設定

- デフォルトで `IAC Driver Bus 1` に接続しますが、`.env` に `ORBITSCORE_MIDI_PORT="Your IAC Bus"` を指定すると上書きできます。
- 各シーケンスの `bus "..."` 設定を解析し、最初に検出したIAC Bus名を優先してオープンします。
- 複数バスを定義する場合は、実行時に警告が表示されます（現状は最初のバスを利用）。

### DSLの基本構文

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
