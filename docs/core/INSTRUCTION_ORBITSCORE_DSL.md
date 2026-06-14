# INSTRUCTION_ORBITSCORE_DSL.md

## OrbitScore DSL Specification (v3.0 – Implemented)

This document defines the **OrbitScore DSL**.
It is the **single source of truth** for the project.
All implementation, testing, and planning must strictly follow this specification.

**Last Updated**: 2026-06-14
**Implementation Status**: ✅ v3.0 audio engine + v1.1 Pitch DSL (MIDI) Phases 1/2/3/R/4 implemented and tested

> 🎯 **進行中の v1.1 拡張（Pitch DSL / MIDI・Session Log・WCTM）の仕様は [`docs/specs-v2/`](../specs-v2/) が正本**（締切 2026-08-07、進捗は GitHub Epic #224）。
> 各フェーズのゲート時に、当該機能のセクションを本ドキュメント（SoT）へ反映し、specs-v2 との乖離を作らないこと（指示書 §8.1-1）。
> 読み順: [IMPLEMENTATION_INSTRUCTIONS](../specs-v2/IMPLEMENTATION_INSTRUCTIONS.html) → [PITCH_DSL_SPEC_v1.1](../specs-v2/PITCH_DSL_SPEC_v1.1.html) → [SESSION_LOG_SPEC_v1](../specs-v2/SESSION_LOG_SPEC_v1.html) → [WCTM_SYSTEM_SPEC_v1](../specs-v2/WCTM_SYSTEM_SPEC_v1.html) → [DESIGN_DISCUSSION_RECORD](../specs-v2/DESIGN_DISCUSSION_RECORD.md)。

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
- Initializes `AudioEngine` with SuperCollider
- Sets up `Transport` system for scheduling
- Default values: tempo=120, beat=4/4
- **Variable naming**: The variable name "global" is conventional but not required - you can use any valid identifier (e.g., `var g = init GLOBAL`, `var master = init GLOBAL`)
- **Singleton behavior**: Multiple `init GLOBAL` statements return the same Global instance

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
- tick() and key() have been removed from the current audio-based implementation
- tick(): MIDI resolution concept, not needed for audio-only playback
- key(): Will be added when MIDI support is implemented. For audio files, requires audio key detection feature.
- Composite meters like (4 by 4)(5 by 4) are not currently supported

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
global.start()            // start scheduler from next bar
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
- Supported formats: wav, aiff, mp3, mp4
- Audio output: 48kHz / 24bit

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

**Strict mode (v1.2.0+)**: `global.linkAudio()` を宣言したファイル内では、 全ての発音 sequence が `.output(name)` で channel を宣言する必要がある。 `.output()` を持たない sequence が `.play()` した時点で **runtime error** を投げる (`Sequence.resolveDispatchChannel`)。 これは「LinkAudio mode 中は全 sequence が LinkAudio 経由」 という §8.1.1 の宣言と整合させるための strict 制約で、 hardware 出力との silent fallback は行わない (hardware/LinkAudio 混在は不可、 §8.1.1 参照)。 編集時には VS Code 拡張が `analyzeLinkAudioMissingOutput` で同等の error 診断を出す (§10)。

`global.linkAudio()` 未宣言で `seq.output()` を呼んだ場合は別経路: channel name は記録されるが hardware path に流れ、 console に一度だけ警告が出る (LinkAudio mode を有効化し忘れたケースのフェイルセーフ)。 編集時の order-violation 検出は §10 参照。

#### 8.1.3 Plugin lifecycle

LinkAudio mode は scsynth プロセス内で動作する SC plugin (`OrbitLinkAudio.scx`、 GPL-2.0-or-later 別 artifact) に依存する。 plugin の load / unload は scsynth 起動 / 終了に紐づく。 ランタイム切替 (演奏中の LinkAudio on/off) は v1.2.0 では非対応。

plugin が load されていない状態で `global.linkAudio()` を宣言した場合は hardware path にフォールバックし警告を出す。 plugin の有無は `EventScheduler.setLinkAudioPluginAvailable()` を経由してブート pipeline (Step 4) が flip する。

#### 8.1.4 Live 側の操作

1. Live 12.4+ を起動、 セッション SR を 48kHz (デフォルト) または `global.linkAudio(SR)` で指定した SR に合わせる
2. Audio トラックの "Audio From" で OrbitScore peer の channel name を選択
3. OrbitScore 側で sequence を再生 → Live のメーターで受信を確認

tempo / beat / phase / Start-Stop は LinkAudio に内包された Link 機能で双方向同期される。 Live 側で tempo 変更 → OrbitScore に反映、 OrbitScore で `global.tempo()` 変更 → Live に反映。

---

## 8. Implementation Notes

- Parser must support nested `play` structures for hierarchical timing
- IR must represent play structures as tree-like data for timing calculation
- Scheduler must handle independent sequence tempos (polytempo) and meters (polymeter)
- Audio engine uses SuperCollider with 0-2ms latency
- Global underscore methods (_tempo, _beat) must trigger seamless parameter updates for inheriting sequences

**Future Additions**:
- Audio manipulation features (fixpitch, time) will require time-stretch and pitch-shift implementation
- Composite meters may require complex timing calculation algorithms
- tick/key will be added when MIDI support is implemented

---

## 9. Testing Guidelines

- **Parser**: Verify meter parsing, nested play structures, variable initialization
- **Timing**: Ensure timing calculations are correct for nested play structures and different meters
- **Audio**: Confirm playback speed matches tempo and sequences synchronize correctly
- **Transport**: Global and sequence transport commands function as specified
- **Underscore Methods**: Verify immediate application behavior for all _method() calls
- **Inheritance**: Test that sequences inherit global parameters correctly and seamless updates work

---

## 10. VS Code Extension Features

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

## 11. Complete Usage Example

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
> rationale, and edge cases live in [`docs/specs-v2/PITCH_DSL_SPEC_v1.1.html`](../specs-v2/PITCH_DSL_SPEC_v1.1.html)
> (the `§N` pointers below refer to it). Where this section and specs-v2 ever disagree,
> specs-v2 wins and this section is the bug.

### P.1 MIDI output declaration (§1)

```js
var piano = init global.seq
piano.midi("IAC", 1)   // (portName substring, channel 1-16) → makes this a MIDI sequence
piano.octave(4)        // base octave: the octave of degree 1. default 4 (C4 = 60)
piano.vel(96)          // default velocity 1-127. default 96
piano.gate(0.8)        // default gate: sounding fraction of a slot. default 0.8

global.key("C")        // numeric-root reference key (note-name token)
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

### P.4 Mode scope (§2.2) — RESERVED (not implemented in v1.1)

> **Status**: the `.mode()` scope-chain syntax **parses** but **throws at dispatch**
> ("`.mode()` is not implemented in v1.1"), and the `mode(...)` definition constructor /
> `.period()` do not exist yet. Mode lattices are a future phase. The design below is
> recorded for forward-compatibility; do not rely on it in v1.1.

```js
var dorian = mode(1, 2, b3, 4, 5, 6, b7)                  // (future)
var custom = mode(1, 2, b3, 4, #5, 6, 7, 9).period(19)   // (future) explicit period (semitones)
```

- A `mode` is a user-defined pitch lattice written in root-scope degree notation. Inside a
  mode scope a melodic degree `n` is a pure index into the lattice:
  `pitch = lattice[(n-1) mod len] + period * floor((n-1)/len)`.
- `period()` defaults to the next octave boundary above the last element (12 for a 7-note
  church mode). The `2↔9` tension wrap-around does **not** hold in a mode (the lattice need
  not be 7 notes). Church modes would ship as a library of predefined `var`s, not primitives.

### P.5 Scope rules — `.root()` / `.oct()` group chains (§3, Phase 2)

`.root()` and `.oct()` attach as method chains to a `( )` rhythm-tree group (`.mode()`
parses but is reserved — see P.4).

```js
seq.root(C)               // sequence default pitch context
seq.play(
  (9, 5, (3, 1), [1,3,5,7]).root(2),     // this group resolves at root = II
  ((1, b3).root(b6), 5, 1).root(2),       // inner .root(b6) wins for its half-slot
  (1, 5, 1, 5),                           // no chain → sequence default
)
```

- Resolution order: inner group → outer group → sequence default (`seq.root()`/`seq.mode()`)
  → error (a degree with no default set is a diagnostic). Unspecified spans fall back to the
  sequence default — **stateless** (the previous scope is not retained).
- `.root(F)` takes a note-name token; `.root(3)` a diatonic degree of `global.key()`;
  `.root(b6)` a non-diatonic degree (resolved by P.2). Numeric root with no `global.key()`
  is an error (note-name root only).
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
seq.play(riff*3, fill, AA)
```

- `n` is an integer ≥ 1: `*0` is an error, `*1` is identity.
- **Tidal difference (must be documented to users)**: Tidal `*` is *in-slot* division
  (n times within one slot); OrbitScore `*n` *occupies n slots* (≡ Tidal `!`). For in-slot
  repetition, nest: `(1, 1)`.
- **Evaluation-time value semantics**: a variable is substituted when `play()` is evaluated.
  Redefining it does not retro-affect a running pattern (re-run the `play()` line). No
  reactive binding. A chord value is a *vertical* value; a pattern variable is a *horizontal*
  (tree) value.

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

> **Expression model (velocity / articulation) — not yet specified here.** The per-note
> `@v` velocity and articulation axes are a confirmed *principle* but their token grammar is
> a dedicated post-Phase-4 phase; spec reflection is **deferred per decision #42**. See
> [`DESIGN_DISCUSSION_RECORD.md`](../specs-v2/DESIGN_DISCUSSION_RECORD.md) §10. `@u` absolute
> duration (v1.0 `@U`) is **rejected** — duration is carried by the tree + ties.

### P.11 Voicing operators & randomness (§12)

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
  element presence (default 0.5), `.r` = chord thinning (no minimum-voice guarantee — silence is
  allowed), `^r` = random octave ±1. `r` is one primitive whose effect depends on its position.
  Reproducibility is by `.orbslog` (execution record, not a result recording) — random re-rolls
  on replay; no seed (decisions #50/#52/#53).
- **`.comp`** (auto jazz comping) is a future generative macro over these primitives — see #259.

---

## 12. Implementation Status

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

**MIDI-only concepts**:
- `global.key()` is **implemented** as part of the v1.1 Pitch DSL (the numeric-root
  reference key — see "Pitch DSL (v1.1 — MIDI Output)" P.1). `tick()` remains future.

#### Pitch DSL (v1.1 — MIDI Output)
See the "Pitch DSL (v1.1 — MIDI Output)" section for the full reference. Implemented across
Epic #224 phases 1/2/3/R/4:
- **MIDI output** (Phase 1): `seq.midi()`, `octave()`, `vel()`, `gate()`, `global.key()`,
  `global.midiLatency()`; degree resolution, lookahead scheduler, active-note tracking
- **Group scope chains** (Phase 2): `.root()` / `.oct()` on `( )` groups (`.mode()` reserved — throws)
- **Stacks + chord values** (Phase 3): `[ ]` simultaneous stacks, bare `[ ]` chord values, spread,
  `-N` removal, `^N` chord shift, `import chords`
- **Repetition + pattern variables** (Phase R): `*n`, `var NAME = <pattern>`
- **Ties / legato / hold** (Phase 4): `_` event tie, `_n` voice tie, `{ }` legato, `.hold()`
- **Voicing + randomness** (E2 / §12): `.drop(n...)`/`.invert(n)`/`.open()`/`.close()`/`.shell()`/
  `.rootless()`; `Xr`/`.r`/`^r` random (see P.11)
- **Not yet specified**: per-note expression (`@v` velocity / articulation) — deferred per
  decision #42 (see breadcrumb above)

#### Parser
- **Tokenizer**: Complete lexical analysis
- **Parser**: Full syntax support including nested play structures
- **IR Generation**: Intermediate representation for execution
- **Error Handling**: Graceful error reporting

#### Audio Engine (SuperCollider)
- **File Loading**: WAV format support with buffer caching
- **Slicing**: `chop(n)` divides audio into n equal parts with precise timing
- **Playback**: 0-2ms latency via SuperCollider scsynth
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
- **fixpitch()**: Pitch shift in semitones
- **time()**: Time stretch/compression
- **offset()**: Start position adjustment
- **reverse()**: Reverse playback
- **fade()**: Fade in/out

#### Effects (Per-Sequence)
- **delay()**: Per-sequence delay effect
- **reverb()**: Per-sequence reverb effect
- **filter()**: Per-sequence filter effects

#### Advanced Features
- **Composite Meters**: `((3 by 4)(2 by 4))`
- **Force Modifier**: `.force` for transport commands
- **Effect Presets**: Named preset system for effect chains
- **DAW Plugin**: VST/AU plugin development

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
- **Total**: 205+ tests passing

---

## 13. Versioning

> **Two version tracks.** The `vN.0` numbers below are the **audio-engine line** (v0.1 →
> v1.0 → v2.0 → v3.0). The **`v1.1` Pitch DSL / MIDI line** is a separate, later workstream
> (2026, Epic #224) layered *on top of* the v3.0 audio engine — it is not a predecessor of
> v3.0 despite the lower number. Read the two as parallel tracks, not a single sequence.

**Current Version**: v3.0 audio engine + v1.1 Pitch DSL (MIDI) — Phases 1/2/3/R/4

- v1.1 Pitch DSL / MIDI (2026, Epic #224): **MIDI output path + symbolic pitch language**,
  layered on the v3.0 audio engine. See "Pitch DSL (v1.1 — MIDI Output)".
  - Phase 1: `seq.midi()` output, degree resolution, scheduler, active-note tracking
  - Phase 2: `.root()`/`.oct()` group scope chains (`.mode()` reserved — throws)
  - Phase 3: `[ ]` stacks + bare `[ ]` chord values
  - Phase R: `*n` repetition + pattern variables
  - Phase 4: `_` / `_n` ties, `{ }` legato, `.hold()`
  - Harmony/voicing (§12): bare `[ ]` chord literal, `.drop/.invert/.open/.close/.shell/.rootless`, `Xr`/`.r`/`^r` random
  - Deferred: per-note expression (`@v` / articulation), per decision #42

- v3.0 (2025-01-09): **Underscore Prefix Pattern** + **Unidirectional Toggle (片記号方式)**
  - **Underscore Prefix**: `method()` = setting only, `_method()` = immediate application
  - **Unidirectional Toggle**: `RUN()`, `LOOP()`, `MUTE()` with inclusion-only semantics
  - RUN and LOOP are independent groups (same sequence can be in both)
  - MUTE is persistent flag, only affects LOOP playback
  - Removed `STOP` keyword (use `LOOP()` with empty/different list instead)
  - 205+ tests passing including 11 new unidirectional toggle tests

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
