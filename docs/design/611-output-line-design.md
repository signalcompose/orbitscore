# #611 出口の一般化 — `output(宛先, thru, db)` はライン上の 1 要素

**Issue**: [#611](https://github.com/signalcompose/orbitscore/issues/611)（正本）/ [#649](https://github.com/signalcompose/orbitscore/issues/649)（フェーダー位置・本書が §10-§12 を改稿）/ [#543](https://github.com/signalcompose/orbitscore/issues/543)-a（回帰の固定）/ [#409](https://github.com/signalcompose/orbitscore/issues/409)（`outs:`）/ [#647](https://github.com/signalcompose/orbitscore/issues/647)（マルチティンバー）
**地図**: `docs/planning/DEVELOPMENT_MAP.md` §4.A / §4.A.1 / §4.A.2 / §4.G.1
**起案**: 2026-09-03（Fable）/ **前提コード**: main `ca176f0`（PR #700 マージ後）
**位置づけ**: 設計のみ。実装は `docs/planning/IMPLEMENTATION_PLAN_2026-09.md` の PR-O 系列。

> **粒度の約束**: 本書は「決まっていないところ以外は、そのまま作れる」水準を目指す。
> 型・wire・触る行・呼び出し元の全列挙・失敗モードを書き、決まっていないものは §14 に隔離する。
> 行番号はすべて main `ca176f0` で実読した値。

---

## 0. owner 裁定（2026-09-03・再議論しない）

| # | 裁定 | 本書での扱い |
|---|---|---|
| ① | `thru` の既定は `false` | §2.1 |
| ② | レベルの単位は dB | §2.1 / §2.3 |
| ③ | `output` は aux を指せる | §2.2 |
| ④ | フェーダーは `output` の level で持つ。**ただし `gain` は残す** | §2.4 / §5.4 |
| ⑤ | フラグ名は `thru` | §2.1 |
| A | `send` は糖衣として残す | §2.3 |
| B | `send` も dB に揃える（移行ではなく**実装**） | §2.3 / §9 |
| C | master は `output` の出力先の 1 つ | §2.2 |
| 1 | **解決後の宛先**が同じなら合算 | §2.5 |
| 2 | master は終端ではなく単にアウト先の 1 つ（`output(master, thru: true).output("3,4")`）| §2.2 / §5.6 |
| 3 | デバイスのチャンネル対も宛先（`mix.output(3, 4)` / 省略形 `output("3,4")`）| §2.2 |
| 4 | `outs:` の値は宣言されたノードを一様に受ける（バス / 物理アウト / render）| §5.6（spec 側の着地は **PR-R0**。§11 の改訂表に `outs:` の行は無い）|
| 5 | pre / post fader はオプションにしない。タップの位置がそのまま答え | §2.1 |
| — | #649 確定事項（順序が信号順・フェーダーという段を作らない・`send` はチェーン要素・評価は主語ごとの全行）は不変 | §1 |

**本書が変えないもの**（不変条件）: `play()` の意味論 / RT に確保・ロック・syscall を持ち込まない /
バス無し経路の bit 一致 / `gain_random` は発音側 / lock 順序 pump → mailbox / `EVT_SLOTS = 2`。

---

## 1. 到達点（1 文）

> **オーディオラインは要素の列であり、`output(宛先, thru, db)` もその 1 要素。宛先に特別なものは無い
> （master / sum / aux / render / Link / デバイス ch 対は同じ軸）。フェーダーは出口のレベルであって段ではない。**

#649 §7.6「置いた位置で役割が決まる」がそのまま実装の形になる。DSL のライン要素は次の 3 種だけ:

| 要素 | DSL | 意味 |
|---|---|---|
| **ラック** | `effect([...])` | プラグイン列（SC.10・#628 出荷済み・**変えない**） |
| **ゲイン** | `gain(db)` | その位置以降のライン信号を減衰（線形スカラー・ramp 付き） |
| **出口** | `output(宛先, thru:, db:)` / `send(aux, db)` | その位置の信号を宛先へ加算。`thru: false` ならその先へ流さない |
| **パン** | `pan(value)` | その位置以降のライン信号の L/R バランス（等パワー） |

🔴 **`pan` はライン要素である**（owner 2026-09-03 Q-611-4 = B・§2.4b・§14 (4)）。
起案時は「発音側のまま」としていたが**裁定で覆った**ので、要素は 3 種ではなく **4 種**。
per-event / ランダム pan（`panRandom`）だけが発音側に残る。

---

## 2. DSL 表面（確定分）

### 2.1 `output(dest, thru: bool = false, db: number = 0)`

```orbs
var mix    = init global.mixer
var master = mix.output(1, 2)      // 物理アウト 1-2（SC.2.1・既存）
var cue    = mix.output(3, 4)      // 物理アウト 3-4
var drums  = mix.sum
var verb   = mix.aux

kick.effect(["Comp"]).output(verb, thru: true, db: -12).output(drums)
//                     ^ comp 後の音を verb へ -12 dB で送り、先へも流す   ^ drums へ（ここで終端）
snare.output(verb, thru: true, db: -6).effect(["Comp"]).output(drums)
//    ^ comp **前**の音を verb へ（pre-fader / pre-insert は位置で表現・裁定 5）
drums.effect(["Glue"]).output(master, thru: true).output(cue, db: -20)
//                      ^ master へ出しつつ cue（3-4）にも -20 dB で出す（裁定 2 の形）
```

| 引数 | 型 | 既定 | 意味 |
|---|---|---|---|
| `dest` | ノード変数（`mix.output` / `mix.sum` / `mix.aux` / `mix.render`）/ 文字列（`"drums"` = sum/aux 名 / `"master"` / `"3,4"`）| 必須 | 解決規則は §3.3 |
| `thru:` | boolean | `false`（裁定 ①）| `true` = この出口の**後ろへも信号を流す** |
| `db:` | number | `0` | **その宛先へ行く分だけ**の減衰（裁定 ④）。ラインには影響しない |

**書かない時の既定**: `_line` に `output` が 1 つも無ければ、評価時に暗黙の `output(master, thru: false, db: 0)` を**末尾**に置く
（今日の `BusTarget::Master` 既定と同じ音・§9 の互換要件）。

### 2.2 宛先の集合（裁定 ②③ C 2 3）

| 宛先 | 書き方 | 解決先（TS `OutputDest`）| 備考 |
|---|---|---|---|
| master | `master`（暗黙ノード）/ `"master"` | `{ kind: 'master' }` | 裁定 C。文字列形は今日 LinkAudio 名に落ちる（`sequence.ts:411-412`）→ 本書で予約語に |
| sum / aux | `drums` / `"drums"` | `{ kind: 'bus', bus: 'sum-bus-0' }` | 裁定 ③ で aux も可。`resolveMixerBus`（`global.ts:502-504`）で kind 込みに解決 |
| 物理アウト | `cue`（`mix.output(3, 4)`）/ `"3,4"` / **`mix.output(3)`（mono）** | `{ kind: 'device', channels: [3, 4] }` / `{ kind: 'device', channels: [3] }` | 裁定 3。1 始まり。**mono 宛ては L+R をマージ**（片側を捨てない・owner 2026-09-03 Q-611-5）。マージ係数は `(L + R) * 0.5`（相関信号でクリップしない・§5.3）|
| render | `stems`（`mix.render(...)`）| `{ kind: 'render', id }` | `docs/design/598-render-endpoint-design.md` |
| LinkAudio ch | `"Kick Ch"`（`global.linkAudio()` 時のみ）| `{ kind: 'link', channel }` | 既存の意味を保つ（§3.3 の解決順の**最後**）|

### 2.3 `send(aux, db, enabled:)` = `output(aux, thru: true, db: db)` の糖衣（裁定 A / B）

```orbs
kick.send(verb, -12)          // ≡ kick.output(verb, thru: true, db: -12)
kick.verb(-12)                // SC.4 の aux 名メソッドも同じ（値は dB）
kick.send(verb, -12, enabled: false)   // ≡ db: -Infinity（送らない・要素は残る）
```

- **単位は dB**（裁定 B）。今日の線形 `amount`（MX.3「0.0-1.0 目安」・`process-statement.ts:185-236` の `amount`）は**廃止**。
  `send("rev", 0.3)` は **+0.3 dB** と読まれる（静かに壊れる典型）→ §9 の golden で差分を式で確認する。
- `send` はライン要素であり（#649 §7.2）、`_line` 上では `output` 要素と**同じ型**で持つ（§3.1）。

### 2.4 `gain(db)` はライン要素として残る（裁定 ④）

| | 何を減衰させるか | 実装 |
|---|---|---|
| `seq.gain(db)`（固定値） | **その位置以降のライン全体** | 本書 §5.3 の `LineOp::Gain`（native スカラー・ramp）|
| `seq.gain(random)` | 発音ごとの揺らぎ | **発音側のまま**（`event-scheduler.ts:28-70` `calculateEventGain`・#649 §6.6）|
| `global.gain(db)` | master ライン上の `gain` 要素（#649 §2.4）| §5.6 の master line program。**core の `global_gain` ramp は production から外す**（§5.5）|
| `output(…, db:)` | その宛先へ行く分だけ | `LineOp::Output.gain` |
| `Gain(db:)`（ラック内）| ラック内の位置 | 既存 `orbit-std-gain`（変えない）|

🔴 **`seq.gain(固定)` の適用点が発音側 → ライン上へ移る**（#649 §14 の判断 5「高確度で音が変わる」）。
effect 併用の譜面では今日「ラック前」だったものが**既定位置ではラック後**になる。§9 の golden で差分を明示する。

### 2.4b `pan(value)` もライン要素（owner 2026-09-03 Q-611-4・B）

`seq.pan(固定値)` は**バス上の L/R バランス**として `LineElement { kind: 'pan' }` になり、ラック・`gain` と同じくチェーン上の位置に置ける（instrument にも効く）。
**発音側に残るもの**: `play()` 内の per-event / ランダム pan（`panRandom`・`event-scheduler.ts:39,94`）は**イベント固有**なのでそのまま。
⚠️ 既存 audio 譜面で `seq.pan(x)` を書いているものは、**イベント側の mono 配置 → バス側のステレオ・バランス**へ変わるため bit 一致しない。golden（PR-O0）で `pan` を含む譜面は**再ベースライン**し、その理由を expectations の式に残す（owner が受け入れ済み）。RT: `Pan(p)` op = `buf[L] *= gL(p); buf[R] *= gR(p)`（等パワー・`scheduler.rs` の 2ch 分岐と同じ法則を使い、法則の二重定義を避ける）。

**位置の自由（Q-611-8・owner）**: `gain` / `pan` / 標準プラグイン（`Gain(db:)` 等）はラック内でもライン上でも**好きな位置に置ける**。既定位置（チェーンを書かずに `seq.gain()` だけ呼んだ時）はラック後だが、**DSL の表現を狭める制限は設けない**。

### 2.5 合算の規則（裁定 1）

- **解決後の宛先**（`OutputDest` の同一性: `master` / `bus` 名 / `device` 対 / `render` の**展開後パス** / `link` 名）が同じなら、
  複数のラインからの出口は**加算**される。RT ではもともと加算（`output.rs:957-960`）なので新規機構は無い。
- 同じラインに同じ宛先の `output` を 2 回書いた場合は §14 (3)。

### 2.6 位置と評価（#649 §10 をそのまま採る・変更点のみ）

#649 v3 §10.1-§10.5（`_lineOrder` + カーソル規則 + `//#evalBegin` / `//#evalEnd`）を採用する。変更点:

| #649 v3 | 本書 |
|---|---|
| `_lineOrder` は**キーの順列**で、値は各スライスに残る | `_line: LineElement[]` に**値も同居**（§3.1）。スライス（`_sumOutputBus` / `_auxSends` / `_renderBus`）は廃止 |
| output の同一性 = 単一 | 同一性 = **宛先キー**（send と同じ・§4.A.1 の帰結）|
| §10.4 既定ストリップ `[ラック → gain → pan → sends → output]` | `[ラック → gain → pan → sends(=output thru) → output(master)]`（**pan はライン要素**・§2.4b / §14 (4)。位置は自由）|
| フェーダー = `gain_override` スカラー | フェーダー = `output` の `gain`（裁定 ④）。`gain` 要素は別に残る |

---

## 3. TS の型と signature

### 3.1 新設: `packages/engine/src/core/sequence/audio-line.ts`（新規ファイル）

```ts
import type { MixerKind } from '../global/mixer-manager'

/** 解決後の宛先。同一性（§2.5）はこの値の構造的等価で決まる。 */
export type OutputDest =
  | { readonly kind: 'master' }
  | { readonly kind: 'bus'; readonly bus: string }                 // daemon bus 名（sum-bus-n / aux-bus-n）
  | { readonly kind: 'device'; readonly channels: readonly [number, number] | readonly [number] }  // 1 始まり。長さ 1 = mono（L+R マージ・Q-611-5）
  | { readonly kind: 'render'; readonly id: string }               // 598 設計 §3（宣言ノード id）
  | { readonly kind: 'link'; readonly channel: string }

export function destKey(d: OutputDest): string {
  switch (d.kind) {
    case 'master': return 'master'
    case 'bus': return `bus:${d.bus}`
    case 'device': return `device:${d.channels.join(',')}`
    case 'render': return `render:${d.id}`
    case 'link': return `link:${d.channel}`
  }
}

export type LineElement =
  | { readonly kind: 'rack' }                                   // effect([...])。ライン上の位置だけを持つ（値は EffectChainMap）
  | { readonly kind: 'gain'; readonly db: number }              // seq.gain(固定値) / global.gain()
  | { readonly kind: 'pan'; readonly pan: number }              // seq.pan(固定値): バス上の L/R バランス（-1..1・owner 2026-09-03 Q-611-4 でライン要素に）
  | {
      readonly kind: 'output'
      readonly dest: OutputDest
      readonly thru: boolean
      readonly db: number                                      // -Infinity = 送らない（enabled: false）
      /** 書いた形（診断・getState 用）。`send` 糖衣なら 'send'。 */
      readonly sugar: 'output' | 'send'
    }

/**
 * 要素の同一性キー（#649 §10.1 の順列キー）。
 * 🔴 owner 裁定（2026-09-03 Q-611-3）: 同じ宛先への `output` を 2 回書いたら **2 要素として両方加算**する
 * （自由度を落とさない）。したがって output のキーは宛先ではなく **チェーン内の出現序数**
 * （`ordinal` = その宛先の何回目か）を含む。`send` も同じ。
 * 「同じ宛先が 2 回ある」ことを知らせたければ **DSL の診断（doc 610 の表・`info`）**で出す。engine は制限しない。
 */
export function elementKey(e: LineElement, ordinal = 0): string {
  return e.kind === 'output' ? `output:${destKey(e.dest)}#${ordinal}` : e.kind
}

/**
 * 1 本のオーディオライン（#649 §10.2 のカーソル規則を持つ）。
 * Sequence / MixerBusHandle / master が 1 つずつ持つ。
 */
export class AudioLine {
  private elements: LineElement[] = []
  /** 評価バッチ内のカーソル（#649 §10.2）。`beginBatch()` で 0 に戻る。 */
  private cursor = 0
  private inBatch = false

  beginBatch(): void { this.cursor = 0; this.inBatch = true }
  endBatch(): void { this.inBatch = false }

  /** #649 §10.2 規則 1-4。バッチ外（生 REPL）は「値だけ更新・位置不変」（規則 4 の退化）。 */
  upsert(e: LineElement): void { /* §3.2 の擬似コード */ }

  /** 暗黙 master を補った、wire へ出す順列（§2.1 の既定・§3.4）。 */
  program(): readonly LineElement[] { /* … */ }

  outputs(): readonly Extract<LineElement, { kind: 'output' }>[] { /* … */ }
  snapshot(): readonly LineElement[] { return [...this.elements] }
}
```

### 3.2 `upsert` の規則（#649 §10.2 を型で固定）

```
upsert(e):
  k = elementKey(e)
  i = elements.findIndex(x => elementKey(x) === k)
  if !inBatch:                       # 生 stdin・単文
    if i >= 0: elements[i] = e       # 値だけ更新・位置不変
    else: insertAtDefault(e)         # §2.6 の既定ストリップ順で挿入
    return
  if i >= cursor: elements[i] = e; cursor = i + 1            # 規則 1
  elif i >= 0: elements.splice(i, 1); elements.splice(cursor, 0, e); cursor += 1   # 規則 2
  else: elements.splice(cursor, 0, e); cursor += 1           # 規則 3
```

規則 4（バッチ内に要素が 1 つしか現れなければ動かない）は、`beginBatch` 直後の 1 回目の `upsert` が
「`i >= 0` かつ `i >= cursor(=0)`」で規則 1 に落ちることで自動的に成立する。

**同一宛先の複数 `output`（Q-611-3・B）**: バッチ内では `ordinal` を「このバッチで同じ宛先を見た回数」で振るので、
`kick.output(verb, thru: true).effect(x).output(verb)` は 2 要素（pre と post を両方 verb へ）になる。
バッチ外（生 stdin の単文）は `ordinal = 0` = **最初の要素だけを値更新**する（後方互換）。engine 側（§4.1 検証）は同一宛先の重複を**拒否しない**。

### 3.3 `Sequence` の変更（`packages/engine/src/core/sequence.ts`）

| 行 | 今 | 変更 |
|---|---|---|
| `:108` `_outputChannel?: string` | LinkAudio 名 | **残す**（`resolveDispatchChannel` `:1592-1618` が読む）。`output()` の link 分岐が `_line` にも `{kind:'link'}` を置く |
| `:113` `_renderBus?: string` | 数値 render bus | **廃止**（§14 (1) の裁定次第で互換読み替え）|
| `:117` `_insertBus?: string` | 割当 stage | 残す |
| `:122` `_sumOutputBus?: string` / `:123` `_auxSends` | 単一 output / aux 名キー | **廃止 → `private readonly _line = new AudioLine()`** |
| `:88` `buildRoutingSends()` | sends 配列 | 廃止 |
| `:350-431` `output(channelName)` | 3 分岐 | 下の新 signature |
| `:454-480` `send(auxName, amount)` | 線形 | 下の新 signature（dB）|
| `:484-499` `routeOutputFromDsl(output)` | sum 名 / `'master'` | `routeOutputFromDsl(dest: OutputDest, opts)`（await 版）|
| `:503-519` `routeSendFromDsl(auxBus, amount)` | 線形 | `routeSendFromDsl(bus, db, enabled)` |
| `:521-533` `pushBusRouting` / `:540-570` `syncBusRouting` | `SetBusRouting` を送る | **`SetBusLine` を送る**（§4）。stale 自己修復・`DaemonProtocolError` 分岐はそのまま |
| `:310-314` `gain(valueDb)` | `GainManager` へ | 固定値なら `_line.upsert({kind:'gain', db})` + `syncBusLine()`; `RandomValue` なら従来どおり |
| `:1571-1572` `scheduleEvents` の `outputChannel` / `insertBus` | | 不変 |
| `:1870-1893` `getState()` | `outputChannel` / `renderBus` | `line: this._line.snapshot()` を足す（`renderBus` は削除）|

```ts
export interface OutputOptions { thru?: boolean; db?: number }

/** §2.1。`dest` は解決前の値（ノード変数は interpreter が OutputDest に解決してから渡す）。 */
output(dest: string | number | OutputDest, opts: OutputOptions = {}): this
/** §2.3。`enabled: false` は db = -Infinity。 */
send(aux: string | OutputDest, db: number, opts: { enabled?: boolean } = {}): this
```

**`output()` の解決順（§2.2 を規範化・`sequence.ts:350-431` を置き換える）**:

1. `OutputDest` が来た（interpreter がノード変数を解決済み）→ そのまま
2. 文字列 `"master"` → `{kind:'master'}`（**予約語**。今日の LinkAudio 名フォールバック `:411-412` を止める）
3. 文字列が `resolveMixerBus`（`global.ts:502`）で sum/aux に解決 → `{kind:'bus'}`（曖昧なら既存の throw）
4. 文字列が `/^\d+,\d+$/` → `{kind:'device'}`（裁定 3 の省略形）
5. number → §14 (1) の裁定まで**現状の `_renderBus` 互換**（`1..16` を `{kind:'render', id:'legacy:<n>'}` に写像。598 設計 §2.4）
6. それ以外の文字列 → `{kind:'link', channel}`（今日の LinkAudio 分岐 `:404-431` と同じ警告・eager 登録）

midi シーケンスの拒否（`:361-366` / `:459-464`）と instrument の `link` 拒否（`:403-409`・PR-3 = #645 まで）は**そのまま**。
instrument の数値 render 拒否（`:376-386`）は §14 (1) と 598 設計 P3 に従う。

### 3.4 `program()` — wire へ出す順列

```
elements に output が 1 つも無い → elements + [output(master, thru:false, db:0)]（末尾）
elements に rack が無い          → 先頭に rack（stage の processor は None なら素通し）
```

`thru:false` の output より**後ろ**の要素は wire にも載せる（daemon は `break` で到達しない・§5.3）。
エディタ診断「この後ろには音が流れません」は #644 の適用可否表の 1 行として扱う（§8）。

### 3.5 `Global` / master ライン（`packages/engine/src/core/global.ts`）

| 行 | 変更 |
|---|---|
| `:601-612` `gain(valueDb)` | `effectsManager.gain` の記録はそのまま。送信を `setGlobalGain` から **`setBusLine('master', masterLine.program())`** へ。`masterLine.upsert({kind:'gain', db})` |
| 新設 `private readonly masterLine = new AudioLine()` | 既定 program = `[rack, output(device(1,2))]` |
| `:440-442` `effect()` | 変更なし（master ラック = daemon `post`）。`masterLine.upsert({kind:'rack'})` を足す |
| 新設 `masterOutput(dest: OutputDest, opts)` | `master.output(cue, thru:true)`（SC.2.1 の output ノードをレシーバに・§3.7）|
| `:515-524` `setBusRouting` | **`setBusLine(bus, program)` を追加**。旧 `setBusRouting` は互換のため残す（呼び出し元ゼロにしてから別 PR で削除）|

### 3.6 `MixerBusHandle`（`packages/engine/src/core/global/mixer-manager.ts`）

| 行 | 変更 |
|---|---|
| `:74-84` interface | `routeOutput(output)` / `routeSend(bus, amount)` → `output(dest: OutputDest, opts)` / `send(bus, db, opts)`。`line: AudioLine` を持つ |
| `:321-344` `route()` | `routings: Map<bus, {output, sends}>` → `lines: Map<bus, AudioLine>`。送信は `setBusLine` |
| `:244-249` `master` 予約 | 不変 |
| `:20-27` `MIXER_BUS_POOL_SIZE = 4` | 不変（撤廃は #663）|

### 3.7 output ノードをレシーバにする（`packages/engine/src/signal-chain/runtime.ts`）

| 行 | 今 | 変更 |
|---|---|---|
| `:76-86` `MixerRuntimeNode` | `output` ノードは `channels` のみ | `output` ノードに `line: AudioLine` を足す。`master`（暗黙・`:285-290`）も同じ |
| `:293-313` `mixerNodeReceiver` | output で **throw**（「#484 D4」）| output ノードも受け手にする: `effect` / `output` / `ui` を受ける `MixerBusHandle` 互換オブジェクトを返す |
| `:74` `BUS_DSL_METHODS` | `effect` / `ui` | `+ 'output' / 'send' / 'gain'` |
| `:100-109` `validateBusChainMethods` | | `output` / `send` / `gain` をバス許可に |

**`#484 D4` の文言**（`runtime.ts:311-312` / `process-statement.ts:244-250` / `tests/interpreter/mixer-runtime.spec.ts:212`）は
本書の実装で**消える**（地図 §9「#484 の D4 が本文に無い」の解消 = 文言側を落とす）。

### 3.8 interpreter（`packages/engine/src/interpreter/`）

| 箇所 | 変更 |
|---|---|
| `evaluate-method.ts:59-85` `processArguments` | `named_arg` を一律 throw している。**メソッド別の名前付き引数スキーマ表**を新設し、`output` / `send` の `thru:` / `db:` / `enabled:` を options オブジェクトへ畳む。スキーマに無い名前は従来の staged error |
| `process-statement.ts:239-255`（`.drums` / `.master` 糖衣）| `dispatch.node.kind === 'output'` の `(1,2)` 限定 throw（`:244-250`）を外し、`OutputDest` に解決して `output()` へ |
| `process-statement.ts:185-236`（aux 名メソッド = send）| `amount` を **dB** として `send()` へ。`enabled:` は維持 |
| `process-statement.ts:72-92` | 受け手 3 種は不変（output ノードは `resolveMixerNode` 経由で `MixerRuntimeNode` として届く）|
| 引数のノード変数（`output(drums)`）| `parse-expression.ts:114` で IDENTIFIER → `parseIdentifier()`（chord ref 等）。`output` / `send` の第 1 引数だけは interpreter で `state.mixers.nodes` を先に引き `OutputDest` へ解決する（`processArguments` に受け手種別を渡す）|

```ts
// evaluate-method.ts（新設）
const NAMED_ARG_SCHEMA: Readonly<Record<string, Readonly<Record<string, 'boolean' | 'number'>>>> = {
  output: { thru: 'boolean', db: 'number' },
  send: { db: 'number', enabled: 'boolean' },
}
```

### 3.9 評価バッチ境界（#649 §10.3・唯一の新機構）

| 箇所 | 変更 |
|---|---|
| `packages/vscode-extension/src/extension.ts:3000-3033` `writeCodeToEngine` | 送出テキストを `//#evalBegin\n … \n//#evalEnd` で挟む（`//#documentDirectory` の後）|
| `packages/engine/src/cli/repl-mode.ts:65-105` メタ行群 | `EVAL_BEGIN_META_RE` / `EVAL_END_META_RE` を追加。`begin` で全 `AudioLine.beginBatch()`、`end` で `endBatch()` |
| MCP `evaluate_orbitscore`（`mcp-server.ts:539`）| 同じ `writeCodeToEngine` を通る（`extension.ts:3045`）ので追加作業なし |

生 stdin（手動 REPL）はバッチ無し = 「値だけ更新・位置不変」に退化する（§3.2）。

---

## 4. wire（daemon protocol）— 🔴 一方通行

### 4.1 新コマンド `SetBusLine`

`SetBusRouting`（`session.rs:2241-2258`・`output?`/`sends?` の**部分適用**意味論）は拡張せず、**全置換**意味論の新コマンドを足す。
理由: 部分適用（省略 = 保持）と順列（位置）は両立しない。旧コマンドは互換のため残し、TS が使わなくなった後に削除 PR を出す。

```jsonc
// request
{ "method": "SetBusLine",
  "params": {
    "bus": "seq-bus-0",              // string: insert / sum / aux の daemon bus 名、または予約語 "master"
    "line": [                        // 順序 = 信号順。全置換
      { "op": "rack" },
      { "op": "gain",   "gain": 0.501187 },                                   // 線形振幅（TS が dB→線形）
      { "op": "output", "dest": { "kind": "bus", "name": "aux-bus-0" }, "thru": true,  "gain": 0.25 },
      { "op": "output", "dest": { "kind": "master" },                    "thru": false, "gain": 1.0 }
    ]
  } }
// ok
{ "status": "accepted" }
```

```ts
// protocol-types.ts:18 CommandMethod に追加
| 'SetBusLine'

// daemon-client.ts（新設・681 の隣）
async setBusLine(bus: string, line: WireLineOp[]): Promise<void> {
  await this.request('SetBusLine', { bus, line })
}
export type WireDest =
  | { kind: 'master' }
  | { kind: 'bus'; name: string }
  | { kind: 'device'; channels: [number, number] }   // 1 始まり
  | { kind: 'render'; id: string }                    // 598 設計 §4
  | { kind: 'link'; channel: string }
export type WireLineOp =
  | { op: 'rack' }
  | { op: 'gain'; gain: number }                      // 線形・有限・>= 0
  | { op: 'output'; dest: WireDest; thru: boolean; gain: number }
```

**検証（daemon・`session.rs` に `parse_set_bus_line_params` を新設・`:203-238` と同型）**:

| 規則 | エラー code |
|---|---|
| `bus` は非空文字列 / `"master"` | `MALFORMED_REQUEST` |
| `line` は配列・各 `op` は 3 種のどれか・`gain` は有限かつ `>= 0` | `MALFORMED_REQUEST` |
| `rack` は高々 1 回 | `MALFORMED_REQUEST` |
| `dest.bus` は既知・**`bus` より後ろの index**（forward-only・MX.4）。kind（sum/aux）は**問わない**（裁定 ③）| `OUTPROC_EFFECT`（既存 `WrapError::OutProcEffect` 経由）|
| `dest.device` は `1 <= a,b <= output_channels` かつ `a != b` | `PARAM_OUT_OF_RANGE` |
| `dest.render` は登録済み id（598 設計）| `MALFORMED_REQUEST` |
| `dest.link` は `link-audio` feature 時のみ・登録済み channel | `LINK_AUDIO_UNAVAILABLE` / `MALFORMED_REQUEST` |
| `bus == "master"` の `line` に `dest.master` / `dest.bus` は不可（自己参照） | `MALFORMED_REQUEST` |
| 1 件でも失敗 → **何も反映しない**（`set_bus_routing` `:5776` と同じ全か無か）| |

### 4.2 `SetGlobalGain`（`session.rs:2214-2239`）

**残す**が意味を変えない形で master line に写す: 受理時に master line の `gain` op を差し替えて再インストール（`ramp_sec` は ramp 長）。
TS は `global.gain()` を `SetBusLine("master", …)` に切り替えるので、production の呼び出し元はゼロになる（`rust-engine-player.ts:1247-1258` / `:1027`）。
core の `Engine::set_global_gain`（`engine.rs:143-152`）は **production では呼ばない**（§5.5）。

### 4.3 変わらないもの

`SetSourceRouting`（`:2259-2276`）/ `PlayAt` の `bus` / `channel`（`:2088-2150`）/ `GetStatus`（`:1349-1360`）。

---

## 5. Rust — ライン・プログラムと master ライン

### 5.1 型（`rust/crates/orbit-audio-native/src/output.rs`・`BusTarget` `:361-367` / `BusSend` `:372-375` の隣）

```rust
/// 出口の宛先（wire `dest` の RT 表現）。index はすべて構築時に解決済み。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputDest {
    Master,
    Bus(usize),                    // stages 配列内の絶対 index（forward-only は構築時検証）
    Device { left: usize, right: Option<usize> },   // 0 始まりの interleaved ch index。right=None = mono（L+R を 0.5 でマージ・Q-611-5）
    Render(usize),                 // render tap の slot index（598 設計 §5）
    Link(usize),                   // LinkEgress.channels の index
}

#[derive(Debug, Clone, Copy)]
pub struct LineOutput { pub dest: OutputDest, pub thru: bool, pub gain: f32 }

#[derive(Debug, Clone, Copy)]
pub enum LineOp { Rack, Gain(f32), Pan(f32), Output(LineOutput) }   // Pan: バス上の L/R バランス（Q-611-4）

/// 1 stage のライン。**RT では読むだけ**。構築は control 側（alloc 可）。
pub struct LineProgram {
    pub ops: Box<[LineOp]>,
    /// op ごとの実効ゲイン（click-free ramp の現在値）。長さ = ops.len()。RT が更新する。
    pub current_gain: Box<[Cell<f32>]>,
}

/// control → RT の差し替え口。`routing_override`（`:410`）/ `send_gain_overrides`（`:416`）を置き換える。
pub struct LineSlot {
    live: AtomicPtr<LineProgram>,          // RT が Acquire load
    retired: Mutex<Vec<Box<LineProgram>>>, // control 側が世代番号で回収（#628 install ring と同じ規律）
    generation: AtomicU64,
}
```

`InsertBusStage`（`:383-417`）から `output_target` / `sends` / `routing_override` / `send_gain_overrides` を外し、`line: LineSlot` を足す。
`with_output_target` `:459` / `with_sends` `:465` / `with_routing_overrides` `:475` は `with_line(LineProgram)` に置き換える（呼び出し元は §7.3）。

**上限を決めない**（owner）: `ops` は `Box<[_]>` なので出口の個数に定数上限は無い。RT 側の `ArrayVec` 容量（`MAX_INSERT_BUS_STAGES` `:347`）は stage 数の話で本書では変えない（撤廃は #663）。

### 5.2 master ライン（新設・`RenderState` `:1433-1442` に `master: MasterLine` を足す）

```rust
pub struct MasterLine {
    /// 全 stage の Master 宛て出口が加算される 2ch バッファ（zero-fill は callback 冒頭）。
    pub buffer: Vec<f32>,
    /// master ラック（今日の `post`・`render_block_with_sources` `:693-695`）。
    pub post: Option<Box<dyn PostProcessor>>,
    pub line: LineSlot,      // 既定 program = [Rack, Output(Device{0,1}, thru:false, 1.0)]
}
```

### 5.3 RT アルゴリズム（`render_engine_with_insert_buses_and_source_outputs` `:823-1000` の post-loop `:943-988` を置き換える）

```
zero-fill hw（device 幅）, master.buffer（2ch）
render_multi_feeds(master.buffer?, targets, feeds)   # §5.5 参照: 「hardware_out」= master.buffer
for i in 0..stages.len():                             # 配列順 = トポロジカル順（不変）
    if !render_targets[i]: continue
    prog = stages[i].line.live.load(Acquire)
    buf = stages[i].buffer[..bs]
    for (k, op) in prog.ops.iter().enumerate():
        match op:
          Rack        => if let Some(p) = stages[i].processor { p.process(buf) }
          Gain(g)     => g_now = ramp(prog.current_gain[k], g); buf *= g_now
          Pan(p)      => (gl, gr) = equal_power(p); buf[L] *= gl; buf[R] *= gr        # Q-611-4
          Output(o)   => g_now = ramp(prog.current_gain[k], o.gain)
                         match o.dest:
                           Master           => master.buffer += buf * g_now
                           Bus(j)           => stages[j].buffer += buf * g_now      # j > i（構築時検証・split_at_mut 継続）
                           Device{l, Some(r)} => hw[frame*ch + l] += buf[frame*2]*g_now; hw[frame*ch + r] += buf[frame*2+1]*g_now
                           Device{l, None}    => hw[frame*ch + l] += (buf[frame*2] + buf[frame*2+1]) * 0.5 * g_now   # mono = マージ（Q-611-5）
                           Render(s)        => render_taps[s].commit(buf * g_now)   # RingTapSink（598 設計 §5）
                           Link(c)          => link.channels[c].scratch += buf * g_now
                         if !o.thru { break }
# master ライン
prog = master.line.live.load(Acquire)
for op in prog.ops: Rack => post.process(master.buffer) / Gain => 同上 / Output => 同上（Master/Bus は構築時拒否）
capture.commit(hw)   # #307 の capture は「デバイスへ出る実信号」= hw のまま
```

- `ramp()`: 1 block で線形に目標へ寄せる（`current_gain += (target - current) * min(1, bs / RAMP_FRAMES)`、`RAMP_FRAMES` = 5 ms 相当を sample_rate から構築時に算出）。core の master ramp（`scheduler.rs:443-476`）を stage 側へ移した形。**click の実測は §10 E2E-7**。
- `Output` 後の `break` により「`thru: false` の後ろの要素は走らない」が RT の事実になる（#649 §7.3）。
- Device 宛ては **master のラック・ゲインを通らない**（裁定 2 の「別チャンネルでモニター」の意味論）。
- 借用: `Bus(j)` は `split_at_mut(i + 1)`（今日の `:951-952`）を維持。`Device` / `Master` / `Render` / `Link` は別バッファなので借用衝突なし。

### 5.4 なぜ「出口の属性」で位置ずれのバグが**クラスとして**消えるか（地図 §4.A.1 検証 (1)）

今日のバグ: core が master gain を**全バッファ**に掛け（`scheduler.rs:443-453`・insert の前）、その後 native が stage を hw へ素のまま加算（`:957-960`）。
本書では「乗算 = 出口の op」であり、**掛ける位置という自由度が無い**。master のゲインは master ラインの op としてラックの**後**に必ず来る。

⚠️ **原因説明の撤回について**（#649 コメント 1・2026-09-02）: #649 本文の「core の `global_gain` が insert の前で掛かるから」という説明は、
**E2E-1（`global.gain(-6)` + instrument）にはバス経路が無い**ため成り立たず、コメントで**撤回済み・原因未特定**である。
本書はこの撤回を前提にし、原因の特定を実装に先行させない。代わりに:

- **E2E-1 は red-first で書く**（TDD）。本書の変更前に落ちること・変更後に通ることを両方観測する。
- 変更後に通る根拠は「core の `global_gain` が production で 1.0 固定になり、乗算経路が master ラインの 1 本だけになる」こと（§5.5）。
  経路が 1 本しか無いので、**どこで掛かっていたか**を突き止めなくても、**どこで掛かるか**が確定する。
- それでも E2E-1 が落ちる場合は、原因が本書の範囲外（events 側 `event-scheduler.ts:28-70` の gain fold や instrument 経路）にあることの証明になるので、
  §13 の反証手順に従って **PR-O2 を止めて報告**する（推測で追加修正しない）。

### 5.5 engine の内部幅を 2ch に固定し、core の master gain を production から外す

| 変更 | 箇所 | 根拠 |
|---|---|---|
| `Engine::new(sample_rate, channels)` → `Engine::new(sample_rate, 2)` | `output.rs:1432` | events / feeds / stages はすべて 2ch。デバイス幅は **Device 出口の配置**でのみ現れる |
| バス buffer の確保 `ensure_buffer_len(sample_rate * channels)` → `* 2` | `:1404-1408` | 8ch@2048 の feed 破棄（#611 本文の実害）は `bs = frames*2 ≤ 8192` で消える |
| `render_multi_feeds` の `hardware_out` に渡すのは **`master.buffer`** | `:823-1000` の呼び出し側 | core は「Master 宛て」を hardware と呼んでいるだけ。core の変更は不要 |
| core の `global_gain` を production で **1.0 固定**（`set_global_gain` を呼ばない）| `engine_wrap.rs:8121-8125` の呼び出し元 = `session.rs:2231` のみ → §4.2 で master line へ | ramp が 1.0 のままなら `render_multi_feeds` は bit 一致（`*= 1.0`）|
| `pan` の 2ch ゲート（`scheduler.rs:260`）/ ch3+ 複製（`:534-548`）| 変更なし | 内部幅 2 なので常に 2ch 分岐を通る（デバイス幅と無関係になる）|
| バス無し経路（`render_engine` `:725`）| hw が device 幅・engine が 2ch になるので **Device{0,1} 配置を 1 回挟む** | 2ch デバイスでは `memcpy` 相当 = bit 一致（§10 E2E-0 で固定）|

**前提の明記（#679 の整合確認 `docs/design/679-input-consistency-check.md` §2）**: 本書は **1 サンプルレート前提**（engine はデバイスの出力レートで構築）。入力（#679・未着手）が別レートのデバイスを掴む場合はリサンプルか aggregate device が要り、それは #679 の設計で決める（本書は変えない）。

### 5.6 `outs:` / マルチティンバー（#409 / #647）との接続

- `SetSourceRouting(source, unit, target)`（`session.rs:2259`・`engine_wrap.rs:5897-5960`）は**そのまま**。unit の宛先は「insert bus」限定（`:5921-5924` の `BusKind::Insert` 検査）を **sum / aux も可**に緩める（feeds は stage の前に加算されるので順序制約なし）。
- `outs: { "kick": bd, "oh": cue }` の値が **output / render ノード**（stage を持たない）の場合: TS が **passthrough stage** を insert プールから 1 つ確保し（`ensureSequenceInsertBus` `global.ts:477` と同じ経路・名前 `<seq>#<unit>`）、`SetSourceRouting(unit → その stage)` + `SetBusLine(stage, [output(dest)])` を送る。
- ポート名 → unit index の写像は **#647**（child が出力ポートを列挙し `orbit-plugin-scan` のカタログに `outputs: [{index, name, channels}]` を記録）。それまで `outs:` は unit 0 のみ受理し、それ以外は **loud なエラー**（silent 無視禁止・SC.3.3）。
- **#647 の shm**: `SharedRegion.output: [f32; BUF_LEN * SLOTS]`（`transport.rs:60`）を `[f32; BUF_LEN * SLOTS * MAX_SOURCE_UNITS]` へ（`MAX_SOURCE_UNITS = 16` `output.rs:353`・2ch@4096 で 16 unit = 2 MiB/slot）。child は `n_units` を `SharedRegion` header に書き、`BlockSource::render` の戻り値（`:268-272`「有効 unit 数」）で報告する。**メモリの実測は #663 の前に取る**（地図 §4.O (3)）。

---

## 6. データの通り道 1 本（端から端まで）

譜面:

```orbs
var mix = init global.mixer
var verb = mix.aux
verb.effect(["ValhallaRoom"])
kick.audio("kick.wav").play(1,0,1,0)
kick.effect(["Comp"]).output(verb, thru: true, db: -12).output("master")
LOOP(kick)
```

| # | 層 | 何が起きるか | 場所 |
|---|---|---|---|
| 1 | 拡張 | `writeCodeToEngine` が `//#documentDirectory` + `//#evalBegin` を前置し stdin へ | `extension.ts:3000-3033` |
| 2 | REPL | `//#evalBegin` を検出 → 全 `AudioLine.beginBatch()` | `repl-mode.ts`（新設メタ行）|
| 3 | parser | `kick.effect([...]).output(verb, thru: true, db: -12).output("master")` → `SequenceStatement{ method:'effect', chain:[{method:'output', args:[Identifier verb, NamedArg thru, NamedArg db]}, {method:'output', args:['master']}] }` | `parse-statement.ts:780-900` |
| 4 | interpreter | `applyMethodChain` が順に dispatch。`output` の第 1 引数 `verb` を `state.mixers.nodes` から `{kind:'bus', bus:'aux-bus-0'}` に解決。`NAMED_ARG_SCHEMA` で `{thru:true, db:-12}` | `process-statement.ts:268-290` / `evaluate-method.ts` |
| 5 | Sequence | `effect()` → `_insertBus = 'seq-bus-0'`・`_line.upsert(rack)`。`output(bus, {thru, db})` → `_line.upsert(output{dest:bus aux-bus-0, thru:true, db:-12})`。`output("master")` → `upsert(output{master, thru:false, 0})`。各 `syncBusLine()` | `sequence.ts:350-431`（置換後）|
| 6 | REPL | `//#evalEnd` → `endBatch()` | `repl-mode.ts` |
| 7 | TS client | `setBusLine('seq-bus-0', [rack, output(bus aux-bus-0, true, 0.251), output(master, false, 1.0)])`。intent cache に保存（respawn replay・`rust-engine-player.ts:975-989` と同型）| `daemon-client.ts`（新設）|
| 8 | daemon | `parse_set_bus_line_params` → index 解決（`bus_index` `engine_wrap.rs:1690`）・forward 検証・`LineProgram` を alloc → `stages[0].line.live.swap(Release)`・旧を retired へ | `session.rs` / `engine_wrap.rs`（新設）|
| 9 | RT | 次 callback: `render_multi_feeds(master.buffer, [seq-bus-0, aux-bus-0], …)` が kick のイベントを `seq-bus-0` に混合 → post-loop: `Rack`（Comp child）→ `Output(Bus aux-bus-0, 0.251)` 加算・thru → `Output(Master, 1.0)` 加算・break → aux-bus-0 の program `[Rack(Valhalla), Output(Master)]` → master ライン `[Rack(post None), Output(Device{0,1})]` → hw | `output.rs`（§5.3）|
| 10 | 出力 | hw → cpal → デバイス ch1/2。capture は hw をそのまま tap（`:700-702`）| |

---

## 7. 呼び出し元の全列挙（grep 実行結果・main `ca176f0`）

### 7.1 `setBusRouting` / `SetBusRouting`（TS・非コメント行）

```
$ grep -rn "setBusRouting\|SetBusRouting" packages/engine/src packages/vscode-extension/src --include=*.ts | grep -v "^\S*:[0-9]*:\s*\(//\|\*\)"
packages/engine/src/audio/rust-engine/daemon-client.ts:681:  async setBusRouting(
packages/engine/src/audio/rust-engine/daemon-client.ts:686:    await this.request('SetBusRouting', {
packages/engine/src/audio/rust-engine/protocol-types.ts:32:  | 'SetBusRouting'
packages/engine/src/audio/rust-engine/rust-engine-player.ts:949:  async setBusRouting(
packages/engine/src/audio/rust-engine/rust-engine-player.ts:961:      await this.daemon.setBusRouting(seqBus, output, sends)
packages/engine/src/audio/rust-engine/rust-engine-player.ts:981:        await this.daemon.setBusRouting(seqBus, output, sends)
packages/engine/src/audio/types.ts:217:  setBusRouting?(
packages/engine/src/core/global/mixer-manager.ts:326:    if (!this.audioEngine.setBusRouting) {
packages/engine/src/core/global/mixer-manager.ts:339:    await this.audioEngine.setBusRouting(
packages/engine/src/core/sequence.ts:525:      await this.global.setBusRouting(
packages/engine/src/core/sequence.ts:546:    void this.global.setBusRouting(bus, this._sumOutputBus, buildRoutingSends(this._auxSends)).then(
packages/engine/src/core/sequence.ts:560:            `❌ ${name}: SetBusRouting(${bus}) was rejected — routing was NOT applied. ` +
packages/engine/src/core/sequence.ts:565:            `⚠️  ${name}: SetBusRouting(${bus}) failed (transient) — ` +
packages/engine/src/core/global.ts:515:  async setBusRouting(
packages/engine/src/core/global.ts:520:    if (!this.audioEngine.setBusRouting) {
packages/engine/src/core/global.ts:523:    await this.audioEngine.setBusRouting(seqBus, output, sends)
```

テスト（同 grep・spec）: `tests/audio/rust-engine/rust-engine-player-plugin-respawn.spec.ts` / `tests/interpreter/signal-chain-dispatch.spec.ts` /
`tests/core/sequence-output-send-mixer.spec.ts` / `tests/core/global-mixer-sum-aux.spec.ts` / `tests/core/sequence-output.spec.ts` — **5 本すべてを `setBusLine` に書き直す**。

### 7.2 `output()` / `send()` の入口（TS・非コメント行）

```
$ grep -rn "\.output(\|routeOutputFromDsl\|routeOutput(" packages/engine/src --include=*.ts | grep -v コメント
packages/engine/src/interpreter/process-statement.ts:254:        ? receiver.routeOutputFromDsl(output)
packages/engine/src/interpreter/process-statement.ts:255:        : receiver.routeOutput(output)
packages/engine/src/core/global/mixer-manager.ts:82:  routeOutput(output: string): Promise<MixerBusHandle>
packages/engine/src/core/sequence.ts:484:  async routeOutputFromDsl(output: string): Promise<this> {
$ grep -rn "\.send(\|routeSendFromDsl\|routeSend(" packages/engine/src --include=*.ts | grep -v コメント
packages/engine/src/interpreter/process-statement.ts:236:          ? receiver.routeSendFromDsl(dispatch.node.handle.bus, gain)
packages/engine/src/interpreter/process-statement.ts:237:          : receiver.routeSend(dispatch.node.handle.bus, gain)
packages/engine/src/core/global/mixer-manager.ts:83:  routeSend(bus: string, amount: number): Promise<MixerBusHandle>
packages/engine/src/core/sequence.ts:503:  async routeSendFromDsl(auxBus: string, amount: number): Promise<this> {
（daemon-client.ts:802 の `ws.send` は WebSocket・無関係）
```

`Sequence.output()` / `send()` の**動的**呼び出し（`callMethod` 経由）は `SEQUENCE_DSL_METHODS`（`runtime.ts:46-47`）に登録された名前で届く。

### 7.3 `_sumOutputBus` / `_auxSends` / `_renderBus` の読み手（TS）

```
packages/engine/src/core/sequence.ts:88   buildRoutingSends
packages/engine/src/core/sequence.ts:113  _renderBus 宣言 / :369 :399 :411 書き込み / :439-440 getRenderBus / :1885 getState
packages/engine/src/core/sequence.ts:122  _sumOutputBus 宣言 / :371 :496 書き込み / :527 :546 読み
packages/engine/src/core/sequence.ts:123  _auxSends 宣言 / :477 :516 書き込み / :528 :546 読み
```

`getRenderBus()` の呼び出し元は render-score 経路（`packages/engine/src/audio/rust-engine/render-score.ts`・598 設計）。§14 (1) と同時に扱う。

### 7.4 Rust: `BusTarget` / `with_output_target` / `with_sends` / `with_routing_overrides` / `set_bus_routing`（非テスト）

```
rust/crates/orbit-audio-daemon/src/session.rs:203       parse_set_bus_routing_params
rust/crates/orbit-audio-daemon/src/session.rs:2241-2243 "SetBusRouting" ハンドラ
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:2117  .with_routing_overrides(...)   ← build_effect_bus_stages
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:5776  pub fn set_bus_routing
rust/crates/orbit-audio-native/src/output.rs:445 :459 :465 :475 :495-499 :509 :851 :875 :957 :962
```

テスト（同 grep）: `engine_wrap.rs:2575-2810`（`set_bus_routing_tests` 15 件）/ `output.rs:2217-2451`（静的 topology テスト 8 件）/
`rust/crates/orbit-audio-daemon/tests/outproc_mixer_bus_gated.rs`。**旧 API を消す PR で全件を `LineProgram` 形へ書き直す**。

### 7.5 Rust: `global_gain` の消費者（非テスト）

```
rust/crates/orbit-audio-core/src/engine.rs:143-152     Engine::set_global_gain
rust/crates/orbit-audio-core/src/scheduler.rs:157 :205 :214-227 :229-231 :443-476
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:8121  EngineWrap::set_global_gain
rust/crates/orbit-audio-daemon/src/session.rs:2214-2239 "SetGlobalGain"
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1027 :1247-1258
packages/engine/src/core/global.ts:608
packages/engine/src/audio/types.ts:193
```

core のテスト（`scheduler.rs:667-1494` の 6 件）は core の API を保つので**そのまま**。

### 7.6 Rust: `Engine::new` / `output_channels`（native）

```
rust/crates/orbit-audio-native/src/output.rs:1432   Engine::new(sample_rate, channels)   ← §5.5 で 2 に
rust/crates/orbit-audio-native/src/output.rs:588 :638 :671 :716-745 :808 :829 :837 :1006 :1024   output_channels を frame 数計算に使用
```

`bs = (hw.len() / output_channels) * output_channels`（`:837` / `:1024`）は「hw の frame 数」を求める式。stage 側は `frames * 2` を使うよう分離する（§5.5）。

---

## 8. 失敗モード（握り潰される経路が無いことの確認）

| 何が壊れうるか | どこで検出 | 何が出るか | 演奏は止まるか |
|---|---|---|---|
| 未宣言ノード / 曖昧名（sum と aux 両方に同名）| `resolveMixerBus` throw（`mixer-manager.ts:198-206`）| 評価エラー（既存文言）| 評価は失敗・演奏継続（#645 方針）|
| `thru: false` の後ろに要素を書いた | エディタ診断（#644 の表の 1 行「到達不能」）| 赤線 | **止めない**（#649 §7.3）|
| forward-only 違反（後ろの bus から前へ）| daemon `parse_set_bus_line_params` | `DaemonProtocolError` → `console.error("SetBusLine(...) was rejected — routing was NOT applied")`（`sequence.ts:556-562` と同型）+ `_busRoutingStale` | 止めない・旧 program 継続 |
| device ch がデバイス幅を超える | daemon 検証 | `PARAM_OUT_OF_RANGE` → 同上 | 止めない |
| デバイス切替（`SelectAudioDevice` `:1331`）で幅が縮み既存 program の Device が範囲外になる | `rebuild_output_stream`（`output.rs:1473`）後の再検証（新設）| **該当 op を無音化し ERROR ログ**「output(3,4) exceeds device channels (2) — muted」| 止めない |
| 同一宛先へ 2 ライン → 合算でクリップ | 検出しない（意図された動作）| — | — |
| `LineProgram` 差し替えの取りこぼし（RT が古い program を読む）| `AtomicPtr` の Release/Acquire | — | 次 block で反映（音楽的精度不要・今日の `routing_override` と同じ）|
| retired program の回収漏れ（メモリ）| `generation` を RT が block ごとに publish・control は 2 世代後に free | leak はしない | — |
| daemon respawn で program が初期値に戻る | TS の intent cache を replay（`reapplyBusRoutingAfterRespawn` `:975` と同型の `reapplyBusLinesAfterRespawn`）| 失敗は `console.error`（既存規律）| — |
| `send("rev", 0.3)`（旧線形）を dB で読む | **検出できない**（静かに壊れる）| — | §9 golden で差分を式で示し、リファレンス / core spec MX.3 を同時改訂 |
| `SetBusLine` を非 `outproc-effect` ビルドへ送る | `#[cfg(not(feature = "outproc-effect"))]` 分岐で `UNSUPPORTED`（`:2251-2257` と同型）| `DaemonProtocolError` | 止めない |

---

## 9. 既存譜面の互換（#543-a を**先に**取る理由）

| 変更 | 既存の音 | 変わるか | golden の期待式 |
|---|---|---|---|
| `output(sum)` / `output` 無し / `output(n)` | | **不変**（裁定 ①・C・§2.1 既定）| RMS 全窓不変（許容 0）|
| `send("rev", 0.3)` → dB | 線形 0.3 | **変わる** | aux RMS: `旧 = 0.3 * dry` → `新 = 10^(0.3/20) * dry`。期待値側に `amount → 20·log10(amount)` を置く |
| `global.gain(-6)` | instrument に効いていない | **変わる**（正しくなる）| instrument 窓: `1.0 → 10^(-6/20)`（#649 受け入れ: 0.0886 → 0.044）|
| `seq.gain(-6)` + `effect` 併用 | ラック前で掛かる | **変わる**（既定位置がラック後）| dry/wet 比が変わる譜面のみ差分。比の式を期待値に |
| バス無し経路 | | **bit 一致** | `capture_realtime_gated.rs` と同型の bit 比較（§5.5 の Device{0,1} 配置）|

**PR-O0（#543-a）**: 上の 4 譜面を `tests/fixtures/mcp-e2e/` に置き、`captureInstrumentScenario`（`orbitstudio-mcp-gated.spec.ts:440-604`）で
窓 RMS を `tests/e2e/output-line-expectations.ts`（`rack-chain-gain-expectations.ts` と同じ「式で持つ」規律）へ固定する。
**裁定の実装 PR は、この期待値表の「変わる行」だけを更新する**（差分が式どおりであることが受け入れ）。

---

## 10. E2E 項目（すべて MCP 経由・`tests/e2e/orbitstudio-mcp-gated.spec.ts`・capture の数値で判定）

| # | シナリオ | 判定（RMS 比・許容 ±10% 目安・式は expectations に）|
|---|---|---|
| E2E-0 | バス無し譜面（`kick_loop.orbs`）を 2ch デバイスで | 実装前後の capture が **bit 一致** |
| E2E-1 | `global.gain(-6)` + instrument（既存 `#643 E2E-1` `:1434-1467`）| half/unity ∈ [0.45, 0.55]（今は落ちているはず → 本書で緑）|
| E2E-2 | `kick.output(verb, thru:true, db:-12).output(master)` | aux 経路 RMS / dry ≈ 10^(-12/20)・master は不変 |
| E2E-3 | `send(verb, -12)` と `output(verb, thru:true, db:-12)` の 2 譜面 | 両 capture の窓 RMS が一致（糖衣の証明・裁定 A）|
| E2E-4 | `thru: false` の後ろに `output(cue)` を書く | cue（ch3/4）は無音・master は有音（多 ch デバイス = BlackHole 16ch）|
| E2E-5 | `output(master, thru:true).output("3,4", db:-20)` | ch1/2 と ch3/4 の RMS 比 ≈ 10^(-20/20) |
| E2E-6 | pre / post: `output(verb, thru:true).effect([Gain(db:-12)])` vs `effect([Gain(db:-12)]).output(verb, thru:true)` | aux RMS が **2 譜面で 10^(-12/20) 倍違う**（#649 受け入れ 3/4）|
| E2E-7 | 演奏中に `output(…, db:)` を -60 → 0 へ差し替え | 遷移窓に不連続（peak スパイク）が無い（ramp の証明）|
| E2E-8 | 8ch デバイス（BlackHole）@ 2048 frames で instrument | 音が出る（今は無音・#611 本文）|
| E2E-9 | `outs: { "kick": bd }`（unit 0）| bd バスの RMS > 0・master 直行が無い |
| E2E-10 | daemon respawn 後 | E2E-2 の routing が復元される（RMS 同一）|
| E2E-11 | `kick.effect([Reverb]).output(master)` を再生中に `global.gain(0)` → `global.gain(-12)` へ | 直接音の窓と残響尾の窓の RMS **比**が変更前後で一致（±10%）。絶対値は 10^(-12/20) 倍（#649 受け入れ 2「フェーダーを下げても残響比が変わらない」）|

すべて `ok` に assert しない・ERROR 件数は `<=`・capture したら数値を見る（`gated-assertion-hygiene.spec.ts` が機械で守る）。

🔴 **前提（doc 668 §10 の実測）**: `analyzeWavBuffer`（`packages/vscode-extension/src/wav-analysis.ts:127-132`）は全チャンネルを加算平均して **mono に潰す**。E2E-4 / E2E-5（ch1/2 と ch3/4 の比較）は **PR-E3（`analyze_audio(per_channel: true)`・doc 668 §20）が先**でないと原理的に書けず、常に緑になる。
`dsl-e2e-coverage.spec.ts` の baseline から `send`（既に covered）は変化なし。`output` は covered 済み。

---

## 11. spec / 設計文書の改訂（実装より**先**・運用規則 6）

> 追記（2026-09-03・doc 610 との接点）: `docs/design/610-diagnostics-applicability-design.md` §3 の適用可否表は今日 `seq.gain` / `seq.pan` を midi・instrument で `warn` にしている（効かない事実）。本書 PR-O4 で `LineOp::Gain` がバスに乗った時点で **instrument の行を `ok` に更新する**（PR-O4 のチェック項目）。midi は引き続き `warn`。

| 文書 | 箇所 | 改訂 |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | MX.2（`:1657-1680`）| `output(destination, thru:, db:)`・宛先の集合（§2.2）・`"master"` 予約語・複数 output・合算規則 |
| 同 | MX.2.1（`:1682-1707`）| §14 (1) の裁定に従い「撤回」か「糖衣」に書き換え |
| 同 | MX.3（`:1709-1721`）| `send(name, db)`・**単位は dB**・「post-fader 固定」を削除（位置が意味）|
| 同 | MX.4（`:1723-1730`）| 「output は sum のみ / send は aux のみ」を削除。forward-only と「配列順 = トポロジカル順」は残す |
| 同 | MX.5（`:1732-1736`）| 「send は post-fader 固定」を削除 |
| 同 | §8.1.2（`:659-683`）| `output("master")` が LinkAudio 名にならないことを追記 |
| `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` | SC.4（`:132-149`）| aux 名メソッドの値は **dB**。「v1 は post-insert 固定」注記を削除 |
| 同 | SC.2.1 規範 (4)(7) | output ノードもレシーバ（`master.output(cue, thru: true)`）|
| `docs/design/649-audio-line-design.md` | §7.3 / §10.1 / §10.4 / §11 / §12 | 本書 §2.6 の表のとおり改稿（本書を正本とし、#649 側に「§10-§12 は 611 設計へ移管」と書く）|
| `docs/design/643-mixer-foundation-design.md` | §1.5 / §12 | 出口の一般化が本書で埋まったことを追記（`SourceDest { Master, Bus, Link }` は §5.6 のとおり残る）|

---

## 12. PR 分割（本書の範囲・詳細は IMPLEMENTATION_PLAN_2026-09.md）

| PR | 内容 | 層 | 概算 | 戻せるか |
|---|---|---|---|---|
| **PR-O0** | #543-a: §9 の 4 譜面の golden（fixture + expectations + gated E2E 4 本）| tests | +400 | 戻せる |
| **PR-O1** | spec 改訂（§11）| docs | +150/-60 | 戻せる |
| **PR-O2** | Rust: engine 内部幅 2ch + Device{0,1} 配置 + master line（`MasterLine`・`post` 移設）+ core gain を production から外す。**wire 無変更**。E2E-0/1/8 | native/daemon | +350/-80 | 戻せる（内部）|
| **PR-O3** | Rust: `LineProgram` / `LineSlot` / `SetBusLine` + 旧 `SetBusRouting` の内部を program 生成へ写す（互換維持）| native/daemon/protocol | +600/-150 | 🔴 **一方通行**（wire）|
| **PR-O4** | TS: `AudioLine` / `output(dest, thru, db)` / `send` dB / master・aux・device 宛先 / 名前付き引数スキーマ / `//#evalBegin,End` / respawn replay。E2E-2〜7 | engine/extension | +900/-300 | 🔴 **一方通行**（DSL 表面）|
| **PR-O5** | `outs:`（unit 0）+ passthrough stage + `SetSourceRouting` の kind 緩和。E2E-9 | engine/daemon | +250 | 戻せる |
| **PR-O6** | 旧 `SetBusRouting` / `_sumOutputBus` 系 / `#484 D4` 文言 / 旧テストの削除 | 全層 | -400 | 戻せる |
| （#647）| child N 出力・shm 拡張・カタログの outputs 記録 | child/sandbox/scan | +500 | 内部 |

---

## 13. 確信度と反証方法

| 判断 | 確信度 | 反証方法 |
|---|---|---|
| Device 宛ては master のラックを通らない（裁定 2 の読み）| 中 | owner に E2E-5 の譜面 1 例で確認。逆なら Device を master ラインの後段 op に限定する（§5.3 の 1 行変更）|
| engine 内部幅を 2 に固定して問題ない | 高 | `pan` が 2ch ゲート（`scheduler.rs:260`）・feeds が `CHANNELS = 2`（`transport.rs:58`）・598 設計「出力はステレオのまま」。反証 = 3ch 以上を内部で扱う要求（§14 (4)）|
| `LineProgram` の `Box<[_]>` + `AtomicPtr` は RT 契約を守る | 高 | RT は load + Cell 更新のみ。`cargo test` の RT 監査（`#628` の不変条件テスト）に op 走査を足す |
| ramp 5 ms で click が出ない | 中 | E2E-7 の peak 測定。出るなら ramp 長を伸ばす（定数 1 箇所）|
| `//#evalBegin/End` が既存メタ行 5 種と干渉しない | 中高 | `repl-mode.ts:65-105` の抽出順を unit で固定（#649 §14 判断 3）|

---

## 14. 🔴 owner 裁定待ち（設計に混ぜていない・他は着手可能）

| # | 未決 | 分岐 | 推奨 |
|---|---|---|---|
| (1) ✅ **A（owner 2026-09-03）**。ただし「必要になった時に糖衣として実装できる形」を保つ: `OutputDest` は閉じた union のまま、`output(n)` の分岐を**パーサ側で** `mix.render` の暗黙宣言に落とせるよう `RenderEndpointManager.declare` を再利用可能にしておく | **数値 render bus `output(n)`（MX.2.1）を撤回するか糖衣で残すか** | A 撤回: §3.3 手順 5 を削除し MX.2.1 を「#598 P1 の暫定形・`mix.render` へ移行」と書く / B 糖衣: `output(n)` ≡ 暗黙の `mix.render("<out_dir>/<n>.wav")` | **A**（P2 未出荷・宛先はすべて宣言ノードという裁定と整合）|
| (2) ✅ **A `db:`（owner 2026-09-03）** | `send` の名前付き引数名 | `amount:`（SC.4 現行）のまま単位だけ dB / `db:` に改名 | **`db:`**（`output(db:)` / `Gain(db:)` と揃う）|
| (3) ✅ **B 2 要素として両方加算（owner 2026-09-03・推奨から変更）**。制限は engine ではなく DSL の診断で（§3.1 `elementKey` 改訂） | 同じラインに同じ宛先の `output` を 2 回書いた時 | A 同一要素（後勝ち・位置は最後）/ B 2 要素として両方加算 | **A**（`elementKey` = 宛先キー。`send` の aux 名キーと同じ）|
| (4) ✅ **B ライン要素（owner 2026-09-03・推奨から変更・§2.4b）** | `pan` をライン要素にするか（#649 Q1）| 発音側のまま / ライン要素（バス上の L/R バランス）| **本書では発音側のまま**（bit 一致を守る・別 PR）|
| (5) ✅ **B 作る。ただし stereo→mono は片側を捨てず L+R をマージ（owner 2026-09-03）** | 単一チャンネル宛て（`mix.output(3)` / mono）| 作らない / `Device{left, right: None}` | **作らない**（stem 用途に要求なし・地図 §9）|
| (6) ✅ **DSL に書いてあるとおり（owner 2026-09-03）**: 漏らすか否かは `thru` で決まる。not-ready の channel は commit しないだけ（= 仮置きどおり・自動で master へ漏らさない）| LinkAudio が not-ready の時に master へ漏らすか捨てるか（#643）| | §5.3 の `Link(c)` は「ready でなければ加算しない = 捨てる」を仮置き |
| (7) ✅ **DSL に書いてあるとおり（owner 2026-09-03）**: kind による制限は設けない。cycle（後方参照）だけを **DSL の診断**で拒否し、engine の検証は安全網 | forward-only の中で sum→sum / aux→sum をどこまで許すか | 本書は **kind を問わず forward-only** | そのまま（順序分離は #643 §9 の後段）|
| (8) ✅ **ラック後を既定（owner 2026-09-03）。ただし位置は自由（§2.4b「表現を狭めない」）** | `seq.gain(固定)` の既定位置をラック後にすることで effect 併用譜面の音が変わる件 | 受け入れる / 既定をラック前にする | **ラック後**（DAW の fader = insert 後・#649 §14 判断 5 のとおり owner に音で提示）|

**2026-09-03 owner 裁定で 8 件すべて解消**（裁定シート Q-611-1〜8）。(3)(4)(5) は推奨から変更されたため §2.2 / §2.4b / §3.1 / §5.1 / §5.3 を改訂した。PR-O4 は着手可能。
