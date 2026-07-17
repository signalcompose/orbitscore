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
sum("bus").effect("./plugins/MyEffect.clap")
```

The processing order is "per-sequence insert (`seq.effect()`) then group bus" — the same idea as "track insert then group track" in a DAW.

### Constraints on sum

- `sum` is a single level only — **you cannot nest a sum inside another sum**.
- The name you pass to `output(name)` must already be declared with `global.sum(name)`. An undeclared name is an error.

## aux / send — Send Audio Down a Separate Path

Declare a return bus with `global.aux(name)`, then send audio to it from each sequence with `send(name, amount)`. `send` copies the audio, so **the original signal is not removed** — it continues on to master (or its sum) as usual.

```text
global.aux("rev")
aux("rev").effect("./plugins/Reverb.clap")

kick.send("rev", 0.3)
```

Inserting something like a reverb on a return bus (`aux`) is a typical use case. The second argument to `send()` controls how much signal is sent (roughly 0.0–1.0, with no hard clamp on the upper end).

A single sequence can send to multiple `aux` buses at once.

```text
kick.send("rev", 0.3)
kick.send("delay", 0.2)
```

## Honest v1 Constraints

This feature is still evolving. Here are the constraints worth knowing before you rely on it.

::: warning No PDC (latency compensation)
If parallel paths (different `sum` or `aux` buses) each have effects with different latency, a small timing (phase) offset can appear between them. OrbitScore does not currently compensate for this automatically.
:::

::: warning send is fixed at post-fader
`send()` always sends the signal **after** the per-sequence insert (`seq.effect()`) has been applied — what a DAW would call post-fader. Switching to pre-fader (sending the signal before the insert) is not currently supported.
:::

::: warning Cannot be combined with LinkAudio
If you use `global.linkAudio()`, you cannot also use mixer features (`sum` / `aux`, or plugin effects in general) at the same time. Declaring both is an error at declaration time.
:::

---

`sum` and `aux` pair naturally with effects ([Inserting Effects](./effects.md)). Next, let us look at `import`, which lets you build a project out of multiple files.

→ [Multi-File Projects](../projects/import.md)

::: tip Verification
The code examples in this chapter were confirmed working in a real end-to-end test run on 2026-07-17.
:::
