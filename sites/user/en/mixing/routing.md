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

sum("drum").output()    // 🔴 the bus needs its own output too (#883 / DSL 2.0)
```

You can insert an effect on a group bus too — for example, applying a single compressor after grouping several sequences together.

```text
sum("bus").effect("GlueComp")
```

You can also insert effects as a chain (array). See [Inserting Effects](./effects.md) for how to chain multiple plugins in series and how to use a built-in plugin such as `Gain(db: n)`.

The processing order is "per-sequence insert (`seq.effect()`) then group bus" — the same idea as "track insert then group track" in a DAW.

### Constraints on sum

- `sum` is a single level only — **you cannot nest a sum inside another sum**.
- When `output(name)` targets a sum bus, that name must already be declared with `global.sum(name)`. Destinations other than a declared bus can also be written — see "Destinations you can pass to output()" below.
- **Audio and instrument sequences** can be sent to a sum bus with `output(name)`. A sequence created with `seq.midi()` targets an external device, so it has no mixer output and raises an error.

## aux / send — Send Audio Down a Separate Path

Declare a return bus with `global.aux(name)`, then send audio to it from each sequence with `send(name, db)`. `send` copies the audio and **the line continues past it**. Since #883 / DSL 2.0, though, the main (dry) path reaches nothing unless an output is written after it — a line with only `send()` sounds the wet signal alone, so add `output()` if you want the dry as well (the editor flags this as `dry-not-routed`).

```text
global.aux("rev")
aux("rev").effect("TAL Reverb 4")

kick.send("rev", -12).output()    // wet to rev, dry to master
```

Inserting something like a reverb on a return bus (`aux`) is a typical use case. The second argument to `send()` is **how much signal is sent, written in decibels (dB)**. `0` matches the original level; `-12` is roughly a quarter of the amplitude.

::: danger The unit of the second argument changed from linear to dB (2026-09-10)
The second argument to `send()` used to be a linear amount (roughly 0.0–1.0). It is now **dB** (core spec MX.3 / #611).

So `kick.send("rev", 0.3)` is now read as "**+0.3 dB**" (about 1.035×, essentially unattenuated) rather than the former "linear 0.3 (about −10 dB)". **It does not raise an error — only the sound changes.** If your existing scores use `send()`, rewrite the second argument in dB (the equivalent of linear `0.3` is `-10.5`).

The named argument `amount:` has been **removed** and now raises an error. Use `db:` instead.
:::

To mute a send temporarily, write `enabled: false`. Its position on the chain is kept, so switching back to `true` restores it in place.

```text
kick.send("rev", -12, enabled: false)   // sends nothing; position preserved
```

A single sequence can send to multiple `aux` buses at once.

```text
kick.send("rev", -12)
kick.send("delay", -6)
kick.output()                     // keep the dry as well (without it, only the wet sounds)
```

::: warning send() is not available on MIDI sequences
Just like `output()`, `send()` works on **audio and instrument sequences**. It cannot be used with `seq.midi()`.
:::

## The Order You Write Is the Order of Processing

`effect()`, `gain()`, `pan()`, `send()` and `output()` line up **in the order you write them, on one audio line**. The same method placed at a different position produces a different result.

```text
kickA.output("rev", thru: true).effect([Gain(db: -12)])   // rev receives the signal BEFORE the gain
kickB.effect([Gain(db: -12)]).output("rev", thru: true)   // rev receives the signal AFTER the gain
```

The `thru:` option on `output()` decides whether the line ends there.

- `thru: false` (the default) = **terminal**. The line ends, and anything written after it is not reached
- `thru: true` = **tap**. The signal is copied to that destination and the line continues

`send(name, db)` is shorthand for `output(name, thru: true, db: db)`. Either spelling gives the same result.

Both `output()` and `send()` can appear more than once on one line.

```text
kick.output("rev", thru: true, db: -12).output("master")
```

🔴 **A line with no `output()` anywhere is silent.** No implicit `output("master")` is appended (#883 / DSL 2.0). The outputs are exactly the ones the text spells out.

```text
kick.audio("k.wav").play()             // 🔴 silent (no output)
kick.audio("k.wav").play().output()    // to master
```

The editor warns about a sounding sequence whose output you forgot before you even evaluate it — see "When You Forget to Write an Output" at the end of this chapter.

### Destinations you can pass to output()

| Spelling | Meaning |
|---|---|
| `output("master")` | The master track (a reserved word) |
| `output("name")` | A declared `sum` bus **or `aux` bus** |
| `output("3,4")` | Physical output channels 3 and 4 |
| `output(variable)` | A mixer node declared as e.g. `var cue = mix.output(3, 4)` |
| `output("name")` | A name that matches none of the above is a LinkAudio channel name (when `global.linkAudio()` is declared) |

Names resolve **top to bottom** in that order. LinkAudio channel names come last, so `"master"` and declared bus names cannot be used as LinkAudio channel names.

::: warning A mixer node cannot be named `master`
Writing `var master = mix.output(1, 2)` is an error: `master` is a reserved word for the master track. Use another name, for example `var mainOut = mix.output(1, 2)`.

Also, `mix.output(1, 2)` names **physical device channels 1 and 2** — not the master track.
:::

## Buses Accept output() / send() / gain() / pan() Too

A `sum` or `aux` bus has its own audio line, just like a sequence. Alongside `effect()` and `ui()`, it accepts `output()`, `send()`, `gain()` and `pan()`.

```text
sum("drum").gain(-3).output("master")
sum("drum").send("rev", -18)
```

## When You Forget to Write an Output

A line with no output at all is silent, so "I forgot to write it" and "I meant it to be silent" sound exactly the same. The editor therefore tells you before you evaluate.

| What you get | When | Severity |
|---|---|---|
| `output-missing` | A sounding sequence has no `output()`, no `send()`, and no bus-name reference at all | Warning |
| `dry-not-routed` | Every `send()` goes to an aux, and the main (dry) path has no output | Information |

Both come with an "add `<name>.output()`" quick fix (the light bulb). The one on `output-missing` is the preferred action.

A sequence that declares `midi()` is exempt: MIDI goes to external gear, so it has no mixer output.

::: warning sum / aux buses need an output too
The same rule applies to buses. Declaring `global.sum("drum")` and routing sequences into it is not enough — **the bus itself goes nowhere**.

```text
global.sum("drum")

kick.output("drum")
snare.output("drum")

sum("drum").output()        // 🔴 without this, the drum bus is silent
```
:::

## Honest v1 Constraints

This feature is still evolving. Here are the constraints worth knowing before you rely on it.

::: warning No PDC (latency compensation)
If parallel paths (different `sum` or `aux` buses) each have effects with different latency, a small timing (phase) offset can appear between them. OrbitScore does not currently compensate for this automatically.
:::

::: tip The post-fader-only constraint on send is gone (2026-09-10)
`send()` used to be fixed at post-fader — it always sent the signal after the per-sequence insert (`seq.effect()`). As described in "The Order You Write Is the Order of Processing" above, **where you write the send on the chain is now where it taps** (before an effect = pre, after it = post).
:::

::: warning Cannot be combined with LinkAudio
If you use `global.linkAudio()`, you cannot also use mixer features (`sum` / `aux`, or plugin effects in general) at the same time. Declaring both is an error at declaration time.
:::

---

`sum` and `aux` pair naturally with effects ([Inserting Effects](./effects.md)). Next, let us look at `import`, which lets you build a project out of multiple files.

→ [Multi-File Projects](../projects/import.md)
