---
title: Inserting Effects
description: How to insert plugin effects on a sequence or bus with seq.effect()
---

# Inserting Effects

So far, you have shaped sound using OrbitScore's built-in tools such as `gain()` and `pan()`. OrbitScore also lets you insert external plugin effects — compressors, reverbs, and so on — on a sequence. This chapter focuses on `seq.effect()`.

## seq.effect() — Insert an Effect on a Sequence

`effect(path)` inserts an effect that applies **only to that sequence**. It is the same idea as a "track insert" in a DAW.

```text
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("./plugins/MyEffect.clap")
```

The processing order is:

1. Per-sequence insert (`seq.effect()`)
2. Master mix
3. `global.effect()` (master chain, if configured)

`global.effect()` is covered elsewhere. Here, the important point is that you can insert effects at the sequence level.

### When the Plugin Loads, and What Happens on Failure

`effect()` loads the plugin at the moment you declare it. If the file cannot be found or the format is not supported, it fails immediately with an error. This avoids the situation where sound silently stays quiet without you noticing — there is no warn-and-continue path.

### v1 Allows One Effect per Sequence

In the current version, a sequence can have only one effect inserted at a time. Declaring the same path again does nothing (this keeps live coding re-evaluation from breaking things). Declaring a **different** path a second time is an error. Chaining multiple effects in series is planned for a future version.

```text
var drums = init global.seq
drums.audio("kick.wav")
drums.effect("./plugins/MyEffect.clap")
drums.effect("./plugins/MyEffect.clap")   // same path -> no-op (idempotent)
// drums.effect("./plugins/Other.clap")   // different path -> error
```

## Effects on sum / aux, Too

The same idea applies to group buses (`sum`) and return buses (`aux`) — you can insert effects on them as well.

```text
sum("bus").effect("./plugins/MyEffect.clap")
```

The details of `sum` and `aux` are covered in the next chapter, [sum and aux/send](./routing.md). For now, just note that buses take effects the same way sequences do.

## v1 Constraints

- Only **`.clap`** files are accepted. `.vst3` and `.component` are not yet supported.
- Paths can be full paths or relative paths.
- Selecting a plugin by name (with autocomplete) is still in progress (#463). For now, use a file path.

```text
drums.effect("~/plugins/TAL-Reverb-4.clap")   // full path
drums.effect("./plugins/MyEffect.clap")       // relative path
```

---

Next, let us look at `sum` and `aux/send`, which let you route multiple sequences together into buses.

→ [sum and aux/send](./routing.md)

::: tip Verification
The code examples in this chapter were confirmed working in a real end-to-end test run on 2026-07-17.
:::
