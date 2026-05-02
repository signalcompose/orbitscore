# OrbitScore VS Code Extension

VS Code extension for the OrbitScore music DSL.

## Supported Platforms

**macOS (Apple Silicon)** only as of v1.0.

| OS / Arch | Status | Notes |
|---|---|---|
| macOS Apple Silicon (arm64) | ✅ Supported | Tested target. Bundled scsynth runs natively. |
| macOS Intel (x86_64) | ⚠️ Untested | The bundled scsynth is a universal binary so it may work, but not actively verified. |
| Windows / Linux | ❌ Not supported | scsynth bundle ships only macOS binaries (`.dylib`, Mach-O). |

Windows / Linux support is tracked separately as a future cross-platform effort.

## Features

- **Syntax Highlighting**: Full syntax highlighting for `.osc` files
- **Run Selection**: Execute selected code with `Cmd+Enter`
- **Transport Controls**: Play, pause, stop, jump, and loop controls
- **Status Bar**: Shows current playback position and BPM
- **Diagnostics**: Real-time syntax error checking

## Commands

- `OrbitScore: Start Engine` - Start the OrbitScore engine
- `OrbitScore: Run Selection` - Execute selected text or entire file (Cmd+Enter)
- `OrbitScore: Stop Engine` - Stop the engine
- `OrbitScore: Transport Panel` - Open transport control panel

## Installation (Users)

Download the latest `orbitscore-*.vsix` from the [GitHub Releases](https://github.com/signalcompose/orbitscore/releases) page and either:

- Double-click the `.vsix` file (opens VS Code's install dialog), or
- In VS Code, run `Extensions: Install from VSIX...` and pick the file, or
- From the command line: `code --install-extension orbitscore-*.vsix`

**SuperCollider does not need to be installed separately** — the bundled `scsynth` (~11.5 MB) is shipped inside the `.vsix`.

## Installation (From Source — Developers)

1. Build the engine first:

```bash
cd packages/engine
npm install
npm run build
```

2. Build the extension:

```bash
cd packages/vscode-extension
npm install
npm run build
```

3. Optional: bundle scsynth (release builds only — requires `SuperCollider.app` installed on the dev machine):

```bash
npm run build:bundle
```

4. Install in VS Code:

- Open VS Code
- Press `Cmd+Shift+P`
- Run "Developer: Install Extension from Location..."
- Select the `packages/vscode-extension` folder

## Usage

1. Open a `.osc` file
2. Start the engine with `OrbitScore: Start Engine`
3. Select code and press `Cmd+Enter` to run
4. Use the transport panel for playback control

## Development

To develop the extension:

```bash
cd packages/vscode-extension
npm run dev  # Watch mode
```

Then press `F5` in VS Code to launch a new Extension Development Host window.
