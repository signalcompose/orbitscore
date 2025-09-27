# OrbitScore Audio-Based DSL Implementation Plan

## Overview

Implementation plan for the new audio-based OrbitScore DSL as defined in `INSTRUCTION_ORBITSCORE_DSL.md`.

**Single Source of Truth**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`

## Migration Status

- **Old System**: MIDI-based DSL (deprecated)
- **New System**: Audio-based DSL (current focus)
- **Migration Date**: December 25, 2024

## Implementation Phases

### Phase A1: New Parser Implementation ⬅️ CURRENT PHASE

**Goal**: Implement parser for the audio-based DSL syntax

#### A1.1 Tokenizer Updates
- [ ] Support for `by` keyword (meter syntax)
- [ ] Support for `.` operator (method calls)
- [ ] Support for `var` keyword
- [ ] Support for `init` keyword
- [ ] Support for parentheses in expressions

#### A1.2 Global Parameter Parsing
```js
global.tempo(140)
global.tick(480)
global.beat(4 by 4)
global.beat((3 by 4)(2 by 4))
global.key(C)
```
- [ ] Parse method call syntax
- [ ] Parse `n by m` meter notation
- [ ] Parse composite meters
- [ ] Parse shorthand aliases (gl.tem)

#### A1.3 Initialization Parsing
```js
var global = init GLOBAL
var seq1 = init GLOBAL.seq
```
- [ ] Parse variable declarations
- [ ] Parse init expressions
- [ ] Track initialized sequences

#### A1.4 Sequence Configuration
```js
seq1.tempo(120)
seq1.beat(17 by 8)
seq1.audio("../audio/piano1.wav").chop(6)
```
- [ ] Parse sequence method calls
- [ ] Parse audio loading
- [ ] Parse chop parameters

#### A1.5 Play Structure Parsing
```js
seq1.play(0)
seq1.play((0)(0))
seq1.play((0)((0)(0)))
seq1.play(0.chop(5), 0.chop(4))
seq1.play(1).fixpitch(0)
```
- [ ] Parse nested play structures
- [ ] Parse functional form (.chop, .time)
- [ ] Parse fixpitch modifier
- [ ] Parse slice numbers (1-6 for chop(6))

#### A1.6 Transport Command Parsing
```js
global.run()
global.run.force()
global.loop(seq1, seq2)
seq1.mute()
```
- [ ] Parse transport methods
- [ ] Parse force modifier
- [ ] Parse targeted sequences

#### A1.7 Testing
- [ ] Create test suite for all syntax variants
- [ ] Generate IR for sample files
- [ ] Validate parser error handling

### Phase A2: Audio Engine Integration

**Goal**: Implement audio playback and processing

#### A2.1 Audio File Loading
- [ ] WAV format support
- [ ] AIFF format support
- [ ] MP3 format support
- [ ] MP4 format support
- [ ] Sample rate conversion to 48kHz/24bit

#### A2.2 Audio Slicing
- [ ] Implement chop(n) functionality
- [ ] Calculate slice boundaries
- [ ] Handle edge cases (uneven division)

#### A2.3 Time-Stretching
- [ ] Default playback (tempo-adjusted)
- [ ] Implement time-stretch algorithm
- [ ] Maintain audio quality

#### A2.4 Pitch Shifting
- [ ] Implement fixpitch(n) functionality
- [ ] Granular synthesis or PSOLA
- [ ] Preserve formants option

#### A2.5 Audio Output
- [ ] CoreAudio integration (macOS)
- [ ] Buffer management
- [ ] Latency optimization

### Phase A3: Transport System

**Goal**: Implement real-time transport controls

#### A3.1 Global Transport
- [ ] run() - start from next bar
- [ ] run.force() - immediate start
- [ ] loop() - loop from next bar
- [ ] loop.force() - immediate loop
- [ ] stop() - stop all sequences

#### A3.2 Sequence Transport
- [ ] Per-sequence run/loop/stop
- [ ] Mute/unmute functionality
- [ ] Targeted transport (specific sequences)

#### A3.3 Scheduling
- [ ] Bar boundary quantization
- [ ] Independent sequence timing
- [ ] Polymeter support

#### A3.4 State Management
- [ ] Track playing sequences
- [ ] Handle sequence synchronization
- [ ] Manage loop points

### Phase A4: VS Code Extension Update

**Goal**: Update extension for audio DSL support

#### A4.1 Syntax Highlighting
- [ ] Update grammar for new syntax
- [ ] Highlight method calls
- [ ] Highlight transport commands

#### A4.2 Command Execution
- [ ] Implement Cmd+Enter execution
- [ ] Parse selected text
- [ ] Send to engine via IPC

#### A4.3 IntelliSense and Autocomplete
- [ ] Method autocomplete
  - Context-aware suggestions (global vs sequence methods)
  - Method signature display
  - Quick info tooltips
- [ ] Parameter hints
  - Type information
  - Valid value ranges
  - Example values
- [ ] Documentation hover
  - Method descriptions
  - Usage examples
  - Links to documentation
- [ ] Snippet support
  - Common patterns (init, play, etc.)
  - Template expansion
  - Cursor positioning
- [ ] NO abbreviations in DSL
  - Full readable names only
  - Speed through autocomplete, not shortcuts
  - Maintain code readability

#### A4.4 Diagnostics
- [ ] Real-time syntax checking
- [ ] Error highlighting
- [ ] Warning for deprecated features

### Phase A5: DAW Plugin Development

**Goal**: Create VST/AU plugin for DAW integration

#### A5.1 Plugin Architecture
- [ ] VST3 wrapper implementation
- [ ] AU wrapper implementation
- [ ] IPC with OrbitScore engine

#### A5.2 Audio Routing
- [ ] Select sequence output
- [ ] Multi-channel support
- [ ] Sync with DAW transport

#### A5.3 Parameter Automation
- [ ] Expose parameters to DAW
- [ ] Handle automation curves
- [ ] Real-time parameter updates

## Testing Strategy

### Unit Tests
- Parser: All syntax variants
- Audio Engine: File formats, slicing, stretching
- Transport: State transitions, timing

### Integration Tests
- End-to-end playback
- Multi-sequence synchronization
- Editor command execution

### Performance Tests
- Audio latency measurement
- CPU usage optimization
- Memory management

## Success Criteria

1. **Parser**: Successfully parse all DSL syntax from INSTRUCTION_ORBITSCORE_DSL.md
2. **Audio**: Play sliced audio with tempo adjustment and optional pitch preservation
3. **Transport**: Execute all transport commands with proper timing
4. **Editor**: Cmd+Enter execution works for all commands
5. **DAW**: Plugin routes audio to DAW tracks

## Migration Path

### Deprecated Components
- `packages/engine/src/midi.ts` - MIDI output
- `packages/engine/src/pitch.ts` - Degree to MIDI conversion
- Old parser for MIDI-based syntax

### New Components Needed
- `packages/engine/src/audio/` - Audio engine
- `packages/engine/src/transport/` - Transport system
- `packages/engine/src/parser/audio-parser.ts` - New parser
- `packages/daw-plugin/` - DAW plugin package

## Risk Mitigation

1. **Audio Latency**: Use appropriate buffer sizes, implement look-ahead
2. **Time-Stretching Quality**: Research best algorithms (Rubber Band, SoundTouch)
3. **Cross-Platform**: Initially focus on macOS, plan for Windows/Linux
4. **DAW Compatibility**: Test with major DAWs (Ableton, Logic, Cubase)

## Timeline Estimate

- Phase A1 (Parser): 1 week
- Phase A2 (Audio Engine): 2-3 weeks
- Phase A3 (Transport): 1 week
- Phase A4 (VS Code Extension): 1 week
- Phase A5 (DAW Plugin): 2-3 weeks

**Total**: 7-10 weeks for full implementation

---

*Last Updated: December 25, 2024*
*Canonical Reference: `docs/INSTRUCTION_ORBITSCORE_DSL.md`*