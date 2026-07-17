---
title: "Engine Settings"
---

# Engine Settings

OrbitScore's sound is produced by the **Audio Engine** (orbit-audio-daemon, written in Rust).
This chapter covers starting and stopping the engine, and what you can — and cannot yet —
configure.

## Starting and stopping the engine

Use the **Audio Engine Settings** view in the OrbitStudio Activity Bar.
You can also click **OrbitScore: Stopped** in the status bar (bottom right) and start it from the command list.

- **Start Engine** — starts the engine (always start it before live coding)
- **Start Engine (Debug)** — starts with verbose logging (for troubleshooting)
- **Stop Engine** — stops the engine

Once the engine is running, evaluating a `.orbs` file (run selection) can produce sound.

## Current audio output

| Item | Current state |
| --- | --- |
| Output device | Fixed to the **OS default output** (change it in your OS sound settings) |
| Sample rate | 48 kHz |
| Channels | Stereo (2ch) |

::: warning About output device selection
In-engine output device selection, buffer size, sample rate changes, and
multi-channel output are not implemented yet (in development — issue #484).
For now, switch the default output in macOS Sound settings to change where
audio goes.
:::

## Advanced: the SuperCollider backend

The default engine is Rust, but the environment variable `ORBITSCORE_ENGINE=sc`
switches to the legacy SuperCollider backend (for compatibility; normally not
needed). Only when SC is selected do the SC-specific commands (Select Audio
Device / Force Kill scsynth) appear in the Command Palette.

::: tip Verification
The statements in this chapter (Rust engine by default, 48 kHz, fixed system
default output) are based on behavior confirmed in a real-machine E2E test on
2026-07-17.
:::
