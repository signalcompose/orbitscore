---
title: Reference (Method List)
description: A quick-lookup table of all OrbitScore methods, organized by category
---

# Reference (Method List)

This page is a quick-lookup table you can open and consult only at the section you need. There is no need to read it from top to bottom.

Use the section headings below to jump to the category you are looking for.

---

## 1. Global Settings

These are settings on the global object (by convention the variable name `global` is used). Every OrbitScore program starts here.

```text
var global = init GLOBAL
```

### Global Methods

| Signature | Description | Example |
|---|---|---|
| `tempo(N)` | Sets the tempo in BPM (how many beats per minute) | `global.tempo(120)` |
| `beat(N by M)` | Sets the time signature. Omitting M (as in `beat(4)`) treats it as `4` | `global.beat(4 by 4)` |
| `audioPath("path")` | Sets the base directory for relative paths used by `seq.audio()` | `global.audioPath("./audio")` |
| `start()` | Starts the scheduler (required before running any sequence) | `global.start()` |
| `stop()` | Stops all sequences | `global.stop()` |

::: tip The second argument of beat()
You can write either `beat(N)` or `beat(N by M)`. `beat(4)` means the same as `beat(4 by 4)`.
:::

---

## 2. Creating Sequences and Basic Settings

A sequence (`seq`) is the basic unit that represents a rhythm or sound pattern.

```text
var kick = init global.seq
```

### Basic Methods

| Signature | Description | Example |
|---|---|---|
| `audio("file.wav")` | Specifies the audio file to play. When `audioPath` is set, a relative path can be used | `kick.audio("kick.wav")` |
| `chop(N)` | Splits the audio file into N equal slices | `arp.chop(8)` |
| `play(...)` | Defines the rhythm pattern using slice numbers (0 is a rest) | `kick.play(1, 0, 1, 0)` |
| `length(N)` | Sets the loop length to N bars (changes playback speed and pitch) | `seq.length(2)` |
| `beat(N by M)` | Sets a per-sequence time signature (inherits from the global if omitted) | `seq.beat(3 by 4)` |
| `tempo(N)` | Sets a per-sequence tempo (inherits from the global if omitted) | `seq.tempo(90)` |

#### Meaning of the Numbers in play()

- **0**: Rest (silence)
- **1 to N**: Slice number (a slice from `chop(N)`)

```text
var arp = init global.seq
arp.audio("arpeggio.wav").chop(4)

// play slices in the order 1→2→3→4
arp.play(1, 2, 3, 4)

// mix in rests
arp.play(1, 0, 3, 0)
```

#### Nested Patterns

Parentheses `()` create groups that subdivide a beat further.

```text
// split the third beat into two
kick.play(1, 0, (1, 0), 0)

// split the fourth beat into four
snare.play(0, 0, 1, (1, 1, 1, 1))
```

---

## 3. Audio Manipulation

These methods adjust volume and stereo position.

### Audio Manipulation Methods

| Signature | Description | Example |
|---|---|---|
| `gain(dB)` | Sets the volume in dB (0 is the default; range: -60 to +12) | `kick.gain(-6)` |
| `pan(value)` | Sets the stereo position from -100 (left) to 100 (right) (0 is the default) | `hihat.pan(-50)` |
| `defaultGain(dB)` | Sets the initial volume value before playback (no playback trigger) | `kick.defaultGain(-3)` |
| `defaultPan(value)` | Sets the initial pan value before playback (no playback trigger) | `kick.defaultPan(-20)` |

::: info gain() and pan() always apply immediately
`gain()` and `pan()` apply immediately regardless of whether the underscore prefix is present. `gain(-6)` and `_gain(-6)` have the same effect.
:::

#### Volume Reference

| Value | Effect |
|---|---|
| `0` | Reference volume (default) |
| `-6` | About half as loud |
| `-12` | Quite quiet |
| `-60` | Almost silent |
| `6` | About twice as loud |

#### Pan Reference

| Value | Position |
|---|---|
| `-100` | Hard left |
| `-50` | Slightly left |
| `0` | Center (default) |
| `50` | Slightly right |
| `100` | Hard right |

---

## 4. Underscore Prefix (DSL v3.0)

From DSL v3.0 onward, almost every method has an "immediate-apply version" (with the underscore).

### The Difference Between method() and _method()

| Form | Behavior |
|---|---|
| `method(value)` | Just stores the setting. It is applied at the next `LOOP()` / `RUN()` |
| `_method(value)` | Stores the setting and **applies it immediately, starting playback** |

When you want a change to take effect quickly during live coding, use `_method()`.

### Methods That Have an Immediate-apply Version

| Immediate version | Settings-only version | Applies to |
|---|---|---|
| `_audio("file.wav")` | `audio("file.wav")` | Audio file specification |
| `_chop(N)` | `chop(N)` | Slice splitting |
| `_play(...)` | `play(...)` | Playback pattern |
| `_beat(N by M)` | `beat(N by M)` | Sequence time signature |
| `_length(N)` | `length(N)` | Loop length |
| `_tempo(N)` | `tempo(N)` | Sequence tempo |
| `_gain(dB)` | `gain(dB)` | Volume (both apply immediately) |
| `_pan(value)` | `pan(value)` | Pan (both apply immediately) |

The global object also has immediate-apply versions.

| Immediate version | Effect |
|---|---|
| `global._tempo(N)` | Changes the global tempo immediately (applies to inheriting sequences) |
| `global._beat(N by M)` | Changes the global time signature immediately (applies to inheriting sequences) |

::: tip About inheritance
A sequence inherits the global tempo and time signature in its initial state. Once you call `seq.tempo()` or `seq.beat()`, the sequence holds its own value from that point on (it no longer follows global changes).
:::

### Usage Example

```text
// Setup phase (before playback): write without the underscore
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")

var kick = init global.seq
kick.audio("kick.wav")
kick.chop(1)
kick.play(1, 0, 1, 0)

global.start()

// Run
LOOP(kick)

// --- from here on, you are rewriting during a performance ---

// change the pattern immediately (use _play)
kick._play(1, (1, 0), 1, 0)

// change the global tempo immediately
global._tempo(140)
```

---

## 5. Transport Commands (Uppercase Keywords)

These commands control playback, stopping, and muting of sequences. They are all written in uppercase.

### Command List

| Command | Description |
|---|---|
| `LOOP(a, b, …)` | Loops the specified sequences. Sequences not specified are stopped automatically |
| `LOOP()` | Stops all loops |
| `RUN(a, b, …)` | Plays the specified sequences once |
| `MUTE(a, b, …)` | Mutes the specified sequences (the loop continues; only the sound is suppressed) |
| `MUTE()` | Releases all mutes |

### Usage Examples

```text
// loop only kick
LOOP(kick)

// loop kick and snare (others stop)
LOOP(kick, snare)

// play hihat once
RUN(hihat)

// loop kick and snare while muting hihat
LOOP(kick, snare, hihat)
MUTE(hihat)

// release all mutes
MUTE()

// stop everything
LOOP()
```

::: warning LOOP is a replace operation
Running `LOOP(kick, snare)` automatically stops any other sequences (such as `hihat`) that were running before. The behavior is "replace this list," not "add to it."
:::

#### Multi-line Notation

When you have many sequences, you can break them across lines.

```text
LOOP(
  kick,
  snare,
  hihat,
)

MUTE(
  hihat,
)
```

---

## 6. Method Chains

All sequence methods can be connected with `.`.

```text
// chain example
var drum = init global.seq
drum.audio("break.wav").chop(8).play(1, 3, 5, 7, 2, 4, 6, 8).gain(-6).pan(-20)

// for long chains, break across lines and indent
var arp = init global.seq
arp
  .audio("arpeggio.wav")
  .chop(8)
  .play(1, 2, 3, 4, 5, 6, 7, 8)
  .gain(-3)
  .pan(0)

// chain immediately after init
var snare = init global.seq
  .length(1)
  .audio("snare.wav")
  .chop(1)
  .play(0, 1, 0, 1)
  .gain(-3)
  .pan(20)
```

The global methods can also be chained.

```text
var global = init GLOBAL
global.tempo(120).beat(4 by 4)
global.start()
```

---

When you run into trouble, please refer to [Troubleshooting](../troubleshooting.md).
