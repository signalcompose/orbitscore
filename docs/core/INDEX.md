# OrbitScore Documentation Index

## 📚 Documentation Structure

### Core Documents

1. **[PROJECT_RULES.md](./PROJECT_RULES.md)** 📏
   - Critical project rules and practices
   - MUST read before contributing
   - Includes WORK_LOG update requirements

2. **[CONTEXT7_GUIDE.md](./CONTEXT7_GUIDE.md)** 📚
   - Context7 usage guidelines
   - External library documentation reference
   - MUST read at session start

3. **Serenaツール** 🤖
   - Serenaを使ってプロジェクト知識を管理
   - `list_memories`で利用可能なメモリを確認
   - 必要に応じて`read_memory`で読み込む

4. **[INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md)** 🎵
   - **Single source of truth** for OrbitScore DSL
   - Audio-based DSL specification (v3.0)
   - Global parameters and sequences
   - Transport commands (RUN/LOOP/MUTE)

5. **[USER_MANUAL.md](./USER_MANUAL.md)** 📖
   - User-facing documentation
   - Feature explanations and examples
   - Live coding workflow guide

### Development Documents

1. **[WORK_LOG.md](../development/WORK_LOG.md)** 📝
   - Complete development history
   - Technical decisions and rationale
   - Chronological progress tracking
   - All commits documented

2. **[IMPLEMENTATION_PLAN.md](../development/IMPLEMENTATION_PLAN.md)** 🗺️
   - Technical roadmap
   - Phase-by-phase implementation
   - Testing requirements
   - Completion criteria

3. **[BEAT_METER_SPECIFICATION.md](../development/BEAT_METER_SPECIFICATION.md)** 🎼
   - Beat/Meter specification and future plans
   - Polymeter feature details
   - Tempo/BPM terminology
   - Phase 2 validation plans

### Testing Documents

1. **[TESTING_GUIDE.md](../testing/TESTING_GUIDE.md)** 🧪
   - Unit & Integration test procedures
   - IDE integration testing (VS Code/Cursor/Claude Code)
   - Feature verification checklist
   - Troubleshooting guide

2. **[PERFORMANCE_TEST.md](../testing/PERFORMANCE_TEST.md)** ⚡
   - Live coding performance testing
   - Benchmarks and metrics
   - Stress test procedures
   - Performance optimization guide

### Planning Documents

1. **[COLLABORATION_FEATURE_PLAN.md](../planning/COLLABORATION_FEATURE_PLAN.md)** 👥
   - Collaboration feature planning
   - Multi-user scenarios

2. **[ELECTRON_APP_PLAN.md](../planning/ELECTRON_APP_PLAN.md)** 💻
   - Standalone Electron app planning
   - Desktop application architecture

3. **[IMPROVEMENT_RECOMMENDATIONS.md](../planning/IMPROVEMENT_RECOMMENDATIONS.md)** 💡
   - Future improvement proposals
   - Priority-based roadmap
   - Technical enhancements

4. **[RUST_ENGINE_MIGRATION_PLAN.md](../planning/RUST_ENGINE_MIGRATION_PLAN.md)** 🦀
   - Rust サウンドエンジン移行計画
   - Engine-as-a-Service アーキテクチャ
   - VST3/CLAP プラグインホスティング、商用展開戦略

5. **[AUDIO_ENGINE_CORE_ARCHITECTURE.md](../planning/AUDIO_ENGINE_CORE_ARCHITECTURE.md)** 🎚️
   - 3 層分離アーキテクチャ（Core / Plugins / App）
   - DSL → MIDI 変換戦略、responsibilities 境界
   - Cargo workspace 構造、Plugin Host MIDI 契約

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
- **Transport Commands**: `global.start()`, `global.loop()`, `seq.mute()`, etc.
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
- **How something works**: Check [WORK_LOG.md](../development/WORK_LOG.md)
- **What to implement**: Check [IMPLEMENTATION_PLAN.md](../development/IMPLEMENTATION_PLAN.md)
- **Project practices**: Check [PROJECT_RULES.md](./PROJECT_RULES.md)
- **Testing procedures**: Check [TESTING_GUIDE.md](../testing/TESTING_GUIDE.md)

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
| **v3.0** | [INSTRUCTION_ORBITSCORE_DSL.md](./INSTRUCTION_ORBITSCORE_DSL.md) | ✅ **現行** | SuperCollider Audio Engine + Unidirectional Toggle |
| **v1.0** | [archive/DSL_SPECIFICATION_v1.0_MIDI.md](./archive/DSL_SPECIFICATION_v1.0_MIDI.md) | 📚 アーカイブ | MIDIベース度数システム |

**設計思想の進化**:
- **v1.0**: MIDIベースの度数システム（0=休符、1-12=半音階）
- **v3.0**: オーディオベース + SuperCollider (`audio()`, `chop()`, `RUN()`, `LOOP()`, `MUTE()`)

詳細な技術的変遷と意思決定の経緯は[WORK_LOG.md](../development/WORK_LOG.md)を参照してください。

---

_Last Updated: 2025-10-26 - Reorganized directory structure for documentation_
