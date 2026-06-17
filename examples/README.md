# OrbitScore Examples

このディレクトリには、OrbitScore Audio DSLのサンプルファイルが含まれています。

## 📚 チュートリアル（推奨順）

### 1. `01_getting_started.orbs`
- **目的**: OrbitScoreの基本を学ぶ
- **内容**: 
  - グローバル設定
  - 基本的なシーケンス作成
  - 音声ファイルの読み込み
  - 実行・停止コマンド

### 2. `05_drum_patterns_simple.orbs`
- **目的**: ドラムパターンの作成
- **内容**:
  - キック、スネア、ハイハットのパターン
  - `chop(1)` を使った全体再生
  - リズムパターンの組み合わせ

### 3. `06_method_chaining.orbs`
- **目的**: メソッドチェーンによる効率的な記述
- **内容**:
  - `.beat().length().audio().play()` の連鎖
  - 読みやすいコードスタイル

### 4. `02_audio_manipulation.orbs`
- **目的**: 音声操作機能の習得
- **内容**:
  - `.chop(n)` による音声分割
  - タイムストレッチ（予定）
  - ピッチシフト（予定）

### 5. `03_polymeter_polytempo.orbs`
- **目的**: ポリメーター・ポリテンポの表現
- **内容**:
  - 異なる拍子のシーケンス
  - 異なるテンポのシーケンス
  - 複雑なリズム構造

### 6. `04_nested_rhythms.orbs`
- **目的**: ネストされたリズムパターン
- **内容**:
  - 階層的な時間分割
  - 複雑なパターン生成

### 7. `07_audio_control.orbs` 🆕
- **目的**: 音量とステレオ位置の制御
- **内容**:
  - `gain()` メソッド（dB単位: -60 to +12 dB、デフォルト 0 dB）
  - `pan()` メソッド（-100=左, 0=中央, 100=右）
  - リアルタイムパラメータ変更（シームレス）
  - ランダム機能（`r`, `r0%10`）
  - ステレオミキシングの実例

### 8. `08_timing_verification.orbs` 🆕
- **目的**: タイミング精度の検証
- **内容**:
  - ポリメーター（異なる拍子）
  - ポリテンポ（異なるBPM）
  - ネストされたリズム（最大11レベル）
  - マルチトラックストレステスト
  - パフォーマンスメトリクス

### 9. `09_reserved_keywords.orbs` 🆕
- **目的**: Reserved Keywords（RUN/LOOP/MUTE）の使い方
- **内容**:
  - Unidirectional Toggle design
  - 複数シーケンスの同時制御
  - ミュート機能

### 10. `10_link_audio.orbs` 🆕 v1.2.0
- **目的**: Ableton Live 12.4+ に Link Audio で出力
- **内容**:
  - `global.linkAudio()` で once-per-file 宣言
  - `seq.output("channel-name")` で channel 指定
  - 同名 channel の sum 動作（drums bus パターン）
  - gain / pan は per-sequence で pre-mix
  - tempo / phase / start-stop は LinkAudio 内蔵 Link で双方向同期

## 🎹 MIDI / Pitch DSL（v1.1+, 2.0.0-dev）

degree → MIDI 出力と記号的ピッチ言語の example 群。**SuperCollider 不要**、IAC ポート（macOS の Audio MIDI Setup で online）に送出する。各ファイルは `npm run midi-run -- examples/NN_*.orbs` で実行でき、parse/schedule 健全性は `scripts/qa-midi-smoke.sh` で一括スモークできる（QA は [`docs/testing/QA_2.0.0.md`](../docs/testing/QA_2.0.0.md)、Epic #278）。

### 11. `11_midi_degrees.orbs` 🆕
- **目的**: 最小の MIDI シーケンス（degree → MIDI note）
- **内容**: `seq.midi("IAC", ch)` / `octave()` / `vel()` / `global.key()` / `RUN`

### 12. `12_chords_stacks.orbs` 🆕
- **目的**: 和音と stack（Phase 3, §6）
- **内容**: `[ ]` stack（同時発音）/ bare `[ ]` chord value / `import chords` / spread `[m7, 9]` / `(m7^+1)` octave shift

### 13. `13_scope_chains.orbs` 🆕
- **目的**: スコープチェーンとモード（Phase 2 §3 + E6 §2.2）
- **内容**: `.root()`（数値 / group-level note-name）/ `.oct()` / `mode(...)` + `.mode(name)` lattice

### 14. `14_ties_legato.orbs` 🆕
- **目的**: タイ・レガート・ホールド（Phase 4 §5）
- **内容**: `_` event tie / `{ }` legato slur / `.hold()` common-tone tie

### 15. `15_repetition_sections.orbs` 🆕
- **目的**: 反復とセクション（Phase R §6.5 + E4 #254）
- **内容**: `*n`（n スロット占有）/ pattern 変数 / `,` multi-cell section（song form）

### 16. `16_expression.orbs` 🆕
- **目的**: ノートごとの表現（E5 §10.3）
- **内容**: `@v` velocity（絶対 / 相対アクセント）/ `@g` articulation（gate %）

### 17. `17_voicing_random.orbs` 🆕
- **目的**: voicing 演算子とランダム性（E2 §12）
- **内容**: `.drop()/.invert()/.open()` / `Xr` 要素確率 / `.r` thinning / `^r` random octave

### 18. `18_voicelead_comp.orbs` 🆕
- **目的**: 自動ボイスリーディングと comping（comp C1 §6.3 / C2a §6.4）
- **内容**: `.voicelead()` / `.cell("charleston").comp(...)`

## 🎵 ライブパフォーマンス用

### `live-demo.orbs`
- **目的**: ライブコーディングのデモ・テンプレート
- **内容**:
  - 基本的な3トラック（kick, snare, hihat）
  - Reserved Keywords使用例
  - ライブパフォーマンス用のシンプルな構成

### `performance-demo.orbs`
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
3. **ファイルを開く**: `.orbs` ファイルを開く
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

1. `01_getting_started.orbs` - 基本操作
2. `05_drum_patterns_simple.orbs` - ドラムパターン
3. `06_method_chaining.orbs` - メソッドチェーン
4. `09_reserved_keywords.orbs` - Reserved Keywords
5. `02_audio_manipulation.orbs` - 音声操作
6. `07_audio_control.orbs` - 音量・パン制御
7. `03_polymeter_polytempo.orbs` - ポリメーター
8. `04_nested_rhythms.orbs` - ネストリズム
9. `08_timing_verification.orbs` - タイミング検証
10. `live-demo.orbs` / `performance-demo.orbs` - ライブパフォーマンス

## 📁 ファイル一覧

```
examples/
├── README.md                       # このファイル
├── 01_getting_started.orbs          # 入門
├── 02_audio_manipulation.orbs       # 音声操作
├── 03_polymeter_polytempo.orbs      # ポリメーター・ポリテンポ
├── 04_nested_rhythms.orbs           # ネストリズム
├── 05_drum_patterns_simple.orbs     # ドラムパターン
├── 06_method_chaining.orbs          # メソッドチェーン
├── 07_audio_control.orbs            # 音量・パン制御
├── 08_timing_verification.orbs      # タイミング精度検証
├── 09_reserved_keywords.orbs        # Reserved Keywords
├── 10_link_audio.orbs               # Link Audio 出力（Ableton Live 12.4+）
├── 11_midi_degrees.orbs             # MIDI degree → note（最小 MIDI）
├── 12_chords_stacks.orbs            # 和音・stack（[ ] / chord value）
├── 13_scope_chains.orbs             # スコープチェーン・モード
├── 14_ties_legato.orbs              # タイ・レガート・ホールド
├── 15_repetition_sections.orbs      # 反復・セクション
├── 16_expression.orbs               # ノートごとの表現（@v / @g）
├── 17_voicing_random.orbs           # voicing 演算子・ランダム性
├── 18_voicelead_comp.orbs           # ボイスリーディング・comping
├── live-demo.orbs                   # ライブコーディングテンプレート
└── performance-demo.orbs            # 総合パフォーマンスデモ
```

## ⚠️ 注意事項

- 音声ファイルのパスは環境に合わせて変更してください
- 古いMIDI DSL構文（`key`, `tempo`, `meter`, `sequence`）は非推奨です
- 新しいAudio DSL構文（`var global = init GLOBAL`）を使用してください

## 🔗 関連ドキュメント

- [WORK_LOG.md](../docs/WORK_LOG.md) - 開発履歴
- [INSTRUCTIONS_NEW_DSL.md](../docs/INSTRUCTIONS_NEW_DSL.md) - DSL仕様
- [README.md](../README.md) - プロジェクト概要
