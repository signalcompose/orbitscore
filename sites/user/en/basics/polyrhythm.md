---
title: Polymeter and Polyrhythm
description: A look at one of OrbitScore's defining features — running sequences with different time signatures and tempos at the same time
---

# Polymeter and Polyrhythm

One of OrbitScore's defining features is the ability to run sequences with different time signatures and tempos at the same time. This chapter introduces three concepts: "polymeter," "polyrhythm," and "polytempo."

## Sorting Out the Three Concepts

| Concept | Meaning |
|---|---|
| polymeter | Run patterns of different time signatures (such as 4/4 and 5/4) at the same time |
| polyrhythm | Layer rhythms with different subdivisions over the same span of time (such as 3 against 4) |
| polytempo | Run sequences with different BPMs at the same time |

All three are mechanisms that produce the appeal of rhythms drifting against one another. Each of them can be expressed in just a few lines of OrbitScore's DSL.

## Polymeter: Running Different Time Signatures Together

When you set an individual time signature on each sequence with `beat()`, the sequence runs independently of the global time signature.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// kick in 4/4
var kick = init global.seq
kick.audio("kick.wav")
kick.beat(4 by 4)
kick.play(1, 0, 0, 1)  // beats 1 and 4

// snare in 5/4 (the cycle drifts against the 4-beat cycle)
var snare = init global.seq
snare.audio("snare.wav")
snare.beat(5 by 4)
snare.play(0, 0, 1, 0, 1)  // beats 3 and 5

LOOP(kick, snare)
```

The kick completes one cycle in 4 beats, and the snare completes one cycle in 5 beats. It takes 5 cycles of the kick and 4 cycles of the snare for both downbeats to line up again (the least common multiple of 4 and 5 = 20 beats). Until that point, the two patterns gradually drift against each other, creating a unique groove.

An example layering three different time signatures is included in `examples/03_polymeter_polytempo.orbs`. When 3/4, 4/4, and 5/4 run at the same time, the three line up again after 60 beats (the least common multiple of 3, 4, and 5).

## Polyrhythm: Different Subdivisions Within the Same Span

Polyrhythm is similar to polymeter, but it is achieved by dividing "the same span of time" into different numbers of equal parts. With the nested syntax of `play()`, you can run a triplet and a quadruplet within a single bar at the same time.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// 1 bar split into 3 (a triplet-like feel)
var three = init global.seq
three.audio("hihat.wav")
three.length(1)
three.play((1, 0, 1), (0, 1, 0))  // 1 bar = 2 groups × 3-way split

// 1 bar split into 4 (quarter-note feel)
var four = init global.seq
four.audio("snare.wav")
four.length(1)
four.play(0, 1, 0, 1)  // beats 2 and 4

LOOP(three, four)
```

::: info The difference between polymeter and polyrhythm
Polymeter is "the time signatures (loop lengths) differ," while polyrhythm is "the loop length is the same, but the number of subdivisions inside differs." The resulting feeling of drift is similar, but the underlying mechanism is different.
:::

## Polytempo: Running Sequences at Different Tempos

When you set an individual tempo on a sequence with `seq.tempo()`, the sequence runs independently of the global tempo.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// kick that runs at the global tempo (120 BPM)
var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

// a slower sequence at half speed (60 BPM)
var slow = init global.seq
slow.tempo(60)  // setting an individual tempo detaches it from the global one
slow.audio("snare.wav")
slow.beat(4 by 4)
slow.length(2)
slow.play(1, 0, 0, 0, 0, 0, 1, 0)

// a faster, finer sequence at double speed (240 BPM)
var fast = init global.seq
fast.tempo(240)
fast.audio("hihat.wav")
fast.beat(4 by 4)
fast.play(1, 0, 1, 0, 1, 0, 1, 0)

LOOP(kick, slow, fast)
```

Once you call `seq.tempo()`, that sequence is no longer affected by global tempo changes (`global.tempo()` or `global._tempo()`). Sequences with their own tempo keep running unchanged, while sequences that follow the global tempo are the only ones that change.

## Summary

- `seq.beat(N by 4)` lets you set the time signature per sequence to create polymeter
- The nesting in `play()` lets you divide the same span into different numbers of parts to create polyrhythm
- `seq.tempo(BPM)` lets you set an independent tempo per sequence to create polytempo
- The drifting cycles return to alignment after "the least common multiple of the numbers" beats

To hear how the rhythmic drift sounds, please run the code yourself and listen. Changing a single number can transform the groove dramatically; this is part of what makes OrbitScore enjoyable.

Next, let us learn about audio manipulation: slicing audio files and adjusting volume and pan.

→ [Audio Manipulation](./audio-manipulation.md)
