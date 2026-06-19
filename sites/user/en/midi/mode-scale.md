---
title: Modes & Scales
description: Defining custom pitch lattices with mode(), and applying them to a group with (..).mode(name)
---

# Modes & Scales

In OrbitScore you can define any scale (mode) with `mode()`, and create a group that uses only the pitches of that scale with `(..).mode(name)`.

> ⚠️ **Specification as of 2.0.0 — scheduled for revision post-2.0**
>
> Root/key interfaces including `.root()` are scheduled for a design revision after the 2.0.0 release. The `mode()` feature itself is stable, but combinations with `.root()` may change in the future.

---

## Defining a Scale with mode()

The arguments to `mode(...)` are the pitches of the scale written as degrees.

```text
var dorian = mode(1, 2, b3, 4, 5, 6, b7)   // Dorian scale
var lydian = mode(1, 2, 3, #4, 5, 6, 7)    // Lydian scale
var penta  = mode(1, 2, 3, 5, 6)           // Pentatonic (5-note scale)
```

Mode definitions are written as intervals from the tonic. With `global.key("C")`, Dorian becomes C Dorian (C D Eb F G A Bb).

---

## Applying a Mode to a Group with (..).mode(name)

Apply a mode defined with `mode()` to a group using the `(..).mode(name)` form.

```text
var global = init GLOBAL
global.tempo(110)
global.beat(4 by 4)
global.key("C")
global.start()

var dorian = mode(1, 2, b3, 4, 5, 6, b7)

var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.length(1)
lead.play((1, 3, 5, 7, 8, 7, 5, 3).mode(dorian))
// In C Dorian: C Eb G Bb C Bb G Eb

LOOP(lead)
```

Inside a `.mode()` group, "degree 1" is the first pitch of that mode. Because indexing follows the mode's lattice (pitch ordering), the interpretation is separate from the outside context (`global.key()`'s reference scale).

### Custom Period (Microtonal, etc.)

You can explicitly set the pitch range (period) of a scale (default: the next octave boundary above the scale's highest pitch).

```text
var custom = mode(1, 2, b3, 4, #5, 6, 7, 9).period(19)   // 19-semitone period
```

---

## Specifying a Group's Root with .root()

Adding `.root()` to a group changes the root note for that group. `seq.root()` also sets the sequence-wide default root.

> ⚠️ **Specification as of 2.0.0 — scheduled for revision post-2.0**
>
> The `.root()` interface is scheduled for a design revision after the 2.0.0 release (possible removal of `.root()` or migration to a postfix form). The behavior described on this page reflects 2.0.0.

```text
var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.root(1)         // sequence default = degree 1 (the tonic of global.key)

lead.play(
  (1, 3, 5).root(2),    // this group resolves with degree 2 as the root
  (1, 3, 5).root(F),    // resolve with note name F as the root (group level only)
  (1, 3, 5),            // default (seq.root(1) = tonic C)
  (1, 5).oct(1),        // same shape played one octave higher
)
```

**Notes**:
- `seq.root()` accepts **degrees only** (note names are valid at the group level only)
- `.root()` and `.mode()` cannot both be applied to the same group
- Groups without an explicit setting fall back to the sequence default (they do not carry over the previous group's state)

---

## Example: Changing the Mode per Group

`.mode()` is applied at the group level. Because `.root()` and `.mode()` cannot be combined on the same group (see above), only mode switching is shown here.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.start()

var dorian = mode(1, 2, b3, 4, 5, 6, b7)

var lead = init global.seq
lead.midi("IAC", 1)
lead.octave(4)
lead.root(1)

// apply dorian per group (no annotation = sequence default)
lead.play(
  (1, 3, 5, 7).mode(dorian),   // C Dorian
  (1, 3, 5, 7),                // no annotation → sequence default (major)
  (1, 3, 5, 7).mode(dorian),   // C Dorian again
)

LOOP(lead)
```

When you want to move the root without changing the mode, use a group with `.root(n)` only (the mode stays at the sequence default):

```text
lead.play(
  (1, 3, 5),          // C (seq.root(1))
  (1, 3, 5).root(2),  // root moves to D
  (1, 3, 5).root(5),  // root moves to G
)
```

---

## Next Page

- Voicing operators, randomness, voice leading → [Voicing & Voice Leading](./voicing.md)
