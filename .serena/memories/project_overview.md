# OrbitScore Project Overview

## Project Summary
OrbitScore is a live-coding audio engine with SuperCollider integration, designed for real-time performance. It features a custom DSL for pattern-based audio sequencing with support for polymeter, polytempo, and nested rhythms.

## Recent Development (January 6, 2025)

### Phase 11: Performance Demo and Extension Packaging
**Status**: ✅ COMPLETE

**Key Achievements**:
1. **VS Code Extension Packaging Fixed**
   - Resolved engine path resolution issues
   - Added fallback logic for bundled vs workspace engine
   - Successfully packaged with dependencies (35 files, 57.5 KB)
   - Tested in live performance - working perfectly

2. **Performance Demo File Created**
   - `examples/performance-demo.osc` with all 13 test samples
   - Organized by category: drums, bass, melody, test
   - Initial silent patterns for live coding
   - Comprehensive command examples

3. **Serena Usage Guidelines Integration**
   - Moved from `docs/SERENA.md` to `AGENTS.md`
   - Now auto-loaded by all agents
   - Clear guidelines for when to use Serena vs normal tools

**Live Performance Result**: ✅ Successfully used in real performance

## Current Architecture

### Core Components
1. **Engine** (`packages/engine/`)
   - SuperCollider integration via supercolliderjs
   - Real-time audio scheduling with microsecond precision
   - Global mastering effects (compressor, limiter, normalizer)
   - Audio path: `test-assets/audio/` (13 samples available)

2. **VS Code Extension** (`packages/vscode-extension/`)
   - Live coding interface with Cmd+Enter execution
   - Status bar controls (Start/Stop/Debug/Kill/Reload)
   - Auto-evaluation for settings, manual for execution
   - Debug mode for verbose logging
   - **Packaging**: Bundles engine with dependencies

3. **DSL** (Domain Specific Language)
   - Syntax: `var global = init GLOBAL`, `var seq = init global.seq`
   - Pattern notation: comma-separated (e.g., `1, 0, 1, 0`)
   - Nested rhythms: `[1, 0, 1]` within patterns
   - Real-time parameter changes: `gain()`, `pan()`, `tempo()`, `length()`

### Key Features
- **Polymeter/Polytempo**: Independent tempo and meter per sequence
- **Chop**: Audio slicing with `chop(n)` and slice playback
- **Global Mastering**: Compressor, limiter, normalizer on master bus
- **Random Values**: `r` (full random), `rX%Y` (random walk)
- **Audio Device Selection**: Via `.orbitscore.json` config
- **Debug Mode**: Toggle verbose logging

## Technical Details

### Audio Engine
- **SuperCollider**: scsynth for audio synthesis
- **SynthDefs**: orbitPlayBuf, fxCompressor, fxLimiter, fxNormalizer
- **Timing**: Microsecond-precision scheduling
- **Gain**: dB units (-60 to +12 dB, -inf for silence)
- **Pan**: -100 (left) to +100 (right)

### Extension Packaging
- **Engine Path Resolution**:
  1. Check `../engine/dist/cli-audio.js` (bundled)
  2. Fallback to `../../engine/dist/cli-audio.js` (workspace)
- **Dependencies**: Includes `node_modules/` with supercolliderjs
- **Size**: 57.5 KB with all dependencies

### Test Assets
13 audio samples in `test-assets/audio/`:
- Drums: kick, snare, hihat_closed, hihat_open, hihat
- Bass: bass_c1, bass_e1, bass_g1
- Melody: arpeggio_c, chord_c_major, chord_a_minor
- Test: sine_440, sine_880

## Development Workflow

### Agent Guidelines (AGENTS.md)
**Use Serena for**:
- Complex code analysis and architecture understanding
- Symbol reference tracking
- Large-scale refactoring impact analysis
- Bug investigation across multiple files

**Use Normal Tools for**:
- Simple file edits
- Known file/function changes
- String search/replace

### Commit Workflow
1. Make changes
2. Update `docs/WORK_LOG.md`
3. Update Serena memory
4. Commit with descriptive message
5. Create PR (if on feature branch)
6. Merge to main (squash merge, keep branch)

### Rules
- **No direct commits to main** (use feature branches)
- **Always update WORK_LOG** with each commit
- **Test before committing**
- **Check official docs** when blocked

## Future Improvements
1. **Error Messages**: Add line numbers to parser/interpreter errors
2. **Extension Packaging**: Automate with webpack/esbuild
3. **Bundle Size**: Reduce by bundling dependencies
4. **Per-Sequence Effects**: Delayed (complex bus architecture)
5. **VST Plugin Support**: Abandoned (installation complexity)

## Current Status
- ✅ Core engine: Stable and production-ready
- ✅ VS Code extension: Working with proper packaging
- ✅ Live performance: Successfully tested
- ✅ Documentation: Up to date
- ✅ Test coverage: Core functionality 100% passing

**Next Steps**: Error message improvements, packaging automation