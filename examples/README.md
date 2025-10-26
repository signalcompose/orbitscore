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

### 7. `07_audio_control.osc` 🆕
- **目的**: 音量とステレオ位置の制御
- **内容**:
  - `gain()` メソッド（dB単位: -60 to +12 dB、デフォルト 0 dB）
  - `pan()` メソッド（-100=左, 0=中央, 100=右）
  - リアルタイムパラメータ変更（シームレス）
  - ランダム機能（`r`, `r0%10`）
  - ステレオミキシングの実例

### 8. `08_timing_verification.osc` 🆕
- **目的**: タイミング精度の検証
- **内容**:
  - ポリメーター（異なる拍子）
  - ポリテンポ（異なるBPM）
  - ネストされたリズム（最大11レベル）
  - マルチトラックストレステスト
  - パフォーマンスメトリクス

### 9. `09_reserved_keywords.osc` 🆕
- **目的**: Reserved Keywords（RUN/LOOP/MUTE）の使い方
- **内容**:
  - Unidirectional Toggle design
  - 複数シーケンスの同時制御
  - ミュート機能

## 🎵 ライブパフォーマンス用

### `live-demo.osc`
- **目的**: ライブコーディングのデモ・テンプレート
- **内容**:
  - 基本的な3トラック（kick, snare, hihat）
  - Reserved Keywords使用例
  - ライブパフォーマンス用のシンプルな構成

### `performance-demo.osc`
- **目的**: 全サンプルファイルを使った総合デモ
- **内容**:
  - ドラム、ベース、メロディの全セクション
  - Reserved Keywords使用例
  - ライブミキシングのヒント
  - マスタリングエフェクト設定例

## 🚀 使い方

### VS Code / Cursor での実行

1. **オーディオデバイス選択**（オプション）: ステータスバーをクリック → "🔊 Select Audio Device"
2. **エンジン起動**: ステータスバーをクリック
   - `🚀 Start Engine` - 通常モード（ログ少ない）
   - `🐛 Start Engine (Debug)` - デバッグモード（全ログ表示）
3. **ファイルを開く**: `.osc` ファイルを開く
4. **保存**: `Cmd+S` で定義を評価（設定のみ）
5. **実行**: コマンドを選択して `Cmd+Enter`（実行コマンド、パラメータ変更）

### 実行コマンド例

```orbitscore
// スケジューラー起動
global.start()

// シーケンス開始（Reserved Keywords使用）
LOOP(kick)         // kickをループ

// 複数シーケンス同時開始
RUN(kick, snare, hihat)

// シーケンス停止
LOOP()             // すべてのシーケンスを停止

// ミュート制御
MUTE(snare)        // snareのみミュート
MUTE()             // すべてアンミュート
```

## 📋 推奨学習順序

1. `01_getting_started.osc` - 基本操作
2. `05_drum_patterns_simple.osc` - ドラムパターン
3. `06_method_chaining.osc` - メソッドチェーン
4. `09_reserved_keywords.osc` - Reserved Keywords
5. `02_audio_manipulation.osc` - 音声操作
6. `07_audio_control.osc` - 音量・パン制御
7. `03_polymeter_polytempo.osc` - ポリメーター
8. `04_nested_rhythms.osc` - ネストリズム
9. `08_timing_verification.osc` - タイミング検証
10. `live-demo.osc` / `performance-demo.osc` - ライブパフォーマンス

## 📁 ファイル一覧

```
examples/
├── README.md                       # このファイル
├── 01_getting_started.osc          # 入門
├── 02_audio_manipulation.osc       # 音声操作
├── 03_polymeter_polytempo.osc      # ポリメーター・ポリテンポ
├── 04_nested_rhythms.osc           # ネストリズム
├── 05_drum_patterns_simple.osc     # ドラムパターン
├── 06_method_chaining.osc          # メソッドチェーン
├── 07_audio_control.osc            # 音量・パン制御
├── 08_timing_verification.osc      # タイミング精度検証
├── 09_reserved_keywords.osc        # Reserved Keywords
├── live-demo.osc                   # ライブコーディングテンプレート
└── performance-demo.osc            # 総合パフォーマンスデモ
```

## ⚠️ 注意事項

- 音声ファイルのパスは環境に合わせて変更してください
- 古いMIDI DSL構文（`key`, `tempo`, `meter`, `sequence`）は非推奨です
- 新しいAudio DSL構文（`var global = init GLOBAL`）を使用してください

## 🔗 関連ドキュメント

- [WORK_LOG.md](../docs/WORK_LOG.md) - 開発履歴
- [INSTRUCTIONS_NEW_DSL.md](../docs/INSTRUCTIONS_NEW_DSL.md) - DSL仕様
- [README.md](../README.md) - プロジェクト概要
