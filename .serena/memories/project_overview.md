# OrbitScore Project Overview

## Project Description
OrbitScore is an audio-based music DSL (Domain Specific Language) for real-time audio manipulation, time-stretching, pitch-shifting, and live coding performance. The project has migrated from a MIDI-based system to an audio-based system.

## Key Features
- **Audio Processing**: WAV, AIFF, MP3, MP4 playback with time-stretching and pitch-shifting
- **Audio Slicing**: `.chop(n)` to divide files into equal parts
- **Real-time Transport**: `global.run()`, `global.stop()`, bar-quantized scheduling
- **Live Coding**: VS Code extension with Cmd+Enter execution and persistent REPL
- **Individual Track Control**: `.run()`, `.loop()`, `.stop()` methods for sequences
- **Polymeter Support**: Independent sequence timing
- **Professional Audio**: 48kHz/24bit quality with CoreAudio integration

## Tech Stack
- **Language**: TypeScript
- **Testing**: Vitest
- **Build System**: TypeScript compiler
- **Package Manager**: npm with workspaces
- **Audio**: sox (Sound eXchange) for advanced features, afplay as fallback
- **Platform**: macOS optimized with CoreAudio
- **Editor**: VS Code extension with syntax highlighting and live execution

## Project Structure
- **Monorepo**: npm workspaces with `packages/engine` and `packages/vscode-extension`
- **Engine**: Core DSL implementation, parser, audio engine, transport system
- **VS Code Extension**: Syntax highlighting, autocomplete, Cmd+Enter execution, persistent REPL
- **Documentation**: Comprehensive docs in `docs/` folder
- **Testing**: Extensive test suite with 216/217 tests passing (99.5%)

## Current Status (Phase 6 - January 13, 2025)

### Implementation Progress
- **Phase 1-3**: ✅ Parser, Interpreter, Transport (100%)
- **Phase 4**: ✅ VS Code Extension (100%)
- **Phase 5**: ✅ Audio Playback Verification (100%)
- **Phase 6**: ✅ Live Coding Workflow (100% - ALL ISSUES RESOLVED)
- **Phase 7**: 📝 Advanced Audio Features (Next)
- **Phase 8**: 📝 DAW Plugin (Planned)

### Phase 6 Complete! 🎉
All critical issues have been resolved:
- ✅ Scheduler auto-stop removed (live coding compatible)
- ✅ Loop timing fixed (no double offset)
- ✅ Instance reuse implemented (no ghost instances)
- ✅ `global.stop()` working perfectly
- ✅ `kick.stop()` working perfectly
- ✅ Accurate rhythm with no drift

### Live Coding Workflow (Verified Working)
1. **Engine Management**: Manual start/stop via status bar
2. **File Evaluation**: Definitions on save, execution via Cmd+Enter
3. **Transport Control**: `global.run()` / `global.stop()`
4. **Sequence Control**: `kick.loop()` / `kick.stop()`
5. **Visual Feedback**: Status bar shows Stopped / Ready / Playing

### Recent Achievements (Phase 6)
- ✅ Persistent engine process with REPL mode
- ✅ Two-phase workflow (definitions vs. execution)
- ✅ Automatic file evaluation on save
- ✅ Code filtering to prevent unintended execution
- ✅ Individual track control with accurate timing
- ✅ Status bar visual feedback
- ✅ Instance reuse across evaluations
- ✅ Scheduler lifecycle fully debugged and fixed

### Latest Session Work (January 13, 2025)
- Fixed scheduler auto-stop issue
- Fixed loop timing double-offset bug
- Implemented instance reuse in interpreter
- Added extensive debug logging
- Improved UI/UX (status bar naming, comment syntax)
- Verified complete live coding workflow

## Next Steps
1. Clean up debug logging for production
2. Test multiple simultaneous sequences
3. Performance testing with complex patterns
4. Update user documentation
5. Begin Phase 7: Advanced audio features