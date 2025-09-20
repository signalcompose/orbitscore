# OrbitScore

**Chromatic degree-based music DSL with shared/independent meter systems for polyrhythmic composition**

半音階度数システム（0=休符, 1-12=半音階）を基盤とし、shared/independentメーターによるポリリズム作曲を可能にする音楽DSL。

## 核心的特徴

### 🎵 度数システムの革新

- **度数0 = 休符** - 無音を音階の一部として定義
- **度数1-12 = 半音階** - C, C#, D, D#, E, F, F#, G, G#, A, A#, B
- 音と無音を同じ体系で扱える統一的アプローチ

### ⚡ その他の特徴

- **選択範囲実行**: VS Codeエディタで選択した範囲を即座に実行（Cmd+Enter）
- **ポリリズム/ポリメーター**: shared（小節線共有）とindependent（独立）の両方をサポート
- **高精度**: 小数第3位までの精度と乱数シードによる再現性
- **リアルタイムトランスポート**: 小節頭でのループ/ジャンプ with 量子化
- **macOS対応**: IAC Bus経由でのMIDI出力（CoreMIDI / @julusian/midi）
- **VS Code拡張**: 統合開発環境での作曲

## 現在の実装状況

### ✅ 完了済みフェーズ

- **Phase 1**: Parser Implementation (100%)
- **Phase 2**: Pitch/Bend Conversion (100%)  
- **Phase 3**: Scheduler + Transport (100%)
- **Phase 4**: VS Code Extension (100%)
- **Phase 5**: MIDI Output Implementation (100%)
- **Phase 6**: Max/MSP Integration (100%)
- **Phase 7**: Live Coding Implementation (100%)
- **Phase 8**: VS Code Extension Live Coding Fixes (100%)

### 🚧 次の実装予定

- **Phase 9**: Global configuration and selective sequence playback
- **Phase 10**: Performance optimization and advanced features

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

**53個のテスト**が全てパスしています：

- Parser: 3 tests
- Pitch: 22 tests
- Scheduler: 22 tests
- MIDI: 5 tests

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
