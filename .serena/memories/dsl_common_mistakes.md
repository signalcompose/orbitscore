# DSL Common Mistakes and Gotchas

このメモリには、OrbitScore DSLでよくある間違いと注意点を記録します。

## Critical Mistakes（絶対に避けるべき間違い）

### 1. beat()の誤用

**間違い**: `beat()`をリズムパターンとして使用

```orbitscore
// ❌ 間違い
seq.beat("x___")  // beat()はリズムパターンではない
```

**正しい使い方**:

```orbitscore
// ✅ 正しい
global.beat(4)         // 拍子設定（4/4拍子）
seq.play(1, 0, 0, 0)   // リズムパターン（1拍目だけ再生）
```

**説明**:
- `beat()`は**タイムシグネチャ（拍子）**を設定するメソッド
- リズムパターンは`play()`メソッドで定義
- `play()`の引数: `0` = 休符、`1-n` = スライス番号

### 2. スケジューラー起動忘れ

**間違い**: `global.run()`を呼ばずにシーケンスを実行

```orbitscore
// ❌ 間違い
kick.run()   // スケジューラーが起動していない
```

**正しい使い方**:

```orbitscore
// ✅ 正しい
global.run()   // スケジューラー起動（必須）
kick.run()     // シーケンス実行
```

**エラーメッセージ**:
```
⚠️ kick - scheduler not running. Use global.run() first.
```

### 3. 音声ファイルパスの解決失敗

**間違い**: `audioPath()`未設定で相対パスを使用

```orbitscore
// ❌ 間違い（audioPath未設定）
seq.audio("kick.wav")  // ファイルが見つからない
```

**正しい使い方**:

**方法1: audioPath()を使用（推奨）**
```orbitscore
// ✅ 正しい
global.audioPath("/path/to/audio")
seq.audio("kick.wav")  // audioPathと結合される
```

**方法2: 絶対パス**
```orbitscore
// ✅ 正しい
seq.audio("/full/path/to/kick.wav")
```

**方法3: 相対パス（カレントディレクトリから）**
```orbitscore
// ✅ 正しい
seq.audio("../test-assets/audio/kick.wav")
```

## Common Pitfalls（よくある落とし穴）

### 4. play()の引数の型

**間違い**: 文字列を使用

```orbitscore
// ❌ 間違い
seq.play("1", "0", "0", "0")  // 文字列ではない
seq.play("1 0 0 0")           // 1つの文字列でもない
```

**正しい使い方**:

```orbitscore
// ✅ 正しい
seq.play(1, 0, 0, 0)  // 数値をカンマ区切り
```

### 5. chop()の省略

**chop(1)の意味**:

```orbitscore
// これらは同等
seq.audio("kick.wav").chop(1)
seq.audio("kick.wav")  // chop(1)がデフォルト
```

- `chop(1)` = 音声ファイル全体を1つのスライスとして使用
- ドラムサンプルなど、全体を再生する場合に使用

### 6. メソッドチェーンの順序

**推奨される順序**:

```orbitscore
var seq = init global.seq
  .length(1)         // 1. ループ長
  .audio("file.wav") // 2. 音声ファイル
  .chop(4)           // 3. 分割
  .play(1, 2, 3, 4)  // 4. リズムパターン
  .gain(0)           // 5. 音量（オプション）
  .pan(0)            // 6. ステレオ位置（オプション）
```

## Important Concepts（重要な概念）

### 7. play()の数値の意味

```orbitscore
seq.chop(4)           // 4つのスライス: 1, 2, 3, 4
seq.play(1, 2, 3, 4)  // 各拍でスライス1→2→3→4を再生

seq.play(1, 0, 1, 0)  // 1拍目と3拍目にスライス1、他は休符
seq.play(1, 1, 1, 1)  // 全拍でスライス1を再生
seq.play(4, 3, 2, 1)  // 逆順で再生
```

**ルール**:
- `0` = 休符（silence）
- `1` ～ `n` = スライス番号（`chop(n)`で分割）
- 同じスライスを複数回使用可能
- 任意の順序で再生可能

### 8. global.audioPath()の動作

**実装**:
- `global.audioPath(path)`でベースパスを設定
- `sequence.audio()`で相対パスを使用すると、自動的に`path.join(audioPath, filepath)`が実行される
- 絶対パスの場合は`audioPath`は無視される

**例**:

```orbitscore
global.audioPath("/Users/you/audio")

// これらは同じファイルを指す
seq.audio("kick.wav")
seq.audio("/Users/you/audio/kick.wav")
```

## Testing Patterns（テストパターン）

### 基本的なキックドラム

```orbitscore
var global = init GLOBAL
global.tempo(120)
global.beat(4)
global.tick(4)
global.audioPath("/path/to/audio")

var kick = init global.seq
kick.length(1)
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 0, 0)

global.run()  // 必須
kick.run()
```

### アルペジオの分割再生

```orbitscore
var global = init GLOBAL
global.tempo(120)
global.beat(4)
global.tick(4)
global.audioPath("/path/to/audio")

var arp = init global.seq
arp.length(1)
arp.audio("arpeggio.wav").chop(4)
arp.play(1, 2, 3, 4)

global.run()
arp.run()
```

### 複数トラック

```orbitscore
var global = init GLOBAL
global.tempo(120)
global.beat(4)
global.tick(4)
global.audioPath("/path/to/audio")

var kick = init global.seq
kick.length(1).audio("kick.wav").chop(1).play(1, 0, 0, 0)

var snare = init global.seq
snare.length(1).audio("snare.wav").chop(1).play(0, 0, 1, 0)

var hihat = init global.seq
hihat.length(1).audio("hihat.wav").chop(1).play(1, 1, 1, 1)

global.run()
kick.run()
snare.run()
hihat.run()
```

## Debugging Tips（デバッグのヒント）

### 1. 音が出ない場合のチェックリスト

1. ✅ `global.run()`を呼んだか？
2. ✅ 音声ファイルが存在するか？（`ls -la /path/to/file.wav`）
3. ✅ audioPath()が正しく設定されているか？
4. ✅ オーディオデバイスの音量は上がっているか？
5. ✅ SuperColliderサーバーが起動しているか？

### 2. デバッグモードでの実行

```bash
# 詳細ログを表示
DEBUG=orbitscore:* node dist/cli-audio.js play file.osc 10
```

### 3. エラーメッセージの確認

よくあるエラーメッセージ：

- `⚠️ scheduler not running` → `global.run()`を追加
- `File could not be opened` → パスを確認
- `Server failed to start` → `killall scsynth`してから再実行

## Reference

- 完全なDSL仕様: `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- ユーザーマニュアル: `docs/USER_MANUAL.md`
- サンプル集: `examples/`