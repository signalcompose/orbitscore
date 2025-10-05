# OrbitScore - Current Issues

**Last Updated:** 2025-01-05

## Status: ✅ ALL CRITICAL ISSUES RESOLVED

### Previously Critical Issues (NOW RESOLVED)

#### 1. ✅ RESOLVED: Snare Pattern Bug - Incorrect Playback
**Status:** Fixed  
**Issue:** `snare.play(0, 1, 0, 1)` was not playing correctly in the expected pattern.

**Root Cause:**
- `scheduledPlays` array was only sorted once at `startScheduler()` initialization
- In live coding mode, new events added via `loop()` were not re-sorted
- This caused events to execute out of chronological order
- snare events scheduled at 500ms were delayed by 500ms, playing at the same time as kick events

**Fix:**
- Added `this.scheduledPlays.sort((a, b) => a.time - b.time)` after every `playAudio()` call
- Files modified: `packages/engine/src/audio/advanced-player.ts`

**Result:** All sequences now play with perfect timing (0-3ms drift)

#### 2. ✅ RESOLVED: Auto-Start Scheduler Issue
**Status:** Fixed  
**Issue:** Calling `sequence.loop()` would automatically start the scheduler, even without `global.run()`.

**Fix:**
- Removed auto-start logic from `scheduleEvent()` and `scheduleSliceEvent()`
- Added scheduler running checks to `sequence.run()` and `sequence.loop()`
- Now displays warning: `⚠️ kick.loop() - scheduler not running. Use global.run() first.`
- Files modified: `packages/engine/src/audio/advanced-player.ts`, `packages/engine/src/core/sequence.ts`

**Result:** Users must explicitly call `global.run()` before sequences will play

#### 3. ✅ RESOLVED: Live Sequence Addition
**Status:** Fixed  
**Issue:** Adding new sequences during live coding required engine restart.

**Fix:**
- Removed `var` declaration filtering during re-evaluation in `filterDefinitionsOnly()`
- `InterpreterV2` already handles instance reuse via `processGlobalInit()` and `processSequenceInit()`
- Files modified: `packages/vscode-extension/src/extension.ts`

**Result:** New sequences can be added by saving file, no restart needed

---

## Known Limitations (Not Bugs)

1. **Loop Start Timing:** Sequences start immediately when `loop()` is called, not quantized to bar boundaries
   - This is acceptable for initial implementation
   - Future enhancement: Add optional quantization parameter

2. **No Visual Feedback for Playing State:** Status bar shows "Playing" for global state only
   - Individual sequence states not displayed
   - Future enhancement: Add sequence-specific indicators

---

## Next Steps

1. Performance testing with complex patterns
2. Loop start quantization (optional feature)
3. Documentation updates
4. User testing and feedback collection
