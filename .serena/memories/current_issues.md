# Current Issues

## ✅ RESOLVED: Phase 6 Live Coding Workflow Issues

### All Critical Issues Fixed (January 13, 2025)

All three critical scheduler issues have been successfully resolved:

#### Issue 1: Scheduler Auto-Stop (RESOLVED ✅)
**Root Cause**: `AdvancedAudioPlayer.startScheduler()` had an auto-stop mechanism that stopped the scheduler 1 second after the event queue became empty. This was incompatible with live coding where new events are continuously added.

**Fix**: Removed auto-stop logic (lines 302-305 in `advanced-player.ts`). Scheduler now runs continuously from `global.run()` until `global.stop()` is explicitly called.

**Files Modified**: `packages/engine/src/audio/advanced-player.ts`

#### Issue 2: Double Offset in Loop Scheduling (RESOLVED ✅)
**Root Cause**: `Sequence.loop()` was passing `loopIteration` to `scheduleEvents()`, which then calculated `loopOffset = loopIteration * patternDuration`. This caused events to be scheduled at double the intended time (e.g., iteration 1 scheduled at 4000ms instead of 2000ms).

**Fix**: Changed `scheduleEvents()` calls in `loop()` to always use `loopIteration=0`, since `baseTime` (from `nextScheduleTime`) already contains the correct absolute time.

**Files Modified**: `packages/engine/src/core/sequence.ts`

#### Issue 3: Instance Recreation on File Save (RESOLVED ✅)
**Root Cause**: 
1. `var` declarations were being re-evaluated on file save, creating new `Global` and `Sequence` instances
2. Old instances' loop timers remained active, causing sound to play from "ghost" instances
3. `InterpreterV2` was creating new instances instead of reusing existing ones

**Fixes**:
1. Modified `extension.ts` to filter out `var` declarations on re-evaluation (`first: false`)
2. Modified `interpreter-v2.ts` to reuse existing `Global` and `Sequence` instances
3. Modified `cli-audio.ts` to reuse `globalInterpreter` instance in REPL mode

**Files Modified**: 
- `packages/vscode-extension/src/extension.ts`
- `packages/engine/src/interpreter/interpreter-v2.ts`
- `packages/engine/src/cli-audio.ts`

### Additional Improvements

#### UI/UX Enhancements
- ✅ Status bar renamed: `Engine: X` → `OrbitScore: X` for clarity
- ✅ Comment syntax fixed: `#` → `//` for TypeScript compatibility
- ✅ Version info displayed on activation (build time, path)
- ✅ Debug logging added to scheduler lifecycle

#### Engine Improvements
- ✅ Added `repl` command to `cli-audio.js`
- ✅ Fixed `global.run()` idempotency (prevents double-start)
- ✅ Removed unnecessary `stopAll()` call in `global.run()`

## 🟢 Current Status: All Systems Operational

### Verified Working ✅
1. **Engine Management**
   - ✅ Manual start/stop via status bar
   - ✅ Status indicators: Stopped / Ready / Playing

2. **File Evaluation**
   - ✅ Definitions evaluated on save
   - ✅ Execution commands filtered out
   - ✅ Instance reuse on re-evaluation

3. **Live Coding Workflow**
   - ✅ `global.run()` - starts scheduler
   - ✅ `kick.loop()` - accurate timing, continuous loop
   - ✅ `kick.stop()` - stops individual sequence
   - ✅ `global.stop()` - stops all sequences and scheduler

4. **Timing Accuracy**
   - ✅ No drift in loop iterations
   - ✅ Events scheduled at correct absolute times
   - ✅ All loop iterations play reliably

## 📝 Next Steps

### Phase 6 Completion
- [ ] Remove debug logging (clean up production code)
- [ ] Test multiple simultaneous sequences (kick + snare + hihat)
- [ ] Performance testing with complex patterns
- [ ] Update documentation

### Phase 7: Advanced Features (Next)
- [ ] Time-stretching with sox
- [ ] Pitch-shifting
- [ ] Real-time effects
- [ ] Pattern transformations

## 🎯 No Active Issues

All critical bugs have been resolved. System is ready for live performance testing and Phase 6 completion.