# OrbitScore Documentation Index

## 📚 Documentation Structure

### Core Documents

1. **[PROJECT_RULES.md](./PROJECT_RULES.md)** 📏
   - Critical project rules and practices
   - MUST read before contributing
   - Includes WORK_LOG update requirements

2. **[SERENA_GUIDE.md](./SERENA_GUIDE.md)** 🤖
   - Serena MCP usage guidelines
   - Code analysis and long-term memory management
   - MUST read at session start

3. **[CONTEXT7_GUIDE.md](./CONTEXT7_GUIDE.md)** 📚
   - Context7 usage guidelines
   - External library documentation reference
   - MUST read at session start

4. **[TOOL_SELECTION_GUIDE.md](./TOOL_SELECTION_GUIDE.md)** 🛠️
   - Tool selection criteria
   - Decision flowchart for choosing appropriate tools

5. **[WORK_LOG.md](./WORK_LOG.md)** 📝
   - Complete development history
   - Technical decisions and rationale
   - Chronological progress tracking
   - All commits documented

6. **[INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md)** 🎵
   - **Single source of truth** for OrbitScore DSL
   - Audio-based DSL specification (v2.0)
   - Global parameters and sequences
   - Transport commands and DAW integration

7. **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** 🗺️
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

## 📦 Archive

### DSL仕様の変遷（論文執筆・研究用）

OrbitScoreのDSL設計は、開発過程で大きく進化しました：

| Version | Document | Status | Description |
|---------|----------|--------|-------------|
| **v2.0** | [INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md) | ✅ **現行** | SuperCollider Audio Engine統合 |
| **v1.0** | [archive/DSL_SPECIFICATION_v1.0_MIDI.md](./archive/DSL_SPECIFICATION_v1.0_MIDI.md) | 📚 アーカイブ | MIDIベース度数システム |

**設計思想の進化**:
- **v1.0**: MIDIベースの度数システム（0=休符、1-12=半音階）
- **v2.0**: オーディオベースの直接再生システム（`audio()`, `chop()`, `play()`）

詳細な技術的変遷と意思決定の経緯は[WORK_LOG.md](./WORK_LOG.md)を参照してください。

---

_Last Updated: October 6, 2025 - Added archive section for research documentation_
