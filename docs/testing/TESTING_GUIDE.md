# OrbitScore Testing Guide

**Last Updated**: 2025-10-26
**Test Status**: 225 passed | 23 skipped (248 total) = 90.7%

## 📚 Overview

This guide provides comprehensive testing procedures for OrbitScore's audio-based live coding DSL. Tests verify implemented features against the specification in [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md).

## 🎯 Prerequisites

### System Requirements
- Node.js v22.0.0+
- SuperCollider (audio engine)
- VS Code / Cursor / Claude Code
- Audio device (speakers or headphones)

### SuperCollider Installation

**macOS:**
```bash
brew install --cask supercollider
```

**Linux:**
```bash
sudo apt-get install supercollider
```

**Windows:**
- Download from [SuperCollider official site](https://supercollider.github.io/)

### Environment Setup

1. **Build the engine:**
```bash
cd packages/engine
npm install
npm run build
```

2. **Verify SynthDefs:**
```bash
ls -la packages/engine/supercollider/synthdefs/
# Verify: orbitPlayBuf.scsyndef, fxCompressor.scsyndef, fxLimiter.scsyndef, fxNormalizer.scsyndef
```

3. **Prepare test audio files:**
```bash
ls -la test-assets/audio/
# Verify: kick.wav, snare.wav, hihat.wav, bass.wav, arpeggio_c.wav
```

---

## 🧪 Unit & Integration Tests

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- audio-parser
npm test -- unidirectional-toggle
```

### Current Test Coverage

**Total**: 225 passed | 23 skipped (248 total) = 90.7%

**Test Suites**:
- ✅ Audio Parser: 50/50
- ✅ Unidirectional Toggle: 22/22
- ✅ Seamless Parameter Update: 10/10
- ✅ DSL v3.0 Underscore Methods: 27/27
- ✅ Gain/Pan Control: 41/41
- ✅ SuperCollider Integration: 15/15

**Skipped Tests** (23):
- End-to-end tests requiring manual verification
- SuperCollider environment-specific tests
- Some interpreter tests

---

## 🎵 IDE Integration Testing (VS Code / Cursor / Claude Code)

### Setup

#### VS Code Extension Installation
```bash
code --install-extension packages/vscode-extension/orbitscore-0.0.1.vsix
```

#### Cursor / Claude Code
Same installation process as VS Code.

### Testing Procedures

#### Test 1: Syntax Highlighting

1. Open `examples/09_reserved_keywords.osc`
2. **Verify**:
   - Keywords (`var`, `init`, `GLOBAL`, `RUN`, `LOOP`, `MUTE`) are highlighted
   - Method names (`tempo`, `beat`, `play`, `audio`) are highlighted
   - Comments are properly colored

#### Test 2: Autocomplete

1. Create a new line in the file
2. Type `global.` → **Verify**: Suggestions include `tempo()`, `beat()`, `start()`, `stop()`
3. Type `seq.` → **Verify**: Suggestions include `audio()`, `play()`, `chop()`, `length()`

#### Test 3: Command Execution (Cmd+Enter / Ctrl+Enter)

**Note**: This tests the core live coding workflow.

**Step 1: Initialize**
```osc
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("../test-assets/audio")
global.start()
```
- Select all lines
- Press **Cmd+Enter** (Mac) or **Ctrl+Enter** (Linux/Windows)
- **Expected**: No errors in output panel

**Step 2: Create Kick Sequence**
```osc
var kick = init global.seq
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)
```
- Select lines → **Cmd+Enter**
- **Expected**: Sequence defined (no sound yet)

**Step 3: Run Kick (Reserved Keyword)**
```osc
RUN(kick)
```
- Select line → **Cmd+Enter**
- **Expected**: Kick plays once on beats 1 and 3

**Step 4: Loop Kick**
```osc
LOOP(kick)
```
- Select line → **Cmd+Enter**
- **Expected**: Kick loops continuously

**Step 5: Mute Kick**
```osc
MUTE(kick)
```
- Select line → **Cmd+Enter**
- **Expected**: Kick loops but produces no sound

**Step 6: Unmute (Unidirectional Toggle)**
```osc
MUTE()
```
- Select line → **Cmd+Enter**
- **Expected**: Kick unmutes (sound resumes)

**Step 7: Stop**
```osc
global.stop()
```
- Select line → **Cmd+Enter**
- **Expected**: All sequences stop

---

## 🔍 Feature Verification Checklist

### Core DSL Features (Implemented)

#### Initialization
- [x] `var global = init GLOBAL`
- [x] `var seq = init global.seq`

#### Global Parameters
- [x] `global.tempo(120)` - Set BPM
- [x] `global.beat(4 by 4)` - Set time signature
- [x] `global.audioPath("path")` - Set audio base directory
- [x] `global.start()` - Start scheduler
- [x] `global.stop()` - Stop scheduler

#### Sequence Configuration
- [x] `seq.audio("file.wav")` - Load audio file
- [x] `seq.chop(n)` - Divide into n slices
- [x] `seq.play(1, 0, 1, 0)` - Set play pattern
- [x] `seq.beat(4 by 4)` - Sequence-specific time signature
- [x] `seq.length(2)` - Loop length in bars
- [x] `seq.tempo(140)` - Sequence-specific tempo

#### Transport Control - Reserved Keywords (DSL v3.0)
- [x] `RUN(seq1, seq2)` - One-shot playback
- [x] `LOOP(seq1, seq2)` - Loop playback (others auto-stop)
- [x] `MUTE(seq1)` - Mute flag (LOOP only, not RUN)

**Unidirectional Toggle Behavior**:
- [x] RUN/LOOP independence (same sequence can be in both)
- [x] MUTE persistence (flag maintained across LOOP changes)
- [x] Auto-stop (sequences not in LOOP are stopped)
- [x] Auto-unmute (sequences not in MUTE are unmuted)

#### Underscore Prefix Pattern (DSL v3.0)
- [x] `_audio()`, `_chop()`, `_play()` - Immediate application
- [x] `_tempo()`, `_beat()`, `_length()` - Immediate application
- [x] `global._tempo()`, `global._beat()` - Immediate for inheriting sequences

#### Gain & Pan Control
- [x] `seq.gain(-6)` - Real-time gain (dB)
- [x] `seq.pan(-50)` - Real-time pan (-100 to 100)
- [x] `seq.defaultGain(-3)` - Initial gain (before playback)
- [x] `seq.defaultPan(20)` - Initial pan (before playback)

#### Method Chaining
- [x] All methods return `this` for chaining

### Audio Engine (SuperCollider Integration)

- [x] WAV file support
- [x] Audio slicing (`chop(n)`)
- [x] 0-2ms latency
- [x] 48kHz/24bit output
- [x] Buffer preloading and caching

### Not Yet Implemented

- [ ] fixpitch() - Pitch shift
- [ ] time() - Time stretch
- [ ] offset() - Start position adjustment
- [ ] reverse() - Reverse playback
- [ ] fade() - Fade in/out
- [ ] Composite meters - `((3 by 4)(2 by 4))`
- [ ] MIDI support
- [ ] DAW Plugin (VST/AU)

---

## 🐛 Troubleshooting

### Issue: No Sound

**Check**:
1. SuperCollider is running
2. Audio files exist in `test-assets/audio/`
3. System volume is up
4. Correct audio device selected

**Solution**:
```bash
# Verify audio files
ls -la test-assets/audio/*.wav

# Check engine logs
# Look for "Failed to load" or "File not found" messages
```

### Issue: Cmd+Enter Does Nothing

**Check**:
1. File has `.osc` extension
2. Extension is activated (restart IDE)
3. Keybinding is registered

**Solution**:
- Restart IDE
- Use Command Palette: "OrbitScore: Run Selection"

### Issue: Parser Error

**Common Errors**:
- "Unknown character": Check comment formatting
- "Unexpected token": Verify syntax (matching parentheses)

---

## 📊 Test Results Template

| Feature | Status | Notes |
|---------|--------|-------|
| Syntax highlighting | ⬜ | |
| Autocomplete | ⬜ | |
| Global initialization | ⬜ | |
| Reserved keywords (RUN/LOOP/MUTE) | ⬜ | |
| Unidirectional toggle | ⬜ | |
| Underscore prefix | ⬜ | |
| Gain/Pan control | ⬜ | |
| Method chaining | ⬜ | |
| SuperCollider integration | ⬜ | |

---

## 🔗 Related Documentation

- **DSL Specification**: [`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md)
- **User Manual**: [`../core/USER_MANUAL.md`](../core/USER_MANUAL.md)
- **Implementation Plan**: [`../development/IMPLEMENTATION_PLAN.md`](../development/IMPLEMENTATION_PLAN.md)
