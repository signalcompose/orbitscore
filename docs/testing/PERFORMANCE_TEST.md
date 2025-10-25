# OrbitScore Performance Testing

**Last Updated**: 2025-10-26
**Test Environment**: macOS, Node.js v22+, VS Code / Cursor / Claude Code

## 📚 Overview

This document provides procedures for performance testing OrbitScore's live coding capabilities in IDE environments (VS Code, Cursor, Claude Code). Tests verify audio quality, system performance, and user experience.

## 🎯 Prerequisites

### System Requirements
- Node.js v22.0.0+
- SuperCollider (audio engine)
- VS Code / Cursor / Claude Code
- Audio device (speakers or headphones)

### Setup
1. **Build the engine**:
```bash
cd packages/engine
npm install
npm run build
```

2. **Install VS Code extension**:
```bash
code --install-extension packages/vscode-extension/orbitscore-0.0.1.vsix
```

3. **Verify audio files**:
```bash
ls -la test-assets/audio/
# Required: kick.wav, snare.wav, hihat.wav, bass.wav, arpeggio_c.wav
```

---

## 🧪 Performance Test Procedures

### Test File
Open `examples/performance-test.osc` in your IDE (VS Code/Cursor/Claude Code)

### Phase 1: Basic Functionality

#### Step 1: Global Initialization
1. Select global initialization lines:
```osc
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("../test-assets/audio")
global.start()
```
2. Press **Cmd+Enter** (Mac) or **Ctrl+Enter** (Linux/Windows)
3. **Expected**: No errors, global context created
4. **Check**: Output panel shows successful execution

#### Step 2: Kick Drum Pattern
1. Select kick drum setup:
```osc
var kick = init global.seq
kick.beat(4 by 4).length(1)
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)
LOOP(kick)
```
2. Press **Cmd+Enter**
3. **Expected**: Kick drum plays 4-on-the-floor pattern
4. **Check**: Audio plays at 120 BPM, kick on beats 1 and 3
5. **Measure**: Latency from Cmd+Enter to audio start

#### Step 3: Add Hi-Hat
1. Select hi-hat setup:
```osc
var hihat = init global.seq
hihat.beat(4 by 4).length(1)
hihat.audio("hihat.wav")
hihat.play(1, 1, 1, 1)
LOOP(kick, hihat)
```
2. Press **Cmd+Enter**
3. **Expected**: Hi-hat joins kick drum with quarter note pattern
4. **Check**: Both kick and hi-hat play simultaneously in sync

#### Step 4: Add Snare
1. Select snare setup:
```osc
var snare = init global.seq
snare.beat(4 by 4).length(1)
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)
LOOP(kick, hihat, snare)
```
2. Press **Cmd+Enter**
3. **Expected**: Snare adds to the rhythm on beats 2 and 4
4. **Check**: Full drum kit sound with tight synchronization

### Phase 2: Advanced Features

#### Step 5: Bassline with Chop
1. Select bassline setup:
```osc
var bass = init global.seq
bass.beat(4 by 4).length(2)
bass.audio("bass.wav").chop(8)
bass.play(1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0)
LOOP(kick, hihat, snare, bass)
```
2. Press **Cmd+Enter**
3. **Expected**: Bassline plays with sliced audio (8 slices)
4. **Check**: Bass plays different slices creating melodic pattern
5. **Verify**: Audio slicing is accurate (no clicks or pops)

#### Step 6: Complex Nested Pattern
1. Select arpeggio setup:
```osc
var arp = init global.seq
arp.beat(4 by 4).length(1)
arp.audio("arpeggio_c.wav").chop(16)
arp.play(1, 0, 3, 0, 5, 0, 3, 0, 8, 0, 5, 0, 3, 0, 1, 0)
LOOP(kick, hihat, snare, bass, arp)
```
2. Press **Cmd+Enter**
3. **Expected**: Arpeggio plays complex melodic pattern
4. **Check**: Timing is accurate with all other sequences
5. **Monitor**: CPU usage during complex multi-track playback

### Phase 3: Real-Time Manipulation

#### Step 7: Tempo Change
1. Select tempo change:
```osc
global._tempo(140)
```
2. Press **Cmd+Enter**
3. **Expected**: All sequences speed up to 140 BPM on next bar
4. **Check**: No audio dropouts, smooth tempo transition
5. **Measure**: Time for tempo change to take effect

#### Step 8: Pattern Modification
1. Select pattern change:
```osc
kick._play(1, 0, 0, 1, 0, 1, 0, 0)
```
2. Press **Cmd+Enter**
3. **Expected**: Kick pattern changes to breakbeat style
4. **Check**: Change takes effect on next bar boundary

#### Step 9: Slice Reordering
1. Select bassline slice reorder:
```osc
bass._play(5, 0, 3, 0, 1, 0, 7, 0, 6, 0, 2, 0, 4, 0, 0, 0)
```
2. Press **Cmd+Enter**
3. **Expected**: Bassline plays slices in different order
4. **Check**: Melodic pattern changes immediately

### Phase 4: Transport Control

#### Step 10: Individual Muting
1. Select mute command:
```osc
MUTE(hihat, snare)
```
2. Press **Cmd+Enter**
3. **Expected**: Hi-hat and snare muted, kick and bass continue
4. **Check**: Muted sequences stop, others maintain timing

#### Step 11: Unmute (Unidirectional Toggle)
1. Select unmute command (remove from MUTE list):
```osc
MUTE()
```
2. Press **Cmd+Enter**
3. **Expected**: All sequences unmute
4. **Check**: All sequences resume in sync

#### Step 12: Selective Loop
1. Select loop subset:
```osc
LOOP(kick, bass)
```
2. Press **Cmd+Enter**
3. **Expected**: Only kick and bass continue, others auto-stop
4. **Check**: Unidirectional Toggle behavior (exclusion-based)

### Phase 5: Polymeter Test

#### Step 13: Different Meter (5/4)
1. Select 5/4 sequence:
```osc
var poly5 = init global.seq
poly5.beat(5 by 4).length(1)
poly5.audio("kick.wav")
poly5.play(1, 0, 0, 1, 0)
LOOP(kick, poly5)
```
2. Press **Cmd+Enter**
3. **Expected**: 5/4 plays alongside 4/4
4. **Check**: Polymeter works correctly, independent timing

#### Step 14: Odd Meter (7/8)
1. Select 7/8 sequence:
```osc
var poly7 = init global.seq
poly7.beat(7 by 8).length(1)
poly7.audio("hihat.wav")
poly7.play(1, 1, 0, 1, 1, 0, 1)
LOOP(kick, poly5, poly7)
```
2. Press **Cmd+Enter**
3. **Expected**: Three different meters play simultaneously (4/4, 5/4, 7/8)
4. **Check**: All sequences maintain their own timing accurately

### Phase 6: Stress Test

#### Step 15: Multiple Sequences
1. Create 6-8 simultaneous sequences
2. Press **Cmd+Enter** for each
3. **Expected**: All sequences play simultaneously
4. **Monitor**:
   - CPU usage
   - Memory usage
   - Audio dropouts (should be none)
   - Synchronization accuracy

#### Step 16: Rapid Pattern Changes
1. Execute pattern changes every 4 bars
2. **Expected**: Changes take effect smoothly
3. **Monitor**: System stability and response time

#### Step 17: Error Handling
1. Select intentional error (e.g., missing audio file):
```osc
var err = init global.seq
err.audio("nonexistent.wav")
err.play(1, 1, 1, 1)
```
2. Press **Cmd+Enter**
3. **Expected**: Error message displayed, other sequences continue
4. **Check**: System remains stable after error

### Phase 7: Cleanup

#### Step 18: Stop All
1. Select stop command:
```osc
global.stop()
```
2. Press **Cmd+Enter**
3. **Expected**: All audio stops immediately
4. **Check**: Clean stop, no hanging processes

---

## 📊 Performance Metrics

### Audio Quality Benchmarks

| Metric | Target | Status |
|--------|--------|--------|
| Latency | < 10ms | ✅ 0-2ms |
| Dropouts | None | ✅ None |
| Sync Accuracy | < 10ms drift | ✅ Accurate |
| Sample Rate | 48kHz | ✅ 48kHz |
| Bit Depth | 24bit | ✅ 24bit |

### System Performance Benchmarks

| Metric | Target | Measured |
|--------|--------|----------|
| CPU Usage (4 tracks) | < 30% | 📝 Measure |
| CPU Usage (8 tracks) | < 50% | 📝 Measure |
| Memory Usage | Stable | 📝 Measure |
| Response Time (Cmd+Enter) | < 100ms | 📝 Measure |

### User Experience Metrics

| Feature | Expected Behavior | Status |
|---------|-------------------|--------|
| Syntax Highlighting | Real-time | ✅ Working |
| Autocomplete | Suggestions on `.` | ✅ Working |
| Error Messages | Clear, with line numbers | ✅ Working |
| Visual Feedback | Status updates in output panel | ✅ Working |

---

## 🐛 Troubleshooting

### No Audio Output
**Check**:
1. SuperCollider is running
2. Audio files exist in correct path
3. System audio settings
4. Output panel for error messages

**Solution**:
```bash
# Verify SuperCollider process
ps aux | grep scsynth

# Check audio files
ls -la test-assets/audio/*.wav

# Restart engine
global.stop()
global.start()
```

### High CPU Usage
**Check**:
1. Number of simultaneous sequences
2. Complex chop patterns
3. System processes

**Solution**:
- Reduce number of sequences
- Simplify chop patterns
- Use `MUTE()` to disable unused sequences

### Timing Drift
**Check**:
1. System clock accuracy
2. Tempo settings
3. Polymeter configurations

**Solution**:
- Restart global scheduler: `global.stop()` → `global.start()`
- Simplify meter configurations
- Verify no other audio applications are running

### Cmd+Enter Not Working
**Check**:
1. File has `.osc` extension
2. Extension is activated
3. Keybinding is registered

**Solution**:
- Restart IDE
- Use Command Palette: "OrbitScore: Run Selection"
- Verify extension installation

---

## 📝 Test Report Template

After completing performance tests, document results:

```markdown
# Performance Test Report

## Test Date: YYYY-MM-DD
## Tester: [Name]
## Environment: [macOS/Linux/Windows], [IDE: VS Code/Cursor/Claude Code]

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
- Synchronization Accuracy: [X]ms drift

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommendations
1. [Improvement suggestion]
2. [Improvement suggestion]
```

---

## 🔗 Related Documentation

- **DSL Specification**: [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md)
- **Testing Guide**: [`./TESTING_GUIDE.md`](./TESTING_GUIDE.md)
- **User Manual**: [`../core/USER_MANUAL.md`](../core/USER_MANUAL.md)
- **Implementation Plan**: [`../development/IMPLEMENTATION_PLAN.md`](../development/IMPLEMENTATION_PLAN.md)
