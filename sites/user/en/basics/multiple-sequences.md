---
title: Multiple Sequences
description: How to play multiple sequences such as kick, snare, and hi-hat at the same time
---

# Multiple Sequences

In [Building Patterns](./patterns.md), you assigned a kick to a single sequence and made it play. A real beat comes together when several sounds — kick, snare, hi-hat, and so on — play together. This chapter covers how to run multiple sequences in parallel and control them as a group.

## Creating Multiple Sequences

You can create as many sequences as you like with `var <name> = init global.seq`. Each one is given its own audio file and rhythm pattern.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 0, 0)  // beat 1 only

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 0, 1, 0)  // beat 3 only

var hihat = init global.seq
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1)  // all four beats

LOOP(kick, snare, hihat)
```

This makes the three sequences kick, snare, and hihat loop at the same time.

## Building a Loop Group with LOOP

`LOOP()` works as a **single-side toggle (Unidirectional Toggle)**. Only the sequences passed to `LOOP()` enter the loop group; any sequence not passed in is automatically removed from the group and stopped.

```text
LOOP(kick, snare, hihat)   // all three loop
LOOP(kick, snare)          // only kick and snare remain; hihat stops
LOOP(kick)                 // only kick remains; snare also stops
LOOP()                     // everything stops
```

When you want to stop a particular sequence, you simply rewrite `LOOP()` without it and run that line again. There is no need to write a separate `STOP` command.

## One-shot Playback with RUN

`RUN()` plays the specified sequences exactly once. They do not loop.

```text
RUN(kick, snare, hihat)   // play each of the three once
```

`LOOP()` and `RUN()` operate independently. You can include the same sequence in both.

```text
LOOP(kick, snare)   // kick and snare loop
RUN(hihat)          // hihat plays once at this point in time
```

## Silencing Individual Sequences with MUTE

`MUTE()` turns on the mute flag for the specified sequences. The loop continues, but no sound is produced.

```text
LOOP(kick, snare, hihat)   // all three loop
MUTE(hihat)                // hihat is muted (the loop continues)
```

If you rewrite `MUTE()` with a different sequence, the previous mute is released.

```text
MUTE(kick)    // mute kick; the previous mute on hihat is automatically released
MUTE()        // release all mutes (no arguments)
```

::: info MUTE only affects LOOP
The mute flag applies only to the `LOOP` group. Sequences played with `RUN()` are unaffected by mute, so even a sequence that is currently muted will produce sound when triggered with `RUN()`.
:::

## A Practical Example: A Basic Drum Beat

Here is a typical 4/4 beat using kick, snare, and hi-hat.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 0, 0)  // beat 1

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 0, 1, 0)  // beat 3

var hihat = init global.seq
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1)  // quarter notes

LOOP(kick, snare, hihat)
```

After running this, please try modifying the code little by little.

- Change to `kick.play(1, 0, 1, 0)` to add a kick on beat 3 as well
- Change to `hihat.play(1, 1, 1, 1, 1, 1, 1, 1)` to play the hi-hat in eighth notes
- Run `MUTE(hihat)` to silence only the hi-hat

After making changes, you can apply them by selecting the modified line and pressing `Cmd+Enter` (`Ctrl+Enter` on Windows / Linux).

## Combining Two-bar Patterns

Each sequence can have its own length set with `length()`. You can combine, for example, a one-bar kick loop with a two-bar snare pattern.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.length(1)
kick.play(1, 0, 1, 0)  // 1-bar pattern

var snare = init global.seq
snare.audio("snare.wav")
snare.length(2)
snare.play(
  0, 0, 1, 0,       // bar 1
  0, 0, 1, (1, 1),  // bar 2 (with a fill)
)

LOOP(kick, snare)
```

## Summary

- You can create as many sequences as you like by writing `var <name> = init global.seq` multiple times
- `LOOP(seq1, seq2, ...)` loops several sequences at the same time
- Sequences not passed to `LOOP()` are removed from the group and automatically stopped
- `RUN(seq1, ...)` plays sequences once (no looping)
- `MUTE(seq1, ...)` silences specific sequences during a loop (affects `LOOP` only)

Next, let us try one of OrbitScore's defining features: running different time signatures and tempos at the same time, known as polymeter and polyrhythm.

→ [Polymeter and Polyrhythm](./polyrhythm.md)
