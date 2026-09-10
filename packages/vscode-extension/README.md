# OrbitScore

Live coding music DSL for VS Code with a bundled native audio engine (Rust `orbit-audio-daemon`).

Write `.orbs` patches and run them line by line with `Cmd+Enter`. No separate audio-engine install required.

## Supported Platforms

**macOS (Apple Silicon)** only as of 2.0.0.

| OS / Arch | Status |
|---|---|
| macOS Apple Silicon (arm64) | ✅ Supported |
| macOS Intel (x86_64) | ⚠️ Untested (bundled binary is universal but not actively verified) |
| Windows / Linux | ❌ Not supported currently |

Cross-platform support is tracked as a future effort.

## Quick Start

1. Open or create a `.orbs` file (a starter template is in [examples/](https://github.com/signalcompose/orbitscore/tree/main/examples))
2. Run **OrbitScore: Start Engine** (status bar shows `OrbitScore: Ready`)
3. Select code (or place the cursor on a line) and press `Cmd+Enter`

The status bar item `✅ engine: rust (native)` confirms the native audio daemon is in use.

Minimal example:

```orbitscore
var global = init GLOBAL
global.tempo(120).beat(4 by 4)

var kick = init global.seq
kick.audio("kick.wav").play(1, 0, 1, 0)

LOOP(kick)
```

## Features

- Syntax highlighting for `.orbs` files
- Run selection with `Cmd+Enter` (single line or multi-line block)
- IntelliSense / hover for DSL keywords
- Real-time syntax diagnostics
- Status bar indicators for engine state and audio backend
- Bundled native audio daemon (`orbit-audio-daemon`) + out-of-process CLAP/VST3 host children

### New in 2.0.0

- **MIDI output** — scale degrees/notes resolve to MIDI notes + velocity, emitted to a CoreMIDI / IAC virtual port
- **Pitch DSL** — musical pitch via scale degrees, chords, voicing, mode, and expression
- **comp** — automatic accompaniment: voice-leading (C1) + comp rhythm (C2a)
- **Ableton Link Audio (LinkAudio)** — OrbitScore acts as the Link tempo leader; Ableton Live follows OrbitScore's tempo
- **quantize** — bar-quantized scheduling control

## Commands

| Command | Description |
|---|---|
| `OrbitScore: Start Engine` | Boot the audio engine |
| `OrbitScore: Run Selection` | Execute selected text or current block (`Cmd+Enter`) |
| `OrbitScore: Stop Engine` | Stop the engine |
| `OrbitScore: Start Engine (Debug)` | Boot with verbose logging |
| `OrbitScore: Configure Flash` | Customize line-flash visual feedback |

## Settings

| Setting | Default | Description |
|---|---|---|
| `orbitscore.audioDevice` | `""` | Output audio device to use. Empty means no device is selected; use `"__default__"` for the operating system default output. |
| `orbitscore.flashCount` | `3` | Number of times to flash executed lines (1–5) |
| `orbitscore.flashDuration` | `150` | Duration of each flash in milliseconds (50–500) |
| `orbitscore.flashColor` | `selection` | Color theme for flash (`selection` / `error` / `warning` / `info` / `custom`) |
| `orbitscore.flashCustomColor` | `#ff6b6b` | Custom flash color (hex) when `flashColor` is `custom` |

## Troubleshooting

### Status bar shows `❌ daemon: not found`

The bundled `orbit-audio-daemon` could not be located. Try:

1. Reinstall the extension (the `.vsix` may be corrupted or partially installed)
2. Or build it yourself (`cd rust && cargo build --release`) and set `ORBIT_AUDIO_DAEMON_PATH` to the binary
3. Open `View → Output → OrbitScore` to see the resolver's failure reason

### Engine starts but no sound

- Open the **Audio Engine Settings** view (activity bar) and pick the correct output device
- The selected device is saved to `orbitscore.audioDevice`
- Restart the engine after changing the device

### Engine crashes on boot

- Check `View → Output → OrbitScore` for stderr from the engine process
- A common cause is sample-rate mismatch when the input device differs from the output device. Forcing input channels off (`numInputBusChannels: 0`) is already enabled by default.

## Links

- 📦 [Download the latest `.vsix`](https://github.com/signalcompose/orbitscore/releases) — GitHub Releases
- 🎓 [User Learning Site (ja)](https://signalcompose.github.io/orbitscore/) — full feature docs (MIDI, Pitch DSL, comp, LinkAudio)
- 🎓 [User Learning Site (en)](https://signalcompose.github.io/orbitscore/en/)
- 🐛 [Report an issue](https://github.com/signalcompose/orbitscore/issues)
- 📖 [Source code](https://github.com/signalcompose/orbitscore) — Contributions welcome
- 📜 License: Signal compose Fair Trade License (extension).
