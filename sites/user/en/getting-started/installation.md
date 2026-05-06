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

::: info Installing SuperCollider is not required
The OrbitScore extension comes with the audio engine (scsynth) bundled. You can start using it right away without installing SuperCollider separately.
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
🎵 OrbitScore: Ready     ✅ scsynth (bundled)
```

If both of these are shown, the installation has completed successfully.

The contents shown in the status bar vary depending on the situation:

| Display | Meaning |
|---|---|
| `✅ scsynth (bundled)` | The bundled audio engine is running (the normal state) |
| `⚙️ scsynth (custom)` | A user-specified audio engine is being used |
| `❌ scsynth: not found` | The audio engine cannot be found (see the workaround below) |

::: warning When `❌ scsynth: not found` is displayed
Please uninstall the extension once, download the `.vsix` file again, and reinstall it. If that does not resolve the issue, please refer to [Troubleshooting](../troubleshooting.md).
:::

## Future Plans

At present, the only supported way to install is downloading the `.vsix` file from GitHub Releases. In the future, direct installation from the VS Code Marketplace and Open VSX is planned as well.

## Next Step

Once the installation is verified, let us make your first sound.

→ [Your First Sound](./first-sound.md)
