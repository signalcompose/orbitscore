---
title: 複数ファイルプロジェクト
description: import を使って複数の .orbs ファイルからプロジェクトを組み立てる方法を解説します
---

# 複数ファイルプロジェクト

ここまでの章では、1 つの `.orbs` ファイルに全てを書いてきました。曲が大きくなると、楽器の設定やルーティングを別ファイルに分けて管理したくなります。OrbitScore の `import` を使うと、複数のファイルを組み合わせて 1 つのプロジェクトとして動かせます。

なお、`import` を使わない従来どおりの 1 ファイル運用は、これからもそのまま使えます。`import` はあくまで追加の選択肢です。

## import の構文

`import { 名前, 名前, ... } from "./ファイル.orbs"` の形で書きます。

```text
// mod/drums.orbs
var global = init GLOBAL
var drums = init global.seq
drums.audio("./sine_880.wav")
drums.play(1)
```

```text
// main.orbs
import { drums } from "./mod/drums.orbs"

var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.sum("bus")
global.start()

drums.output("bus")

RUN(drums)
```

`{ }` の中には、import 元ファイルの先頭にある `var` 宣言の名前を書きます。ここで指定した名前が import 元ファイルに存在しない場合はエラーになります。

### import はファイルの先頭に書く

`import` 文は、ファイルの中で最初の（import 以外の）文より前に書く必要があります。

```text
import { drums } from "./mod/drums.orbs"
import { bass } from "./mod/bass.orbs"

var global = init GLOBAL
// ここから通常の記述
```

### パスの書き方

パスは `./` または `../` で始まる相対パスで書きます。基準になるのは **import を書いたファイル自身のディレクトリ**です。絶対パスや、`./` を省略した書き方はできません。拡張子 `.orbs` も省略できません。

## module ファイルの役割 — 宣言専用

`import` される側のファイル（module）は、**宣言専用**として扱われます。シーケンスの設定やルーティングは書けますが、`RUN` / `LOOP` / `MUTE` のような演奏の開始・停止を指示するキーワードは、import されるファイルの中に書くとエラーになります。これらは entry ファイル（実際に開いて実行するファイル）だけが持てる役割です。

```text
// mod/drums.orbs — ここまでは OK
var global = init GLOBAL
var drums = init global.seq
drums.audio("./sine_880.wav")
drums.play(1)

// RUN(drums)   ← module 内に書くとエラー
```

この分離には理由があります。楽器やルーティングは「プロジェクトの構造」として持続させたいものですが、`tempo` の調整やループの ON/OFF といった演奏の操作はライブコーディング中に頻繁に変える「パフォーマンスの操作」です。OrbitScore はこの 2 つの役割を、import される側 / entry 側で分けています。

なお、module ファイルを直接開いて単独で実行する分には、通常どおり `RUN` / `LOOP` も使えます。「import された文脈で実行するとエラー」という点に注意してください。

## audio() のパス基準

module ファイルの中で `audio("./sine_880.wav")` のように相対パスを書いた場合、その基準は **module ファイル自身のディレクトリ**です。entry ファイルの場所には依存しません。これにより、module ファイルはディレクトリを移動しても壊れにくくなっています。

## 名前の一致と再評価

`import` は、名前が一致する宣言を同じインスタンスとして扱います。同じファイルを複数箇所から import しても、二重に初期化されることはありません（循環 import はエラーになります）。ライブコーディング中に entry ファイルを再評価すると、`import` されているファイルも毎回読み直されますが、同じ名前のシーケンスはそのまま同一の演奏中インスタンスとして扱われるため、音が途切れにくくなっています。

異なるファイルで同じ名前を宣言してしまった場合は、後から評価された定義が同じインスタンスに適用されます。この場合の重複を検出する仕組みは、現時点ではまだありません。

---

`import` は sum / aux によるバス構成（[sum と aux/send](../mixing/routing.md)）と組み合わせて、楽器やルーティングをファイルに分けて管理するのに向いています。

::: tip 検証について
本章のコード例は 2026-07-17 の実機 E2E テストで動作確認済みです。
:::
