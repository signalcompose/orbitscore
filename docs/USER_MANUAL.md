# OrbitScore ユーザーマニュアル

## 目次

1. [はじめに](#はじめに)
2. [インストール](#インストール)
3. [基本的な使い方](#基本的な使い方)
4. [DSL構文ガイド](#dsl構文ガイド)
   - 4.1 [初期化](#1-初期化)
   - 4.2 [グローバルパラメータ](#2-グローバルパラメータ)
   - 4.3 [シーケンスパラメータ](#3-シーケンスパラメータ)
   - 4.4 [リズムパターン（play()）](#4-リズムパターンplay)
   - 4.5 [トランスポートコマンド](#5-トランスポートコマンド)
   - 4.6 [音量とステレオ位置](#6-音量とステレオ位置)
   - 4.7 [アンダースコアプレフィックスパターン（DSL v3.0）](#7-アンダースコアプレフィックスパターンdsl-v30)
   - 4.8 [メソッドチェーン](#8-メソッドチェーン)
5. [よくある間違い](#よくある間違い)
6. [トラブルシューティング](#トラブルシューティング)

---

## はじめに

OrbitScoreは、度数ベースの音楽DSLを持つライブコーディング用オーディオエンジンです。SuperColliderをバックエンドとして使用し、リアルタイムでの音楽制作を可能にします。

### 特徴

- **シンプルなDSL**: 直感的なメソッドチェーン構文
- **リアルタイム制御**: パラメータをライブで変更可能
- **SuperCollider統合**: 高品質なオーディオエンジン
- **VS Code拡張機能**: 統合開発環境
- **アンダースコアプレフィックス（v3.0）**: 設定のみ vs 即時適用を明示的に制御
- **片記号方式（v3.0）**: RUN/LOOP/MUTEによる一方向トグル制御

---

## インストール

### 前提条件

- **Node.js**: v22.0.0以上
- **SuperCollider**: 3.14.0以上
- **VS Code / Cursor**: エディタ

### SuperColliderのインストール

**macOS:**
```bash
brew install --cask supercollider
```

**Linux:**
```bash
sudo apt-get install supercollider
```

**Windows:**
[SuperCollider公式サイト](https://supercollider.github.io/)からダウンロード

### OrbitScoreのインストール

```bash
# リポジトリをクローン
git clone https://github.com/your-org/orbitscore.git
cd orbitscore

# Engineをビルド
cd packages/engine
npm install
npm run build

# VSCode拡張機能をビルド（オプション）
cd ../vscode-extension
npm install
npm run build
```

### SynthDefのセットアップ

OrbitScoreは専用のSynthDef（シンセサイザー定義）を使用します。通常はビルド済みファイルが含まれているため、追加の設定は不要です。

**SynthDefを再ビルドする場合:**

```bash
cd packages/engine/supercollider

# 既存のsclangプロセスを終了
killall sclang 2>/dev/null

# SynthDefをビルド（macOS）
/Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd

# 成功メッセージを確認
# ✅ All SynthDefs saved! が表示されればOK
```

---

## 基本的な使い方

### 最初のプログラム

以下は、シンプルなキックドラムを再生する例です。

```orbitscore
// グローバル設定
var global = init GLOBAL
global.tempo(120)
global.beat(4)
global.audioPath("/path/to/your/audio/files")

// キックドラムシーケンス
var kick = init global.seq
kick.length(1)
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 0, 0)

// 実行
global.start()
kick.run()
```

### 実行方法

#### VS Code / Cursor での実行

1. **エンジン起動**: ステータスバーをクリック → "🚀 Start Engine"
2. **ファイルを開く**: `.osc` ファイルを開く
3. **保存**: `Cmd+S` で定義を評価
4. **実行**: コマンドを選択して `Cmd+Enter`

#### CLIでの実行

```bash
cd packages/engine
node dist/cli-audio.js play your-file.osc 10  # 10秒間再生
```

---

## DSL構文ガイド

### 1. 初期化

#### グローバルコンテキスト

```orbitscore
var global = init GLOBAL
```

すべてのOrbitScoreプログラムは、グローバルコンテキストの初期化から始まります。これにより、トランスポートとオーディオエンジンが作成されます。

**注意**: `global`という変数名は慣例ですが、任意の名前を使用できます（例: `var g = init GLOBAL`）。

#### シーケンス作成

```orbitscore
var seq = init global.seq
```

シーケンスは音楽のパターンを表現する基本単位です。

### 2. グローバルパラメータ

#### テンポ設定

```orbitscore
global.tempo(120)   // 120 BPM
global.tempo(140)   // 140 BPM
```

#### 拍子設定（Time Signature）

```orbitscore
global.beat(4)        // 4/4拍子
global.beat(3)        // 3/4拍子
global.beat(5 by 4)   // 5/4拍子
global.beat(7 by 8)   // 7/8拍子
```

**重要**: `beat()`は拍子（タイムシグネチャ）を設定するメソッドです。リズムパターンを定義するものではありません。

#### オーディオファイルのベースパス

```orbitscore
global.audioPath("/Users/you/audio")
```

このパスを設定すると、`sequence.audio()`で相対パスを使用できます。

### 3. シーケンスパラメータ

#### ループの長さ

```orbitscore
seq.length(1)   // 1小節ループ
seq.length(2)   // 2小節ループ
seq.length(4)   // 4小節ループ
```

**重要な動作**: `length()`は各イベントの時間を変更し、結果として音程（playback rate）も変化します。

**例: 120 BPM, 4/4拍子, 1秒のオーディオを`chop(4)`した場合**

- `length(1)`: 4イベントが1小節（2秒）に分散 → 各イベント500ms → rate = 0.5
- `length(2)`: 4イベントが2小節（4秒）に分散 → 各イベント1000ms → rate = 0.25（1オクターブ下）
- `length(4)`: 4イベントが4小節（8秒）に分散 → 各イベント2000ms → rate = 0.125（2オクターブ下）

```orbitscore
// 例: length(2)で音程が1オクターブ下がる
var arp = init global.seq
arp.audio("arpeggio.wav").chop(4)
arp.play(1, 2, 3, 4)

arp.length(1)   // 通常の音程
arp.length(2)   // 1オクターブ下
arp.length(0.5) // 1オクターブ上
```

これにより、`length()`を使って意図的に音程を変えることができます。

#### 音声ファイルの読み込み

```orbitscore
// audioPath()を使用した相対パス
global.audioPath("/path/to/audio")
seq.audio("kick.wav")

// 絶対パス
seq.audio("/full/path/to/kick.wav")

// 相対パス（カレントディレクトリから）
seq.audio("../audio/kick.wav")
```

#### Chop（音声分割）

```orbitscore
seq.chop(1)   // 分割しない（全体を1つのスライスとして使用）
seq.chop(4)   // 4つのスライスに分割
seq.chop(8)   // 8つのスライスに分割
seq.chop(16)  // 16つのスライスに分割
```

**用途:**
- **ドラムサンプル**: `chop(1)` または省略（全体を再生）
- **ループ素材**: `chop(8)`, `chop(16)` など（スライスして並べ替え）

### 4. リズムパターン（play()）

`play()`メソッドでリズムパターンを定義します。

```orbitscore
seq.play(1, 0, 0, 0)     // 1拍目だけ再生
seq.play(1, 0, 1, 0)     // 1拍目と3拍目
seq.play(1, 1, 1, 1)     // 全拍で再生
```

**数値の意味:**
- **0**: 休符（silence）
- **1-n**: スライス番号（`chop(n)`で分割したスライス）

**例: 4分割したアルペジオを順番に再生**

```orbitscore
var arp = init global.seq
arp.audio("arpeggio.wav").chop(4)
arp.play(1, 2, 3, 4)  // スライス1→2→3→4の順で再生
```

#### ネストされたリズムパターン

括弧 `()` を使ってリズムを階層的に細分化できます：

```orbitscore
seq.play(1, (2, 3))              // 1拍目に1、2拍目を2分割して2と3
seq.play((1, 2), (3, 4, 5))     // 複雑な分割
seq.play(1, 0, (1, 0), 0)       // 3拍目を2分割
```

**ネストの動作原理:**

1. トップレベルの要素は小節（または`length()`で指定された長さ）を等分割します
2. ネストされた要素は、親要素の時間をさらに等分割します
3. 各イベントの再生速度（rate）は、イベントの長さに合わせて自動調整されます

**実例: 120 BPM, 4/4拍子（1小節 = 2秒）**

```orbitscore
// 基本パターン
arp.play(1, 2, 3, 4)
// → 各要素500ms（0.5秒）

// ネストパターン
arp.play((1, 0), 2, (3, 2, 3), 4)
// → 1番目: (1, 0)が500msを2分割 → 各250ms
//    2番目: 2が500ms
//    3番目: (3, 2, 3)が500msを3分割 → 各166ms
//    4番目: 4が500ms
```

**確認済みの動作例:**

```orbitscore
var global = init GLOBAL
global.tempo(120)
global.beat(4)
global.audioPath("/path/to/audio")

var arp = init global.seq
arp.audio("arpeggio_c.wav").chop(4)

// 基本: スライス1→2→3→4
arp.play(1, 2, 3, 4)

// 休符を挟む: スライス1→休符→スライス2→休符→...
arp.play(1, 0, 2, 0, 3, 0, 4, 0)

// ネスト: 1番目と3番目を細分化
arp.play((1, 0), 2, (3, 2, 3), 4)
// → 聞こえる順: 1(速い)→2→3(速い)→2(速い)→3(速い)→4

global.start()
arp.loop()
```

**音程（pitch）の変化:**
ネストで時間が短くなると、自動的に再生速度が上がり、音程が高くなります。
- 2分割 → 2倍速 → 1オクターブ上
- 3分割 → 3倍速 → 約1.58倍の周波数（完全5度 + 長3度）

### 5. トランスポートコマンド

#### スケジューラーの起動

```orbitscore
global.start()   // スケジューラーを起動（必須）
```

**重要**: シーケンスを実行する前に、必ず`global.start()`でスケジューラーを起動する必要があります。

#### シーケンスの実行（個別）

```orbitscore
seq.run()    // 1回だけ実行
seq.loop()   // ループ実行
seq.stop()   // 停止
seq.mute()   // ミュート（LOOPのみ影響）
seq.unmute() // ミュート解除
```

#### 予約語による一括制御（DSL v3.0）

**片記号方式（Unidirectional Toggle）**を使って、複数のシーケンスを一括制御できます：

```orbitscore
// RUN: ワンショット再生グループ（指定したシーケンスのみ実行）
RUN(kick)                 // kickのみワンショット再生
RUN(kick, snare, hihat)   // kick, snare, hihatをワンショット再生

// LOOP: ループ再生グループ（指定したシーケンスのみループ、他は自動停止）
LOOP(bass)                // bassのみループ（他のループは自動停止）
LOOP(kick, snare)         // kick, snareのみループ

// MUTE: ミュートフラグ（LOOPにのみ影響、RUNには影響なし）
MUTE(hihat)               // hihatのミュートフラグON（他はOFF）
MUTE(snare, hihat)        // snare, hihatのミュートフラグON
```

**片記号方式の特徴:**

1. **一方向制御**: `RUN(kick, snare)` = kick と snare **のみ** RUNグループに含める
   - 指定しなかったシーケンスは自動的にグループから除外される
   - `STOP`や`UNMUTE`キーワードは不要

2. **RUNとLOOPの独立性**: 同じシーケンスが両方のグループに所属可能
   ```orbitscore
   RUN(kick)    // kickをワンショット再生
   LOOP(kick)   // kickをループ再生（両方同時に動作）
   ```

3. **MUTEはLOOPのみに影響**: ミュートフラグはループ再生にのみ作用
   ```orbitscore
   LOOP(kick, snare, hat)   // 3つ全てループ
   MUTE(hat)                // hatはループするが音は出ない
   RUN(hat)                 // hatはワンショット再生で音が出る（MUTEは影響しない）
   ```

4. **MUTE永続性**: MUTEフラグはLOOP離脱後も維持される
   ```orbitscore
   MUTE(kick)               // kickのMUTEフラグON
   LOOP(kick, snare)        // kickループ（ミュート）、snareループ
   LOOP(snare)              // kickはループ停止するが、MUTEフラグは維持
   LOOP(kick)               // kickループ再開、まだミュートされている
   ```

**マルチライン記法:**
```orbitscore
RUN(
  kick,
  snare,
  hihat,
)

LOOP(
  bass,
  lead,
)

MUTE(
  hihat,
)
```

#### 全体の停止

```orbitscore
global.stop()   // すべてのシーケンスを停止
```

### 6. 音量とステレオ位置

#### 音量（Gain）

```orbitscore
seq.gain(0)     // 0 dB（デフォルト）
seq.gain(6)     // +6 dB（大きく）
seq.gain(-6)    // -6 dB（小さく）
seq.gain(-60)   // ほぼ無音
```

範囲: -60 dB ～ +12 dB

#### ステレオ位置（Pan）

```orbitscore
seq.pan(0)      // 中央（デフォルト）
seq.pan(-100)   // 完全に左
seq.pan(100)    // 完全に右
seq.pan(-50)    // やや左
seq.pan(50)     // やや右
```

範囲: -100（左） ～ 100（右）

### 7. アンダースコアプレフィックスパターン（DSL v3.0）

**DSL v3.0から、全ての設定メソッドに「設定のみ」と「即時適用」の2つのバージョンがあります。**

#### パターン: `method()` vs `_method()`

- **`method(value)`**: **設定のみ** - 値を保存するだけで、再生トリガーや即時反映は行わない
- **`_method(value)`**: **即時適用** - 値を保存し、かつ即座に再生トリガー/反映を行う

**対象メソッド:**

**Sequenceメソッド:**
- `audio()` / `_audio()` - オーディオファイル設定
- `chop()` / `_chop()` - スライス分割
- `play()` / `_play()` - プレイパターン
- `beat()` / `_beat()` - ビート設定
- `length()` / `_length()` - ループ長
- `tempo()` / `_tempo()` - テンポ設定
- `gain()` / `_gain()` - 音量（リアルタイムパラメータ - 両方とも即時反映）
- `pan()` / `_pan()` - パン（リアルタイムパラメータ - 両方とも即時反映）

**Globalメソッド:**
- `tempo()` / `_tempo()` - グローバルテンポ設定（アンダースコアあり版は全シーケンスに即時反映）
- `beat()` / `_beat()` - グローバル拍子設定（アンダースコアあり版は全シーケンスに即時反映）

#### 使い分け

**1. セットアップフェーズ（再生前）**

再生前の初期設定では、アンダースコアなしのメソッドを使用します：

```orbitscore
var global = init GLOBAL
global.tempo(120)

var kick = init global.seq
kick.audio("kick.wav")     // 設定のみ
kick.chop(4)               // 設定のみ
kick.play(1, 0, 1, 0)      // 設定のみ
kick.gain(-3)              // 音量は即時反映（リアルタイムパラメータ）

global.start()
kick.run()                 // ここで全ての設定が適用される
```

**2. ライブコーディング（再生中）**

再生中にパターンを変更する場合、アンダースコアありのメソッドで即座に反映：

```orbitscore
// シーケンスは既にループ中
kick.loop()

// アンダースコアなし: 設定はバッファされ、次のrun()/loop()で適用
kick.play(1, 1, 0, 0)      // パターン変更はまだ反映されない
kick.tempo(140)            // テンポ変更もまだ反映されない
kick.run()                 // ここで適用される

// アンダースコアあり: 即座に適用・再生
kick._play(1, 1, 0, 0)     // パターンが即座に変更され、再生開始
kick._tempo(160)           // テンポが即座に変更
```

**3. グローバルパラメータの即時反映（再生中）**

Globalのアンダースコアメソッドは、そのパラメータを継承している全シーケンスに即座に反映されます：

```orbitscore
var g = init GLOBAL
g.tempo(120)

var kick = init g.seq
kick.play(1, 0, 1, 0)
// kickはグローバルのテンポ(120)を継承

var bass = init g.seq
bass.tempo(90)  // bassは独自のテンポを設定（グローバルを上書き）
bass.play(1, 0, 0, 0)

g.start()
kick.loop()
bass.loop()

// グローバルテンポを即座に変更（継承しているkickのみ影響）
g._tempo(140)
// → kickは140 BPMで再生（即座に反映）
// → bassは90 BPM（変更なし、独自テンポを使用中）

// グローバル拍子を即座に変更
g._beat(3, 4)
// → 継承している全シーケンスが3/4拍子に変更
```

**継承とオーバーライドのルール:**
- シーケンスは初期状態でGlobalのtempo/beatを継承
- `sequence.tempo()`や`sequence.beat()`を呼ぶと、その時点で継承を解除し独自値を使用
- `global._tempo()`や`global._beat()`は、**継承しているシーケンスのみ**に即座に反映

**4. リアルタイムミキシング**

`gain()`と`pan()`は**リアルタイムパラメータ**なので、アンダースコアの有無に関わらず常に即時反映されます：

```orbitscore
// 以下は全て即座に反映される
kick.gain(-6)              // 即座に音量変更
kick._gain(-6)             // 同じ効果
kick.pan(-50)              // 即座にパン変更
kick._pan(-50)             // 同じ効果
```

#### 初期値設定メソッド

再生前に音量やパンの初期値を設定する場合は、専用のメソッドを使用できます：

```orbitscore
kick.defaultGain(-3)       // 初期音量を設定（再生トリガーなし）
kick.defaultPan(-20)       // 初期パンを設定（再生トリガーなし）

global.start()
kick.run()                 // 設定された初期値で再生開始
```

#### メリット

- **セットアップ時**: 冗長な再生トリガーを回避し、クリーンな初期化
- **ライブコーディング時**: `_method()`で即座に変更を反映
- **一貫性**: 全メソッドで統一されたパターン
- **明示性**: コードの意図が明確

### 8. メソッドチェーン

すべてのシーケンスメソッドはチェーン可能です：

```orbitscore
var snare = init global.seq
  .length(1)
  .audio("snare.wav")
  .chop(1)
  .play(0, 0, 1, 0)
  .gain(-3)
  .pan(20)
```

---

## よくある間違い

### 1. beat()の誤用

❌ **間違い:**
```orbitscore
seq.beat("x___")  // beat()はリズムパターンではない
```

✅ **正しい:**
```orbitscore
global.beat(4)         // 4/4拍子（第2引数は省略可、デフォルト=4）
global.beat(3, 4)      // 3/4拍子
global.beat(5, 4)      // 5/4拍子
seq.play(1, 0, 0, 0)   // リズムパターン
```

**重要**: `beat()`は**拍子（Time Signature）**を設定するメソッドです。リズムパターンは`play()`で定義します。

### 2. スケジューラーの起動忘れ

❌ **間違い:**
```orbitscore
kick.run()   // global.start()を呼んでいない
```

✅ **正しい:**
```orbitscore
global.start()   // スケジューラー起動（必須）
kick.run()       // シーケンス実行
```

### 3. 音声ファイルパスの問題

❌ **間違い:**
```orbitscore
seq.audio("kick.wav")  // audioPath未設定で相対パスを使用
```

✅ **正しい方法1（audioPathを使用）:**
```orbitscore
global.audioPath("/path/to/audio")
seq.audio("kick.wav")
```

✅ **正しい方法2（絶対パス）:**
```orbitscore
seq.audio("/full/path/to/kick.wav")
```

### 4. play()の数値の意味を誤解

❌ **間違い:**
```orbitscore
seq.play("1")  // 文字列ではなく数値を使用
```

✅ **正しい:**
```orbitscore
seq.play(1, 0, 0, 0)  // 数値で指定
```

---

## トラブルシューティング

### 音が出ない

**症状**: エラーは出ないが音が聞こえない

**原因と解決策:**

1. **スケジューラーが起動していない**
   ```orbitscore
   global.start()  // これを追加
   kick.run()
   ```

2. **音声ファイルが見つからない**
   - パスが正しいか確認
   - `global.audioPath()`を設定
   - 絶対パスを試す

3. **オーディオデバイスの音量を確認**
   - システムの音量設定を確認
   - 正しいオーディオデバイスが選択されているか確認

### SuperColliderサーバーが起動しない

**症状**: "Server failed to start" エラー

**原因**: ポート57110が既に使用されている

**解決策:**
```bash
# 既存のSuperColliderプロセスを終了
killall scsynth
killall sclang

# 再度実行
```

### 音声ファイルが読み込めない

**症状**: "File could not be opened" エラー

**解決策:**

1. **ファイルが存在するか確認**
   ```bash
   ls -la /path/to/audio/kick.wav
   ```

2. **パスを修正**
   ```orbitscore
   // 絶対パスを試す
   seq.audio("/Users/you/audio/kick.wav")
   ```

3. **audioPath()を使用**
   ```orbitscore
   global.audioPath("/Users/you/audio")
   seq.audio("kick.wav")
   ```

### SynthDefが見つからない

**症状**: SynthDefエラー

**解決策:**

1. **SynthDefをビルド**
   ```bash
   cd packages/engine/supercollider
   /Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd
   ```

2. **成功メッセージを確認**
   ```
   ✅ All SynthDefs saved!
   ```

---

## 次のステップ

- [DSL仕様書](INSTRUCTION_ORBITSCORE_DSL.md) - 完全なDSL仕様
- [サンプル集](../examples/README.md) - 実践的な例
- [パフォーマンステストガイド](PERFORMANCE_TEST_GUIDE.md) - 高度な機能

---

**Version**: 3.1
**Last Updated**: 2025-10-09

**変更履歴:**
- **v3.1 (2025-10-09)**: Issue #57対応 - tick/key削除、Global._tempo()/_beat()追加、継承システム説明追加
- **v3.0 (2025-01-09)**: アンダースコアプレフィックスパターン + 片記号方式（Unidirectional Toggle）追加
- **v1.0 (2024-10-08)**: 初版公開
