---
title: Live Coding
description: The workflow for changing music by rewriting code while it is playing
---

# Live Coding

The biggest feature of OrbitScore is that **changes you make to your code while it is running are reflected in the sound right away**. There is no need to save the file; you select a line or block and "execute" it to change the sound. This technique is called "live coding."

This chapter pulls together the operations and the way of thinking you use during live coding.

## Executing With Cmd+Enter

The basic action in VS Code (or Cursor) is `Cmd+Enter` (`Ctrl+Enter` on Windows / Linux). Pressing this key executes one of the following, depending on the cursor position and selection state.

| State | What gets executed |
|---|---|
| You have text selected | Only the selected range is executed |
| Nothing is selected (the cursor is just placed on a line) | The entire "block" containing the cursor is executed |

A "block" is a group of lines separated by blank lines. For example, the following code is split into two blocks.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)
```

If you place the cursor anywhere in the first block (from `var global = …` to `global.start()`) and press `Cmd+Enter`, only that block is executed.

---

## Choosing Between LOOP, RUN, and MUTE

In OrbitScore, you control playback and stopping of sequences with three keywords: `LOOP`, `RUN`, and `MUTE`. They are all written in uppercase.

### LOOP — Repeated Playback

`LOOP(...)` plays the specified sequences in a loop. **Only what you place inside the parentheses keeps looping; everything else is stopped automatically.**

```text
// loop only kick
LOOP(kick)

// loop kick and snare (other sequences stop)
LOOP(kick, snare)

// stop all loops
LOOP()
```

The important point is "this replaces, it does not add." When you run `LOOP(kick, snare)`, anything that was running before — such as `hihat` — is stopped automatically.

### RUN — Play Once

`RUN(...)` plays the specified sequences exactly once. They do not loop and stop after they finish playing. You can use this for sound effects or fills.

```text
// play hihat once
RUN(hihat)

// play several sequences once each
RUN(kick, snare, hihat)
```

### MUTE — Silence the Sound

`MUTE(...)` mutes (silences) the specified sequences. The loop continues, but the sound is suppressed. Calling `MUTE()` with empty parentheses releases all mutes.

```text
// mute snare
MUTE(snare)

// mute snare and hihat
MUTE(snare, hihat)

// release all mutes
MUTE()
```

::: info MUTE only affects LOOP
`MUTE` only applies to sequences that are looping. Sequences played with `RUN` are outside the scope of `MUTE`.
:::

---

## A Practical Workflow

Let us walk through a live coding flow using the following code as an example.

```text
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)
global.audioPath("./audio")
global.start()

var kick = init global.seq
kick.beat(4 by 4).length(1)
kick.audio("kick.wav").chop(1)
kick.play(1, 0, 1, 0)

var snare = init global.seq
snare.beat(4 by 4).length(1)
snare.audio("snare.wav").chop(1)
snare.play(0, 0, 1, 0)

var hihat = init global.seq
hihat.beat(4 by 4).length(1)
hihat.audio("hihat_closed.wav").chop(1)
hihat.play(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
```

**Step 1**: Place the cursor in the global setup block and press `Cmd+Enter` to start the engine.

**Step 2**: Run each sequence definition block with `Cmd+Enter` in turn (this loads their settings, but no sound is produced yet).

**Step 3**: Write and run the following line.

```text
LOOP(kick)
```

The kick starts playing.

**Step 4**: Add and run the next line.

```text
LOOP(kick, snare)
```

The snare joins. The kick keeps looping as before.

**Step 5**: Add another line and run it.

```text
LOOP(kick, snare, hihat)
```

The three sequences loop together.

**Step 6**: Suppose you want to change the snare pattern. Find the snare definition block and rewrite the `play()` line.

```text
// before
snare.play(0, 0, 1, 0)

// after
snare.play(0, 0, 1, (1, 1))
```

If you place the cursor on this block and press `Cmd+Enter`, the sound does not change yet. The new setting has only been loaded. The next step applies it.

**Step 7**: Run the `LOOP(kick, snare, hihat)` line again. The new snare pattern now takes effect.

---

## The Underscore Prefix — Apply Changes Immediately

In Steps 6–7 above, you needed two steps: "execute the setup block" and then "re-execute LOOP." With methods that have the `_` (underscore) prefix, you can **apply the change in a single step**.

From DSL v3.0 onward, every setting method has two versions.

| Form | Behavior |
|---|---|
| `method(value)` | Just stores the setting (it is applied at the next `LOOP()` / `RUN()`) |
| `_method(value)` | Stores the setting and applies it immediately, starting playback |

### Example: play() vs _play()

```text
// changing the snare pattern during a loop

// without underscore: the value is set, but not yet applied
snare.play(0, 0, 1, (1, 1))
// → it only takes effect after you re-run LOOP(kick, snare, hihat)

// with underscore: it takes effect the moment you write and run the line
snare._play(0, 0, 1, (1, 1))
// → applied immediately when you press Cmd+Enter on this single line
```

When you want to change the sound quickly during live coding, methods like `_play()`, `_tempo()`, and `_length()` are useful.

### gain() and pan() Are Always Immediate

Volume (`gain()`) and stereo position (`pan()`) are special: they take effect immediately regardless of whether the underscore is present.

```text
// the following two are equivalent and both apply right away
kick.gain(-6)
kick._gain(-6)   // same effect
```

### Immediate Application of Global Settings

Using `global._tempo()` or `global._beat()`, you can change the global tempo or time signature immediately. The change is reflected in every sequence that inherits from the global.

```text
// change the tempo to 140 BPM immediately
global._tempo(140)

// change the time signature to 3/4 immediately
global._beat(3 by 4)
```

---

## Tips for Live Coding

**Add small pieces at a time**

Rather than writing everything and then executing, it is easier to grasp where the sound changed if you proceed line by line or block by block.

**Reset once with LOOP()**

When several sequences feel tangled, running `LOOP()` to stop everything and then restarting only what you need can clear things up.

```text
// stop everything
LOOP()

// restart only what you need
LOOP(kick, snare)
```

**Use MUTE for temporary silencing**

When you want to silence a particular sequence without stopping it, use `MUTE`. You can return to the previous state with `MUTE()`.

```text
MUTE(hihat)    // silence hihat
// ... play for a while ...
MUTE()         // unmute everything
```

---

## Summary

Here is a summary of what this chapter covered.

| Operation | Effect |
|---|---|
| `Cmd+Enter` | Execute the line, the selection, or the surrounding block |
| `LOOP(a, b)` | Loop a and b (everything else stops) |
| `LOOP()` | Stop all loops |
| `RUN(a)` | Play a once |
| `MUTE(a)` | Mute a |
| `MUTE()` | Release all mutes |
| `_method(value)` | Apply the setting immediately |
| `method(value)` | Store the setting (applied at the next LOOP / RUN) |

---

A quick lookup table for every method is on the next page.

→ [Reference (Method List)](../reference/methods.md)
