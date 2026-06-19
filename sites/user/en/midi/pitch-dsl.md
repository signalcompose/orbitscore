---
title: Pitch DSL (Degrees & Chords)
description: Degree notation, chord stacks, octave shifts, pattern variables, and repetition
---

# Pitch DSL (Degrees & Chords)

In a MIDI sequence, `play()` takes **degrees** instead of slice numbers. A degree is a number that expresses an interval from the tonic (root note). For example, with `global.key("C")`, degree `1` is C and degree `3` is E.

## Basic Degree Notation

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.start()

var piano = init global.seq
piano.midi("IAC", 1)
piano.octave(4)
piano.vel(96)
piano.length(1)
piano.play(1, 3, 5, 1)   // C4 E4 G4 C4

LOOP(piano)
```

Valid degrees are **1–9, 11, 13**. 10, 12, and 14 or higher are not allowed (use the `^N` notation below to change the octave).

| Degree | Note in C major |
|---|---|
| `1` | C |
| `2` | D |
| `3` | E |
| `4` | F |
| `5` | G |
| `6` | A |
| `7` | B |
| `8` | C (same as degree 1 one octave up) |
| `9` | D (a major ninth above degree 1) |
| `0` | Rest |

### Accidentals

Flat `b` and sharp `#` can be prepended to a degree.

```text
piano.play(1, b3, 5, b7)   // minor 3rd and minor 7th (minor-7th chord tones)
piano.play(1, 3, #5, 7)    // augmented 5th
```

---

## `^N` — Octave Shift (Sticky)

Appending `^N` to a note shifts it N octaves up (or down). The shift **persists (sticky)**, so it carries over to subsequent notes.

```text
piano.play(1, 3, 5^+1, 7)
// 1=C4, 3=E4, 5^+1=G5 (+1 oct), 7=B5 (the prior ^+1 persists)
```

Write `^0` to return to the base register.

```text
piano.play(1^+1, 3, 5, 1^0, 3, 5)
// 1^+1=C5, 3=E5, 5=G5, 1^0=C4 (^0 resets), 3=E4, 5=G4
```

Use a minus sign to shift downward.

```text
piano.play(1^-1, 3^-1, 5^-1)   // one octave lower
```

---

## `[ ]` — Chord Stack (Simultaneous Notes)

Writing multiple degrees inside `[ ]` sounds a **chord** on that beat.

```text
piano.play([1, 3, 5])         // C triad (C E G)
piano.play([1, 3, 5, 7])      // Cmaj7 chord
piano.play([1, b3, 5, b7])    // Cm7 chord
```

You can line up multiple chords to create a chord progression.

```text
piano.play([1, 3, 5], [5, 7, 2], [6, 8, 3], [4, 6, 8])
// C triad → G triad → Am → F
```

### Storing Chords in Variables

Frequently used chords can be stored in variables for reuse.

```text
var m7 = [1, b3, 5, b7]     // minor 7th chord

piano.play(m7, 0, m7, 0)    // Cm7 · Cm7 ·
```

Chord variables use `[ ]` notation, making them "vertical (simultaneous) values." They are distinct from `( )` pattern variables (described below).

### Spread, Adding, and Removing Notes

```text
var m7    = [1, b3, 5, b7]
var m7add9 = [m7, 9]         // add a 9th to m7
var m7omit5 = [m7, -5]       // remove the 5th from m7
```

### Stdlib Chords

```text
import chords

piano.play(maj7, m7, dom7)   // Cmaj7, Cm7, C7
```

`import chords` makes the standard library's predefined chords available (`m7`, `maj7`, `dom7`, `m7b5`, `dim7`, `sus4`, etc.).

---

## `*n` — Repetition

Appending `*n` places that element **n slots** in a row.

```text
var riff = (1, 5, 8, 5)

bass.play(riff*2)   // riff repeated twice (4 slots × 2 = 8 slots)
```

::: warning Different from Tidal's `*`
In OrbitScore, `*n` **occupies n slots** (equivalent to Tidal's `!`). It is not Tidal's `*n` (subdividing one slot into n equal parts). To repeat inside one slot, use nesting such as `(1, 1)`.
:::

---

## Pattern Variables and Section Variables

Wrapping a pattern in `( )` and assigning it to a variable lets you reuse it to build up the structure of a piece.

```text
var riff = (1, 5, 8, 5)          // pattern variable (1 cell)
var sec  = (1, 3, 5), (5, 3, 1)  // section variable (comma-separated = 2 cells)

bass.play(riff*2)                // repeat riff twice
lead.play(sec, sec)              // lay out the 2 cells of sec twice (e.g. AABA form)
```

Using variables lets you organize each section (A, B, C, etc.) of a piece cleanly.

::: tip When variables are evaluated
Variables are expanded when `play()` is evaluated. Redefining a variable does not affect a pattern that is already running. To change the pattern, execute `play()` again.
:::

---

## `{ }` — Legato (Slur) Group

Notes enclosed in `{ }` overlap slightly with the next note (slur effect).

```text
piano.play({1, 3, 5, 8})   // 4 notes connected smoothly
```

---

## `_` — Tie (Extend a Note)

A standalone `_` extends the previous note by one slot (no retrigger).

```text
piano.play(1, _, 3)   // hold 1 for 2 slots, then 3
```

To extend an entire chord stack, place `_` immediately after the chord.

```text
piano.play([1, 3, 5], _)   // hold the C triad for 2 slots
```

---

## `@v` and `@g` — Per-Note Expression

Use `@v` and `@g` modifiers to vary velocity or gate on individual notes.

```text
piano.play(5@v110, 3@v60, 1@v80)   // absolute velocity per note
piano.play(5@v+20, 1@v-10)         // relative to the sequence's vel()
piano.play(5@g30, 1@g100)          // gate as a percentage (30 = 0.30 = staccato)
```

`@v` and `@g` can be combined.

```text
piano.play(5@v110@g30)   // loud + staccato
```

---

## Next Pages

- Modes and scales → [Modes and Scales](./mode-scale.md)
- Voicing operators, randomness, voice leading → [Voicing & Voice Leading](./voicing.md)
