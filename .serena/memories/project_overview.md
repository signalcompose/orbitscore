# OrbitScore Project Overview

**Last Updated**: 2025-10-10

## Project Description
OrbitScore is an audio-based live coding DSL for modern music production. It provides real-time audio manipulation with time-stretching, pitch shifting, and bar-quantized transport control, integrated with SuperCollider for ultra-low latency (0-2ms) playback.

## Current Status
- **Project Start**: 2025-09-16
- **DSL Version**: v3.0 (完全実装済み)
- **Test Status**: 225 passed, 23 skipped (248 total) = 90.7%
- **Current Branch**: develop
- **Latest PR**: #58 (Merged 2025-10-10) - DSL仕様明確化 + Claude Code Hooks削除

## Core Architecture

### 1. Parser (`packages/engine/src/parser/`)
- **Tokenizer**: Lexical analysis with reserved keyword support
- **Parser**: Syntax analysis → IR (Intermediate Representation)
- **Audio Parser**: Audio-specific DSL syntax support
- **Keywords**: `var`, `init`, `GLOBAL`, `RUN`, `LOOP`, `STOP`, `MUTE`

### 2. Interpreter (`packages/engine/src/interpreter/`)
- **InterpreterV2**: OOP-based statement processing
- **Process Statement**: Global/Sequence/Transport command execution
- **State Management**: runGroup, loopGroup, muteGroup tracking

### 3. Audio Engine (`packages/engine/src/audio/`)
- **SuperCollider Integration**: scsynth via supercolliderjs
- **Audio Slicer**: WAV file slicing with chop(n) support
- **Buffer Management**: Preloading and lifecycle management
- **Latency**: 0-2ms ultra-low latency achievement

### 4. Transport System (`packages/engine/src/global/`)
- **Global Class**: Global transport control and parameter management
- **Tempo Manager**: BPM and polymeter support
- **Scheduler**: Bar-quantized event scheduling with look-ahead

### 5. Sequence (`packages/engine/src/sequence/`)
- **Sequence Class**: Individual track state and playback control
- **Parameter Management**: Audio, tempo, beat, length, gain, pan
- **Play Patterns**: Nested play() support with timing calculation

### 6. VS Code Extension (`packages/vscode-extension/`)
- **Syntax Highlighting**: .osc file support
- **Command Execution**: Cmd+Enter execution
- **IntelliSense**: Context-aware autocomplete

## Latest Features (DSL v3.0)

### Underscore Prefix Pattern
- `method()`: Setting only (buffered)
- `_method()`: Immediate application (triggers playback/seamless update)
- Exception: `gain()`, `pan()` always apply immediately

### Unidirectional Toggle (片記号方式)
- `RUN(kick, snare)`: Start only specified sequences
- `LOOP(hat)`: Loop only specified sequences (others auto-stop)
- `MUTE(kick)`: Mute only specified sequences (LOOP only)
- Removed: `STOP()`, `UNMUTE()` keywords

## Development Workflow

**CRITICAL**: Issue → Branch → PR → Merge

1. Create Issue (get number)
2. Create branch: `<issue-number>-<descriptive-name>` (English only)
3. Implement and test
4. Update WORK_LOG.md before commit
5. Create PR with `Closes #<issue-number>`
6. Merge (squash)

**Branch Policy**:
- ✅ develop: Feature integration branch
- ✅ Feature branches: `<issue-number>-description`
- ❌ Never commit directly to develop/main

**Serena Memory Policy**:
- ✅ Edit/save on develop: OK
- ❌ Commit on develop: NG
- ✅ Commit on feature branch: OK (with feature changes)

## Documentation Structure
- `CLAUDE.md` - Claude Code guidelines (session start actions, quick reference)
- `docs/INDEX.md` - Documentation entry point
- `docs/PROJECT_RULES.md` - Development workflow and coding standards
- `docs/INSTRUCTION_ORBITSCORE_DSL.md` - DSL specification v3.0 (single source of truth)
- `docs/IMPLEMENTATION_PLAN.md` - Technical roadmap and phase tracking
- `docs/WORK_LOG.md` - Complete development history (for academic paper)
- `docs/USER_MANUAL.md` - User-facing features and usage

## Essential Commands

```bash
# Build & Test
npm run build                    # Build entire project
npm test                         # Run all tests (229 passed, 19 skipped)
npm run lint                     # Check code style
npm run lint:fix                 # Auto-fix linting issues

# Development
npm run dev:engine              # Run engine in dev mode
node packages/engine/dist/cli-audio.js run examples/demo.osc

# Git
gh issue create                 # Create Issue
git checkout -b <issue-number>-description
git commit -m "feat: description"
gh pr create --base develop --title "..." --body "Closes #<issue-number>"
```

## Testing Strategy
- **Framework**: Vitest with --pool=forks for isolation
- **Unit Tests**: Parser, Interpreter, Core classes
- **Integration Tests**: E2E playback (SuperCollider required)
- **CI**: SuperCollider tests skipped (`describe.skipIf(process.env.CI === 'true')`)
- **Pre-commit**: Husky runs tests, build, lint-staged automatically

## Known Limitations
- SuperCollider tests require local scsynth installation
- E2E tests skipped in CI environment
- Audio formats: WAV fully supported, AIFF/MP3/MP4 placeholders only

## Next Steps (Priority Order)

### High Priority
1. **Audio Recording Feature** - User request for live performance archiving
2. **Edge Case Tests** - RUN/LOOP/MUTE robustness improvements

### Medium Priority
3. **Documentation** - Live coding patterns, migration guide, troubleshooting

### Low Priority (Future)
4. **Audio Key Detection** - Polymodal feature prerequisite
5. **MIDI Support** - External instrument control
6. **DAW Plugin** - VST/AU wrapper for DAW integration

## Reference
- **Canonical DSL Spec**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- **Serena Memories**: 28 memories available for project-specific knowledge
- **GitHub Issues**: Use for all new features and bug fixes
