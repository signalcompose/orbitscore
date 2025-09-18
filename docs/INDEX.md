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

3. **[INSTRUCTIONS_NEW_DSL.md](./INSTRUCTIONS_NEW_DSL.md)** 🎵
   - DSL language specification
   - Syntax and semantics
   - Key concepts (degree 0 = rest)
   - Implementation requirements

4. **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** 🗺️
   - Technical roadmap
   - Phase-by-phase implementation
   - Testing requirements
   - Completion criteria

### Quick Links

- **User Guide**: [../README.md](../README.md) - Start here for usage
- **VS Code Extension**: [../packages/vscode-extension/README.md](../packages/vscode-extension/README.md)
- **Examples**: [../examples/](../examples/) - Sample .osc files

## 📋 Development Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Complete | Parser Implementation |
| 2 | ✅ Complete | Pitch/Bend Conversion |
| 3 | ✅ Complete | Scheduler + Transport |
| 4 | ✅ Complete | VS Code Extension |
| 5 | ⏳ Pending | MIDI Output (CoreMIDI) |

## 🎯 Key Concepts

### Degree System
- **0 = Rest/Silence** (革新的特徴)
- **1-12 = Chromatic Scale** (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)

### Precision
- 小数第3位まで (3 decimal places)
- Deterministic randomness with seed

### Meter Types
- **Shared**: Global bar lines
- **Independent**: Per-sequence bar lines

## 🔍 Finding Information

- **How something works**: Check [WORK_LOG.md](./WORK_LOG.md)
- **What to implement**: Check [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
- **Language details**: Check [INSTRUCTIONS_NEW_DSL.md](./INSTRUCTIONS_NEW_DSL.md)
- **Project practices**: Check [PROJECT_RULES.md](./PROJECT_RULES.md)

## 📝 Documentation Guidelines

1. **Always update WORK_LOG.md** with every commit
2. Keep documentation in sync with code
3. Use clear, descriptive headings
4. Include examples where helpful
5. Document decisions and rationale

---

*Last Updated: December 19, 2024*