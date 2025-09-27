# OrbitScore Documentation Index

## 📚 Documentation Structure

### Core Documents

1. **[PROJECT_RULES.md](./PROJECT_RULES.md)** 📏
   - Critical project rules and practices
   - MUST read before contributing
   - Includes WORK_LOG update requirements

2. **[WORK_LOG.md](./WORK_LOG.md)** 📝
   - Complete development history
   - Technical decisions and rationale
   - Chronological progress tracking
   - All commits documented

3. **[INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md)** 🎵
   - **Single source of truth** for OrbitScore DSL
   - Audio-based DSL specification (v0.1)
   - Global parameters and sequences
   - Transport commands and DAW integration
   
4. **[INSTRUCTIONS_NEW_DSL.md](./INSTRUCTIONS_NEW_DSL.md)** ⚠️ **DEPRECATED**
   - Old MIDI-based DSL specification
   - Superseded by INSTRUCTION_ORBITSCORE_DSL.md
   - Kept for historical reference only

5. **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** 🗺️
   - Technical roadmap
   - Phase-by-phase implementation
   - Testing requirements
   - Completion criteria

### Quick Links

- **User Guide**: [../README.md](../README.md) - Start here for usage
- **VS Code Extension**: [../packages/vscode-extension/README.md](../packages/vscode-extension/README.md)
- **Examples**: [../examples/](../examples/) - Sample .osc files

## 📋 Development Phases

### Previous MIDI-Based Implementation (Deprecated)
| Phase | Status      | Description            |
| ----- | ----------- | ---------------------- |
| 1-10  | ⚠️ Deprecated | Old MIDI-based system  |

### New Audio-Based Implementation
| Phase | Status      | Description                  |
| ----- | ----------- | ---------------------------- |
| A1    | 🔄 Planning | New Parser (Audio DSL)       |
| A2    | 📝 Planned  | Audio Engine Integration     |
| A3    | 📝 Planned  | Transport System             |
| A4    | 📝 Planned  | VS Code Extension Update     |
| A5    | 📝 Planned  | DAW Plugin Development       |

## 🎯 Key Concepts

### New Audio-Based DSL

- **Audio File Playback**: Load and slice audio files (.wav, .aiff, .mp3, .mp4)
- **Time-Stretching**: Automatic tempo matching with pitch preservation
- **Transport Commands**: `global.run()`, `global.loop()`, `seq.mute()`, etc.
- **Editor Integration**: Execute commands with Cmd+Enter

### Core Features

- **Tempo**: Global and per-sequence tempo control
- **Meter**: Support for composite meters like `(4 by 4)(5 by 4)`
- **Chop**: Divide audio files into equal slices
- **Fixpitch**: Decouple playback speed from pitch

### DAW Integration

- **Audio Output**: Internal audio engine at 48kHz/24bit
- **Plugin Bridge**: VST/AU plugin for DAW routing
- **MIDI**: IAC Bus support (future)

## 🔍 Finding Information

- **DSL Specification**: Check [INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md) ⭐
- **How something works**: Check [WORK_LOG.md](./WORK_LOG.md)
- **What to implement**: Check [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
- **Project practices**: Check [PROJECT_RULES.md](./PROJECT_RULES.md)

## 📝 Documentation Guidelines

1. **Always update WORK_LOG.md** with every commit
2. Keep documentation in sync with code
3. Use clear, descriptive headings
4. Include examples where helpful
5. Document decisions and rationale

---

_Last Updated: December 25, 2024 - Migrated to Audio-Based DSL_
