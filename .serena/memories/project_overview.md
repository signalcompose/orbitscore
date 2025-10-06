# OrbitScore Project Overview

## Project Description
OrbitScore is a live coding environment for audio performance, featuring a custom DSL for intuitive musical pattern creation with ultra-low latency playback.

## Tech Stack
- **Language**: TypeScript
- **Audio Engine**: SuperCollider (scsynth + supercolliderjs)
- **VS Code Extension**: Cursor/VS Code extension for live coding
- **Parser**: Custom DSL parser (audio-parser.ts) with dB unit, negative number, boolean literal support
- **Scheduler**: Precision 1ms interval scheduler
- **Build**: npm workspaces (monorepo)

## Architecture
- `packages/engine`: Core audio engine with SuperCollider integration
- `packages/vscode-extension`: Cursor/VS Code extension for live coding
- `examples/`: Tutorial files and comprehensive tests
- `test-assets/audio/`: Sample audio files
- `tests/`: Core test suite (128 tests passing)

## Current Status (Phase 10: Codebase Cleanup - 100% Complete)

### Phase 10 Achievements (January 6, 2025)

#### 1. Major Codebase Cleanup (5896 lines deleted)
- ✅ **MIDI System Removed**: Complete removal of deprecated MIDI-based architecture
  - Deleted: midi.ts, scheduler.ts, old parser, transport, IR, pitch conversion
  - Deleted: 25 MIDI-related test files
  - Result: Clean, maintainable codebase focused on SuperCollider
- ✅ **Unimplemented Features Cleaned**: Removed placeholder completions (delay, fixpitch, time)
- ✅ **Transport System Removed**: Old Transport class replaced with direct SuperCollider scheduling

#### 2. Debug Mode Implementation
- ✅ **Dual Mode Operation**:
  - 🚀 Normal Mode: Clean output (only important messages)
  - 🐛 Debug Mode: Full verbose logging (SuperCollider communication)
- ✅ **Smart Filtering**: Removes sendosc/rcvosc, JSON, OSC messages, device info
- ✅ **Status Bar Integration**: Shows 🐛 icon in debug mode
- ✅ **CLI Support**: `--debug` flag for verbose output

#### 3. length() Fix
- ✅ **Correct Behavior**: `length(n)` now multiplies event duration by n
- ✅ **Auto-Recalculation**: Timing recalculated when length changes
- ✅ **Seamless Updates**: Auto-restart loop when length changes during playback
- ✅ **Example**: `length(2)` doubles beat duration (1 bar pattern over 2 bars)

#### 4. Execution Method Filters
- ✅ **Added to filter**: `length`, `tempo`, `beat` (Cmd+Enter required when standalone)
- ✅ **Preserved**: Method chaining auto-evaluation
- ✅ **Example**: `kick.length(2)` requires Cmd+Enter, but `kick.tempo(140).audio(...).play(...)` auto-evaluates

#### 5. Comprehensive Testing
- ✅ **test-all-features.osc**: All implemented features in one file
- ✅ **Test Coverage**: 128/143 tests passing (core functionality 100%)
- ✅ **Verified Features**: Init, config, audio, chop, gain, pan, random, polymeter, polytempo, nested, length, mastering effects, transport

### Previous Achievements (Phases 1-9)

#### Phase 9: Global Mastering Effects
- ✅ Compressor, Limiter, Normalizer
- ✅ Individual on/off control
- ✅ Seamless parameter updates
- ✅ Significant loudness increase

#### Phase 8: dB-Based Gain Control
- ✅ Professional dB unit (-60 to +12 dB)
- ✅ Master volume: `global.gain()`
- ✅ Random values: `r`, `r0%10`
- ✅ Seamless parameter changes

#### Phase 7: SuperCollider Integration
- ✅ 0-2ms latency
- ✅ Buffer caching
- ✅ Chop functionality
- ✅ Audio device selection

#### Phase 6: Audio DSL
- ✅ Pan control (-100 to 100)
- ✅ Timing verification (0-2ms drift)
- ✅ Polymeter, polytempo
- ✅ Nested rhythms (11 levels)

### Performance Metrics
- **Latency**: 0-2ms (exceptional)
- **Timing drift**: 0-2ms (sub-millisecond precision)
- **Test coverage**: 128 tests passing
- **Codebase**: ~6000 lines cleaner

### Key Features Summary

**Audio Control**:
- `sequence.gain(dB)` - Volume in dB
- `sequence.pan(position)` - Stereo position
- `sequence.length(bars)` - Loop length multiplier
- `sequence.tempo(bpm)` - Independent tempo
- `sequence.beat(n by d)` - Independent meter
- `global.gain(dB)` - Master volume
- Random values: `r`, `r-6%3`, `pan(r50%30)`

**Mastering Effects** (Global):
- `global.compressor(threshold, ratio, attack, release, makeupGain, enabled)`
- `global.limiter(level, duration, enabled)`
- `global.normalizer(level, duration, enabled)`

**Timing Features**:
- Polymeter: Different time signatures
- Polytempo: Different BPM
- Nested rhythms: Up to 11 levels
- Length control: Stretch pattern duration

**Audio Manipulation**:
- `chop(n)` - Split audio into n slices
- `play(pattern)` - Nested rhythm patterns
- `audio(file)` - Load with caching

**Live Coding**:
- Seamless parameter changes
- Auto-evaluation (settings)
- Cmd+Enter (execution/changes)
- Debug mode for troubleshooting

**VS Code Integration**:
- Status bar with command palette
- Debug/Normal mode toggle
- Audio device selection
- Kill SuperCollider command
- Smart auto-completion

### Deprecated/Removed

**MIDI System** (Completely Removed):
- Old MIDI-based DSL syntax
- MIDI output functionality
- All related tests and implementations
- 5896 lines of legacy code

### Latest Commits
- `6171c8d` - docs: Update documentation for codebase cleanup and debug mode
- `542e901` - feat: Add debug mode and fix length() implementation
- `0f5fb7f` - refactor: Remove deprecated MIDI system and old implementations

## Next Phase Options

### Option 1: Effect Presets System
- TypeScript-style import/export
- Named preset definitions
- Reusable mastering chains

### Option 2: Additional Effects
- Reverb (FreeVerb)
- Delay (CombL) - for global only
- Filters (RLPF, RHPF)

### Current Focus
- Ready for preset system implementation
- All core features stable and tested
- Clean codebase ready for new features