# OrbitScore Examples

このディレクトリには、OrbitScore Audio DSLのサンプルファイルが含まれています。

## 📚 チュートリアル（推奨順）

### 1. `01_getting_started.osc`
- **目的**: OrbitScoreの基本を学ぶ
- **内容**: 
  - グローバル設定
  - 基本的なシーケンス作成
  - 音声ファイルの読み込み
  - 実行・停止コマンド

### 2. `05_drum_patterns_simple.osc`
- **目的**: ドラムパターンの作成
- **内容**:
  - キック、スネア、ハイハットのパターン
  - `chop(1)` を使った全体再生
  - リズムパターンの組み合わせ

### 3. `06_method_chaining.osc`
- **目的**: メソッドチェーンによる効率的な記述
- **内容**:
  - `.beat().length().audio().play()` の連鎖
  - 読みやすいコードスタイル

### 4. `02_audio_manipulation.osc`
- **目的**: 音声操作機能の習得
- **内容**:
  - `.chop(n)` による音声分割
  - タイムストレッチ（予定）
  - ピッチシフト（予定）

### 5. `03_polymeter_polytempo.osc`
- **目的**: ポリメーター・ポリテンポの表現
- **内容**:
  - 異なる拍子のシーケンス
  - 異なるテンポのシーケンス
  - 複雑なリズム構造

### 6. `04_nested_rhythms.osc`
- **目的**: ネストされたリズムパターン
- **内容**:
  - 階層的な時間分割
  - 複雑なパターン生成

## 🎵 ライブコーディング用

### `live-demo.osc`
- **目的**: ライブコーディングのデモ・テンプレート
- **内容**:
  - 基本的な3トラック（kick, snare, hihat）
  - コメントアウトされた実行コマンド
  - ライブパフォーマンス用のシンプルな構成

### `multi-track-test.osc`
- **目的**: 複数トラックの同時制御テスト
- **内容**:
  - 3つの独立したシーケンス
  - 個別のループ制御
  - グローバル停止のテスト

## 🚀 使い方

### VS Code / Cursor での実行

1. **エンジン起動**: ステータスバーの `🎵 OrbitScore: Stopped` をクリック
2. **ファイルを開く**: `.osc` ファイルを開く
3. **保存**: `Cmd+S` で定義を評価
4. **実行**: コマンドを選択して `Cmd+Enter`

### 実行コマンド例

```orbitscore
// スケジューラー起動
global.run()

// シーケンス開始
kick.loop()

// シーケンス停止
kick.stop()

// 全停止
global.stop()
```

## 📁 ディレクトリ構造

```
examples/
├── README.md                       # このファイル
├── 01_getting_started.osc          # 入門
├── 02_audio_manipulation.osc       # 音声操作
├── 03_polymeter_polytempo.osc      # ポリメーター
├── 04_nested_rhythms.osc           # ネストリズム
├── 05_drum_patterns_simple.osc     # ドラムパターン
├── 06_method_chaining.osc          # メソッドチェーン
├── live-demo.osc                   # ライブデモ
├── multi-track-test.osc            # マルチトラックテスト
└── max/                            # Max/MSP パッチ（MIDI用、非推奨）
```

## ⚠️ 注意事項

- 音声ファイルのパスは環境に合わせて変更してください
- 古いMIDI DSL構文（`key`, `tempo`, `meter`, `sequence`）は非推奨です
- 新しいAudio DSL構文（`var global = init GLOBAL`）を使用してください

## 🔗 関連ドキュメント

- [WORK_LOG.md](../docs/WORK_LOG.md) - 開発履歴
- [INSTRUCTIONS_NEW_DSL.md](../docs/INSTRUCTIONS_NEW_DSL.md) - DSL仕様
- [README.md](../README.md) - プロジェクト概要
