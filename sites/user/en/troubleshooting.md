---
title: Troubleshooting
description: Common issues you may run into when using OrbitScore, with their solutions
---

# Troubleshooting

This page is the one to consult when something does not work. Please look for the symptom that matches your situation in the categories below.

## No Sound

### Have You Called `global.start()`?

In OrbitScore, the scheduler (the mechanism that manages timing) must be started before any sequence can run. If you forget to write `global.start()`, no sound is produced even when you execute the code.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()   // ← do not forget this

var drum = init global.seq
drum.audio("kick.wav")
drum.play(1, 1, 1, 1)

LOOP(drum)
```

### Is the `audioPath` Correct?

When you write a relative path such as `global.audioPath("./audio")`, the base for that path is "the location of the currently open `.orbs` file." If the folder location or file name differs, the audio file cannot be found and no sound is produced.

Using an absolute path (one written from the drive root) is more reliable:

```text
global.audioPath("/Users/yourname/orbitscore-practice/audio")
```

### Is the Audio File in the Right Place?

Please make sure the file specified by `audio()` actually exists inside the folder specified by `audioPath`. Watch out for typos in the file name as well.

### Check Your Speaker / Headphone Settings

Please make sure your operating system's audio output is set to the device you want to listen on. Also confirm that the system volume is not at 0.

---

## `Cmd+Enter` Does Not Work

### Is the File Extension `.orbs`?

Code execution in OrbitScore is only available inside files with the `.orbs` extension. `Cmd+Enter` does not function in files with other extensions like `.txt` or `.js`.

Please confirm the file name ends with `.orbs` in the VS Code tab.

### Is `🎵 OrbitScore: Ready` Shown in the Status Bar?

If the extension is not running, the command will not work. Please check the status bar at the bottom of the VS Code window. If `🎵 OrbitScore: Ready` is not shown, click that part of the status bar to start the extension.

---

## The Pattern Does Not Sound the Way You Expected

### Did You Write `LOOP()` Before `global.start()`?

If `LOOP()` or `RUN()` is executed before `global.start()` is called, the scheduler is not yet running, so they will not work correctly. Please make sure you call `LOOP()` or `RUN()` only after `global.start()` has been executed.

### Are You Mixing Up `beat()` and `play()`?

`global.beat()` is the method that sets the time signature (the number of beats in a bar). The rhythm pattern itself is defined by `play()`.

```text
// ❌ Wrong: writing a pattern in beat() does not produce a rhythm
// seq.beat("x___")  ← this does not work

// ✅ Correct: time signature is beat(); rhythm pattern is play()
global.beat(4 by 4)       // set 4/4 time signature
seq.play(1, 0, 0, 0)      // play only on beat 1
```

### Have You Changed the Tempo or Time Signature?

Depending on the default tempo and time signature, a pattern may sound slower or faster than you expected. Please write `global.tempo()` and `global.beat()` explicitly to confirm.

---

## `❌ scsynth: not found` Is Shown in the Status Bar

The OrbitScore extension comes with the audio engine (scsynth) bundled, but for some reason it cannot be found.

Please try the following in order:

1. **Reinstall the extension**
   Uninstall OrbitScore from the VS Code extensions list, download the `.vsix` file again from [GitHub Releases](https://github.com/signalcompose/orbitscore/releases), and reinstall it.

2. **Check the logs**
   Open **View → Output** from the VS Code menu and select **OrbitScore** in the dropdown to view the startup logs. Detailed error information may be shown there.

3. **Specify a system scsynth (advanced)**
   If you already have SuperCollider installed, you can specify the path to the system scsynth in the VS Code settings (`orbitscore.scsynthPath`):
   ```json
   {
     "orbitscore.scsynthPath": "/Applications/SuperCollider.app/Contents/Resources/scsynth"
   }
   ```

---

## Errors Related to audioPath

### What Is the Base for a Relative Path?

A relative path that starts with `./`, such as `global.audioPath("./audio")`, means "the `audio` folder in the same location as the currently open `.orbs` file." If your folder is in a different location from the `.orbs` file, using an absolute path can help avoid trouble.

### You Can Also Specify Files by Absolute Path Individually

Even without setting `audioPath`, you can pass an absolute path directly to `audio()`:

```text
var drum = init global.seq
drum.audio("/Users/yourname/audio/kick.wav")
drum.play(1, 1, 1, 1)
```

---

## scsynth Server Will Not Start ("Server failed to start" Error)

If port 57110 is already in use by another process, scsynth may fail to start.

Please open the VS Code command palette (`Cmd+Shift+P`) and run `OrbitScore: Force Kill scsynth`. This terminates the existing scsynth process. After that, click the status bar to start the engine again.

---

## When None of the Above Resolves the Issue

If you encounter a problem that is not described here, or if the steps above do not solve your issue, please report it on the GitHub issue tracker.

→ [GitHub Issues](https://github.com/signalcompose/orbitscore/issues)

When you report an issue, including the following information as much as possible helps the cause be identified more quickly:

- OS version (e.g., macOS 15.0 Apple Silicon)
- VS Code or Cursor version
- OrbitScore version
- The full text of any error messages
- Logs shown in `View → Output → OrbitScore`
