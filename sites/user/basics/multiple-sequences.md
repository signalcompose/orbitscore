---
title: 複数のシーケンス
description: kick・snare・hi-hat など複数のシーケンスを同時に鳴らす方法を解説します
---

# 複数のシーケンス

[パターンを作る](./patterns.md) では 1 つのシーケンスにキックを割り当てて動かしました。実際のビートは、キック・スネア・ハイハットといった複数の音を同時に鳴らすことで成立します。この章では、複数のシーケンスを並行して動かし、グループとして制御する方法を解説します。

## 複数のシーケンスを作る

シーケンスは `var <名前> = init global.seq` で何個でも作れます。それぞれに別の音声ファイルとリズムパターンを設定します。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 0, 0)  // 1 拍目だけ

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 0, 1, 0)  // 3 拍目だけ

var hihat = init global.seq
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1)  // 4 拍すべて

LOOP(kick, snare, hihat)
```

これで kick・snare・hihat の 3 つが同時にループします。

## LOOP でループ再生グループを作る

`LOOP()` は **片記号方式（Unidirectional Toggle）** で動作します。`LOOP()` に渡したシーケンスだけがループグループに入り、渡さなかったシーケンスは自動的にグループから外れて停止します。

```text
LOOP(kick, snare, hihat)   // 3 つ全てループ
LOOP(kick, snare)          // kick と snare だけ残る、hihat は停止
LOOP(kick)                 // kick だけ残る、snare も停止
LOOP()                     // 全て停止
```

「特定のシーケンスを止めたい」と思ったら、止めたいシーケンスを外した状態で `LOOP()` を書き直して実行するだけです。別途 `STOP` コマンドを書く必要はありません。

## RUN でワンショット再生する

`RUN()` は、指定したシーケンスを 1 回だけ再生します。ループはしません。

```text
RUN(kick, snare, hihat)   // 3 つを 1 回ずつ再生
```

`LOOP()` と `RUN()` は独立して動作します。同じシーケンスを両方に含めることもできます。

```text
LOOP(kick, snare)   // kick と snare はループ
RUN(hihat)          // hihat はこの時点で 1 回だけ鳴らす
```

## MUTE で個別に消音する

`MUTE()` は、指定したシーケンスのミュートフラグを ON にします。ループは継続しますが、音が出なくなります。

```text
LOOP(kick, snare, hihat)   // 3 つ全てループ
MUTE(hihat)                // hihat は音が出なくなる（ループは続いている）
```

`MUTE()` を別のシーケンスで書き直すと、前のミュートが解除されます。

```text
MUTE(kick)    // kick をミュート、hihat のミュートは自動的に解除される
MUTE()        // 全てのミュートを解除（引数なし）
```

::: info MUTE は LOOP にのみ影響します
ミュートフラグは `LOOP` グループに対してのみ作用します。`RUN()` で再生する場合はミュートの影響を受けず、`MUTE` 中のシーケンスでも `RUN()` では音が出ます。
:::

## 実践例: 基本的なドラムビート

以下は kick・snare・hihat を使った典型的な 4/4 ビートです。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 0, 0)  // 1 拍目

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 0, 1, 0)  // 3 拍目

var hihat = init global.seq
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1)  // 4 分音符で刻む

LOOP(kick, snare, hihat)
```

これを実行したら、次のように少しずつ変えてみてください。

- `kick.play(1, 0, 1, 0)` に変えて 3 拍目にも kick を追加
- `hihat.play(1, 1, 1, 1, 1, 1, 1, 1)` に変えて 8 分音符刻みにする
- `MUTE(hihat)` を実行してハイハットだけを消す

変更後は、変えた行を選択して `Cmd+Enter`（Windows / Linux の場合は `Ctrl+Enter`）で反映できます。

## 2 小節パターンを組み合わせる

シーケンスごとに `length()` で異なる長さを設定できます。kick は 1 小節ループ、snare だけ 2 小節パターンにする、といった組み合わせが可能です。

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.length(1)
kick.play(1, 0, 1, 0)  // 1 小節パターン

var snare = init global.seq
snare.audio("snare.wav")
snare.length(2)
snare.play(
  0, 0, 1, 0,       // 1 小節目
  0, 0, 1, (1, 1),  // 2 小節目（フィルあり）
)

LOOP(kick, snare)
```

## まとめ

- `var <名前> = init global.seq` を複数書いて、シーケンスを好きな数だけ作れる
- `LOOP(seq1, seq2, ...)` で複数のシーケンスを同時にループ再生する
- `LOOP()` に渡さなかったシーケンスはグループから外れて自動的に停止する
- `RUN(seq1, ...)` でワンショット再生（ループしない）
- `MUTE(seq1, ...)` でループ中の特定シーケンスを消音する（LOOP にのみ影響）

次は OrbitScore の特徴である、異なる拍子やテンポを同時に走らせる「ポリメーター・ポリリズム」を試してみましょう。

→ [ポリメーター・ポリリズム](./polyrhythm.md)
