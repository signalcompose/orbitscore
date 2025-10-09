# INSTRUCTION_ORBITSCORE_DSL.md

## OrbitScore DSL Specification (v3.0 – Implemented)

This document defines the **OrbitScore DSL**.
It is the **single source of truth** for the project.
All implementation, testing, and planning must strictly follow this specification.

**Last Updated**: 2025-01-09
**Implementation Status**: ✅ Core features implemented and tested (205/205 tests passing)

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
- Initializes `AudioEngine` with SuperCollider
- Sets up `Transport` system for scheduling
- Default values: tempo=120, beat=4/4
- **Variable naming**: The variable name "global" is conventional but not required - you can use any valid identifier (e.g., `var g = init GLOBAL`, `var master = init GLOBAL`)
- **Singleton behavior**: Multiple `init GLOBAL` statements return the same Global instance

### Sequence Initialization
```js
// After global initialization, create sequences
var seq1 = init global.seq
var seq2 = init global.seq
// Or with any global variable name:
var kick = init g.seq
var snare = init master.seq
```

**Implementation Details**:
- Creates instances of the `Sequence` class through Global's factory method
- Each sequence maintains its own state (tempo, beat, length, audio, play pattern)
- Sequences inherit global parameters (tempo, beat) by default but can override them
- Each sequence is automatically registered with the global transport
- **Variable naming**: Sequence variable names are arbitrary and user-defined (common names: kick, snare, hat, bass, lead, etc.)

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

### Meter (Time Signature)
```js
global.beat(4 by 4)   // equivalent to 4/4
global.beat(5 by 4)   // 5/4
global.beat(9 by 8)   // 9/8
global.beat(3, 4)     // alternative syntax: 3/4
```

**Note**:
- tick() and key() have been removed from the current audio-based implementation
- tick(): MIDI resolution concept, not needed for audio-only playback
- key(): Will be added when MIDI support is implemented. For audio files, requires audio key detection feature.
- Composite meters like (4 by 4)(5 by 4) are not currently supported

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

### Multiline Parentheses & Chaining
- 括弧で囲まれた引数リストやネスト構造は、**どのメソッド/関数でも改行を挟んで記述可能**です。
- `global.beat()` や `seq.play()`、今後導入予定の `RUN()` など、DSL全体で同じ書き方ができます。
- カンマ区切りを守れば閉じ括弧の位置・インデントも自由に整形できます。

```js
global.beat(
  5 by 4,
)

seq.audio(
  "../audio/snare.wav",
).play(
  (1, 0),
  2,
  (
    3,
    (4, 5),
  ),
)
```

> 注: `(1)(2)` のようなタプルネスト記法も改行混在で利用できます。閉じ括弧は任意の行に置いて構いません。

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

**Note**: Play modifiers like .chop(), .time(), and .fixpitch() are planned for future release but not yet implemented.

---

## 5. Transport Commands

### Global Transport
Available on `global`:

```js
global.start()            // start scheduler from next bar
global.stop()             // stop scheduler
```

### Sequence Transport (Method-based)
Available on individual sequences:

```js
kick.run()                // play sequence once (one-shot)
kick.loop()               // play sequence in loop
kick.stop()               // stop sequence
kick.mute()               // mute sequence (only affects LOOP playback)
kick.unmute()             // unmute sequence
```

### Reserved Keywords (Unidirectional Toggle) - v3.0

**DSL v3.0 introduces片記号方式 (unidirectional toggle)**:

Use uppercase reserved keywords to control multiple sequences with **unidirectional toggle** semantics:

```js
RUN(kick)                 // Include ONLY kick in RUN group (one-shot playback)
RUN(kick, snare, hihat)   // Include ONLY kick, snare, hihat in RUN group

LOOP(bass)                // Include ONLY bass in LOOP group (others auto-stop)
LOOP(kick, snare)         // Include ONLY kick, snare in LOOP group (hat stops if it was looping)

MUTE(hihat)               // Set ONLY hihat's MUTE flag ON (others OFF, applies only to LOOP)
MUTE(snare, hihat)        // Set ONLY snare and hihat's MUTE flags ON (others OFF)
```

**Unidirectional Toggle Behavior (片記号方式)**:
- **RUN group**: Lists sequences for one-shot playback. Only listed sequences are included.
- **LOOP group**: Lists sequences for loop playback. **Sequences not listed are automatically stopped.**
- **MUTE group**: Sets MUTE flag ON for listed sequences, OFF for others. **MUTE only affects LOOP playback**, not RUN.
- Each command **replaces** the entire group with the new list (unidirectional - inclusion only)

**RUN and LOOP Independence**:
- RUN and LOOP are **independent groups** - the same sequence can be in both simultaneously
- When a sequence is in both RUN and LOOP, it plays both one-shot AND loops
- Example: `RUN(kick)` then `LOOP(kick)` → kick plays one-shot AND loops

**MUTE Behavior**:
- MUTE is a **persistent flag** that only affects LOOP playback
- Like a mixer mute button: LOOP continues but produces no sound
- **MUTE does NOT affect RUN playback** - RUN sequences always play with sound
- MUTE flag persists even when sequence leaves/rejoins LOOP group

**Examples:**
```js
// Setup
var kick = init global.seq
var snare = init global.seq
var hat = init global.seq

global.start()

// Include kick and snare in RUN group
RUN(kick, snare)              // kick and snare play one-shot

// Replace LOOP group with only hat
LOOP(hat)                     // Only hat loops (kick/snare NOT looping)

// Both RUN and LOOP
RUN(kick)                     // kick plays one-shot
LOOP(kick)                    // kick ALSO loops (independent)

// MUTE only affects LOOP
LOOP(kick, snare, hat)        // All three loop
MUTE(hat)                     // hat loops but muted (kick/snare unmuted)
RUN(hat)                      // hat plays one-shot WITH sound (MUTE doesn't affect RUN)

// Changing groups
LOOP(kick, snare, hat)        // All three loop
LOOP(kick)                    // Only kick loops (snare and hat auto-stop)

// MUTE persistence
MUTE(kick)                    // kick's MUTE flag ON
LOOP(kick, snare)             // kick loops (muted), snare loops (unmuted)
LOOP(snare)                   // kick stops, but MUTE flag persists
LOOP(kick)                    // kick loops again, still muted (flag persisted)
MUTE(snare)                   // kick's MUTE flag OFF, snare's MUTE flag ON
```

**Benefits of Reserved Keywords:**
- **Clearer intent**: `RUN(kick, snare)` is more readable than `kick.run()` followed by `snare.run()`
- **Unidirectional control**: One statement defines the entire group state
- **Live coding friendly**: Quick bulk updates with multiline support

**Multiline support:**
```js
RUN(
  kick,
  snare,
  hihat,
)

LOOP(
  bass,
  lead,
)

MUTE(
  hihat,
)
```

### Editor Execution
- Any `global` or `seq` transport command can be executed by selecting it in the editor and pressing **Command + Enter**.
- Reserved keywords (`RUN`, `LOOP`, `MUTE`) can also be executed this way.

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
seq1.play(1, 2, 3, 4)  // play slices in sequence
```

**Note**: Audio manipulation features like fixpitch() and time() are planned for future release but not yet implemented.

---

## 7. Underscore Prefix Pattern (Setting vs. Application) - v3.0

**DSL v3.0 introduces a consistent pattern for all configuration methods:**

### The Pattern: `method()` vs. `_method()`

- **`method(value)`**: **Setting only** - stores the value but does NOT trigger playback or apply immediately
- **`_method(value)`**: **Immediate application** - sets the value AND triggers playback/applies immediately

This pattern applies to ALL configuration methods that can affect running sequences.

### Applicable Methods

#### Sequence Configuration Methods

All sequence configuration methods follow this pattern:

```js
// Setting-only methods (no underscore)
seq.audio("file.wav")     // Set audio file (no playback)
seq.chop(8)               // Set chop divisions (no slicing applied yet)
seq.play(1, 2, 3, 4)      // Set play pattern (no playback)
seq.beat(4 by 4)          // Set meter (no timing change yet)
seq.length(2)             // Set loop length (no change yet)
seq.tempo(140)            // Set tempo (no tempo change yet)

// Immediate application methods (with underscore)
seq._audio("file.wav")    // Set audio file AND apply immediately (triggers playback if running)
seq._chop(8)              // Set chop divisions AND re-slice immediately
seq._play(1, 2, 3, 4)     // Set play pattern AND start playback immediately
seq._beat(4 by 4)         // Set meter AND apply timing change immediately
seq._length(2)            // Set loop length AND apply immediately
seq._tempo(140)           // Set tempo AND apply immediately
```

#### Global Configuration Methods

Global also supports underscore methods for parameters that affect all sequences:

```js
// Setting-only methods (no underscore)
global.tempo(140)         // Set global tempo (no immediate effect on sequences)
global.beat(4 by 4)       // Set global beat (no immediate effect on sequences)

// Immediate application methods (with underscore)
global._tempo(140)        // Set global tempo AND update all sequences that inherit it
global._beat(4 by 4)      // Set global beat AND update all sequences that inherit it
```

**Inheritance behavior**:
- When a sequence hasn't overridden tempo/beat, it inherits from global
- `global._tempo()` triggers seamless parameter updates for all inheriting sequences
- `global._beat()` triggers seamless parameter updates for all inheriting sequences
- If a sequence has overridden a parameter (e.g., `seq.tempo(160)`), it ignores global changes

### Real-Time vs. Buffered Parameters

**Real-time parameters** (apply immediately regardless of playback state):
- `gain(dB)` and `_gain(dB)` - both apply immediately
- `pan(position)` and `_pan(position)` - both apply immediately
- These are mixer-style controls that should respond instantly

**Buffered parameters** (timing-dependent):
- Non-underscore: Buffered until next `run()` or `loop()` call
- Underscore: Applied immediately even during playback

### Usage Patterns

**Pattern 1: Setup phase (before playback)**
```js
// During setup, use non-underscore methods (cleaner, no redundant playback triggers)
var kick = init global.seq
kick.audio("kick.wav")
kick.chop(4)
kick.play(1, 0, 1, 0)
kick.beat(4 by 4)
kick.length(1)

// Start playback
global.start()
kick.run()                // Now all settings are applied
```

**Pattern 2: Live coding (during playback)**
```js
// Sequence is already running
kick.run()

// Non-underscore: Changes are buffered, applied at next run()/loop()
kick.play(1, 1, 0, 0)     // Pattern buffered, not applied yet
kick.run()                // NOW the new pattern is applied

// Underscore: Changes apply immediately
kick._play(1, 1, 0, 0)    // Pattern applied immediately, playback restarts
```

**Pattern 3: Real-time mixing**
```js
// These always apply immediately (mixer-style controls)
kick.gain(-6)             // Immediate
kick._gain(-6)            // Immediate (same effect)
kick.pan(-50)             // Immediate
kick._pan(-50)            // Immediate (same effect)

// But other parameters are buffered without underscore
kick.tempo(160)           // Buffered
kick._tempo(160)          // Applied immediately
```

### Benefits

1. **Clear Intent**: Underscore makes it explicit when you want immediate effect
2. **Performance**: Avoid redundant operations during setup phase
3. **Live Coding**: Quick updates with `_method()` during performance
4. **Consistency**: Same pattern across all configuration methods

### Default Behavior

For backward compatibility and ease of use:
- `defaultGain(dB)` - sets initial gain without triggering playback (use before `run()`)
- `defaultPan(position)` - sets initial pan without triggering playback (use before `run()`)
- `gain(dB)` / `pan(position)` - apply immediately during playback (real-time controls)

---

## 8. DAW Integration

- **MIDI**: use macOS **IAC Bus** for routing when MIDI features are enabled later.  
- **Audio**: OrbitScore outputs audio internally.  
- **DAW Plugin**: provide a VST/AU plugin that can connect to OrbitScore and select which `seqN` output to route.  
- Plugin acts as the bridge for DAW integration.

---

## 8. Implementation Notes

- Parser must support nested `play` structures for hierarchical timing
- IR must represent play structures as tree-like data for timing calculation
- Scheduler must handle independent sequence tempos (polytempo) and meters (polymeter)
- Audio engine uses SuperCollider for ultra-low latency playback (0-2ms)
- Global underscore methods (_tempo, _beat) must trigger seamless parameter updates for inheriting sequences

**Future Additions**:
- Audio manipulation features (fixpitch, time) will require time-stretch and pitch-shift implementation
- Composite meters may require complex timing calculation algorithms
- tick/key will be added when MIDI support is implemented

---

## 9. Testing Guidelines

- **Parser**: Verify meter parsing, nested play structures, variable initialization
- **Timing**: Ensure timing calculations are correct for nested play structures and different meters
- **Audio**: Confirm playback speed matches tempo and sequences synchronize correctly
- **Transport**: Global and sequence transport commands function as specified
- **Underscore Methods**: Verify immediate application behavior for all _method() calls
- **Inheritance**: Test that sequences inherit global parameters correctly and seamless updates work

---

## 10. VS Code Extension Features

### Autocomplete and IntelliSense

- **No abbreviations/shortcuts in DSL**: Maintain full readability with descriptive names
- **Smart autocomplete**: VS Code extension provides intelligent suggestions
  - `global.` → suggests `tempo()`, `_tempo()`, `beat()`, `_beat()`, `start()`, `stop()`, `gain()`, etc.
  - `seq1.` → suggests `audio()`, `chop()`, `play()`, `tempo()`, `beat()`, `length()`, `run()`, `loop()`, `mute()`, etc.
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
seq.play(1, 2, 3).┃  // Suggests: run(), loop(), mute()

// After 'global.'
global.┃  // Suggests: tempo(), _tempo(), beat(), _beat(), start(), stop(), loop(), gain()
```

**Method Order Rules**:
- `audio()` must come before `chop()` and `play()`
- `beat()`, `length()`, `tempo()` can be called anytime after init
- `play()` typically comes after `audio()` (with or without `chop()`)
- `run()`, `loop()`, `mute()` are usually final in the chain
- Underscore methods (_audio, _chop, _play, _tempo, _beat, _length) can be used during live coding for immediate updates

---

## 11. Complete Usage Example

```js
// STEP 1: Initialize global context first
var global = init GLOBAL

// STEP 2: Configure global parameters
global.tempo(120)
global.beat(4 by 4)

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

// STEP 5b: Set initial gain/pan (before playback)
kick.defaultGain(-3).defaultPan(0)
bass.defaultGain(-6).defaultPan(-30)
lead.defaultGain(-9).defaultPan(30)

// STEP 6: Start playback
global.start()

// STEP 7: Live manipulation (real-time changes during playback)
kick.mute()
bass.gain(-12)      // Real-time gain change
lead.pan(0)         // Real-time pan change
global._tempo(130)  // Change global tempo for all inheriting sequences
```

---

## 12. Implementation Status

### Completed Features ✅

#### Core DSL (v3.0)
- **Initialization**: `init GLOBAL`, `init global.seq` (variable names are arbitrary, not hardcoded)
- **Global Parameters**: tempo, beat
- **Sequence Configuration**: tempo, beat, length, audio, chop
- **Play Patterns**: Flat and nested structures with hierarchical timing
- **Method Chaining**: All methods return `this` for fluent API
- **Transport Commands**: run, stop, loop, mute, unmute
- **Underscore Prefix Pattern (v3.0)**:
  - Sequence: `_audio()`, `_chop()`, `_play()`, `_beat()`, `_length()`, `_tempo()` for immediate application
  - Global: `_tempo()`, `_beat()` for immediate application with seamless parameter updates
- **Parameter Inheritance**: Sequences inherit tempo/beat from Global unless overridden
- **Unidirectional Toggle (v3.0)**: `RUN()`, `LOOP()`, `MUTE()` reserved keywords with片記号方式 semantics
  - RUN and LOOP are independent groups
  - MUTE is persistent flag, only affects LOOP playback
  - STOP keyword removed (use LOOP with different list)

**Removed (not yet implemented for audio-based DSL)**:
- tick() and key() - MIDI-only concepts, will be added when MIDI support is implemented

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
  - `gain(dB)`: Real-time volume control in dB (-60 to +12, default 0) - applies immediately even during playback
  - `pan(position)`: Real-time stereo positioning (-100 to 100) - applies immediately even during playback
  - `defaultGain(dB)`: Set initial gain without triggering playback - use before `run()` or `loop()`
  - `defaultPan(position)`: Set initial pan without triggering playback - use before `run()` or `loop()`
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

### Testing Coverage (v3.0)
- **Audio Parser Tests**: 50/50 passing
- **Parser Syntax Tests**: 11/11 passing (v3.0: STOP removed)
- **Unidirectional Toggle Tests**: 11/11 passing (v3.0: RUN/LOOP/MUTE semantics)
- **Underscore Methods Tests**: 27/27 passing (v3.0: _audio, _chop, _play, etc.)
- **Timing Tests**: 8/8 passing
- **Pitch Tests**: 25/25 passing
- **Audio Slicer Tests**: 9/9 passing
- **SuperCollider Tests**: 15/15 passing
- **Sequence Tests**: 20/20 passing
- **Setting Sync Tests**: 13/13 passing (v3.0: RUN/LOOP buffering)
- **Total**: 205+ tests passing

---

## 13. Versioning

**Current Version**: v3.0 (Underscore Prefix + Unidirectional Toggle)

- v3.0 (2025-01-09): **Underscore Prefix Pattern** + **Unidirectional Toggle (片記号方式)**
  - **Underscore Prefix**: `method()` = setting only, `_method()` = immediate application
  - **Unidirectional Toggle**: `RUN()`, `LOOP()`, `MUTE()` with inclusion-only semantics
  - RUN and LOOP are independent groups (same sequence can be in both)
  - MUTE is persistent flag, only affects LOOP playback
  - Removed `STOP` keyword (use `LOOP()` with empty/different list instead)
  - 205+ tests passing including 11 new unidirectional toggle tests

- v2.0 (2025-01-06): SuperCollider integration, global mastering effects, dB-based gain control
  - SuperCollider audio engine for professional-grade timing
  - Global mastering: compressor, limiter, normalizer
  - dB-based gain control (-60 to +12 dB)

- v1.0 (2024-12-25): Core implementation complete with 100% test coverage
  - Parser, interpreter, timing calculator
  - Nested play structures
  - Method chaining

- v0.1 (2024-09-28): Initial draft specification

**Migration Notes from v2.0 to v3.0**:
- **STOP keyword removed**: Use `LOOP(seq1)` then `LOOP(seq2)` to switch - seq1 auto-stops
- **UNMUTE keyword removed**: Use `MUTE(seq2)` - seq1 auto-unmutes (unidirectional toggle)
- **New behavior**: `RUN()` and `LOOP()` are independent - sequence can be in both simultaneously
- **MUTE semantics changed**: MUTE only affects LOOP, not RUN playback
- **New pattern**: Use `_method()` for immediate application during live coding
- All existing v2.0 code continues to work (backward compatible for non-keyword features)

**Migration Notes from v1.0 to v2.0**:
- MIDI output system has been completely replaced with SuperCollider audio engine
- Old MIDI DSL syntax is no longer supported
- All audio playback now goes through SuperCollider for professional-grade timing and quality

Future changes must update this document first before implementation.
