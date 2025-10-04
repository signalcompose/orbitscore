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
- **Phase 6**: 🚧 Live Coding Workflow (70% - Critical Issues)
- **Phase 7**: 📝 Advanced Audio Features (Planned)
- **Phase 8**: 📝 DAW Plugin (Planned)

### Recent Achievements (Phase 6)
- ✅ Persistent engine process with REPL mode
- ✅ Two-phase workflow (definitions vs. execution)
- ✅ Automatic file evaluation on save/open
- ✅ Code filtering to prevent audio on save
- ✅ Individual track control (`.run()`, `.loop()`, `.stop()`)
- ✅ Status bar visual feedback
- ✅ Audio playback confirmed working

### Critical Issues 🔴
**Blocking live performance:**
1. `global.stop()` not fully stopping audio
2. `kick.stop()` not functioning
3. Rhythm timing inaccurate (pattern distortion)

See `.serena/memories/current_issues.md` for detailed bug reports.

### Latest Commits
- `11db725` - feat: implement live coding workflow with persistent REPL
- `a0d6acd` - docs: add commit hash to WORK_LOG.md

## Next Steps
1. **IMMEDIATE**: Fix scheduler event management
2. **HIGH**: Ensure `.stop()` methods work reliably
3. **HIGH**: Fix rhythm accuracy for live performance
4. After bugs: Complete Phase 6, performance testing, video documentation