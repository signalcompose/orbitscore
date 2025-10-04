# Current Critical Issues

## 🔴 Critical: Scheduler Lifecycle & Event Management Issues

### Issue 1: `global.stop()` Not Fully Stopping Audio
**Status**: CRITICAL - Live coding workflow broken  
**Reported**: Multiple times by user  
**Symptom**: 
- After `global.stop()`, status bar shows "⏸️ Ready"
- But `kick.loop()` still plays audio
- Pattern is distorted: plays as `(1,0,1,0,0,0,0,0)` instead of `(1,0,1,0)`

**Root Cause (Suspected)**:
- Events are accumulating in the scheduler
- `AdvancedAudioPlayer.stopAll()` may not be clearing all scheduled events
- Loop timers (`setInterval`) may not be properly cleared in `Sequence.stop()`

**Files Involved**:
- `packages/engine/src/audio/advanced-player.ts` - Scheduler and event management
- `packages/engine/src/core/sequence.ts` - Loop management
- `packages/engine/src/core/global.ts` - Global stop implementation

### Issue 2: `kick.stop()` Not Functioning
**Status**: CRITICAL  
**Symptom**: Individual sequence `.stop()` method has no effect

**Root Cause (Suspected)**:
- Loop timer not being cleared properly
- Event queue not being flushed for specific sequences

### Issue 3: Inaccurate Rhythm / Extended Patterns
**Status**: CRITICAL - Makes live performance impossible  
**Symptom**: 
- Patterns play with incorrect timing ("間伸びしてる" - stretched out)
- Pattern appears to extend with zeros: `(1,0,1,0) → (1,0,1,0,0,0,0,0)`

**Root Cause (Suspected)**:
- Event timing calculation in `Sequence.scheduleEvents()` may be incorrect
- `baseTime` calculation in `loop()` may accumulate errors
- Events from previous loops not being cleared before scheduling new ones

## 🔧 Attempted Fixes (Not Yet Resolved)

### Previous Fix Attempts:
1. ✅ Modified `sequence.loop()` to call `stop()` first to clear old events
2. ✅ Modified `global.stop()` to call `globalScheduler.stopAll()` and stop all sequences
3. ✅ Modified `global.run()` to call `stopAll()` before starting
4. ✅ Added scheduler restart logic in `scheduleEvent()` if stopped
5. ❌ **STILL NOT WORKING** - Core issue remains unresolved

### Root Problem:
The scheduler's event management and lifecycle needs fundamental review:
- How events are queued
- How they are cleared
- How loop timers interact with the scheduler
- How `stop()` propagates through the system

## 📋 Debug Strategy Needed

1. Add comprehensive logging to track:
   - Event queue state before/after operations
   - Loop timer lifecycle
   - Scheduler state transitions

2. Verify event clearing logic:
   - Are all events properly removed on `stop()`?
   - Are loop timers (`setInterval`) properly cleared?

3. Test timing calculation:
   - Is `baseTime` calculated correctly in loops?
   - Are events scheduled at correct absolute times?

## 🎯 Priority Actions

1. **IMMEDIATE**: Fix scheduler event management
2. **HIGH**: Ensure `stop()` methods work reliably
3. **HIGH**: Fix rhythm accuracy for live performance

## 📝 Notes

- User explicitly requested to keep command palette engine start/stop for debugging due to these issues
- Live coding workflow depends on reliable start/stop functionality
- This is blocking Phase 4 completion and live performance testing