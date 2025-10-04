# OrbitScore Project Overview

## Project Description
OrbitScore is an audio-based music DSL (Domain Specific Language) for real-time audio manipulation, time-stretching, pitch-shifting, and live coding performance. The project has migrated from a MIDI-based system to an audio-based system.

## Key Features
- **Audio Processing**: WAV, AIFF, MP3, MP4 playback with time-stretching and pitch-shifting
- **Audio Slicing**: `.chop(n)` to divide files into equal parts
- **Real-time Transport**: `global.run()`, `global.stop()`, bar-quantized scheduling
- **Live Coding**: VS Code extension with Cmd+Enter execution
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
- **VS Code Extension**: Syntax highlighting, autocomplete, Cmd+Enter execution
- **Documentation**: Comprehensive docs in `docs/` folder
- **Testing**: Extensive test suite with 216/217 tests passing (99.5%)

## Current Status
- **Migration**: From MIDI-based to audio-based DSL (completed)
- **Implementation**: ~85% complete (core features done, advanced features pending)
- **Testing**: 216 passed, 1 skipped tests
- **Real Audio**: Verified with kick, arpeggio, and complex nested patterns