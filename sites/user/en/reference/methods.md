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

## 6. MIDI Output (v2.0.0 Pitch DSL)

Methods for MIDI sequences and related global settings. See [MIDI Output](/en/midi/) for full documentation.

### Global — MIDI Settings

| Signature | Description | Example |
|---|---|---|
| `key("C")` | Sets the tonic (root note) for MIDI sequences ⚠️ | `global.key("C")` |
| `key("D3")` | Sets the tonic and register in one declaration ⚠️ | `global.key("D3")` |
| `midiLatency(ms)` | Fixed MIDI send offset in ms for timing alignment (default 0) | `global.midiLatency(20)` |
| `quantize(val)` | LOOP launch grid: `"bar"`(default) / `"beat"` / `"2bar"` / `"4bar"` / `"8bar"` / `"off"` | `global.quantize("bar")` |
| `linkAudio()` | Enable LinkAudio mode (streams audio to Live; macOS + Live 12.4+) | `global.linkAudio()` |
| `linkAudio(SR)` | Enable LinkAudio with explicit sample rate | `global.linkAudio(48000)` |

> ⚠️ `global.key()` / `seq.root()` and related root/key interfaces are scheduled for redesign post-2.0.

### Sequence — MIDI Declaration

| Signature | Description | Example |
|---|---|---|
| `midi(port, ch)` | Switches this sequence to MIDI mode (port = substring match, ch = 1–16) | `piano.midi("IAC", 1)` |
| `octave(N)` | Base octave (the octave degree 1 belongs to; default 4 = C4) | `piano.octave(4)` |
| `vel(N)` | Default velocity (1–127; default 96) | `piano.vel(96)` |
| `gate(N)` | Default gate ratio (0.8 = 80% of slot; default 0.8) | `piano.gate(0.8)` |
| `root(N)` | Sequence-default root (degree only) ⚠️ | `piano.root(1)` |
| `voicelead()` | Apply automatic voice leading to the whole sequence (alias: `vl()`) | `piano.voicelead()` |
| `quantize(val)` | Per-sequence LOOP launch grid override | `fill.quantize("off")` |
| `output("name")` | LinkAudio channel name (required when `global.linkAudio()` is active) | `kick.output("kick")` |

### play() values for MIDI sequences

| Notation | Meaning |
|---|---|
| `0` | Rest |
| `1`–`9`, `11`, `13` | Degrees (Ionian-relative) |
| `b3`, `#5` | Flat / sharp accidentals |
| `5^+1` | Shift up 1 octave (sticky) |
| `[1, 3, 5]` | Chord stack (simultaneous note-on) |
| `_` | Tie — extend previous event one slot |
| `5r` | Element randomly sounds ~50% of cycles |
| `5^r` | Random octave ±1 each cycle |
| `[1,3,5].r` | Chord thinning (each voice ~50%) |
| `5@v110` | Absolute velocity per note |
| `5@g30` | Gate percent per note (30 = staccato) |
| `riff*3` | Repeat pattern 3 slots wide |

---

## 7. Plugins — instrument / effect / UI

Features for hosting CLAP / VST3 plugins. For a full walkthrough, see [Playing a Plugin Instrument](../plugins/instrument.md) and [Inserting Effects](../mixing/effects.md).

### Sequence — Plugin Instrument

| Signature | Description | Example |
|---|---|---|
| `instrument(spec)` | A type-declaration verb that declares the plugin as the instrument (mutually exclusive with `.audio()`/`.midi()`). Values passed to `play()` are interpreted as degrees | `piano.instrument("Kontakt 8")` |
| `instrument(spec, statePath)` | A second argument ending in `.vstpreset`/`.state` restores a saved state (VST3 only) | `piano.instrument("Kontakt 8", "./states/piano.state")` |
| `instrument(spec, pluginId, statePath)` | Three-argument form that specifies both a pluginId and a state | `piano.instrument("Kontakt 8.vst3", "id", "./states/piano.state")` |

- Supported formats are `.clap` / `.vst3` (`.component` is not supported). Each sequence gets an independent instance; sounds are not shared.
- `seq.effect()`, and `output()` / `send()` to a `sum` bus, **cannot** be used on a note sequence (`instrument()`/`midi()`) (v1 constraint).

### Global / Sequence — Inserting Effects

| Signature | Description | Example |
|---|---|---|
| `global.effect(spec)` | Insert on the master bus (applies to every sequence) | `global.effect("TAL Reverb 4")` |
| `seq.effect(spec)` | Insert that applies only to that sequence (audio-sequence-only) | `drums.effect("TAL Reverb 4")` |
| `sum("name").effect(spec)` / `aux("name").effect(spec)` | Insert on a bus (sum or aux) | `sum("bus").effect("TAL Reverb 4")` |

Values you can pass as `spec`:

| Notation | Meaning |
|---|---|
| `"name"` | A catalog plugin name (`effect("name")` means the same as `effect(["name"])` — it replaces the whole chain with this picture) |
| `"vendor/name"` / `"clap/name"` / `"vst3/name"` | Vendor / format qualification (disambiguates a name collision) |
| `"./path/to/plugin.clap"` | A direct path (never consults the catalog) |
| `[...]` | A **series chain**. Plugins connect in order, top to bottom |
| `plugin("name", enabled: false)` | Argument form. `enabled: false` disables that plugin (pass-through in a series chain) |
| `Gain(db: n)` | A built-in plugin (bundled with the app, no UI/state, parameters written directly in the DSL) |
| `layer([...])` | Parallel combination (**notation reserved only — using it in v1 is an error**) |

```text
drums.effect(["TAL Reverb 4", Gain(db: -6)])           // chain
drums.effect([plugin("TAL Reverb 4", enabled: false)])  // disabled (bypass)
drums.effect([])                                        // remove everything (removal = drop from the array and re-evaluate)
```

- Accepted formats are `.clap` / `.vst3` (`.component` is not supported).
- There is no dedicated removal method. **Removal means dropping the element from the array and re-evaluating.**

### Sequence / Bus — Plugin UI

| Signature | Description | Example |
|---|---|---|
| `seq.ui()` | No-argument form = opens the instrument's UI | `piano.ui()` |
| `seq.ui("name")` / `sum("name").ui("name")` / `aux("name").ui("name")` | Opens the UI of every insert matching the name | `drums.ui("TAL Reverb 4")` |
| `seq.ui("name", false)` | Closes it | `drums.ui("TAL Reverb 4", false)` |

- Built-in plugins (such as `Gain`) have no UI, so passing a name for one is an explicit error.
- Zero matches is also an explicit error (it never silently no-ops).
- The open form of `ui()` is idempotent (re-evaluating the same line does not open it twice). Close is not idempotent.

---

## 8. Mixer — sum / aux / send / output

Features for grouping sequences into buses. For a full walkthrough, see [sum and aux/send](../mixing/routing.md).

| Signature | Description | Example |
|---|---|---|
| `global.sum(name)` | Declares a group bus (idempotent) | `global.sum("drum")` |
| `global.aux(name)` | Declares a return bus (idempotent) | `global.aux("rev")` |
| `sum("name")` / `aux("name")` | A reference to an already-declared bus (`.effect()` / `.ui()` can be chained) | `sum("drum").effect("GlueComp")` |
| `seq.output(name)` | Routes the sequence's output to a group bus (audio-sequence-only) | `kick.output("drum")` |
| `seq.output(n)` | Numbered render bus (1–16, score mode) | `kick.output(1)` |
| `seq.send(name, amount)` | Sets the amount sent to a return bus (fixed at post-fader; multiple sends allowed) | `kick.send("rev", 0.3)` |

- `sum` is a single level only (no nesting).
- `output(name)` / `send(name, amount)` are **audio-sequence-only** (not usable on note sequences in v1).
- The second argument to `send()` is a linear gain (roughly 0.0–1.0, with no hard clamp on the upper end).
- `global.linkAudio()` cannot be combined with mixer features (sum/aux/plugin effects in general).

---

## 9. Method Chains

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
