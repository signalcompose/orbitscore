# Future Features TODO

This document tracks features that have been discussed or planned but not yet implemented in OrbitScore.

## Audio Recording Feature (High Priority)

**Background**: During a live performance, the user forgot to record in Ableton, resulting in no archive. OrbitScore should have built-in recording capability.

**Requirements**:
- `global.start()` begins recording from master out
- `global.stop()` stops recording and saves the file
- Future: Record MIDI data per sequence when using IAC Bus for external sound sources
- Recording should capture absolute time based on Global's settings
- Audio format: likely WAV at 48kHz/24bit (or configurable)

**Implementation Considerations**:
- Need to integrate with SuperCollider's recording capabilities
- Should support multi-output recording (master + per-sequence stems)
- File naming and storage location configuration
- Buffer management for long recordings

**Related Issue**: To be created when implementation begins

---

## Audio Key Detection (Medium Priority)

**Background**: For audio files (not MIDI), OrbitScore needs to detect the musical key of audio samples to enable polymodal/key-based features.

**Requirements**:
- Analyze audio files to detect their musical key (e.g., C major, D minor)
- Store key information with audio buffers
- Enable `key()` method for audio-based sequences
- Support key transposition and polymodal composition with audio

**Implementation Considerations**:
- Audio analysis algorithm (FFT-based, machine learning, or library integration)
- Performance: analysis should happen during audio loading, not playback
- Accuracy: need reliable key detection for various audio types (drums, melodic, noise)
- May integrate with existing audio analysis tools (Essentia, librosa, etc.)

**Dependencies**: This must be implemented before `key()` can be used with audio files

---

## MIDI Support (Future)

**Status**: Currently deprecated/removed from DSL v3.0

**Background**: Original OrbitScore used MIDI output. Audio engine (SuperCollider) has replaced this, but MIDI will be added back for external instrument control.

**Requirements**:
- `tick()` method for MIDI resolution (480, 960, 1920 ticks per quarter note)
- `key()` method for MIDI key/scale (C, D, E, etc.)
- IAC Bus integration on macOS for routing MIDI to external instruments
- Per-sequence MIDI recording (same absolute time format as audio recording)
- MIDI CC control for external parameters

**Implementation Note**: When MIDI is added:
- Add back `tick()` to Global and TempoManager
- Add back `key()` to Global
- Consider whether sequences need `key()` method too (likely yes, for polymodal support)

---

## Audio Manipulation Features (Medium Priority)

Features planned but not yet implemented in parser/engine:

### fixpitch()
- Pitch shift in semitones without affecting playback speed
- Requires granular synthesis or PSOLA-based time-stretching
- Parser currently throws error directing users to GitHub issues
- Use case: Transpose loops while maintaining tempo

### time()
- Time stretch/compression without affecting pitch
- Requires time-stretch algorithm implementation
- Parser currently throws error directing users to GitHub issues
- Use case: Speed up/slow down loops while maintaining pitch

### Other Planned Features
- `offset()`: Start position adjustment within sample
- `reverse()`: Reverse playback
- `fade()`: Fade in/out envelopes

**Implementation Considerations**:
- All require audio DSP algorithms (SuperCollider has built-in support for some)
- Performance impact during playback must be minimal
- Should work with sliced audio (chop) seamlessly

---

## Composite Meters (Low Priority)

**Status**: Removed from DSL v3.0 as not yet implemented

**Background**: Originally planned to support complex time signatures like `(4 by 4)(5 by 4)` or `4/4+3/8`.

**Current Status**:
- Parser rejects composite meter syntax with clear error message
- Single meters only: `4 by 4`, `5 by 4`, `3 by 8`
- Polyrhythm can still be achieved via individual sequence meters

**Future Implementation**:
- May add support for additive meters (e.g., 4/4+3/8)
- Timing calculation algorithms need to be designed
- Use cases: Contemporary classical music, complex polyrhythms
- Current polymeter support is sufficient for most use cases

**Decision**: Only implement if there's a clear user demand and use case

---

## Per-Sequence Effects (Future)

Currently only Global has mastering effects (compressor, limiter, normalizer).

**Planned Effects**:
- `delay()`: Per-sequence delay effect
- `reverb()`: Per-sequence reverb effect
- `filter()`: Per-sequence filter effects (lowpass, highpass, bandpass)
- Effect chaining and routing

**Implementation Considerations**:
- SuperCollider has built-in effects
- Need to design effect parameter API
- Consider effect presets system
- Multi-output routing for stems

---

## DAW Integration (Future)

**Requirements**:
- VST/AU plugin that acts as bridge between OrbitScore and DAW
- Select which sequence output to route
- MIDI routing via IAC Bus (macOS)
- Audio routing for multi-track recording
- Sync with DAW transport (start/stop/tempo)

**Implementation**: Major undertaking, requires plugin development experience

---

## Multi-Output / Routing System (Future)

Related to recording and DAW integration:

**Requirements**:
- Route each sequence to separate audio outputs
- Mix and match sequences on different busses
- Per-sequence gain/pan/effects
- Master bus processing

**Implementation Considerations**:
- Need to consider relationship with recording, multi-output, effects
- May affect Global and Sequence architecture
- Plan holistically before implementation

---

## Notes on Prioritization

**High Priority**:
- Recording feature (user need for archiving live performances)

**Medium Priority**:
- Audio key detection (enables polymodal features for audio)
- Audio manipulation (fixpitch, time, offset, reverse, fade)

**Low Priority**:
- Composite meters (current polymeter support is sufficient)

**Future** (requires significant design/implementation):
- MIDI support
- Per-sequence effects
- DAW integration
- Multi-output routing

---

## Process for Adding Features

1. **Specification First**: Update `docs/INSTRUCTION_ORBITSCORE_DSL.md` with clear spec
2. **Parser Support**: Add syntax support if needed
3. **Core Implementation**: Implement in Global/Sequence/AudioEngine
4. **Tests**: Add comprehensive tests
5. **Documentation**: Update user manuals and examples
6. **VS Code Extension**: Update autocomplete/IntelliSense if needed

**Never implement before specification is agreed upon and documented.**
