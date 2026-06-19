---
title: LinkAudio (Streaming to Ableton Live)
description: How to use global.linkAudio() and seq.output() to send OrbitScore audio directly to Ableton Live
---

# LinkAudio (Streaming to Ableton Live)

In OrbitScore 2.0.0, **LinkAudio** lets you send audio directly to Ableton Live. Unlike IAC-based MIDI, it streams audio signals over LAN.

## Prerequisites

- **macOS only**
- **Ableton Live 12.4 or later** must be running
- **OrbitLinkAudio.scx** plugin must be installed
- Live's session sample rate must match OrbitScore's setting (default: 48000 Hz)

---

## Basic Usage

Declare `global.linkAudio()` once at the top of your `.orbs` file. This routes **all audio sequences** in that file through LinkAudio.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.linkAudio()     // enable LinkAudio mode
global.start()

var kick = init global.seq
kick.audio("../audio/kick.wav").output("kick")
kick.play(1, 0, 1, 0)

var snare = init global.seq
snare.audio("../audio/snare.wav").output("snare")
snare.play(0, 1, 0, 1)

LOOP(kick, snare)
```

On the Live side:
1. In each audio track's "Audio From" selector, choose the OrbitScore `"kick"` / `"snare"` channel
2. Enable monitoring and start playback

::: warning LinkAudio and regular audio cannot coexist
When `global.linkAudio()` is declared, all audio sequences in that file go through LinkAudio. You cannot mix hardware output and LinkAudio in the same file.

However, **MIDI sequences** (using `seq.midi()`) are not subject to this restriction. Even when `global.linkAudio()` is declared, MIDI sequences are still sent to IAC as usual.
:::

---

## seq.output() — Specifying the Channel Name

`seq.output("name")` sets the channel name that Live uses to receive the audio.

```text
kick.audio("kick.wav").output("kick")      // received in Live as "kick"
snare.audio("snare.wav").output("snare")   // received in Live as "snare"
```

An audio sequence without `output()` causes a runtime error when `global.linkAudio()` is active (strict mode to prevent mixing).

### Summing to the Same Channel

When multiple sequences share the same channel name, they are **summed (mixed)** inside the plugin.

```text
global.linkAudio()

var hat_c = init global.seq
hat_c.audio("hihat_closed.wav").output("drums")
hat_c.play(1, 1, 1, 0)

var hat_o = init global.seq
hat_o.audio("hihat_open.wav").output("drums")
hat_o.play(0, 0, 0, 1)
// both are mixed into the Live "drums" channel
```

### Combining with gain() / pan()

`gain()` and `pan()` are applied to each sequence before summing.

```text
var ghost = init global.seq
ghost.audio("snare.wav").output("drums")
ghost.gain(-12).pan(-30)
ghost.play(0, (0, 1), 0, (1, 0))
```

---

## Setting the Sample Rate

Use `global.linkAudio(SR)` to explicitly match Live's session sample rate.

```text
global.linkAudio(48000)    // 48000 Hz (this is also the default)
global.linkAudio(44100)    // change to 44100 Hz
```

---

## Tempo

In OrbitScore 2.0.0, **OrbitScore acts as the Link tempo leader** (#283).

- The BPM set by `global.tempo()` is pushed to all Link peers
- Ableton Live follows that tempo
- **Tempo changes made from Live's side are not reflected back to OrbitScore in 2.0.0**

In practice, you manage tempo from OrbitScore and use Live as a follower.

---

## MIDI and LinkAudio Coexisting

MIDI sequences and LinkAudio audio sequences can run in parallel within the same file.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.key("C")
global.linkAudio()   // audio goes through LinkAudio
global.start()

// MIDI sequence (sent to IAC — outside LinkAudio's scope)
var piano = init global.seq
piano.midi("IAC", 1).octave(4).vel(84)
piano.play(1, 3, 5, 8)

// audio sequence (sent to Live via LinkAudio)
var kick = init global.seq
kick.audio("kick.wav").output("kick")
kick.play(1, 0, 1, 0)

LOOP(piano, kick)
```

---

## When OrbitLinkAudio.scx Is Not Available

If the plugin is not loaded and `global.linkAudio()` is declared, OrbitScore falls back to hardware output on the first dispatch (playback) and shows a warning.

---

## Next Pages

- Controlling loop launch timing with Launch Quantize → [Launch Quantize](./quantize.md)
- Method reference → [Reference](../reference/methods.md)
