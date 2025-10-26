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

### 9. `test-mastering-effects.osc` 🆕
- **目的**: グローバルマスタリングエフェクト
- **内容**:
  - `global.compressor()` - 音圧を上げる
  - `global.limiter()` - クリッピング防止
  - `global.normalizer()` - 最大音量化
  - シームレスなon/off制御
  - 超アグレッシブな設定例

### 10. `test-all-features.osc` 🆕
- **目的**: 全機能の網羅的テスト
- **内容**:
  - 実装済み全機能のデモ
  - 基本的な使い方の参考例
  - コメントアウトされたテストケース

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

## 🧪 参考テストファイル

高度な使用例やストレステストのための参考ファイル：

- `test-gain.osc` - 音量制御の詳細テスト（dB単位）
- `test-pan.osc` - ステレオ位置の詳細テスト
- `test-random-gain-pan.osc` - ランダム機能のテスト
- `test-mastering-effects.osc` - マスタリングエフェクトのテスト
- `test-polymeter.osc` - ポリメーターの基本テスト
- `test-polytempo.osc` - ポリテンポの基本テスト
- `test-nested.osc` - ネストリズムの各種パターン
- `test-insane-nested.osc` - 極限ネスト（11レベル）
- `test-danger-zone-poly.osc` - マルチトラックストレステスト

これらのファイルは開発・デバッグ用ですが、参考になる場合があります。

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
├── 07_audio_control.osc            # 🆕 音量・パン制御
├── 08_timing_verification.osc      # 🆕 タイミング検証
├── live-demo.osc                   # ライブデモ
├── multi-track-test.osc            # マルチトラックテスト
├── test-*.osc                      # 参考テストファイル
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
