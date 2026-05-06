# OrbitScore

Live coding music DSL for VS Code with a bundled SuperCollider audio engine.

Write `.orbs` patches and run them line by line with `Cmd+Enter`. No separate SuperCollider install required.

## Supported Platforms

**macOS (Apple Silicon)** only as of v1.x.

| OS / Arch | Status |
|---|---|
| macOS Apple Silicon (arm64) | ✅ Supported |
| macOS Intel (x86_64) | ⚠️ Untested (bundled binary is universal but not actively verified) |
| Windows / Linux | ❌ Not supported in v1.x |

Cross-platform support is tracked as a future effort.

## Quick Start

1. Open or create a `.orbs` file (a starter template is in [examples/](https://github.com/signalcompose/orbitscore/tree/main/examples))
2. Run **OrbitScore: Start Engine** (status bar shows `OrbitScore: Ready`)
3. Select code (or place the cursor on a line) and press `Cmd+Enter`

The status bar item `✅ scsynth (bundled)` confirms the audio engine is using the bundled SuperCollider binary.

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
- Bundled `scsynth` (~11.5 MB, no manual SuperCollider install)

## Commands

| Command | Description |
|---|---|
| `OrbitScore: Start Engine` | Boot the audio engine |
| `OrbitScore: Run Selection` | Execute selected text or current block (`Cmd+Enter`) |
| `OrbitScore: Stop Engine` | Stop the engine |
| `OrbitScore: Start Engine (Debug)` | Boot with verbose logging |
| `OrbitScore: Select Audio Device` | Pick an output device interactively |
| `OrbitScore: Force Kill scsynth` | Escape hatch — force-kill any orphan `scsynth` processes |
| `OrbitScore: Configure Flash` | Customize line-flash visual feedback |

## Settings

| Setting | Default | Description |
|---|---|---|
| `orbitscore.scsynthPath` | `""` | Override path to a custom `scsynth` binary. Leave empty to use the bundled scsynth (recommended). |
| `orbitscore.flashCount` | `3` | Number of times to flash executed lines (1–5) |
| `orbitscore.flashDuration` | `150` | Duration of each flash in milliseconds (50–500) |
| `orbitscore.flashColor` | `selection` | Color theme for flash (`selection` / `error` / `warning` / `info` / `custom`) |
| `orbitscore.flashCustomColor` | `#ff6b6b` | Custom flash color (hex) when `flashColor` is `custom` |

## Troubleshooting

### Status bar shows `❌ scsynth: not found`

The bundled `scsynth` could not be located. Try:

1. Reinstall the extension (the `.vsix` may be corrupted or partially installed)
2. Or set `orbitscore.scsynthPath` in your VS Code settings to a system `scsynth` binary, e.g. `/Applications/SuperCollider.app/Contents/Resources/scsynth`
3. Open `View → Output → OrbitScore` to see the resolver's failure reason

### Engine starts but no sound

- Run **OrbitScore: Select Audio Device** and pick the correct output device
- The selected device is saved to `.orbitscore.json` in your workspace root
- Restart the engine after changing the device

### Engine crashes on boot

- Check `View → Output → OrbitScore` for stderr from `scsynth`
- A common cause is sample-rate mismatch when the input device differs from the output device. Forcing input channels off (`numInputBusChannels: 0`) is already enabled by default.

## Links

- 📦 [Download the latest `.vsix`](https://github.com/signalcompose/orbitscore/releases) — GitHub Releases
- 🐛 [Report an issue](https://github.com/signalcompose/orbitscore/issues)
- 📖 [Source code](https://github.com/signalcompose/orbitscore) — Contributions welcome
- 📜 License: Signal compose Fair Trade License (extension), GPL-3.0 (bundled SuperCollider), LGPL-2.1 (bundled libsndfile). See `engine/scsynth/NOTICE` for details.
