---
title: Playing a Plugin Instrument
description: How to host a CLAP / VST3 plugin as an instrument with seq.instrument() and play it using degree notation
---

# Playing a Plugin Instrument

So far, you have covered audio file playback with `seq.audio()` and sending notes to external MIDI hardware with `seq.midi()`. OrbitScore also lets you **host a CLAP / VST3 plugin instrument (a synthesizer or sampler) directly and play it**. Everything runs inside the engine, so you do not need to go through an external DAW.

## seq.instrument() — Declare a Plugin as an Instrument

```text
var piano = init global.seq
piano.instrument("Kontakt 8")     // catalog name
piano.octave(4).vel(96).gate(0.8)
piano.play(1, 3, 5, 0)            // values are degrees, same notation as MIDI output
```

- A sequence that declares `instrument()` becomes a "note sequence," and the values passed to `play()` are interpreted as degrees. This is the same semantics as `seq.midi()`. For the full details of degree notation, chords, and voicing, see [Pitch DSL (Degrees & Chords)](../midi/pitch-dsl.md).
- `.audio()` and `.midi()` are mutually exclusive with `.instrument()`. A sequence can have only one output (audio / MIDI / instrument).
- Supported formats are **CLAP** and **VST3**. `.component` (AU) is not yet supported.
- The same methods as MIDI sequences are available — `octave()`, `vel()`, `gate()`, `root()`, and so on (see [Reference](../reference/methods.md) for details).

## Selecting by Catalog Name or Path

There are two ways to specify a plugin.

```text
piano.instrument("Kontakt 8")                                    // catalog name (recommended)
piano.instrument("/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3")  // full path
```

Selecting by catalog name gives you autocomplete suggestions in the editor. When a plugin with the same name exists as both CLAP and VST3, CLAP takes priority. To select the VST3 version explicitly, prefix the format, as in `"vst3/Kontakt 8"`. When multiple vendors share a name, disambiguate the same way with a vendor prefix, as in `"Native Instruments/Kontakt 8"`.

::: tip When a catalog name does not show up in autocomplete
Run **"OrbitScore: Rescan Plugin Catalog"** from the Command Palette to rescan installed plugins. Try this if a plugin you just installed does not appear in autocomplete.
:::

## Saving and Restoring a Sound (State)

You can save and restore a sound you created with a plugin by passing a path ending in `.vstpreset` or `.state` as the second argument (or the third argument, when you also specify a pluginId). **This works with both CLAP and VST3** (#562).

```text
// catalog name + state (the extension identifies it as a state path)
piano.instrument("Kontakt 8", "./states/piano.state")

// path + pluginId + state (three arguments)
piano.instrument("/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3", "kontakt-8-id", "./states/piano.state")
```

The second argument is classified by its file extension alone. Anything ending in `.vstpreset` or `.state` is treated as a state path; any other string is treated as a pluginId. Relative paths are resolved against the directory of the file being edited.

## Each Sequence Gets an Independent Instance

Each sequence that declares `instrument()` gets its own independent plugin instance (an independent child process). **Declaring the same plugin on multiple sequences does not share the sound or parameters between them.**

```text
var vc = init global.seq
vc.instrument("Kontakt 8", "./states/cello.state")

var pf = init global.seq
pf.instrument("Kontakt 8", "./states/piano.state")   // a separate instance and sound from vc
```

Because each instance is its own child process, a crash in one instance does not affect the other sequences' sound (a crashed instance is restarted automatically).

## Swapping Live During a Performance

If you rewrite an `instrument()` declaration during a performance and re-evaluate it, the sound swaps without restarting the engine.

```text
piano.instrument("Kontakt 8", "./states/piano-a.state")
// swap to a different state during a live performance (takes effect on the next evaluation)
piano.instrument("Kontakt 8", "./states/piano-b.state")
```

- **Re-declaring the same content does nothing** (idempotent). This is so that re-evaluating the whole file during live coding does not interrupt the sound.
- **Re-declaring a different path / pluginId / state swaps the instrument.** The original sound keeps playing until the new instance finishes loading; if loading fails, the original sound is left intact.
- The current sound is saved automatically right before the swap. Re-evaluating the same declaration again restores that sound.

## Opening the Plugin UI

When you want to sculpt the sound in detail, `ui()` opens the plugin's own window.

```text
piano.ui()   // opens the instrument's UI (no arguments = instrument)
```

- **The no-argument form opens the instrument's UI.** A sequence has only one instrument, so no name is needed.
- Re-evaluating the score does not open a second copy of the UI (idempotent) — live coding assumes the same line gets re-evaluated repeatedly.
- To close an open UI, close the panel directly.

## v1 Constraints (Honest Disclosure)

- **`~` (detune) is not available.** The plugin path does not yet have pitch bend / CC, so it is skipped with a warning.
- **CC control, per-note expression, and tempo sync** are not implemented.
- **Offline render destinations (a numeric `output(1)`) are not supported.** Recording goes
  through a separate path, so specifying one raises an explicit error.
- **`output()` to a LinkAudio channel is not wired for instruments yet.**
- **Cannot be combined with `global.linkAudio()`** (an error at declaration time).
- Note timing has block-level precision (sample-accurate timing is future work).

---

Chaining multiple plugins in series ("chains"), and inserting effects on the master or on individual sequences, are covered in the next chapter.

→ [Inserting Effects](../mixing/effects.md)

::: tip A real-world example
A real work (a Kontakt string quintet plus piano, and a gong audio file) restores its performance sound using the `instrument(path, statePath)` form. It is a real example of using catalog names and state together.
:::
