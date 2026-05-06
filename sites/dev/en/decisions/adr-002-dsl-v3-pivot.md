---
title: "ADR-002 DSL v1 (MIDI) → v3 (Audio) pivot"
chapter-id: "adr-002"
verified-against: 0a4b598
verified-at: "2026-05-05"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-05-05. The code is the truth; this page is merely a snapshot of understanding at that point in time.

# ADR-002 DSL v1 (MIDI) → v3 (Audio) pivot

The OrbitScore DSL has gone through three major versions to reach the current v3.0. These version number changes are not merely sequential — each represents an important design turning point. This chapter unpacks the flow of v0.1 → v1.0 → v2.0 → v3.0 from the DSL specification and commit history.

**Important**: Although the ADR title says "v1 → v3 pivot," there are actually three stages of change. **v1 → v2 is the largest pivot (MIDI → Audio)**, and v2 → v3 is a refinement of DSL syntax. This chapter covers all three changes.

---

## Table of Contents

1. [Overview of Version History](#overview-of-version-history)
2. [v0.1 → v1.0: the Completed Form of the MIDI Base](#v01-v10-the-completed-form-of-the-midi-base)
3. [v1.0 → v2.0: the MIDI → Audio Pivot (the Largest Transition)](#v10-v20-the-midi-audio-pivot-the-largest-transition)
4. [v2.0 → v3.0: Refinement of DSL Syntax](#v20-v30-refinement-of-dsl-syntax)
5. [Alignment with the Paper](#alignment-with-the-paper)
6. [Trade-off of Lost Features](#trade-off-of-lost-features)
7. [Outline of the v1.0 MIDI DSL Specification](#outline-of-the-v10-midi-dsl-specification)
8. [Comparison with v3.0 Current DSL](#comparison-with-v30-current-dsl)

---

## Overview of Version History

`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` has the official record in the Versioning section:

| Version | Date | Main Changes |
|---|---|---|
| v0.1 | 2024-09-28 | Initial draft specification |
| v1.0 | 2024-12-25 | Core implementation complete, 100% test coverage (MIDI + Parser + Interpreter) |
| v2.0 | 2025-01-06 | **SuperCollider integration, MIDI deprecated** |
| v3.0 | 2025-01-09 | Underscore prefix pattern + unidirectional toggle |

From v1.0 to v2.0 is **only 12 days**, and from v2.0 to v3.0 is **3 days** — a dense sprint.

> NOTE: unverified — the dates above (v1.0: 2024-12-25, v2.0: 2025-01-06, v3.0: 2025-01-09) are dates listed in the `INSTRUCTION_ORBITSCORE_DSL.md` specification, but they may not match the timestamps of the git commit history. The "version declaration date" in the spec and the "commit date" can differ; verifying directly against the commit log may reveal inconsistencies. For exact implementation timing, consult the commit log.

---

## v0.1 → v1.0: the Completed Form of the MIDI Base

v1.0 is the version that completed as a "MIDI-output-based music DSL." The basic concepts of the DSL (Parser, Interpreter, time calculator) were assembled, and test coverage reached 100%.

The central concepts of the v1.0 DSL are the **degree system** and the **sequence keyword**:

```
// Example v1.0 DSL (from docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md)
sequence kick {
  bus "IAC Driver Bus 1"
  channel 10
  meter 4/4 shared
  1 0 1 0   // 度数: 1=キック音、0=休符
}
```

Features:
- The original musical abstraction of **degree 0 = rest**
- MIDI bus name and channel are specified directly
- Polyrhythm/polymeter expression via `meter N/D shared|independent`
- Block description with the `sequence` keyword

Notes from the header of the archive file (`docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md:1-12`):

> アーカイブ日: 2025-10-06
> 理由: v2.0でSuperCollider Audio Engineに移行（MIDIベースからオーディオベースへ）

---

## v1.0 → v2.0: the MIDI → Audio Pivot (the Largest Transition)

v1.0 → v2.0 is the largest design pivot for OrbitScore. MIDI output was replaced by audio file playback.

The Migration Notes from the DSL specification:

> **Migration Notes from v1.0 to v2.0**:
> - MIDI output system has been completely replaced with SuperCollider audio engine
> - Old MIDI DSL syntax is no longer supported
> - All audio playback now goes through SuperCollider for professional-grade timing and quality

This pivot is an incompatible change. The `sequence` keyword in v1.0 was deprecated and replaced by the new syntax `var seq = init global.seq`. The very concept of MIDI bus / channel specification disappeared, and instead WAV/AIFF/MP3 file paths are specified.

New features in v2.0:
- Professional-grade timing via the SuperCollider audio engine (0-8 ms drift)
- Global mastering effects: compressor, limiter, normalizer
- dB-based gain control (-60 to +12 dB)

> NOTE: unverified — the decision-making process from v1.0 to v2.0 (why MIDI was abandoned and what discussions occurred) is not currently preserved in commit messages or PR discussions. On the timeline, the sox → SuperCollider migration (the change handled in ADR-001) and the v1.0 → v2.0 DSL update happened around the same time, suggesting that "since SuperCollider became usable, we switched to audio output" was the natural flow.

---

## v2.0 → v3.0: Refinement of DSL Syntax

v3.0 is an improvement of DSL expressiveness on top of the audio engine foundation. There are two major changes.

### 1. The Underscore Prefix Pattern (Setting vs. Application)

In v2.0, even when configuration methods were called, "when they take effect" was unclear. v3.0 introduced an explicit rule:

```js
// Setting-only methods (no underscore)
seq.audio("file.wav")     // Set audio file (no playback)
seq.play(1, 0, 1, 0)      // Set play pattern (no playback)

// Immediate application methods (with underscore)
seq._audio("file.wav")    // Set audio file AND apply immediately
seq._play(1, 0, 1, 0)     // Set play pattern AND start playback immediately
```

- `method()`: stores the value but does not apply immediately (buffered until the next `run()` / `loop()`)
- `_method()`: stores the value **and applies it immediately** (when swapping a running loop in live coding)

This distinction is important for live coding. At setup time, you can stack settings with `audio()` / `chop()` / `play()` and start them all together with `loop()`. To swap a loop during a performance, you can apply `_play()` instantly.

### 2. Unidirectional Toggle

v3.0 unified the semantics of multi-sequence control of `RUN()`, `LOOP()`, and `MUTE()` to "unidirectional toggle":

```js
LOOP(seq1, seq2)    // Set seq1 and seq2 in the loop group (anything previously looping stops)
LOOP(seq2, seq3)    // Switch to seq2 and seq3 (seq1 stops automatically)
MUTE(seq2)          // Mute seq2 (seq1 is unmuted)
```

- Each command "completely replaces the current group with this list"
- The `STOP` keyword is removed (instead, pass an empty list to `LOOP()`, or switch to a different sequence)
- The `UNMUTE` keyword is removed (indirectly unmute by `MUTE()`-ing a different sequence)

This allows you to always explicitly declare "which sequences are running" during live coding.

---

## Alignment with the Paper

DSL design changes are closely tied to the presentation at ICMC (International Computer Music Conference).

The v1.0 degree system (0=rest, 1-12=chromatic) was a concept that could be written up in a paper as an original academic contribution. However, by pivoting to audio file playback in v2.0, the axis of "polyrhythm representation via the degree system" became thinner, and the axis of "high-precision scheduling of audio samples and a live coding environment" became stronger.

> NOTE: unverified — the final positioning of the paper (which aspects to claim as academic contributions) cannot currently be confirmed from the publicly available documents. The status of the ICMC presentation is described in the README as "ICMC v1.1.0 release-ready."

---

## Trade-off of Lost Features

There are features that disappeared in the v1.0 → v2.0 pivot:

| v1.0 feature | Status | Notes |
|---|---|---|
| MIDI bus/channel specification | **deprecated** | replaced by audio file playback |
| Degree system (0-12) | **deprecated** | pitch expression changed to WAV file selection |
| Microtonal expression (`1.5`, etc.) | **deprecated** | reimplementation possible in SuperCollider but not yet implemented |
| `meter N/D shared|independent` | **continues in changed form** | renamed to `beat(N by D)`; the polymeter concept is preserved |
| MPE mode | **deprecated** | a MIDI-dependent feature |

On the other hand, features **newly gained** in v2.0:
- Direct playback of WAV / AIFF / MP3 / MP4
- Audio slicing via `chop()`
- dB-based gain control
- Global mastering effects (compressor, limiter, normalizer)
- Seamless pattern swapping during live coding

Also, `updateDiagnostics()` in v3.0 has a warning implementation for remnants of v1.0 MIDI syntax. Lines containing the `sequence ` keyword are highlighted with `DiagnosticTag.Deprecated`:

```typescript
// packages/vscode-extension/src/extension.ts:1244-1253
    // Check for deprecated syntax (old MIDI DSL)
    if (line.includes('sequence ') && !line.includes('//')) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(i, 0, i, line.length),
        'Deprecated: Use "var seq = init GLOBAL.seq" instead of "sequence"',
        vscode.DiagnosticSeverity.Warning,
      )
      diagnostic.tags = [vscode.DiagnosticTag.Deprecated]
      diagnostics.push(diagnostic)
    }
```

A trace of implementation history that, when opening v1.0-era code, displays a warning in strikethrough style.

---

## Outline of the v1.0 MIDI DSL Specification

A quote from the archive (`docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md`). Kept for the contrast of how different the current v3.0 is.

v1.0 global settings:
```
key C
tempo 120
meter 4/4 shared
randseed 42
```

v1.0 sequence definition:
```
sequence kick {
  bus "IAC Driver Bus 1"
  channel 10
  meter 4/4 shared
  1 0 1 0   // 度数: 1=C音、0=休符
}
```

Event notation:
- `1` → C (MIDI note)
- `2` → C#
- `0` → rest (silence)
- `1.5` → between C and C# (microtone, expressed via pitch bend)
- `1r` → a random value in [C+0, C+0.999]

---

## Comparison with v3.0 Current DSL

| Aspect | v1.0 (MIDI) | v3.0 (Audio) |
|---|---|---|
| Output | via MIDI bus | SuperCollider + WAV files |
| Sequence definition | `sequence name { ... }` | `var seq = init global.seq` |
| Note expression | degrees 0-12 | none (pitch is determined by file selection) |
| Rhythm expression | implicitly defined by a degree sequence | `.chop(N)` + `.play(...)` pattern |
| Multi-sequence control | none (no description) | `RUN()`, `LOOP()`, `MUTE()` unidirectional toggle |
| Immediate application | none | `_method()` underscore pattern |
| File reference | none | `.audio("file.wav")` |

In v3.0, "which sound to play" is determined by the file name, and "at what timing" is determined by `chop()` and `play()`. The aspect of "pitch sequencing" that the v1.0 degree system handled has been replaced by an audio-sampler-like approach.

---

## Related Terms

- [DSL (Domain-Specific Language)](/en/glossary#dsl) — the subject of this ADR. Evolution from v1.0 MIDI DSL to v3.0 Audio DSL
- [Underscore Prefix Pattern](/en/glossary#underscore-prefix-pattern) — the distinction between `method()` vs `_method()` introduced in v3.0
- [Unidirectional Toggle](/en/glossary#unidirectional-toggle-single-side-toggle) — the `RUN()` / `LOOP()` / `MUTE()` semantics in v3.0
- [RUN](/en/glossary#run) — the unidirectional-toggle one-shot playback command introduced in v3.0
- [LOOP](/en/glossary#loop) — the unidirectional-toggle loop command introduced in v3.0
- [MUTE / UNMUTE](/en/glossary#mute--unmute) — v3.0 deprecated the `UNMUTE` keyword and unified to the unidirectional-toggle scheme
- [sequence (legacy keyword)](/en/glossary#sequence-legacy-keyword) — the `sequence name { }` syntax in v1.0. Deprecated in v2.0. Warned with `DiagnosticTag.Deprecated`
- [init](/en/glossary#init) — the syntax `var seq = init global.seq` that replaced the `sequence` keyword in v2.0
- [ICMC (International Computer Music Conference)](/en/glossary#icmc-international-computer-music-conference) — the presentation goal closely tied to DSL design changes

## Related ADRs

- [ADR-001 Choosing SuperCollider as the Implementation Base](/en/decisions/adr-001-supercollider) — the decision to adopt the audio engine that supported the v1.0 → v2.0 pivot (MIDI → Audio)
- [ADR-003 scsynth Bundle Strict Mode](/en/decisions/adr-003-scsynth-bundle) — the distribution strategy for scsynth that powers the post-v2.0 Audio DSL

## Next Exploration Candidates

- Excavating the decision record of the v2.0 pivot — confirm whether detailed discussion remains in PR or commit bodies
- Feasibility of reimplementing the degree system — whether sample playback with pitch modulation can be realized using SuperCollider SynthDefs
- Current support status of `randseed` — whether the randomness control in v1.0 is carried over to v3.0
- Implementation details of polymeter — whether the independent time base in `beat(N by D)` is equivalent to v1.0's `meter N/D independent`
- Treatment of the v1.0 degree system in the paper — whether deprecated features are included as academic contributions in the paper

---

## Sources

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:734-769` — the Versioning section: change history of v0.1-v3.0 and Migration Notes
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:362-415` — the v3.0 underscore prefix pattern specification
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:233-257` — the unidirectional toggle specification
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` — the v1.0 MIDI DSL specification archive (archived 2025-10-06)
- `packages/vscode-extension/src/extension.ts:1244-1253` — implementation of the deprecation warning for the `sequence ` keyword
- commit `081a474` — the SuperCollider integration and sox abolition (the technical foundation of v2.0)
- commit `cfa0381` — Web Audio API removal and consolidation on SuperCollider (PR #31)
