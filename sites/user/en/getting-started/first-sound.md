---
title: Your First Sound
description: A step-by-step guide to playing your first sound with OrbitScore
---

# Your First Sound

Once you have installed the VS Code extension, it is time to make some sound. By the time you finish reading this chapter, you should hear a kick drum playing through your speakers or headphones.

## What You Will Need

- The OrbitScore VS Code extension installed (see [Installation](./installation.md))
- A folder containing a `.wav` audio file. For this chapter, a single kick (bass drum) sample is enough

If you do not have an audio file at hand, you can download a free kick sample from sites such as [freesound.org](https://freesound.org/). The file name does not matter, but this guide assumes the file is named `kick.wav`.

## Step 1: Create a Working Folder

Create a new folder anywhere you like. For example, you can create a folder called `orbitscore-practice` in your home directory.

Inside that folder, create a subfolder called `audio` and place `kick.wav` inside it.

```
orbitscore-practice/
└── audio/
    └── kick.wav
```

## Step 2: Open the Folder in VS Code

Launch VS Code and select **File → Open Folder...** from the menu, then open the `orbitscore-practice` folder you just created.

## Step 3: Create an `.orbs` File

Right-click in the file explorer of your working folder and select **New File**. Name the file `first-sound.orbs` (the extension must be `.orbs`).

## Step 4: Write the Code

Open `first-sound.orbs` and write the following code. You can copy and paste it.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var drum = init global.seq
drum.audio("kick.wav")
drum.play(1, 1, 1, 1)

LOOP(drum)
```

This is enough to instruct OrbitScore to "play the kick drum repeatedly for four beats."

What each line does is explained gently in [Building Patterns](../basics/patterns.md). For now, focus on getting sound out.

## Step 5: Run It

Select all of the code you wrote (`Cmd+A` on macOS, or `Ctrl+A` on Windows / Linux).

With the code still selected, press `Cmd+Enter` (or `Ctrl+Enter` on Windows / Linux).

After a brief moment, you should hear a repeating "thump, thump, thump, thump" through your speakers or headphones. You have just played a sound with OrbitScore.

## Stopping the Sound

To stop the sound, write the following on a new line:

```text
LOOP()
```

Place your cursor on that line and press `Cmd+Enter` again. This stops all loops.

## If You Do Not Hear Anything

There are a few possible causes. Check them in order.

### Is the `audioPath` Correct?

The `./audio` in `global.audioPath("./audio")` means "the `audio` folder located at the same level as the currently open `.orbs` file." If you used a different folder name or location, adjust the path accordingly.

You can also use an absolute path:

```text
global.audioPath("/Users/yourname/orbitscore-practice/audio")
```

### Is the `.wav` File in the Right Place?

Make sure `kick.wav` actually exists inside the `audio/` folder. Watch out for typos in the file name.

### Is the VS Code Extension Running?

The status bar at the bottom of the VS Code window should show `🎵 OrbitScore: Ready`. If it does not, click that part of the status bar to start the extension.

### Are Your Speaker / Headphone Settings Correct?

Make sure your operating system's audio output is set to the device you want to listen on.

If none of the above resolves the issue, please refer to [Troubleshooting](../troubleshooting.md).

## What Just Happened (a Brief Explanation)

Detailed explanations come in the following chapters, but in short:

- `var global = init GLOBAL` — Creates a "conductor" that manages overall tempo and time signature
- `global.tempo(120)` — Sets the tempo to 120 beats per minute
- `global.beat(4 by 4)` — Sets the time signature to 4/4
- `global.audioPath("./audio")` — Specifies the folder containing your audio files
- `global.start()` — Tells the conductor to start
- `var drum = init global.seq` — Creates a sequence (one unit of a sound pattern) named `drum`
- `drum.audio("kick.wav")` — Tells this sequence to play `kick.wav`
- `drum.play(1, 1, 1, 1)` — Defines a four-beat pattern that plays `kick.wav` on every beat
- `LOOP(drum)` — Starts the loop playback of `drum`

## Next Step

Now that you have heard your first sound, the next step is to build rhythm patterns.

→ [Building Patterns](../basics/patterns.md)
