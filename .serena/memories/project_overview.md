# OrbitScore - Project Overview

**Last Updated:** 2025-01-05

## What is OrbitScore?

OrbitScore is a **live coding audio DSL (Domain Specific Language)** designed for real-time musical performance and composition. It provides an intuitive, text-based interface for creating and manipulating rhythmic patterns and audio sequences.

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js
- **Audio Engine:** `sox` (primary), `afplay` (fallback for macOS)
- **Project Structure:** Monorepo with npm workspaces
- **IDE Integration:** VS Code/Cursor extension with syntax highlighting and live coding support

## Core Components

1. **DSL Parser** (`packages/engine/src/parser/`)
   - Parses `.osc` files into Abstract Syntax Tree (AST)
   - Supports hierarchical patterns and nested structures

2. **Interpreter** (`packages/engine/src/interpreter/`)
   - `InterpreterV2`: Persistent REPL-based interpreter
   - Maintains state across multiple evaluations
   - Reuses instances for live coding workflow

3. **Audio Scheduler** (`packages/engine/src/audio/`)
   - `AdvancedAudioPlayer`: High-precision audio scheduler (1ms resolution)
   - Manages parallel playback of multiple sequences
   - Supports real-time event scheduling and modification

4. **VS Code Extension** (`packages/vscode-extension/`)
   - Syntax highlighting for `.osc` files
   - Live coding support with `Cmd+Enter` execution
   - Two-phase workflow: file save for definitions, Cmd+Enter for transport
   - Real-time status feedback via status bar

## Current Status

### Phase 6: Live Coding Workflow - ✅ 100% Complete

**Recent Achievements:**
- ✅ Fixed snare pattern playback bug (scheduledPlays sorting issue)
- ✅ Implemented explicit scheduler control (no auto-start)
- ✅ Enabled live sequence addition without restart
- ✅ Achieved perfect multi-track synchronization (0-3ms drift)
- ✅ Individual sequence control (independent loop/stop)
- ✅ Cleaned up debug logs for production readiness

**Test Results:**
- ✅ 3-track simultaneous playback (kick + snare + hihat)
- ✅ Individual sequence control
- ✅ Global stop functionality
- ✅ Live sequence addition
- ✅ Explicit scheduler control

**Latest Commits:**
- `fix: Sort scheduledPlays after adding events for correct timing`
- `fix: Remove auto-start logic, require explicit global.run()`
- `fix: Enable live sequence addition via file save`
- `chore: Clean up debug logs for production`

## Live Coding Workflow

1. **Start Engine:** Click status bar or use command palette
2. **Define Sequences:** Save file (`Cmd+S`) to load definitions
3. **Start Scheduler:** Execute `global.run()` with `Cmd+Enter`
4. **Control Sequences:**
   - `kick.loop()` - Start looping a sequence
   - `kick.stop()` - Stop a specific sequence
   - `global.stop()` - Stop all sequences and scheduler
5. **Add New Sequences:** Edit file, save, and use immediately

## Key Features

- **Real-time Performance:** 1ms scheduler precision, 0-3ms typical drift
- **Persistent State:** Interpreter maintains state across evaluations
- **Live Modification:** Add/modify sequences without restarting
- **Explicit Control:** User controls when audio starts/stops
- **Multi-track Sync:** Perfect synchronization of multiple sequences
- **IDE Integration:** Seamless Cursor/VS Code integration

## Next Steps

1. Performance testing with complex patterns
2. Optional loop quantization feature
3. Additional DSL features (effects, parameters)
4. Community testing and feedback
