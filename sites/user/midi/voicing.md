---
title: ボイシングと voice leading
description: コードの配置を変えるボイシング演算子、ランダム要素の追加、滑らかな声部進行（voicelead）、コンピングリズム（comp）の使い方を説明します
---

# ボイシングと voice leading

コードを書いただけでは声部がすべて密集した配置になります。ボイシング演算子を使うと、ドロップ 2 や転回など一般的な和音の配置を DSL で表現できます。さらに `.voicelead()` で声部の動きを滑らかにし、`.comp()` でジャズコンプのリズムを付けられます。

---

## ボイシング演算子

ボイシング演算子はコード値（`[ ]`）に対してメソッドチェーンで使います。演算は**評価時・決定論的**です。実行ごとに変わることはありません。

```text
import chords

var piano = init global.seq
piano.midi("IAC", 1)
piano.octave(4)
piano.length(1)

piano.play(
  [1, 3, 5, 7].drop(2),      // ドロップ 2（上から 2 番目の声部を 1 オクターブ下げる）
  [1, 3, 5, 7].drop(2, 4),   // ドロップ 2&4
  [1, 3, 5, 7].invert(2),    // 下から 2 つの声部を 1 オクターブ上げる（第 2 転回）
  maj7.open(),               // オープンポジション
)
```

### 演算子一覧

| 書き方 | 効果 |
|---|---|
| `.drop(n)` | 上から N 番目の声部を 1 オクターブ下げる（ドロップ 2 など） |
| `.drop(n, m)` | 複数の声部をドロップ（ドロップ 2&4） |
| `.invert(n)` | 下から N 声部を 1 オクターブ上げる（転回） |
| `.open()` | クローズ→上から 2 番目の声部を 1 オクターブ下げる（Drop 2／オープンポジション） |
| `.close()` | クローズポジション |
| `.shell()` | ルート + 3度 + 7度のみ（5 度省略シェルボイシング） |
| `.rootless()` | ルート（1 度）を除く |

::: tip 「上から N 番目」の数え方
声部は書いた順で上から数えます。`[1, 3, 5, 7]` の場合、位置 1 = 7 度、位置 2 = 5 度、位置 3 = 3 度、位置 4 = 1 度です（記譜上の降順）。
:::

---

## ランダム要素

DSL には 3 種類のランダムが用意されています。いずれもループのたびに**サイクルごとに再ロール**されます（毎回変化します）。

### `Xr` — その音を出すかどうかをランダムに決める

```text
piano.play(1, 3r, 5, 8)   // 3 度は約 50% の確率で鳴る
```

### `.r` — コードの声部を間引く（コードシニング）

```text
piano.play([1, 3, 5, 7].r)   // 各声部が約 50% の確率で鳴る
                              // 全消しもあり得る（最低声部数は保証されない）
```

### `^r` — ランダムオクターブ（-1/0/+1 oct）

```text
piano.play(1, 3, 5^r, 8)    // 5 度だけ毎サイクル -1/0/+1 オクターブのいずれかにランダムシフト（0 = 移動なし）
```

::: info 再現性について
`.orbslog`（セッションログ）は実行の記録を残しますが、再生時にランダムは再ロールされます（シード固定なし）。2.0.0 ではセッションログは既定 off（opt-in: `ORBITSCORE_SESSION_LOG=1`）です。
:::

---

## `.voicelead()` — 自動声部進行

連続するコードスタック間で、声部の動きが最小になるようにオクターブ配置を調整します。

```text
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)

lead.play(([1, 3, 5], [5, 7, 2], [6, 8, 3], [4, 6, 8]).voicelead())
// 各コードの声部が大きく跳躍せず、近い音に滑らかに進む

LOOP(lead)
```

`seq.voicelead()` でシーケンス全体にデフォルト適用することもできます（エイリアス: `seq.vl()`）。

```text
lead.voicelead()
lead.play([1, 3, 5], [5, 7, 2])   // 自動的に voice lead される
```

**動作の特徴**:
- 決定論的（サイクルごとに変わらない）。初回実行時に一度計算されます
- 最初のコードは書いた配置のまま残ります。2 番目以降のコードが近い方向へ移動します
- 声部の音名（ピッチクラス）は変えません。オクターブの選択だけを変えます
- 声部数が違うコード間では可能な範囲で進行させます

---

## `.comp()` — コンピングリズム

`.comp()` は各コードを「コンプセル（comping cell）」と呼ぶリズムパターンに展開します。コードをコード進行のように渡すと、1 コード = 1 小節として展開します。

```text
var piano = init global.seq
piano.midi("IAC", 2)
piano.octave(4)
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2])
// 2 コード → 2 小節（length は自動的に 2 に設定される）
```

### セルの種類

| セル名 | リズムの特徴 |
|---|---|
| `"charleston"` | チャールストン（デフォルト）。8 スロット分割の典型的なカラコン刻み |
| `"quarters"` | 4 分音符ベース |
| `"twofour"` | 2・4 拍ベース |
| `"redgarland"` | レッド・ガーランド風 |
| `"offbeats"` | 裏拍中心 |

デフォルトは `"charleston"` です。セルを省略した場合もチャールストンが使われます。

```text
piano.comp([1, 3, 5])              // デフォルト（charleston）
piano.cell("quarters").comp([1, 3, 5])   // quarters セル
```

### density() — 密度でランダムコンプ

セルを使わずに、8 分音符グリッドに指定した密度でオンセットを置くこともできます。

```text
piano.density(0.6).comp([1, 3, 5])   // 約 60% の 8 分音符にアタックを置く
piano.density(0)                      // 全消し（laying out 状態）
```

### .voicelead() との組み合わせ

`.comp()` と `.voicelead()` は組み合わせて使えます。

```text
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2]).voicelead()
```

---

## 完全な例

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")

import chords

// voice lead 付きコード進行
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)
lead.play(([1, 3, 5], [5, 7, 2], [6, 8, 3], [4, 6, 8]).voicelead())

// charleston コンプ（2 小節）
var piano = init global.seq
piano.midi("IAC", 2)
piano.octave(4)
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2])

global.start()
RUN(lead, piano)
```

---

## 次のページ

- Ableton Live への音声出力（LinkAudio） → [LinkAudio](./link-audio.md)
- メソッド一覧 → [リファレンス](../reference/methods.md)
