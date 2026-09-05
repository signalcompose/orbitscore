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
| Output device | Chosen from **Output Device** (the OS default output when nothing is selected) |
| Sample rate | 48 kHz |
| Channels | Stereo (2ch) |

::: warning Not available yet
Changing the buffer size, changing the sample rate, and multi-channel output are not implemented.
:::

## Choosing an output device

Expand **Output Device** in the **Audio Engine Settings** view to list the devices you can use.
The selected device is marked with `●`. Choosing **System Default** returns to the OS default
output. Clicking the already-selected device deselects it and stops the engine.

Clicking a device while the engine is running switches to it in place — no stop and restart needed.

### When the device you chose produces no sound

On some devices the audio output can appear to open while no request for audio ever arrives.
Left alone that becomes "silence with no error at all", so the engine **first confirms that
requests for audio really arrive** before using the device. What happens when it cannot confirm
depends on **whether the engine is starting up or already playing**.

| When | What happens |
| --- | --- |
| Engine startup | It **starts on the OS default output instead** (you are never left in silence). The reason for the switch is written to the log |
| Switching while playing | The switch is **cancelled and the currently playing device is kept**. The sound does not stop |

When a switch is cancelled while playing, the reason is shown as a warning. Usually all you need
is to pick a different device, so **no restart is offered**. Only the following cases require a
restart, and the warning carries a **Restart Engine** button for them.

- Both the switch and the return to the original device failed (this is the only case where the sound has stopped)
- The device you switched to runs at a different sample rate
- A recording via `ORBIT_CAPTURE_WAV` was in progress (devices cannot be switched while recording)

