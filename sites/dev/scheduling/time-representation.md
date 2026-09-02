---
title: "II-1. 時間表現"
chapter-id: "II-1"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# II-1. 時間表現

OrbitScore は音楽を「いつ音を出すか」という問いに答えながら動きます。その答えを作るためには、**tempo・beat・bar** という概念を計算できる形に変換する必要があります。本章では、DSL の `global.tempo(120)` や `global.beat(4 by 4)` という記述がどのように内部で時間 (ms) に変換されるのか、実装を追って確認します。

## 2026-09-01 の再検証メモ

本章は 2026-05-05 (0a4b598) に書いた内容を 2026-09-01 (69dc968) の code に突き合わせて更新したものです。時間表現の核心 (`Meter` 型、`calculateBarDuration()` の式、`convertToAbsoluteTiming()`、`formatTiming()`) は 4 か月間まったく変わっていませんでした。変わったのは周辺です:

- `TimedEvent` に MIDI 用の optional フィールド (`pitch` / `scope` / `tie` など) と、live playhead 用の `argPath` (#390) が増えた
- `TempoManager.calculateEventTiming()` の末尾に #390 のコメントが入り、行番号がずれた
- 既定の音声バックエンドが SuperCollider から Rust daemon (`orbit-audio-daemon`) に切り替わった (cutover #108、2026-07-03)。ただし本章で扱う「ms への変換」は TS 側に残っており、バックエンドの違いは影響しません

## 基本的な時間の単位

OrbitScore の時間表現には 3 つの概念的な単位があります。

| 概念 | 説明 | 単位 |
|---|---|---|
| **tempo** | 1 分間に刻む 4 分音符の回数 (BPM) | bpm |
| **beat / meter** | 1 小節の拍の構成 (分子 / 分母) | — |
| **bar duration** | 1 小節の実時間の長さ | ms |

DSL ユーザーが見る世界は tempo と beat で記述されていますが、スケジューラーが扱う世界はすべて **ms 単位の浮動小数点数** です。

## Meter 型: 拍子の数値表現

拍子の情報は `Meter` という interface で表現されています。

```typescript
// packages/engine/src/core/global/types.ts:5-8
export interface Meter {
  numerator: number
  denominator: number
}
```

`numerator` (分子) と `denominator` (分母) をそれぞれ整数として持ちます。たとえば 4/4 拍子なら `{ numerator: 4, denominator: 4 }`、5/4 拍子なら `{ numerator: 5, denominator: 4 }` です。

ここで注目したいのは、`Meter` 型はあくまで「DSL の `beat(n1 by n2)` を構造化した入れ物」であって、**OrbitScore は有理数型を使っていない**という点です。`Fraction` や `Rational` という専用クラスは存在せず、分子・分母を整数で保持したあと、すぐに浮動小数点数の ms に変換します。

> NOTE: unverified — 将来のバージョンで有理数ライブラリを導入する計画があるかどうかは docs を確認していない。BEAT_METER_SPECIFICATION.md は計算例をすべて float で示しており、2026-09-01 時点では有理数型を使わない設計であることが読み取れる。

## Global の Tempo 管理

`Global` クラスの tempo と beat は `TempoManager` に委譲されています。

```typescript
// packages/engine/src/core/global/tempo-manager.ts:1-36
/**
 * Tempo and meter management for Global class
 */

import { Meter } from './types'

export class TempoManager {
  private _tempo: number = 120
  private _beat: Meter = { numerator: 4, denominator: 4 }

  // Note: tick and key have been removed
  // - tick: MIDI resolution, not needed for audio implementation
  // - key: Will be added when MIDI support is implemented

  // Property accessors with method chaining
  tempo(value?: number): number | this {
    if (value === undefined) {
      return this._tempo
    }
    this._tempo = value
    return this
  }

  beat(numerator: number, denominator: number): this {
    this._beat = { numerator, denominator }
    return this
  }

  // Get current state
  getState() {
    return {
      tempo: this._tempo,
      beat: this._beat,
    }
  }
}
```

デフォルト値は `tempo = 120`、`beat = 4/4` です。`tempo()` や `beat()` メソッドは **method chaining** を可能にするため `this` を返します。

## bar duration の計算式

tempo と meter が決まれば、1 小節の長さ (bar duration) を ms で計算できます。計算ロジックは `Sequence` の `TempoManager` に実装されています。

```typescript
// packages/engine/src/core/sequence/parameters/tempo-manager.ts:64-68
  private calculateBarDuration(tempo: number, meter: Meter): number {
    // 1小節の長さ = 4分音符の長さ × (分子 / 分母 × 4)
    const quarterNoteDuration = 60000 / tempo
    return quarterNoteDuration * ((meter.numerator / meter.denominator) * 4)
  }
```

この式を数式で表すと次のようになります。

$$
\text{quarterNote} = \frac{60000}{\text{tempo}} \text{ (ms)}
$$

$$
\text{barDuration} = \text{quarterNote} \times \frac{\text{numerator}}{\text{denominator}} \times 4 \text{ (ms)}
$$

具体例でイメージしてみましょう。

### 計算例

**例1: tempo = 60、beat = 4/4**

```
quarterNote = 60000 / 60 = 1000ms
barDuration = 1000 × (4 / 4 × 4) = 4000ms
→ 1拍 = 1秒、1小節 = 4秒
```

**例2: tempo = 60、beat = 5/4**

```
quarterNote = 60000 / 60 = 1000ms
barDuration = 1000 × (5 / 4 × 4) = 5000ms
→ 1拍 = 1秒、1小節 = 5秒
```

**例3: tempo = 120、beat = 7/8**

```
quarterNote = 60000 / 120 = 500ms
barDuration = 500 × (7 / 8 × 4) = 500 × 3.5 = 1750ms
→ 1拍（8分音符）= 250ms、1小節 = 1.75秒
```

数式の `× 4` は「基準が 4 分音符」という意味です。分母が 4 なら 4 分音符で割る、分母が 8 なら 8 分音符で割る、という拍子記号の音楽的意味をそのまま計算しています。

### 同じ式が quantize のグリッドにも使われている

面白いのは、この「4 分音符 × (分子/分母 × 4)」という式が `Sequence` の `TempoManager` だけでなく、launch quantize (`global.quantize("bar")` など、[II-4. transport](/scheduling/transport) で扱います) のグリッド計算にも独立して書かれている点です。

```typescript
// packages/engine/src/core/global/quantize-manager.ts:36-54
export function quantizeDurationMs(value: QuantizeValue, tempo: number, beat: Meter): number {
  if (value === 'off') return 0

  const quarterNoteMs = 60_000 / tempo
  const barMs = quarterNoteMs * ((beat.numerator / beat.denominator) * 4)

  switch (value) {
    case 'beat':
      return quarterNoteMs
    case 'bar':
      return barMs
    case '2bar':
      return barMs * 2
    case '4bar':
      return barMs * 4
    case '8bar':
      return barMs * 8
  }
}
```

`barMs` の行は `calculateBarDuration()` と文字どおり同じ式です。片方だけ直すともう片方とずれる、という典型的な「二重化された定数」なので、この式を触るときは両方を見る必要があります。なお `"beat"` は `quarterNoteMs` (4 分音符) を返すので、7/8 のような分母 8 の拍子でも「1 拍 = 4 分音符」として扱われます。core spec (INSTRUCTION_ORBITSCORE_DSL.md §5) は `"beat"` を「1 拍 (= `60_000 / tempo` ms)」と定義しているので、実装は spec どおりです。

## 一般化した計算フロー

```mermaid
flowchart LR
  DSL["DSL テキスト\nglobal.tempo(120)\nglobal.beat(4 by 4)"] --> TM["TempoManager\n_tempo=120\n_beat={4,4}"]
  TM --> CALC["calculateBarDuration()\n60000/120 × (4/4×4)\n= 2000ms"]
  CALC --> SCHED["Scheduler\n(RustEnginePlayer / EventScheduler)\nスケジュール時間 (ms)"]
```

DSL からスケジューラー (Rust daemon 経路では `RustEnginePlayer`、SC 経路では `EventScheduler`) に至るまで、時間は一度も「拍数」や「tick 数」という単位に変換されません。すべて **ms 単位の浮動小数点数**として一貫して流れます。Rust daemon 経路では最後の最後、daemon へ `PlayAt` を送る瞬間にだけ秒 (`time_sec`) へ変換されますが、それは [II-3. event queue と look-ahead](/scheduling/event-queue) で扱います。

## バーオフセット: 絶対時間への変換

bar duration が決まれば、n 番目の小節の開始時刻は次の関数で計算できます。

```typescript
// packages/engine/src/timing/calculation/convert-to-absolute-timing.ts:18-29
export function convertToAbsoluteTiming(
  events: TimedEvent[],
  barNumber: number,
  barDuration: number,
): TimedEvent[] {
  const barOffset = barNumber * barDuration

  return events.map((event) => ({
    ...event,
    startTime: event.startTime + barOffset,
  }))
}
```

`barOffset = barNumber × barDuration` を各イベントの `startTime` に加算するだけです。シンプルですが、これが「小節内の相対時刻」から「スケジューラーが使う絶対時刻」への橋渡しになっています。

## TimedEvent: スケジューラーの基本単位

タイミング計算の中間結果は `TimedEvent` という型で表現されています。2026-05 時点では 4 フィールドだけの小さな型でしたが、Pitch DSL (v1.1) と live playhead (#390) の実装で optional フィールドが大きく増えました。時間表現に関わるのは先頭の 4 つと、末尾の `argPath` です。

```typescript
// packages/engine/src/timing/calculation/types.ts:31-89 (MIDI 用の optional フィールド群を // ... で省略)
export interface TimedEvent {
  sliceNumber: number // 0 for silence, 1-n for slice (audio); = degree as a fallback for pitched MIDI events
  startTime: number // Start time in milliseconds relative to bar start
  duration: number // Duration in milliseconds
  depth: number // Nesting depth (for debugging)
  // ...
  argPath?: string
}
```

`startTime` と `duration` はどちらも ms です。`sliceNumber` は「何番目のオーディオスライスを再生するか」を指し、`0` は休符を意味します (MIDI シーケンスでは度数のフォールバックとしても使われます)。`depth` はネストしたパターン (`seq.play(1, [2, 3], 4)` のような入れ子構造) のデバッグ用フィールドです。

省略した optional フィールドは `pitch` (MIDI の symbolic pitch)、`scope` (`.root()` / `.mode()` / `.oct()` のレキシカルスコープ)、`tie` / `legato` / `voiceTie` (アーティキュレーション)、`random` / `randomOctave`、`velocity` / `velocityDelta` / `articulation` で、いずれも**時間計算には関与しません**。`startTime` / `duration` を決めるリズム木の走査は audio / MIDI で共通で、値の意味 (slice 番号か度数か) だけがドメインで変わる、というのが型コメントの説明です。

`argPath` は #390 (2026-07-07) で追加された観測専用フィールドです。`play()` の引数木のどの位置から来たイベントかを `"2"` や `"1.0"` のようなドット結合インデックスで持ち、バックエンドが dispatch 時に `[STEP]` マーカーを stdout に出すためだけに使われます。型コメントに「Never read by timing / scheduling logic」と明記されているとおり、これも時間表現には影響しません。

## デバッグ支援: formatTiming

`TimedEvent[]` を人間が読みやすい文字列に変換するヘルパー関数があります。

```typescript
// packages/engine/src/timing/calculation/format-timing.ts:17-38
export function formatTiming(events: TimedEvent[], bpm: number = 120): string {
  const lines: string[] = []
  const beatDuration = 60000 / bpm // ms per beat

  for (const event of events) {
    const startBeat = event.startTime / beatDuration
    const durationBeats = event.duration / beatDuration
    const indent = '  '.repeat(event.depth)

    if (event.sliceNumber === 0) {
      lines.push(
        `${indent}[silence] @ beat ${startBeat.toFixed(2)} for ${durationBeats.toFixed(2)} beats`,
      )
    } else {
      lines.push(
        `${indent}Slice ${event.sliceNumber} @ beat ${startBeat.toFixed(2)} for ${durationBeats.toFixed(2)} beats`,
      )
    }
  }

  return lines.join('\n')
}
```

この関数は ms から拍数に逆変換して表示します。注目したいのは、**内部では ms で計算しながら、デバッグ表示だけ拍数に戻す** という設計です。計算精度は ms のまま保ち、可読性のためだけに拍数表示を使っています。

## まとめ

OrbitScore の時間表現をひとことで言えば、「DSL は音楽的な単位 (tempo, beat) で記述し、実装はすべて ms に変換して扱う」です。

```mermaid
flowchart TB
  subgraph DSL["DSL 世界"]
    direction LR
    T["tempo(120)"] 
    B["beat(4 by 4)"]
  end

  subgraph IMPL["実装世界"]
    direction LR
    M["Meter {numerator, denominator}"]
    MS["barDuration (ms)\n= 60000/tempo × numerator/denominator × 4"]
    EV["TimedEvent[]\nstartTime: number (ms)\nduration: number (ms)"]
  end

  DSL --> IMPL
  M --> MS
  MS --> EV
```

変換の核心は `calculateBarDuration()` の 2 行の計算式です。この式を理解すれば、次章で扱う polymeter がなぜ自然に実現できるのか、という問いにも答えられます。

## 関連用語

- [DSL](/glossary#dsl) — OrbitScore が定義するドメイン固有言語。`tempo()` / `beat()` 構文が本章の時間表現の起点
- [chop](/glossary#chop) — オーディオファイルを等分割するメソッド。`TimedEvent` の `duration` フィールドと直結する
- [play パターン](/glossary#play-パターン) — サンプルのトリガー列。スケジューラーが ms に変換して並べる対象

## 次の深掘り候補

- `formatTiming()` の逆変換 (ms → 拍数) が浮動小数点誤差をどう扱っているか (`.toFixed(2)` の影響)
- `calculateBarDuration()` が `numerator / denominator × 4` という順序で計算することの数値精度への影響 (先に整数演算してから float にするとどう変わるか)
- BEAT_METER_SPECIFICATION.md の Phase 2 案 (分母を 2 の冪に制限する) が実装された場合、Parser 側での validation のコストとスケジューラー側への影響
- `length()` 修飾子が `_length` フィールドを通じて `effectiveBarDuration` に掛け算される仕組み (`tempo-manager.ts:99`)
- `calculateBarDuration()` と `quantizeDurationMs()` に二重化されている小節長の式を 1 か所に寄せられるか (`Global.msToBarBeat()` にも `(60_000 / tempo) * 4 / denominator` という同種の式がある)
- `TimedEvent` の MIDI 用 optional フィールドが output 段でどう解決されるか (`pitch` → MIDI ノート番号、`scope` → RootContext)

## Sources

- `packages/engine/src/core/global/types.ts:5-8` — `Meter` interface の定義 (`numerator`, `denominator` の整数フィールド)
- `packages/engine/src/core/global/tempo-manager.ts:1-36` — `TempoManager`: `_tempo` デフォルト 120、`_beat` デフォルト 4/4
- `packages/engine/src/core/sequence/parameters/tempo-manager.ts:64-68` — `calculateBarDuration()`: bar duration の計算式
- `packages/engine/src/core/sequence/parameters/tempo-manager.ts:73-105` — `calculatePatternDuration()` / `calculateEventTiming()`: length 修飾子の適用 (#390 のコメント込み)
- `packages/engine/src/core/global/quantize-manager.ts:36-54` — `quantizeDurationMs()`: 小節長の式の二重化先 (quantize グリッド)
- `packages/engine/src/timing/calculation/types.ts:31-89` — `TimedEvent` interface (`startTime`, `duration` が ms、MIDI 用 optional フィールドと `argPath`)
- `packages/engine/src/timing/calculation/convert-to-absolute-timing.ts:18-29` — `convertToAbsoluteTiming()`: barNumber × barDuration でオフセット計算
- `packages/engine/src/timing/calculation/format-timing.ts:17-38` — `formatTiming()`: ms → 拍数の逆変換 (デバッグ用)
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §5 "Launch Quantize" — `"beat"` = `60_000 / tempo` ms の定義
- [BEAT_METER_SPECIFICATION.md](https://github.com/signalcompose/orbitscore/blob/main/docs/development/BEAT_METER_SPECIFICATION.md) — 小節長計算式の仕様と将来の分母制約案
- Issue [#390](https://github.com/signalcompose/orbitscore/issues/390) — live playhead (`argPath` の追加理由)
