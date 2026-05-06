---
title: What is OrbitScore
description: OrbitScore is a DSL and audio engine for making live coding music in VS Code
---

# What is OrbitScore

OrbitScore is a tool for making music inside VS Code by writing short pieces of code. You can change sounds, add rhythms, and shift the tempo on the fly without saving the file. This is called "live coding."

This site walks you through the journey from making your very first sound with OrbitScore to performing live, step by step.

## Who This Is For

- Those who find it tedious to click around with a mouse in a DAW (digital audio workstation) to enter notes
- Those interested in making music by writing code
- Those who enjoy improvisation (jamming or live performance)
- Those who find the idea of expressing complex rhythms in just a few lines of code intriguing

You do not need much programming experience. The first few chapters cover the basics together.

## What You Can Do

The DSL (a small programming language designed for a specific purpose) you write in OrbitScore looks like this:

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var drum = init global.seq
drum.audio("kick.wav").chop(1)
drum.play(1, 1, 1, 1)

LOOP(drum)
```

This code expresses "keep playing the kick sound at even intervals for four beats." Once you write this in VS Code and press `Cmd+Enter` (on macOS), the sound starts playing right away.

## Features of OrbitScore

### A Simple DSL

Method chains (the way of connecting calls with `.`, like `drum.audio(...).chop(...)`) let you express what you want intuitively.

### Designed for Live Coding

You can run only the part of your code you select, without saving the file. This means you can rewrite patterns measure by measure during a performance.

### Polymeter and Polyrhythm Support

Running patterns of different time signatures simultaneously is called "polymeter," and combining different tempos is called "polyrhythm." Both are easy to express with OrbitScore's syntax. See [Polymeter and Polyrhythm](./basics/polyrhythm.md) for details.

### Backed by SuperCollider

The actual sound is produced by [SuperCollider](https://supercollider.github.io/), an audio engine with a long history. OrbitScore's VS Code extension comes with SuperCollider bundled, so you do not need to install it separately.

## How to Read This Site

Reading the chapters in order should give you a smooth learning curve:

1. **This page** (What is OrbitScore)
2. [Installation](./getting-started/installation.md)
3. [Your First Sound](./getting-started/first-sound.md) — by the end of this chapter, you will have made sound with OrbitScore
4. [Building Patterns](./basics/patterns.md)
5. [Multiple Sequences](./basics/multiple-sequences.md)
6. [Polymeter and Polyrhythm](./basics/polyrhythm.md)
7. [Audio Manipulation](./basics/audio-manipulation.md)
8. [Live Coding](./basics/live-coding.md)
9. [Reference](./reference/methods.md) — a quick lookup for all methods
10. [Troubleshooting](./troubleshooting.md)

You can also open chapter 9 (Reference) or chapter 10 (Troubleshooting) on their own when you need them.

## System Requirements

- macOS Apple Silicon (Macs with M1, M2, M3, etc.)
- VS Code or Cursor (version 1.99.0 or later)

Intel Mac, Windows, and Linux are not supported in v1. (Some Intel Macs may work, but this is unverified.)

## Next Step

Let's start by installing the VS Code extension.

→ [Installation](./getting-started/installation.md)
