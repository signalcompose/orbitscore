# OrbitScore Project Overview

## Project Description
OrbitScore is a live coding environment for audio performance, featuring a custom DSL for intuitive musical pattern creation with ultra-low latency playback.

## Tech Stack
- **Language**: TypeScript
- **Audio Engine**: SuperCollider (scsynth + supercolliderjs)
- **VS Code Extension**: Cursor/VS Code extension for live coding
- **Parser**: Custom DSL parser for audio patterns with negative number support
- **Scheduler**: Precision 1ms interval scheduler
- **Build**: npm workspaces (monorepo)

## Architecture
- `packages/engine`: Core audio engine with SuperCollider integration
- `packages/vscode-extension`: Cursor/VS Code extension for live coding
- `examples/`: Tutorial files (01-08) and reference tests
- `test-assets/audio/`: Sample audio files (kick, snare, hihat)
- `tests/`: Comprehensive test suite (67 tests total)

## Current Status (Phase 8: Audio Control & Timing Verification - 100% Complete)

### Phase 8 Achievements (January 5, 2025)

#### 1. Volume Control (gain)
- ✅ `gain()` method implementation
  - Range: 0-100 (default: 80)
  - Maps to SuperCollider amp: 0.0-1.0
  - Real-time updates with 1-2ms latency
  - Method chaining support
  - 15 unit tests passing

#### 2. Stereo Positioning (pan)
- ✅ `pan()` method implementation
  - Range: -100 (left) to 100 (right), default: 0 (center)
  - Maps to SuperCollider pan: -1.0 to 1.0
  - Real-time updates with 1-2ms latency
  - Method chaining support
  - 28 unit tests passing

#### 3. Parser Enhancement
- ✅ Negative number support
  - Added MINUS token type
  - Correctly parses pan(-100), pan(-50), etc.
  - 6 new parser tests

#### 4. Timing Verification
- ✅ Polymeter: Different time signatures (4/4, 5/4, 7/4)
- ✅ Polytempo: Different tempos (80-160 BPM)
- ✅ Nested rhythms: Up to 11 levels (2048th notes, 0.98ms intervals)
- ✅ Multi-track: 5 simultaneous tracks with complex patterns
- ✅ Timing drift: 0-2ms consistently

### Test Coverage
- **Total**: 67 tests (66 passing, 1 skipped)
  - Parser: 39 tests
  - Sequence: 15 tests
  - SuperCollider: 13 tests

### Documentation & Examples
- ✅ Comprehensive Phase 8 work log
- ✅ New tutorials:
  - `07_audio_control.osc` - Volume and stereo positioning
  - `08_timing_verification.osc` - Timing tests and performance metrics
- ✅ Cleaned up examples directory (17 files organized)
- ✅ Updated README with new tutorials

### Performance Metrics (Verified)
- **Latency**: 0-2ms (70x better than sox)
- **Timing drift**: 0-2ms across all tracks
- **Precision**: Sub-millisecond (0.98ms intervals working)
- **Stability**: 100% (no crashes, no leaks)

### Latest Commits
- `c9025c5` - docs: Add Phase 8 documentation and reorganize examples
- `2ed153a` - feat: Add gain() and pan() methods for audio control
- `11f5d4e` - docs: Update documentation for Phase 7 SuperCollider integration
- `06cd4dd` - feat: Complete chop functionality with buffer preloading
- `aa8fd2c` - feat: Complete SuperCollider live coding integration in Cursor

## Next Phase (Phase 9: Advanced Audio Effects)

### Planned Features
1. **Pitch Control** - `pitch()` method using SuperCollider's rate parameter
2. **Filters** - `lpf()` and `hpf()` methods (low-pass/high-pass)
3. **Reverb** - `reverb()` method
4. **Compression** - `compress()` method

### Current Focus
- Ready to implement compression/effects
- All timing and control features verified and stable
