---
title: Building Patterns
description: How to use the play() method to build rhythm patterns
---

# Building Patterns

In [Your First Sound](../getting-started/first-sound.md), you wrote `drum.play(1, 1, 1, 1)` to play a sound on all four beats. This chapter explains what `play()` actually does and shows you how to add rests or subdivide beats more finely.

## The Basics of play()

The numbers passed as arguments to `play()` decide which slice (a piece of sound) is played on each beat.

The numbers have the following meanings:

| Value | Behavior |
|---|---|
| `0` | Rest (the beat is not played) |
| Integer `1` or greater | The slice number to play |

A slice is one of the pieces produced when an audio file is split with `chop()`. If you write `chop(1)` (or omit `chop()` altogether), the entire audio file is treated as "slice 1." In that case, writing `1` plays the whole file, and `0` produces silence. This is the typical setup when triggering one-shot drum samples.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var drum = init global.seq
drum.audio("kick.wav")
drum.play(1, 1, 1, 1)  // play kick.wav on all four beats

LOOP(drum)
```

## Adding Rests to Build a Pattern

Writing `0` makes the beat silent.

```text
drum.play(1, 0, 1, 0)  // play only on beats 1 and 3
```

In this example, beats 2 and 4 become rests. A basic beat combining a kick and a snare can be written as follows.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)  // kick on beats 1 and 3

var snare = init global.seq
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)  // snare on beats 2 and 4

LOOP(kick, snare)
```

The number of arguments you write inside `play()` becomes "how many beats this sequence subdivides each loop into." Four arguments give a four-beat subdivision, and eight arguments give an eight-beat subdivision.

## Eighth-note Patterns

If you pass eight arguments, you get a pattern subdivided into eighth notes (one bar split into eight equal parts).

```text
var hihat = init global.seq
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1, 1, 1, 1, 1)  // hi-hat on every eighth note
```

By mixing in `0`, you can freely create finer rests as well.

```text
hihat.play(1, 1, 1, 0, 1, 1, 1, 0)  // remove the 4th and 8th eighth notes
```

## Changing the Overall Length with length()

`length()` sets how many bars the entire pattern spans. If you omit it, the default is one bar.

```text
seq.length(1)   // 1-bar loop (default)
seq.length(2)   // 2-bar loop
seq.length(4)   // 4-bar loop
```

To write a two-bar pattern, list two bars' worth of arguments in `play()`.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav")
kick.length(2)
kick.play(
  1, 0, 0, 0,   // bar 1
  1, 0, 1, 0,   // bar 2 (with a slight variation)
)

LOOP(kick)
```

::: warning length() also affects pitch
Changing `length()` changes the time allocated to each event. If you are using `chop()` to split a file, the playback speed changes and the pitch shifts along with it. For example, setting `length(2)` halves the playback speed and lowers the pitch by one octave. With drum samples that use `chop(1)` (the default) and play the whole file, this is usually not a concern, but please be careful when using loop material chopped into smaller slices. This is explained in detail in [Audio Manipulation](./audio-manipulation.md).
:::

## Setting the Time Signature with beat()

`beat()` is the method that sets the time signature for a sequence. It plays a different role from `play()`, so please be careful not to confuse them.

```text
global.beat(4 by 4)   // set the global time signature to 4/4
global.beat(3 by 4)   // set the global time signature to 3/4
global.beat(5 by 4)   // set the global time signature to 5/4
```

You can also set an individual time signature on a sequence so that it runs in a different time signature from the global one. This usage is covered in detail in the polymeter chapter.

## Nested Rhythm Expressions

Using parentheses `()`, you can subdivide a single beat even further.

```text
drum.play(1, (1, 1), 0, 1)
// beat 1: kick
// beat 2: kick twice (the beat split into two equal parts)
// beat 3: rest
// beat 4: kick
```

The number of elements inside the parentheses determines how many equal parts the beat is divided into. Three elements give a triplet (three equal parts), and four give a quadruplet.

```text
// example with a triplet on beat 4
drum.play(1, 0, 1, (1, 0, 1))
```

You can nest multiple levels, but going too deep makes the pattern hard to read. We recommend keeping nesting to about two or three levels. An example of complex rhythms using nesting is included in `examples/04_nested_rhythms.orbs`.

## Summary

- The arguments of `play()` are slice numbers (`0` is a rest, `1` or greater is the slice number to play)
- The number of arguments determines how many beats the loop is subdivided into
- `length()` changes the total number of bars in the pattern (note that this also affects pitch)
- `beat()` sets the time signature; it does not define the rhythm pattern
- Parentheses `()` let you subdivide a single beat even further

Next, let us run multiple sequences at the same time and put together a real beat.

→ [Multiple Sequences](./multiple-sequences.md)
