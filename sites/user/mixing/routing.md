---
title: sum と aux/send
description: 複数のシーケンスをグループバスにまとめたり、send でリターンバスに送ったりする方法を解説します
---

# sum と aux/send

前の章では、1 つのシーケンスにエフェクトを挿す方法を見ました。この章では、複数のシーケンスをまとめて扱う「バス」の仕組みを解説します。OrbitScore には 2 種類のバスがあります。**sum（グループバス）** と **aux（リターンバス）** です。

## sum — シーケンスをグループにまとめる

`global.sum(name)` でグループバスを宣言し、各シーケンスの `output(name)` でそのバスに送ります。

```text
global.sum("drum")

kick.output("drum")
snare.output("drum")
```

グループバスにもエフェクトを挿せます。バスにまとめてから 1 基のコンプレッサーをかける、といった使い方ができます。

```text
sum("bus").effect("GlueComp")
```

エフェクトはチェーン（配列）でも挿せます。複数プラグインの直列接続や `Gain(db: n)` のような標準プラグインの使い方は [エフェクトを挿す](./effects.md) を参照してください。

処理の順番は「シーケンス個別の insert（`seq.effect()`）→ グループバス」です。DAW の「トラック insert → グループトラック」と同じ考え方です。

### sum の制約

- `sum` は 1 段のみで、**ネスト（sum の中に sum）はできません**。
- `output(name)` で指定する名前は、事前に `global.sum(name)` で宣言しておく必要があります。未宣言の名前を指定するとエラーになります。
- `output(name)` で sum バスへ送れるのは **audio シーケンスだけ**です。`seq.midi()` / `seq.instrument()` で作った note シーケンスは、v1 では sum バスへ送れません（詳しくは [プラグイン音源を鳴らす](../plugins/instrument.md) を参照してください）。

## aux / send — 別経路に音を送る

`global.aux(name)` でリターンバスを宣言し、各シーケンスの `send(name, amount)` でそのバスに音を送ります。`send` は元の音をコピーして送る仕組みなので、**元の音自体は消えず、そのまま master（または sum）へ流れ続けます**。

```text
global.aux("rev")
aux("rev").effect("TAL Reverb 4")

kick.send("rev", 0.3)
```

リターンバス（`aux`）には、リバーブのようなエフェクトを挿すのが典型的な使い方です。`send()` の第 2 引数はどれだけの量を送るかを表す値です（0.0〜1.0 が目安で、上限は特に制限されません）。

1 つのシーケンスから複数の `aux` に同時に送ることもできます。

```text
kick.send("rev", 0.3)
kick.send("delay", 0.2)
```

::: warning send() も audio シーケンス専用です
`output()` と同じく、`send()` を使えるのは audio シーケンスだけです。note シーケンス（`seq.midi()` / `seq.instrument()`）では v1 では使えません。
:::

## v1 の正直な制約

この機能はまだ発展途上の部分があります。使う前に知っておいてほしい制約を挙げます。

::: warning PDC（レイテンシ補正）はありません
複数の経路（並列の `sum` や `aux`）にそれぞれ異なるレイテンシを持つエフェクトを挿すと、経路ごとにわずかなタイミングのズレ（位相のズレ）が生じることがあります。OrbitScore は現時点でこのズレを自動補正しません。
:::

::: warning send は post-fader 固定です
`send()` は「シーケンス個別の insert（`seq.effect()`）を適用した後」の音を送る仕様に固定されています（DAW でいう post-fader）。pre-fader（insert 適用前の音を送る）への切り替えは、現在は対応していません。
:::

::: warning LinkAudio との併用はできません
`global.linkAudio()` を使う場合、`sum` / `aux` を含むミキサー機能（プラグインエフェクト全般）とは同時に使えません。両方を宣言すると宣言時点でエラーになります。
:::

---

sum や aux はエフェクト（[エフェクトを挿す](./effects.md)）と組み合わせて使う機能です。次は、複数ファイルでプロジェクトを構成する `import` の使い方を見てみましょう。

→ [複数ファイルプロジェクト](../projects/import.md)
