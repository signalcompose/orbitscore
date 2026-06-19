---
title: MIDI Output
description: How to send MIDI from OrbitScore via IAC, and how to build basic sequences
---

# MIDI Output

In OrbitScore 2.0.0 you can send MIDI via IAC Bus. Pitch, velocity, and articulation can be delivered directly from the OrbitScore DSL to your synths and software instruments.

## Setting Up IAC

1. Open **Audio MIDI Setup** (Launchpad → Other → Audio MIDI Setup)
2. In the top menu, choose **Window** → **MIDI Studio**
3. Double-click **IAC Driver** and check **Device is online**
4. In the DAW that should receive MIDI (e.g. Ableton Live), set the IAC Driver port as a MIDI input

---

## Switching a Sequence to MIDI

Calling `seq.midi()` turns that sequence into a MIDI sequence. The numbers written in `play()` are interpreted as **degrees** (not slice numbers).

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")    // set the tonic to C
global.start()

var piano = init global.seq
piano.midi("IAC", 1)   // send to the first port whose name contains "IAC", on ch 1
piano.octave(4)        // degree 1 = C4 (MIDI 60)
piano.vel(96)          // default velocity (1–127)
piano.gate(0.8)        // default gate ratio (0.8 = 80% of one slot)
piano.length(1)
piano.play(1, 3, 5, 8)  // C E G C(+1 oct)

LOOP(piano)
```

This example plays degrees 1, 3, 5, and 8 (degree 1 one octave up) of the C major scale.

::: info Difference from audio()
A sequence declared with `seq.midi()` becomes a MIDI sequence. You cannot use both `audio()` and `midi()` on the same sequence. However, running a MIDI sequence and an audio sequence **as separate variables** in parallel is fine.
:::

### Specifying the Port Name

The first argument of `midi(portName, channel)` performs a **substring match** against the CoreMIDI output port names.

- `"IAC"` → connects to the first port whose name contains "IAC"
- If multiple ports match, the first one is used and a warning is shown
- If no port matches, an error is raised and a list of available port names is displayed

---

## Basic Parameters

### octave() — Base Octave

`seq.octave(N)` sets "the octave that degree 1 belongs to." The default is `4` (C4 = MIDI 60).

```text
piano.octave(4)   // degree 1 = C4 (default)
piano.octave(3)   // degree 1 = C3 (one octave lower)
```

### vel() — Velocity

`seq.vel(N)` sets the default velocity for the entire sequence (1–127; default 96).

```text
piano.vel(80)    // slightly softer
piano.vel(110)   // louder
```

### gate() — Gate Ratio

`seq.gate(N)` sets the fraction of the slot duration for which the note sounds (default 0.8; clamped 0–1).

| Value | Character |
|---|---|
| `0.3` | Staccato (short and detached) |
| `0.8` | Standard (default) |
| `1.0` | Sounds for the full slot (upper limit) |

::: info Overlapping notes
`gate` is clamped to 0–1, so a value like `gate(1.2)` becomes `1.0`. To overlap notes (legato), use a `{ }` legato group (see [Pitch DSL](./pitch-dsl.md)).
:::

---

## global.key() — Setting the Tonic

> ⚠️ **Specification as of 2.0.0 — scheduled for revision post-2.0**
>
> The root/key interfaces such as `global.key()` / `seq.root()` are scheduled for a design revision after the 2.0.0 release. The behavior described on this page reflects 2.0.0.

`global.key("C")` sets the tonic (root note name) for the entire file. This is the reference used to resolve degree numbers in MIDI sequences.

```text
global.key("C")     // C as the root
global.key("D")     // D as the root
global.key("F#")    // F# as the root
global.key("D3")    // D as the tonic, with degree 1 anchored to D3
```

Adding an octave number as in `global.key("D3")` lets you manage the register of the root note in one place (individual sequences can still override it with `seq.octave()`).

---

## global.midiLatency() — MIDI Latency Compensation

A fixed offset for aligning the timing of SuperCollider's audio output with its MIDI output by ear.

```text
global.midiLatency(20)  // send MIDI 20 ms early (default 0)
```

---

## Complete Example

```text
var global = init GLOBAL
global.tempo(100)
global.beat(4 by 4)
global.key("C")
global.start()

var piano = init global.seq
piano.midi("IAC", 1)
piano.octave(4)
piano.vel(90)
piano.gate(0.7)
piano.length(2)
piano.play(
  1, 0, 3, 0,   // bar 1: C · E ·
  5, 0, 8, 0,   // bar 2: G · C(+1) ·
)

LOOP(piano)
```

---

## Next Pages

- Degree notation, register, and chord writing → [Pitch DSL (Degrees & Chords)](./pitch-dsl.md)
- Modes and scales → [Modes and Scales](./mode-scale.md)
- Audio output to Ableton Live → [LinkAudio](./link-audio.md)
