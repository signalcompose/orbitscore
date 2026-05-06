---
title: オーディオ操作
description: chop でオーディオファイルをスライスし、音量・パンで音の質感を整える方法を解説します
---

# オーディオ操作

ここまでの章では、オーディオファイルを丸ごと 1 つのサンプルとして鳴らしてきました。OrbitScore には、そのファイルをさらに細かく切り分けて使ったり、音量や左右の定位（パン）を調整したりする機能があります。この章では、そうした操作をまとめて解説します。

## chop — オーディオファイルをスライスに切る

`chop(N)` は、読み込んだオーディオファイルを **N 個の均等なスライス**に分割するメソッドです。たとえばコード進行やアルペジオが入った 1 つの WAV ファイルを切り分けて、好きな順番で並べ直せます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var arp = init global.seq
arp.audio("arpeggio.wav").chop(8)
arp.play(1, 2, 3, 4, 5, 6, 7, 8)

LOOP(arp)
```

上のコードは `arpeggio.wav` を 8 等分し、先頭から順番に 1→2→3→…→8 と再生します。

### play() でスライス番号を指定する

`play()` の引数にスライス番号を並べることで、再生する順番を自由に決められます。

```text
// 偶数スライスだけを選ぶ
arp.play(2, 4, 6, 8)

// 逆順で再生する
arp.play(8, 7, 6, 5, 4, 3, 2, 1)

// 好きな並び替え
arp.play(3, 1, 4, 6, 2, 7)
```

スライス番号は `chop(N)` で指定した N の範囲（1 〜 N）で指定してください。

### 0 は休符

`play()` の引数に **0** を書くと、その拍は無音になります。

```text
var drum = init global.seq
drum.audio("break.wav").chop(4)

// スライス 1 → 休符 → スライス 2 → スライス 3
drum.play(1, 0, 2, 3)
```

これを使うと、フレーズの途中に「間」を入れることができます。

### chop(1) — 分割しない場合

`chop(1)` と書くと、ファイルを分割せずに「1 つのスライス全体」として使います。通常のキックやスネアのような短いワンショットサンプルには `chop(1)` が適しています。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)

LOOP(kick)
```

---

## length() — パターン全体の長さを変える

`length(N)` はシーケンスが 1 ループに使う小節数を指定します。この値を変えると、各スライスの再生時間が変わるため、タイムストレッチに近い効果が得られます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var phrase = init global.seq
phrase.audio("phrase.wav").chop(4)
phrase.play(1, 2, 3, 4)

phrase.length(1)   // 1 小節で 4 スライスを再生
phrase.length(2)   // 2 小節で 4 スライスを再生（ゆっくり）
phrase.length(4)   // 4 小節で 4 スライスを再生（さらにゆっくり）

LOOP(phrase)
```

::: warning 音程が変わります
`length()` は再生速度を変えるため、音程も連動して変わります。`length(2)` にすると約 1 オクターブ低く聞こえます。これはバグではなく仕様です。意図的に音程の変化を利用した表現もできます。
:::

---

## gain() — 音量を調整する

`gain(dB)` で、そのシーケンスの音量を **dB（デシベル）** 単位で調整します。dB（デシベル）は音の大きさを表す単位で、0 が基準、負の値にすると小さく、正の値にすると大きくなります。

| 値 | 効果 |
|---|---|
| `0` | デフォルト（基準音量） |
| `6` | 約 2 倍の音量感（+6 dB） |
| `-6` | 約半分の音量感（-6 dB） |
| `-60` | ほぼ無音 |

設定できる範囲は -60 dB 〜 +12 dB です。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)
kick.gain(-3)   // 少し小さめに

var snare = init global.seq
snare.audio("snare.wav").chop(1)
snare.play(0, 1, 0, 1)
snare.gain(0)   // デフォルトのまま

LOOP(kick, snare)
```

`gain()` はライブコーディング中でも即時反映されます。演奏しながらリアルタイムに音量バランスを調整できます。

---

## pan() — ステレオの左右位置を調整する

`pan(value)` は音の左右の位置（ステレオパン）を -100〜100 の範囲で指定します。パンとは「パノラマ」の略で、左右のスピーカーの音量バランスのことです。

| 値 | 位置 |
|---|---|
| `-100` | 完全に左 |
| `-50` | やや左 |
| `0` | 中央（デフォルト） |
| `50` | やや右 |
| `100` | 完全に右 |

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var hi_l = init global.seq
hi_l.audio("hihat_open.wav").chop(1)
hi_l.play(1, 0, 1, 0)
hi_l.pan(-60)   // 左寄り

var hi_r = init global.seq
hi_r.audio("hihat_closed.wav").chop(1)
hi_r.play(0, 1, 0, 1)
hi_r.pan(60)    // 右寄り

LOOP(hi_l, hi_r)
```

`pan()` も `gain()` と同様、ライブコーディング中に即時反映されます。

---

## メソッドチェーンで書く

OrbitScore のメソッドはチェーン（`.` で繋げる書き方）が使えます。設定が 1 行にまとまり、ライブコーディング中にも素早く書けます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// 複数行版
var drum = init global.seq
drum.audio("break.wav")
drum.chop(8)
drum.play(1, 3, 5, 7, 2, 4, 6, 8)
drum.gain(-6)
drum.pan(-20)

// チェーン版（同じ意味）
var drum2 = init global.seq
drum2.audio("break.wav").chop(8).play(1, 3, 5, 7, 2, 4, 6, 8).gain(-6).pan(-20)

LOOP(drum)
```

長いチェーンは改行してインデントすると読みやすくなります。

```text
var arp = init global.seq
arp
  .audio("arpeggio.wav")
  .chop(8)
  .play(1, 2, 3, 4, 5, 6, 7, 8)
  .gain(-3)
  .pan(0)
```

`init global.seq` の直後にチェーンを続けることもできます。

```text
var snare = init global.seq
  .length(1)
  .audio("snare.wav")
  .chop(1)
  .play(0, 1, 0, 1)
  .gain(-3)
  .pan(20)
```

---

## まとめ

この章で扱ったメソッドをまとめます。

| メソッド | 説明 |
|---|---|
| `chop(N)` | オーディオファイルを N 個のスライスに分割する |
| `play(1, 2, …)` | スライス番号で再生順を指定（0 は休符） |
| `length(N)` | ループ長を N 小節に変更（速度・音程が変わる） |
| `gain(dB)` | 音量を dB で調整（0 がデフォルト、即時反映） |
| `pan(value)` | ステレオ位置を -100〜100 で調整（即時反映） |

---

次は、演奏中にコードを書き換えながら音楽を変えていく「ライブコーディング」のワークフローを見てみましょう。

→ [ライブコーディング](./live-coding.md)
