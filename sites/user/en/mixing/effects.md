---
title: Inserting Effects
description: How to insert plugin effects on a sequence or bus with seq.effect() / global.effect(), and how to chain multiple plugins together
---

# Inserting Effects

So far, you have shaped sound using OrbitScore's built-in tools such as `gain()` and `pan()`. OrbitScore also lets you insert external plugin effects — compressors, reverbs, and so on — on a sequence or a bus. This chapter focuses on `seq.effect()` and `global.effect()`.

## seq.effect() — Insert an Effect on a Sequence

`effect(spec)` inserts an effect that applies **only to that sequence**. It is the same idea as a "track insert" in a DAW.

```text
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("TAL Reverb 4")   // specified by catalog name
```

The processing order is:

1. Per-sequence insert (`seq.effect()`)
2. Master mix
3. `global.effect()` (master chain, if configured)

::: warning Not available on MIDI sequences
`seq.effect()` works on sequences declared with `seq.audio()` and `seq.instrument()`.
A sequence created with `seq.midi()` sends to an external device, so it has no mixer
output and declaring an effect raises an error.
:::

### When the Plugin Loads, and What Happens on Failure

`effect()` loads the plugin at the moment you declare it. If the file cannot be found or the format is not supported, it fails immediately with an error. This avoids the situation where sound silently stays quiet without you noticing — there is no warn-and-continue path.

## global.effect() — Insert on the Master

`global.effect(spec)` is a master bus insert that **applies to every sequence**.

```text
global.effect("TAL Reverb 4")
```

Like `seq.effect()`, it loads the plugin at the moment you declare it, and it fails the same way on error.

## Selecting by Catalog Name or Path

There are two ways to specify a plugin.

```text
drums.effect("TAL Reverb 4")                  // catalog name (recommended, gives autocomplete)
drums.effect("~/plugins/TAL-Reverb-4.clap")   // full path
drums.effect("./plugins/MyEffect.clap")       // relative path
```

When a plugin with the same name exists as both CLAP and VST3, CLAP takes priority. To select the VST3 version explicitly, prefix the format, as in `"vst3/TAL Reverb 4"`. When multiple vendors share a name, disambiguate the same way with a vendor prefix, as in `"TAL Software/TAL Reverb 4"`. A path specification never consults the catalog, so it also works for a plugin that is not registered in the catalog.

::: tip When a catalog name does not show up in autocomplete
Run **"OrbitScore: Rescan Plugin Catalog"** from the Command Palette to rescan installed plugins.
:::

Accepted formats are **`.clap`** and **`.vst3`**. `.component` (AU) is not yet supported.

## Chaining Multiple Plugins in Series

You can also pass an array to `effect()`. Plugins written in an array are **connected in series, in order from top to bottom**.

```text
drums.effect([
  "TAL Reverb 4",
  Gain(db: -6),
])
```

- Each array element is one of: a catalog plugin name (a string), a built-in plugin such as `Gain(db: n)`, or an argument form such as `plugin("name", enabled: false)`.
- **`effect("name")` (a single string) means exactly the same thing as `effect(["name"])`.** In other words, `effect(spec)` always declares "make the whole chain look like this" — it never appends.

```text
drums.effect(["TAL Reverb 4"])
drums.effect(["TAL Reverb 4", "ValhallaRoom"])   // pass the "whole picture" with ValhallaRoom added to Reverb 4
drums.effect(["ValhallaRoom"])                   // Reverb 4 is gone — only ValhallaRoom remains
drums.effect([])                                 // remove everything
```

### Removing an Effect Means Removing It From the Array and Re-evaluating

There is no dedicated removal method. **Removal means dropping the plugin you want to remove from the array and re-evaluating.** The sound (state) of a removed plugin is saved automatically right before it unloads, so writing it back into the array restores the same sound.

### Disabling — enabled: false

If you want to bypass a plugin temporarily without unloading it, use `plugin("name", enabled: false)`.

```text
drums.effect([
  plugin("TAL Reverb 4", enabled: false),   // pass-through (bypassed)
  "ValhallaRoom",
])
```

In a series chain, a plugin marked `enabled: false` passes the signal straight through. The plugin stays loaded with its state intact, so setting it back to `enabled: true` restores the same sound.

### Built-in Plugin — Gain

`Gain(db: n)` is a built-in plugin bundled with OrbitScore. It has no UI or state; every parameter is set directly in the DSL text.

```text
drums.effect(["TAL Reverb 4", Gain(db: -10)])
```

Built-in plugins are written as calls starting with a capital letter, so they never collide with catalog plugins (which are strings). Currently `Gain` is the only built-in plugin available.

### v1 Constraints

- **`layer([...])` (parallel combination) has its notation reserved but is not implemented — using it in v1 is an error.** Only series chains work.
- There is a limit on how many sequences can hold inserts at the same time (default 8). A declaration that exceeds the limit fails with an explicit error.
- There is no latency compensation (PDC) for plugins.

## Effects on sum / aux, Too

The same idea as `seq.effect()` / `global.effect()` applies to group buses (`sum`) and return buses (`aux`) — you can insert a chain of effects on them as well.

```text
sum("bus").effect(["TAL Reverb 4", Gain(db: -6)])
```

The details of `sum` and `aux` are covered in the next chapter, [sum and aux/send](./routing.md). For now, just note that buses take effects the same way sequences do.

## Opening a Plugin UI

When you want to sculpt the sound in detail, `ui()` opens the plugin's own window. Passing a name opens the UI of every plugin in the chain that matches it.

```text
drums.ui("TAL Reverb 4")          // opens the UI of every matching plugin
drums.ui("TAL Reverb 4", false)   // close it

sum("bus").ui("ValhallaRoom")     // also works on a sum bus's inserts
```

- When multiple plugins in the chain share the same name, **all of them open, without picking one** (this is deliberate, to avoid ambiguity).
- Built-in plugins (such as `Gain`) have no UI, so passing a built-in plugin's name is an explicit error.
- Zero matches is also an explicit error (nothing silently does nothing).
- Re-evaluating the score does not open an already-open UI a second time (idempotent).

---

Next, let us look at `sum` and `aux/send`, which let you route multiple sequences together into buses.

→ [sum and aux/send](./routing.md)
