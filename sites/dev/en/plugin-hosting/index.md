---
title: "PH-1. Plugin Hosting Overview"
chapter-id: "PH-1"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

# PH-1. Plugin Hosting Overview

OrbitScore hosts 3rd-party CLAP / VST3 plugins as **sandboxed out-of-process (OOP) children**.
This chapter surveys the whole picture — DSL syntax, the format support matrix, and how OOP
hosting works. The deeper internals are left to later chapters: the child-process transport and
shm layout to [RE-2](/en/rust-engine/oop-children), the plugin UI window wiring to
[PH-2](/en/plugin-hosting/plugin-ui), catalog-name resolution and replacement to
[PH-3](/en/plugin-hosting/catalog), and racks (writing a chain as a value) to
[SC-1](/en/signal-chain/).

This chapter was written on 2026-07-17 and re-read against commit `69dc968` on 2026-09-01. In
between, the DSL surface absorbed catalog names (#463), state restoration (#540), replacement
(#618 / #625), racks (#628) and plugin UI (#617 / #633); the TS-side managers were folded into a
shared foundation; and the effect side gained VST3 and a rack child.

## DSL syntax: the hosting surfaces

On 2026-07-17 there were two surfaces, `global.effect()` and `seq.instrument()`. The surfaces
defined by the core spec (PH.1–PH.6 / PC.* / MX.*) as of 2026-09-01 are as follows.

| DSL | role | spec | notes |
|---|---|---|---|
| `seq.instrument(spec[, pluginId][, statePath])` | per-sequence sound source; an independent instance per sequence | PH.1 / PH.4 | restore a sound with `.vstpreset` / `.state` (#540 P2, VST3 only). A different spec replaces in prepare-commit style (#618) |
| `global.effect(spec \| rack[, pluginId])` | master-bus insert | PH.2 | the single form desugars to a one-element rack; several use the array form `["A", Gain(db: -6)]` (#628, SC.10) |
| `seq.effect(spec \| rack[, pluginId])` | per-sequence insert ([RE-3](/en/rust-engine/insert-bus)) | PH.2b / PH.2d | a different spec replaces; removal = delete from the array (#625 → #628) |
| `sum(name).effect(...)` / `aux(name).effect(...)` | mixer bus inserts | MX.2 / MX.3 | [SC-2](/en/signal-chain/mixer-audio-line) |
| `seq.ui([name][, open])` | open / close a plugin UI window | PH.2c | no argument = the instrument's UI; every insert whose name matches is opened (#617 / #628) |
| catalog names (`effect("TAL Reverb 4")` / `"vendor/name"` / `"vst3/name"`) | resolve by name without writing a path | PC.2 | path-direct specs (starting with `./` `../` `~/` `/`, or ending in a known extension) still resolve as paths |

Whether `spec` is a path or a catalog name is decided by `isPluginPathSpec`. The audio-side rule
"contains `/` → path" is deliberately not reused — the vendor-qualified
`"TAL Software/TAL Reverb 4"` contains `/` but is a catalog name.

```typescript
// packages/engine/src/core/global/plugin-resolver.ts:68-80
const PATH_DIRECT_PREFIXES = ['./', '../', '~/', '/']

/**
 * PC.2 discriminator: path-direct specs start with `./`/`../`/`~/`/`/` or end with a known
 * plugin extension; everything else is a catalog name. Deliberately does NOT reuse audio's
 * `looksLikePath()` ("contains `/`" = path) — a vendor-qualified catalog name like
 * `"TAL Software/TAL Reverb 4"` contains `/` but is not a path.
 */
export function isPluginPathSpec(spec: string): boolean {
  if (PATH_DIRECT_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true
  const lower = spec.toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
```

## TS-side managers: four managers folded into one foundation

On 2026-07-17, `PluginInstrumentManager` and `PluginEffectManager` each duplicated ~15 lines of
"validate → LinkAudio gate → resolve → eager load → idempotent redeclaration". With #468 / #527
these were unified into `effect-slot.ts`'s `EffectChainMap` (the declaration registry with a
per-key serialization queue) and `BusPool`; `SequenceEffectManager` / `MixerManager` sit on the
same foundation.

The instrument side uses the "single instrument, legacy path" `EffectChainMap.declare()` and gives
each sequence the instance ID `plugin:<seqName>`.

```typescript
// packages/engine/src/core/global/plugin-instrument-manager.ts:53-91
  async instrument(
    seqName: string,
    spec: string,
    pluginId?: string,
    statePath?: string,
  ): Promise<void> {
    // 拡張子検証は path-direct spec にのみ適用する（#463 C2: カタログ名はここで弾かず、
    // resolvePluginSpec のカタログ解決に委ねる — effect-slot.ts の resolveEffectSpec と同型）。
    if (isPluginPathSpec(spec)) {
      validatePluginExtension(spec, 'instrument')
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolved = resolvePluginSpec(
      spec,
      pluginId,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    await this.slots.declare(
      seqName,
      {
        role: 'instrument',
        bus: undefined,
        normalizedName: normalizePluginInstanceName(spec),
        resolvedPath: resolved.path,
        pluginId: resolved.pluginId,
        // note 側 `resolveNoteTarget()` の port（`plugin:<seqName>`）と同じ規約。
        instance: `plugin:${seqName}`,
        // #540 P2: 保存済み state（音色）。相対パスは document directory 基準で解決する。
        statePath: statePath === undefined ? undefined : this.resolveStatePath(statePath),
      },
      () =>
        `Sequence '${seqName}' already has an instrument instance; replacing it requires the Rust engine backend.`,
    )
  }
```

The effect side is the rack path through `applyRack()`. `global.effect()` became remarkably short.

```typescript
// packages/engine/src/core/global/plugin-effect-manager.ts:49-61
  async effect(value: string | RackRecipe, pluginId?: string): Promise<void> {
    const recipe = toRackRecipe(value, pluginId)
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }
    const rack = resolveEffectRack(
      recipe,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      'global.effect() cannot be used while LinkAudio is enabled in v1.',
    )
    await this.slots.applyRack('master', rack)
    this.hasDeclared = true
  }
```

The order "validate → LinkAudio gate → resolve", which a 2026-07-17 comment called load-bearing,
moved into `resolveEffectSpec` and is still honored. A relative spec in an unsaved file (no
document context) makes `resolvePluginPath` throw a "cannot resolve" error; if that ran first, it
would mask the more relevant LinkAudio-conflict error. Since #463 C2 the extension check applies
only to path-direct specs (catalog names carry no extension, so rejecting them here would never
reach catalog resolution).

```typescript
// packages/engine/src/core/global/effect-slot.ts:33-61
/**
 * effect spec の共通前処理。順序は load-bearing（PluginEffectManager 由来）:
 * spec 検証 → LinkAudio gate → パス解決。未保存ファイル等で resolve が
 * 「cannot resolve」を投げる前に、より本質的な LinkAudio 競合エラーを出すため。
 * 拡張子検証（`validatePluginExtension`）は path-direct spec にのみ適用する
 * （#463 C2: カタログ名はここで弾かず、`resolvePluginSpec` のカタログ解決に委ねる）。
 */
export function resolveEffectSpec(
  spec: string,
  pluginId: string | undefined,
  deps: { audioManager: AudioManager; linkAudioManager: LinkAudioManager },
  linkAudioErrorMessage: string,
  catalogPathOverride?: string,
): ResolvedPluginSpec {
  if (isPluginPathSpec(spec)) {
    validatePluginExtension(spec, 'effect')
  }
  if (deps.linkAudioManager.isEnabled()) {
    throw new Error(linkAudioErrorMessage)
  }
  return resolvePluginSpec(
    spec,
    pluginId,
    deps.audioManager.getAudioPaths(),
    deps.audioManager.getDocumentDirectory(),
    'effect',
    catalogPathOverride,
  )
}
```

`EffectChainMap`'s rules — redeclaring the same spec is idempotent (no-op); a stale cache after a
respawn is reloaded (self-heal) when `isPluginActive?.() === false`; a different spec replaces —
are covered in the [PH-3](/en/plugin-hosting/catalog) chapter.

## Format support matrix

Extension-based validation lives in `plugin-resolver.ts`. On 2026-07-17 there was a role
asymmetry ("`.vst3` for instruments only"); #552 brought per-plugin format resolution to the
effect side as well (`orbit-vst3-effect-child`), so `.clap` / `.vst3` are accepted regardless of
role.

```typescript
// packages/engine/src/core/global/plugin-resolver.ts:39-66
export type PluginRole = 'effect' | 'instrument'

/** 実際にロードできる拡張子。新 format のサポートを足す時はここに追加する。 */
const SUPPORTED_PLUGIN_EXTENSIONS = ['.clap', '.vst3']
/** plugin ファイルとしては認識するが v1 ではロードできない拡張子（AU 予約）。 */
const RESERVED_PLUGIN_EXTENSIONS = ['.component']
/**
 * plugin ファイルパスとして**認識する**拡張子 = ロード可能 + 予約。
 * ロード可否とは別概念なので、`validatePluginExtension` は上の2つから判定する
 * （この配列だけを見ると「予約拡張子もロードできる」と誤読するため）。
 */
export const KNOWN_PLUGIN_EXTENSIONS = [
  ...SUPPORTED_PLUGIN_EXTENSIONS,
  ...RESERVED_PLUGIN_EXTENSIONS,
]
const KNOWN_PLUGIN_FORMATS = SUPPORTED_PLUGIN_EXTENSIONS.map((extension) => extension.slice(1))

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (SUPPORTED_PLUGIN_EXTENSIONS.includes(extension)) return
  if (RESERVED_PLUGIN_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future AU support).`,
    )
  }
  const expected = SUPPORTED_PLUGIN_EXTENSIONS.join(' or ')
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}
```

| spec form | `.clap` | `.vst3` | `.component` (AU) | notes |
|---|---|---|---|---|
| path-direct (shared by `seq.instrument()` / `global.effect()` / `seq.effect()` / `sum().effect()`) | ✅ | ✅ | ❌ ("reserved for future AU support" error) | unknown extensions are an error |
| catalog name | ✅ | ✅ | not scanned (PC.5) | if the same name exists in both formats, **CLAP > VST3** (PH.3 / PC.2) |

`.component` (Audio Unit) is a reserved extension that is "recognized as a plugin file but cannot
be loaded"; `KNOWN_PLUGIN_EXTENSIONS` (recognized) and `SUPPORTED_PLUGIN_EXTENSIONS` (loadable)
are kept separate precisely so the two are not confused.

## OOP child process layout

The daemon (`orbit-audio-daemon`) does not host the plugin implementation (CLAP/VST3 SDK calls)
in its own process. Instead it spawns **dedicated child processes** and exchanges audio/events
with them through shared memory. The children it may spawn are enumerated in
`SPAWNABLE_CHILD_BINARIES` (see the table in [RE-2](/en/rust-engine/oop-children) for the list
and roles).

```rust
// rust/crates/orbit-audio-daemon/src/lib.rs:84-93
pub const SPAWNABLE_CHILD_BINARIES: &[&str] = &[
    // effect: #628 以降は rack child 1 本がチェーン全体を持つ（format で分岐しない）。
    "orbit-effect-rack-child",
    // effect（退役予定・#628 で到達不能になったが、退役 PR まで配布は続ける）。
    "orbit-clap-effect-child",
    "orbit-vst3-effect-child",
    // instrument: format ごとに child が分かれる（1 instrument = 1 child）。
    "orbit-clap-instrument-child",
    "orbit-vst3-instrument-child",
];
```

The mapping as of 2026-09-01 is as follows.

| role | child | selection |
|---|---|---|
| effect (every bus: master / seq / sum / aux) | `orbit-effect-rack-child` (#628) | one child runs the whole chain serially; the CLAP/VST3 branch lives inside the child |
| instrument | `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` | a pure function chooses by the plugin path's extension (#421, #552) |

Instrument-side child selection is a pure function that treats only `.vst3` (case-insensitive) as
VST3 and sends everything else to the CLAP child. On 2026-07-17 it was self-contained in
`outproc_instrument.rs`; with #552 the "rule" was shared in `outproc_child_exe.rs`, and the
instrument side keeps only its "pair of binary names" (the motivation was #548, a bug where the
rule had been applied to one side only).

```rust
// rust/crates/orbit-audio-daemon/src/outproc_child_exe.rs:10-56
/// plugin path が VST3 か。**未知拡張子は VST3 ではない**（= CLAP へフォールバックする）。
///
/// CLAP は VST3 対応前から唯一サポートされていた format なので、未知拡張子のフォールバック先
/// として妥当。gated テストは未バンドルの raw `.dylib`（clap-test-synth）を attach するため、
/// ここで未知拡張子を reject すると既存経路が壊れる。不正な plugin path の失敗は従来どおり
/// child 側の load エラーとして表面化する。
pub(crate) fn is_vst3_plugin_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("vst3"))
}

/// attach する plugin に合わせて child binary を読み替える（純関数）。
///
/// - `current_child_exe` の file name が `clap_name` / `vst3_name` のどちらでもない場合は
///   **明示指定と見なして触らない**（`ORBIT_*_CHILD_BIN` override と gated テストの
///   config 直指定を保護する）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは `current_exe` が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。
/// - **冪等かつ対称**: retryable な attach 失敗で `ChildLaunch` が再利用されても毎回この
///   読み替えが走るので、`.vst3` → `.clap` の attach し直しで元の child に戻る。
///
/// 🔴 デフォルト名は呼び出し側が `default_child_name()` から渡すこと（手打ちリテラルにしない）。
/// 決め打ちだと child をリネームしたとき判定が常に false へ倒れ、**per-plugin のフォーマット
/// 切替が無音のまま無効化される**。
pub(crate) fn child_exe_for_attach(
    current_child_exe: &Path,
    plugin_path: &Path,
    clap_name: &'static str,
    vst3_name: &'static str,
) -> PathBuf {
    let current_name = current_child_exe.file_name().and_then(|name| name.to_str());
    let is_default_name = current_name.is_some_and(|name| name == clap_name || name == vst3_name);
    if !is_default_name {
        return current_child_exe.to_path_buf();
    }
    let desired = if is_vst3_plugin_path(plugin_path) {
        vst3_name
    } else {
        clap_name
    };
    match current_child_exe.parent() {
        Some(dir) => dir.join(desired),
        None => PathBuf::from(desired),
    }
}
```

```rust
// rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:154-191
/// instrument child のフォーマット別デフォルト binary 名。VST3 だけが専用 child を持ち、
/// それ以外（.clap・raw .dylib CLAP 等）は従来どおり CLAP child が担当する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentPluginFormat {
    Clap,
    Vst3,
}

impl InstrumentPluginFormat {
    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-instrument-child",
            Self::Vst3 => "orbit-vst3-instrument-child",
        }
    }
}

/// attach する plugin の拡張子から instrument child binary を選ぶ（純関数・unit テスト対象）。
///
/// - `current_child_exe` の file name がフォーマット別デフォルト名（clap/vst3 child）で
///   ない場合は**明示指定と見なして触らない**（gated テストの config 直指定・
///   `ORBIT_INSTRUMENT_CHILD_BIN` override を保護）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは current_exe が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。retryable attach 失敗で
///   `ChildLaunch` が再利用されても、毎回この読み替えが走るので .vst3 → .clap の
///   attach し直しで元の child に戻る（対称・冪等）。
pub(crate) fn child_exe_for_attach(current_child_exe: &Path, plugin_path: &Path) -> PathBuf {
    // 規則そのものは effect と共有する（`outproc_child_exe`）。ここが持つのは
    // 「instrument の binary 名の対」だけ。
    crate::outproc_child_exe::child_exe_for_attach(
        current_child_exe,
        plugin_path,
        InstrumentPluginFormat::Clap.default_child_name(),
        InstrumentPluginFormat::Vst3.default_child_name(),
    )
}

```

Note that the TypeScript validation (`validatePluginExtension`) and the Rust
`is_vst3_plugin_path` do **not** agree. The TS side rejects unknown extensions on path-direct
specs, while the Rust side falls back to CLAP for unknown extensions. This is an intentional
asymmetry; the comment records it as a design decision to avoid breaking the existing path
where the CLAP gated tests attach an unbundled raw `.dylib` (clap-test-synth).

The child-binary swap is a symmetric, idempotent pure function that only acts when the current
name is a default one (`orbit-clap-instrument-child` / `orbit-vst3-instrument-child`), within the
same directory. "Don't re-derive from `current_exe`" is a test-harness compatibility concern
(sibling resolution breaks under `target/debug/deps/`), and "never overwrite an explicitly-set
custom binary" protects the gated tests' direct config and the `ORBIT_*_CHILD_BIN` overrides.

Since #628 the effect side no longer branches on format. `default_rack_child_exe` defaults to
`orbit-effect-rack-child` in the daemon's own directory.

```rust
// rust/crates/orbit-audio-daemon/src/outproc_effect.rs:451-458
/// （spike の sibling-of-exe を踏襲・設計 §4.5）。インストール時は daemon と child が並んで置かれる前提。
fn default_rack_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join("orbit-effect-rack-child"))
}
```

`orbit-clap-effect-child` / `orbit-vst3-effect-child` became unreachable with #628 but keep being
distributed until the retirement PR (comment on `SPAWNABLE_CHILD_BINARIES`).

## Try it: play `seq.instrument("SynthOracle.vst3")`

The following is the procedure verified in the real-hardware E2E for Issue #421 (VST3 instrument
production), recorded in WORK_LOG 6.258.

```
var global = init GLOBAL
global.tempo(100)
global.beat(4 by 4)
global.key("C")
global.start()

var synth = init global.seq
synth.instrument("/path/to/SynthOracle.vst3")
synth.octave(4)
synth.vel(96)
synth.length(1)

synth.play(1, 3, 5, 8)

RUN(synth)
```

Running the distribution-configuration release daemon + `cli-audio.js` with `ORBIT_CAPTURE_WAV`
enabled objectively exercises the whole path: DSL →
`LoadPlugin(role=instrument, instance="plugin:synth")` → extension-based child selection →
`orbit-vst3-instrument-child` → note on/off via `IEventList` → sine tone → master bus.

**Expected value**: capture peak = **0.25000** (exact match to `SynthOracle`'s known amplitude,
confirmed on real hardware per WORK_LOG 6.258 on 2026-07-17; not re-measured during the
2026-09-01 re-read).

The E2E that goes through the user's own path (OrbitStudio + MCP) is accumulated in
`tests/e2e/orbitstudio-mcp-gated.spec.ts` and runs with `npm run test:e2e:gated`
([RE-4](/en/rust-engine/capture-verification)).

> **Gotcha**: `play()` only buffers the pattern; actually sounding it requires `RUN(seq)` (a
> recurring "forgot RUN/LOOP" silent-failure pattern already documented in WORK_LOG).

## Next exploration candidates

- How to confirm, at the E2E level, that `EffectChainMap.declare()`'s self-heal (`isPluginActive`) reloads correctly after a respawn
- How `seq.instrument()`'s `statePath` (#540 P2) is restored at child startup as `LoadPlugin.state`
- How `orbit-effect-rack-child` hosts CLAP and VST3 side by side (`rack_wire.rs`)
- The places to touch when adding `.component` (AU) support (`RESERVED_PLUGIN_EXTENSIONS` / the catalog scanner / PH.3)

## Sources

- `packages/engine/src/core/global/plugin-resolver.ts:29-80` — `resolvePluginPath` / `validatePluginExtension` / `isPluginPathSpec` (extension vs. catalog-name discrimination)
- `packages/engine/src/core/global/plugin-resolver.ts:238-260` — `resolvePluginSpec` (error on combining a catalog name with a pluginId argument)
- `packages/engine/src/core/global/plugin-instrument-manager.ts:22-91` — `PluginInstrumentManager.instrument()` (`plugin:<seqName>` instance ID, statePath)
- `packages/engine/src/core/global/plugin-effect-manager.ts:15-62` — `PluginEffectManager.effect()` (rack path)
- `packages/engine/src/core/global/effect-slot.ts:33-61` — `resolveEffectSpec` (the load-bearing validate → gate → resolve order)
- `rust/crates/orbit-audio-daemon/src/lib.rs:84-93` — `SPAWNABLE_CHILD_BINARIES`
- `rust/crates/orbit-audio-daemon/src/outproc_child_exe.rs:1-64` — the shared child-binary selection rule (#552)
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:154-199` — `InstrumentPluginFormat` / `child_exe_for_attach` / `default_child_exe`
- `rust/crates/orbit-audio-daemon/src/outproc_effect.rs:451-458` — `default_rack_child_exe`
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.1–PH.6 / PC.1–PC.5 — DSL spec for plugin hosting and the catalog
- [`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10 — source of truth for the rack form
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 — VST3 instrument production real-hardware E2E record (capture peak 0.25000)
- Epic [#424](https://github.com/signalcompose/orbitscore/issues/424) — plugin hosting DoD overview
- Issue [#421](https://github.com/signalcompose/orbitscore/issues/421) — VST3 instrument production
- Issue [#463](https://github.com/signalcompose/orbitscore/issues/463) — plugin catalog and name resolution
- Issue [#552](https://github.com/signalcompose/orbitscore/issues/552) — per-plugin format resolution on the effect side
- Issue [#628](https://github.com/signalcompose/orbitscore/issues/628) — the effect rack child
