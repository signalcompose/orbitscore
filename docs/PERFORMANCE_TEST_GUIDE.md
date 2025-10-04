# OrbitScore VS Code Live Coding Performance Test Guide

## Overview

This guide provides step-by-step instructions for testing OrbitScore's VS Code extension live coding capabilities using the `examples/performance-test.osc` file.

## Prerequisites

1. **VS Code Extension Installed**: The OrbitScore extension should be installed and active
2. **Audio Files Available**: Ensure test audio files exist in `test-assets/audio/`
3. **Engine Built**: The OrbitScore engine should be compiled and ready

## Test Setup

### 1. Open the Performance Test File
- Open `examples/performance-test.osc` in VS Code
- Ensure the file is recognized as OrbitScore language (`.osc` extension)

### 2. Verify Extension Functionality
- Check that syntax highlighting is working
- Verify autocomplete works (type `global.` and see suggestions)
- Confirm Cmd+Enter keybinding is registered

### 3. Check Audio Assets
Verify these files exist:
- `test-assets/audio/kick.wav`
- `test-assets/audio/hihat.wav`
- `test-assets/audio/snare.wav`
- `test-assets/audio/bass.wav`
- `test-assets/audio/arpeggio.wav`

## Test Execution Steps

### Phase 1: Basic Functionality Test

#### Step 1: Global Initialization
1. Select lines 5-8 (global initialization)
2. Press **Cmd+Enter**
3. **Expected**: No errors, global context created
4. **Check**: Output panel shows "Code executed successfully"

#### Step 2: Kick Drum Pattern
1. Select lines 12-19 (kick drum setup)
2. Press **Cmd+Enter**
3. **Expected**: Kick drum starts playing 4-on-the-floor pattern
4. **Check**: Audio plays at 120 BPM, kick on beats 1 and 3

#### Step 3: Add Hi-Hat
1. Select lines 24-30 (hi-hat setup)
2. Press **Cmd+Enter**
3. **Expected**: Hi-hat joins kick drum with 16th note pattern
4. **Check**: Both kick and hi-hat play simultaneously

#### Step 4: Add Snare
1. Select lines 35-41 (snare setup)
2. Press **Cmd+Enter**
3. **Expected**: Snare adds to the rhythm on beats 2 and 4
4. **Check**: Full drum kit sound with kick, hi-hat, and snare

### Phase 2: Advanced Features Test

#### Step 5: Bassline with Chop
1. Select lines 46-52 (bassline setup)
2. Press **Cmd+Enter**
3. **Expected**: Bassline plays with sliced audio
4. **Check**: Bass plays different slices creating melodic pattern

#### Step 6: Complex Nested Pattern
1. Select lines 57-63 (arpeggio setup)
2. Press **Cmd+Enter**
3. **Expected**: Arpeggio plays complex nested rhythm
4. **Check**: Timing is accurate despite complex nesting

### Phase 3: Real-Time Manipulation Test

#### Step 7: Tempo Change
1. Select lines 68-69 (tempo change)
2. Press **Cmd+Enter**
3. **Expected**: All sequences speed up to 140 BPM
4. **Check**: No audio dropouts, smooth tempo transition

#### Step 8: Pattern Modification
1. Select lines 74-75 (kick pattern change)
2. Press **Cmd+Enter**
3. **Expected**: Kick pattern changes to breakbeat style
4. **Check**: Change takes effect on next bar boundary

#### Step 9: Slice Reordering
1. Select lines 80-82 (bassline slice reorder)
2. Press **Cmd+Enter**
3. **Expected**: Bassline plays slices in reverse order
4. **Check**: Melodic pattern changes immediately

### Phase 4: Transport Control Test

#### Step 10: Individual Muting
1. Select lines 87-88 (mute hi-hat and snare)
2. Press **Cmd+Enter**
3. **Expected**: Only kick and bass continue playing
4. **Check**: Muted sequences stop, others continue

#### Step 11: Unmute and Modify
1. Select lines 93-95 (unmute and change hi-hat)
2. Press **Cmd+Enter**
3. **Expected**: Hi-hat returns with new pattern
4. **Check**: Hi-hat plays quarter note pattern

### Phase 5: Complex Pattern Test

#### Step 12: Nested Structure
1. Select lines 100-106 (complex nested pattern)
2. Press **Cmd+Enter**
3. **Expected**: Complex timing pattern plays correctly
4. **Check**: Hierarchical timing is accurate

#### Step 13: Different Meter
1. Select lines 111-117 (5/4 meter test)
2. Press **Cmd+Enter**
3. **Expected**: Quintuple meter plays alongside 4/4
4. **Check**: Polymeter works correctly

#### Step 14: Polymeter Test
1. Select lines 122-128 (7/8 meter test)
2. Press **Cmd+Enter**
3. **Expected**: Three different meters play simultaneously
4. **Check**: All sequences maintain their own timing

### Phase 6: Performance Test

#### Step 15: Method Chaining
1. Select lines 133 (method chaining test)
2. Press **Cmd+Enter**
3. **Expected**: Single line creates and runs sequence
4. **Check**: Fluent API works correctly

#### Step 16: Error Handling
1. Select lines 138-142 (intentional error)
2. Press **Cmd+Enter**
3. **Expected**: Error message displayed, other sequences continue
4. **Check**: System remains stable after error

#### Step 17: Multiple Sequences
1. Select lines 147-152 (performance test)
2. Press **Cmd+Enter**
3. **Expected**: Four sequences play simultaneously
4. **Check**: CPU usage remains reasonable, no audio dropouts

### Phase 7: Transport System Test

#### Step 18: Stop All
1. Select lines 157-158 (stop all sequences)
2. Press **Cmd+Enter**
3. **Expected**: All audio stops immediately
4. **Check**: Clean stop, no hanging processes

#### Step 19: Restart
1. Select lines 163-164 (restart with new tempo)
2. Press **Cmd+Enter**
3. **Expected**: All sequences restart at 100 BPM
4. **Check**: Clean restart, new tempo applied

#### Step 20: Loop Mode
1. Select lines 169-170 (enable loop mode)
2. Press **Cmd+Enter**
3. **Expected**: Sequences loop continuously
4. **Check**: Seamless looping without gaps

## Performance Metrics to Monitor

### Audio Quality
- **Latency**: Time between Cmd+Enter and audio start
- **Dropouts**: Any audio interruptions or glitches
- **Synchronization**: All sequences stay in time
- **Quality**: Audio clarity and fidelity

### System Performance
- **CPU Usage**: Monitor during complex patterns
- **Memory Usage**: Check for memory leaks
- **Response Time**: Cmd+Enter execution speed
- **Stability**: No crashes or freezes

### User Experience
- **Visual Feedback**: Status messages and error reporting
- **Autocomplete**: Speed and accuracy of suggestions
- **Syntax Highlighting**: Real-time error detection
- **Workflow**: Smooth live coding experience

## Expected Results

### Successful Test Indicators
- ✅ All steps execute without errors
- ✅ Audio plays immediately after Cmd+Enter
- ✅ Real-time changes take effect smoothly
- ✅ Multiple sequences play simultaneously
- ✅ Complex patterns maintain accurate timing
- ✅ Error handling works gracefully
- ✅ Transport controls function correctly

### Performance Benchmarks
- **Latency**: < 100ms from Cmd+Enter to audio
- **CPU Usage**: < 30% during complex patterns
- **Memory**: Stable, no leaks during extended use
- **Synchronization**: < 10ms drift between sequences

## Troubleshooting

### Common Issues

#### No Audio Output
- Check audio file paths are correct
- Verify audio files exist and are valid
- Check system audio settings
- Ensure engine process is running

#### Cmd+Enter Not Working
- Verify extension is installed and active
- Check keybinding is registered
- Ensure file has `.osc` extension
- Check VS Code language mode

#### Performance Issues
- Monitor CPU usage during tests
- Check for memory leaks
- Verify audio buffer sizes
- Test with fewer simultaneous sequences

#### Timing Issues
- Check tempo settings
- Verify meter calculations
- Monitor sequence synchronization
- Test with simpler patterns first

## Test Report Template

After completing all tests, document results in `docs/PERFORMANCE_TEST_REPORT.md`:

```markdown
# Performance Test Report

## Test Date: [DATE]
## Tester: [NAME]
## Environment: [OS, VS Code Version, etc.]

### Test Results Summary
- [ ] All basic functionality tests passed
- [ ] Real-time manipulation works
- [ ] Complex patterns play correctly
- [ ] Performance is acceptable
- [ ] Error handling works

### Performance Metrics
- Average Latency: [X]ms
- Peak CPU Usage: [X]%
- Memory Usage: [X]MB
- Synchronization Accuracy: [X]ms

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommendations
1. [Improvement suggestion]
2. [Improvement suggestion]
```

## Next Steps

After completing the performance test:

1. **Document Results**: Create detailed test report
2. **Identify Issues**: List any problems found
3. **Prioritize Fixes**: Rank issues by severity
4. **Plan Improvements**: Create roadmap for enhancements
5. **Share Feedback**: Report findings to development team

---

*This guide should be updated as new features are added to OrbitScore.*