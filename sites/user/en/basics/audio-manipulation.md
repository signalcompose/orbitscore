---
title: Audio Manipulation
description: How to slice audio files with chop, and shape the sound with volume and pan
---

# Audio Manipulation

So far, you have been triggering each audio file as a single sample played in full. OrbitScore also lets you cut a file into smaller pieces and adjust volume and stereo position (pan). This chapter pulls those operations together.

## chop — Slice an Audio File

`chop(N)` is a method that splits the loaded audio file into **N equal slices**. For example, you can take a single WAV file containing a chord progression or arpeggio and rearrange the slices in any order.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var arp = init global.seq
arp.audio("arpeggio.wav").chop(8)
arp.play(1, 2, 3, 4, 5, 6, 7, 8)

LOOP(arp)
```

The code above splits `arpeggio.wav` into eight equal pieces and plays them in order from the beginning: 1 → 2 → 3 → … → 8.

### Specifying Slice Numbers in play()

By listing slice numbers as arguments to `play()`, you can decide the playback order freely.

```text
// pick only the even slices
arp.play(2, 4, 6, 8)

// play in reverse order
arp.play(8, 7, 6, 5, 4, 3, 2, 1)

// any reordering you like
arp.play(3, 1, 4, 6, 2, 7)
```

Please use slice numbers within the range specified by `chop(N)` (1 through N).

### 0 is a Rest

If you write **0** as an argument to `play()`, that beat becomes silent.

```text
var drum = init global.seq
drum.audio("break.wav").chop(4)

// slice 1 → rest → slice 2 → slice 3
drum.play(1, 0, 2, 3)
```

This lets you insert a "gap" in the middle of a phrase.

### chop(1) — When You Do Not Split

Writing `chop(1)` keeps the file un-split and treats it as "one whole slice." For short one-shot samples like a typical kick or snare, `chop(1)` is the right fit.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)

LOOP(kick)
```

---

## length() — Change the Overall Pattern Length

`length(N)` specifies how many bars the sequence uses for one loop. Changing this value changes the playback duration of each slice, producing an effect close to time-stretching.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var phrase = init global.seq
phrase.audio("phrase.wav").chop(4)
phrase.play(1, 2, 3, 4)

phrase.length(1)   // play 4 slices over 1 bar
phrase.length(2)   // play 4 slices over 2 bars (slower)
phrase.length(4)   // play 4 slices over 4 bars (slower still)

LOOP(phrase)
```

::: warning The pitch changes
Because `length()` changes the playback speed, the pitch shifts along with it. Setting `length(2)` makes the result sound about one octave lower. This is by design, not a bug. You can also use the resulting pitch change as part of an intentional musical effect.
:::

---

## gain() — Adjust the Volume

`gain(dB)` adjusts the volume of the sequence in **dB (decibels)**. dB (decibels) is a unit that expresses loudness; 0 is the reference level, negative values make it quieter, and positive values make it louder.

| Value | Effect |
|---|---|
| `0` | Default (reference volume) |
| `6` | About twice as loud (+6 dB) |
| `-6` | About half as loud (-6 dB) |
| `-60` | Almost silent |

The valid range is from -60 dB to +12 dB.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)
kick.gain(-3)   // a little quieter

var snare = init global.seq
snare.audio("snare.wav").chop(1)
snare.play(0, 1, 0, 1)
snare.gain(0)   // default

LOOP(kick, snare)
```

`gain()` takes effect immediately, even during live coding. You can adjust the volume balance in real time while you perform.

---

## pan() — Adjust the Left-Right Stereo Position

`pan(value)` specifies the left-right position of the sound (the stereo pan) in the range from -100 to 100. "Pan" is short for "panorama" and refers to the volume balance between the left and right speakers.

| Value | Position |
|---|---|
| `-100` | Hard left |
| `-50` | Slightly left |
| `0` | Center (default) |
| `50` | Slightly right |
| `100` | Hard right |

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var hi_l = init global.seq
hi_l.audio("hihat_open.wav").chop(1)
hi_l.play(1, 0, 1, 0)
hi_l.pan(-60)   // toward the left

var hi_r = init global.seq
hi_r.audio("hihat_closed.wav").chop(1)
hi_r.play(0, 1, 0, 1)
hi_r.pan(60)    // toward the right

LOOP(hi_l, hi_r)
```

Like `gain()`, `pan()` also takes effect immediately during live coding.

---

## Writing With Method Chains

OrbitScore methods support chaining (connecting calls with `.`). The settings fit on a single line, which is convenient for fast typing during live coding.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

// multi-line version
var drum = init global.seq
drum.audio("break.wav")
drum.chop(8)
drum.play(1, 3, 5, 7, 2, 4, 6, 8)
drum.gain(-6)
drum.pan(-20)

// chain version (same meaning)
var drum2 = init global.seq
drum2.audio("break.wav").chop(8).play(1, 3, 5, 7, 2, 4, 6, 8).gain(-6).pan(-20)

LOOP(drum)
```

Long chains become more readable when you break them across lines and indent.

```text
var arp = init global.seq
arp
  .audio("arpeggio.wav")
  .chop(8)
  .play(1, 2, 3, 4, 5, 6, 7, 8)
  .gain(-3)
  .pan(0)
```

You can also continue a chain directly after `init global.seq`.

```text
var snare = init global.seq
  .length(1)
  .audio("snare.wav")
  .chop(1)
  .play(0, 1, 0, 1)
  .gain(-3)
  .pan(20)
```

---

## Summary

Here is a summary of the methods covered in this chapter.

| Method | Description |
|---|---|
| `chop(N)` | Splits the audio file into N slices |
| `play(1, 2, …)` | Specifies the playback order by slice number (0 is a rest) |
| `length(N)` | Changes the loop length to N bars (speed and pitch change as well) |
| `gain(dB)` | Adjusts the volume in dB (0 is the default; takes effect immediately) |
| `pan(value)` | Adjusts the stereo position from -100 to 100 (takes effect immediately) |

---

Next, let us look at the workflow of "live coding" — changing the music while the code is running.

→ [Live Coding](./live-coding.md)
