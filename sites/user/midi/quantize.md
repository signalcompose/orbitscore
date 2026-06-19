---
title: Launch Quantize（起動タイミングの制御）
description: global.quantize() と seq.quantize() で LOOP の起動タイミングをグリッドに揃える方法を説明します
---

# Launch Quantize（起動タイミングの制御）

複数のシーケンスをライブコーディングで切り替えるとき、タイミングがバラバラに起動すると音楽的に揃いません。**Launch Quantize** を使うと、`LOOP()` の起動や `play()` の差し替えを次の小節頭まで待機させ、グリッドに揃えることができます。

---

## global.quantize() — グローバル設定

```text
global.quantize("bar")   // デフォルト。次の小節頭まで待機してから起動
global.quantize("beat")  // 1 拍単位でグリッドに揃える
global.quantize("2bar")  // 2 小節ごとに受け付ける
global.quantize("4bar")  // 4 小節ごと
global.quantize("8bar")  // 8 小節ごと
global.quantize("off")   // 即時実行（ライブ感を残したい場合）
```

デフォルトは `"bar"`（1 小節待機）です。Ableton Live の Global Quantization と同じ挙動をイメージすると分かりやすいです。

---

## seq.quantize() — シーケンス個別設定

特定のシーケンスだけ別のタイミングで動かしたいときは `seq.quantize()` を使います。指定のないシーケンスはグローバル設定を継承します。

```text
global.quantize("bar")    // デフォルトは 1 小節待機

var fill = init global.seq
fill.quantize("off")      // このシーケンスだけ即時起動（ドロップ・フィル用）

var chord = init global.seq
chord.quantize("4bar")    // このシーケンスは 4 小節グリッドで起動
```

---

## 影響する操作・しない操作

| 操作 | Quantize の影響 |
|---|---|
| `LOOP()` の新規起動 | ✅ あり（グリッドまで待機） |
| LOOP 中の `play()` 差し替え | ✅ あり（グリッドまで待機） |
| `RUN()` | ❌ なし（**常に即時実行**） |
| LOOP 中の `gain()` / `pan()` | ❌ なし（常に即時反映） |
| LOOP 中の `audio()` / `chop()` | ❌ なし（常に即時反映） |

::: info RUN() は Quantize の影響を受けません
`RUN()` はワンショット（1 回だけ再生）のため、常に即時実行です。fill を即打ちしたいときは `RUN()` を使うとよいでしょう。
:::

---

## 使用例

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.quantize("bar")   // すべて 1 小節グリッドで揃える
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)

// LOOP を起動。次の小節頭でグリッドに揃って始まる
LOOP(kick, snare)

// play() の差し替えも次の小節頭まで待機
kick.play(1, 1, 0, 0)

// フィルだけ即時打ち
RUN(kick)
```

---

## ポリメーターとの組み合わせ

`quantize` のグリッドは「グローバルの `beat()` × `tempo()`」で決まります。`seq.beat(5 by 4)` のように個別の拍子を設定しているシーケンスも、グローバル小節境界を基準として起動します。

---

## 次のページ

- メソッド一覧 → [リファレンス](../reference/methods.md)
- トラブルシューティング → [困ったときは](../troubleshooting.md)
