---
title: "Glossary"
chapter-id: "glossary"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

# Glossary

A reference page that consolidates the terms used throughout this site in one place. It serves as the anchor source for first-occurrence explanations in each chapter. Entries are ordered alphabetically within categories.

---

## DSL / Syntax Terms

### Underscore Prefix Pattern

A naming convention introduced in DSL v3.0. `method()` is configuration only (buffered until the next `run()` / `loop()`), while `_method()` applies immediately. Example: `seq.play(...)` vs `seq._play(...)`. For details, see [ADR-002](/en/decisions/adr-002-dsl-v3-pivot).

### Unidirectional Toggle (Single-Side Toggle)

The semantics used in `RUN()`, `LOOP()`, `MUTE()`. Executing the command "completely replaces the current group with this list." It has no `STOP` or `UNMUTE` keyword — an inclusion-only design. Introduced in DSL v3.0.

### chop

`seq.chop(N)` — divides an audio file into N equal slices. Subsequent `play()` then specifies which slice plays in what order. The default is N=1 (treats the entire file as a single slice).

### DSL (Domain-Specific Language)

"Domain-specific language." In OrbitScore, a language designed for music production and live coding. The file extension is `.orbs` and the language ID is `orbitscore`.

### global

A singleton object created with `var global = init GLOBAL`. It manages tempo, time signature, audio base path, and global mastering effects. The variable name does not have to be `global` — `g`, `master`, etc. are also fine.

### init

A keyword. Used in the form `var x = init GLOBAL` or `var seq = init global.seq`. On the TypeScript side, `InterpreterV2` recognizes the `init` token and creates the corresponding object.

### LOOP

A unidirectional-toggle transport command. `LOOP(seq1, seq2)` sets seq1 and seq2 as the loop playback group. Sequences that were previously LOOP'd stop automatically.

### MUTE / UNMUTE

A unidirectional-toggle mute command. When `MUTE(seq2)` mutes seq2, seq1 is automatically unmuted. The `UNMUTE` keyword was deprecated in v3.0.

### play pattern

A sequence of slice indices specified as in `seq.play(1, 0, 1, 0)`. `0` is a rest, and `N` (N ≥ 1) plays the n-th slice.

### RUN

A unidirectional-toggle transport command. `RUN(seq1, seq2)` sets seq1 and seq2 as the one-shot playback group. It maintains a group independent of LOOP.

### sequence (legacy keyword)

A keyword from DSL v1.0 (the MIDI phase). Sequences were defined in the form `sequence name { ... }`. It was removed from v2.0 onward and replaced by `var seq = init global.seq`. The VS Code extension's diagnostic feature shows a warning with `DiagnosticTag.Deprecated`.

### setDocumentDirectory

`global.setDocumentDirectory("path/to/dir")` — tells the engine the directory of the `.orbs` file. It is used as the base for resolving relative paths in `audioPath()` and `audio()`. The VS Code extension's `runSelection()` automatically injects it at the following timings:

- When evaluating a block containing `var global = init GLOBAL` (inserted right after the init)
- For any evaluation after the above init (prepended to the top of the code, also tracking `.orbs` file switches)

In the CLI (`playFile`), it is automatically derived from the `.orbs` file path.

There is no fallback to `process.cwd()`. If documentDirectory is unset and a relative path is specified, an explicit error is raised (absolute paths are always allowed).

### SoT (Single Source of Truth)

Single source of truth. In OrbitScore, the principle "code is the SoT" is upheld throughout. Documentation is a snapshot of the understanding of the code, and when documentation conflicts with code, the code is considered correct.

### subject-based block evaluation

The operating mode of `runSelection()`. It detects the subject (variable name) from the line at the cursor position, gathers all lines in that file with the same subject, and sends them as a unit to the engine. For details, see [IV-2](/en/editor/execution-feedback).

---

## Rust Engine / Daemon Terms

### orbit-audio-daemon

The binary in `rust/crates/orbit-audio-daemon`. It receives commands from the TS engine over WebSocket IPC (protocol v0.2) and produces audio through cpal. It has been the **default backend** since cutover #108 (2026-07-03, WORK_LOG 6.179), and `scripts/copy-daemon-bin.sh` bundles it into the `.vsix`. See [RE-1](/en/rust-engine/).

### AudioEngineBackend (backend seam)

The interface in `packages/engine/src/audio/engine-backend.ts`. It is the only contract the interpreter / scheduler have with an audio backend; both `SuperColliderPlayer` and `RustEnginePlayer` satisfy it. It carries `boot` / `quit` / `loadPlugin` / `applyEffectChain` / `setGlobalGain` / `pluginNoteOn`, and so on.

### ORBITSCORE_ENGINE

The environment variable that selects the backend. `sc` or `supercollider` opts out to the SuperCollider path; unset or anything else means the Rust daemon (`resolveEngineKind()` in `create-audio-engine.ts`). The VS Code setting `orbitscore.engine` maps to it.

### RustEnginePlayer / DaemonClient

The TS side of the Rust path. `packages/engine/src/audio/rust-engine/rust-engine-player.ts` acts as the `Scheduler` and builds PlayAt commands; `daemon-client.ts` sends them to the daemon over WebSocket. The `[STEP]` lines for the playhead are emitted here too.

### OOP child (out-of-process child)

A child process that runs a third-party plugin outside the daemon. There are `orbit-clap-effect-child` / `orbit-vst3-effect-child` / `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` / `orbit-effect-rack-child`; the daemon (`outproc_*.rs`) provides crash isolation and respawn. See [RE-2](/en/rust-engine/oop-children).

### shm transport (orbit-audio-sandbox)

The shared-memory transport between the daemon and a child. Audio blocks travel through a file-backed mmap SPSC ping-pong; note / UI events travel through the evt ring.

### insert bus (`seq-bus-<n>`)

The per-sequence insert bus used by `seq.effect()`. The daemon pre-allocates 8 inactive buses by default (`ORBIT_EFFECT_BUS_POOL`) and a declaration is the activation. The `seq-bus-` prefix is a contract shared by TS (`sequence-effect-manager.ts`) and Rust (`engine_wrap.rs`). See [RE-3](/en/rust-engine/insert-bus).

### sum bus / aux bus (`sum-bus-<n>` / `aux-bus-<n>`)

The mixer buses used by `global.sum()` / `global.aux()`. `SUM_BUS_PREFIX` / `AUX_BUS_PREFIX` in TS `mixer-manager.ts` must match the default pool prefixes in Rust `engine_wrap.rs`; v1 allows 4 of each at a time (`MIXER_BUS_POOL_SIZE`). See [SC-2](/en/signal-chain/mixer-audio-line).

### receiver id (`sum:<name>` / `aux:<name>`)

The prefixed identifier that addresses a mixer bus in plugin-state persistence (#564). `formatReceiverId()` and its parser are the only home of this wire format.

### capture seam (`ORBIT_CAPTURE_WAV`)

The mechanism that writes the daemon's post-mix output to a WAV file in realtime (`rust/crates/orbit-audio-native/src/capture.rs`). It is what the gated E2E's RMS / peak assertions measure; since #651 the header is patched periodically, so the file opens even after an abnormal exit. See [RE-4](/en/rust-engine/capture-verification).

### LinkAudio (orbit-link-audio)

Audio egress for Ableton Link. The GPL dependency is isolated in the `orbit-link-audio` crate and gated by `cargo-deny`. OrbitScore acts as the Link tempo leader (#283, #333).

---

## Plugin Hosting / Signal Chain Terms

### CLAP / VST3

The plugin formats OrbitScore hosts. There are in-process host libraries (`orbit-clap-host` / `orbit-vst3-host`) and the OOP children that wrap them. The format is decided by the file extension (PH.3).

### plugin catalog (`~/.orbitscore/plugin-catalog.json`)

The catalog written by `orbit-plugin-scan` (#463) after scanning CLAP / VST3 plugins. The DSL refers to plugins by bare name (PC.2); the editor uses it for completion and pre-evaluation diagnostics (#638). See [PH-3](/en/plugin-hosting/catalog).

### rack / RackRecipe

Writing a chain as a **value**, as in `var rack = [ ... ]` (SC.10, #628). `packages/engine/src/signal-chain/rack.ts` builds a `RackRecipe` out of `catalog` / `standard` / `layer` elements, and re-evaluation matches by diff. See [SC-1](/en/signal-chain/).

### standard plugin Gain (orbit-std-gain)

A CLAP plugin bundled as part of the language vocabulary (SC.10.8). Its dB contract is pinned by `tests/e2e/rack-chain-gain-expectations.ts` and CI.

### orbit-effect-rack-child

A rack child in which one process runs N stages (CLAP / macOS VST3) serially, so a rack does not spawn one child per element.

### seq.ui()

The DSL that opens a plugin's UI from the score (PH.2c; name form since #617 / #628). The UI runs on the child's main-thread AppKit runloop (`orbit-child-runtime`) and is governed by a close state machine (`orbit-child-ui`, where `Closed` is defined by a drain condition). See [PH-2](/en/plugin-hosting/plugin-ui).

### evt ring / dirty_epoch

The ring that carries UI / state events from child to daemon (#474 P2, WORK_LOG 6.337). `dirty` was taken out of the ring and carried as an epoch, sealing the ordering in the types.

### UiEventPump (per-window)

The daemon-side pump that drains UI events. #633 made it per-index / per-window, and measurement confirmed that several windows can be open at once with correct addressing.

---

## MCP / E2E Terms

### MCP server (inside the extension)

`packages/vscode-extension/src/mcp-server.ts`. A Streamable HTTP MCP server hosted in the Extension Host so an external agent (Claude Code, etc.) can drive OrbitScore. `ORBITSCORE_MCP_PORT` takes precedence over the `orbitscore.mcpServer.port` setting; it binds to 127.0.0.1 only. It descends from WCTM's Agent Bridge. See [IV-3](/en/editor/mcp-and-gated-e2e).

### gated E2E (`ORBIT_GATED_ORBITSTUDIO=1`)

`tests/e2e/orbitstudio-mcp-gated.spec.ts`. It launches the real OrbitStudio.app, drives it through MCP tool calls only, and judges by numbers from the captured WAV. The `pretest` of `npm run test:e2e:gated` builds the daemon automatically. Without the gate env, the suite is skipped.

### coverage ratchet

`tests/e2e/dsl-e2e-coverage.spec.ts`. It keeps a baseline of DSL words not yet covered by the real-device E2E; the test turns red if the list grows (it may only shrink).

### playhead / `[STEP]`

The feature that highlights `play()` arguments in step with the engine (#390). The extension (`playhead.ts`) turns `[STEP]` lines emitted by the engine into decorations. #654 wired it to instrument (MIDI) sequences as well.

### quantize (launch quantize)

`global.quantize("bar")` / `seq.quantize(...)` make `LOOP()` wait for the bar boundary before starting (#212, `quantize-manager.ts`). `RUN()` is always immediate.

---

## Audio / SuperCollider Terms (opt-out path)

> The terms below belong to the SuperCollider path, which is reached only by opting out with `ORBITSCORE_ENGINE=sc`. For the default path, see "Rust Engine / Daemon Terms" above.

### Buffer (SC)

In-memory audio data held by the SuperCollider server. WAV files are loaded onto the server with the `/b_allocRead` OSC message and held as Buffers. A reference (bufnum) to the Buffer is used for playback.

### OSC (Open Sound Control)

A communication protocol for music and multimedia. It runs over UDP/IP. The SuperCollider server runs as an OSC server and accepts messages such as `/s_new`, `/b_allocRead`, and `/d_recv`.

### orbitPlayBuf

The name of the dedicated SynthDef that OrbitScore registers with SuperCollider. It uses the `PlayBuf` UGen to play back audio buffers. It has the parameters `startPos`, `duration`, `rate`, `pan`, and `amp`.

### scsynth

The SuperCollider audio server binary. It accepts control via OSC/UDP, executes SynthDefs, and produces audio output. From v1.0 onward, it is bundled inside the `.vsix`.

### SynthDef (SC)

SuperCollider's sound synthesis definition. Expressed as a graph of UGens (Unit Generators). OrbitScore uses four: `orbitPlayBuf`, `fxCompressor`, `fxLimiter`, and `fxNormalizer`.

### UGen (Unit Generator)

The basic processing unit of SuperCollider. Examples include `PlayBuf`, `Pan2`, `Out`, `EnvGen`, and `Compander`, which are connected to compose a SynthDef. UGens are provided as `.scx` plugin files.

---

## VS Code Extension / Runtime Terms

### activate() / deactivate()

The VS Code extension lifecycle functions. `activate()` is called once when the extension is first loaded; it registers commands, status bar items, IntelliSense, and diagnostics. `deactivate()` is called when the extension is unloaded; it kills the engine process.

### activationEvents

A `package.json` field. Declares the triggers that activate the extension. OrbitScore uses two: `"onStartupFinished"` (always activated after VS Code starts) and `"onLanguage:orbitscore"` (when an `.orbs` file is opened).

### DiagnosticCollection

A VS Code API. Registers source-code errors and warnings as "diagnostics." They appear as red/yellow squiggles in the editor and in the Problems panel. In OrbitScore, `updateDiagnostics()` updates them on every keystroke.

### DiagnosticTag.Deprecated

A VS Code diagnostic tag. Ranges marked with this tag are displayed with strikethrough styling. In OrbitScore, it is applied to the `sequence ` keyword (a remnant of the v1.0 MIDI DSL).

### Extension Host

A dedicated Node.js process used by VS Code to run extensions. It is forked from the Renderer process (UI). It has no DOM access but can use Node.js APIs. The OrbitScore extension runs here, and further launches the engine process via `child_process.spawn`.

### flashLines()

The visual feedback function of `runSelection()`. It briefly flashes the executed line range in the editor. Implemented with `createTextEditorDecorationType` + a `setTimeout` loop. `flashCount` / `flashDuration` / `flashColor` are configurable.

### language ID (orbitscore)

The VS Code language ID assigned to `.orbs` files. IntelliSense, diagnostics, key bindings, and so on are scoped to operate only within the `orbitscore` language.

### MethodChainContext

An interface in `completion-context.ts`. Represents the state of the method chain at the cursor position (`hasAudio`, `hasChop`, `hasPlay`, `hasRun`, etc.) and is used by IntelliSense to return context-aware completion candidates.

### StatusBarItem

A VS Code API. Items displayed in the status bar at the bottom of the editor. OrbitScore uses two: engine state (priority 100) and scsynth resolution state (priority 99).

### workspace trust (untrustedWorkspaces)

VS Code's trust model. In an untrusted workspace an extension is restricted by default and `activate()` is never called. OrbitScore declares `supported: true` under `capabilities.untrustedWorkspaces` in `package.json` (#385), so it activates even in a folder-less loose-file launch. `restrictedConfigurations` lists only the 2 settings where "the workspace deciding the value makes a different executable run" (`orbitscore.scsynthPath` / `orbitscore.engine`).

---

## scsynth Resolver / Bundle Terms

### bundle (scsynth source)

One of the `ScsynthSource` values. The source identifier used when the scsynth binary bundled in the `.vsix` is used. It points to `<engine root>/scsynth/Contents/Resources/scsynth`.

### explicit (scsynth source)

One of the `ScsynthSource` values. Used when a user explicitly specifies a path via the `orbitscore.scsynthPath` setting. It is the resolver's highest priority.

### env (scsynth source)

One of the `ScsynthSource` values. Used when a path is specified via the `ORBIT_SCSYNTH_PATH` environment variable. It has lower priority than `explicit` and higher priority than `bundle`. Used during development to point to SC.app's scsynth.

### strict mode (scsynth resolver)

The operating mode of the scsynth path resolver. It has no implicit fallback to SC.app or Spotlight; if none of `explicit > env > bundle` is found, it throws `ScsynthNotFoundError`. A fail-loud design that does not silently hide bundle inclusion failures. For details, see [ADR-003](/en/decisions/adr-003-scsynth-bundle).

### ScsynthNotFoundError

The Error subclass thrown when scsynth is not found. The `searched` field holds "the list of paths that were searched but not found." The error message guides the user toward the workaround via `ORBIT_SCSYNTH_PATH`.

### ScsynthResolution

The return type of `resolveScsynthPath()`. It has three fields: `path` (the resolved binary path), `source` (`'explicit' | 'env' | 'bundle'`), and `searched` (the list of searched paths).

---

## Design / Process Terms

### ADR (Architectural Decision Record)

A document format for recording important architectural decisions. It records "what was chosen and why," "what alternatives existed," and "what trade-offs were involved." A format popularized by Michael Nygard. Stored in this site's `decisions/` directory.

### DDD (Documentation-Driven Development)

Documentation-Driven Development. An approach in which documentation is written (or updated) before implementation and is used as the single source of truth that drives implementation. In this project, the documents under `docs/core/` are the SoT.

::: info Confusingly identical acronym
In software engineering at large, "DDD" generally refers to **Domain-Driven Design** (Eric Evans). In this site, DDD means **Documentation-Driven Development**; the two are different concepts.
:::

### ICMC (International Computer Music Conference)

The annual international conference of the International Computer Music Association. OrbitScore is being developed targeting a presentation at ICMC, and the `v1.0 release-ready` milestone is part of that preparation.

### Phase B

The content writing phase of this site (the dev learning site). Phase A is chapter scaffolding (creating the table of contents in stub state); Phase B is the stage of promoting stubs to drafts. This document was entirely written in Phase B.

### stub → draft → reviewed → stable

The stages of a chapter's status. `stub` is table of contents and headings only, `draft` is body written, `reviewed` has been reviewed, and `stable` is a long-term stable version. Managed via the `status` frontmatter field.

---

## Next Exploration Candidates

- Enriching cross-references between terms — adding links from each chapter to the glossary
- Refining Polymeter / Polyrhythm terms — once the `scheduling/` chapters are complete, add notation details
- Adding Transport / Scheduler terms — terms related to `transport.ts` / `event-scheduler.ts`
- Protocol v0.2 command vocabulary — a per-command entry once RE-1's command table stabilises
- Pitch DSL / MIDI terms (degree, mode lattice, voicing, comp) — the MIDI pillar has no glossary entries yet

---

## Sources

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — DSL v3.0 specification (Single Source of Truth)
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` — v1.0 MIDI DSL archive
- `packages/vscode-extension/src/extension.ts` — activate(), flashLines(), updateDiagnostics()
- `packages/vscode-extension/src/completion-context.ts` — MethodChainContext interface
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts` — ScsynthResolution, ScsynthNotFoundError
- `packages/engine/src/audio/engine-backend.ts`, `create-audio-engine.ts` — AudioEngineBackend seam, ORBITSCORE_ENGINE
- `packages/engine/src/core/global/mixer-manager.ts` — SUM_BUS_PREFIX / AUX_BUS_PREFIX / MIXER_BUS_POOL_SIZE / formatReceiverId
- `packages/engine/src/signal-chain/rack.ts` — RackRecipe
- `packages/vscode-extension/src/mcp-server.ts`, `extension.ts` — MCP server, ORBITSCORE_MCP_PORT precedence
- `tests/e2e/orbitstudio-mcp-gated.spec.ts`, `tests/e2e/dsl-e2e-coverage.spec.ts` — gated E2E, coverage ratchet
- `rust/crates/*/Cargo.toml` — crate descriptions (children, hosts, scanner, std-gain)
- `docs/archive/WORK_LOG_2026-07.md` 6.179, 6.337 / `docs/archive/WORK_LOG_2026-08.md` 6.413–6.421 — cutover, evt ring, per-window pump, playhead
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` — survey of the bundle minimum set
- [SuperCollider OSC Command Reference](https://doc.sccode.org/Reference/Server-Command-Reference.html) — OSC message specifications such as `/s_new` and `/b_allocRead`
