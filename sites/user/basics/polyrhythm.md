---
title: ポリメーター・ポリリズム
description: 異なる拍子やテンポのシーケンスを同時に走らせる OrbitScore の特徴的な機能を紹介します
---

# ポリメーター・ポリリズム

OrbitScore の特徴の一つが、異なる拍子やテンポのシーケンスを同時に走らせられる点です。この章では「ポリメーター」「ポリリズム」「ポリテンポ」という 3 つの概念を紹介します。

## 3 つの概念を整理する

| 概念 | 意味 |
|---|---|
| ポリメーター | 異なる拍子（4/4 と 5/4 など）のパターンを同時に走らせる |
| ポリリズム | 同じ時間の中で異なる分割数のリズムを重ねる（3 対 4 など）|
| ポリテンポ | 異なる BPM のシーケンスを同時に走らせる |

3 つとも「ずれていくリズムの面白さ」を生み出す仕組みです。どれも OrbitScore の DSL では数行で書けます。

## ポリメーター: 異なる拍子を同時に走らせる

各シーケンスに `beat()` で個別の拍子を設定すると、グローバルの拍子とは独立して動きます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// 4/4 のキック
var kick = init global.seq
kick.audio("kick.wav")
kick.beat(4 by 4)
kick.play(1, 0, 0, 1)  // 1 拍目と 4 拍目

// 5/4 のスネア（4 拍周期と周期がずれていく）
var snare = init global.seq
snare.audio("snare.wav")
snare.beat(5 by 4)
snare.play(0, 0, 1, 0, 1)  // 3 拍目と 5 拍目

LOOP(kick, snare)
```

kick は 4 拍で 1 周、snare は 5 拍で 1 周します。毎周の頭が重なるまでに kick は 5 周、snare は 4 周かかります（4 と 5 の最小公倍数 = 20 拍）。それまでの間、2 つのパターンがじわじわとずれていく独特のグルーヴが生まれます。

3 つの異なる拍子を重ねた例は `examples/03_polymeter_polytempo.orbs` に掲載されています。3/4、4/4、5/4 を同時に走らせると、3 つが揃うのは 60 拍後（3・4・5 の最小公倍数）になります。

## ポリリズム: 同じ時間内で異なる分割数を重ねる

ポリリズムはポリメーターと似ていますが、「同じ長さの区間」を異なる数に等分することで実現します。`play()` のネスト構文で、1 小節の中に 3 連符と 4 連符を同時に走らせることができます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// 1 小節を 3 等分（3 連符的な刻み）
var three = init global.seq
three.audio("hihat.wav")
three.length(1)
three.play((1, 0, 1), (0, 1, 0))  // 1 小節を 2 グループ × 3 分割

// 1 小節を 4 等分（4 分音符刻み）
var four = init global.seq
four.audio("snare.wav")
four.length(1)
four.play(0, 1, 0, 1)  // 2 拍目と 4 拍目

LOOP(three, four)
```

::: info ポリメーターとポリリズムの違い
ポリメーターは「拍子（1 ループの長さ）が違う」、ポリリズムは「1 ループの長さは同じでも中の分割数が違う」という点が異なります。結果として生まれるズレの感覚は似ていますが、仕組みは別です。
:::

## ポリテンポ: 異なるテンポのシーケンスを走らせる

`seq.tempo()` でシーケンスに個別のテンポを設定すると、グローバルのテンポとは独立して動きます。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// グローバルのテンポ（120 BPM）で動く kick
var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

// 半速（60 BPM）のゆっくりしたシーケンス
var slow = init global.seq
slow.tempo(60)  // 個別テンポを指定するとグローバルから独立する
slow.audio("snare.wav")
slow.beat(4 by 4)
slow.length(2)
slow.play(1, 0, 0, 0, 0, 0, 1, 0)

// 倍速（240 BPM）の細かいシーケンス
var fast = init global.seq
fast.tempo(240)
fast.audio("hihat.wav")
fast.beat(4 by 4)
fast.play(1, 0, 1, 0, 1, 0, 1, 0)

LOOP(kick, slow, fast)
```

`seq.tempo()` を呼ぶと、そのシーケンスはグローバルのテンポ変更（`global.tempo()` や `global._tempo()`）の影響を受けなくなります。独自テンポのシーケンスだけは動きが変わらず、グローバルに従うシーケンスだけが変化します。

## まとめ

- `seq.beat(N by 4)` でシーケンスごとに拍子を設定し、ポリメーターを作れる
- `play()` のネストで、同じ長さの区間を異なる数に等分してポリリズムを作れる
- `seq.tempo(BPM)` でシーケンスごとに独立したテンポを設定し、ポリテンポを作れる
- ずれていく周期は「それぞれの数の最小公倍数」拍後に元の位置に戻る

リズムのズレがどう聴こえるかは、ぜひ実際にコードを動かして確認してみてください。数値を 1 つ変えるだけでグルーヴが大きく変わるのが OrbitScore の面白さです。

次は、音声ファイルを切り出したり、音量・パンを調整したりするオーディオ操作を学びましょう。

→ [オーディオ操作](./audio-manipulation.md)
