---
title: Installation
description: How to install the OrbitScore VS Code extension via the .vsix file
---

# Installation

OrbitScore runs as an extension for VS Code. This chapter walks you through installing the extension and verifying that it works.

## System Requirements

Before you begin, please make sure your environment meets the following conditions.

| Item | Status |
|---|---|
| macOS Apple Silicon (Macs with M1, M2, M3, etc.) | Supported |
| macOS Intel (x86_64) | May work in some cases, but unverified |
| Windows / Linux | Not supported in v1 |
| VS Code or Cursor (version 1.99.0 or later) | Required |

::: info Nothing else to install
The extension bundles the audio engine (`orbit-audio-daemon`, written in Rust) along with
the binaries that host plugins. There is nothing else you need to install.
:::

## Installation Steps

### Step 1: Download the .vsix File

Open [GitHub Releases](https://github.com/signalcompose/orbitscore/releases) and download the latest `orbitscore-*.vsix` file.

### Step 2: Install the Extension in VS Code

You can install the downloaded `.vsix` file using any of the following three methods. Choose the one that suits you best.

#### Method A: Double-click the File

Double-click the downloaded `.vsix` file. VS Code opens automatically and the installation begins.

#### Method B: From the VS Code Command Palette

1. Launch VS Code
2. Open the command palette (`Cmd+Shift+P`)
3. Type `Extensions: Install from VSIX...` and select it
4. Choose the downloaded `.vsix` file

#### Method C: From the Command Line (Terminal)

Open a terminal and run the following command. Replace the `orbitscore-*.vsix` part with the actual file name.

```text
code --install-extension orbitscore-*.vsix
```

If you are using Cursor, type `cursor` instead of `code`.

### Step 3: Verify That It Works

Once the installation is complete, the OrbitScore status is displayed in the status bar (the blue bar) at the bottom of the VS Code window.

```
🎵 OrbitScore: Stopped
```

This appears first — the engine has not started yet. Click it to open the command list
and choose **Start Engine**. Once it starts, the text changes:

The contents shown in the status bar vary depending on the situation:

| Display | Meaning |
|---|---|
| `🎵 OrbitScore: Stopped` | The engine is stopped (the normal state before you start it) |
| `🎵 OrbitScore: Ready` | The engine is running and ready to evaluate |
| `🎵 OrbitScore: ▶️ Playing` | Playback is running |
| `🎵 OrbitScore: Ready 🐛` | Running in debug mode (the trailing 🐛 marks it) |

::: info Seeing only one indicator is normal
With the default engine, no extra indicator for the audio engine is shown. That is by
design — nothing is displayed when there is nothing wrong. (It appears only if you have
selected the legacy SuperCollider backend, or if the engine cannot be found.)
:::

## Future Plans

At present, the only supported way to install is downloading the `.vsix` file from GitHub Releases. In the future, direct installation from the VS Code Marketplace and Open VSX is planned as well.

## Next Step

Once the installation is verified, let us make your first sound.

→ [Your First Sound](./first-sound.md)
