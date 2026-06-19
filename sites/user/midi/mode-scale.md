---
title: モードとスケール
description: mode() で独自のピッチラティスを定義し、(..).mode(name) でグループに適用する方法を説明します
---

# モードとスケール

OrbitScore では `mode()` を使って任意のスケール（モード）を定義し、`(..).mode(name)` でそのスケールの音だけを使うグループを作れます。

> ⚠️ **2.0.0 時点の仕様 — post-2.0 で見直し予定**
>
> `.root()` などを含む root/key 系のインターフェースは 2.0.0 リリース後に設計が見直される予定です。`mode()` 機能自体は安定していますが、`.root()` との組み合わせについては将来変更が入る可能性があります。

---

## mode() でスケールを定義する

`mode(...)` の引数にはスケールの各音を度数で書きます。

```text
var dorian = mode(1, 2, b3, 4, 5, 6, b7)   // ドリアン スケール
var lydian = mode(1, 2, 3, #4, 5, 6, 7)    // リディアン スケール
var penta  = mode(1, 2, 3, 5, 6)           // ペンタトニック（5 音音階）
```

このモード定義は「トニックからの音程」で書きます。`global.key("C")` なら、ドリアンは C ドリアン（C D Eb F G A Bb）になります。

---

## (..).mode(name) でグループに適用する

`mode()` で定義したモードを `(..).mode(name)` 形式でグループに適用します。

```text
var global = init GLOBAL
global.tempo(110)
global.beat(4 by 4)
global.key("C")
global.start()

var dorian = mode(1, 2, b3, 4, 5, 6, b7)

var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)
lead.play((1, 3, 5, 7, 8, 7, 5, 3).mode(dorian))
// C Dorian で: C Eb G Bb C Bb G Eb

LOOP(lead)
```

`.mode()` グループ内の「度数 1」はそのモードの 1 番目の音になります。モードのラティス（音の並び）でインデックスされるため、グループの外（`global.key()` の基準スケール）とは別の解釈になります。

### カスタム周期（マイクロトーナルなど）

スケールの音程範囲（デフォルトはそのスケールの最高音より上の次のオクターブ境界）を明示的に設定できます。

```text
var custom = mode(1, 2, b3, 4, #5, 6, 7, 9).period(19)   // 19 セミトーン周期
```

---

## .root() でグループのルートを指定する

グループに `.root()` を付けると、そのグループのルート（根音）を変えられます。`seq.root()` でシーケンスデフォルトのルートも設定できます。

> ⚠️ **2.0.0 時点の仕様 — post-2.0 で見直し予定**
>
> `.root()` インターフェースは 2.0.0 リリース後に設計が見直される予定です（`.root()` の廃止、後置形式への移行などを検討中）。2.0.0 での動作は本ページに記載のとおりです。

```text
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.root(1)         // シーケンスデフォルト = 度数 1（global.key のトニック）

lead.play(
  (1, 3, 5).root(2),    // このグループは度数 2 をルートとして解決
  (1, 3, 5).root(F),    // ノート名 F をルートとして解決（グループレベル限定）
  (1, 3, 5),            // デフォルト（seq.root(1) = トニック C）
  (1, 5).oct(1),        // 同じ形を 1 オクターブ上で演奏
)
```

**注意点**:
- `seq.root()` には**度数のみ**指定できます（ノート名はグループレベルだけ有効）
- `.root()` と `.mode()` を同じグループに両方付けることはできません
- グループに指定のない部分はシーケンスデフォルトにフォールバックします（前のグループの状態を引き継ぎません）

---

## 例：ドリアンとルート移動

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.start()

var dorian = mode(1, 2, b3, 4, 5, 6, b7)

var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.root(1)

// ドリアンモードで 4 グループ、ルートをそれぞれ変えてみる
lead.play(
  (1, 3, 5, 7).mode(dorian),           // C ドリアン
  (1, 3, 5, 7).mode(dorian).root(2),   // D ドリアン
  (1, 3, 5, 7).mode(dorian).root(5),   // G ドリアン
  (1, 3, 5, 7).mode(dorian),           // C ドリアン に戻る
)

LOOP(lead)
```

---

## 次のページ

- voicing 演算子やランダム、voice leading → [ボイシングと voice leading](./voicing.md)
