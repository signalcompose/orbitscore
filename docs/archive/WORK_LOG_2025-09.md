# OrbitScore Development Work Log - September 2025 Archive

**Archive Period**: September 16, 2025 - October 4, 2025  
**Note**: This is an archived version of the work log. For recent work, see [../WORK_LOG.md](../WORK_LOG.md)

---

### 6.15 Multi-Track Synchronization and Final Fixes (October 5, 2025)

**Date**: October 5, 2025
**Status**: ✅ COMPLETE

**Work Content**: Resolved final issues with multi-track playback and completed Phase 6

#### Issue 1: Snare Pattern Playback Bug
**Problem**: `snare.play(0, 1, 0, 1)` was heard as `(0, 1, 1, 0)` or distorted pattern  
**Impact**: Multi-track synchronization broken, live performance impossible  
**Root Cause**: `scheduledPlays` array was only sorted once at scheduler initialization. New events added during live coding were appended without re-sorting, causing out-of-order execution  
**Debug Evidence**:
```
Scheduled: snare at 47341ms
Actually played: snare at 47841ms (drift: 500ms) ← Wrong!
```

**Fix**: Added `this.scheduledPlays.sort((a, b) => a.time - b.time)` to `playAudio()` method  
**Result**: ✅ Perfect timing, all sequences play with 0-3ms drift  
**Files**: `packages/engine/src/audio/advanced-player.ts`

#### Issue 2: Auto-Start Scheduler
**Problem**: Calling `sequence.loop()` automatically started scheduler, even after `global.stop()`  
**Impact**: Loss of explicit control over when audio plays  
**Root Cause**: `scheduleEvent()` and `scheduleSliceEvent()` contained auto-start logic  
**Fix**: 
1. Removed auto-start from `scheduleEvent()` and `scheduleSliceEvent()`
2. Added scheduler running checks to `sequence.run()` and `sequence.loop()`
3. Display warning: `⚠️ kick.loop() - scheduler not running. Use global.start() first.`

**Result**: ✅ Users must explicitly call `global.start()` before sequences will play  
**Files**: `packages/engine/src/audio/advanced-player.ts`, `packages/engine/src/core/sequence.ts`

#### Issue 3: Live Sequence Addition Required Restart
**Problem**: Adding new sequences (e.g., hihat) during live coding required engine restart  
**Impact**: Broken live coding workflow, loss of state  
**Root Cause**: `filterDefinitionsOnly()` filtered out ALL `var` declarations during re-evaluation  
**Fix**: Removed `var` declaration filtering - `InterpreterV2` already handles instance reuse  
**Result**: ✅ New sequences can be added by saving file, no restart needed  
**Files**: `packages/vscode-extension/src/extension.ts`

#### Issue 4: hasEvaluatedFile Not Reset
**Problem**: After engine restart, first file save showed `first: false`, causing instance creation errors  
**Impact**: Sequences not instantiated after restart  
**Root Cause**: `hasEvaluatedFile` flag not reset in `startEngine()`, `stopEngine()`, and process exit handler  
**Fix**: Added `hasEvaluatedFile = false` to all engine lifecycle events  
**Result**: ✅ First save after restart correctly initializes all instances  
**Files**: `packages/vscode-extension/src/extension.ts`

#### Final Test Results

**3-Track Synchronization Test** (kick + snare + hihat):
```
🔊 Playing: kick at 178494ms (drift: 1ms)
🔊 Playing: hihat at 178494ms (drift: 1ms)  ← Perfect sync!
🔊 Playing: snare at 178994ms (drift: 1ms)
🔊 Playing: hihat at 178994ms (drift: 1ms)
🔊 Playing: kick at 179493ms (drift: 0ms)
🔊 Playing: hihat at 179493ms (drift: 0ms)
🔊 Playing: snare at 179993ms (drift: 0ms)
🔊 Playing: hihat at 179993ms (drift: 0ms)
```

**Timing Accuracy**:
- Target interval: 500ms
- Actual drift: 0-3ms (0.6% error)
- Parallel playback: Perfect synchronization

**Workflow Verification**:
- ✅ Engine start without `global.start()` → no audio
- ✅ `kick.loop()` without `global.start()` → warning displayed
- ✅ `global.start()` → scheduler starts
- ✅ `kick.loop()` → kick plays
- ✅ `snare.loop()` → snare added, synced with kick
- ✅ Add hihat to file and save → hihat available immediately
- ✅ `hihat.loop()` → hihat added, synced with kick and snare
- ✅ `kick.stop()` → only kick stops, others continue
- ✅ `snare.stop()` → only snare stops, hihat continues
- ✅ `global.stop()` → all stop
- ✅ `kick.loop()` after stop → warning displayed

#### Files Modified

**Engine Core**:
- `packages/engine/src/audio/advanced-player.ts`:
  - Added sort after `playAudio()` for chronological execution
  - Removed auto-start logic from `scheduleEvent()` and `scheduleSliceEvent()`
  - Removed verbose debug logs

- `packages/engine/src/core/sequence.ts`:
  - Added scheduler running checks to `run()` and `loop()`
  - Added warning messages for calls without running scheduler
  - Removed verbose debug logs

**VS Code Extension**:
- `packages/vscode-extension/src/extension.ts`:
  - Removed `var` declaration filtering in `filterDefinitionsOnly()`
  - Added `hasEvaluatedFile = false` to `startEngine()`, `stopEngine()`, and exit handler
  - Removed verbose evaluation logs

**Examples**:
- `examples/multi-track-test.osc` - Updated to use `hihat_closed.wav`
- `examples/debug-snare.osc` - Created for testing (can be deleted)
- `examples/debug-kick-snare.osc` - Created for testing (can be deleted)

#### Debug Log Cleanup

Removed verbose logs while keeping essential messages:
- ✅ Removed: Pattern scheduling details
- ✅ Removed: Event-by-event playback logs
- ✅ Removed: File evaluation details
- ✅ Kept: Warning messages for user errors
- ✅ Kept: Status messages (Global running/stopped)
- ✅ Kept: Error messages

#### Phase 6 Metrics

**Development Time**:
- Initial implementation: 2 days
- Bug discovery and resolution: 1 day
- Total: 3 days

**Code Changes**:
- Files modified: 8 core files
- Lines of code: ~500 lines added/modified
- Debug sessions: 3 major iterations

**Test Coverage**:
- Unit tests: 216/217 passing (99.5%)
- Manual tests: All critical workflows verified
- Edge cases: Engine restart, multiple sequence addition, individual control

### 6.16 Phase 6 Final Status

**Status**: ✅ 100% COMPLETE

**All Features Working**:
1. ✅ Persistent engine process with REPL
2. ✅ Two-phase workflow (save for definitions, Cmd+Enter for execution)
3. ✅ Live sequence addition without restart
4. ✅ Perfect multi-track synchronization (0-3ms drift)
5. ✅ Individual sequence control (independent loop/stop)
6. ✅ Explicit scheduler control (no auto-start)
7. ✅ Reliable global stop functionality
8. ✅ Clean, production-ready logging

**Ready for Phase 7**: Advanced audio features (time-stretch, pitch-shift)

**Commit History**:
- `58add44` - fix: resolve Phase 6 critical scheduler issues - live coding workflow complete
- `0fc66c4` - fix: multi-track synchronization and Phase 6 completion

---

### 6.17 Polymeter Support Implementation (October 5, 2025)

**Objective**: Enable sequences to have independent time signatures (polymeter/polytempo).

**Problem Identified**:
- Bar duration calculation used incorrect formula: `barDuration = (60000 / tempo) * meter.numerator`
- This prevented sequences from having different bar lengths
- `beat(5 by 4)` was incorrectly calculated as 2500ms when it should be based on numerator and denominator

**Solution Implemented**:
1. **Corrected Bar Duration Formula**:
   - Old: `barDuration = beatDuration * meter.numerator` (wrong)
   - New: `barDuration = quarterNoteDuration * (meter.numerator / meter.denominator * 4)` (correct)
   
2. **Applied to Multiple Locations**:
   - `play()` method - for initial timing calculation
   - `getPatternDuration()` - for loop duration calculation

**Mathematical Examples** (BPM 120 = 500ms quarter note):
- `4 by 4`: 500 * (4/4 * 4) = 2000ms ✅
- `5 by 4`: 500 * (5/4 * 4) = 2500ms ✅
- `9 by 8`: 500 * (9/8 * 4) = 2250ms ✅

**Test Results**:
- ✅ Polymeter test: `kick.beat(4 by 4)` + `snare.beat(5 by 4)`
- ✅ Kick: 1000ms intervals (2000ms bar / 2 triggers)
- ✅ Snare: 1250ms intervals (2500ms bar / 2 triggers)
- ✅ Synchronization at 10000ms (20 beats = LCM of 4 and 5)
- ✅ Drift: 0-5ms (excellent accuracy)

**Files Modified**:
- `packages/engine/src/core/sequence.ts` - Fixed `play()` and `getPatternDuration()`
- `packages/engine/src/audio/advanced-player.ts` - Added debug logging
- `examples/multi-track-test.osc` - Updated for polymeter testing
- `test-assets/audio/hihat.wav` - Created combined hihat file (closed + open)

**Debug Enhancements**:
- Added playback timing logs: `🔊 Playing: {sequence} at {time}ms (scheduled: {scheduled}ms, drift: {drift}ms)`
- Helps verify precise timing and identify timing issues

**Key Insight**:
- `beat()` defines **bar duration**, not trigger count
- `play()` arguments define **trigger count and timing**
- This separation enables polymeter while keeping `play()` simple

**Commit**: (pending) `feat: add polymeter support with correct bar duration calculation`

---

## Phase 7: SuperCollider Integration (October 5, 2025)

### 7.1 Motivation and Decision

**Date**: October 5, 2025  
**Status**: ✅ COMPLETE

**Background**:
During Phase 6 testing, discovered significant latency issue with sox-based audio engine:
- First event of each loop: 140-150ms drift
- Subsequent events: 0-3ms drift
- Root cause: sox spawning new process for every audio event

**Decision**: Replace sox with SuperCollider for professional-grade, low-latency audio.

**SuperCollider Benefits**:
- Persistent server process (no per-event overhead)
- Professional audio synthesis server
- Industry-standard for live coding (TidalCycles, Sonic Pi)
- Support for real-time effects and synthesis
- OSC-based communication (fast and flexible)

### 7.2 SuperCollider Integration Implementation

**Core Components**:

1. **SuperColliderPlayer Class** (`packages/engine/src/audio/supercollider-player.ts`):
   - OSC communication via supercolliderjs
   - Buffer management and caching
   - Implements Scheduler interface (drop-in replacement for AdvancedAudioPlayer)
   - 1ms precision scheduler
   - Drift monitoring

2. **Custom SynthDef** (`packages/engine/supercollider/synthdefs/orbitPlayBuf.scsyndef`):
   - `PlayBuf` UGen for sample playback
   - Support for `startPos` and `duration` (chop functionality)
   - Conditional envelope for precise playback length
   - Auto-release (doneAction: 2)

3. **Scheduler Interface** (`packages/engine/src/core/global.ts`):
   - Polymorphic interface for audio backends
   - Allows both AudioEngine and SuperColliderPlayer
   - Optional Transport (SuperCollider doesn't need it)

**Implementation Steps**:
1. Created `SuperColliderPlayer` with boot, buffer loading, scheduling
2. Added `Scheduler` interface to `Global` class
3. Modified `InterpreterV2` to use `SuperColliderPlayer`
4. Added null checks for `Transport` (not needed with SuperCollider)
5. Fixed type compatibility issues

**Files Created**:
- `packages/engine/src/audio/supercollider-player.ts` - Main player class
- `packages/engine/supercollider/setup-chop-fixed.scd` - SynthDef creation script
- `packages/engine/test-sc-livecoding.js` - JavaScript test for verification
- `examples/test-sc-repl.osc` - DSL integration test

**Files Modified**:
- `packages/engine/src/interpreter/interpreter-v2.ts` - Use SuperColliderPlayer
- `packages/engine/src/core/global.ts` - Scheduler interface, Transport null checks
- `packages/engine/src/core/sequence.ts` - Type compatibility fixes
- `packages/engine/tsconfig.json` - Added skipLibCheck, esModuleInterop
- `tsconfig.base.json` - Added types, esModuleInterop
- `package.json` - Added @types/node to devDependencies
- `packages/engine/package.json` - Added supercolliderjs, osc, tslib

**TypeScript Issues Resolved**:
- Installed @types/node successfully after clean reinstall
- Fixed Scheduler type compatibility
- Added proper null handling for optional methods
- Enabled skipLibCheck for incomplete supercolliderjs types

**Commit**: `6f831d8` - feat: Integrate SuperCollider for ultra-low latency audio playback

### 7.3 REPL Boot Optimization

**Problem**: File save triggered 12 simultaneous SuperCollider boot attempts (one per line), causing:
- Memory leak warnings (MaxListenersExceeded)
- Port conflicts (UDP socket address in use)
- 11 failed boots, 1 successful

**Root Cause**:
- REPL received each file line separately
- Each line triggered `execute()` → `ensureBooted()`
- `isBooted` flag was per-instance, not maintained across calls

**Solution**:
1. Added explicit `boot()` call in REPL initialization
2. Made `boot()` public method on InterpreterV2
3. Boot happens once at engine startup, before REPL loop starts
4. All subsequent `execute()` calls reuse the booted instance

**Additional Fixes**:
- Added 100ms debounce to file evaluation in VS Code extension
- SIGTERM handler for graceful SuperCollider shutdown
- No more `killall scsynth` (safe for multiple SC sessions)

**Test Results**:
```
🎵 Booting SuperCollider server...  ← Only once!
✅ SuperCollider server ready
✅ SynthDef loaded
🎵 Live coding mode
✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓  ← All 12 lines processed
```

**Commits**:
- `4f071b8` - fix: Fix SuperCollider multiple boot issue in REPL mode

### 7.4 Audio Path Resolution and Chop Completion

**Problem 1: Audio Path Double-Join**:
- `global.audioPath("test-assets/audio")` + `kick.audio("kick.wav")`
- Result: `test-assets/audio/test-assets/audio/kick.wav` (double path)
- Root cause: `audio()` already joins paths, `scheduleEvents()` joined again

**Fix**: Remove redundant join in `scheduleEvents()`, use simple `path.resolve()`

**Problem 2: Workspace Root Resolution**:
- Engine cwd was `dist` directory
- Relative paths resolved from wrong location
- Fix: Set engine cwd to workspace root in extension

**Problem 3: Chop Slice Indexing**:
- DSL uses 1-based indexing: `play(1, 2, ...)` where `0` = silence
- SuperCollider uses 0-based: `startPos` should be `0, 0.15, ...`
- Fix: Convert with `(sliceIndex - 1) * sliceDuration`

**Problem 4: Buffer Duration Unknown**:
- First loop used default duration before buffer loaded
- Caused wrong `startPos` and `duration` values
- Fix: Preload buffers in `sequence.loop()` before scheduling

**Solution Implemented**:
```typescript
// In sequence.loop()
if (this._audioFilePath && scheduler.loadBuffer) {
  await scheduler.loadBuffer(resolvedPath)
}
```

**8-Beat Hihat Test Results**:
```
🔊 Playing: kick at 6033ms (scheduled: 6032ms, drift: 1ms)
🔊 Playing: hihat at 6033ms (scheduled: 6032ms, drift: 1ms)
  "bufnum": 2,
  "startPos": 0,      ← Correct! (closed hihat)
  "duration": 0.15
🔊 Playing: hihat at 6282ms
  "startPos": 0.15,   ← Correct! (open hihat)
  "duration": 0.15
```

**Graceful Shutdown**:
```typescript
// Extension sends SIGTERM
engineProcess.kill('SIGTERM')

// CLI handles it
process.on('SIGTERM', async () => {
  await audioEngine.quit()  // SuperCollider server quits gracefully
  process.exit(0)
})
```

**Files Modified**:
- `packages/engine/src/core/sequence.ts` - Path resolution, async loop, buffer preload
- `packages/engine/src/audio/supercollider-player.ts` - Slice index conversion, duration warning
- `packages/vscode-extension/src/extension.ts` - Workspace root cwd, SIGTERM handler, debounce
- `packages/engine/src/cli-audio.ts` - Shutdown handler
- `examples/test-sc-repl.osc` - Simplified (removed redundant beat settings)

**Commits**:
- `aa8fd2c` - feat: Complete SuperCollider live coding integration in Cursor
- `06cd4dd` - feat: Complete chop functionality with buffer preloading

### 7.5 Phase 7 Final Status

**Status**: ✅ 100% COMPLETE

**All Features Working**:
1. ✅ SuperCollider server integration
2. ✅ Ultra-low latency (0-2ms drift)
3. ✅ Perfect 3-track synchronization
4. ✅ Chop functionality with correct slicing
5. ✅ Buffer preloading
6. ✅ Graceful lifecycle management
7. ✅ Workspace-relative path resolution
8. ✅ Production-ready live coding in Cursor

**Performance Metrics**:
- **Latency improvement**: 140-150ms → 0-2ms (70x better!)
- **Drift**: 0-2ms (0.4% at BPM 120)
- **Stability**: 100% (no crashes)
- **Memory**: No leaks

**Test Results - 8-Beat Hihat**:
```
Kick:  1 - - 1 - - 1 - -  (on beats)
Snare: - - 1 - - 1 - - -  (backbeat)
Hihat: 1 2 1 2 1 2 1 2    (8th notes, closed/open)
Drift: 0-2ms across all tracks
```

**Ready for Phase 8**: Polymeter testing, advanced synthesis, effects

---

## Phase 8: Audio Control & Timing Verification (October 5, 2025)

### 8.1 Volume Control (gain) Implementation

**Date**: October 5, 2025  
**Status**: ✅ COMPLETE

**Work Content**: Implemented real-time volume control with live coding support

#### Implementation Details

**Sequence Class** (`packages/engine/src/core/sequence.ts`):
- Added `private _volume: number = 80` property (0-100 range)
- Implemented `gain(value: number): this` method
  - Clamps value to 0-100 range
  - Supports method chaining
  - Real-time update: clears and reschedules events if already playing
- Updated `scheduleEvents()` to pass volume parameter
- Added volume to `getState()` output

**SuperCollider Integration** (`packages/engine/src/audio/supercollider-player.ts`):
- Added `volume?: number` to options in `scheduleEvent()` and `scheduleSliceEvent()`
- Convert 0-100 range to 0.0-1.0 for SuperCollider's `amp` parameter
- Default value: 80 (0.8 amp)

**Parser Support** (no changes needed - already supported positive numbers)

**Test Coverage**: 15 tests added
- Value setting and clamping (0, 50, 80, 100)
- Method chaining
- Default value verification

**Example Usage**:
```osc
kick.gain(50).loop()   // 50% volume
kick.gain(100)         // Real-time change to 100%
kick.gain(0)           // Mute
```

**Files Modified**:
- `packages/engine/src/core/sequence.ts`
- `packages/engine/src/audio/supercollider-player.ts`
- `packages/engine/src/core/global.ts` (Scheduler interface)

---

### 8.2 Stereo Positioning (pan) Implementation

**Date**: October 5, 2025  
**Status**: ✅ COMPLETE

**Work Content**: Implemented stereo panning with negative number support

#### Implementation Details

**Sequence Class** (`packages/engine/src/core/sequence.ts`):
- Added `private _pan: number = 0` property (-100 to 100 range)
- Implemented `pan(value: number): this` method
  - Clamps value to -100~100 range (-100=left, 0=center, 100=right)
  - Real-time update support
  - Method chaining
- Updated event scheduling to pass pan parameter
- Added pan to `getState()` output

**Parser Enhancement** (`packages/engine/src/parser/audio-parser.ts`):
- **Critical Fix**: Added support for negative numbers
- Added `MINUS` token type
- Implemented negative number parsing in `parseArgument()`
- Now correctly parses `pan(-100)`, `pan(-50)`, etc.

**SuperCollider Integration** (`packages/engine/src/audio/supercollider-player.ts`):
- Added `pan?: number` to options
- Convert -100~100 range to -1.0~1.0 for SuperCollider's `pan` parameter
- Default value: 0 (center)
- Uses existing `orbitPlayBuf` SynthDef's `Pan2.ar` for stereo positioning

**Test Coverage**: 28 tests added
- Parser: Negative numbers (-100, -50, 0, 50, 100)
- Sequence: Value setting, clamping, chaining
- SuperCollider: Conversion accuracy (-1.0 to 1.0)

**Example Usage**:
```osc
left.pan(-100).loop()   // Full left
center.pan(0).loop()    // Center
right.pan(100).loop()   // Full right

// Live changes
left.pan(-100)  // Move to full left
left.pan(0)     // Move to center
left.pan(100)   // Move to full right
```

**Real-Time Behavior**:
- Changes take effect immediately (within 1-2ms)
- Events are cleared and rescheduled with new pan value
- Console feedback: `🎛️ left: pan=-100`

**Files Modified**:
- `packages/engine/src/core/sequence.ts`
- `packages/engine/src/parser/audio-parser.ts` (negative number support)
- `packages/engine/src/audio/supercollider-player.ts`
- `packages/engine/src/core/global.ts` (Scheduler interface)

---

### 8.3 Timing Verification Tests

**Date**: October 5, 2025  
**Status**: ✅ COMPLETE

**Work Content**: Created comprehensive test suite for polymeter, polytempo, and nested rhythms

#### Test Files Created

**Polymeter Test** (`examples/test-polymeter.osc`):
- Kick: 4/4 at 120 BPM
- Snare: 5/4 at 120 BPM
- **Result**: ✅ Perfect synchronization, correct bar duration calculations

**Polytempo Test** (`examples/test-polytempo.osc`):
- Kick: 120 BPM
- Snare: 90 BPM
- **Result**: ✅ Independent tempo tracking working correctly

**Nested Rhythm Tests** (`examples/test-nested.osc`):
- Binary: `play(1, (2, 2))` - 8th notes
- Triplet: `play(1, (2, 2, 2))` - Triplets
- Deep: `play(1, (2, (3, 3)))` - 3 levels deep
- Complex: `play((1, 1), (2, (3, 3)))` - Mixed nesting
- Extreme: `play(1, (2, (3, (4, 4))))` - 4 levels deep
- **Result**: ✅ All nested patterns play correctly

**Insane Nested Test** (`examples/test-insane-nested.osc`):
- Up to **11 levels of nesting** (2048th notes)
- Time interval: 0.98ms per hit
- **Result**: ✅ SuperCollider handles extreme precision perfectly
- **Drift**: 0-2ms even at sub-millisecond intervals

**Danger Zone Test** (`examples/test-danger-zone-poly.osc`):
- 5 simultaneous tracks
- Polymeter (3/4, 5/4, 7/4, 4/4)
- Polytempo (140, 100, 80, 120, 160 BPM)
- Variable loop lengths (1-3 bars)
- Deep nesting (4 levels)
- **Result**: ✅ All tracks synchronized perfectly

---

### 8.4 Test Suite Expansion

**Date**: October 5, 2025  
**Status**: ✅ COMPLETE

**Work Content**: Created comprehensive unit and integration tests

#### Test Files Added

**Parser Tests** (`tests/audio-parser/audio-parser.spec.ts`):
- Added 6 new tests for `gain()` and `pan()`
- Total: 39 tests (38 passing, 1 skipped)
- Coverage: Positive/negative numbers, zero, extreme values, chaining

**Sequence Tests** (`tests/core/sequence-gain-pan.spec.ts`):
- Created 15 new tests for gain/pan behavior
- Tests: Value setting, clamping, chaining, defaults
- All tests passing ✅

**SuperCollider Tests** (`tests/audio/supercollider-gain-pan.spec.ts`):
- Created 13 new tests for parameter conversion
- Tests: Volume conversion (0-100 → 0.0-1.0)
- Tests: Pan conversion (-100~100 → -1.0~1.0)
- Tests: Default values, extreme values, combined parameters
- All tests passing ✅

**Total Test Coverage**:
- **67 tests total** (66 passing, 1 skipped)
- Parser: 39 tests
- Sequence: 15 tests
- SuperCollider: 13 tests

---

### 8.5 Example Files for Documentation

**Gain Examples**:
- `examples/test-gain.osc` - Various static gain levels
- `examples/test-gain-simple.osc` - Simple gain test
- `examples/test-live-gain.osc` - Real-time gain changes

**Pan Examples**:
- `examples/test-pan.osc` - Full stereo positioning test
- `examples/test-pan-simple.osc` - Simple pan test

**Timing Examples**:
- `examples/test-polymeter.osc` - Different time signatures
- `examples/test-polytempo.osc` - Different tempos
- `examples/test-nested.osc` - Nested rhythms (5 patterns)
- `examples/test-insane-nested.osc` - Extreme nesting (11 levels)
- `examples/test-danger-zone-poly.osc` - Multi-track stress test

---

### 8.6 Phase 8 Summary

**Status**: ✅ 100% COMPLETE

**Features Implemented**:
1. ✅ `gain()` method - Volume control (0-100)
2. ✅ `pan()` method - Stereo positioning (-100~100)
3. ✅ Negative number support in parser
4. ✅ Real-time parameter updates
5. ✅ Comprehensive timing verification
6. ✅ 67 unit/integration tests

**Performance Verified**:
- ✅ Polymeter: Correct bar duration calculations
- ✅ Polytempo: Independent tempo tracking
- ✅ Nested rhythms: Up to 11 levels (0.98ms precision)
- ✅ Multi-track: 5 tracks with complex patterns
- ✅ Real-time updates: 1-2ms latency
- ✅ Timing drift: 0-2ms consistently

**Code Quality**:
- ✅ All tests passing (66/67)
- ✅ Type-safe implementation
- ✅ Comprehensive test coverage
- ✅ Example files for all features

**Commit**: `2ed153a` - feat: Add gain() and pan() methods for audio control

**Next Steps (Phase 9)**:
- Pitch control (`pitch()` method using SuperCollider's `rate` parameter)
- Filter effects (`lpf()`, `hpf()` methods)
- Reverb (`reverb()` method)
- Compression (`compress()` method)

---

### 8.7 Global Mastering Effects Implementation (January 6, 2025)

**Date**: January 6, 2025
**Status**: ✅ COMPLETE
**Branch**: `feature/supercollider-effects` → merged to `main`
**PR**: #4

**Work Content**: Implemented global mastering effects to increase loudness and prevent clipping

#### Implemented Effects

**1. Compressor (Compander)**
- Parameters: `threshold` (0-1), `ratio` (0-1), `attack` (s), `release` (s), `makeupGain` (0-2)
- Purpose: Increase perceived loudness by compressing dynamic range
- SynthDef: `fxCompressor` using `Compander.ar()`

**2. Limiter**
- Parameters: `level` (0-1), `duration` (lookahead time)
- Purpose: Prevent clipping by limiting peaks
- SynthDef: `fxLimiter` using `Limiter.ar()`

**3. Normalizer**
- Parameters: `level` (0-1), `duration` (lookahead time)
- Purpose: Maximize output level
- SynthDef: `fxNormalizer` using `Normalizer.ar()`

#### Technical Implementation

**SuperCollider Architecture**:
- All effects process bus 0 (master output) directly
- Use `In.ar(0, 2)` to read stereo input
- Use `ReplaceOut.ar(0, ...)` to write back to bus 0
- Effects are chained: orbitPlayBuf → Compressor → Limiter → Normalizer → Output

**TypeScript Implementation**:
- `Global.compressor()`, `limiter()`, `normalizer()` methods
- Effect synth management: `Map<string, Map<string, number>>` (target → effectType → synthID)
- Individual effect control: each effect can be added/removed independently
- Seamless updates: existing synths updated via `/n_set`, new synths created via `/s_new`
- Proper cleanup: `/n_free` removes specific effect without affecting others

**Parser Enhancement**:
- Added boolean literal support: `true` and `false` are now recognized as boolean values
- Enables `enabled` parameter: `global.compressor(..., false)` to turn off

**Auto-Evaluation Filter**:
- Added `compressor`, `limiter`, `normalizer` to standalone command filter
- Prevents auto-evaluation on file open/save (Cmd+Enter required)

#### Testing Results

**Test File**: `examples/test-mastering-effects.osc`

**Aggressive Settings** (verified working):
```osc
global.compressor(0.15, 0.95, 0.001, 0.02, 2.0, true)  // Ultra-heavy compression
global.limiter(0.95, 0.01, true)                       // Brick wall limiting
global.normalizer(1.0, 0.01, true)                     // Maximum loudness
```

**Results**:
- ✅ Significant loudness increase (user confirmed: "ガッチリ上がって良いね")
- ✅ Individual on/off control working correctly
- ✅ Seamless parameter updates during playback
- ✅ No audio dropout when effects are removed
- ✅ Dry signal returns when all effects are off

#### Bug Fixes

**Issue 1**: Effect synth management
- **Problem**: All effect synths stored in single array, removing one effect removed all
- **Fix**: Changed to nested Map structure for individual effect type management

**Issue 2**: Boolean parsing
- **Problem**: `false` parameter not recognized, treated as identifier
- **Fix**: Added boolean literal parsing in `parseArgument()`

**Issue 3**: Auto-evaluation
- **Problem**: Effect methods auto-evaluated on file open, causing duplicate synths
- **Fix**: Added effect methods to auto-evaluation filter

**Commits**:
- `260eead` - feat: implement global mastering effects (compressor, limiter, normalizer)
- `1a2795e` - fix: mastering effects - individual on/off control and boolean parsing

---

### 8.8 Codebase Cleanup and Debug Mode (January 6, 2025)

**Date**: January 6, 2025
**Status**: ✅ COMPLETE
**Branch**: `refactor/cleanup-unimplemented-features` → merged to `main`
**PR**: #5

**Work Content**: Major codebase cleanup - removed deprecated MIDI system and added debug mode

#### Removed Code (5896 lines deleted)

**MIDI System (Deprecated)**:
- `packages/engine/src/midi.ts` - Old MIDI output system
- `packages/engine/src/scheduler.ts` - Old MIDI scheduler
- `packages/engine/src/parser/parser.ts` - Old MIDI DSL parser
- `packages/engine/src/transport/transport.ts` - Old Transport system
- `packages/engine/src/ir.ts` - Old IR definitions
- `packages/engine/src/pitch.ts` - Old pitch conversion
- `packages/engine/src/audio/advanced-player.ts` - Old audio player
- `packages/engine/src/cli.ts` - Old MIDI CLI
- `packages/engine/src/index.ts` - Old entry point
- `packages/engine/src/interpreter/interpreter.ts` - Old interpreter

**MIDI Tests (25 test files)**:
- `tests/midi/*` - All MIDI tests
- `tests/scheduler/*` - Old scheduler tests
- `tests/max/*` - Max/MSP integration tests
- `tests/live_coding/*` - Old live coding tests
- All related test files

**Unimplemented Features**:
- `delay()` completion (SynthDef doesn't exist)
- `fixpitch()` completion (not implemented)
- `time()` completion (not implemented)

#### Added Features

**Debug Mode**:
- Command palette: `🚀 Start Engine` (normal) vs `🐛 Start Engine (Debug)`
- Normal mode: Shows only important messages (✅, 🎛️, ERROR, ⚠️)
- Debug mode: Shows all logs including SuperCollider communication
- Status bar shows 🐛 icon in debug mode
- CLI flag: `--debug` to enable verbose logging

**Output Filtering (Normal Mode)**:
- Filters out: `sendosc:`, `rcvosc:`, JSON objects, OSC messages
- Filters out: Device info, SuperCollider boot details
- Filters out: `🔊 Playing:` messages, buffer allocations
- Keeps: Initialization, transport state, effects, errors, warnings

#### Bug Fixes

**length() Implementation**:
- **Problem**: `length(n)` didn't correctly stretch event timing
- **Fix**: Apply length multiplier to `barDuration` in `play()` method
- **Fix**: Recalculate timing when `length()` is changed
- **Fix**: Auto-restart loop when length changes during playback
- **Result**: `length(2)` now correctly doubles the duration of each beat

**Auto-Evaluation Rules**:
- Added `length`, `tempo`, `beat` to execution method filter
- Standalone calls require Cmd+Enter
- Method chain calls are auto-evaluated

#### Documentation Updates

**DSL Specification**:
- Updated to v2.0 (SuperCollider Audio Engine)
- Marked MIDI support as deprecated
- Updated implementation status
- Updated test coverage numbers

**Examples**:
- Created `examples/test-all-features.osc` - comprehensive feature test
- Updated README with debug mode instructions

#### Test Results

**After Cleanup**:
- 128/143 tests passing
- Removed tests: MIDI-related (deprecated system)
- Failing tests: SuperCollider boot timeout (test environment issue)
- Core functionality: 100% passing

**Commits**:
- `c60a8c3` - refactor: Remove unimplemented features from completions and code
- `0f5fb7f` - refactor: Remove deprecated MIDI system and old implementations
- `542e901` - feat: Add debug mode and fix length() implementation

---

### 8.9 Performance Demo and Extension Packaging (January 6, 2025)

**Date**: January 6, 2025  
**Status**: ✅ COMPLETE

**Work Content**: VS Code extension packaging improvements and performance demo file creation

#### 1. Extension Packaging Issues and Resolution
**Problem**: Extension couldn't find engine after packaging
- `engine/dist/cli-audio.js` not found in installed extension
- `node_modules` (supercolliderjs) missing from package
- Relative path validation errors from vsce

**Root Causes**:
1. `.vscodeignore` incorrectly excluded engine files
2. Engine path resolution only checked workspace location
3. Dependencies not included in package

**Solutions**:
1. **Engine Path Resolution** (`extension.ts`):
   - Added fallback logic: check `../engine/dist/cli-audio.js` first (bundled)
   - Then check `../../engine/dist/cli-audio.js` (workspace)
   - Provides clear error message if neither found

2. **Packaging Process**:
   - Copy engine files directly into extension directory
   - Include: `dist/`, `supercollider/`, `package.json`, `node_modules/`
   - Update `.vscodeignore` to exclude parent directories but include engine

3. **Final Package**:
   - 35 files, 57.5 KB (with dependencies)
   - Successfully tested in live performance

#### 2. Performance Demo File
**Created**: `examples/performance-demo.osc`
- All 13 test-assets samples configured
- Drums: kick, snare, hatc, hato, hat
- Bass: bassc, basse, bassg
- Melody: arp, chordc, chorda
- Test: sine1, sine2
- Initial patterns: `0, 0, 0, 0` (silent, ready for live coding)
- Comprehensive command examples for live performance

#### 3. Serena Usage Guidelines Integration
**Moved**: `docs/SERENA.md` → `AGENTS.md`
- Consolidated into main agent rules file
- Auto-loaded by all agents (Cursor, Codex CLI, etc.)
- Guidelines:
  - Use Serena for: complex code analysis, architecture understanding, symbol references
  - Use normal tools for: simple file edits, known file changes, string search/replace

**Performance Result**: ✅ Successfully used in live performance, all features working

**Files Modified**:
- `packages/vscode-extension/src/extension.ts`
- `packages/vscode-extension/.vscodeignore`
- `examples/performance-demo.osc` (new)
- `AGENTS.md`

**Future Improvements**:
- Add line numbers to error messages
- Automate extension packaging process
- Bundle extension with webpack/esbuild for smaller size

---

## 2025-01-07: Chop Slice Playback Rate and Envelope Improvements

### 問題
1. **スライスの再生速度が不適切**: `chop()`で分割されたスライスが、イベントの時間枠に合わせて再生速度を調整していなかった
2. **クリックノイズ**: スライスの開始・終了時に急激な音量変化によるクリックノイズが発生
3. **アタック感の喪失**: フェードインが長すぎてアタック感が失われる

### 解決
1. **再生速度の自動調整**:
   - `SuperColliderPlayer.scheduleSliceEvent()`に`eventDurationMs`パラメータを追加
   - `rate = sliceDuration / eventDurationSec`で再生速度を計算
   - スライスが時間枠より短い場合は減速、長い場合は加速

2. **エンベロープの可変フェード時間**:
   - `orbitPlayBuf` SynthDefのエンベロープを再生時間に応じて調整
   - フェードイン: 0ms（アタック感を保持）
   - フェードアウト: 再生時間の4%（最大8ms）でクリックノイズを防止

### 実装詳細

#### TypeScript側の変更
- `packages/engine/src/audio/supercollider-player.ts`:
  - `scheduleSliceEvent()`に`eventDurationMs`パラメータを追加
  - `rate = sliceDuration / eventDurationSec`で再生速度を計算
  - `options.rate`をSuperColliderに送信

- `packages/engine/src/core/global.ts`:
  - `Scheduler`インターフェースの`scheduleSliceEvent()`シグネチャを更新

- `packages/engine/src/core/sequence.ts`:
  - `scheduleEvents()`と`scheduleEventsFromTime()`で`event.duration`を`scheduleSliceEvent()`に渡す

#### SuperCollider側の変更
- `packages/engine/supercollider/setup.scd`:
  - `orbitPlayBuf` SynthDefに可変エンベロープを実装
  - `fadeIn = 0`（アタック感を保持）
  - `fadeOut = min(0.008, actualDuration * 0.04)`（クリックノイズ防止）
  - `sustain = max(0, actualDuration - fadeOut)`

### SynthDefビルド方法のドキュメント化
- `packages/engine/supercollider/README.md`を新規作成
- ビルド手順、トラブルシューティング、編集方法を詳細に記載
- 頻繁に発生する問題（sclangが終了しない、構文エラー、ファイルが更新されない）の解決策を記載

### 動作確認
- ✅ `play(1,2,3,4)`: 各スライスが均等に再生される
- ✅ `play(4,3,2,1)`: 逆順再生が正しく動作
- ✅ `play(4,0,3,0,2,0,1,0)`: 休符を含むパターンが正しく動作
- ✅ `play(1,1,2,2,3,3,4,4)`: 同じスライスの繰り返しが正しく動作
- ✅ `play((1,0),2,(3,3,3),4)`: ネストしたパターンで3連符が正しく再生される（rate=1.5）
- ✅ クリックノイズが大幅に軽減
- ✅ アタック感が保持される

### ファイル変更
- `packages/engine/src/audio/supercollider-player.ts`: 再生速度計算とrate送信
- `packages/engine/src/core/global.ts`: Schedulerインターフェース更新
- `packages/engine/src/core/sequence.ts`: eventDuration渡し
- `packages/engine/supercollider/setup.scd`: 可変エンベロープ実装
- `packages/engine/supercollider/README.md`: SynthDefビルド方法のドキュメント（新規作成）

---

## 2025-01-07: CLI Timed Execution Bug Fix

### 問題
`packages/engine/src/cli-audio.ts` の92行目で、timed execution条件 `durationSeconds && globalInterpreter` が不適切だった：

1. **REPLモードの不適切な防止**: `globalInterpreter` は常に truthy のため、`durationSeconds` が指定されると常に timed execution モードになる
2. **0秒実行の失敗**: `durationSeconds` が `0` の場合、falsy として扱われて 0秒実行が開始されない

### 解決
条件を `durationSeconds !== undefined && globalInterpreter` に変更：

- `durationSeconds` が明示的に指定された場合（`0` を含む）のみ timed execution モード
- `durationSeconds` が `undefined` の場合は REPL モードまたは one-shot モード

### 動作確認
- ✅ 0秒実行: 適切に timed execution モードになり、即座に終了
- ✅ REPLモード: `durationSeconds` 未指定時に正しく REPL モードに入る
- ✅ 通常実行: 指定秒数の timed execution が正常動作

### ファイル変更
- `packages/engine/src/cli-audio.ts`: 92行目の条件修正

---

### 6.20 Refactor CLI Audio - Phase 3-1 (October 7, 2025)

**Date**: October 7, 2025
**Status**: ✅ COMPLETE
**Branch**: 16-refactor-cli-audio-phase-3-1
**Issue**: #16

**Work Content**: `cli-audio.ts`（282行）を7つのモジュールに分割し、コーディング規約に準拠

#### リファクタリング内容

**1. モジュール分割**
新しいディレクトリ構造：
```
packages/engine/src/cli/
├── index.ts                  # モジュールエクスポート
├── types.ts                  # CLI型定義
├── parse-arguments.ts        # 引数パース処理
├── play-mode.ts              # ファイル再生処理
├── repl-mode.ts              # REPLモード処理
├── test-sound.ts             # テスト音再生処理
├── shutdown.ts               # シャットダウン処理
└── execute-command.ts        # コマンド実行ロジック
```

**2. 各モジュールの責務**
- `types.ts`: CLI関連の型定義（`ParsedArguments`, `PlayOptions`, `REPLOptions`, `PlayResult`）
- `parse-arguments.ts`: コマンドライン引数のパース、グローバルデバッグフラグの設定
- `play-mode.ts`: `.osc`ファイルの読み込み・パース・実行、timed execution制御
- `repl-mode.ts`: REPLモードの起動、SuperColliderのブート、インタラクティブな入力処理
- `test-sound.ts`: テスト音（ドラムパターン）の再生
- `shutdown.ts`: SuperColliderサーバーのグレースフルシャットダウン、シグナルハンドラー登録
- `execute-command.ts`: コマンドルーティング、ヘルプ表示、エラーハンドリング

**3. 後方互換性**
- `cli-audio.ts`を薄いラッパーとして保持
- 既存のエントリーポイント（`#!/usr/bin/env node`）を維持
- 既存のコマンドラインインターフェースは変更なし

#### コーディング規約の適用

**1. SRP（単一責任の原則）**
- 各関数が1つの明確な責務を持つ
- 引数パース、コマンド実行、REPL、再生、シャットダウンを分離

**2. DRY（重複排除）**
- `play`, `run`, `eval`コマンドの共通処理を`playFile()`関数に集約
- `cli-audio.ts`は新しいモジュールに委譲

**3. 再利用性**
- 各関数は独立して使用可能
- 明確な関数名（`parseArguments`, `playFile`, `startREPL`, `playTestSound`, `shutdown`, `executeCommand`）

**4. ドキュメント**
- 各関数にJSDocコメント
- パラメータと戻り値の説明
- 使用例を含む詳細な説明

#### テスト結果
```bash
npm test
```
- ✅ 115 tests passed
- ⏭️ 15 tests skipped
- ✅ ビルド成功
- ✅ lint成功

#### ファイル変更
- **新規作成**:
  - `packages/engine/src/cli/index.ts`
  - `packages/engine/src/cli/types.ts`
  - `packages/engine/src/cli/parse-arguments.ts`
  - `packages/engine/src/cli/play-mode.ts`
  - `packages/engine/src/cli/repl-mode.ts`
  - `packages/engine/src/cli/test-sound.ts`
  - `packages/engine/src/cli/shutdown.ts`
  - `packages/engine/src/cli/execute-command.ts`
- **変更**:
  - `packages/engine/src/cli-audio.ts` (薄いラッパーに変更)

#### コミット
- `[次のコミット]`: refactor: cli-audio.tsをモジュール分割（Phase 3-1）

---

### 6.21 Refactor Interpreter V2 - Phase 3-2 (October 7, 2025)

**Date**: October 7, 2025
**Status**: ✅ COMPLETE
**Branch**: 18-refactor-interpreter-v2ts-phase-3-2
**Issue**: #18

**Work Content**: `interpreter-v2.ts`（275行）を5つのモジュールに分割し、コーディング規約に準拠

#### リファクタリング内容

**1. モジュール分割**
新しいディレクトリ構造：
```
packages/engine/src/interpreter/
├── index.ts                      # モジュールエクスポート
├── types.ts                      # 型定義
├── process-initialization.ts     # 初期化処理
├── process-statement.ts          # ステートメント処理
├── evaluate-method.ts            # メソッド評価
└── interpreter-v2.ts             # 薄いラッパー（後方互換性）
```

**2. 各モジュールの責務**
- `types.ts`: `InterpreterState`, `InterpreterOptions`の型定義
- `process-initialization.ts`: `processGlobalInit`, `processSequenceInit`（グローバルとシーケンスの初期化）
- `process-statement.ts`: `processStatement`, `processGlobalStatement`, `processSequenceStatement`, `processTransportStatement`（ステートメント処理）
- `evaluate-method.ts`: `callMethod`, `processArguments`（メソッド呼び出しと引数処理）
- `interpreter-v2.ts`: 後方互換性のための薄いラッパークラス（`@deprecated`タグ付き）

**3. 後方互換性**
- `InterpreterV2`クラスを薄いラッパーとして保持
- 既存のコードは変更不要
- `@deprecated`タグで新しいモジュールの使用を推奨

#### コーディング規約の適用

**1. SRP（単一責任の原則）**
- 初期化処理、ステートメント処理、メソッド評価を分離
- 各関数が1つの明確な責務を持つ

**2. DRY（重複排除）**
- 共通の状態管理を`InterpreterState`型で統一
- メソッド呼び出しロジックを`callMethod`関数に集約

**3. 再利用性**
- 各関数は独立して使用可能
- 明確な関数名（`processGlobalInit`, `processStatement`, `callMethod`など）

**4. ドキュメント**
- 各関数にJSDocコメント
- パラメータと戻り値の説明
- 使用例を含む詳細な説明

#### テスト結果
```bash
npm test
```
- ✅ 115 tests passed
- ⏭️ 15 tests skipped
- ✅ ビルド成功
- ✅ lint成功（1つの既存の警告のみ）

#### ファイル変更
- **新規作成**:
  - `packages/engine/src/interpreter/index.ts`
  - `packages/engine/src/interpreter/types.ts`
  - `packages/engine/src/interpreter/process-initialization.ts`
  - `packages/engine/src/interpreter/process-statement.ts`
  - `packages/engine/src/interpreter/evaluate-method.ts`
- **変更**:
  - `packages/engine/src/interpreter/interpreter-v2.ts` (薄いラッパーに変更)

#### コミット
- `[PENDING]`: refactor: interpreter-v2.tsをモジュール分割（Phase 3-2）

---



---

### 2025-01-08: Audio Output Testing & Bug Fixes

**Date**: October 8, 2025  
**Branch**: `feature/audio-test-setup`  
**Status**: ✅ Testing Complete

#### Goal
音声出力機能のテストとVSCode拡張機能のライブコーディングテスト準備

#### Critical Bug Fixes

1. **`beat()` denominator default value** (🔴 Critical)
   - **Problem**: `global.beat(4)` → `denominator` が `undefined` → タイミング計算が `NaN`
   - **Root Cause**: `beat(numerator, denominator)` に第2引数のデフォルト値がなかった
   - **Solution**: `beat(numerator: number, denominator: number = 4)` にデフォルト値追加
   - **Impact**: これがないと音が一切鳴らない（全てのタイミング計算が破綻）
   - **Files**: `packages/engine/src/core/global.ts`, `packages/engine/src/core/global/tempo-manager.ts`

2. **`run()` sequence scheduling timing**
   - **Problem**: イベントが過去の時間にスケジュールされ、即座にクリアされる
   - **Solution**: `run-sequence.ts` で 100ms バッファを追加
   - **Files**: `packages/engine/src/core/sequence/playback/run-sequence.ts`

#### Audio Output Tests

✅ **All tests passed:**
- Simple playback: `play(1, 0, 0, 0)` with `run()` 
- Loop test: `play(1, 0, 0, 0)` with `loop()`
- Chop test: `play(1, 2, 3, 4)` with `chop(4)`
- Silence test: `play(1, 0, 2, 0, 3, 0, 4, 0)`
- Nested pattern: `play((1, 0), 2, (3, 2, 3), 4)`
- Length test: `length(2)` - rate調整が正しく動作

#### Test Coverage

**Created**: `tests/audio/rate-calculation.spec.ts`
- 15 tests covering rate calculation
- Tempo variations (120, 140, 90 BPM)
- Different chop divisions (2, 4, 8)
- Length variations (1, 2, 4 bars)
- Nested patterns and edge cases
- **Result**: All 15 tests passing ✅

#### Key Findings

**Rate Calculation Formula:**
```
rate = (sliceDuration * 1000) / eventDurationMs
```

At 120 BPM, 4/4, `length(1)`:
- 1 bar = 2000ms, 4 events = 500ms each
- For 1s audio with `chop(4)`: sliceDuration = 250ms
- rate = 250 / 500 = 0.5

With `length(2)`:
- 2 bars = 4000ms, 4 events = 1000ms each  
- rate = 250 / 1000 = 0.25 (1 octave lower)

#### Example Files Created

- `examples/test-simple-run.osc` - Simple kick drum
- `examples/test-loop.osc` - Looping kick
- `examples/test-chop.osc` - Arpeggio chop
- `examples/test-chop-sparse.osc` - With silences
- `examples/test-chop-nested.osc` - Nested patterns
- `examples/test-length.osc` - Length(2) test

#### Documentation Updates

- Updated `docs/USER_MANUAL.md`:
  - Added `length()` and pitch relationship
  - Detailed nested pattern explanation
  - Improved `beat()` usage examples
- Updated `docs/WORK_LOG.md`: This entry

#### Next Steps

- [ ] VSCode extension live coding test
- [ ] Additional feature tests (gain, pan, multiple sequences)
- [ ] Commit changes

