# OrbitScore ユーザーマニュアル

## 目次

1. [はじめに](#はじめに)
2. [インストール](#インストール)
3. [基本的な使い方](#基本的な使い方)
4. [DSL構文ガイド](#dsl構文ガイド)
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
global.tick(4)
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

#### Tick Resolution

```orbitscore
global.tick(480)   // 1/4音符あたり480 tick（デフォルト）
global.tick(960)   // より高精度
```

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

#### シーケンスの実行

```orbitscore
seq.run()    // 1回だけ実行
seq.loop()   // ループ実行
seq.stop()   // 停止
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

### 7. メソッドチェーン

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

**Version**: 1.0  
**Last Updated**: 2025-10-08
