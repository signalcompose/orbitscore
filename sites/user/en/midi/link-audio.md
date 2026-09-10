---
title: LinkAudio (Streaming to Ableton Live)
description: How to use global.linkAudio() and seq.output() to send OrbitScore audio directly to Ableton Live
---

# LinkAudio (Streaming to Ableton Live)

**LinkAudio** is the mechanism for sending audio directly to Ableton Live. Unlike IAC-based MIDI, it streams audio signals over LAN.

::: danger Audio does not reach Live in shipped builds (as of 2026-09-10)
**LinkAudio audio egress does not work in the shipped OrbitScore (`.vsix`).** You can still write `global.linkAudio()` and `seq.output()`, and neither raises an error, but **no channels appear on the Live side**.

There are two reasons.

- **OrbitLinkAudio.scx**, the SuperCollider plugin that used to carry the audio, was removed together with the whole SuperCollider path in [#502](https://github.com/signalcompose/orbitscore/issues/502) (2026-09-10)
- Its Rust replacement (`orbit-link-audio`) is **not included in shipped builds**. Turning it on would pull Ableton Link's license (GPL-2.0-or-later) into what is shipped, and that decision has not been made yet

⚠️ **What happens to the sound instead is not settled.** The spec (DSL spec §8.1) says playback falls back to hardware output and warns exactly once; a real-device measurement on 2026-09-04 found **no sound and no warning** (recorded at `tests/e2e/orbitstudio-mcp-gated.spec.ts:5113-5119`). **Until that is resolved, do not rely on LinkAudio for a performance.**

Pushing `global.tempo()` to Link peers is disabled for the same reason.

Read the rest of this page as **how it behaves on a build where egress is enabled**. The current state is recorded in [DSL spec §8.1](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md).
:::

## Prerequisites

- **macOS only**
- **Ableton Live 12.4 or later** must be running
- **A build with LinkAudio egress enabled** (see the warning above — shipped builds do not have it)
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

An audio sequence without `output()` is **skipped silently** while `global.linkAudio()` is active, and the reason is written to the log (strict mode to prevent mixing). It never falls back to hardware output on its own.

This used to raise a runtime error. During live coding an exception would take down **every other sequence in the same evaluation block** as well, so it became a skip plus a log line instead (#645). The editor still reports a missing `output()` as an error diagnostic before evaluation.

### Summing to the Same Channel

When multiple sequences share the same channel name, they are **summed (mixed)** on the egress side.

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

::: warning The tempo push is also disabled in shipped builds
Pushing tempo to Link peers rides on the **same mechanism** as audio egress. In shipped builds it is therefore disabled just like the audio, and you only get the one warning (see the notice at the top of this page).
:::

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

## When Egress Is Not Available in Your Build

Per the spec (DSL spec §8.1.3), if egress is unavailable and `global.linkAudio()` is declared, OrbitScore falls back to hardware output **on the first dispatch (playback)** and warns **exactly once**. Nothing happens at the moment you write `global.linkAudio()`.

The single warning is deliberate: so that the same reason does not pile up a warning per note, the warning is emitted from **exactly one place — where the channel is registered**.

⚠️ However, **this description conflicts with what was measured on real hardware**. On 2026-09-04 there was no sound (capture RMS = 0) and no warning (`tests/e2e/orbitstudio-mcp-gated.spec.ts:5113-5119`). See also the notice at the top of this page.

---

## Next Pages

- Controlling loop launch timing with Launch Quantize → [Launch Quantize](./quantize.md)
- Method reference → [Reference](../reference/methods.md)
