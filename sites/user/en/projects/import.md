---
title: Multi-File Projects
description: How to use import to assemble a project from multiple .orbs files
---

# Multi-File Projects

Up to this point, every chapter has kept everything in a single `.orbs` file. As a piece grows, you may want to split instrument setup and routing into separate files. OrbitScore's `import` lets you combine multiple files into a single running project.

The traditional single-file workflow, without `import`, still works exactly as before. `import` is an additional option, not a replacement.

## import Syntax

Write `import { name, name, ... } from "./file.orbs"`.

```text
// mod/drums.orbs
var global = init GLOBAL
var drums = init global.seq
drums.audio("./sine_880.wav")
drums.play(1)
```

```text
// main.orbs
import { drums } from "./mod/drums.orbs"

var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.sum("bus")
global.start()

drums.output("bus")

RUN(drums)
```

Inside `{ }`, list the names of the top-level `var` declarations from the file being imported. If a listed name does not exist in that file, it is an error.

### import Goes at the Top of the File

`import` statements must appear before the first non-import statement in the file.

```text
import { drums } from "./mod/drums.orbs"
import { bass } from "./mod/bass.orbs"

var global = init GLOBAL
// regular code continues from here
```

### How Paths Are Resolved

Paths must be relative, starting with `./` or `../`. They are resolved **relative to the directory of the file that contains the import statement**. Absolute paths and paths without a leading `./` are not allowed, and the `.orbs` extension cannot be omitted.

## The Role of a Module File — Declarations Only

A file that gets imported (a module) is treated as **declaration-only**. You can configure sequences and routing in it, but transport keywords such as `RUN`, `LOOP`, and `MUTE` are an error inside an imported file. Only the entry file — the file you actually open and run — owns transport control.

```text
// mod/drums.orbs — this part is fine
var global = init GLOBAL
var drums = init global.seq
drums.audio("./sine_880.wav")
drums.play(1)

// RUN(drums)   <- an error if placed inside a module
```

The reasoning behind this split: instruments and routing form the persistent "project structure," while tempo tweaks and turning loops on/off are "performance operations" you change constantly while live coding. OrbitScore separates these two roles between imported files and the entry file.

Note that if you open a module file directly and run it on its own, `RUN` / `LOOP` work as usual — the restriction only applies when the file is being imported.

## Path Resolution Inside audio()

If a module file writes a relative path such as `audio("./sine_880.wav")`, it is resolved **relative to the module file's own directory**, not the entry file's location. This keeps module files portable — you can move them around without breaking their internal paths.

## Name Matching and Re-evaluation

`import` treats declarations with matching names as the same instance. Importing the same file from multiple places does not initialize it twice (a circular import is an error). During live coding, re-evaluating the entry file re-reads every imported file each time, but a sequence with a matching name keeps its identity as the same running instance, which helps avoid audio dropouts.

If two different files happen to declare the same name, whichever definition is evaluated later gets applied to the shared instance. There is currently no mechanism to detect this kind of collision.

---

`import` pairs well with sum/aux routing ([sum and aux/send](../mixing/routing.md)) for keeping instruments and routing organized across files.

::: tip Verification
The code examples in this chapter were confirmed working in a real end-to-end test run on 2026-07-17.
:::
