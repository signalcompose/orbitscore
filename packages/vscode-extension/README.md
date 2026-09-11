# OrbitScore

Live coding music DSL for VS Code, with a native audio engine bundled inside the extension.

Write `.orbs` patches and run them with `Cmd+Enter`. Nothing else to install — the Rust audio
daemon (`orbit-audio-daemon`), the plugin hosts, and the standard plugins all ship in the `.vsix`.

## Install

OrbitScore is distributed as a `.vsix` on **[GitHub Releases](https://github.com/signalcompose/orbitscore/releases)**.
It is not published on the VS Code Marketplace or Open VSX.

1. Download `orbitscore-darwin-arm64-<version>.vsix` from the latest release
2. In VS Code: **Extensions** → `…` menu → **Install from VSIX…**, or from a terminal:

```bash
code --install-extension orbitscore-darwin-arm64-<version>.vsix
```

Updating works the same way — install the newer `.vsix` over the old one.

## Supported platforms

| OS / Arch | Status |
|---|---|
| macOS Apple Silicon (arm64) | ✅ Supported |
| macOS Intel (x86_64) | ❌ Not supported — the release builds an arm64-only `.vsix`, and Rosetta is not planned |
| Windows / Linux | ❌ Not supported |

## Quick start

1. Open or create a `.orbs` file (starter patches live in [examples/](https://github.com/signalcompose/orbitscore/tree/main/examples))
2. Open the **Audio Engine Settings** view in the activity bar and pick an output device
3. Run **OrbitScore: Start / Stop Engine** — the status bar shows `🎵 OrbitScore: Ready`
4. Select some code, or put the cursor on a line, and press `Cmd+Enter`

New to the DSL? Run **OrbitScore: Start the Walkthrough** for a guided tour inside the editor.

```orbitscore
var global = init GLOBAL
global.tempo(120).beat(4 by 4)

var kick = init global.seq
kick.audio("kick.wav").play(1, 0, 1, 0)

LOOP(kick)
```

## What you get

**Editing**

- Syntax highlighting, IntelliSense, and hover documentation for `.orbs`
- Real-time syntax diagnostics as you type
- Run a selection or the block under the cursor with `Cmd+Enter`, with a configurable line flash
- A per-sequence playhead that follows playback in the editor gutter
- A **Learning** view and an in-editor walkthrough

**Sound**

- Sample playback (WAV / AIFF / MP3 / MP4) with `chop(n)` slicing and sample-accurate scheduling
- Independent tempo and meter per sequence — polymeter falls out of the model
- Real-time `gain(dB)` and `pan()` that apply while a sequence is playing
- **Mixer / routing**: group buses (`sum`), aux buses and sends (`aux` / `send`)
- **Plugin hosting**: CLAP and VST3 effects and instruments, each in its own out-of-process
  child, with racks, plugin UIs opened from the score, and a scanned catalog with name completion

**Notes**

- **Pitch DSL** — scale degrees, chords, voicing, modes, ties and legato, per-note expression
- **MIDI output** to a CoreMIDI / IAC virtual port
- **comp** — automatic accompaniment with voice leading and comp rhythm

**Projects**

- `import { … } from "./file.orbs"` splits a set into several files. A plain single-file `.orbs`
  keeps working exactly as before

## Not in this build

Two DSL surfaces parse and run but do not do what their names suggest.

| Surface | What happens |
|---|---|
| `global.linkAudio()` / Ableton Link tempo push | **No LinkAudio, and nothing is audible under it.** Ableton Link is dual-licensed GPL / commercial, so enabling it would put GPL code into the shipped binary; the daemon feature is off by default and the release does not turn it on. The spec says the sound should fall back to the hardware output with one warning, but a real-machine measurement found silence and no warning, so **do not build a set on `global.linkAudio()`** |
| `global.compressor()` / `limiter()` / `normalizer()` | **No-ops.** The only implementation lived in the retired audio backend and has no replacement on the native engine. Put a CLAP / VST3 plugin on the master bus instead |

## Commands

| Command | Description |
|---|---|
| `OrbitScore: Start / Stop Engine` | Boot or stop the audio engine |
| `OrbitScore: Run Selection` | Execute the selection or the current block (`Cmd+Enter`) |
| `OrbitScore: Restart Engine (recovery)` | Stop and start again after a failure |
| `OrbitScore: Start Engine (Debug)` | Boot with verbose logging |
| `OrbitScore: Select Audio Device (Engine View)` | Choose the output device |
| `OrbitScore: Browse Plugins` | Browse the scanned CLAP / VST3 catalog |
| `OrbitScore: Rescan Plugin Catalog` | Re-scan installed plugins |
| `OrbitScore: Configure Flash Settings` | Customize the line-flash feedback |
| `OrbitScore: Start the Walkthrough` | Open the guided tour |
| `OrbitScore: Open Learning Site` / `Open Dev Docs` | Open the documentation sites |
| `OrbitScore: Register Claude Code MCP Server` | Wire the extension's MCP server into an agent |

## Settings

| Setting | Default | Description |
|---|---|---|
| `orbitscore.audioDevice` | `""` | Output device. Empty means none selected; `"__default__"` uses the OS default output |
| `orbitscore.engineDebug` | `false` | Start the audio engine in debug mode |
| `orbitscore.flashCount` | `3` | Times to flash executed lines (1–5) |
| `orbitscore.flashDuration` | `150` | Flash duration in milliseconds (50–500) |
| `orbitscore.flashColor` | `selection` | Flash color theme (`selection` / `error` / `warning` / `info` / `custom`) |
| `orbitscore.flashCustomColor` | `#ff6b6b` | Custom flash color when `flashColor` is `custom` |
| `orbitscore.playheadPalette` | 32 colors | Playhead highlight colors; sequences are assigned from this list |
| `orbitscore.mcpServer.port` | `0` | Port for the MCP control server. `0` disables it. Development and agent integration only |

## Troubleshooting

**Status bar shows `daemon: not found`**

The bundled `orbit-audio-daemon` could not be located.

1. Reinstall the extension — the `.vsix` may be partially installed
2. Or build it yourself (`cd rust && cargo build --release`) and point `ORBIT_AUDIO_DAEMON_PATH` at the binary
3. Open **View → Output → OrbitScore** for the resolver's failure reason

**The engine starts but there is no sound**

- Open **Audio Engine Settings** and select an output device. The choice is saved to `orbitscore.audioDevice`
- Restart the engine after changing the device

**The engine crashes on boot**

- Check **View → Output → OrbitScore** for the engine's stderr
- A common cause is a sample-rate mismatch when the input device differs from the output device

**A plugin does not load**

- Run **OrbitScore: Rescan Plugin Catalog**, then **Browse Plugins** to confirm it was found
- Plugin children run out of process, so an attach failure appears in the output channel rather
  than as an editor diagnostic

## Links

- 📦 [Releases](https://github.com/signalcompose/orbitscore/releases) — download the `.vsix`
- 🎓 [User guide (ja)](https://signalcompose.github.io/orbitscore/) / [(en)](https://signalcompose.github.io/orbitscore/en/)
- 🐛 [Report an issue](https://github.com/signalcompose/orbitscore/issues)
- 📖 [Source code](https://github.com/signalcompose/orbitscore)
- 📜 License: Signal compose Fair Trade License (extension)
