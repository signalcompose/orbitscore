# INSTRUCTION_ORBITSCORE_DSL.md

## OrbitScore DSL Specification (v0.1 – Initial Draft)

This document defines the **OrbitScore DSL**.  
It is the **single source of truth** for the project.  
All implementation, testing, and planning must strictly follow this specification.

---

## 1. Global Parameters

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

## 2. Initialization

```js
var global = init GLOBAL
// Starts the global transport and prepares to receive live coding input
```

---

## 3. Sequences

### Initialization
```js
var seq1 = init GLOBAL.seq
```
- Inherits all global parameters by default
- Can override tempo, meter, and other properties

### Overrides
```js
seq1.tempo(120)       // independent tempo (polymeter support)
seq1.beat(17 by 8)    // independent meter
```

---

## 4. Playback and Structure

### Play
```js
seq1.play(0)                     // play whole bar
seq1.play((0)(0))                // divide bar into 2
seq1.play((0)((0)(0)))           // divide into 1 + 2
```

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
seq1.audio("../audio/piano1.wav").chop(6)
```
- Splits file into equal slices (1..6)
- Supported formats: wav, aiff, mp3, mp4
- Output defaults to 48kHz / 24bit (unless global override)

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

---

## 11. Versioning

This is version **v0.1 Initial Draft**.  
Future changes must update this document first before implementation.
