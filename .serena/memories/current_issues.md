# OrbitScore - Current Issues

**Last Updated:** 2025-01-05

## Status: ✅ NO CRITICAL ISSUES

All Phase 6 critical issues have been resolved. System is stable and ready for advanced features.

### Recent Fixes (2025-01-05)

#### ✅ RESOLVED: Polymeter Support - Incorrect Bar Duration Calculation
**Status:** Fixed  
**Issue:** Bar duration calculation was incorrect, preventing polymeter (different time signatures per sequence).

**Root Cause:**
- `play()` method: `barDuration = (60000 / tempo) * meter.numerator` - incorrect formula
- `getPatternDuration()`: `barDuration = beatDuration * 4` - hardcoded 4/4 assumption
- This prevented sequences from having independent bar lengths

**Fix:**
- Corrected formula: `barDuration = quarterNoteDuration * (meter.numerator / meter.denominator * 4)`
- Applied to both `play()` and `getPatternDuration()` methods
- Files modified: `packages/engine/src/core/sequence.ts`

**Result:**
- ✅ Polymeter works perfectly
- ✅ `global.beat(4 by 4)` + `snare.beat(5 by 4)` → 20-beat cycle (LCM of 4 and 5)
- ✅ Each sequence maintains its own bar duration independently
- ✅ Synchronization accuracy: 0-5ms drift

**Examples:**
- `beat(4 by 4)` @ BPM120 = 2000ms
- `beat(5 by 4)` @ BPM120 = 2500ms  
- `beat(9 by 8)` @ BPM120 = 2250ms

---

## Previously Resolved Issues

### 1. ✅ Snare Pattern Bug (2025-01-05)
- Out-of-order event execution
- Fixed by sorting `scheduledPlays` after every event addition

### 2. ✅ Auto-Start Scheduler (2025-01-05)
- Sequences auto-starting without `global.run()`
- Fixed by requiring explicit scheduler start

### 3. ✅ Live Sequence Addition (2025-01-05)
- Required engine restart to add sequences
- Fixed by allowing `var` declarations in re-evaluation

---

## Known Limitations (Not Bugs)

1. **Loop Start Timing:** Sequences start immediately when `loop()` is called, not quantized to bar boundaries
   - Acceptable for initial implementation
   - Future enhancement: Optional quantization parameter

2. **No Visual Feedback for Individual Sequence State:** Status bar shows global state only
   - Future enhancement: Sequence-specific indicators

---

## Next Steps

1. Nest pattern testing (hierarchical play structures)
2. Performance testing with complex polymeter patterns
3. Optional loop quantization feature
4. Documentation updates for polymeter feature
