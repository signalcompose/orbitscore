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
- **macOS対応**: IAC Bus経由でのMIDI出力（実装予定）
- **VS Code拡張**: 統合開発環境での作曲

## 技術スタック

- TypeScript
- VS Code Extension API
- CoreMIDI (@julusian/midi)
- macOS IAC Bus

## プロジェクト構造

```
orbitscore/
├── packages/
│   ├── engine/          # DSLエンジン（パーサ、スケジューラ、MIDI出力）
│   └── vscode-extension/ # VS Code拡張
├── examples/
│   └── demo.osc         # デモファイル
├── tests/               # テスト
└── INSTRUCTIONS_NEW_DSL.md # 詳細仕様
```

## 開発状況

✅ **Phase 1 完了** - パーサ実装
✅ **Phase 2 完了** - Pitch/Bend変換（度数→MIDIノート+PitchBend、octave/octmul/detune/MPE）

DSLのパーサが完全に実装され、demo.oscの解析に成功しました。

## 📚 Documentation

プロジェクトのドキュメントは [`docs/`](docs/) フォルダに整理されています：

- 📏 [PROJECT_RULES.md](docs/PROJECT_RULES.md) - プロジェクトルール（必読）
- 📝 [WORK_LOG.md](docs/WORK_LOG.md) - 開発履歴
- 🎵 [INSTRUCTIONS_NEW_DSL.md](docs/INSTRUCTIONS_NEW_DSL.md) - 言語仕様
- 🗺️ [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) - 実装計画
- 📚 [INDEX.md](docs/INDEX.md) - ドキュメント索引

### 実装済み機能

- ✅ グローバル設定パース（key, tempo, meter, randseed）
- ✅ シーケンス設定パース（bus, channel, meter, tempo, octave, etc.）
- ✅ イベントパース（和音、単音、休符、各種音価）
- ✅ 複雑な音価構文（@U0.5, @2s, @25%2bars）
- ✅ vitestテストフレームワーク

### 次のフェーズ

🔄 **Phase 3** - スケジューラ + Transport（LookAhead=50ms/ Tick=5ms、shared/independent、Loop/Jump）

### テストの実行

```bash
npm test
```

すべてのテスト（parser / pitch / scheduler）が実行されます。

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

1. VS Codeでプロジェクトを開く
2. `Cmd+Enter` で選択範囲を実行（実装予定）

## ライセンス

ISC

## 貢献

プロジェクトへの貢献を歓迎します。詳細は `INSTRUCTIONS_NEW_DSL.md` と `IMPLEMENTATION_PLAN.md` をご覧ください。
