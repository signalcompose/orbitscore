---
title: "PH-1. Plugin Hosting Overview"
chapter-id: "PH-1"
verified-against: 5b227da
verified-at: "2026-07-17"
status: draft
---

> **Note**: This page is a snapshot of the author's reading as of 2026-07-17. The code is the
> source of truth; this page is only a snapshot of that understanding at that point in time.

# PH-1. Plugin Hosting Overview

OrbitScore hosts 3rd-party CLAP / VST3 plugins as **sandboxed out-of-process (OOP) children**.
This chapter surveys the whole picture — DSL syntax, format support matrix, and how OOP hosting
works. The detailed internals (child-process-side transport, shared-memory layout) are left to
later chapters (PH-2, PH-3).

## DSL syntax: two hosting surfaces

The OrbitScore DSL splits plugin hosting into two independent surfaces.

- **`global.effect(spec, pluginId?)`** — a master-bus insert (v1 supports exactly one)
- **`seq.instrument(spec, pluginId?)`** — a per-sequence sound source (v1 supports exactly one instance)

Both share the same "declare → resolve → load" pattern, but differ in which formats they accept.

```typescript
// plugin-instrument-manager.ts:27-51
  async instrument(spec: string, pluginId?: string): Promise<void> {
    validatePluginExtension(spec, 'instrument')
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        if (this.audioEngine.isPluginActive?.() === false) {
          await this.issueLoad(resolvedPath, pluginId)
        }
        return
      }
      throw new Error('seq.instrument() supports one instrument instance in v1.')
    }
    await this.issueLoad(resolvedPath, pluginId)
  }
```

`global.effect()` is nearly identical in structure, but is careful about ordering in a way that
matters: extension validation → LinkAudio gate → path resolution, in that order, **on purpose**.

```typescript
// plugin-effect-manager.ts:27-44
  async effect(spec: string, pluginId?: string): Promise<void> {
    // Order is load-bearing: validate the spec, then gate on LinkAudio, and
    // only then resolve the path. A relative spec with no document context
    // yet (unsaved file) makes `resolvePluginPath` throw a "cannot resolve"
    // error; if that ran before the LinkAudio gate, it would mask the more
    // relevant LinkAudio-conflict error with a confusing resolve failure.
    validatePluginExtension(spec, 'effect')

    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'effect',
    )
```

The comment explains why this ordering is "load-bearing": on an unsaved file (no document
context yet), a relative spec makes `resolvePluginPath` throw an "unresolvable" error; if that
ran before the LinkAudio gate, it would mask the more relevant LinkAudio-conflict error behind a
confusing resolve failure.

Both `PluginInstrumentManager` and `PluginEffectManager` share the constraint that v1 supports
only a single declaration. Calling with a second, different spec throws explicitly (effect
chains / multiple instruments are reserved for future support). The
`isPluginActive?.() === false` self-heal branch guards against a silent failure where a daemon
respawn leaves the cache thinking the load succeeded while the actual plugin was not restored —
it re-issues the load instead of returning a false "success".

## Format support matrix

Extension-based validation varies the accepted formats per `PluginRole`.

```typescript
// plugin-resolver.ts:21-44
export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
  role: PluginRole,
): string {
  validatePluginExtension(spec, role)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

export type PluginRole = 'effect' | 'instrument'

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3' && role === 'instrument') return
  if (extension === '.vst3' || extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future VST3/AU support).`,
    )
  }
  const expected = role === 'instrument' ? '.clap or .vst3' : '.clap'
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}
```

| Role | `.clap` | `.vst3` | `.component` (AU) |
|---|---|---|---|
| `global.effect()` (master insert) | ✅ | ❌ (raises "reserved for future" error) | ❌ |
| `seq.instrument()` (sound source) | ✅ | ✅ | ❌ |

`.component` (Audio Unit) is unsupported for either role (explicitly rejected as "reserved for
future"). VST3 is only valid for instrument — this asymmetry reflects that Issue #421 (VST3
instrument production) shipped only the instrument path so far; VST3 support for effect is a
separate, unscoped item.

## OOP child process layout

The daemon (`orbit-audio-daemon`) does not host the plugin's actual implementation (CLAP/VST3
SDK calls) in its own process. Instead it spawns a **dedicated child process** and exchanges
audio/events over shared memory. Which child to spawn is decided by a pure function keyed off
the plugin path's extension:

```rust
// outproc_instrument.rs:106-134
/// instrument child のフォーマット別デフォルト binary 名。VST3 だけが専用 child を持ち、
/// それ以外（.clap・raw .dylib CLAP 等）は従来どおり CLAP child が担当する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentPluginFormat {
    Clap,
    Vst3,
}

impl InstrumentPluginFormat {
    /// 拡張子 `.vst3`（大文字小文字不問）のみ VST3。**それ以外はすべて Clap** —
    /// CLAP は VST3 対応前から唯一サポートされていた instrument フォーマットだった
    /// ため、未知拡張子のフォールバック先として妥当。一例として、CLAP gated テストは
    /// 未バンドルの raw `.dylib`（clap-test-synth）を attach するため、ここで未知
    /// 拡張子を reject すると既存経路が壊れる（本ブランチの実機 gated RUN で検出済み）。
    /// 不正な plugin path の失敗は従来どおり child 側の load エラーとして表面化する。
    fn from_plugin_path(path: &Path) -> Self {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("vst3") => Self::Vst3,
            _ => Self::Clap,
        }
    }

    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-instrument-child",
            Self::Vst3 => "orbit-vst3-instrument-child",
        }
    }
}
```

Note that the source code comments above stay in Japanese: they are quoted verbatim from the
repository per this site's citation discipline (see `STYLE_GUIDE.md` §5-bis) — translating
inline code comments would break the verbatim guarantee that the code snippet matches the actual
file byte-for-byte.

The TypeScript-side validation (`validatePluginExtension`) and the Rust-side
`InstrumentPluginFormat::from_plugin_path` are **not** aligned. TS rejects anything other than
`.clap`/`.vst3`, while Rust falls back unknown extensions to CLAP. This is an intentional
asymmetry: the comment explains it exists so the CLAP gated test — which attaches an unbundled
raw `.dylib` (roughly "no extension") — doesn't break on an existing path.

The child binary selection itself is a symmetric, idempotent pure function that only swaps
binaries in-place when the current child exe has one of the default names:

```rust
// outproc_instrument.rs:136-159
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
    let is_default_name = matches!(
        current_child_exe.file_name().and_then(|name| name.to_str()),
        Some("orbit-clap-instrument-child") | Some("orbit-vst3-instrument-child")
    );
    if !is_default_name {
        return current_child_exe.to_path_buf();
    }
    let desired = InstrumentPluginFormat::from_plugin_path(plugin_path).default_child_name();
    match current_child_exe.parent() {
        Some(dir) => dir.join(desired),
        None => PathBuf::from(desired),
    }
}
```

The "don't re-derive from `current_exe`" decision is a test-harness compatibility workaround,
and the "don't touch an explicitly-set custom binary" guard protects gated tests that set the
child exe directly. Both are covered in more depth in PH-3 (VST3 instrument hosting).

Effect hosting has a corresponding OOP child (`orbit-clap-effect-child` family,
`outproc_effect.rs`), but since effect currently only supports CLAP, there is no VST3 effect
child. Effect hosting details are covered in PH-4.

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
enabled objectively exercises the whole path: DSL → `LoadPlugin(role=instrument)` →
extension-based child selection → `orbit-vst3-instrument-child` → note on/off via `IEventList` →
sine tone → master bus.

**Expected value**: capture peak = **0.25000** (exact match to `SynthOracle`'s known amplitude,
confirmed on real hardware per WORK_LOG 6.258).

> **Gotcha**: `play()` only buffers the pattern; actually sounding it requires `RUN(seq)` (a
> recurring "forgot RUN/LOOP" silent-failure pattern already documented in WORK_LOG).

## Sources

- `packages/engine/src/core/global/plugin-resolver.ts:21-44` — `resolvePluginPath` / `validatePluginExtension` (per-role format allowlist logic)
- `packages/engine/src/core/global/plugin-instrument-manager.ts:27-51` — `PluginInstrumentManager.instrument()`
- `packages/engine/src/core/global/plugin-effect-manager.ts:27-44` — `PluginEffectManager.effect()` (the load-bearing validation-order comment)
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:106-167` — `InstrumentPluginFormat` and `child_exe_for_attach` (pure-function per-format child selection)
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) 6.258 — VST3 instrument production real-hardware E2E record (capture peak 0.25000)
- Epic [#424](https://github.com/signalcompose/orbitscore/issues/424) — plugin hosting DoD overview
- Issue [#421](https://github.com/signalcompose/orbitscore/issues/421) — VST3 instrument production
