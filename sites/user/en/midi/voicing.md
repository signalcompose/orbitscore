---
title: Voicing & Voice Leading
description: Voicing operators that reshape chord positions, adding randomness, smooth voice leading, and the comp rhythm feature
---

# Voicing & Voice Leading

Writing a chord alone places all voices in a tight, close-position arrangement. Voicing operators let you express common chord voicings — drop 2, inversions, and more — directly in the DSL. You can then use `.voicelead()` to smooth out voice motion, and `.comp()` to add a jazz comping rhythm.

---

## Voicing Operators

Voicing operators are used as method chains on chord values (`[ ]`). All computations are **deterministic and evaluated at run time** — they do not change between loops.

```text
import chords

var piano = init global.seq
piano.midi("IAC", 1)
piano.octave(4)
piano.length(1)

piano.play(
  [1, 3, 5, 7].drop(2),      // Drop 2 (lower the 2nd-from-top voice by one octave)
  [1, 3, 5, 7].drop(2, 4),   // Drop 2 & 4
  [1, 3, 5, 7].invert(2),    // Raise the bottom 2 voices by one octave (2nd inversion)
  maj7.open(),               // Open position
)
```

### Operator Reference

| Notation | Effect |
|---|---|
| `.drop(n)` | Lower the Nth voice from the top by one octave (Drop 2, etc.) |
| `.drop(n, m)` | Drop multiple voices (Drop 2 & 4) |
| `.invert(n)` | Raise the bottom N voices by one octave (inversion) |
| `.open()` | Close then lower the 2nd-from-top voice by one octave (Drop 2 / open position) |
| `.close()` | Close position |
| `.shell()` | Root + 3rd + 7th only (5th omitted — shell voicing) |
| `.rootless()` | Remove the root (degree 1) |

::: tip Counting "the Nth from the top"
Voices are counted downward in the order they are written. For `[1, 3, 5, 7]`: position 1 = 7th, position 2 = 5th, position 3 = 3rd, position 4 = root (descending by written order).
:::

---

## Randomness

The DSL provides three kinds of randomness. All are **re-rolled each cycle** (they change on every loop pass).

### `Xr` — Randomly Sound a Note

```text
piano.play(1, 3r, 5, 8)   // degree 3 sounds on ~50% of cycles
```

### `.r` — Chord Thinning

```text
piano.play([1, 3, 5, 7].r)   // each voice sounds on ~50% of cycles
                              // all voices can drop out (minimum voice count is not guaranteed)
```

### `^r` — Random Octave (-1/0/+1)

```text
piano.play(1, 3, 5^r, 8)    // degree 5 shifts randomly by -1, 0, or +1 octave each cycle (0 = no shift)
```

::: info Reproducibility
`.orbslog` (the session log) records execution, but randomness is re-rolled on playback (no fixed seed). In 2.0.0, the session log is off by default (opt-in: `ORBITSCORE_SESSION_LOG=1`).
:::

---

## `.voicelead()` — Automatic Voice Leading

Adjusts the octave placement between successive chord stacks so that each voice moves by the smallest interval possible.

```text
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)

lead.play(([1, 3, 5], [5, 7, 2], [6, 8, 3], [4, 6, 8]).voicelead())
// each chord's voices move smoothly to the nearest pitch rather than leaping

LOOP(lead)
```

`seq.voicelead()` applies voice leading as the sequence default (alias: `seq.vl()`).

```text
lead.voicelead()
lead.play([1, 3, 5], [5, 7, 2])   // automatically voice-led
```

**Behavior**:
- Deterministic (does not change cycle to cycle). Computed once on first execution
- The first chord stays exactly as written; subsequent chords move toward the nearest available position
- Pitch classes (note names) are never changed — only octave choices are adjusted
- When chords have different voice counts, voice leading is applied to the extent possible

---

## `.comp()` — Comp Rhythm

`.comp()` expands each chord into a rhythmic pattern called a "comping cell." Pass chords as a chord progression: one chord equals one bar of expansion.

```text
var piano = init global.seq
piano.midi("IAC", 2)
piano.octave(4)
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2])
// 2 chords → 2 bars (length is set to 2 automatically)
```

### Cell Types

| Cell name | Rhythmic character |
|---|---|
| `"charleston"` | Charleston (default) — classic off-beat pattern in 8 subdivisions |
| `"quarters"` | Quarter-note based |
| `"twofour"` | Beats 2 and 4 |
| `"redgarland"` | Red Garland-style |
| `"offbeats"` | Off-beat heavy |

The default is `"charleston"`. Omitting the cell also uses charleston.

```text
piano.comp([1, 3, 5])              // default (charleston)
piano.cell("quarters").comp([1, 3, 5])   // quarters cell
```

### density() — Random Comp by Density

Instead of a cell, you can place onsets at a specified density on an eighth-note grid.

```text
piano.density(0.6).comp([1, 3, 5])   // place attacks on ~60% of eighth-note positions
piano.density(0)                      // all attacks removed (laying out)
```

### Combining with .voicelead()

`.comp()` and `.voicelead()` can be used together.

```text
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2]).voicelead()
```

---

## Complete Example

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")

import chords

// chord progression with voice leading
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)
lead.play(([1, 3, 5], [5, 7, 2], [6, 8, 3], [4, 6, 8]).voicelead())

// charleston comp (2 bars)
var piano = init global.seq
piano.midi("IAC", 2)
piano.octave(4)
piano.cell("charleston").comp([1, 3, 5], [5, 7, 2])

global.start()
RUN(lead, piano)
```

---

## Next Pages

- Audio output to Ableton Live (LinkAudio) → [LinkAudio](./link-audio.md)
- Method reference → [Reference](../reference/methods.md)
