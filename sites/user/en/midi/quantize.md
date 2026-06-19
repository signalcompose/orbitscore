---
title: Launch Quantize
description: Using global.quantize() and seq.quantize() to align LOOP launch timing to a grid
---

# Launch Quantize

When switching between sequences during live coding, loops that start at arbitrary moments sound musically unaligned. **Launch Quantize** holds a `LOOP()` launch or a `play()` swap until the next bar boundary, locking it to the grid.

---

## global.quantize() — Global Setting

```text
global.quantize("bar")   // default — wait until the next bar boundary before launching
global.quantize("beat")  // align to every beat
global.quantize("2bar")  // accept only every 2 bars
global.quantize("4bar")  // every 4 bars
global.quantize("8bar")  // every 8 bars
global.quantize("off")   // immediate execution (for a raw, live feel)
```

The default is `"bar"` (wait one bar). The behavior mirrors Ableton Live's Global Quantization setting.

---

## seq.quantize() — Per-Sequence Setting

Use `seq.quantize()` when you want a specific sequence to move on a different grid. Sequences without an explicit setting inherit the global value.

```text
global.quantize("bar")    // default: 1-bar wait

var fill = init global.seq
fill.quantize("off")      // this sequence launches immediately (for drops and fills)

var chord = init global.seq
chord.quantize("4bar")    // this sequence launches on a 4-bar grid
```

---

## What Is and Is Not Affected

| Operation | Quantize applies? |
|---|---|
| New `LOOP()` launch | ✅ Yes (waits for grid) |
| `play()` swap inside a LOOP | ✅ Yes (waits for grid) |
| `RUN()` | ❌ No (**always immediate**) |
| `gain()` / `pan()` inside a LOOP | ❌ No (always immediate) |
| `audio()` / `chop()` inside a LOOP | ❌ No (always immediate) |

::: info RUN() is not affected by Quantize
`RUN()` is a one-shot (plays once), so it always executes immediately. Use `RUN()` when you want to fire a fill on the spot.
:::

---

## Usage Example

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.quantize("bar")   // align everything to a 1-bar grid
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)

// LOOP launches — will start on the next bar boundary
LOOP(kick, snare)

// play() swap also waits for the next bar boundary
kick.play(1, 1, 0, 0)

// fire a fill immediately
RUN(kick)
```

---

## Combining with Polymeter

The quantize grid is determined by the global `beat()` × `tempo()`. Sequences with their own time signature (e.g. `seq.beat(5 by 4)`) still use the global bar boundary as their launch reference.

---

## Next Pages

- Method reference → [Reference](../reference/methods.md)
- Troubleshooting → [Troubleshooting](../troubleshooting.md)
