# OrbitScore VS Code Extension

VS Code extension for the OrbitScore music DSL.

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

## Installation

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

3. Install in VS Code:
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