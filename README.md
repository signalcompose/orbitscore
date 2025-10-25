# OrbitScore

**Audio-based live coding DSL for modern music production**

A new music production DSL focused on audio file manipulation, integrating time-stretching, pitch-shifting, and real-time transport control.

> ⚠️ **Migration Notice**: The project is migrating from MIDI-based to audio-based DSL. See [INSTRUCTION_ORBITSCORE_DSL.md](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) for the new specification.

## Core Features (Audio-Based DSL v3.0)

### 🎵 Audio Processing

- **Audio File Support**: WAV, AIFF, MP3, MP4 playback
- **Time-Stretching**: Tempo adjustment with pitch preservation
- **Audio Slicing**: `.chop(n)` to divide files into equal parts
- **Pitch Shifting**: `.fixpitch(n)` for independent pitch control

### ⚡ Live Coding Features

- **Editor Integration**: Execute commands with Cmd+Enter
- **Transport Commands**: `RUN()`, `LOOP()`, `MUTE()` (Unidirectional Toggle)
- **Real-time Control**: Bar-quantized transport with look-ahead
- **Polymeter Support**: Independent sequence timing

### 🔧 Technical Features

- **0-2ms Latency**: SuperCollider audio engine
- **48kHz/24bit Audio**: High-quality audio output
- **VS Code Extension**: Syntax highlighting and live execution
- **DAW Integration**: VST/AU plugin for routing (planned)
- **macOS Optimized**: CoreAudio integration

## Current Implementation Status

### 📦 Legacy MIDI-Based Implementation (Deprecated)

The previous MIDI-based implementation (Phases 1-10) is now deprecated but preserved for research purposes.

### 🚧 New Audio-Based Implementation

| Phase | Status | Progress | Description |
|-------|--------|----------|-------------|
| **Phase 1-3** | ✅ Complete | 100% | Parser, Interpreter, Transport System |
| **Phase 4** | ✅ Complete | 100% | VS Code Extension (Syntax, Commands, IntelliSense) |
| **Phase 5** | ✅ Complete | 100% | Audio Playback Verification |
| **Phase 6** | ✅ Complete | 100% | Live Coding Workflow |
| **Phase 7** | ✅ Complete | 100% | SuperCollider Integration (0-2ms Latency) |
| **Git Workflow** | ✅ Complete | 100% | Development Environment Setup |
| **Phase 8** | 📝 Next | 0% | Polymeter Testing & Advanced Features |
| **Phase 9** | 📝 Planned | 0% | DAW Plugin Development |

**Current Status**: Documentation reorganization (Issue #67) 📚

**Phase 7 Achievements**:
- ✅ SuperCollider audio engine (replaced sox)
- ✅ 0-2ms latency (was 140-150ms)
- ✅ 48kHz/24bit audio output via scsynth
- ✅ 3-track synchronization
- ✅ Chop functionality (8-beat hihat with closed/open)
- ✅ Buffer preloading and management
- ✅ Graceful lifecycle (SIGTERM → server.quit())
- ✅ Live coding ready

**Phase 6 Achievements** (Foundation):
- ✅ Persistent engine process with REPL
- ✅ Two-phase workflow (definitions on save, execution via Cmd+Enter)
- ✅ Individual track control
- ✅ Live sequence addition without restart
- ✅ Explicit scheduler control (no auto-start)
- ✅ Polymeter support (independent time signatures per sequence)

See [WORK_LOG.md](docs/development/WORK_LOG.md) for detailed resolution notes.

## Technology Stack

### Current (Audio-Based)
- TypeScript
- VS Code Extension API
- SuperCollider (scsynth + supercolliderjs)
- OSC (Open Sound Control)

### Legacy (Deprecated / Not Implemented)
- ~~CoreMIDI (@julusian/midi)~~ - Legacy, not implemented
- ~~macOS IAC Bus~~ - Legacy, not implemented

## Project Structure

```
orbitscore/
├── packages/
│   ├── engine/          # DSL Engine (Audio-Based)
│   │   ├── src/
│   │   │   ├── parser/       # Parser implementation
│   │   │   ├── interpreter/  # Interpreter (v2)
│   │   │   ├── core/         # Global & Sequence
│   │   │   ├── audio/        # SuperCollider integration
│   │   │   ├── timing/       # Timing calculation
│   │   │   └── cli/          # CLI interface
│   │   ├── dist/             # Build output
│   │   └── supercollider/    # SynthDef definitions
│   └── vscode-extension/     # VS Code extension
│       ├── src/              # Extension source
│       ├── syntaxes/         # Syntax definition
│       └── engine/           # Bundled engine
├── docs/                     # Documentation
│   ├── core/                 # Core documentation (Japanese)
│   ├── development/          # Development documentation (Japanese)
│   ├── testing/              # Testing documentation (Japanese)
│   ├── planning/             # Planning documentation (Japanese)
│   └── user/                 # User documentation (English/Japanese)
│       ├── en/               # English user docs
│       └── ja/               # Japanese user docs
├── tests/                    # Test suite
│   ├── parser/              # Parser tests
│   ├── interpreter/         # Interpreter tests
│   ├── audio/               # Audio processing tests
│   ├── core/                # Global & Sequence tests
│   └── timing/              # Timing calculation tests
├── examples/
│   └── *.osc                # Sample files
└── README.md                # This file
```

## Development Status

### Completed Phases (Audio-Based Implementation)

See [`docs/development/IMPLEMENTATION_PLAN.md`](docs/development/IMPLEMENTATION_PLAN.md) for details.

- ✅ **Phase 1-3** - Parser, Interpreter, Transport System
- ✅ **Phase 4** - VS Code Extension (Syntax, Commands, IntelliSense)
- ✅ **Phase 5** - Audio Playback Verification
- ✅ **Phase 6** - Live Coding Workflow
- ✅ **Phase 7** - SuperCollider Integration (0-2ms Latency)

### Legacy Completed Phases (MIDI-Based / Deprecated)

<details>
<summary>Legacy phases (for reference)</summary>

- ✅ **Phase 1** - Parser implementation
- ✅ **Phase 2** - Pitch/Bend conversion (degree → MIDI note + PitchBend, octave/octmul/detune/MPE)
- ✅ **Phase 3** - Scheduler + Transport (real-time playback, Loop/Jump, Mute/Solo)
- ✅ **Phase 4** - VS Code extension (syntax highlighting, Cmd+Enter execution, Transport UI)
- ✅ **Phase 5** - MIDI output implementation (CoreMIDI / IAC Bus)

</details>

## 📚 Documentation

Project documentation is organized in the [`docs/`](docs/) folder:

- 📏 [PROJECT_RULES.md](docs/core/PROJECT_RULES.md) - Project rules (must-read)
- 📝 [WORK_LOG.md](docs/development/WORK_LOG.md) - Development history
- 🎵 [INSTRUCTION_ORBITSCORE_DSL.md](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) - Language specification (Single Source of Truth)
- 📖 [USER_MANUAL.md](docs/core/USER_MANUAL.md) - User manual
- 🗺️ [IMPLEMENTATION_PLAN.md](docs/development/IMPLEMENTATION_PLAN.md) - Implementation plan
- 🧪 [TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md) - Testing guide
- 📚 [INDEX.md](docs/core/INDEX.md) - Documentation index (overall structure)

### User Documentation (English/Japanese)

- 📖 [User Manual (English)](docs/user/en/USER_MANUAL.md) - Coming soon
- 📖 [ユーザーマニュアル (日本語)](docs/user/ja/USER_MANUAL.md) - Coming soon
- 🚀 [Getting Started (English)](docs/user/en/GETTING_STARTED.md) - Coming soon
- 🚀 [はじめに (日本語)](docs/user/ja/GETTING_STARTED.md) - Coming soon

## Implemented Features (Audio-Based v3.0)

### Parser & Interpreter

- ✅ Global settings (`GLOBAL`, `tempo()`, `beat()`, `audioPath()`)
- ✅ Sequence settings (`global.seq`, `beat()`, `length()`, `audio()`)
- ✅ Pattern definition (`play()`, `chop()`)
- ✅ Method chaining syntax

### Audio Engine (SuperCollider)

- ✅ Audio file playback (WAV, AIFF, MP3, MP4)
- ✅ 0-2ms latency
- ✅ Time-stretching (tempo adjustment)
- ✅ Chop functionality (audio slicing)
- ✅ Buffer management and preloading

### Transport & Timing

- ✅ Real-time scheduling
- ✅ Polymeter support (independent time signatures per sequence)
- ✅ Global transport: `global.start()`, `global.stop()`
- ✅ Sequence control: `RUN()`, `LOOP()`, `MUTE()` (Unidirectional Toggle)
- ✅ Bar-quantized execution

### VS Code Extension

- ✅ Syntax highlighting (Audio DSL v3.0)
- ✅ Cmd+Enter execution
- ✅ Engine control commands
- ✅ Real-time feedback

<details>
<summary>Legacy implemented features (MIDI-Based / Deprecated)</summary>

### Parser (Phase 1)

- ✅ Global settings (key, tempo, meter, randseed)
- ✅ Sequence settings (bus, channel, meter, tempo, octave, etc.)
- ✅ Events (chords, single notes, rests)
- ✅ Duration syntax (@U0.5, @2s, @25%2bars, @[3:2]\*U1)

### Pitch/Bend conversion (Phase 2)

- ✅ Degree → MIDI note conversion (0=rest, 1=C, 2=C#...12=B)
- ✅ Octave/detune processing
- ✅ PitchBend calculation (bendRange support)
- ✅ MPE channel assignment

### Scheduler (Phase 3)

- ✅ Real-time playback (LookAhead=50ms, Tick=5ms)
- ✅ Shared/Independent meter
- ✅ Transport (Loop/Jump) bar-head quantization
- ✅ Mute/Solo functionality
- ✅ Window-based NoteOff management

</details>

## Testing

```bash
npm test
```

**225/248 tests passing (90.7%)**:

- Parser: ✅ Complete (50 tests)
- Audio Engine: ✅ Complete (15 tests)
- Timing Calculator: ✅ Complete (10 tests)
- Interpreter: ✅ Complete (83 tests)
- DSL v3.0: ✅ Complete (56 tests)
- Setting Sync: ✅ Complete (19 tests)
- Live Coding Workflow: ✅ Verified (manual testing)

**Note**: 23 tests skipped (SuperCollider integration tests require local environment).

## Getting Started

### Prerequisites

- macOS
- Node.js v22+
- SuperCollider
- VS Code

### Installation

```bash
npm install
npm run build
```

### Build Commands

```bash
# Regular build (incremental)
npm run build

# Clean build (recompile all files)
npm run build:clean
```

**Note**: For first-time builds or TypeScript incremental build issues, run `npm run build:clean`.

**VSCode Extension Build**:
```bash
cd packages/vscode-extension
npm run build          # Incremental build
npm run build:clean    # Clean build
```

### Basic DSL Syntax (Audio-Based v3.0)

```osc
// Global settings
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")  // Audio file base path

// Start global
global.start()

// Kick sequence
var kick = init global.seq
kick.beat(4 by 4).length(1)
kick.audio("kick.wav")
kick.play(1, 0, 1, 0)

// Snare sequence
var snare = init global.seq
snare.beat(4 by 4).length(1)
snare.audio("snare.wav")
snare.play(0, 1, 0, 1)

// Transport control
LOOP(kick)
RUN(snare)
```

<details>
<summary>Legacy MIDI syntax (for reference / Deprecated)</summary>

```osc
# Global settings
key C
tempo 120
meter 4/4 shared
randseed 42

# Sequence (piano)
sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 5/4 independent
  tempo 132
  octave 4.0
  octmul 1.0
  bendRange 2

  # Events
  (1@U0.5, 5@U1, 8@U0.25)  0@U0.5  3@2s  12@25%2bars
}
```

</details>

### VS Code Extension

1. Build the extension:

```bash
cd packages/vscode-extension
npm install
npm run build
```

2. Install in VS Code:
   - `Cmd+Shift+P` → "Developer: Install Extension from Location..."
   - Select `packages/vscode-extension` folder

3. Usage:
   - Open a `.osc` file
   - Execute with `Cmd+Enter`
   - Control transport with commands

## License

ISC

## Contributing

Contributions are welcome. Please see `INSTRUCTION_ORBITSCORE_DSL.md` and `IMPLEMENTATION_PLAN.md` for details.
