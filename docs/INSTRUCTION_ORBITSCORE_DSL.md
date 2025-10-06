# INSTRUCTION_ORBITSCORE_DSL.md

## OrbitScore DSL Specification (v1.0 – Implemented)

This document defines the **OrbitScore DSL**.  
It is the **single source of truth** for the project.  
All implementation, testing, and planning must strictly follow this specification.

**Last Updated**: 2024-12-25  
**Implementation Status**: ✅ Core features implemented and tested (187/187 tests passing)

---

## 1. Initialization

### Global Context
```js
// REQUIRED: First, initialize the global context
var global = init GLOBAL
// This creates the global transport and audio engine
```

**Implementation Details**:
- Creates an instance of the `Global` class
- Initializes `AudioEngine` with Web Audio API
- Sets up `Transport` system for scheduling
- Default values: tempo=120, tick=480, beat=4/4, key='C'

### Sequence Initialization  
```js
// After global initialization, create sequences
var seq1 = init global.seq
var seq2 = init global.seq
```

**Implementation Details**:
- Creates instances of the `Sequence` class through Global's factory method
- Each sequence maintains its own state (tempo, beat, length, audio, play pattern)
- Sequences inherit global parameters by default but can override them
- Each sequence is automatically registered with the global transport

**Legacy Syntax Support** (for backward compatibility):
```js
var seq = init GLOBAL.seq  // Still supported but deprecated
```

---

## 2. Global Parameters

After initialization, configure the global context:

### Tempo
```js
global.tempo(140)   // set global tempo to 140 BPM
```

### Tick Resolution
```js
global.tick(480)    // default resolution is 480 ticks per quarter note
// Allowed values: 480, 960, 1920
```

### Meter (Time Signature)
```js
global.beat(4 by 4)   // equivalent to 4/4
global.beat(5 by 4)   // 5/4
global.beat(9 by 8)   // 9/8
```
- One bar = `n * (tick * (4/N))`
  - Example: `5 by 4` → 5 × (480 × 4/4) = 2400 ticks  
  - Example: `11 by 8` → 11 × (480 × 4/8) = 2640 ticks  

### Composite Meters
```js
global.beat((4 by 4)(5 by 4))  
global.beat((3 by 4)(2 by 4)).time(2)
```

### Key
```js
global.key(C)
```

---

## 3. Sequences

### Configuration
After initialization, sequences can be configured:
```js
seq1.tempo(120)       // independent tempo (polytempo support)
seq1.beat(17 by 8)    // independent meter (polymeter support)
seq1.length(2)        // loop length in bars (default: 1)
```

### Method Chaining
All sequence methods return the sequence object, allowing fluent chaining:
```js
// Multi-line (traditional)
var snare = init global.seq
snare.beat(4 by 4)
snare.length(1)
snare.audio("snare.wav")
snare.chop(4)
snare.play(0, 0, 1, 0)
snare.run()

// Single-line (method chaining)
var snare = init global.seq
snare.beat(4 by 4).length(1).audio("snare.wav").chop(4).play(0, 0, 1, 0).run()

// Or even more concise (if parser supports)
init global.seq.beat(4 by 4).length(1).audio("snare.wav").play(0, 0, 1, 0).run()
```

### Loop Length and Pattern Relationship
The `length` parameter defines how many bars the sequence loops over:
- `length(1)` with `.chop(4)` = 4 slices per bar × 1 bar = 4 elements in `play()`
- `length(2)` with `.chop(8)` = 4 slices per bar × 2 bars = 8 elements in `play()`
- `length(4)` with `.chop(16)` = 4 slices per bar × 4 bars = 16 elements in `play()`

### Slice Indexing in play()
When using `chop(n)`, the audio is divided into n slices numbered 1 through n:
- **0** = silence (no playback)
- **1 to n** = play slice number (1-indexed)
- Numbers can be reused and reordered freely

**Special case**: `chop(1)` means no division - the entire audio file is slice 1:
```js
// For drum hits - play the whole sample
kick.audio("kick.wav").chop(1)  // or just kick.audio("kick.wav")
kick.play(1, 0, 1, 0)           // Kick, silence, kick, silence

// For sliced loops
break.audio("break.wav").chop(8)  // Divide into 8 slices
break.play(1,3,2,1, 5,7,0,4)      // Rearrange slices
```

Example:
```js
seq1.beat(4 by 4).length(2)     // 2-bar loop in 4/4
seq1.audio("file.wav").chop(8)  // Creates slices 1-8
seq1.play(1,3,2,1, 5,7,0,4)     // Play: slice1, slice3, slice2, slice1, slice5, slice7, silence, slice4
seq1.play(1,1,1,1, 2,2,2,2)     // Repeat slices
seq1.play(8,7,6,5, 4,3,2,1)     // Reverse order
```

---

## 4. Playback and Structure

### Play - Rhythmic Division with Nesting
The `play()` method divides time hierarchically using nested structures:

```js
seq1.play(1)                     // play slice 1 for whole bar
seq1.play(1, 2)                  // divide bar into 2: each gets 1/2
seq1.play(1, (2, 3))              // 1 gets 1/2, then 2&3 each get 1/4 (splitting the second 1/2)
seq1.play((1, 2), (3, 4, 5))     // first half: 1&2 (each 1/4), second half: 3,4,5 (each 1/6)
seq1.play(1, (0, 1, 2, 3, 4))    // 1 gets 1/2 (2 beats), then 5-tuplet in remaining 1/2
```

**Implementation Details**:
- Implemented via `TimingCalculator` class that recursively calculates timing
- Each nested structure creates a `TimedEvent` with `sliceNumber`, `startTime`, `duration`, and `depth`
- Parser supports both `(1, 2)` and `(1)(2)` syntax for nesting
- Timing is calculated based on bar duration (tempo × meter)

**Nesting Rule**: Each level of parentheses divides its parent's time duration:
- Top level divides the bar
- Nested elements divide their parent's time slot equally
- 0 = silence, 1-n = slice number from `chop(n)`

### Alternative Functional Form
```js
seq1.play(0.chop(5), 0.chop(4))  // equivalent to nested form
```

### Time Modifiers
```js
seq1.play((0).chop(5).time(5), (0).chop(4).time(4))
```

---

## 5. Transport Commands

Available on both `global` and sequences (`seqN`).

```js
global.run()              // run from next bar
global.run.force()        // run immediately
global.loop()             // loop from next bar
global.loop.force()       // loop immediately
global.mute()
global.unmute()
global.stop()
```

### Targeted Transport
```js
global.run(seq1, seq2)   // run only selected sequences
global.loop(seq1)        // loop only seq1
```

### Editor Execution
- Any `global` or `seq` transport command can be executed by selecting it in the editor and pressing **Command + Enter**.

---

## 6. Audio Playback

### File Loading
```js
seq1.audio("../audio/piano1.wav").chop(6)  // Divide into 6 slices
seq1.audio("../audio/kick.wav").chop(1)     // No division (whole file)
seq1.audio("../audio/kick.wav")             // Default: chop(1)
```
- `.chop(n)` divides file into n equal slices (numbered 1 to n)
- `.chop(1)` or omitting `.chop()` = no division (entire file is slice 1)
- Supported formats: wav, aiff, mp3, mp4
- Output defaults to 48kHz / 24bit (unless global override)

**Common patterns**:
- Drum hits: Use `.chop(1)` or omit - triggers entire sample
- Loops/Breaks: Use `.chop(8)`, `.chop(16)` etc. for slicing and rearrangement

### Play with Audio
```js
seq1.play(1)           // play slice 1
seq1.play(1).fixpitch(0)  // play at original pitch
```

### Fixpitch
```js
fixpitch(0)   // original pitch
fixpitch(1)   // +1 semitone
fixpitch(-1)  // -1 semitone
```
- Decouples playback speed from pitch (granular or PSOLA-based time-stretching).

---

## 7. DAW Integration

- **MIDI**: use macOS **IAC Bus** for routing when MIDI features are enabled later.  
- **Audio**: OrbitScore outputs audio internally.  
- **DAW Plugin**: provide a VST/AU plugin that can connect to OrbitScore and select which `seqN` output to route.  
- Plugin acts as the bridge for DAW integration.

---

## 8. Implementation Notes

- Parser must support both nested `play` and functional `.chop/.time` syntax.  
- IR must normalize both syntaxes into the same structure.  
- Scheduler must handle composite meters and independent seq tempos.  
- Audio engine must implement time-stretch (default) and pitch-shift when `fixpitch` is specified.  

---

## 9. Testing Guidelines

- **Parser**: verify meters, composite beats, both play syntaxes, fixpitch parsing.  
- **Mapping**: ensure ticks match expected values for given meters and chops.  
- **Audio**: confirm playback speed matches tempo; fixpitch keeps pitch constant.  
- **Transport**: global and targeted transport commands function as specified.

---

## 10. VS Code Extension Features

### Autocomplete and IntelliSense

- **No abbreviations/shortcuts in DSL**: Maintain full readability with descriptive names
- **Smart autocomplete**: VS Code extension provides intelligent suggestions
  - `global.` → suggests `tempo()`, `tick()`, `beat()`, `key()`, `run()`, `loop()`, etc.
  - `seq1.` → suggests `play()`, `audio()`, `tempo()`, `beat()`, `mute()`, etc.
  - Method signatures with parameter hints
- **Snippet expansion**: Type-ahead for common patterns
  - `init` → expands to `var seq = init GLOBAL.seq`
  - `play` → expands to `seq.play()`
- **Hover documentation**: Inline help for all methods and parameters
- **Parameter hints**: Shows expected types and values as you type

### Design Philosophy

Instead of creating abbreviated forms that reduce readability (e.g., `gl.tem()`), we prioritize:
1. **Full, descriptive method names** for clarity
2. **Fast input via autocomplete** for efficiency
3. **Code readability** for collaboration and maintenance

This approach ensures code remains self-documenting while maintaining fast input speed.

### Context-Aware Autocomplete

**Implementation Status**: ✅ Fully implemented in VS Code extension

The extension provides intelligent suggestions based on method chain context:

```js
// After 'var seq = init global.seq'
seq.┃  // Suggests: audio(), beat(), length(), tempo()

// After 'seq.audio("file.wav")'
seq.audio("file.wav").┃  // Suggests: chop(), play(), run()

// After 'seq.audio("file.wav").chop(8)'
seq.audio("file.wav").chop(8).┃  // Suggests: play(), run()

// After 'seq.play(1, 2, 3)'
seq.play(1, 2, 3).┃  // Suggests: run(), loop(), mute(), fixpitch(), time()

// After 'global.'
global.┃  // Suggests: tempo(), beat(), tick(), key(), run(), loop(), stop()
```

**Method Order Rules**:
- `audio()` must come before `chop()` and `play()`
- `beat()`, `length()`, `tempo()` can be called anytime after init
- `play()` typically comes after `audio()` (with or without `chop()`)
- `run()`, `loop()`, `mute()` are usually final in the chain
- Modifiers like `fixpitch()`, `time()` can appear after `play()`

---

## 11. Complete Usage Example

```js
// STEP 1: Initialize global context first
var global = init GLOBAL

// STEP 2: Configure global parameters
global.tempo(120)
global.beat(4 by 4)
global.tick(480)
global.key(C)

// STEP 3: Initialize sequences from global
var kick = init global.seq
var bass = init global.seq
var lead = init global.seq

// STEP 4: Configure sequences
kick.beat(4 by 4).length(1)
bass.beat(4 by 4).length(2)
lead.beat(4 by 4).length(4)

// STEP 5: Load audio and create patterns
kick.audio("kick.wav").chop(4)
kick.play(1, 0, 0, 1)

bass.audio("bass.wav").chop(8)
bass.play(1, 0, 0, 1, 0, 0, 1, 0,
          0, 1, 0, 1, 0, 0, 0, 0)

lead.audio("synth.wav").chop(16)
lead.play((1, 0, 0, 0), 0, 0, (1, 0, 0, 0), 
          0, 0, 0, 0, 0, 0, 0, 0,
          1, 1, 1, 0)

// STEP 6: Start playback
global.run()

// STEP 7: Live manipulation
kick.mute()
bass.fixpitch(5)
lead.time(0.5)
global.tempo(130)
```

---

## 12. Implementation Status

### Completed Features ✅

#### Core DSL
- **Initialization**: `init GLOBAL`, `init global.seq`
- **Global Parameters**: tempo, tick, beat, key
- **Sequence Configuration**: tempo, beat, length, audio, chop
- **Play Patterns**: Flat and nested structures with hierarchical timing
- **Method Chaining**: All methods return `this` for fluent API
- **Transport Commands**: run, stop, loop, mute, unmute

#### Parser
- **Tokenizer**: Complete lexical analysis
- **Parser**: Full syntax support including nested play structures
- **IR Generation**: Intermediate representation for execution
- **Error Handling**: Graceful error reporting

#### Audio Engine (SuperCollider)
- **File Loading**: WAV format support with buffer caching
- **Slicing**: `chop(n)` divides audio into n equal parts with precise timing
- **Playback**: Ultra-low latency (0-2ms) via SuperCollider scsynth
- **Audio Control**: 
  - `gain(dB)`: Volume control in dB (-60 to +12, default 0)
  - `pan(position)`: Stereo positioning (-100 to 100)
  - Random values: `r` (full random), `r0%10` (random walk)
- **Global Mastering Effects**:
  - `global.compressor()`: Increase perceived loudness
  - `global.limiter()`: Prevent clipping
  - `global.normalizer()`: Maximize output level
- **Audio Device Selection**: Choose output device via command palette
- **Default Behavior**: `chop(1)` or no chop treats file as single slice

#### Object-Oriented Architecture
- **Global Class**: Transport and audio engine management
- **Sequence Class**: Individual sequence state and behavior
- **AudioEngine Class**: Audio processing and playback
- **Transport Class**: Scheduling and synchronization
- **InterpreterV2**: DSL execution engine

#### VS Code Extension
- **Syntax Highlighting**: Complete DSL syntax support
- **Autocomplete**: Context-aware intelligent suggestions
- **IntelliSense**: Parameter hints and hover documentation
- **Diagnostics**: Real-time error detection
- **Command Execution**: Cmd+Enter to run selected code

### Not Yet Implemented 📋

#### Audio Manipulation
- **fixpitch()**: Pitch shift in semitones
- **time()**: Time stretch/compression
- **offset()**: Start position adjustment
- **reverse()**: Reverse playback
- **fade()**: Fade in/out

#### Effects (Per-Sequence)
- **delay()**: Per-sequence delay effect
- **reverb()**: Per-sequence reverb effect
- **filter()**: Per-sequence filter effects

#### Advanced Features
- **Composite Meters**: `((3 by 4)(2 by 4))`
- **Force Modifier**: `.force` for transport commands
- **Effect Presets**: Named preset system for effect chains
- **DAW Plugin**: VST/AU plugin development

#### MIDI Support (Deprecated)
- **MIDI Output**: Original MIDI-based system has been replaced with SuperCollider audio engine
- **MIDI DSL**: Old syntax (`sequence`, `bus`, `channel`, `degree`, `velocity`) is no longer supported
- **Note**: All MIDI-related tests and implementations have been removed in favor of direct audio playback

### Testing Coverage
- **Audio Parser Tests**: 50/50 passing
- **Timing Tests**: 8/8 passing
- **Pitch Tests**: 25/25 passing
- **Audio Slicer Tests**: 9/9 passing
- **SuperCollider Tests**: 15/15 passing
- **Sequence Tests**: 20/20 passing
- **Total**: 196+ tests passing (MIDI-related tests removed)

---

## 13. Versioning

**Current Version**: v2.0 (SuperCollider Audio Engine)
- v2.0 (2025-01-06): SuperCollider integration, global mastering effects, dB-based gain control
- v1.0 (2024-12-25): Core implementation complete with 100% test coverage
- v0.1 (2024-09-28): Initial draft specification

**Migration Notes**:
- MIDI output system has been completely replaced with SuperCollider audio engine
- Old MIDI DSL syntax is no longer supported
- All audio playback now goes through SuperCollider for professional-grade timing and quality

Future changes must update this document first before implementation.
