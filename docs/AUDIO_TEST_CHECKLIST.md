# OrbitScore 実音出しテスト - チェックリスト

**作成日**: 2025-10-10
**目的**: USER_MANUAL.md記載の全実装済み機能の動作確認
**担当**: AI（テストファイル作成） + ユーザー（音質確認）

---

## テスト環境

- [ ] SuperCollider起動確認（scsynth）
- [ ] オーディオファイル準備確認（test-assets/audio/）
- [ ] VSCode Extension動作確認

---

## 機能別テストチェックリスト

### 1. 初期化 (Initialization)

- [ ] **1-1**: グローバルコンテキスト初期化 (`var global = init GLOBAL`)
- [ ] **1-2**: シーケンス作成 (`var seq = init global.seq`)

**テストファイル**: `test-audio/01_initialization.osc`

---

### 2. グローバルパラメータ (Global Parameters)

- [ ] **2-1**: テンポ設定 (`global.tempo(120)`)
- [ ] **2-2**: 拍子設定 - 4/4拍子 (`global.beat(4)`)
- [ ] **2-3**: 拍子設定 - 5/4拍子 (`global.beat(5 by 4)`)
- [ ] **2-4**: オーディオパス設定 (`global.audioPath()`)

**テストファイル**: `test-audio/02_global_params.osc`

---

### 3. シーケンスパラメータ (Sequence Parameters)

- [ ] **3-1**: ループの長さ (`seq.length(1)`, `seq.length(2)`)
- [ ] **3-2**: 音声ファイル読み込み - 相対パス (`seq.audio("kick.wav")`)
- [ ] **3-3**: 音声ファイル読み込み - 絶対パス (`seq.audio("/path/to/kick.wav")`)
- [ ] **3-4**: Chop（音声分割） (`seq.chop(1)`, `seq.chop(4)`, `seq.chop(8)`)

**テストファイル**: `test-audio/03_sequence_params.osc`

---

### 4. リズムパターン (Play Patterns)

- [ ] **4-1**: 基本play() - 1拍目のみ (`play(1, 0, 0, 0)`)
- [ ] **4-2**: 基本play() - 複数拍 (`play(1, 0, 1, 0)`)
- [ ] **4-3**: 基本play() - スライス順再生 (`play(1, 2, 3, 4)`)
- [ ] **4-4**: ネストplay() - 2分割 (`play((1, 0), 2, 3, 4)`)
- [ ] **4-5**: ネストplay() - 3分割 (`play(1, 2, (3, 2, 3), 4)`)
- [ ] **4-6**: 休符を挟む (`play(1, 0, 2, 0, 3, 0, 4, 0)`)

**テストファイル**: `test-audio/04_play_patterns.osc`

---

### 5. トランスポートコマンド (Transport Commands)

#### 5-1. 基本トランスポート

- [ ] **5-1-1**: スケジューラー起動 (`global.start()`)
- [ ] **5-1-2**: ワンショット再生 (`seq.run()`)
- [ ] **5-1-3**: ループ再生 (`seq.loop()`)
- [ ] **5-1-4**: 停止 (`seq.stop()`)
- [ ] **5-1-5**: ミュート/アンミュート (`seq.mute()`, `seq.unmute()`)
- [ ] **5-1-6**: 全体停止 (`global.stop()`)

**テストファイル**: `test-audio/05_transport_basic.osc`

#### 5-2. 予約語による一括制御（DSL v3.0）

- [ ] **5-2-1**: RUN() - 単一シーケンス (`RUN(kick)`)
- [ ] **5-2-2**: RUN() - 複数シーケンス (`RUN(kick, snare, hihat)`)
- [ ] **5-2-3**: LOOP() - 単一シーケンス (`LOOP(kick)`)
- [ ] **5-2-4**: LOOP() - 複数シーケンス、他は自動停止 (`LOOP(kick, snare)`)
- [ ] **5-2-5**: MUTE() - ミュートフラグ (`MUTE(hihat)`)
- [ ] **5-2-6**: MUTE() - LOOPにのみ影響、RUNには影響なし
- [ ] **5-2-7**: RUNとLOOPの独立性（同じシーケンスが両方で動作）
- [ ] **5-2-8**: MUTEフラグの永続性（LOOP離脱後も維持）

**テストファイル**: `test-audio/05_transport_commands.osc`

---

### 6. 音量とステレオ位置 (Gain & Pan)

- [ ] **6-1**: 音量設定 - 0dB (`seq.gain(0)`)
- [ ] **6-2**: 音量設定 - +6dB (`seq.gain(6)`)
- [ ] **6-3**: 音量設定 - -6dB (`seq.gain(-6)`)
- [ ] **6-4**: パン設定 - 中央 (`seq.pan(0)`)
- [ ] **6-5**: パン設定 - 左 (`seq.pan(-100)`)
- [ ] **6-6**: パン設定 - 右 (`seq.pan(100)`)
- [ ] **6-7**: リアルタイム音量変更（LOOP中）
- [ ] **6-8**: リアルタイムパン変更（LOOP中）

**テストファイル**: `test-audio/06_gain_pan.osc`

---

### 7. アンダースコアプレフィックスパターン（DSL v3.0）

#### 7-1. 設定のみ vs 即時適用

- [ ] **7-1-1**: `audio()` vs `_audio()` - 設定のみ vs 即時適用
- [ ] **7-1-2**: `chop()` vs `_chop()` - 設定のみ vs 即時適用
- [ ] **7-1-3**: `play()` vs `_play()` - 設定のみ vs 即時適用
- [ ] **7-1-4**: `tempo()` vs `_tempo()` - 設定のみ vs 即時適用
- [ ] **7-1-5**: `length()` vs `_length()` - 設定のみ vs 即時適用

**テストファイル**: `test-audio/07_underscore_prefix.osc`

#### 7-2. グローバルパラメータの即時反映

- [ ] **7-2-1**: `global._tempo()` - 継承しているシーケンスに即時反映
- [ ] **7-2-2**: `global._beat()` - 継承しているシーケンスに即時反映
- [ ] **7-2-3**: 独自テンポ設定済みシーケンスは影響を受けない

**テストファイル**: `test-audio/07_global_underscore.osc`

#### 7-3. 初期値設定メソッド

- [ ] **7-3-1**: `defaultGain()` - 初期音量設定（再生トリガーなし）
- [ ] **7-3-2**: `defaultPan()` - 初期パン設定（再生トリガーなし）

**テストファイル**: `test-audio/07_default_values.osc`

---

### 8. メソッドチェーン (Method Chaining)

- [ ] **8-1**: メソッドチェーンでシーケンス設定
- [ ] **8-2**: チェーンの可読性確認（複数行記法）

**テストファイル**: `test-audio/08_method_chaining.osc`

---

### 9. 統合テスト (Integration Tests)

- [ ] **9-1**: マルチトラック同期（kick + snare + hihat）
- [ ] **9-2**: テンポ変更中のシーケンス同期
- [ ] **9-3**: RUN/LOOP/MUTE複合動作
- [ ] **9-4**: ライブコーディングシミュレーション（パターン変更）

**テストファイル**: `test-audio/09_integration.osc`

---

## テスト実行手順

### 自動テスト（AI実行）

1. SuperCollider統合テスト実行
   ```bash
   npm test -- tests/audio/supercollider-*.spec.ts
   ```

2. CLIテスト実行
   ```bash
   node packages/engine/dist/cli-audio.js run test-audio/01_initialization.osc
   ```

### 手動テスト（ユーザー実行）

各`.osc`ファイルをVSCode Extensionで実行し、以下を確認：

1. **タイミング精度**: 0-3ms以内の誤差
2. **音質**: クリアで歪みがない
3. **同期**: 複数トラックがズレない
4. **即時反映**: `_method()`が即座に反映される
5. **エラーハンドリング**: 適切なエラーメッセージ

---

## テスト結果記録

各テスト項目について以下を記録：

- ✅ 正常動作
- ⚠️ 動作するが問題あり（詳細を記載）
- ❌ 動作しない（詳細を記載）

**記録場所**: このファイルまたは別途Issue作成

---

## 完了条件

- [ ] 全自動テストがパス
- [ ] 全手動テストで音質・タイミング確認完了
- [ ] 発見した問題をIssue化
- [ ] WORK_LOG.mdに結果を記録

---

**注意事項:**
- テスト中に発見したバグは即座にIssue化
- リファクタリングが必要な箇所は別途記録
- マニュアルに不足している説明があれば追記
