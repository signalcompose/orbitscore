# OrbitScore Project Overview

## Project Description
OrbitScore is a live coding environment for audio performance, featuring a custom DSL for intuitive musical pattern creation with ultra-low latency playback.

## Tech Stack
- **Language**: TypeScript
- **Audio Engine**: SuperCollider (scsynth + supercolliderjs)
- **VS Code Extension**: Cursor/VS Code extension for live coding
- **Parser**: Custom DSL parser with dB unit and negative number support
- **Scheduler**: Precision 1ms interval scheduler
- **Build**: npm workspaces (monorepo)

## Architecture
- `packages/engine`: Core audio engine with SuperCollider integration
- `packages/vscode-extension`: Cursor/VS Code extension for live coding
- `examples/`: Tutorial files (01-08) and reference tests
- `test-assets/audio/`: Sample audio files (kick, snare, hihat)
- `tests/`: Comprehensive test suite (77 tests total)

## Current Status (Phase 9: dB-Based Gain Control - 100% Complete)

### Phase 9 Achievements (January 6, 2025)

#### 1. Professional dB Unit for Volume Control
- ✅ Replaced 0-100 integer with dB unit (-60 to +12 dB)
- ✅ Default: 0 dB (unity gain, 100%)
- ✅ Conversion: amplitude = 10^(dB/20)
- ✅ Examples: -6 dB ≈ 50%, -12 dB ≈ 25%, +6 dB ≈ 200%
- ✅ Full floating-point precision for fine control
- ✅ Real-time updates with 1-2ms latency
- ✅ Method chaining support

#### 2. Master Volume (Global Gain)
- ✅ `global.gain()` affects all sequences
- ✅ Final dB = sequence dB + master dB (additive in dB domain)
- ✅ Real-time updates cascade to all playing sequences
- ✅ Professional mixing capability

#### 3. Silence Control
- ✅ `-inf` and `-Infinity` for complete silence
- ✅ Short form `-inf` for convenience
- ✅ Amplitude = 0.0 when -Infinity

#### 4. Parser Enhancement
- ✅ Support for `-inf` as alias for `-Infinity`
- ✅ Enhanced negative number parsing for decimal dB values
- ✅ Correct handling of floating-point dB values

#### 5. Test Coverage
- ✅ **77 tests passing** (100% pass rate)
  - Sequence tests: 20 tests
  - SuperCollider conversion tests: 15 tests
  - Parser tests: 42 tests
- ✅ Verified dB to amplitude conversion accuracy
- ✅ Tested real-time gain changes
- ✅ Tested master volume control

#### 6. Documentation & Examples
- ✅ Updated Tutorial 07: Audio Control with dB units
- ✅ Created 3 test files for dB verification
- ✅ Added Tutorial File Management rule to PROJECT_RULES.md
- ✅ Mandates checking tutorials before creating test files

### Previous Achievements (Phases 1-8)

#### Phase 8: Audio Control & Timing Verification
- ✅ Pan control (-100 to 100, stereo positioning)
- ✅ Timing verification: 0-2ms drift at all scales
- ✅ Polymeter, polytempo, nested rhythms (11 levels)

#### Phase 7: SuperCollider Integration
- ✅ 0-2ms latency (70x better than sox)
- ✅ Buffer preloading with automatic caching
- ✅ Chop functionality with slice indexing

### Performance Metrics (Verified)
- **Latency**: 0-2ms (exceptional)
- **Timing drift**: 0-2ms (even at 0.98ms intervals)
- **Gain precision**: Full floating-point (unlimited resolution)
- **Stability**: 100% (no crashes, no leaks)
- **Test coverage**: 77 tests (100% pass rate)

### Latest Commit
- `e023304` - feat: Implement dB-based gain control for sequences and global master volume

## Next Phase Options

### Option 1: VST Plugin Support (User Requested)
- Load VST/VST3 plugins via SuperCollider VSTPlugin
- GUI control for plugin parameters
- Integration with OrbitScore DSL

### Option 2: Built-in Effects
- Pitch control (`pitch()` method)
- Filters (`lpf()`, `hpf()`)
- Reverb (`reverb()`)
- Compression (`compress()`)

### Current Focus
- Ready for next feature discussion
- All timing and control features verified and stable
- Professional audio control with dB units implemented
