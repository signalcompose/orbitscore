# OrbitScore Project Overview

## Project Description
OrbitScore is a live coding environment for audio performance, featuring a custom DSL for intuitive musical pattern creation with ultra-low latency playback.

## Tech Stack
- **Language**: TypeScript
- **Audio Engine**: SuperCollider (scsynth + supercolliderjs)
- **VS Code Extension**: Cursor/VS Code extension for live coding
- **Parser**: Custom DSL parser with dB unit, negative number, and boolean literal support
- **Scheduler**: Precision 1ms interval scheduler
- **Build**: npm workspaces (monorepo)

## Architecture
- `packages/engine`: Core audio engine with SuperCollider integration
- `packages/vscode-extension`: Cursor/VS Code extension for live coding
- `examples/`: Tutorial files (01-09) and reference tests
- `test-assets/audio/`: Sample audio files (kick, snare, hihat)
- `tests/`: Comprehensive test suite (77 tests total)

## Current Status (Phase 9: Global Mastering Effects - 100% Complete)

### Phase 9 Achievements (January 6, 2025)

#### 1. Global Mastering Effects
- ✅ **Compressor (Compander)** - Increase perceived loudness
  - Parameters: `threshold` (0-1), `ratio` (0-1), `attack` (s), `release` (s), `makeupGain` (0-2)
  - Ultra-aggressive preset: `global.compressor(0.15, 0.95, 0.001, 0.02, 2.0, true)`
- ✅ **Limiter** - Prevent clipping
  - Parameters: `level` (0-1), `duration` (lookahead time)
  - Brick wall preset: `global.limiter(0.95, 0.01, true)`
- ✅ **Normalizer** - Maximize output level
  - Parameters: `level` (0-1), `duration` (lookahead time)
  - Maximum preset: `global.normalizer(1.0, 0.01, true)`

#### 2. Technical Architecture
**SuperCollider**:
- All effects process bus 0 (master output) directly
- Use `In.ar(0, 2)` → `ReplaceOut.ar(0, ...)` for in-place processing
- Effect chain: orbitPlayBuf → Compressor → Limiter → Normalizer → Output
- SynthDefs: `fxCompressor`, `fxLimiter`, `fxNormalizer`

**TypeScript**:
- Effect synth management: `Map<string, Map<string, number>>` (target → effectType → synthID)
- Individual effect control: add/remove/update independently
- Seamless updates: `/n_set` for existing synths, `/s_new` for new
- Proper cleanup: `/n_free` removes specific effect only

#### 3. Parser & Extension Enhancements
- ✅ Boolean literal support: `true`/`false` recognized as boolean values
- ✅ Auto-evaluation filter: `compressor`, `limiter`, `normalizer` require Cmd+Enter
- ✅ Completion providers for all mastering effects

#### 4. Testing & Verification
- ✅ Significant loudness increase confirmed
- ✅ Individual on/off control working
- ✅ Seamless parameter updates during playback
- ✅ No audio dropout when effects removed
- ✅ Dry signal returns when all effects off

### Previous Achievements (Phases 1-8)

#### Phase 8: dB-Based Gain Control
- ✅ Professional dB unit (-60 to +12 dB, default 0 dB)
- ✅ Master volume: `global.gain()`
- ✅ Silence: `-inf` or `-Infinity`
- ✅ Random values: `r` (full random), `r0%10` (random walk)
- ✅ Seamless parameter changes (no restart)

#### Phase 7: SuperCollider Integration
- ✅ 0-2ms latency (70x better than sox)
- ✅ Buffer preloading with automatic caching
- ✅ Chop functionality with slice indexing
- ✅ Audio device selection via command palette

#### Phase 6: Audio DSL
- ✅ Pan control (-100 to 100, stereo positioning)
- ✅ Timing verification: 0-2ms drift at all scales
- ✅ Polymeter, polytempo, nested rhythms (11 levels)

### Performance Metrics (Verified)
- **Latency**: 0-2ms (exceptional)
- **Timing drift**: 0-2ms (even at 0.98ms intervals)
- **Gain precision**: Full floating-point dB (unlimited resolution)
- **Stability**: 100% (no crashes, no leaks)
- **Test coverage**: 77 tests (100% pass rate)

### Key Features Summary

**Audio Control**:
- `sequence.gain(dB)` - Volume in dB (-60 to +12, default 0)
- `sequence.pan(position)` - Stereo position (-100 to 100)
- `global.gain(dB)` - Master volume
- Random values: `gain(r)`, `gain(r-6%3)`, `pan(r50%30)`

**Mastering Effects** (Global only):
- `global.compressor(threshold, ratio, attack, release, makeupGain, enabled)`
- `global.limiter(level, duration, enabled)`
- `global.normalizer(level, duration, enabled)`

**Timing Features**:
- Polymeter: Different time signatures per sequence
- Polytempo: Different BPM per sequence
- Nested rhythms: Up to 11 levels tested (0.98ms precision)

**Audio Manipulation**:
- `chop(n)` - Split audio into n slices
- `play(pattern)` - Complex nested rhythm patterns
- `audio(file)` - Load audio files with caching

**Live Coding**:
- Seamless parameter changes (no restart)
- Auto-evaluation on save (settings only)
- Cmd+Enter for execution commands
- Status bar with command palette

### Latest Commits
- `5fd235a` - feat: Global mastering effects (compressor, limiter, normalizer)
- `53b178b` - feat: Add audio device selection via command palette
- `f0ffbbb` - docs: Add user confirmation requirement to project rules

## Next Phase Options

### Option 1: Effect Presets System (User Requested)
- TypeScript-style import/export for effect presets
- Named preset definitions
- Reusable mastering chains

### Option 2: Additional Effects
- Reverb (FreeVerb)
- Delay (CombL)
- Filters (RLPF, RHPF)

### Option 3: Per-Sequence Effects
- Revisit dynamic bus allocation
- Independent effect processing per sequence

### Current Focus
- Preparing to implement effect presets system
- All mastering effects verified and stable
- Ready for next feature discussion