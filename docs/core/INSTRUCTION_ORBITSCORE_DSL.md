# INSTRUCTION_ORBITSCORE_DSL.md

## OrbitScore 2.0.0 — DSL Specification

> **Product version**: OrbitScore **2.0.0**
> `ENGINE_VERSION 2.0.0` / `DSL_VERSION 1.1`
> (audio engine line v3.0 + Pitch DSL v1.1)

This document defines the **OrbitScore DSL**.
It is the **single source of truth** for the project.
All implementation, testing, and planning must strictly follow this specification.

**Last Updated**: 2026-09-01
**Implementation Status**: ✅ OrbitScore 2.0.0 — v3.0 audio engine + v1.1 Pitch DSL (MIDI) Phases 1/2/3/R/4 implemented and tested
**Audio backend**: Rust `orbit-audio-daemon` is the default since cutover #108 (2026-07-03); SuperCollider (scsynth) remains as an opt-out backend via `ORBITSCORE_ENGINE=sc` (`packages/engine/src/audio/create-audio-engine.ts`). Plugin hosting (PH.*), catalog (PC.*), mixer (MX.*), import (IM.*) and the rack chain ([SIGNAL_CHAIN_DSL_SPEC_v1](../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10) are implemented on the Rust path only.

> 🎯 **進行中の v1.1 拡張（Pitch DSL / MIDI・Session Log・WCTM）の仕様は [`docs/specs-v2/`](../specs-v2/) が正本**（進捗は GitHub Epic #224）。
> ⚠️ 本番トラック retarget（2026-07-12・統括 [#413](https://github.com/signalcompose/orbitscore/issues/413)）: 藝大コンサート（2026-08-07）は不採択。旧「締切 2026-08-07」は失効し ICLC 提出方向へ retarget（年次・提出日・形態は要確認）。Max 必須の縛りも消滅。
> 各フェーズのゲート時に、当該機能のセクションを本ドキュメント（SoT）へ反映し、specs-v2 との乖離を作らないこと（指示書 §8.1-1）。
> 読み順: [IMPLEMENTATION_INSTRUCTIONS](../specs-v2/IMPLEMENTATION_INSTRUCTIONS.md) → [PITCH_DSL_SPEC_v1.1](../specs-v2/PITCH_DSL_SPEC_v1.1.md) → [SESSION_LOG_SPEC_v1](../specs-v2/SESSION_LOG_SPEC_v1.md) → [WCTM_SYSTEM_SPEC_v1](../specs-v2/WCTM_SYSTEM_SPEC_v1.md) → [DESIGN_DISCUSSION_RECORD](../specs-v2/DESIGN_DISCUSSION_RECORD.md)。

---

## 1. Initialization

### Global Context
```js
// REQUIRED: First, initialize the global context
var global = init GLOBAL
// This creates the global transport and audio engine
```

**Implementation Details**:
- Creates an instance of the `Global` class
- Initializes the audio backend (`createAudioEngine()` — Rust `orbit-audio-daemon` by default, SuperCollider with `ORBITSCORE_ENGINE=sc`)
- Sets up `Transport` system for scheduling
- Default values: tempo=120, beat=4/4
- **Variable naming**: The variable name "global" is conventional but not required - you can use any valid identifier (e.g., `var g = init GLOBAL`, `var master = init GLOBAL`)
- **Singleton behavior**: Re-executing `init GLOBAL` with the **same variable name** (e.g. re-running `var g = init GLOBAL`) reuses the existing instance. Binding `init GLOBAL` to a **different variable name** (e.g. `var master = init GLOBAL` alongside `var g = init GLOBAL`) creates a separate instance. In most live-coding workflows a single instance is the convention.

### Sequence Initialization
```js
// After global initialization, create sequences
var seq1 = init global.seq
var seq2 = init global.seq
// Or with any global variable name:
var kick = init g.seq
var snare = init master.seq
```

**Implementation Details**:
- Creates instances of the `Sequence` class through Global's factory method
- Each sequence maintains its own state (tempo, beat, length, audio, play pattern)
- Sequences inherit global parameters (tempo, beat) by default but can override them
- Each sequence is automatically registered with the global transport
- **Variable naming**: Sequence variable names are arbitrary and user-defined (common names: kick, snare, hat, bass, lead, etc.)

**Legacy Syntax Support** (for backward compatibility):
```js
var seq = init GLOBAL.seq  // Still supported but deprecated
```

**Session log (`.orbslog`)**: OrbitScore 2.0.0 ships a session-log writer (`.orbslog` files)
but it is **dormant by default**. Opt in with `ORBITSCORE_SESSION_LOG=1` env var.
A session-scoped format redesign is deferred to a post-2.0 release.

---

## 2. Global Parameters

After initialization, configure the global context:

### Tempo
```js
global.tempo(140)   // set global tempo to 140 BPM
```

### Meter (Time Signature)
```js
global.beat(4 by 4)   // equivalent to 4/4
global.beat(5 by 4)   // 5/4
global.beat(9 by 8)   // 9/8
global.beat(3, 4)     // alternative syntax: 3/4
```

### Audio Path (Search List)
```js
global.audioPath("../test-assets/audio")                  // 旧: 単一の base directory
global.audioPath("~/Clean-Samples", "./samples")          // v1.2.1+: 複数 search path (variadic)
global.audioPath(["~/Clean-Samples", "./samples"])        // v1.2.1+: 配列形式 (TypeScript ergonomic)
```

**Forms**:
- `audioPath()` — getter, returns the first entry as a string (legacy compat)
- `audioPath("a")` — single search path (legacy)
- `audioPath("a", "b", "c")` — variadic, multiple search paths in priority order
- `audioPath(["a", "b"])` — array form

各 entry には `~/` を home directory への展開記号として使える。相対 path は `.orbs` ファイル直下に対して解決。

**Audio file resolution rules** (適用順):

`.audio(spec)` の `spec` 文字列は次のいずれかとして解釈される:

1. **Path-direct** — `./`, `../`, `~/`, `/` で始まる、または `/` を含む
   → 既存挙動の path 解決 (`~/` は home に展開、相対 path は document directory 基準)

2. **Bank lookup** — bare name (separator なし)
   → `audioPath` の各 entry を順に traverse、`<entry>/<bank>/` フォルダ内の sorted Nth audio file を返す
   → variant index は `bd:N` 表記で指定 (file 数で modulo wrap)

3. **Legacy fallback** — bare name + 拡張子 (例 `kick.wav`) で bank lookup が hit しない場合
   → 各 entry 内に該当 file が物理的にあれば直接返す。なければ最初の entry と join (旧 `audioPath(string) + audio("file.wav")` 互換)

**Examples**:
```js
// 1. Path-direct
seq.audio("./pad.wav")           // ./pad.wav (そのまま)
seq.audio("/abs/path/kick.wav")  // /abs/path/kick.wav
seq.audio("~/sample.wav")        // ~ を home directory に展開

// 2. Bank lookup (TidalCycles 系 sample collection 互換)
global.audioPath("~/Clean-Samples")
seq.audio("bd")     // ~/Clean-Samples/bd/ 内の sorted 0 番目
seq.audio("bd:2")   // ~/Clean-Samples/bd/ 内の sorted 2 番目
seq.audio("hh:5")   // ~/Clean-Samples/hh/ 内の sorted 5 番目 (file 数で modulo)

// 3. Legacy join (互換)
global.audioPath("../audio")
seq.audio("kick.wav")  // ../audio/kick.wav (bank 不在時の fallback)
```

**Supported audio extensions** (大文字小文字不問): `wav`, `aif`, `aiff`, `mp3`, `mp4`, `flac`

**Resolution cache**:
- 解決結果は in-memory `Map` で cache
- `audioPath()` 再設定時または `setDocumentDirectory()` 変更時に invalidate
- live coding 中の繰り返し呼び出しを高速化

**Sample collection 案内**:
- ✅ [Clean-Samples](https://github.com/tidalcycles/Clean-Samples) (GPL-3.0、properly sourced) を最初の推奨
- ⚠️  [Dirt-Samples](https://github.com/tidalcycles/Dirt-Samples) は LICENSE file 不在で provenance largely unknown (yaxu maintainer 自認)。OrbitScore は bundle / auto-download せず、user 個人利用の判断に委ねる
- OrbitScore 自体は sample collection を再配布しない設計

**Note**:
- `key()` is implemented as part of the v1.1 Pitch DSL (`global.key()` — see P.1). It sets the numeric-root reference key for MIDI sequences; it is a no-op for audio-only sequences.
- `tick()` is not implemented (MIDI resolution concept; no implementation planned for audio-only path).
- Composite meters like `(4 by 4)(5 by 4)` are not currently supported.

---

## 3. Sequences

### Configuration
After initialization, sequences can be configured:
```js
seq1.tempo(120)       // independent tempo (polytempo support)
seq1.beat(17 by 8)    // independent meter (polymeter support)
seq1.length(2)        // loop length in bars (default: 1)
```

### Method Chaining
All sequence methods return the sequence object, allowing fluent chaining:
```js
// Multi-line (traditional)
var snare = init global.seq
snare.beat(4 by 4)
snare.length(1)
snare.audio("snare.wav")
snare.chop(4)
snare.play(0, 0, 1, 0)
snare.run()

// Single-line (method chaining)
var snare = init global.seq
snare.beat(4 by 4).length(1).audio("snare.wav").chop(4).play(0, 0, 1, 0).run()

// Or even more concise (if parser supports)
init global.seq.beat(4 by 4).length(1).audio("snare.wav").play(0, 0, 1, 0).run()
```

### Multiline Parentheses & Chaining
- 括弧で囲まれた引数リストやネスト構造は、**どのメソッド/関数でも改行を挟んで記述可能**です。
- `global.beat()` や `seq.play()`、今後導入予定の `RUN()` など、DSL全体で同じ書き方ができます。
- カンマ区切りを守れば閉じ括弧の位置・インデントも自由に整形できます。

```js
global.beat(
  5 by 4,
)

seq.audio(
  "../audio/snare.wav",
).play(
  (1, 0),
  2,
  (
    3,
    (4, 5),
  ),
)
```

> 注: `(1)(2)` のようなタプルネスト記法も改行混在で利用できます。閉じ括弧は任意の行に置いて構いません。

### Loop Length and Pattern Relationship
The `length` parameter defines how many bars the sequence loops over:
- `length(1)` with `.chop(4)` = 4 slices per bar × 1 bar = 4 elements in `play()`
- `length(2)` with `.chop(8)` = 4 slices per bar × 2 bars = 8 elements in `play()`
- `length(4)` with `.chop(16)` = 4 slices per bar × 4 bars = 16 elements in `play()`

### Slice Indexing in play()
When using `chop(n)`, the audio is divided into n slices numbered 1 through n:
- **0** = silence (no playback)
- **1 to n** = play slice number (1-indexed)
- Numbers can be reused and reordered freely

**Special case**: `chop(1)` means no division - the entire audio file is slice 1:
```js
// For drum hits - play the whole sample
kick.audio("kick.wav").chop(1)  // or just kick.audio("kick.wav")
kick.play(1, 0, 1, 0)           // Kick, silence, kick, silence

// For sliced loops
break.audio("break.wav").chop(8)  // Divide into 8 slices
break.play(1,3,2,1, 5,7,0,4)      // Rearrange slices
```

Example:
```js
seq1.beat(4 by 4).length(2)     // 2-bar loop in 4/4
seq1.audio("file.wav").chop(8)  // Creates slices 1-8
seq1.play(1,3,2,1, 5,7,0,4)     // Play: slice1, slice3, slice2, slice1, slice5, slice7, silence, slice4
seq1.play(1,1,1,1, 2,2,2,2)     // Repeat slices
seq1.play(8,7,6,5, 4,3,2,1)     // Reverse order
```

### Slice-to-Slot Fitting (varispeed)

A chop slice has a **natural length** (`fileDuration / chopDivisions`), but `play()` nesting
and `length()` decide the **event slot** the slice is scheduled into. When those two differ,
the slice is **time-scaled to fill its slot by varispeed** (a playback-rate change), exactly
like SuperCollider's `PlayBuf.ar(rate:)`:

- `rate = sliceNaturalDuration / eventSlotDuration`.
- `rate > 1` → the slice plays **faster** (shorter, **higher** pitch);
  `rate < 1` → **slower** (longer, **lower** pitch).
- **Pitch moves with the rate.** This is varispeed (like a turntable / sampler), *not*
  pitch-preserving time-stretch. A `rate = 2.0` slice sounds one octave up; `rate = 0.5`
  one octave down.

This is the slot-fitting behavior for **both** the SuperCollider engine and the Rust
engine (`ORBITSCORE_ENGINE=rust`); the two stay in parity. A *pitch-preserving* fit would
require time-stretch — see `fixpitch()` / `time()` / `stretch()` in §12.

#### 🔴 This section applies to `chop(n)` with **n > 1** only

**Without `chop()`, or with `chop(1)`, no slot fitting happens at all.**

| declaration | path | behavior |
|---|---|---|
| no `chop()` / `chop(1)` | `scheduleEvent` | 🟢 the **whole file plays at its natural rate and natural pitch**. It **rings past the slot** and **overlaps the next trigger** |
| `chop(n > 1)` | `scheduleSliceEvent` | the slice is varispeed-fitted into its slot (above) — **pitch moves** |

The branch is in `packages/engine/src/core/sequence/scheduling/event-scheduler.ts:111-138`
(`if (chopDivisions && chopDivisions > 1)`) — full path, because a second `event-scheduler.ts`
exists under `packages/engine/src/audio/supercollider/`.
`scheduleEvent` takes **no duration and no rate argument**, so there is nothing to scale by.

**The non-chop path is a feature, not an omission.** It is how you write a one-shot that
rings freely — a gong struck at the head of a long bar, a cymbal, a sample whose tail should
bleed into the next event. Reach for it whenever the sample's own length is the musical value.

```js
gong.beat(21 by 4).length(1)
gong.audio("EAF_Gong_05.wav").chop(1)   // 17.7 s, natural pitch
gong.play(1, 0, 0, 0)                    // struck every 10.0 s -> ~7.7 s of tail overlaps
```

> 🔴 **This paragraph exists because its absence caused a real misreading.** On 2026-08-31,
> two sessions independently concluded from this section that audio is *always* fitted to the
> slot, and computed a 16-semitone pitch error for a piece that was in fact playing correctly.
> The section named "chop slice" but never said what happens without one (#665).

---

## 4. Playback and Structure

### Play - Rhythmic Division with Nesting
The `play()` method divides time hierarchically using nested structures:

```js
seq1.play(1)                     // play slice 1 for whole bar
seq1.play(1, 2)                  // divide bar into 2: each gets 1/2
seq1.play(1, (2, 3))              // 1 gets 1/2, then 2&3 each get 1/4 (splitting the second 1/2)
seq1.play((1, 2), (3, 4, 5))     // first half: 1&2 (each 1/4), second half: 3,4,5 (each 1/6)
seq1.play(1, (0, 1, 2, 3, 4))    // 1 gets 1/2 (2 beats), then 5-tuplet in remaining 1/2
```

**Implementation Details**:
- Implemented via `TimingCalculator` class that recursively calculates timing
- Each nested structure creates a `TimedEvent` with `sliceNumber`, `startTime`, `duration`, and `depth`
- Parser supports both `(1, 2)` and `(1)(2)` syntax for nesting
- Timing is calculated based on bar duration (tempo × meter)

**Nesting Rule**: Each level of parentheses divides its parent's time duration:
- Top level divides the bar
- Nested elements divide their parent's time slot equally
- 0 = silence, 1-n = slice number from `chop(n)`

**Note**: Play modifiers like .chop(), .time(), and .fixpitch() are planned for future release but not yet implemented.

---

## 5. Transport Commands

### Launch Quantize (`quantize`)

`LOOP()` の起動と LOOP 中の `play()` 差し替えは、デフォルトで「現在進行中の小節が終わるまで待機」してから反映される。これは Ableton Live の Global Quantization と同様の挙動で、複数のループを並走させているときに新しいループが小節境界で揃って入る。`RUN()`(one-shot) は常に即時実行で、 `quantize` の影響を受けない。

```js
global.quantize("bar")   // default. 次の小節頭まで待機
global.quantize("off")   // 旧来通り即時実行 (live coding でトリガー感を残したい場合)
global.quantize("2bar")  // 2 小節に 1 回だけ受け付ける
global.quantize("beat")  // 1 拍単位 (グローバル meter の denominator 基準)
```

**設定可能な値:**

| value | 意味 |
|---|---|
| `"off"` | 即時実行 (legacy 挙動) |
| `"beat"` | 1 拍 (= `60_000 / tempo` ms) |
| `"bar"` | 1 小節 (グローバル `beat()` 基準) **default** |
| `"2bar"` | 2 小節 |
| `"4bar"` | 4 小節 |
| `"8bar"` | 8 小節 |

**シーケンス側 override:**

```js
seq.quantize("off")    // この seq だけ即時起動 (drop / fill 用)
seq.quantize("2bar")   // この seq だけ 2 小節間隔
```

`seq.quantize()` 未指定時はグローバル値を継承する。

**スコープ:**

- 影響する: `LOOP()` の新規起動、 LOOP 中の `play(...)` 差し替え。
- 影響しない: `RUN()` (常に即時)、 LOOP 中の `gain()` / `pan()` / `audio()` / `chop()` (常に即時)、 LOOP 中の `tempo()` / `beat()` / `length()` (もとから次サイクル待機)。

**ポリメーター時の挙動:**

`quantize` のグリッドは「グローバル `beat()` × `tempo()`」で決まる。 `seq.beat(5 by 4)` のような per-seq meter override がある場合でも、グローバル小節境界が起動の基準。シーケンス自身の小節境界に揃えたい場合は post-1.1 で別オプションとして検討。

### Global Transport
Available on `global`:

```js
global.start()            // start scheduler immediately (LOOP()/seq.loop() quantize to the next bar boundary; global.start() itself does not wait)
global.stop()             // stop scheduler
```

### Sequence Transport - Reserved Keywords (Unidirectional Toggle)

**DSL v3.0 introduces片記号方式 (unidirectional toggle)**:

Use uppercase reserved keywords to control multiple sequences with **unidirectional toggle** semantics:

```js
RUN(kick)                 // Include ONLY kick in RUN group (one-shot playback)
RUN(kick, snare, hihat)   // Include ONLY kick, snare, hihat in RUN group

LOOP(bass)                // Include ONLY bass in LOOP group (others auto-stop)
LOOP(kick, snare)         // Include ONLY kick, snare in LOOP group (hat stops if it was looping)

MUTE(hihat)               // Set ONLY hihat's MUTE flag ON (others OFF, applies only to LOOP)
MUTE(snare, hihat)        // Set ONLY snare and hihat's MUTE flags ON (others OFF)
```

**Unidirectional Toggle Behavior (片記号方式)**:
- **RUN group**: Lists sequences for one-shot playback. Only listed sequences are included.
- **LOOP group**: Lists sequences for loop playback. **Sequences not listed are automatically stopped.**
- **MUTE group**: Sets MUTE flag ON for listed sequences, OFF for others. **MUTE only affects LOOP playback**, not RUN.
- Each command **replaces** the entire group with the new list (unidirectional - inclusion only)

**Why no STOP or UNMUTE keywords?**
- **STOP is unnecessary**: Use `LOOP(other_sequences)` to stop unwanted sequences automatically
- **UNMUTE is unnecessary**: Use `MUTE(other_sequences)` to unmute by exclusion
- This design simplifies the DSL and makes the state explicit and predictable

**RUN and LOOP Independence**:
- RUN and LOOP are **independent groups** - the same sequence can be in both simultaneously
- When a sequence is in both RUN and LOOP, it plays both one-shot AND loops
- Example: `RUN(kick)` then `LOOP(kick)` → kick plays one-shot AND loops

**MUTE Behavior**:
- MUTE is a **persistent flag** that only affects LOOP playback
- Like a mixer mute button: LOOP continues but produces no sound
- **MUTE does NOT affect RUN playback** - RUN sequences always play with sound
- MUTE flag persists even when sequence leaves/rejoins LOOP group

**Examples:**
```js
// Setup
var kick = init global.seq
var snare = init global.seq
var hat = init global.seq

global.start()

// Include kick and snare in RUN group
RUN(kick, snare)              // kick and snare play one-shot

// Replace LOOP group with only hat
LOOP(hat)                     // Only hat loops (kick/snare NOT looping)

// Both RUN and LOOP
RUN(kick)                     // kick plays one-shot
LOOP(kick)                    // kick ALSO loops (independent)

// MUTE only affects LOOP
LOOP(kick, snare, hat)        // All three loop
MUTE(hat)                     // hat loops but muted (kick/snare unmuted)
RUN(hat)                      // hat plays one-shot WITH sound (MUTE doesn't affect RUN)

// Changing groups
LOOP(kick, snare, hat)        // All three loop
LOOP(kick)                    // Only kick loops (snare and hat auto-stop)

// MUTE persistence
MUTE(kick)                    // kick's MUTE flag ON
LOOP(kick, snare)             // kick loops (muted), snare loops (unmuted)
LOOP(snare)                   // kick stops, but MUTE flag persists
LOOP(kick)                    // kick loops again, still muted (flag persisted)
MUTE(snare)                   // kick's MUTE flag OFF, snare's MUTE flag ON
```

**Benefits of Reserved Keywords:**
- **Clearer intent**: `RUN(kick, snare)` is more readable than `kick.run()` followed by `snare.run()`
- **Unidirectional control**: One statement defines the entire group state
- **Live coding friendly**: Quick bulk updates with multiline support

**Multiline support:**
```js
RUN(
  kick,
  snare,
  hihat,
)

LOOP(
  bass,
  lead,
)

MUTE(
  hihat,
)
```

### Editor Execution
- Any `global` or `seq` transport command can be executed by selecting it in the editor and pressing **Command + Enter**.
- Reserved keywords (`RUN`, `LOOP`, `MUTE`) can also be executed this way.

---

## 6. Audio Playback

### File Loading
```js
seq1.audio("../audio/piano1.wav").chop(6)  // Divide into 6 slices
seq1.audio("../audio/kick.wav").chop(1)     // No division (whole file)
seq1.audio("../audio/kick.wav")             // Default: chop(1)
```
- `.chop(n)` divides file into n equal slices (numbered 1 to n)
- `.chop(1)` or omitting `.chop()` = no division (entire file is slice 1)
- Supported formats: `wav`, `aif`, `aiff`, `mp3`, `mp4`, `flac`
- SR/bit depth follow the system hardware (scsynth default); for LinkAudio match session SR via `global.linkAudio(SR)`

**Common patterns**:
- Drum hits: Use `.chop(1)` or omit - triggers entire sample
- Loops/Breaks: Use `.chop(8)`, `.chop(16)` etc. for slicing and rearrangement

### Play with Audio
```js
seq1.play(1)           // play slice 1
seq1.play(1, 2, 3, 4)  // play slices in sequence
```

**Note**: Audio manipulation features like fixpitch() and time() are planned for future release but not yet implemented.

---

## 7. Underscore Prefix Pattern (Setting vs. Application) - v3.0

> ⚠️ **設計のみ・2.0.0 では未実装 / planned, not implemented**
>
> `_method()` 形式は DSL v3.0 設計上の概念として定義されているが、
> OrbitScore 2.0.0 時点ではトークナイザーが行頭の `_` を `UNDERSCORE` トークンとして扱うため、
> `seq._play()` 等のアンダースコアプレフィックスメソッドはパーサーで**解析エラー**になる。
> `_method()` を定義したメソッド実装も存在しない。以下は設計意図の記録として残す。
>
> (**English summary**: The `_method()` forms described here are **design intent only**.
> The tokenizer emits a leading `_` as an `UNDERSCORE` token; `seq._play()` etc. fail to
> parse, and no `_`-prefixed method implementations exist in 2.0.0.)

**DSL v3.0 introduces a consistent pattern for all configuration methods:**

### The Pattern: `method()` vs. `_method()`

- **`method(value)`**: **Setting only** - stores the value but does NOT trigger playback or apply immediately
- **`_method(value)`**: **Immediate application** - sets the value AND triggers playback/applies immediately

This pattern applies to ALL configuration methods that can affect running sequences.

### Applicable Methods

#### Sequence Configuration Methods

All sequence configuration methods follow this pattern:

```js
// Setting-only methods (no underscore)
seq.audio("file.wav")     // Set audio file (no playback)
seq.chop(8)               // Set chop divisions (no slicing applied yet)
seq.play(1, 2, 3, 4)      // Set play pattern (no playback)
seq.beat(4 by 4)          // Set meter (no timing change yet)
seq.length(2)             // Set loop length (no change yet)
seq.tempo(140)            // Set tempo (no tempo change yet)

// Immediate application methods (with underscore)
seq._audio("file.wav")    // Set audio file AND apply immediately (triggers playback if running)
seq._chop(8)              // Set chop divisions AND re-slice immediately
seq._play(1, 2, 3, 4)     // Set play pattern AND start playback immediately
seq._beat(4 by 4)         // Set meter AND apply timing change immediately
seq._length(2)            // Set loop length AND apply immediately
seq._tempo(140)           // Set tempo AND apply immediately
```

#### Global Configuration Methods

Global also supports underscore methods for parameters that affect all sequences:

```js
// Setting-only methods (no underscore)
global.tempo(140)         // Set global tempo (no immediate effect on sequences)
global.beat(4 by 4)       // Set global beat (no immediate effect on sequences)

// Immediate application methods (with underscore)
global._tempo(140)        // Set global tempo AND update all sequences that inherit it
global._beat(4 by 4)      // Set global beat AND update all sequences that inherit it
```

**Inheritance behavior**:
- When a sequence hasn't overridden tempo/beat, it inherits from global
- `global._tempo()` triggers seamless parameter updates for all inheriting sequences
- `global._beat()` triggers seamless parameter updates for all inheriting sequences
- If a sequence has overridden a parameter (e.g., `seq.tempo(160)`), it ignores global changes

### Real-Time vs. Buffered Parameters

**Real-time parameters** (apply immediately regardless of playback state):
- `gain(dB)` and `_gain(dB)` - both apply immediately
- `pan(position)` and `_pan(position)` - both apply immediately
- These are mixer-style controls that should respond instantly

**Buffered parameters** (timing-dependent):
- Non-underscore: Buffered until next `run()` or `loop()` call
- Underscore: Applied immediately even during playback

### Usage Patterns

**Pattern 1: Setup phase (before playback)**
```js
// During setup, use non-underscore methods (cleaner, no redundant playback triggers)
var kick = init global.seq
kick.audio("kick.wav")
kick.chop(4)
kick.play(1, 0, 1, 0)
kick.beat(4 by 4)
kick.length(1)

// Start playback
global.start()
kick.run()                // Now all settings are applied
```

**Pattern 2: Live coding (during playback)**
```js
// Sequence is already running
kick.run()

// Non-underscore: Changes are buffered, applied at next run()/loop()
kick.play(1, 1, 0, 0)     // Pattern buffered, not applied yet
kick.run()                // NOW the new pattern is applied

// Underscore: Changes apply immediately
kick._play(1, 1, 0, 0)    // Pattern applied immediately, playback restarts
```

**Pattern 3: Real-time mixing**
```js
// These always apply immediately (mixer-style controls)
kick.gain(-6)             // Immediate
kick._gain(-6)            // Immediate (same effect)
kick.pan(-50)             // Immediate
kick._pan(-50)            // Immediate (same effect)

// But other parameters are buffered without underscore
kick.tempo(160)           // Buffered
kick._tempo(160)          // Applied immediately
```

### Benefits

1. **Clear Intent**: Underscore makes it explicit when you want immediate effect
2. **Performance**: Avoid redundant operations during setup phase
3. **Live Coding**: Quick updates with `_method()` during performance
4. **Consistency**: Same pattern across all configuration methods

### Default Behavior

For backward compatibility and ease of use:
- `defaultGain(dB)` - sets initial gain without triggering playback (use before `run()`)
- `defaultPan(position)` - sets initial pan without triggering playback (use before `run()`)
- `gain(dB)` / `pan(position)` - apply immediately during playback (real-time controls)

---

## 8. DAW Integration

OrbitScore は 2 系統の DAW 連携経路を持つ:

- **Audio out → Ableton Link Audio (Live 12.4+)** ... v1.2.0 で導入。 名前付きチャンネルを LAN 上で stream する。 詳細は §8.1。
- **MIDI out → IAC Bus**: macOS IAC Bus で routing 予定。 v1.2.0 では未実装、 別 Issue で扱う。

DAW 側 (Ableton Live 等) にプラグインを別途 install する形式は採らない。 OrbitScore の出力経路は scsynth (hardware bus) または Link Audio (名前付き channel) のいずれか。

### 8.1 Ableton Link Audio Output

LinkAudio は Live 12.4 (2026-05-05 公開) で導入された Link の上位互換。 tempo / beat / phase / start-stop の同期に加えて、 LAN 上で名前付きの音声 channel を publish / subscribe できる。 ライセンスは GPL-2.0-or-later / proprietary commercial の dual。 OrbitScore は publisher 側 (Sink) のみを実装する。

#### 8.1.1 Global mode declaration

ファイル単位で LinkAudio 出力モードに切り替えるには、 `global.linkAudio()` を **once-per-file** で宣言する。 既存の `global.tempo()` 等と同じ scope (state-setting メソッド)。

```orbs
global.tempo(120)
global.linkAudio()           // LinkAudio mode を有効化、 target SR は plugin が auto-detect (fallback 48000)
global.linkAudio(48000)      // 明示的に target SR を指定 (override)
```

宣言中は **全 sequence が LinkAudio 経由** に出力される。 hardware (scsynth Out.ar) との混在は不可。 宣言なしの .orbs ファイルは従来通り hardware 出力のみ。

target sample rate は plugin 内で scsynth (hardware SR) の出力をリサンプリングするための値。 LinkAudio 自身は内部リサンプリングを行わないため、 publisher と subscriber (Live) の SR が一致しないと連続的なサンプルドロップが発生する (Live default 48kHz と異なる場合は必ず明示する)。

#### 8.1.2 Per-sequence channel binding

各 sequence の出力チャンネル名を `seq.output(name)` で指定する。 channel name は ASCII 英数 + `-` + `_`、 max 64 chars 推奨 (LinkAudio 仕様には明示的な上限なし)。

```orbs
global.linkAudio()
var s = init global.seq
s.audio("../audio/kick.wav").output("kick")        // → Live で channel "kick" を受信
```

同名 channel を指定した複数 sequence は **plugin 内で加算合成 (sum)** される。 これにより drums bus 等の汎用的な再生制御が DSL 側 1 行で実現できる。

```orbs
global.linkAudio()
var k = init global.seq
var s = init global.seq
k.audio("kick.wav").output("drums")
s.audio("snare.wav").output("drums")               // kick と snare が同 channel に合成されて Live で受信
```

**Strict mode (v1.2.0+)**: `global.linkAudio()` を宣言したファイル内では、 全ての発音 sequence が `.output(name)` で channel を宣言する必要がある。 `.output()` を持たない sequence が `.play()` した時点で **runtime error** を投げる (`Sequence.resolveDispatchChannel`)。 これは「LinkAudio mode 中は全 sequence が LinkAudio 経由」 という §8.1.1 の宣言と整合させるための strict 制約で、 hardware 出力との silent fallback は行わない (hardware/LinkAudio 混在は不可、 §8.1.1 参照)。 編集時には VS Code 拡張が `analyzeLinkAudioMissingOutput` で同等の error 診断を出す (§11)。

**MIDI 例外**: `seq.midi()` で宣言した MIDI sequence は strict mode の `.output()` 要件から**免除**される。MIDI sequence は SC audio bus ではなく MIDI bus にルーティングされるため、LinkAudio channel binding は不要 (#282)。`seq.instrument()` で宣言した instrument sequence も同様に免除される（plugin 経路にルーティングされるため。ただし v1 では `global.linkAudio()` と plugin hosting の同時使用自体が不可 — Plugin Hosting PH.5 参照）。

`global.linkAudio()` 未宣言で `seq.output()` を呼んだ場合は別経路: channel name は記録されるが hardware path に流れ、 `.output()` 呼び出しのたびに console に警告が出る (LinkAudio mode を有効化し忘れたケースのフェイルセーフ。警告は dedup されず毎回発火する)。 編集時の order-violation 検出は §11 参照。

#### 8.1.3 Plugin lifecycle

LinkAudio mode は scsynth プロセス内で動作する SC plugin (`OrbitLinkAudio.scx`、 GPL-2.0-or-later 別 artifact) に依存する。 plugin の load / unload は scsynth 起動 / 終了に紐づく。 ランタイム切替 (演奏中の LinkAudio on/off) は v1.2.0 では非対応。

plugin が load されていない状態で `global.linkAudio()` を宣言した場合は hardware path にフォールバックし警告を出す。この警告は **`global.linkAudio()` 宣言時ではなく、最初のディスパッチ（再生）時**に発火する。 plugin の有無は `EventScheduler.setLinkAudioPluginAvailable()` を経由してブート pipeline (Step 4) が flip する。

#### 8.1.4 Live 側の操作

1. Live 12.4+ を起動、 セッション SR を 48kHz (デフォルト) または `global.linkAudio(SR)` で指定した SR に合わせる
2. Audio トラックの "Audio From" で OrbitScore peer の channel name を選択
3. OrbitScore 側で sequence を再生 → Live のメーターで受信を確認

tempo / beat / phase / Start-Stop は LinkAudio に内包された Link 機能を用いる。**OrbitScore は Link テンポリーダー**として動作する (#283): `global.tempo()` で設定した BPM が Link ピアに push され、Ableton Live はそれに追従する。**Live 側からのテンポ変更が OrbitScore に反映される機能は 2.0.0 では未実装**（Live のテンポを手動で変えても OrbitScore のテンポは変わらない）。

---

## 9. Implementation Notes

- Parser must support nested `play` structures for hierarchical timing
- IR must represent play structures as tree-like data for timing calculation
- Scheduler must handle independent sequence tempos (polytempo) and meters (polymeter)
- Audio engine is the Rust daemon by default (SuperCollider opt-out); both satisfy the `AudioEngineBackend` seam (`packages/engine/src/audio/engine-backend.ts`)
- Global underscore methods (_tempo, _beat) must trigger seamless parameter updates for inheriting sequences

**Future Additions**:
- Audio manipulation features (fixpitch, time) will require time-stretch and pitch-shift implementation
- Composite meters may require complex timing calculation algorithms
- tick/key will be added when MIDI support is implemented

---

## 10. Testing Guidelines

- **Parser**: Verify meter parsing, nested play structures, variable initialization
- **Timing**: Ensure timing calculations are correct for nested play structures and different meters
- **Audio**: Confirm playback speed matches tempo and sequences synchronize correctly
- **Transport**: Global and sequence transport commands function as specified
- **Underscore Methods**: Verify immediate application behavior for all _method() calls
- **Inheritance**: Test that sequences inherit global parameters correctly and seamless updates work

---

## 11. VS Code Extension Features

### Autocomplete and IntelliSense

- **No abbreviations/shortcuts in DSL**: Maintain full readability with descriptive names
- **Smart autocomplete**: VS Code extension provides intelligent suggestions
  - `global.` → suggests `tempo()`, `_tempo()`, `beat()`, `_beat()`, `start()`, `stop()`, `gain()`, etc.
  - `seq1.` → suggests `audio()`, `chop()`, `play()`, `tempo()`, `beat()`, `length()`, `run()`, `loop()`, `mute()`, etc.
  - Method signatures with parameter hints
- **Snippet expansion**: Type-ahead for common patterns
  - `init` → expands to `var seq = init GLOBAL.seq`
  - `play` → expands to `seq.play()`
- **Hover documentation**: Inline help for all methods and parameters
- **Parameter hints**: Shows expected types and values as you type

### Design Philosophy

Instead of creating abbreviated forms that reduce readability (e.g., `gl.tem()`), we prioritize:
1. **Full, descriptive method names** for clarity
2. **Fast input via autocomplete** for efficiency
3. **Code readability** for collaboration and maintenance

This approach ensures code remains self-documenting while maintaining fast input speed.

### Context-Aware Autocomplete

**Implementation Status**: ✅ Fully implemented in VS Code extension

The extension provides intelligent suggestions based on method chain context:

```js
// After 'var seq = init global.seq'
seq.┃  // Suggests: audio(), beat(), length(), tempo()

// After 'seq.audio("file.wav")'
seq.audio("file.wav").┃  // Suggests: chop(), play(), run()

// After 'seq.audio("file.wav").chop(8)'
seq.audio("file.wav").chop(8).┃  // Suggests: play(), run()

// After 'seq.play(1, 2, 3)'
seq.play(1, 2, 3).┃  // Suggests: run(), loop(), mute()

// After 'global.'
global.┃  // Suggests: tempo(), _tempo(), beat(), _beat(), start(), stop(), loop(), gain()
```

**Method Order Rules**:
- `audio()` must come before `chop()` and `play()`
- `beat()`, `length()`, `tempo()` can be called anytime after init
- `play()` typically comes after `audio()` (with or without `chop()`)
- `run()`, `loop()`, `mute()` are usually final in the chain
- Underscore methods (_audio, _chop, _play, _tempo, _beat, _length) can be used during live coding for immediate updates

---

## 12. Complete Usage Example

```js
// STEP 1: Initialize global context first
var global = init GLOBAL

// STEP 2: Configure global parameters
global.tempo(120)
global.beat(4 by 4)

// STEP 3: Initialize sequences from global
var kick = init global.seq
var bass = init global.seq
var lead = init global.seq

// STEP 4: Configure sequences
kick.beat(4 by 4).length(1)
bass.beat(4 by 4).length(2)
lead.beat(4 by 4).length(4)

// STEP 5: Load audio and create patterns
kick.audio("kick.wav").chop(4)
kick.play(1, 0, 0, 1)

bass.audio("bass.wav").chop(8)
bass.play(1, 0, 0, 1, 0, 0, 1, 0,
          0, 1, 0, 1, 0, 0, 0, 0)

lead.audio("synth.wav").chop(16)
lead.play((1, 0, 0, 0), 0, 0, (1, 0, 0, 0),
          0, 0, 0, 0, 0, 0, 0, 0,
          1, 1, 1, 0)

// STEP 5b: Set initial gain/pan (before playback)
kick.defaultGain(-3).defaultPan(0)
bass.defaultGain(-6).defaultPan(-30)
lead.defaultGain(-9).defaultPan(30)

// STEP 6: Start playback
global.start()

// STEP 7: Use reserved keywords for transport control
RUN(kick, bass, lead)
LOOP(kick, bass)
MUTE(kick)          // Mute kick in LOOP (RUN still plays with sound)

// STEP 8: Live manipulation (real-time changes during playback)
bass.gain(-12)      // Real-time gain change
lead.pan(0)         // Real-time pan change
global._tempo(130)  // Change global tempo for all inheriting sequences
```

---

## Pitch DSL (v1.1 — MIDI Output)

The v1.1 line adds a **MIDI output path** and a **symbolic pitch language** on top of
the v3.0 audio engine. A sequence is an *audio* sequence (values = slice numbers) **or**
a *MIDI* sequence (values = degrees) — never both. The two paths can run side by side in
the same file. `0 = rest` in both domains, and the `( )` rhythm-division tree is shared.

> **Canonical source**: this is the implemented-feature reference. The full design,
> rationale, and edge cases live in [`docs/specs-v2/PITCH_DSL_SPEC_v1.1.md`](../specs-v2/PITCH_DSL_SPEC_v1.1.md)
> (the `§N` pointers below refer to it). Where this section and specs-v2 ever disagree,
> specs-v2 wins and this section is the bug.

### P.1 MIDI output declaration (§1)

> Note: `global.key()` (the numeric-root reference key set here) is part of the root/key/scale
> surface that is slated for a post-2.0 redesign. See the ⚠️ callout in P.5 for details.

```js
var piano = init global.seq
piano.midi("IAC", 1)   // (portName substring, channel 1-16) → makes this a MIDI sequence
piano.octave(4)        // base octave: the octave of degree 1. default 4 (C4 = 60)
piano.vel(96)          // default velocity 1-127. default 96
piano.gate(0.8)        // default gate: sounding fraction of a slot. default 0.8

global.key("C")        // numeric-root reference key (note-name token)
global.key("D3")       // #253 key-center register: note + octave → tonic D, degree 1 at octave 3
                       //   (the whole piece's register in one place; seq.octave() still overrides)
global.midiLatency(20) // fixed send offset in ms (for ear-matching the SC path). default 0
```

- `portName` resolves by case-insensitive substring match against CoreMIDI output ports
  (multiple matches → first + warning; no match → error listing available ports).
- A `midi()` sequence interprets `play()` values as **degrees**. Combining `midi()` with
  `audio()`/`chop()` is an error. Running alongside the SC audio path is allowed (no
  LinkAudio-style exclusivity).

### P.2 Degrees and pitch resolution (§2.1)

Degrees are an **Ionian-relative interval vocabulary** plus accidentals — `b3` is "a minor
third above the root" in *any* context (quality is carried by the notation, not by walking
back to a scale declaration).

```
IONIAN = [0, 2, 4, 5, 7, 9, 11]   // semitones for degrees 1..7
semitones = IONIAN[(n-1) mod 7] + 12*floor((n-1)/7) + alteration
pitch     = rootPitch + semitones + 12*range          // range = sticky ^N (P.3)
rootPitch = 12*(octave+1) + rootPitchClass            // C4 = 60
```

- Accidentals: `b = -1`, `#` = +1, `bb`/`##` = ±2 (stacking allowed, warns beyond 2).
- **Accepted degrees = {1–9, 11, 13}** (decision #38): 1–7 Ionian, 8 = octave root (≡ `1^1`),
  9/11/13 = tensions. **10, 12, 14, ≥15 are an error** — write octaves with `^N`
  (e.g. `3^1`), not as large linear numbers. v1.1 takes no backward-compat here.
- `0 = rest`.

### P.3 Pitch range `^N` (sticky) and detune `~` (§2.4)

```js
3^1      // set running range to +1 octave; STICKY — persists for following degrees
3^-1     // down an octave (sign required for down; `^+N` plus is optional)
1^0      // back to base range
0^2      // a rest that silently shifts the range to +2
b7~-0.25 // detune in semitones (pitch-bend; ±2 semitone bend range for now)
```

- `^N` is a **linear / persistent** range state attached to a note or rest. It runs in
  read (time) order and resets only at the top of each `play()` or on a later `^M`/`^0`.
- A bare `^N` marker (no note) is a syntax error — use `0^N`.
- **`^N` (linear) and `.oct(N)` (lexical/group, P.5) are orthogonal axes** (§9.4): `^N`
  does **not** reset at `.root()` or group boundaries; `.oct(N)` closes a range to a group.
- For a stack/chord, `^N` sets the whole chord's register; a voice's own `^N` (P.7 voicing)
  is structural on top and does **not** move the running range (a chord is one slot).

### P.4 Mode scope (§2.2, E6)

```js
var dorian = mode(1, 2, b3, 4, 5, 6, b7)                  // a pitch lattice (degree 1 = lattice[0])
var custom = mode(1, 2, b3, 4, #5, 6, 7, 9).period(19)   // explicit period (semitones)
seq.play((1, 3, 5, 7).mode(dorian))                       // in C dorian: C Eb G Bb (60 63 67 70)
```

- A `mode` is a user-defined pitch lattice written in root-scope degree notation. Inside a
  `(...).mode(name)` scope a melodic degree `n` is a pure index into the lattice:
  `pitch = rootPitch + lattice[(n-1) mod len] + period * floor((n-1)/len)` (degree 8 wraps to
  the next period). The `{1-9,11,13}` Ionian acceptance does **not** apply (any length is
  allowed); an accidental alters the looked-up lattice tone.
- `.period(n)` defaults to the next octave boundary above the **highest** element (code uses
  `max`, so non-ascending lattices get a valid period; 12 for a typical 7-note church mode);
  non-octave / microtonal periods are allowed. The `2↔9` tension wrap-around does **not** hold
  in a mode (the lattice need not be 7 notes).
- A mode rides on the sequence's root (key tonic or `seq.root()`); `.root()` and `.mode()` are
  mutually exclusive on one group (§3). A mode name used as a play *value* warns (it is a scope).

### P.5 Scope rules — `.root()` / `.mode()` / `.oct()` group chains (§3, Phase 2)

> ⚠️ **post-2.0 redesign pending**: the root/key/scale surface (P.1 `global.key()`, P.5
> `.root()`/`.mode()` scope) is slated for revision after 2.0.0 (`.root()` removal, postfix
> roots `(...)I`/`(...)F`, key-carrying default lattice). See
> [`docs/development/POST_2.0_PITCH_MODEL_NOTES.md`](../development/POST_2.0_PITCH_MODEL_NOTES.md).
> **Do not rewrite these sections** — the note is a forward-compatibility marker only.

`.root()`, `.mode()` (P.4) and `.oct()` attach as method chains to a `( )` rhythm-tree group.

```js
seq.root(1)               // sequence default pitch context (numeric degree; seq-level root is numeric-only)
                          // group-level .root() takes a note name: (...).root(F)
seq.play(
  (9, 5, (3, 1), [1,3,5,7]).root(2),     // this group resolves at root = II
  ((1, b3).root(b6), 5, 1).root(2),       // inner .root(b6) wins for its half-slot
  (1, 5, 1, 5),                           // no chain → sequence default
)
```

- Resolution order: inner group → outer group → sequence default (`seq.root()`)
  → error (a degree with no default set is a diagnostic). Unspecified spans fall back to the
  sequence default — **stateless** (the previous scope is not retained).
- **`seq.root()` is numeric-degree-only** (`seq.root(1)`, `seq.root(b6)`); note-name root works
  only at group level (`(...).root(F)`). Using a note name at seq level is an error (#280;
  redesign pending).
- **`.mode()` is group-scope only**: `(...).mode(name)` — no `seq.mode()` setter exists.
  A sequence-default mode is not implemented.
- `.root(F)` (group level) takes a note-name token; `.root(3)` a diatonic degree of `global.key()`;
  `.root(b6)` a non-diatonic degree (resolved by P.2). Numeric root with no `global.key()`
  is an error (note-name root only at group level).
- **A chain applies to a whole juxtaposition run**: `(...)(...)... .root(X)` shares the
  pitch context across siblings (each keeps its own time slot) — the standard "one chord
  over several bars" notation. A chained group followed by `(` with no comma is a parse
  error ("expected comma after chained group"). Duplicate scope on one group
  (`.root(2).root(5)`, or root + mode together) is a diagnostic error (no last-wins).

### P.6 Brackets — `( )` / `[ ]` / `{ }` (§4)

| Notation | Meaning | Time | MIDI realization |
|----------|---------|------|------------------|
| `( )` | rhythm division (existing) | parent slot split evenly by element count | — |
| `[ ]` | **stack** (simultaneous) | all voices share the full parent slot | simultaneous note-on |
| `{ }` | **legato group** | same split as `( )` | note-off delayed past the next note-on (overlap) |

- A `[ ]` voice can itself be a subtree: `[1, (5, 3, 2, 1)]` holds degree 1 while a 5-3-2-1
  line runs in the same span (intra-part polyphony).
- `{ }` overlap is implementation-defined (10–30 ms after the next note-on; 20 ms used). The
  group-tail note follows the normal gate. A `[ ]` inside `{ }` overlaps all its voices.

### P.7 Chord values (§6, Phase 3)

```js
import chords                          // stdlib: m7, maj7, dom7, m7b5, dim7, sus4, ...
var m7      = [1, b3, 5, b7]           // root-unbound degree stack (a value); bare [ ] (#48)
var m7omit5 = [m7, -5]                 // spread + literal removal
var m7add9  = [m7, 9]                  // spread + add
var so_what = [1, 11, b7^+1, b3^+1, 5^+1]
```

- A chord value is a **bare `[ ]` degree stack** (§6 decision #48 — the `chord([...])` wrapper
  was removed). The var-binding type follows the bracket: `[ ]` = vertical (chord value),
  `( )` = horizontal (pattern variable, §6.5) — the same discriminant as in `play()`.
- A chord value resolves against the **scope where it is placed** (root/mode) — *root is the
  context, chord is the value*. Spreading happens inside a `[ ]` stack or as a bare element.
- `-N` removes the **literal-matching** voice (degree + alteration) from the spread; no match
  → no-op + warning. `m7^+1` shifts the whole chord an octave (same `^N` token). Builder APIs
  (`.add()`/`.omit()`) are not adopted — everything is value composition.

### P.8 Ties, voice leading (§5, Phase 4)

```js
play(1, _, 3)                 // `_` event tie: extends the PREVIOUS event one slot (no retrigger)
play([1,3,5], _)              // a `_` after a stack extends the WHOLE chord
play([1, 3, _5], ...)         // `_n` voice tie: prefix inside a stack
piano.hold()                  // auto common-tone tie between consecutive stacks
play({1, 3, 5})               // `{ }` slur: smooth (overlapping) connection
```

- **`_` event tie**: extends the previous *event* (for a stack, every voice) by one slot. A
  leading `_` or a `_` after a rest extends nothing (a rest breaks the tie chain).
- **`_n` voice tie**: "if the resolved pitch is already sounding in this sequence, suppress
  the note-off/on and hold; otherwise play normally." Matching is by **resolved pitch**, not
  by voice position — safe across chords of different sizes and live swaps.
- **`.hold()`**: auto-applies the voice tie to every common tone, but **only between two
  stacks** (a repeated single note never auto-ties, so rhythm is preserved — decision #8).
  Settable per-sequence and per-group (`(...).hold()`).

### P.9 Repetition `*n` and pattern variables (§6.5, Phase R — domain-shared)

These are rhythm-tree structure operations, independent of pitch — they work the same for
MIDI and audio sequences.

```js
1*3                            // ≡ (1)(1)(1) — n juxtaposed copies (a bare event → a 1-group)
(0, m7, 0, m7)*4.root(3)       // postfix is left-to-right; the .root() covers all 4 copies
var riff = (1, 0, (3, 5), 7)   // pattern variable — a bare-tuple value, no constructor
var AA   = (1,0,5,0)(0,5,1,0)  // a juxtaposition binding → splices as multiple siblings
var A    = (1,0,5,0), (0,5,1,0)  // #254 SECTION: comma-separated multi-cell binding
seq.play(riff*3, fill, AA)
seq.play(A, A, B, A)           // song form (AABA) — sections spliced and reused
```

- `n` is an integer ≥ 1: `*0` is an error, `*1` is identity.
- **Tidal difference (must be documented to users)**: Tidal `*` is *in-slot* division
  (n times within one slot); OrbitScore `*n` *occupies n slots* (≡ Tidal `!`). For in-slot
  repetition, nest: `(1, 1)`.
- **Evaluation-time value semantics**: a variable is substituted when `play()` is evaluated.
  Redefining it does not retro-affect a running pattern (re-run the `play()` line). No
  reactive binding. A chord value is a *vertical* value; a pattern variable is a *horizontal*
  (tree) value.
- **Section variables** (#254, §6.5 Q2 revised): a top-level **comma** in a pattern binding
  separates *section cells* (`var A = (bar1), (bar2), …`), spliced as siblings at the use
  site — `play(A, A, B, A)` writes a song form. (A comma-less juxtaposition `(..)(..)` shares
  one root-scope run; a comma ends the run, exactly as in `play()`.)

### P.10 MIDI realization rules (§7)

- **Symbolic preservation**: the TimedEvent pipeline carries symbolic pitch (degree,
  alteration, octave shift, the root/mode context, tie/legato flags); resolution to a MIDI
  note number happens **only** in the final output stage (a future real-time score-rendering
  epic depends on this — never flow resolved numbers through the pipeline).
- **Note lifecycle**: each event → note-on(vel), note-off after `slotDuration * gate`; a tie
  suppresses the note-off/on pair, legato delays the note-off.
- **Active-note tracking / cleanup**: per-sequence sounding notes are released on LOOP
  exclusion, MUTE, and `play()` swap (note-off the held notes); `global.stop()` / engine
  shutdown / crash sends CC123 (All Notes Off) + CC120 (All Sound Off) on all channels.
- **Scheduling**: a TS-side lookahead scheduler (RtMidi sends immediately); `midiLatency()`
  is added to the send time. Detune is realized by pitch bend; bend is per-channel, so
  different detunes sounding on one channel at once collide (last bend wins) — the canonical
  spec specifies a warning for this case, but it is not yet implemented. MPE is out of scope.

### P.11 Per-note expression — `@v` velocity / `@g` articulation (正本 PITCH_DSL_SPEC §2.5 / DESIGN §10.3, E5)

The two expression axes (decision #41): velocity and articulation. Per-note `@` postfix
modifiers; `@u` absolute duration (v1.0 `@U`) is **rejected** — duration is carried by the
tree + ties.

```js
5@v110          // absolute velocity 110 (1..127) — overrides seq.vel()
5@v+20  5@v-30  // velocity relative to seq.vel() (an accent / de-emphasis)
5@g30           // articulation = gate PERCENT: 30 = 0.30 (staccato) — overrides seq.gate()
5@g120          // 120 = 1.20 gate (legato-leaning); the axis `{ }` legato also lives on
5@v100@g30      // compose; also orthogonal to `^N` / `~` / `r`
```

- **`@v`** = velocity. Absolute `@v<n>` (1..127) or relative `@v+<n>`/`@v-<n>` (accent,
  added to `seq.vel()` and clamped). An accent is just a velocity boost — no separate token.
- **`@g`** = articulation as a gate **percent** (`@g30` = 0.30). It is the per-note point on
  the same axis as `{ }` legato (`@g` > 100 rings past the slot). Overrides `seq.gate()` for
  that note. Integer/percent args avoid a decimal point splitting the token.

### P.12 Voicing operators & randomness (正本 PITCH_DSL_SPEC §6.1–6.2 / DESIGN §12)

Postfix operators on a chord value / `[ ]` stack that raise the abstraction of *how* a
chord is voiced and add aleatoric comping. Full design + rationale: [`DESIGN_DISCUSSION_RECORD.md`](../specs-v2/DESIGN_DISCUSSION_RECORD.md) §12 (decisions #47–53).

```js
[1,3,5,7].drop(2,4)    // drop the 2nd & 4th voices from the top an octave (drop2&4)
[1,3,5,7].invert(2)    // raise the bottom 2 voices an octave
m7.open() / m7.close() // open / close position; .shell() = R+3+7; .rootless() = drop the root
[1,3,5,7].r            // random thinning: each voice ~50% to sound this cycle (.r(p) to tune)
(1, 3, 5r, 7)          // `Xr`: this element randomly sounds or rests
5^r                    // `^r`: a random octave (±1) this cycle
```

- **Voicing operators** (`.drop(n...)` / `.invert(n)` / `.open()` / `.close()` / `.shell()` /
  `.rootless()`) are **deterministic, evaluation-time, symbolic** — sugar over per-voice `^N`
  (or a voice filter), so they preserve §7-0 symbolic pitch and compose with `.root()`/`.oct()`.
  "Position N from the top" counts the structural (written/ascending) order. Method form,
  parens required (like `.hold()`). `.drop(...)`/`.invert(n)` take positions; the rest take none.
- **Randomness** (`Xr` / `.r` / `.r(p)` / `^r`) is **runtime, per-cycle re-rolled**: `Xr` =
  element presence (default 0.5), `.r` = chord thinning — **rolls once per slot; all voices in
  the stack thin together** (not independently per voice; no minimum-voice guarantee — silence is
  allowed), `^r` = random octave ±1. `r` is one primitive whose effect depends on its position.
  Reproducibility is by `.orbslog` (execution record, not a result recording) — random re-rolls
  on replay; no seed (decisions #50/#52/#53).
- **`.comp`** (jazz comping rhythm) is implemented as a *primitive* macro — see P.14 (comp C2a).

### P.13 Auto voice-leading — `.voicelead()` / `.vl()` (正本 PITCH_DSL_SPEC §6.3, comp C1, #269)

Connects consecutive **chord stacks** with minimal voice motion (octave placement only;
pitch classes preserved). The deterministic foundation `.comp` builds on.

```js
([1,3,5], [5,7,2]).voicelead()   // C→G: the B drops an octave to stay near C/E/G
seq.voicelead()                   // sequence default (alias: seq.vl())
```

- **Deterministic, context-dependent, computed once** — NOT eval-time (unlike §6.1 voicing) and
  NOT per-cycle (unlike §6.2 randomness). It needs absolute pitch (the resolved root context), so
  it runs as a once-run output-stage pass and writes each voice's `octaveShift` back symbolically;
  `^N` / `.oct()` / `^r` still layer on top (§7-0 preserved). Independent of `.r`/`Xr` thinning.
- Attaches at **group** `(...).voicelead()` and **sequence default** `seq.voicelead()` (same scope-chain
  mechanism as `.root()`/`.oct()`). Operates on ≥2-voice chords; single notes pass through. The first
  chord keeps its authored placement; later chords lead from it. Authored `^N` octaves are subsumed.
- Algorithm: equal voice-count = sorted + n cyclic rotations (min L1, crossing-free); unequal = lead
  min(n,m), extras at octave 0 (C1 simplification; full bipartite is C2+). **Limitation**: L1-minimal
  does NOT guarantee tendency-tone resolution or parallel-5th/8ve avoidance — "smooth by default, user
  controls specifics."

### P.14 Comping rhythm — `.comp()` / `.cell()` / `.density()` (正本 PITCH_DSL_SPEC §6.4, comp C2a, #271)

A *primitive* macro: each argument is one bar's chord, expanded by a comping **cell** into an
ordinary play pattern (so chord resolution / timing / `.voicelead()` compose unchanged — no parser
change). `N` chords → `N` bars (`length` set to `N`).

```js
piano.comp([1,3,5], [5,7,2])           // 1 chord/bar; default cell = charleston
piano.cell("quarters").comp([1,3,5])   // charleston / redgarland / offbeats / quarters / twofour
piano.density(0.6).comp([1,3,5])       // cell-less: density 0..1 (0 = laying out)
piano.comp([1,3,5], [5,7,2]).voicelead()  // composes with §6.3
```

- **Cells are meter-independent fixed subdivisions** (charleston = 8 slots, quarters/twofour = 4).
  The bar is cut into the cell's own slot count, so an even-grid cell over an odd meter rides an
  intentional **polymeter** (e.g. 8-against-3) — a feature, composable with the multi-layer time
  structure. The meter sets the bar's real duration; the cell sets how many equal parts.
- **Off slots are rests; stab length is `gate`** (predominant comping is articulated/short — Freddie
  Green flat-four; sustained/let-ring is a future option). Density mode places `round(d×8)` onsets
  evenly across 8 equal bar divisions (an eighth-note grid in 4/4).
- **Scope boundary**: `.comp` is the *mechanism* (which onsets, what subdivision). The *intelligence*
  — choosing the cell/voicing, density shaping, when to sustain, reacting to a soloist — is **out of
  DSL scope (comp C3)**: it belongs to an LLM bandmate skill that live-codes the DSL, keeping the DSL
  a controllable primitive set rather than an auto-composer (philosophy: user/AI control, not autogen).

---

## Plugin Hosting (CLAP effect / instrument)

> ⚠️ **一部未実装 / partially implemented**
>
> 本節は Issue #425（2026-07-13・owner 設計セッション + Fable 検証）で確定した構文仕様。
> DSL 疎通は #426（effect・PR #432）/ #427（instrument + Pitch DSL 接続）ともに実装済み。
> **VST3 instrument hosting は #421（PR #447・2026-07-17 マージ）で実装済み**（`seq.instrument()` が
> `.vst3` を受理）。VST3 effect 側も child プロセスの READY handshake（#445・PR #446）を経て
> `global.effect()` が `.vst3` を受理する。名前指しで同名の CLAP / VST3 が存在する場合は CLAP を優先する。VST3 instrument のスコープは note on/off のみ
> — CC 制御（IMidiMapping 相当）・per-note expression・tempo 連動（#408）は明示的に先送り。
> 残るスコープは #428（note timing のサンプル精度化）のみ。
> Option A/B/C の比較経緯は `docs/development/POST_2.0_VST3_HOSTING_PLAN.md` §6、
> 決定の記録は Issue #425 / WORK_LOG を参照。

OrbitScore engine（Rust daemon）は CLAP / VST3 プラグインをホストする配管を持つ
（CLAP effect = PR #397 / CLAP instrument = PR #422 / VST3 instrument = #421 PR #447 /
VST3 effect child handshake = #445 PR #446）。本節はそれを DSL から消費する構文の正本。

### PH.1 instrument — `seq.instrument(path[, pluginId][, statePath])`

```js
var synth = init global.seq
synth.instrument("~/plugins/Surge XT.clap")   // 種別宣言＝出口宣言
synth.octave(4).vel(100)
synth.play(1, 3, 5, 0)                        // 値は度数（Pitch DSL と同じ）

var keys = init global.seq
keys.instrument("Kontakt 8.vst3", "keys.vstpreset")  // 保存済み state で音色を選択（#540 P2）
```

- **state 復元（#540 P2・VST3 のみ）**: 第2/第3引数に **`.vstpreset` / `.state`** で終わる
  パスを渡すと、保存済みプラグイン state を child 起動時に復元して音色を選択する
  （`.vstpreset` は他 DAW で書き出した Steinberg 標準 container・raw な component state
  chunk も可）。引数の判別は**拡張子ヒューリスティック** — `.vstpreset`/`.state` で終われば
  state、さもなくば pluginId（3引数形 `instrument(path, pluginId, statePath)` は明示指定）。
  相対パスは **document directory 基準**で解決する（音源検索パスは使わない — state は
  プロジェクトの資産で、暗黙検索による別プロジェクト同名 state の誤読を避ける）。
  復元失敗はロード失敗として表面化する（default 音のまま黙って鳴らさない）。daemon respawn
  後の再ロードでも state は再適用される。CLAP は v1 未対応（明示エラー）。

- `.midi(port, ch)` と同型の**シーケンス種別宣言 verb**。宣言したシーケンスは
  **note シーケンス**となり、`play()` の値は度数として解釈される。
- `.audio()` / `.midi()` と**相互排他**（同じ throw パターン。1 シーケンス 1 出口）。
  audio シーケンスの `play()` 意味論には一切影響しない。
- 度数解釈・リズム木・Pitch DSL §7 realization rules を MIDI シーケンスと共有する
  （`octave` / `vel` / `gate` / `root`、mode / chord / `[ ]` / tie / voicing 適用可）。
- **v1 実現マトリクスの例外**: detune `~` は不可（plugin 経路に pitch bend / CC がない
  ため warn + skip）。`global.midiLatency()` は MIDI 送出専用のため非適用。
- 出力は**当該シーケンスの insert bus に源流として合流**し、per-sequence の effect チェーン /
  send / 出力先ルーティングの対象になる（#517 S4 で master 直行から移設）。ルーティング未宣言時の
  既定の行き先は従来どおり master であり、global gain / master effect insert / capture の対象で
  あることは不変。
  > **移設の理由**: 移設前は instrument の音が master の post processor で add-mix されており
  > （`engine_wrap.rs` の `CompositePostProcessor`）、**seq バスグラフを一切通らなかった**。
  > このため SC.0 の `lead.Serum(...).TALReverb4(size: 0.6).subout` — 楽器にエフェクトを挿し
  > 出力先を指定する記述 — が原理的に成立しなかった（DSL 層も note シーケンスへの
  > `output()` / `send()` を拒否していた）。#522 の到達点「SC.0 の完全実行」には移設が必須である。
  >
  > **v1 の現在地**: **✅ 実装済み（#643・2026-08-29）**。PR-1a（#527）時点では未移設で、
  > instrument の出力は master の `CompositePostProcessor`（`rust/crates/orbit-audio-daemon/src/engine_wrap.rs`）に
  > 後付け加算されていた。#643 以降、instrument の音は master への後付け加算ではなく
  > **ミキサーの source** として `render_multi` の内側（event 混合後・gain ramp の前）で
  > 合流する。`seq.effect()` / `seq.output(sum)` / `seq.send()` は **instrument で使える**。
  >
  > | メソッド | midi | instrument |
  > |---|---|---|
  > | `effect()` / `output(sum)` / `send()` | **拒否**（MIDI は外部機器へ送出するためミキサーの出力先を持たない） | **✅ 使える** |
  > | `output(数値)` = オフライン render bus | 素通り（#644 で診断予定） | **拒否**（録音経路が未設計） |
  > | `output("LinkAudio チャンネル名")` | 素通り（同上） | **拒否**（PR-3 で配線予定） |
  >
  > アドレスは **`(instance, unit)`**（`SetSourceRouting { source, unit, target }`）。
  > 現在 `unit` は **0 固定** — 子プロセスが常に main 出力のみを返すため。
  > マルチティンバー（unit ≥ 1）は **#647**、ミキサーの出口（物理チャンネル指定）は **#611**。
  >
  > 設計正本: `docs/design/643-mixer-foundation-design.md`
- RUN / LOOP / MUTE / quantize の意味論は MIDI シーケンスと同一。

### PH.2 effect — `global.effect(path[, pluginId])`

```js
global.effect("~/plugins/TAL-Reverb-4.clap")   // master bus insert
```

- **master bus への単一 insert**（全シーケンスに掛かる）。global master effects
  （compressor / limiter / normalizer）と同じ「master バス処理は global スコープ」の
  役割分担に従う。
- v1 は 1 基のみ。**同一 path + pluginId の再宣言は冪等（no-op）** — ライブコーディングの
  ファイル全体再評価を壊さないため（PH.4 の instrument 冪等と同じ原理）。
  **異なる path / pluginId での再宣言は差し替え**（#625・意味論は PH.2d）。
- **チェーン（複数 insert）は #628 のラック形で入る**（正本 = `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`
  **SC.10**）。表記は配列 — `global.effect(["A", Gain(db: -6)])`。`[...]` が直列、`layer([...])` が並列
  （並列は PDC とセットで後続・SC.10.11）。**「複数回呼び出しが直列チェーンになる」形は採らない**
  （後勝ちの単位が呼び出しではなく配列全体になるため — SC.10.3b）。

### PH.2b per-sequence effect — `seq.effect(path[, pluginId])`（#434）

```js
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("~/plugins/TAL-Reverb-4.clap")   // この seq だけに掛かる insert
```

- **シーケンス個別の insert**（DAW の per-track insert と同型）。処理順は
  **per-sequence insert → master mix → `global.effect()`（master chain）** — 既存の
  master 経路の意味論は不変。
- v1 は **1 seq = 1 insert**。同一 path + pluginId の再宣言は冪等（no-op・PH.2 と同じ
  ライブ再評価保護）。**異なる path / pluginId での再宣言は差し替え**（#625・意味論は
  PH.2d）。**チェーン（複数 insert）は #628 のラック形で入る**（PH.2 と同じ・正本 SC.10）。
  > 🔴 **訂正（#628）**: ここには以前「チェーンは将来拡張（エンジン内部は順序付きリストで
  > 実装済み・DSL 側のガード解放のみ）」と書かれていたが、**これは誤りである**。順序付き
  > リストを持っていたのは **TS 側の帳簿（`EffectChainMap`）だけ**で、その長さは常に 1 だった。
  > daemon は **1 bus = 1 child** であり、**ガードを外しても複数 insert は持てない**。
  > 実際にチェーンを持つには child 側の機構（1 child が N プラグインを直列に回す rack child）
  > が要る — それを作るのが #628 である。
- **受理フォーマットは effect と同じ**: `.clap` / `.vst3` を受理し、`.component` は未対応。
- **エンジン実装（規範）**: `seq.effect()` 宣言はエンジンの **named insert bus** を確保し、
  当該シーケンスの再生イベントに bus tag を付けてスケジュールする。bus は宣言時点で
  登録され、**plugin の attach 完了前でも音は素通しで master に届く**（宣言 → attach の
  間に音が消えたり詰まったりしない）。plugin ロード失敗時も bus は pass-through で残る。
- **既知の v1 制約（非目標）**: plugin latency 補償（PDC）なし — 複数 seq に latency の
  異なる insert を掛けると bus 間で位相がずれる。master gain ramp は per-sequence insert の
  **前**に適用される（DAW の「fader は insert 後」と逆・master unity なら影響なし）。
  insert を同時に持てるシーケンス数には上限がある（既定 8・エンジンは RT 安全のため
  bus を起動時にプールとして確保し、宣言時にプールから割り当てる）。上限超過の
  `seq.effect()` 宣言は明示エラー。
- LinkAudio との併用不可は PH.5 に従う（`global.effect()` と同じ v1 排他）。
- **将来予約（非規範）**: aux バス / send-return（pre/post-fader tap・fan-out）は同じ
  insert bus 基盤の上に実装する（#453・正本 = `POST_2.0_MIXER_DSL_DESIGN.html`）。

### PH.2d insert の差し替え・削除（#625）

**master（PH.2）/ per-sequence（PH.2b）/ sum・aux（MX.2・MX.3）の 4 経路すべてに同じ規則が
適用される。** 正本は `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.5（失敗モデル 2 型）。

> 🔴 **#628 でモデルが確定した。** 以下は #625 時点の v1 実装（1 insert・`remove()`）の記述で
> あり、**ラック形（複数 insert・`layer`・配列からの削除）へ移行する**。正本は
> `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10**、経緯は
> `docs/archive/design/628-effect-chain-model.md`。移行後は `remove()` は撤回される。

```js
sum("drum").effect("TAL-Reverb-4")   // 挿す
sum("drum").effect("ValhallaRoom")   // 差し替え（エンジン再起動なし）
sum("drum").remove("ValhallaRoom")   // 外す（#628 で撤回予定）
```

**移行後（SC.10）**:

```js
sum("drum").effect(["TAL-Reverb-4"])                    // 挿す
sum("drum").effect(["ValhallaRoom"])                    // 差し替え
sum("drum").effect([])                                  // 外す（配列から消す）
```

**移行後の要点（SC.10 の要約 — 詳細は正本を参照）**:

- **後勝ち**。生き残る要素は **LCS**（最長共通部分列）で対応づけられ、**対応がついた要素は
  音を止めずに生き続ける**。**出現順はインスタンスに固定**され、テキストから数え直さない。
- **削除は配列から消す**こと。**`remove()` は撤回**（SC.10.3c）。
- **`enabled: false` はその合成の単位元** — 直列では素通し、並列では無音（SC.10.2）。
  状態は保持されるので、戻せば同じ音色で復帰する。
- **ラックは値（レシピ）**。`var` に束縛しただけではプラグインは起動せず、レシーバへ適用された
  時に起動する。同じラックを複数のレシーバへ適用してもインスタンスは共有されない（SC.10.4）。
- **標準プラグイン**（`Gain(db: -6)` のような大文字呼び出し）は**アプリ同梱の CLAP** で、
  UI も state ファイルも持たない。パラメータは DSL が正である（SC.10.8）。

---

以下は #625 時点（1 insert・`remove()`）の記述:

- **異なる spec での再宣言 = 差し替え**（後勝ち）。エンジン再起動も楽譜の再評価も要らない。
- **明示削除は `remove("名前")`**（**#628 で撤回**）。名前は現在挿さっている insert の正規化名と
  一致する必要があり、一致しなければエラー（黙って別のものを消さない）。v1 は 1 insert なので
  出現順指定 `remove("名前", n)` は `n = 0` のみ受理する。**bus は解放されない** —
  `seq.output()` / `seq.send()` の routing は insert が無くなっても生き続ける。
- **差し替え・削除の直前に、旧 insert の state（音色）は自動保存される**。旧 spec を再宣言
  すればその音色が復元される。保存に失敗した場合は差し替えを中止し、旧 insert を保持する。
- **演奏中でも差し替え・削除できる。** 差し替えの窓（旧プラグインの解体 〜 新プラグインの
  ロード完了）の間、その bus は **dry 素通し**になる — 音は途切れず、insert だけが一時的に
  外れる。🔴 **#628 のラック形ではこの dry 窓は消える** — rack child がプロセスを保ったまま
  新チェーンを prepare して block 境界で切り替えるため、編集中も旧チェーンが鳴り続ける
  （SC.5 失敗モデル (i) prepare-commit 型へ昇格）。
- **失敗時（in-place 型の失敗モデル・SC.5)**: 旧 insert の解体**前**に失敗した場合は旧 insert が
  無傷で残る。解体**後**に失敗した場合は dry 素通しへ縮退する（**無音にはならない**）。
  縮退からの復旧は、同じ宣言をもう一度評価するだけでよい。ただし、回復不能な attach 失敗は
  スロット隔離となり、この場合はエンジン再起動が必要。
- instrument（PH.4）の差し替えは**別の失敗モデル**（prepare-commit 型 = 新インスタンスの準備
  成功を待って原子的に切り替わり、失敗時は旧が無傷）。スロット機構が違うため意味論も違う。
  `seq.remove()` は effect insert 専用で、instrument の削除には使えない。

### PH.2c プラグイン UI — `seq.ui([名前][, open])`（#617・#628 で名前形へ）

```js
var cb = init global.seq
cb.instrument("Kontakt 8.vst3")
cb.ui()                       // instrument の UI を開く（無引数 = instrument）
cb.ui("ValhallaRoom")         // 名前が一致する insert の UI（複数一致ならすべて開く）
cb.ui("ValhallaRoom", false)  // 閉じる

sum("strings").ui("Pro-Q 3")  // mixer bus の insert
aux("verb").ui("ValhallaRoom")
```

**動機**: 音色を作って保存する工程を**楽譜を書きながら**回せるようにする。従来は
エディタの右クリックか MCP からしか UI を開けず、その流れに乗らなかった。

> 🔴 **#628 で数値 index 形は撤回された** — `ui()` に数値を渡す形はすべて受理されない。
> ラックは入れ子になり得るため位置は 1 次元の index では指せず、出現順を DSL 表面に出すと
> SC.10.3b / SC.10.5 が追い出した概念が戻ってくる。正本は
> [`../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) **SC.10.10.1**。

- **無引数形 = instrument の UI**（instrument は 1 つなので指定が要らない）。bus / master には
  instrument が無いため、無引数形は「この bus に instrument は無い」で loud に失敗する。
- **第 1 引数はカタログ名の文字列**。**一致する insert すべての UI を開く**（`layer` の入れ子も
  含めチェーン全体から探す）。**同名が複数あっても曖昧にならない** — 選ばずに全部開くため。
- **標準プラグインは UI を持たない**（SC.10.8）ので、標準プラグイン名を渡すのは明示エラー。
- **一致 0 件は loud に失敗する**（黙って no-op しない）。
- **主経路は Cmd+Click**（SC.10.10 規範 2）: 楽譜上のプラグイン名を Cmd+Click すると当該
  インスタンスの UI が開く。エディタが構文木の位置からパスを解決するので、**書き手が
  数えなくてよい**。DSL の `ui()` を残すのは、**LLM が DSL 経路で駆動できる**ようにするため。
  - 🔴 **現在地（2026-08-28）**: Cmd+Click は **#633 で実装**する。#628 の時点で使えるのは
    DSL `ui("名前")` と MCP `open_plugin_ui` の 2 経路（owner 確認済み）。
- **複数同時オープンを制限しない**。セッティング時に複数パートを並べて見比べられる。
- 🔴 **open は冪等**: 既に開いているインスタンスへの `ui()` は **no-op** で成功する。
  ライブコーディングでは**ブロックの再評価が常態**で、楽譜に書いた `cb.ui()` は評価のたびに
  走るため、冪等でないと再評価のたびにエラーになる。**close は冪等化しない**。
  （MCP の `open_plugin_ui` は明示操作なので冪等にしない — 二重 open は loud に落とす）
- **未ロードのスロットでは loud に失敗する**（黙って no-op しない）。エラーは現在挿さっている
  名前を列挙する。
- **`master` は DSL 面を持たない**（現状）。`master` チェーンの UI は MCP の
  `open_plugin_ui({ receiver: "master", chain_path })` から開ける。
- 機構は MCP / REPL メタ行と**同一の経路**（`Global.openPluginUi` / `closePluginUi`）を通る。
  宛先解決・セッション簿記・エラー面は共通。

詳細は [`../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`](../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md)
UIH.5.1。

### PH.3 プラグイン識別と format 判定

- 第1引数 = path 文字列。相対 path の基準は `.audio()` の path-direct 形
  （`./` `../` `~/` `/`）と同じ規則。bank 名検索（`global.audioPath()` 相当）はなし。
- format は**拡張子で判定**: `.clap` → CLAP、`.vst3` → VST3、`.component` → AU。
  verb は format 非依存（format 別 verb は作らない）。
  **role 別の受理**（#421・2026-07-17 実装事実）:
  - `seq.instrument()`: `.clap` / `.vst3` を受理。`.component` は構文上予約し
    「not yet supported」エラーを返す。
  - `global.effect()`: `.clap` / `.vst3` を受理。`.component` は構文上予約し
    「not yet supported」エラーを返す。
  未知拡張子はいずれの role でもエラー。
- カタログ名による解決では、effect / instrument とも同名の CLAP / VST3 が存在する場合は
  **CLAP を優先**する。
- 第2引数 `pluginId`（optional）: 1 バンドルに複数プラグインが入る場合の指定
  （daemon `LoadPlugin.plugin_id` に対応）。省略時はバンドル先頭のプラグイン。

### PH.4 ロード・エラー・多重宣言の意味論

- **宣言時 eager ロード**: `.midi()` のポート eager 解決と同型。ロード失敗
  （ファイル不在・非対応 format・plugin 非対応ビルド）は**宣言時のハードエラー**とし、
  warn + no-op にしない（instrument の silent failure = 無音を防ぐ。daemon の
  `CLAP_NOT_LOADED` 正直エラー方針 #405 と整合）。
- **instrument はシーケンスごとに 1 インスタンス**（#517 S4 で「エンジン全体で 1 インスタンス」の
  制約を解除）:
  - 各 note シーケンスの宣言は**独立したインスタンス**を生成する。複数シーケンスが同じ path を
    宣言しても**共有しない**（音色状態・パラメータ・preset・声部がトラックごとに独立する。
    CPU / メモリもインスタンスごとに掛かる）。
  - 同一シーケンスの再宣言: 同一 path + pluginId + statePath は冪等（no-op・ライブ再評価の保護。
    **statePath もロード identity の一部** — 同じ plugin でも state が違えば別宣言・#540 P2）。
    異なる path / pluginId / statePath は**後勝ちで差し替える**（SC.3.1 規範4）。差し替えは
    prepare → commit 型で、新インスタンスのロード成功まで旧インスタンスが鳴り続け、失敗時は
    旧インスタンスが無傷で残る（= 失敗したら何も起きなかったのと同じ）。**差し替え要求の直前に**
    旧インスタンスの state を自動保存してから要求を出す（project.yaml に登記され、後で同じ
    プラグインを再宣言すると音色が復元される。保存に失敗した場合は差し替えを中止する。
    document directory が無い場合のみ警告して続行する）。
    > **保存点が「commit の直前」でなく「要求の直前」である理由**: daemon 側の差し替えは
    > prepare → commit → teardown を**単一の原子的呼び出し**として実装され、途中に保存を
    > 差し込む点が無い（原子性と引き換え）。したがって保存と commit の間に新インスタンスの
    > spawn + READY 待ちが挟まる。その間に旧インスタンスのパラメータを変えると保存に写らないが、
    > 差し替えを要求してから完了するまでの間に旧音色をいじる操作は想定しない。差し替えは評価時に即時反映され、
    `quantize` の影響を受けない（宣言層の意味論）。

    差し替えに note-off の先出しは伴わない: スケジュール済みの note-on / note-off は**発火時点で
    宣言が指すインスタンス**へ配送される（commit 後は新インスタンス。鳴っていない key への
    note-off は no-op）。旧インスタンスの発音は teardown（child プロセス終了）とともに止まる。
    強制 note-off が必要になるのは note の**発生源**（シーケンス）が offTime より前に止まる場面
    （§7-2: MUTE / LOOP 除外 / play() 差し替え / stop）であり、**宛先**（instrument）が変わる
    場面ではない。
    > **v1 の現在地**: instrument の後勝ち差し替えは **#618 で実装済み**（同一シーケンスへの
    > 再宣言で path / pluginId / statePath の変更がエンジン再起動なしに反映される）。effect
    > チェーン側の後勝ち（SC.5 のブロック置換・`remove()`）は未実装のまま（#522）。
  - note の宛先は宣言シーケンス自身のインスタンス。channel は 0 固定（インスタンス化により
    per-sequence channel の必要は消滅した。channel は本来の意味 = マルチティンバープラグイン内の
    パート指定として後続 stage で使う）。
  - **クラッシュ隔離**: 1 インスタンス = 1 child プロセス。crash 時は当該シーケンスのみ無音になり
    自動 respawn する。他のインスタンス・audio シーケンスは影響を受けない。

> **なぜ共有をやめたか（#527 の調査）**: 旧規則の「同 path 共有」は、daemon が 2 回目の `LoadPlugin` を
> `AlreadyLoaded` にする制約に合わせた TS 側 dedup だった。しかし**フォーマット側に共有を成立させる
> 機構が無い**: CLAP は `clap_plugin_preset_load` がインスタンス丸ごとにしか効かず（port / channel で
> スコープする引数が無い）。param の**持続的な問い合わせ**（`clap_plugin_params.get_value` —
> 引数は `param_id` のみで port / channel / key のスコープを持たない）にもスコープが無い。value 設定
> イベント自体（`clap_event_param_value`）は `note_id` / `port_index` / `channel` / `key` のスコープ
> フィールドを持つが、これは**発音中のボイス1つを一時的に狙う**ための機構であり（`PER_NOTE_ID` 等の
> フラグと同様 MPE 的なボイス単位モジュレーション）、パートごとに持続する音色設定を表す機構ではない。
> host 側アクセサ
> `clap_host_track_info.get` が返す track 情報が**単数**であることからも（`clap_plugin_track_info` は
> plugin 側の変更通知構造体）、CLAP は 1 インスタンス = 1 トラックを
> 前提にしている。VST3 は Unit 機構（`UnitInfo.programListId` / `ParameterInfo.unitId` /
> `getUnitByBus`）で per-part を表現できるが **opt-in** で、本実装は未対応。
> したがって旧規則は**共有の利点を実現する機構を持たないまま、preset / param / note が混ざる欠点だけを
> 負っていた**。

> **v1 の現在地（per-sequence インスタンス化）**: **#540 P1 で実装済み。** 宣言の登記は
> シーケンス名キー（`PluginInstrumentManager` + `EffectChainMap<string>`）、daemon は起動時に
> 事前確保した **instrument slot pool** へ `instance`（`plugin:<seqName>` 規約）で割り当てる。
> 異なる note シーケンスの `instrument()` 宣言は独立したインスタンス（独立 child プロセス）を
> 生成し、実機 gated テストが2インスタンスの同時発音と宛先分離をピン留めしている。
>
> **slot pool の上限**: 同時に持てるインスタンス数は起動時固定の slot 数まで
> （env `ORBIT_OUTPROC_INSTRUMENT_SLOTS`・既定 8・最大 32）。超過した宣言は
> 「instrument slot pool exhausted」の明示エラーになり、env を上げてエンジンを再起動する。
> 割当は解除されない（ライブセッション中に多数のシーケンス名を使い捨てると再起動が必要になる）。
> 差し替えは prepare 中に空き slot を 1 つ使う（commit 後、旧 slot は返却され以後の宣言・差し替えに
> 再利用される）。空き slot が無い状態での差し替えは明示エラーになり、旧インスタンスは無傷で残る。
> **劣化経路**: 旧 slot の後始末が完了を確認できなかった場合（イベントの排出応答が来ない・
> shm の制御語を戻せない）、その slot は**返却されず隔離**される（前テナントの痕跡が残った slot を
> 再利用するより、1 slot を失う方が安い）。差し替え自体は成功し音は鳴るが、実効 pool 容量が
> 1 減る。隔離はログに残り、繰り返せば pool 枯渇として顕在化する。

- **複数シーケンスと 1 インスタンスの関係**（暗黙には生じない。いずれも明示宣言・後続 stage）:
  - **サミング**: 複数シーケンスが同一インスタンスの**同一 part** に note を合流させる（通常の
    単一ティンバー音源を含む）。note ストリームは 1 つの voice pool に合流し、preset / パラメータは
    1 組。**note の解放はシーケンス単位** — あるシーケンスの停止は自分が発音した note のみを解放し、
    同一 key を他シーケンスが保持していれば発音は続く（`(port_index, channel, key)` 参照カウント方式・
    M2 §4.7 の voice 簿記と同一）。**voice stealing はプラグインのポリフォニー管理に従う内在的性質として
    容認**する（DAW で 1 トラックにクリップを重ねた場合と同じ）。
  - **マルチティンバー**: 複数シーケンスが同一インスタンスの**異なる part**（port / channel、VST3 では
    Unit）を独立に叩く。note は合流せず、part ごとに独立した preset / param を持つ（対応 format のみ。
    CLAP は per-part の機構を持たないため part 指定は明示エラー）。
  - 通常音源は part を 1 つだけ持つ縮退形であり、**part 指定のない合流はサミングになる**。
- **All Notes Off**: plugin 経路に CC はないため、active note を列挙して note-off を
  逐次送出する。`global.stop()` / LOOP 除外 / MUTE / `play()` 差し替え時の保留 note
  解放義務は Pitch DSL §7-2 と同一。**インスタンスごと・シーケンス（owner）ごとに追跡**し、
  サミング時は上記の参照カウント判定に従う（他シーケンスが同一 key を保持していれば note-off を
  送出しない）。アンロード / 差し替えの teardown では明示の choke を送らず、**child プロセスの
  終了が全声部を落とす**（1 シーケンスの停止に wildcard な解放を使わないという規範は変わらない —
  他シーケンスの発音を巻き込むため）。
  child crash で声部が消滅した後の stale な note-off は無害（受信側に該当声部が無い）。
  🔴 **発火ケースの追加（#628・SC.10.6 規範 2）**: **instrument ブランチの無効化
  （`enabled: false`）・削除**も強制 note-off の対象である。ブランチを無効化すると
  **その音源で発音中のノートの発生源が止まる**ため、保留 note を解放しないと鳴りっぱなしになる。
  **本項は仕様の追記のみで、runtime 実装は `layer`（並列 instrument）とセットの後続工程**
  （SC.10.11・v1 では `instrument(layer([...]))` の適用自体が stage 表記エラー）。
  実装時は **#606 が作る flush 機構をこの発火点から呼ぶ** — note-off 配送機構を二重に作らない。
- **underscore 規約**: plugin verb は宣言専用であり `_effect` / `_instrument` 形はない。
- `.orbslog`: 宣言は他 verb 同様に因果評価ログとして自動記録される（特別扱いなし）。

### PH.5 LinkAudio との関係（v1 制限）

- instrument シーケンスは MIDI シーケンス同様、strict mode の `.output()` 要件から
  **免除**される（SC audio bus ではなく plugin 経路にルーティングされるため。§8.1.2 参照）。
- **v1 制限**: `global.linkAudio()` と plugin hosting（effect / instrument）は
  同時使用不可 — 宣言時エラー（現 engine の compile-time 排他 feature の実態を開示）。

### PH.6 v1 制限（実装事実の開示）

- release 既定の OOP-both 構成（`--features outproc-effect,outproc-instrument`）では、effect と
  instrument の同一プロセス同時使用をサポートする（#431 で解消、Epic #424 DoD 達成）。
  in-process `clap-host` は dev / gated-test 専用の単一 slot なので、異なる role への再ロードは
  `CLAP_CROSS_ROLE_REJECTED` で拒否される。
- note 発火は block-head 精度（sample-accurate 化は #428）。
- ロード確認から audio 反映までの短い race window が残存する（#410）。
- **param / CC 制御**（EQ-from-DSL 等）は本節のスコープ外 — M2 param path の成熟後に
  別途構文を確定する（構文未確定。ここで先取りしない）。

---

## Plugin Catalog — 名前指し・自動補完（#463）

> **Status**: C1（スキャナ + キャッシュ）実装済み（PR #475）・C1b/C2/C3 は未実装（issue #463 が追跡）。
> 本節が規範（DocDD: spec 先行）。**path 指定（PH.3）は不変** — カタログはその上に載る
> 追加の解決層であり、path で書かれた spec はカタログを一切参照しない。

### PC.1 カタログ

- インストール済みプラグインの index。エントリ =
  `{ name, vendor, format, path, pluginId, roles }`（roles = effect / instrument 判定。
  1 バンドル複数プラグインは pluginId ごとに 1 エントリ）
- スキャン対象 = OS 標準ディレクトリ（macOS: `~/Library/Audio/Plug-Ins/CLAP`・
  `/Library/Audio/Plug-Ins/CLAP`・同 `VST3`）+ 環境変数 `ORBIT_PLUGIN_PATH`
  （`:` 区切り・追加検索パス・**各ディレクトリ直下のみ = 非再帰**）
- catalog v2 は互換投影 `plugins` に加えて全バンドルの `artifacts` 台帳を持つ。各 artifact は
  `format` / `path` / `fingerprint` と次の status のいずれかを持つ:
  - `staticSuccess`: 静的 metadata または従来の CLAP descriptor 読取りで成功。
    `source` と投影済み `plugins` を保持
  - `probePending`: native descriptor をまだ検査していない。`reason` を保持
  - `probeSucceeded`: child probe 成功。`source` / `durationMs` / `descriptorApis` /
    投影済み `plugins` を保持
  - `probeFailed`: child probe が理由付きで失敗。`durationMs` と
    `failure { code, message, hostArch?, slices?, exitCode?, signal? }` を保持
- **VST3 の native probe は明示スキャン時だけ行う**（規範）。コンテンツ依存プラグインが
  ネイティブダイアログを出し得るため（#463、実害確認 2026-07-17）、無人起動で
  moduleinfo 無し VST3 をロードしてはならない。flag なしの `orbit-plugin-scan` は
  VST3 を `moduleinfo.json` だけで読み、過去の fingerprint 一致 probe 結果があれば復元する。
  一方 CLAP は #463 前からの互換挙動として descriptor を in-process で読み、
  `plugins` 投影から消してはならない。`orbit-plugin-scan --probe-artifacts` と
  OrbitStudio/MCP の明示 rescan は、pending と再試行対象を 1 artifact / 1 child で検査する。
- fingerprint は `format + canonical bundle path + executable の相対パス/解決経路
  + executable の size/mtime(ns) + Info.plist の size/mtime + scanner schema version`。
  解決経路は `coreFoundation` / `infoPlistXml` / `convention` / `directoryScan`
  （standalone file は `directFile`）。fingerprint 変化、または scanner schema version の
  更新で positive/negative cache を無効化する。schema version は解決・分類・role mapping・
  classes→entries 投影など、cached state の意味が変わる時にも上げる。
- probe failure は「検査を完遂できなかった」環境起因と「検査を完遂して使えないと判定した」
  artifact 固有に分ける。`timeout` / `killTimeout` / `crash` / `spawnError` /
  `protocolError` は前者で、明示 rescan ごとに再試行する。`bundleLoad` /
  `unsupportedArch` / `missingSymbol` / `nullFactory` / `invalidClassCount` /
  `descriptorRead` / `invalidBundle` / `unsupportedFormat` は後者で、fingerprint が
  変わるまで隔離する。cached failure は毎回 architecture を再検証し、
  `unsupportedArch` の根拠が消えたら再probeして自己修復する。
- キャッシュ = `~/.orbitscore/plugin-catalog.json`（正本はこのファイル。エンジン・
  拡張・MCP はこれを読むだけ）。生成/更新 = 初回スキャン + 明示 rescan（自動 watch は
  v1 スコープ外）。スキャンは crash-isolated な独立 `orbit-plugin-scan` バイナリが所有し、
  OrbitStudio と MCP は明示 rescan 時に同バイナリを起動する。

### PC.2 DSL の名前指し

```js
kick.effect("TAL Reverb 4")            // カタログ名で解決
kick.effect("TAL Software/TAL Reverb 4")  // vendor 修飾（同名衝突時の一意化）
kick.effect("vst3/TAL Reverb 4")       // format 修飾（VST3 版を明示）
kick.effect("./plugins/MyComp.clap")   // 従来の path 指定（不変・カタログ非参照）
```

- **判別規則**: spec が path-direct 形（`./` `../` `~/` `/` **開始**）または既知拡張子
  （`.clap` `.vst3` `.component`）で終わる → 従来どおり path 解決（PH.3）。
  それ以外 → **カタログ名として解決**
  - **実装注意**: audio 系の `looksLikePath()`（「`/` を含む」= path 判定）は**再利用
    しない** — vendor 修飾 `"TAL Software/TAL Reverb 4"` は `/` を含むがカタログ名。
    判別は本節の規則（開始形/末尾拡張子）で専用に実装する
  - カタログ名自体が既知拡張子で終わる場合（例: name = `"MyPlugin.clap"`）は path 解決に
    倒れる（既知の限界 — 該当プラグインは path 指定で回避）
- 名前解決: `name` 完全一致（case-insensitive・前後空白 trim・Unicode は **NFC 正規化後**
  に比較 — macOS FS の NFD 由来の不一致を防ぐ）。最初の `/` より前が既知 format 名
  （`clap` / `vst3`）なら `"format/name"` としてその format に限定し、それ以外は従来どおり
  `"vendor/name"` として扱う。format 名と同じ vendor が両方の解釈で候補を持つ場合は曖昧エラーにする。
  同名別 vendor は候補を列挙してエラー（silent に先頭を選ばない）。
- **解決の出力 = `(path, pluginId)` の組**で、両方を `LoadPlugin` へ渡す（カタログは
  pluginId 単位で 1 エントリ = name → (path, pluginId) は 1:1）。したがって**カタログ
  名指しと第 2 引数 `pluginId` の併用はエラー**（名前が既に一意。pluginId 引数は
  path 指定時のみ有効）
- 同名同 vendor で複数 format がある場合の優先: **CLAP > VST3**。
- role 検査: 解決したエントリの roles が verb と不一致（effect() に instrument-only 等）
  はエラー
- カタログ未生成・名前未ヒット時のエラーは「rescan 手順」を含む actionable メッセージ

### PC.3 OrbitStudio 自動補完

- 拡張の completion provider が `effect("` / `instrument("` の引数位置で
  カタログから候補（name・vendor 修飾形・format ラベル付き）をサジェスト
- `effect()` / `instrument()` ともに CLAP と VST3 の候補をサジェストする。同名が両 format
  にある場合は `clap/name` / `vst3/name` と format 接頭辞を付け、表示と insertText を一致
  させる（同一 vendor 内だけを比較）。format 接頭辞後も別 vendor とラベルが衝突する場合は
  `vendor/name` を表示する。format 衝突のない名前は従来どおり接頭辞なし。名前解決は PH.3 に従い
  CLAP を優先する。
- 補完はキャッシュファイル読取のみ（engine 起動不要）。キャッシュ不在時は候補なし + 
  rescan を促す 1 回限りの案内
- 🔴 **ラック形でも同じ補完が出る**（#628・SC.10.10 規範 1）: `effect([` の配列内・**複数行に
  またがるラック**・`layer([` の入れ子・`plugin("` の各文脈で、文字列リテラルの中にカタログ
  候補が出る。役割は文脈から決まる（`instrument(` 配下では instrument の候補のみ、`effect(`
  配下では effect の候補のみ）。

### PC.4 MCP

- `list_plugins` ツール（#450 の doc ツール群と同じ流儀）: カタログをそのまま返す。
  LLM が「入っているプラグイン」を前提に作編曲できるようにする
- `rescan_plugins` ツール: `orbit-plugin-scan --probe-artifacts` を起動し、
  artifact 総数、success/pending/failure 集計、および
  `failures [{ path, code, message, hostArch?, slices? }]` を返す。失敗 artifact と理由を
  JSON ファイルの手動閲覧なしで検証できること

### PC.5 制約（実装事実の開示）

- 多バージョン共存（同名同 vendor 同 format の別バージョン）は区別しない —
  スキャン順で最後に見つかった path が勝つ（バージョン規則は将来拡張）
- ファイルシステム watch による自動 rescan なし・AU（`.component`）はスキャン対象外
  （PH.3 の受理状況と整合してから追加）

---

## Mixer / Routing（sum・aux/send — #453/#459）

> **Status**: 設計確定（2026-07-17・issue #459 コメントが決定記録）・実装は M1-M3 で段階導入。
> 本節が規範（DocDD: spec 先行）。ブレスト正本 `POST_2.0_MIXER_DSL_DESIGN.html` は非規範。

### MX.1 ルーティングモデル

グラフは **source（seq）→ 任意の per-seq insert（PH.2b）→ sum（group bus）→ master** の直列と、
**send → aux（return bus）→ master** の並列タップで構成する。エッジは常に **source が行き先を指す**。
reconciliation key は名前（同名 = 同一 node・再評価は再束縛）。

### MX.2 sum / render bus / LinkAudio — `seq.output(destination)`

```js
global.sum("drum")                    // group bus 宣言（冪等）
kick.output("drum")                   // メンバーシップ = 行き先指定
snare.output("drum")
sum("drum").effect("GlueComp.clap")   // group bus 自身の insert（v1 は 1 基・PH.2b と同規則）
sum("drum").remove("GlueComp")        // 外す（差し替え・削除は PH.2d）
```

- `seq.output(name)` の名前解決: **sum 宣言があれば group bus・LinkAudio 有効なら egress
  channel**（両機構は v1 相互排他のため衝突しない）。sum にも LinkAudio にも解決されない
  名前は**記録 + 警告**（§8.1.2 の既存挙動 — 後から `global.linkAudio()` を宣言する
  ワークフローを壊さないため。宣言時ハードエラーではないことに注意・#477）
- sum の **ネストは v1 不可**（1 段・将来拡張として予約）
- sum bus の insert も **差し替え・削除できる**（異 spec 再宣言 = 差し替え / `remove("名前")`・
  意味論は PH.2d）
- seq が per-seq insert（`seq.effect()`）を持つ場合の処理順: **per-seq insert → group bus**
  （DAW の track insert → group と同型）
- **master への明示的な復帰**: `SetBusRouting` の `output` に予約語 `"master"` を渡すと、
  sum への出力先指定を解除して hardware/master へ戻す（#517 S3 で追加）。`output` の
  **省略**は従来どおり「既存の出力先を保持（変更なし）」を意味し、予約語との区別で
  三状態を表現する。native 側の routing エンコードは以前から `1 = Master` を持っており、
  本変更は control-plane（parse + 検証 + TS 3層 + respawn cache）のみに閉じる

#### MX.2.1 数値 render bus — `seq.output(n)`（#598 P1）

```orbs
kick.output(1)
snare.output(2)
piano.output(8)
```

`output(n)` は既存 `output(name)` に統合された score-mode 用 routing。`n` は整数 `1..16`、
manifest/wire 上の bus 名は先頭ゼロなしの文字列 `"1"`〜`"16"` になる。別の render bus 宣言は
不要で、同じ番号へ出した sequence は同じ stem に合流する。audio sequence と
`instrument()` sequence の両方で使用できる。

解決順は次で固定する（既存2用途を保護するため順序も仕様）:

1. 引数を文字列化した名前に一致する `global.sum(name)`
2. 元の引数が number の場合だけ render bus (`1..16`)
3. string 引数の既存 LinkAudio channel

したがって `global.sum("1")` が宣言済みなら `output(1)` は sum bus を選ぶ。`output("1")` は
数字に見えても render bus へ暗黙変換せず、sum が無ければ従来の LinkAudio channel 用法になる。
範囲外・非整数・非有限の number は runtime error。数値 render bus は score-mode 宣言なので、
P1 では記録のみを行い、WAV 書き出しは #598 P2 で有効になる。

既存 `output(sumName)` と LinkAudio の warning/strict-mode、`play()` の意味論、realtime の既定出力は
変更しない。

### MX.3 aux / send — `global.aux(name)` / `seq.send(name, amount)`

```js
global.aux("rev")                     // return bus 宣言
aux("rev").effect("Reverb.clap")      // return の insert（v1 必須要素）
kick.send("rev", 0.3)                 // send（copy・原音は継続して master/sum へ）
```

- send は **post-fader（= per-seq insert 適用後）固定**（v1。pre/post 切替は将来拡張）
- `amount` は線形 gain（0.0-1.0 目安・上限は clamp しない）
- 複数 send 可（fan-out）。send 先未宣言はエラー
- aux bus の insert（`aux("rev").effect(...)`）も **差し替え・削除できる**（異 spec 再宣言 =
  差し替え / `remove("名前")`・意味論は PH.2d）

### MX.4 エンジン実装（規範）

- event は常に**単一の bus に tag** される（fan-out は event 複製ではなく **bus 処理段の
  copy 加算**で行う）。stage は構築時にトポロジカル順で固定（per-seq → sum → aux return →
  master）。RT 経路に alloc/lock なし・全 bus inactive なら従来経路とビット同一（PH.2b と同じ
  activation 機構）
- bus は起動時プールから確保（kind: insert/sum/aux）。宣言 = activation・失敗ロールバック・
  per-bus health・UNROUTABLE_EVENTS 観測は PH.2b の機構を共有

### MX.5 v1 制約（実装事実の開示）

- PDC（plugin latency 補償）なし — 並列経路（aux・group 間）の位相整合は保証しない
- sum ネスト不可・send は post-fader 固定・LinkAudio と相互排他（PH.5）
- 受理フォーマットは effect 系 = `.clap` のみ（PH.3）

---

## Import / Project 構成（複数ファイル — #456）

> **Status**: ✅ 実装済み（2026-07-17・I1+I2 = PR #470・I3 = PR #471・#456 CLOSED）。
> 本節が規範（DocDD: spec 先行）。ブレスト正本 `POST_2.0_MIXER_DSL_DESIGN.html` §8 は非規範。
> 素朴な 1 ファイル運用は**恒久に保護**する — import を使わない .orbs は従来どおり完結して動く。

### IM.1 構文

```js
import { kick, snare } from "./drums.orbs"   // ファイル import（名前列挙必須）
import chords                                 // 既存の stdlib import（§6・変更なし）
```

- パスは**文字列リテラル・import 元ファイル基準の相対パス**（`./` または `../` で始まること。
  絶対パス・裸の名前はエラー）。拡張子 `.orbs` は必須（省略糖衣なし）
- 文法の判別: `import` の次が `{` → ファイル import、識別子 → stdlib import（v1.1 の
  `import chords` と後方互換のまま共存）
- `{ }` 内は import 先ファイルの **top-level `var` 宣言名**。列挙した名前が import 先に
  宣言されていなければ**エラー**（契約検査）
- import 文はファイル先頭領域（最初の非 import 文より前）にのみ書ける
- `export` キーワードは v1 では導入しない（全 top-level 宣言が import 可能・将来の可視性
  制御のため予約語として確保）

### IM.2 意味論 — import = グラフの合成（名前一致 merge）

- import 先ファイルの**宣言群を評価し、共有名前空間へ名前キーで合流**させる。OrbitScore の
  reconciliation key は名前（MX.1 と同一原理）: 同名 = 同一 node・再評価は**再束縛であって
  再構築ではない**（hot-reload identity）
- `var global = init GLOBAL` は import 先ファイルにも**書いてよい（推奨）**。名前キー
  reconciliation により entry と同一の Global インスタンスへ解決されるため、各ファイルは
  **単独でも評価可能**（standalone-evaluable）かつ import されても二重初期化しない（冪等）
- **評価順序（規範）**: import は**ソース記載順・深さ優先（依存が先 = post-order）**で評価し、
  その後に import 元自身の宣言を評価する。したがって同名衝突の「後から評価された定義」は
  決定的に定まる（entry 自身の宣言が常に最後 = 最優先）
- 同一ファイルの多重 import（ダイヤモンド）は **1 回だけ評価**（top-level 評価ごとの
  module cache）。ファイル同一性の基準は**解決済み絶対パス**（symlink 解決後の realpath —
  異なる相対表記が同一ファイルを指す場合も 1 回）。**循環 import はエラー**
- v1 制約: モジュールスコープは持たない（フラット名前空間）。`{ }` に列挙しなかった宣言も
  評価され名前空間に入る（列挙は契約検査であって隔離ではない — 隔離は v2 予約）。異なる
  ファイルが同名を宣言した場合は**後から評価された定義が同一インスタンスに再適用**される
  （衝突診断は将来拡張）

### IM.3 module 制約 — project / performance の分離

- import されたファイルは**宣言専用**: `RUN` / `LOOP` / `MUTE` 等の transport キーワードが
  import されたコンテキストで実行されるのは**エラー**（entry ファイルのみが transport を
  所有する）。単独評価時（そのファイルを直接 play/eval）は従来どおり transport 可
- 設計根拠: project（永続グラフ = 楽器・mixer・routing）と performance（live 操作 = tempo・
  transport）の 2 分割（POST_2.0_MIXER_DSL_DESIGN §8.1）。import で持ち込むのは前者

### IM.4 パス解決

- import パスの基準 = **import を書いたファイルのディレクトリ**（transitive import も同様）
- import 先ファイル内の `audio("...")` 等の相対パスは**そのファイル自身のディレクトリ基準**で
  解決する（規範）。entry の documentDirectory に依存しない — モジュールは移動可能な単位

### IM.5 再評価 / live coding

- entry の再評価は import を**毎回読み直す**（キャッシュは 1 評価内のみ）。名前キー
  reconciliation により走行中シーケンスの identity は保たれ、差し替えは再束縛で済む
  （音切れ最小化 — MX.1 と同じ機構に乗る）
- import 先ファイルだけを編集した場合の自動反映（ファイルウォッチ）は v1 スコープ外 —
  entry の再評価で取り込む

### IM.6 v1 制約（実装事実の開示）

- モジュールスコープなし・`export` なし・衝突診断なし（IM.2 に明記）
- VS Code 拡張のファイル横断診断・補完・サブジェクトブロック実行は v1 スコープ外
  （import 行を含むファイルでは未定義変数診断を抑制する方向で段階対応）
- REPL / 部分 eval（行・ブロック実行）からの import 文は entry ファイル基準が定まらないため
  **エディタで開いているファイルのディレクトリ**を基準とする

---

## Implementation Status

### Completed Features ✅

#### Core DSL (v3.0)
- **Initialization**: `init GLOBAL`, `init global.seq` (variable names are arbitrary, not hardcoded)
- **Global Parameters**: tempo, beat
- **Sequence Configuration**: tempo, beat, length, audio, chop
- **Play Patterns**: Flat and nested structures with hierarchical timing
- **Method Chaining**: All methods return `this` for fluent API
- **Transport Commands**: run, stop, loop, mute, unmute
- **Underscore Prefix Pattern (v3.0)**:
  - Sequence: `_audio()`, `_chop()`, `_play()`, `_beat()`, `_length()`, `_tempo()` for immediate application
  - Global: `_tempo()`, `_beat()` for immediate application with seamless parameter updates
- **Parameter Inheritance**: Sequences inherit tempo/beat from Global unless overridden
- **Unidirectional Toggle (v3.0)**: `RUN()`, `LOOP()`, `MUTE()` reserved keywords with片記号方式 semantics
  - RUN and LOOP are independent groups
  - MUTE is persistent flag, only affects LOOP playback
  - STOP keyword removed (use LOOP with different list)
- **Launch Quantize**: `global.quantize()` / `seq.quantize()` — shipped (§5)
- **Session log (`.orbslog`)**: implemented but **dormant by default in 2.0.0** (opt-in `ORBITSCORE_SESSION_LOG=1`; session-scoped format redesign deferred post-2.0)

**MIDI-only concepts**:
- `global.key()` is **implemented** as part of the v1.1 Pitch DSL (the numeric-root
  reference key — see "Pitch DSL (v1.1 — MIDI Output)" P.1). `tick()` remains future.

#### Pitch DSL (v1.1 — MIDI Output)
See the "Pitch DSL (v1.1 — MIDI Output)" section for the full reference. Implemented across
Epic #224 phases 1/2/3/R/4:
- **MIDI output** (Phase 1): `seq.midi()`, `octave()`, `vel()`, `gate()`, `global.key()`,
  `global.midiLatency()`; degree resolution, lookahead scheduler, active-note tracking
- **Group scope chains** (Phase 2 / E6): `.root()` / `.mode()` / `.oct()` on `( )` groups (mode = §2.2 lattice)
- **Stacks + chord values** (Phase 3): `[ ]` simultaneous stacks, bare `[ ]` chord values, spread,
  `-N` removal, `^N` chord shift, `import chords`
- **Repetition + pattern variables** (Phase R): `*n`, `var NAME = <pattern>`
- **Ties / legato / hold** (Phase 4): `_` event tie, `_n` voice tie, `{ }` legato, `.hold()`
- **Voicing + randomness** (E2 / §12): `.drop(n...)`/`.invert(n)`/`.open()`/`.close()`/`.shell()`/
  `.rootless()`; `Xr`/`.r`/`^r` random (see P.12)
- **Key-center register** (E3 / #253): `global.key("D4")` base octave (see P.1)
- **Section variables** (E4 / #254): comma-separated multi-bar bindings (see P.9)
- **Per-note expression** (E5 / §10.3): `@v` velocity (absolute / relative) + `@g` articulation (see P.11)
- **Mode scope** (E6 / §2.2): `mode(...)` user lattice + `(...).mode(name)` + `.period(n)` (see P.4)

#### Parser
- **Tokenizer**: Complete lexical analysis
- **Parser**: Full syntax support including nested play structures
- **IR Generation**: Intermediate representation for execution
- **Error Handling**: Graceful error reporting

#### Audio Engine (Rust daemon default / SuperCollider opt-out)
- **File Loading**: WAV / AIFF / MP3 / MP4 decoding (symphonia on the Rust path; buffer caching on the SC path)
- **Slicing**: `chop(n)` divides audio into n equal parts with precise timing
- **Playback**: sample-accurate `PlayAt` scheduling on the Rust daemon (SC path: 0-2ms latency via scsynth)
- **Audio Control**:
  - `gain(dB)`: Real-time volume control in dB (-60 to +12, default 0) - applies immediately even during playback
  - `pan(position)`: Real-time stereo positioning (-100 to 100) - applies immediately even during playback
  - `defaultGain(dB)`: Set initial gain without triggering playback - use before `run()` or `loop()`
  - `defaultPan(position)`: Set initial pan without triggering playback - use before `run()` or `loop()`
  - Random values: `r` (full random), `r0%10` (random walk)
- **Global Mastering Effects**:
  - `global.compressor()`: Increase perceived loudness
  - `global.limiter()`: Prevent clipping
  - `global.normalizer()`: Maximize output level
- **Audio Device Selection**: Choose output device via command palette
- **Default Behavior**: `chop(1)` or no chop treats file as single slice

#### Object-Oriented Architecture
- **Global Class**: Transport and audio engine management
- **Sequence Class**: Individual sequence state and behavior
- **AudioEngine Class**: Audio processing and playback
- **Transport Class**: Scheduling and synchronization
- **InterpreterV2**: DSL execution engine

#### VS Code Extension
- **Syntax Highlighting**: Complete DSL syntax support
- **Autocomplete**: Context-aware intelligent suggestions
- **IntelliSense**: Parameter hints and hover documentation
- **Diagnostics**: Real-time error detection
- **Command Execution**: Cmd+Enter to run selected code

### Not Yet Implemented 📋

#### Audio Manipulation

These per-slice modifiers (`seq.play(1.fixpitch(7), 2.time(0.5), ...)`) are recognized by the
parser but currently throw "not yet implemented" (#213). Their **semantics are fixed** below so
the two time/pitch axes stay orthogonal and consistent with the chop slice-fit varispeed (§3):

- **fixpitch(semitones)**: shift pitch by N semitones, **duration preserved** (pitch-preserving
  pitch-shift — the *pitch* axis moves, time held). Requires a pitch-preserving DSP
  (permissive Signalsmith, not GPL Rubber Band).
- **time(factor)**: change playback speed by `factor` — **varispeed, pitch moves with speed**
  (`0.5` = half speed / one octave down, `2.0` = double speed / one octave up). The *time* axis
  moves, pitch follows. Reuses the same rate primitive as chop slice-fit (§3); **not**
  pitch-preserving. (#213)
- **stretch(factor)** *(reserved name, unspecified for implementation)*: pitch-preserving
  time-stretch (duration changes, **pitch held**) — the complement of `time()`. Pitch-preserving
  time-stretch is also obtainable by composing `time()` (varispeed) with `fixpitch()` (inverse
  shift), so a first-class `stretch()` is sugar, deferred until a concrete need.
- **offset()**: Start position adjustment
- **reverse()**: Reverse playback
- **fade()**: Fade in/out

#### Effects (Per-Sequence)
- **delay()**: Per-sequence delay effect
- **reverb()**: Per-sequence reverb effect
- **filter()**: Per-sequence filter effects
- **seq.effect()** (per-sequence plugin insert): implemented (#434) — see PH.2b. Chains
  (multiple inserts per sequence) and aux/send routing (#453) remain future extensions

#### Advanced Features
- **Composite Meters**: `((3 by 4)(2 by 4))`
- **Force Modifier**: `.force` for transport commands
- **Effect Presets**: Named preset system for effect chains
- **DAW Plugin**: VST/AU plugin development
- **Plugin Hosting implementation**: the CLAP effect/instrument hosting *syntax* is finalized
  (#425 — see the Plugin Hosting section above); DSL wiring for effect (#426) and instrument
  (#427) is implemented. **VST3 instrument hosting is implemented** (#421 — `seq.instrument()`
  accepts `.vst3`; PR #447, merged 2026-07-17). **VST3 effect hosting is implemented**
  (`global.effect()` accepts `.vst3`; same-name catalog resolution prefers CLAP). `.component` (AU) remains reserved
  for both roles (not yet supported). Only sample-accurate note timing (#428) remains
  outstanding for the implemented paths.
- **`slice()`**: per-event start/end point selection within a chopped file (#239)
- **Audio `[ ]` stack / slice layering**: simultaneous audio-layer stacking in the play tree (#238)

#### Legacy MIDI DSL (Deprecated — superseded by the v1.1 design)
- **Old flat syntax** (`sequence`, `bus`, `channel`, `degree`, `velocity`) from the original
  MIDI-only system is no longer supported; that implementation was removed when the v2.0
  SuperCollider audio engine landed.
- **Not a removal of MIDI itself**: the **v1.1 Pitch DSL (MIDI Output)** above is a *different*
  design — `seq.midi()` + symbolic degree resolution as a path that runs **alongside** the SC
  audio engine, not a return of the deprecated `bus`/`channel`/`degree` syntax.

### Testing Coverage (v3.0)
- **Audio Parser Tests**: 50/50 passing
- **Parser Syntax Tests**: 11/11 passing (v3.0: STOP removed)
- **Unidirectional Toggle Tests**: 11/11 passing (v3.0: RUN/LOOP/MUTE semantics)
- **Underscore Methods Tests**: 27/27 passing (v3.0: _audio, _chop, _play, etc.)
- **Timing Tests**: 8/8 passing
- **Pitch Tests**: 25/25 passing
- **Audio Slicer Tests**: 9/9 passing
- **SuperCollider Tests**: 15/15 passing
- **Sequence Tests**: 20/20 passing
- **Setting Sync Tests**: 13/13 passing (v3.0: RUN/LOOP buffering)
- **Total**: 1100+ unit tests passing (count grows; see CI for latest)

---

## 13. Versioning

> **Two version tracks.** The `vN.0` numbers below are the **audio-engine line** (v0.1 →
> v1.0 → v2.0 → v3.0). The **`v1.1` Pitch DSL / MIDI line** is a separate, later workstream
> (2026, Epic #224) layered *on top of* the v3.0 audio engine — it is not a predecessor of
> v3.0 despite the lower number. Read the two as parallel tracks, not a single sequence.

**Current Version**: OrbitScore **2.0.0** — v3.0 audio engine + v1.1 Pitch DSL (MIDI) — Phases 1/2/3/R/4

- v1.1 Pitch DSL / MIDI (2026, Epic #224): **MIDI output path + symbolic pitch language**,
  layered on the v3.0 audio engine. See "Pitch DSL (v1.1 — MIDI Output)".
  - Phase 1: `seq.midi()` output, degree resolution, scheduler, active-note tracking
  - Phase 2 / E6: `.root()`/`.mode()`/`.oct()` group scope chains (mode = §2.2 user lattice)
  - Phase 3: `[ ]` stacks + bare `[ ]` chord values
  - Phase R: `*n` repetition + pattern variables
  - Phase 4: `_` / `_n` ties, `{ }` legato, `.hold()`
  - Harmony/voicing (§12): bare `[ ]` chord literal, `.drop/.invert/.open/.close/.shell/.rootless`, `Xr`/`.r`/`^r` random
  - Per-note expression (E5 / §10.3): `@v` velocity + `@g` articulation — **implemented in 2.0.0** (see Completed list above and P.11)

- v3.0 (2025-01-09): **Underscore Prefix Pattern** + **Unidirectional Toggle (片記号方式)**
  - **Underscore Prefix**: `method()` = setting only, `_method()` = immediate application
  - **Unidirectional Toggle**: `RUN()`, `LOOP()`, `MUTE()` with inclusion-only semantics
  - RUN and LOOP are independent groups (same sequence can be in both)
  - MUTE is persistent flag, only affects LOOP playback
  - Removed `STOP` keyword (use `LOOP()` with empty/different list instead)
  - 1100+ unit tests passing (count grows; see CI for latest)

- v2.0 (2025-01-06): SuperCollider integration, global mastering effects, dB-based gain control
  - SuperCollider audio engine for professional-grade timing
  - Global mastering: compressor, limiter, normalizer
  - dB-based gain control (-60 to +12 dB)

- v1.0 (2024-12-25): Core implementation complete with 100% test coverage
  - Parser, interpreter, timing calculator
  - Nested play structures
  - Method chaining

- v0.1 (2024-09-28): Initial draft specification

**Migration Notes from v2.0 to v3.0**:
- **STOP keyword removed**: Use `LOOP(seq1)` then `LOOP(seq2)` to switch - seq1 auto-stops
- **UNMUTE keyword removed**: Use `MUTE(seq2)` - seq1 auto-unmutes (unidirectional toggle)
- **New behavior**: `RUN()` and `LOOP()` are independent - sequence can be in both simultaneously
- **MUTE semantics changed**: MUTE only affects LOOP, not RUN playback
- **New pattern**: Use `_method()` for immediate application during live coding
- All existing v2.0 code continues to work (backward compatible for non-keyword features)

**Migration Notes from v1.0 to v2.0**:
- MIDI output system has been completely replaced with SuperCollider audio engine
- Old MIDI DSL syntax is no longer supported
- All audio playback now goes through SuperCollider for professional-grade timing and quality

Future changes must update this document first before implementation.
