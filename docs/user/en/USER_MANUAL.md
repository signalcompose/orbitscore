# OrbitScore User Manual

**Version**: 3.0 (Audio-Based DSL)
**Last Updated**: 2025-10-26

## Table of Contents

- [Introduction](#introduction)
- [Installation](#installation)
- [Basic Usage](#basic-usage)
- [DSL Syntax Guide](#dsl-syntax-guide)
- [Transport Control](#transport-control)
- [Advanced Features](#advanced-features)
- [Troubleshooting](#troubleshooting)

## Introduction

OrbitScore is an audio-based live coding DSL (Domain Specific Language) for modern music production. It allows you to manipulate audio files in real-time with features like time-stretching, audio slicing, and polymeter support.

### Features

- **Real-time Audio Playback**: 0-2ms latency with SuperCollider
- **Audio Slicing**: Divide audio files into equal parts with `.chop(n)`
- **Live Coding**: Execute code with Cmd+Enter in VS Code/Cursor/Claude Code
- **Polymeter Support**: Independent time signatures per sequence
- **Method Chaining**: Fluent API for readable code

## Installation

### Prerequisites

- macOS (primary support)
- Node.js v22.0.0+
- SuperCollider
- VS Code / Cursor / Claude Code

### SuperCollider Installation

**macOS**:
```bash
brew install --cask supercollider
```

**Linux**:
```bash
sudo apt-get install supercollider
```

**Windows**:
Download from [SuperCollider official site](https://supercollider.github.io/)

### OrbitScore Installation

```bash
# Clone repository
git clone https://github.com/yourusername/orbitscore.git
cd orbitscore

# Build engine
cd packages/engine
npm install
npm run build

# Build VS Code extension (optional)
cd ../vscode-extension
npm install
npm run build
```

### SynthDef Setup

```bash
# Stop existing sclang processes
pkill sclang

# Build SynthDefs (macOS)
cd packages/engine/supercollider
./build-synthdefs.sh

# Verify success message
# ✅ All SynthDefs saved! should appear
```

## Basic Usage

### Your First Program

Create a file `hello.osc`:

```osc
// Initialize global context
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("../test-assets/audio")
global.start()

// Create kick sequence
var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

// Run kick
LOOP(kick)
```

### Execution

#### In VS Code / Cursor / Claude Code

1. Select code lines
2. Press **Cmd+Enter** (Mac) or **Ctrl+Enter** (Linux/Windows)
3. Audio will start playing

#### In CLI

```bash
cd packages/engine
npm run cli -- path/to/your/file.osc
```

## DSL Syntax Guide

### 1. Initialization

#### Global Context

```osc
var global = init GLOBAL
```

Creates the global context that manages tempo, time signature, and scheduler.

#### Sequence Creation

```osc
var kick = init global.seq
var snare = init global.seq
```

Creates sequences that inherit global settings.

### 2. Global Parameters

#### Tempo

```osc
global.tempo(120)    // Set to 120 BPM
global._tempo(140)   // Apply immediately during playback
```

#### Time Signature (Beat)

```osc
global.beat(4 by 4)   // 4/4 time signature
global.beat(7 by 8)   // 7/8 time signature
```

#### Audio File Base Path

```osc
global.audioPath("./audio")           // Relative path
global.audioPath("/absolute/path")    // Absolute path
```

### 3. Sequence Parameters

#### Audio File Loading

```osc
kick.audio("kick.wav")                // Load audio file
bass.audio("bass.wav").chop(8)        // Load and divide into 8 slices
```

#### Play Pattern

```osc
// Basic pattern (0 = rest, 1-n = play slice)
kick.play(1, 0, 1, 0)

// With audio slicing
bass.chop(4)
bass.play(1, 2, 3, 4)  // Play slices 1, 2, 3, 4 in order

// Nested patterns
hihat.play(1, (2, 3), 1, (4, 5, 6))
```

#### Time Signature and Length

```osc
// Sequence-specific time signature
poly.beat(5 by 4)     // 5/4 polymeter

// Loop length in bars
seq.length(2)         // Loop every 2 bars
```

#### Gain and Pan Control

```osc
// Set initial gain/pan (before playback)
kick.defaultGain(-6)  // -6 dB
kick.defaultPan(50)   // Pan right

// Real-time control during playback
kick.gain(-3)         // Apply immediately
kick.pan(-50)         // Apply immediately
```

### 4. Method Chaining

All methods return `this`, enabling fluent syntax:

```osc
var kick = init global.seq
kick.audio("kick.wav").chop(4).play(1, 2, 3, 4).gain(-6)
```

### 5. Underscore Prefix Pattern

Methods with `_` prefix apply changes immediately during playback:

```osc
// Normal: buffered, applied at next cycle
kick.tempo(140)

// Underscore: immediate application
kick._tempo(140)
kick._play(1, 1, 1, 1)
kick._chop(8)
```

## Transport Control

### Reserved Keywords

OrbitScore uses **Unidirectional Toggle** for transport control:

#### RUN() - One-shot Playback

```osc
RUN(kick)              // Play kick once
RUN(kick, snare)       // Play multiple sequences once
RUN(kick, snare, hat)  // Variable arguments
```

#### LOOP() - Loop Playback

```osc
LOOP(kick)             // Loop kick, auto-stop others
LOOP(kick, snare)      // Loop kick and snare, stop others
LOOP()                 // Stop all looping sequences
```

**Important**: `LOOP()` automatically stops sequences not in the list.

#### MUTE() - Mute Flag

```osc
MUTE(kick)             // Mute kick (LOOP only, not RUN)
MUTE(kick, snare)      // Mute multiple
MUTE()                 // Unmute all
```

**Important**: Mute flag persists across `LOOP()` changes.

### Why No STOP or UNMUTE?

- **STOP is unnecessary**: Use `LOOP(other_sequences)` to stop unwanted sequences
- **UNMUTE is unnecessary**: Use `MUTE(other_sequences)` or `MUTE()` to unmute

This design simplifies the DSL and makes state explicit.

### Example Workflow

```osc
// 1. Define sequences
var kick = init global.seq
kick.audio("kick.wav").play(1, 0, 1, 0)

var snare = init global.seq
snare.audio("snare.wav").play(0, 1, 0, 1)

var hat = init global.seq
hat.audio("hihat.wav").play(1, 1, 1, 1)

// 2. Start global
global.start()

// 3. Loop kick
LOOP(kick)

// 4. Add snare to loop (kick continues)
LOOP(kick, snare)

// 5. Mute kick
MUTE(kick)

// 6. Unmute kick
MUTE()

// 7. Loop only snare (kick auto-stops)
LOOP(snare)

// 8. Stop all
LOOP()
```

## Advanced Features

### Polymeter

Different time signatures per sequence:

```osc
// 4/4 kick
var kick = init global.seq
kick.beat(4 by 4).audio("kick.wav").play(1, 0, 1, 0)

// 5/4 sequence
var poly5 = init global.seq
poly5.beat(5 by 4).audio("synth.wav").play(1, 0, 0, 1, 0)

// 7/8 sequence
var poly7 = init global.seq
poly7.beat(7 by 8).audio("hat.wav").play(1, 1, 0, 1, 1, 0, 1)

// Loop all with independent timing
LOOP(kick, poly5, poly7)
```

### Audio Slicing (Chop)

```osc
// Divide into 8 slices
bass.audio("bass.wav").chop(8)

// Play slices in custom order
bass.play(1, 0, 3, 0, 5, 0, 7, 0)

// Reverse playback
bass.play(8, 7, 6, 5, 4, 3, 2, 1)
```

### Real-time Parameter Updates

```osc
// Start looping
LOOP(kick)

// Change pattern (applies at next bar)
kick.play(1, 1, 0, 1)

// Change pattern immediately
kick._play(1, 1, 1, 1)

// Change tempo immediately
global._tempo(140)
```

## Troubleshooting

### No Audio Output

**Check**:
1. SuperCollider is running
2. Audio files exist in specified path
3. System audio volume is up
4. Correct audio device selected

**Solution**:
```bash
# Verify audio files
ls -la test-assets/audio/*.wav

# Check SuperCollider process
ps aux | grep scsynth

# Restart if needed
global.stop()
global.start()
```

### Cmd+Enter Not Working

**Check**:
1. File has `.osc` extension
2. VS Code extension is installed
3. Extension is activated

**Solution**:
- Restart IDE
- Use Command Palette: "OrbitScore: Run Selection"
- Verify keybinding is registered

### High Latency

**Check**:
1. SuperCollider is properly configured
2. Audio buffer sizes
3. System audio settings

**Solution**:
- Reduce buffer sizes in SuperCollider
- Close other audio applications
- Check CPU usage

### Parser Errors

**Common Errors**:
- Missing parentheses in method calls
- Incorrect `by` syntax in time signatures
- Typos in keywords (`init`, `GLOBAL`, `RUN`, `LOOP`, `MUTE`)

**Solution**:
- Check error message for line number
- Verify syntax against examples
- Check for matching parentheses

## See Also

- [Getting Started Guide](./GETTING_STARTED.md) - Quick start guide
- [DSL Specification](../../core/INSTRUCTION_ORBITSCORE_DSL.md) - Complete language reference
- [Testing Guide](../../testing/TESTING_GUIDE.md) - Testing procedures

---

For Japanese documentation, see [ユーザーマニュアル (日本語)](../ja/USER_MANUAL.md).
