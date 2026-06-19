# OrbitScore

**Live-coding music DSL with a SuperCollider audio engine and MIDI output**

Write `.orbs` patches and play them with `Cmd+Enter`. OrbitScore drives both a SuperCollider audio engine (sample playback) and MIDI output (Pitch DSL, chords, comp, Ableton Link). Version 2.0.0 is the released state.

## Core Features (2.0.0)

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

### 🎹 MIDI & Pitch (2.0.0)

- **MIDI Output**: Degrees/notes resolve to MIDI notes + velocity, emitted to a CoreMIDI / IAC virtual port
- **Pitch DSL**: Musical pitch via scale degrees, chords, voicing, mode, and expression
- **comp**: Automatic accompaniment — voice-leading (C1) + comp rhythm (C2a)
- **Ableton Link Audio (LinkAudio)**: OrbitScore as the Link tempo leader; Ableton Live follows OrbitScore's tempo
- **quantize**: Bar-quantized scheduling control

### 🔧 Technical Features

- **0-2ms Latency**: SuperCollider audio engine
- **VS Code Extension**: Syntax highlighting and live execution
- **macOS Optimized**: CoreAudio integration

## Current Implementation Status

**2.0.0 is released.** OrbitScore 2.0.0 is a dual-output live-coding DSL:

- **MIDI output** — degrees/notes resolve to MIDI notes + velocity, emitted to a CoreMIDI / IAC virtual port
- **Pitch DSL** — scale degrees, chords, voicing, mode, and expression (DSL_VERSION 1.1)
- **comp** — automatic accompaniment: voice-leading (C1) + comp rhythm (C2a)
- **Ableton Link Audio (LinkAudio)** — OrbitScore as the Link tempo leader (Ableton Live follows OrbitScore's tempo)
- **quantize** — bar-quantized scheduling control
- **Audio foundation** — scsynth sample playback (WAV/AIFF/MP3/MP4), `.chop()` slicing, time-stretching, polymeter, `RUN()`/`LOOP()`/`MUTE()` transport, bundled scsynth

**Supported platforms**: macOS Apple Silicon (arm64). Intel x86_64 untested. Windows / Linux not supported currently.

See [WORK_LOG.md](docs/development/WORK_LOG.md) for detailed resolution notes.

<details>
<summary>Development history (audio phases, ICMC release, legacy MIDI phases)</summary>

### Audio-Based Implementation Phases

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1-3** | ✅ Complete | Parser, Interpreter, Transport System |
| **Phase 4** | ✅ Complete | VS Code Extension (Syntax, Commands, IntelliSense) |
| **Phase 5** | ✅ Complete | Audio Playback Verification |
| **Phase 6** | ✅ Complete | Live Coding Workflow |
| **Phase 7** | ✅ Complete | SuperCollider Integration (0-2ms Latency) |

**Phase 7 Achievements**:
- ✅ SuperCollider audio engine (replaced sox)
- ✅ 0-2ms latency (was 140-150ms)
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

### ICMC v1.1.0 bundle release (Epic #131)

`.vsix` install だけで音が鳴る + tag push で全 channel に自動 publish:

| Issue | Status | Description |
|-------|--------|-------------|
| #136 | ✅ Merged ([PR #155](https://github.com/signalcompose/orbitscore/pull/155)) | scsynth + 26 plugins + libsndfile bundle (~11.5MB), strict path resolver, first-run UX |
| #137 | ✅ Merged ([PR #157](https://github.com/signalcompose/orbitscore/pull/157)) | GitHub Actions release workflow (Marketplace + Open VSX + GitHub Release) |
| #139 | ✅ Closed (吸収 in #155) | LICENSE.GPL-3.0 verbatim + NOTICE aggregation clause |
| #146 | ✅ Closed (吸収 in #155) | First-run check / status bar / settings override |
| #138 | ⏳ Pending | Cold-install acceptance test on SC-less macOS (manual verification) |

### Legacy pre-2.0 MIDI phases (historical)

The pre-audio MIDI-based implementation (Phases 1-5) is preserved for historical reference.

- ✅ **Phase 1** - Parser implementation
- ✅ **Phase 2** - Pitch/Bend conversion (degree → MIDI note + PitchBend, octave/octmul/detune/MPE)
- ✅ **Phase 3** - Scheduler + Transport (real-time playback, Loop/Jump, Mute/Solo)
- ✅ **Phase 4** - VS Code extension (syntax highlighting, Cmd+Enter execution, Transport UI)
- ✅ **Phase 5** - MIDI output implementation (CoreMIDI / IAC Bus)

</details>

## Technology Stack

- TypeScript
- VS Code Extension API
- SuperCollider (scsynth + supercolliderjs)
- OSC (Open Sound Control)
- MIDI output (CoreMIDI / IAC virtual port)
- Ableton Link (LinkAudio tempo sync)

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
│   └── *.orbs                # Sample files
└── README.md                # This file
```

## Development Status

### Completed Phases (2.0.0)

See [`docs/development/IMPLEMENTATION_PLAN.md`](docs/development/IMPLEMENTATION_PLAN.md) for details.

- ✅ **Phase 1-3** - Parser, Interpreter, Transport System
- ✅ **Phase 4** - VS Code Extension (Syntax, Commands, IntelliSense)
- ✅ **Phase 5** - Audio Playback Verification
- ✅ **Phase 6** - Live Coding Workflow
- ✅ **Phase 7** - SuperCollider Integration (0-2ms Latency)

<details>
<summary>Pre-2.0 phases (historical)</summary>

- ✅ **Phase 1** - Parser implementation
- ✅ **Phase 2** - Pitch/Bend conversion (degree → MIDI note + PitchBend, octave/octmul/detune/MPE)
- ✅ **Phase 3** - Scheduler + Transport (real-time playback, Loop/Jump, Mute/Solo)
- ✅ **Phase 4** - VS Code extension (syntax highlighting, Cmd+Enter execution, Transport UI)
- ✅ **Phase 5** - MIDI output implementation (CoreMIDI / IAC Bus)

</details>

## 📚 Documentation

### Learning Sites (web)

- 🎓 [User Learning Site (ja)](https://signalcompose.github.io/orbitscore/) — beginner-friendly tutorial
- 🎓 [User Learning Site (en)](https://signalcompose.github.io/orbitscore/en/)
- 🛠️ [Dev Learning Site (ja)](https://signalcompose.github.io/orbitscore/dev/) — implementation reading notes (personal)
- 🛠️ [Dev Learning Site (en)](https://signalcompose.github.io/orbitscore/dev/en/)

### Project documentation (in-repo)

Project documentation is organized in the [`docs/`](docs/) folder:

- 📏 [PROJECT_RULES.md](docs/core/PROJECT_RULES.md) - Project rules (must-read)
- 📝 [WORK_LOG.md](docs/development/WORK_LOG.md) - Development history
- 🎵 [INSTRUCTION_ORBITSCORE_DSL.md](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) - Language specification (Single Source of Truth)
- 🗺️ [IMPLEMENTATION_PLAN.md](docs/development/IMPLEMENTATION_PLAN.md) - Implementation plan
- 🧪 [TESTING_GUIDE.md](docs/testing/TESTING_GUIDE.md) - Testing guide
- 📚 [INDEX.md](docs/core/INDEX.md) - Documentation index (overall structure)

### User Documentation

Current user docs live at the **User Learning Site**:

- 🎓 [User Learning Site (ja)](https://signalcompose.github.io/orbitscore/) — beginner-friendly tutorial
- 🎓 [User Learning Site (en)](https://signalcompose.github.io/orbitscore/en/)

In-repo USER_MANUAL files are **deprecated** (historical reference only):
- [USER_MANUAL.md (ja)](docs/user/ja/USER_MANUAL.md) — deprecated, see learning site above
- [USER_MANUAL.md (en)](docs/user/en/USER_MANUAL.md) — deprecated, see learning site above

## Implemented Features (2.0.0)

### 🎹 MIDI & Pitch (2.0.0 pillars)

- ✅ MIDI output — degrees/notes → MIDI notes + velocity, emitted to CoreMIDI / IAC virtual port
- ✅ Pitch DSL — scale degrees, chords, voicing, mode, expression
- ✅ comp — automatic accompaniment: voice-leading (C1) + comp rhythm (C2a)
- ✅ Ableton Link Audio (LinkAudio) — OrbitScore as Link tempo leader; Live follows OrbitScore's tempo
- ✅ quantize — bar-quantized scheduling control

### Parser & Interpreter

- ✅ Global settings (`GLOBAL`, `tempo()`, `beat()`, `audioPath()` — variadic / array, with `~/` expansion and TidalCycles-style sample bank lookup `audio("bd:2")` since v1.2.1)
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

- ✅ Syntax highlighting (2.0.0)
- ✅ Cmd+Enter execution
- ✅ Engine control commands
- ✅ Real-time feedback

<details>
<summary>Legacy pre-2.0 MIDI-pitch internals (historical)</summary>

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

**1129 passed, 23 skipped (1152 total) — 2.0.0**

Run `npm test` to see the current breakdown. 23 tests are skipped (SuperCollider integration tests require a local environment).

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

### Basic DSL Syntax

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

MIDI/Pitch DSL examples (degrees, chords, comp) live in `examples/` and the [User Learning Site](https://signalcompose.github.io/orbitscore/).

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
   - Open a `.orbs` file
   - Execute with `Cmd+Enter`
   - Control transport with commands

## License

Signal compose Source-Available License v1.0 — see [LICENSE](LICENSE) for details.

Summary:
- **Base**: Apache License 2.0
- **Commons Clause**: Reselling the Software as a competing product is not permitted.
- **Fair Revenue Clause**: Organizations with annual revenue exceeding $250,000 USD require a commercial license when using the source code commercially.
- **Academic Exception**: Students, faculty, and staff of accredited academic institutions may use the Software at no cost.

Packaged binary products (Steam, App Store, Gumroad, etc.) are distributed under separate end-user license terms accompanying each product.

Commercial licensing inquiries: license@signalcompose.com

Copyright (c) 2026 Signal compose Inc.

## Contributing

Contributions are welcome. Please see `INSTRUCTION_ORBITSCORE_DSL.md` and `IMPLEMENTATION_PLAN.md` for details.
