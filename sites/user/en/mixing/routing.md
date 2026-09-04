---
title: sum and aux/send
description: How to group sequences into a bus with sum, and send audio to a return bus with aux/send
---

# sum and aux/send

The previous chapter showed how to insert an effect on a single sequence. This chapter covers OrbitScore's two kinds of buses for working with multiple sequences at once: **sum (group bus)** and **aux (return bus)**.

## sum — Group Sequences Together

Declare a group bus with `global.sum(name)`, then send each sequence to it with `output(name)`.

```text
global.sum("drum")

kick.output("drum")
snare.output("drum")
```

You can insert an effect on a group bus too — for example, applying a single compressor after grouping several sequences together.

```text
sum("bus").effect("GlueComp")
```

You can also insert effects as a chain (array). See [Inserting Effects](./effects.md) for how to chain multiple plugins in series and how to use a built-in plugin such as `Gain(db: n)`.

The processing order is "per-sequence insert (`seq.effect()`) then group bus" — the same idea as "track insert then group track" in a DAW.

### Constraints on sum

- `sum` is a single level only — **you cannot nest a sum inside another sum**.
- The name you pass to `output(name)` must already be declared with `global.sum(name)`. An undeclared name is an error.
- **Audio and instrument sequences** can be sent to a sum bus with `output(name)`. A sequence created with `seq.midi()` targets an external device, so it has no mixer output and raises an error.

## aux / send — Send Audio Down a Separate Path

Declare a return bus with `global.aux(name)`, then send audio to it from each sequence with `send(name, amount)`. `send` copies the audio, so **the original signal is not removed** — it continues on to master (or its sum) as usual.

```text
global.aux("rev")
aux("rev").effect("TAL Reverb 4")

kick.send("rev", 0.3)
```

Inserting something like a reverb on a return bus (`aux`) is a typical use case. The second argument to `send()` controls how much signal is sent (roughly 0.0–1.0, with no hard clamp on the upper end).

::: danger The unit of the second argument will change to dB (decided, not yet implemented)
The 2026-09-03 specification revision (#611 / #649) **decided that the second argument to `send()` changes from a linear amount to dB** (core spec MX.3). The implementation has not landed yet, so **what you write today is still linear**.

Once it switches, `kick.send("rev", 0.3)` will be read as "**+0.3 dB**" (essentially unattenuated) rather than "linear 0.3 (about −10 dB)". **It will not raise an error — only the sound changes, silently.** If your existing scores use sends, wait for the switch to be announced.
:::

A single sequence can send to multiple `aux` buses at once.

```text
kick.send("rev", 0.3)
kick.send("delay", 0.2)
```

::: warning send() is not available on MIDI sequences
Just like `output()`, `send()` works on **audio and instrument sequences**. It cannot be used with `seq.midi()`.
:::

## Honest v1 Constraints

This feature is still evolving. Here are the constraints worth knowing before you rely on it.

::: warning No PDC (latency compensation)
If parallel paths (different `sum` or `aux` buses) each have effects with different latency, a small timing (phase) offset can appear between them. OrbitScore does not currently compensate for this automatically.
:::

::: warning send is fixed at post-fader (an implementation constraint)
`send()` always sends the signal **after** the per-sequence insert (`seq.effect()`) has been applied — what a DAW would call post-fader. Switching to pre-fader (sending the signal before the insert) is not currently supported.

This is now **a constraint of the current implementation, not a decision of the specification**. The 2026-09-03 revision (#611 / #649) removed "sends fixed post-fader" from the constraint list in core spec MX.5 and replaced it with: **where you write the send on the chain is where it taps** (before an effect = pre, after it = post). Position starts to matter once the implementation catches up.
:::

::: warning Cannot be combined with LinkAudio
If you use `global.linkAudio()`, you cannot also use mixer features (`sum` / `aux`, or plugin effects in general) at the same time. Declaring both is an error at declaration time.
:::

---

`sum` and `aux` pair naturally with effects ([Inserting Effects](./effects.md)). Next, let us look at `import`, which lets you build a project out of multiple files.

→ [Multi-File Projects](../projects/import.md)
