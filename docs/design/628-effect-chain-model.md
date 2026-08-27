# エフェクトチェーンと DSL — DAW リサーチと設計の論点

**Date**: 2026-08-27 / **Issue**: #628（削除の DSL）・#522（複数 insert）/ **Status**: **確定**（spec SC.10 として制定済み）

> **この文書の役割**: DAW リサーチと、owner との議論で**なぜその形になったか**を残す。
> **確定した意味論の正本は `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.10**、
> **実装設計は `docs/design/628-rack-chain-implementation-design.md`**。

> **前提**: 削除・バイパス・チェーンは **3 つの決定ではなく 1 つのモデル**である（owner 指摘
> 2026-08-27）。DAW を調べると、この 3 つは実際に 1 つのスロット状態モデルとして設計されている。
>
> **参照 DAW は Bitwig と Live に置く**（owner 指定）。固定スロット型（Logic 15 / Cubase 16 /
> Pro Tools 10）は対比の文脈としてのみ扱う。

---

## 1. OrbitScore の現在地（実測）

| | 現状 |
|---|---|
| 1 レシーバあたりの insert 数 | **1**（`maxLength` 既定 1・master / seq / sum / aux すべて上書きなし） |
| daemon のホスティング | **1 bus = 1 child**（`bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>`）・child は `--plugin` 1 つ |
| 直列で組める段数 | **実質 2 段**（per-seq insert → sum bus insert）。sum のネストは v1 不可 |
| 差し替え | #625 で実装済み（エンジン再起動なし・窓の間は dry 素通し） |
| 削除 | `remove("名前")`（#625）。行を消して再評価する経路は**未実装** |
| 音色の保持 | 差し替え・削除の**直前に自動保存**され、同じ spec の再宣言で復元 |

🔴 **core spec の記述に誤りがある**: 「チェーンは将来拡張（エンジン内部は順序付きリストで
実装済み・DSL 側のガード解放のみ）」— 順序付きリストが実装済みなのは **TS 側の帳簿だけ**で、
daemon は 1 bus 1 child。**ガードを外しても持てない。**

---

## 2. DAW は何をしているか

### 2.1 insert 数の上限 — 二派に割れている

| DAW | 1 トラックあたり |
|---|---|
| **REAPER** | 無制限 |
| **Ableton Live** | 無制限 |
| **Bitwig** | 無制限 |
| Cubase | 16 |
| Logic Pro | 15（+ MIDI プラグイン 8） |
| Pro Tools | 10 |

固定スロット型は**ミキサーストリップという UI と固定サイズの DSP グラフ**を前提にした設計。
Live / Bitwig / REAPER は動的なチェーンなので上限がない。

**OrbitScore にミキサーストリップの制約は無い。** owner の「CPU が許す限り無限」は
Live / Bitwig 側の設計であり、固定スロットを模倣する理由はない。

### 2.2 🔴 スロットの状態は 2 つではなく 4 つ

ここが本論点の核心。DAW は「有る / 無い」ではなく、**資源とレイテンシの解放度で段階を分けて
いる**。

| 状態 | プラグイン | 設定 | CPU | メモリ | レイテンシ |
|---|---|---|---|---|---|
| **空スロット** | 無し | — | 0 | 0 | 0 |
| **有効** | ロード済み | 保持 | 使う | 使う | 有り |
| **バイパス / オフ** | ロード済み | 保持 | 一部〜0 | **使う** | **有り** |
| **無効化（deactivate）** | **アンロード** | **保持** | 0 | 0 | 0 |

**Live と Bitwig でここが違う**:

- **Live**: デバイスをオフにすると **CPU は解放されるが、メモリとレイテンシは残る**
- **Bitwig**: deactivate すると **CPU・メモリ・レイテンシがすべて解放**され、それでいて
  設定は保持され再有効化できる

### 2.3 🔴 OrbitScore は既に Bitwig の deactivate を持っている（宣言の形で）

#625 の実装は「差し替え・削除の**直前に旧 insert の state を自動保存**し、同じ spec を
再宣言すれば復元する」。これは **Bitwig の deactivate と同じ意味論**を、宣言的に達成している。

**足りないのは機構ではなく語彙である。** 「いま無効化したい」「戻したい」を DSL でどう言うかが
決まっていない。

### 2.4 順序は音そのもの

プラグインは insert チェーンに現れた順に処理される。EQ → Compressor と Compressor → EQ は
別の音になる。すべての DAW がミキサーの insert スロットを**上から下へ**流す。

→ **空スロットが位置を保つかどうかは、音に関わる**。詰めてしまうと埋め直した時に順序が変わる。

### 2.5 コンテナ — 直列と並列は別のものとして持つ

- **Live の Audio Effect Rack**: 各 chain が**同じ入力を同時に受け**、それぞれ内部で直列処理し、
  出力を合算する。**Rack は Rack を入れ子にできる**
- **Bitwig**: **FX Layer = 並列**（全レイヤーを同時に通る）/ **Chain = 直列**（1 つずつ順に通る）
  という別デバイスとして提供

つまり「チェーン」は単なる配列ではなく、**直列と並列を入れ子にできる木**である。

### 2.6 レイテンシは段数で積み上がる

PDC（Plugin Delay Compensation）は各トラックの報告レイテンシの最大値を取り、他を遅らせて
揃える。**1 つのチェーンが長いと、プロジェクト全体がその分遅れる。**

OrbitScore は **v1 で PDC を持たない**（core spec 明記）。out-of-process なので **1 段ごとに
shm 往復が入る**。段数を増やす設計はレイテンシの設計と不可分。

### 2.7 🔴 out-of-process ホスティング — Bitwig が隔離度を「設定可能な軸」にしている

OrbitScore と同じくプラグインを別プロセスでホストする Bitwig は、**5 段階**を用意している。

| モード | 内容 |
|---|---|
| Within Bitwig | audio engine と同居 |
| **Together** | 全プラグインを 1 つの別プロセスに同居 |
| By manufacturer | メーカー単位でグループ化 |
| By plug-in | 同一プラグインのインスタンスをグループ化 |
| **Individually** | 1 インスタンス = 1 プロセス |

公式ガイド:

> those on the left potentially using **less RAM** and those toward the right offering **greater safety**
> （Individually）"This will require **more computing resources**, but that is the trade-off"
> （By plug-in）"may **save a significant amount of computing resources**"

**OrbitScore の現状は右端の Individually**（`1 slot = 1 shm = 1 child`）— 最も高価なモードを、
選択の余地なく採っている。

---

## 3. ライブコーディング言語は何をしているか（対比）

| 言語 | エフェクトの表現 |
|---|---|
| **Sonic Pi** | `with_fx :reverb do ... end` の**入れ子ブロック**。内側の出力が外側へ流れる |
| **TidalCycles** | `d1 $ s "bd" # room 0.5 # crush 4` — **パターンの名前付きパラメータ**として付ける |

Sonic Pi の入れ子は Live/Bitwig のコンテナに似ているが、**スコープが時間的**（ブロック内の
コードだけが効果を受ける）。Tidal はエフェクトを**永続的なインスタンスとして持たない** —
イベントごとのパラメータであり、スロットも順序の概念も表面に出ない。

> ⚠️ Tidal の内部的な順序の扱いは、公式リファレンスからは確認できなかった。断定しない。

**OrbitScore はどちらでもない。** プラグインは**永続的でステートフルで、別プロセスにいる**。
音色を保存し復元し、UI を開き、差し替える。この性質は Tidal より **DAW に近い**。

→ **DSL の表面はライブコーディング的でよいが、下のモデルは DAW 的でなければ辻褄が合わない。**

---

## 4. 統合モデルとしての DSL（論点）

DAW の 4 状態を OrbitScore の宣言的表面へ写すと、こうなる。

| DAW の状態 | OrbitScore で言いたいこと | 候補の表面 | 現状 |
|---|---|---|---|
| 有効 | 挿す / 差し替える | `effect("X")` | ✅ #625 |
| **バイパス**（Live のオフ） | ロードしたまま音だけ外す | `effect("X", enabled: false)` | ❌ 未実装（spec 規範6 に概念あり） |
| **無効化**（Bitwig の deactivate） | アンロードするが音色は保つ | ? | ⚠️ **機構は #625 で実装済み・語彙が無い** |
| 空スロット | 位置は保つが何も無い | `effect("")`（owner 案） | ❌ 未実装 |
| 除去 | スロットごと無くす | 行を消して再評価（規範4） | ❌ 引き金が未実装 |

### 4.1 owner 案 `effect("")` の位置づけ

```js
cb.effect("TAL-Reverb-4")   // 挿す
cb.effect("ValhallaRoom")   // 差し替え（後勝ち）
cb.effect("")               // 空にする ← 同じ動詞・同じ後勝ち
```

**利点**（議論で確認済み）:

- `evaluate_orbitscore`（文書の概念が無い経路）でも動く
- 主語集合や空行の定義に依存しない → 評価単位の議論と切り離せる
- 選択の仕方で振る舞いが変わらない
- **今刺さっているものの名前を知らなくてよい**（`remove("名前")` との差）
- 空文字は**現在完全に空いている**（`normalizeCatalogKey` に一致するカタログ名は実在しない）

**未確定**: 空には名前が無いので、**チェーンの中でどのスロットを指すのか**。
議論では「評価された列の中での位置」で識別する案が出た（規範1 の「チェーンと行分割は同一の
評価列」に沿う）。

### 4.2 累積か宣言か（決着済み）

実装を読んだ結果、**現在は累積モデル**である。`play` の行を消して再評価してもパターンは残る。
`init` の再評価で `gain` / `pan` **だけ**が既定へ戻る（中途半端に宣言的）。

宣言的モデル（書いてある通りになる）は owner の直観に合うが、**同じレシーバの宣言が文書内で
離れている時に破壊的**になる。owner 判断で **累積のまま**とし、削除は明示的な表面で行う。

---

## 5. 複数 insert をどう実現するか

| 案 | 内容 | Bitwig との対応 | 代償 |
|---|---|---|---|
| **A** | 1 bus に **N child を直列** | Individually のまま | **shm 往復が段数に比例**。無限チェーンと相性が悪い |
| **B** | **1 child が N プラグインをホスト** | **Together / By plug-in 相当** | child プロトコルの改造（index 別の load/unload/replace/state/UI） |
| **C** | N 本の bus を routing で連結 | — | bus プール消費。無限化と正反対 |

**B を推す根拠**（私見）: Bitwig が「グループ化は計算資源を大きく節約する」と明言しており、
同じ OOP 構造を持つ実装での実績がある。shm 往復が段数に比例しないのは、無限チェーンを
掲げる以上ほぼ必須。

**B の含意**: #625 で作った差し替え機構を **index 単位へ一般化**する作業が付いてくる。
また B の形にしておけば、後から Bitwig の Individually 相当（隔離を上げる）へ倒せる。

---

## 6. 確定したモデル（2026-08-27）

```js
kick.effect([
  "FabFilter Pro-C 2",
  plugin("FabFilter Pro-Q 3", enabled: false),
  layer([
    [],
    ["ValhallaRoom", gain(db: -10)],
  ]),
  "FabFilter Pro-L 2",
])
```

| 語 | 意味 |
|---|---|
| `[...]` | 直列チェーン（どこでも同じ意味）。`chain(...)` の糖衣 |
| `"名前"` | プラグイン（既定値）。`plugin(...)` の糖衣 |
| `layer([...])` | 並列。effect / instrument で同じ語 |
| `plugin("名前", ...)` | 引数が要る時の完全形。**形式は書かない**（CAP.6-1） |
| `gain(db:)` | チェーンの要素。child を起こさないのでレイテンシもプロセスも増えない |
| `enabled: false` | **その合成の単位元になる**（直列 = 素通し / 並列 = 無音） |

- **削除は配列から消す**。`remove()` は撤回・`effect("")` は不要
- **後勝ち**。生き残りは **LCS** で対応づけ、**出現順はインスタンスに固定**
- **ラックは値（レシピ）**。宣言だけではプラグインを起こさない・適用先ごとに別インスタンス
- **機構は B**（1 child が N プラグイン）
- **`layer` の実装は PDC とセットで後続**。記法は今回確定

## 7. 議論の途中で覆った判断（記録）

設計の質はここに出るので、**誰の主張が何によって覆されたか**を残す。

| 当初の立場 | 覆した根拠 | 結論 |
|---|---|---|
| main「宣言的モデルは危険（宣言が散らばると破壊的）」 | owner の**配列案**が「散らばり」の前提を外した。加えて **UI が無い**環境では隠れた蓄積状態の方が危険 | 配列 = 完全な像。宣言的が成立 |
| main「文字列形の方が短くて読める」 | 実名で数えたら**メソッド形の方が短い**（`FabFilterProQ3` 14 文字 < `"FabFilter Pro-Q 3"` 19 文字） | 思い込みだった。最終的には**裸の文字列**で両方不要に |
| main「`[...]` がエフェクトで直列・instrument で並列になるのは危険」 | `layer` / `chain` を**関数名が意味を運ぶ**形にすれば、`[...]` は意味を持たない | 懸念は解消 |
| owner「`vst("名前")` / `clap("名前")` が分かりやすい」 | **CAP.6-1**「プラグイン形式は利用者に見えてはならない」。#552 で process-global な形式指定を捨てて per-plugin 解決へ揃えた実績がある | `plugin("名前")` に。形式は書かない |
| main「木にすると同一性が足りない」 | **木ではなく複数 insert が原因**。平坦なチェーンでも `[A, B, A]` から 1 つ消せば起きる。v1 で見えないのは insert が 1 つで出現順が常に 0 だから | 原因の特定を訂正 |
| main「`as:` で明示的なキーを付ける」 | owner「書き方や名前が増えるのが辛い」→ **LCS + 出現順のインスタンス固定**で構文追加ゼロで解ける | 構文を足さずに解決 |
| main「`selector` を兄弟として見込むべき」 | owner「ラックごとに有効無効を切り替えればいいのでは」→ **`enabled:` が A/B を包含**し、しかも「両方」「どちらも無し」まで書ける | selector 不要 |
| owner「`alias Fx as effect()` でユーザーが別名を作れば良い」 | 値は `var` で足りるので実質「メソッド名の改名」だけ。楽譜が**その人だけのもの**になり、共通語彙という DSL の目的に反する | 言語には入れない。**import 経由**なら性質が変わるので #631 で後日 |

## 8. 派生した issue

| # | 内容 |
|---|---|
| **#630** | **import の実機 E2E がゼロ**（ユニット 22 件・E2E 0 件）。`setDocumentDirectory` の経路に乗っているのに実機未確認 |
| **#631** | ユーザー定義エイリアスを `import` で配る（#630 がブロッカー） |

## Sources

- [REAPER — About（technical）](https://www.reaper.fm/about.php#technical)
- [Ableton Reference Manual — Instrument, Drum and Effect Racks](https://www.ableton.com/en/manual/instrument-drum-and-effect-racks/)
- [Ableton Reference Manual — Computer Audio Resources and Strategies](https://www.ableton.com/en/manual/computer-audio-resources-and-strategies/)
- [Bitwig Userguide — VST Plug-in Handling and Options](https://www.bitwig.com/userguide/latest/vst_plug-in_handling_and_options/)
- [Bitwig — Plug-in Hosting & Crash Protection](https://www.bitwig.com/learnings/plug-in-hosting-crash-protection-in-bitwig-studio-20/)
- [KVR — Bitwig's ability to deactivate tracks and plugins](https://www.kvraudio.com/forum/viewtopic.php?t=537019)
- [Ableton Forum — Does Turning Devices Off Save CPU?](https://forum.ableton.com/viewtopic.php?t=204950)
- [Production Expert — Insert Order And Why It Changes Everything](https://www.production-expert.com/production-expert-1/insert-order-and-why-it-changes-everything)
- [Avid — How to Add Plug-ins in Pro Tools](https://www.avid.com/pro-tools/user-guide/adding-plugins)
- [Steinberg Forums — 16 inserts per track](https://forums.steinberg.net/t/16-inserts-per-track/643801)
- [Logic Pro Help — Going Beyond Logic Pro's 15 Plugin Limit?](https://www.logicprohelp.com/forums/topic/137169-going-beyond-logic-pros-15-plugin-limit/)
- [Sonic Pi Tutorial — 7.1 Adding FX](https://sonic-pi.net/tutorial.html#section-7-1)
- [TidalCycles — Audio Effects reference](https://tidalcycles.org/docs/reference/audio_effects)
- [macProVideo — Understanding Plug-In Delay Compensation](https://www.macprovideo.com/article/recording-and-production/understanding-plug-in-delay-compensation)
