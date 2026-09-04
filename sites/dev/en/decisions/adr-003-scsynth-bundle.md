---
title: "ADR-003 scsynth bundle strict mode"
chapter-id: "adr-003"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

::: warning Status as of 2026-09
The scsynth bundle and the strict resolver belong to the SuperCollider path. Since cutover #108 on 2026-07-03 (`docs/archive/WORK_LOG_2026-07.md` §6.179), this path is used **only when you opt out with `ORBITSCORE_ENGINE=sc`** (in VS Code, `orbitscore.engine: "sc"`); on the default Rust path scsynth is not even resolved. However, the "fail-loud resolver" pattern this ADR decided on is reused as-is for resolving `orbit-audio-daemon` (see "Consequences revisited (2026-09)" at the end). For the default path, see [RE-1. Daemon Architecture Overview](/en/rust-engine/).

```typescript
// packages/engine/src/audio/create-audio-engine.ts:17-22
export function createAudioEngine(env: NodeJS.ProcessEnv = process.env): AudioEngineBackend {
  const raw = env[ENGINE_ENV_VAR]
  if (resolveEngineKind(raw) === 'supercollider') {
    console.log(`🎛️ [engine] using SuperCollider backend (opt-out via ORBITSCORE_ENGINE=${raw})`)
    return new SuperColliderPlayer()
  }
```

```typescript
// packages/engine/src/audio/engine-backend.ts:52-53
/** バックエンド選択 env。既定（未設定）は Rust daemon 経路。`sc` / `supercollider` で SC に opt-out。 */
export const ENGINE_ENV_VAR = 'ORBITSCORE_ENGINE'
```
:::

# ADR-003 scsynth bundle strict mode

From v1.0, OrbitScore began bundling scsynth (SuperCollider's audio server binary) into the `.vsix` extension package. At the same time, the implicit fallback to SC.app was **intentionally removed** from the scsynth path resolution logic. This chapter unpacks that decision and its implementation.

---

## Table of Contents

1. [Background: Why Bundle scsynth](#background-why-bundle-scsynth)
2. [What is strict mode](#what-is-strict-mode)
3. [Removal of the SC.app Fallback: the Decision Process](#removal-of-the-scapp-fallback-the-decision-process)
4. [Resolver Implementation](#resolver-implementation)
5. [Bundle Composition and Size](#bundle-composition-and-size)
6. [Signing / Notarize Strategy](#signing-notarize-strategy)
7. [Use on the VS Code Extension Side](#use-on-the-vs-code-extension-side)
8. [Impact on the dev Environment](#impact-on-the-dev-environment)
9. [Consequences revisited (2026-09)](#consequences-revisited-2026-09)

---

## Background: Why Bundle scsynth

The journey to OrbitScore adopting SuperCollider was covered in [ADR-001](/en/decisions/adr-001-supercollider). As long as we use SuperCollider, the user needs to obtain the `scsynth` binary somehow.

In the early implementation, the user needed to install SuperCollider.app separately. This had the following problems:

1. **Poor installation experience**: just installing the `.vsix` did not work
2. **Difficulty of version management**: the user's SC.app version varies, changing behavior
3. **Risk during ICMC presentations**: at the venue, "it doesn't work without SC.app" would be problematic

To solve this, in Issue #131 (Epic: v1.0 ICMC Ready Phase 1), the policy of bundling a minimum scsynth into the `.vsix` was decided. As a precedent, Sonic Pi takes a similar approach.

---

## What is strict mode

It is clearly written in the comments of `scsynth-resolver.ts`:

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17
/**
 * scsynth binary path resolver.
 *
 * 優先順位 (strict mode — Issue #136 の "SC 不要で動く" を保証するため
 * SC.app / Spotlight への暗黙 fallback は意図的に持たない):
 *   1. explicit (caller 明示)
 *   2. env (ORBIT_SCSYNTH_PATH)
 *   3. bundle (extension 同梱、`<engine root>/scsynth/Contents/Resources/scsynth`)
 *
 * 全 miss 時は `ScsynthNotFoundError` を投げ、bundle が無い状況を「サイレントに
 * SC.app で誤魔化す」のではなく明示的に検知できるようにする。dev 環境で
 * SC.app を使いたい場合は `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/...`
 * を env で渡すこと。
 *
 * パターンは `packages/engine/src/audio/rust-engine/daemon-client.ts` の
 * `resolveDaemonBinary()` を流用。各候補は `fs.statSync` + 実行権限を検査。
 */
```

"strict mode" is a **fail-loud approach**:
- scsynth found → return that path
- scsynth not found → **throw** `ScsynthNotFoundError` (no silent fallback to SC.app)

---

## Removal of the SC.app Fallback: the Decision Process

The PR that removed the fallback was #155 (commit `1569110`). The reason is written in the commit message:

> refactor(audio): drop SC.app/spotlight fallback from scsynth resolver
>
> Issue #136 の "SC が入っていない環境で .vsix install するだけで動く" を
> 明示的に保証するため、resolver から SC.app fallback と Spotlight 探索を
> 削除。bundle 不在 = 即エラー (`ScsynthNotFoundError`) で fail loud に
> 切り替える。
>
> **動機 (本ブランチでの user 指摘より)**:
> fallback があると bundle 抽出失敗を SC.app が静かに肩代わりして
> production の不具合を隠蔽する。`vsce package` で bundle が壊れていても
> SC.app があれば動いてしまうため、cold-install テストの意味が曖昧に。

Further details of the change:

> - `ScsynthSource` を `'explicit' | 'env' | 'bundle'` の 3 段階に縮小
> - `SC_APP_DEFAULT_PATH`, `SPOTLIGHT_TIMEOUT_MS`, `findViaSpotlight()` を削除
> - `child_process.spawnSync` import を削除
> - `ScsynthNotFoundError` のメッセージに dev workaround
>   (`ORBIT_SCSYNTH_PATH=/Applications/.../scsynth`) の案内を追記

Organizing **why having the fallback is problematic**:

1. **Hiding problem**: even if the bundle inclusion fails, it works as long as SC.app exists
2. **Loss of meaning of cold-install testing**: cannot test in environments without bundle and without SC.app
3. **Divergence between production and dev environments**: works on developers' machines (with SC.app) but not in user environments (without SC.app)

This is the audio-binary version of the classic "works only on the dev machine" problem.

---

## Resolver Implementation

Let's look at the core part of `scsynth-resolver.ts`:

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99
export function resolveScsynthPath(opts: ResolveOptions = {}): ScsynthResolution {
  const searched: string[] = []

  const tryCandidate = (
    candidate: string | null | undefined,
    source: ScsynthSource,
  ): ScsynthResolution | null => {
    if (!candidate) return null
    searched.push(candidate)
    if (isExecutableFile(candidate)) {
      return { path: candidate, source, searched: [...searched] }
    }
    return null
  }

  return (
    tryCandidate(opts.explicit, 'explicit') ??
    tryCandidate(process.env[ENV_VAR], 'env') ??
    tryCandidate(bundleCandidatePath(), 'bundle') ??
    (() => {
      throw new ScsynthNotFoundError(searched)
    })()
  )
}
```

Priority is expressed by a chain using `??` (nullish coalescing):

1. `opts.explicit` — the path the caller explicitly specified (orbitscore.scsynthPath setting value)
2. `process.env['ORBIT_SCSYNTH_PATH']` — environment variable
3. `bundleCandidatePath()` — the scsynth bundled in the `.vsix`

If all return `null`, `ScsynthNotFoundError` is thrown. The `searched` array contains "the list of paths that were searched but not found" and is included in the error message.

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:34-45
export class ScsynthNotFoundError extends Error {
  public readonly searched: string[]

  constructor(searched: string[]) {
    super(
      `scsynth binary not found. Searched paths:\n${searched.map((p) => '  - ' + p).join('\n')}\n\n` +
        `For development without a bundled scsynth, set ORBIT_SCSYNTH_PATH to a system scsynth (e.g. /Applications/SuperCollider.app/Contents/Resources/scsynth).`,
    )
    this.name = 'ScsynthNotFoundError'
    this.searched = searched
  }
}
```

The error message describes "which paths were searched" and "the workaround in the dev environment."

Let's also confirm the implementation of `bundleCandidatePath()`:

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:57-59
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}
```

`__dirname` is the directory of the `.js` file at runtime. When bundled into the VS Code extension:

```
packages/vscode-extension/engine/dist/audio/supercollider/scsynth-resolver.js
```

So `../../../` becomes:

```
packages/vscode-extension/engine/dist/  → ../
packages/vscode-extension/engine/       → ../../
packages/vscode-extension/              → ../../../
```

and points to `packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth`.

On the other hand, when the engine package is run standalone, it is `packages/engine/dist/...`, so the bundle path does not exist; it always misses → `ScsynthNotFoundError`. This is intentional design (when running engine standalone, pass via the `ORBIT_SCSYNTH_PATH` environment variable).

---

## Bundle Composition and Size

Through the investigation in Issue #134 (`docs/research/SCSYNTH_BUNDLE_MANIFEST.md`), the minimum set to bundle was finalized:

| Element | Size | Notes |
|---|---|---|
| scsynth binary | ~1.5 MB | universal binary (arm64 + x86_64) |
| plugins (non-supernova) | ~5.1 MB | 26 files (.scx) |
| libsndfile.dylib | ~4.9 MB | scsynth's only external dependency |
| **Total** | **~11.5 MB** | libfftw3f turned out to be unnecessary, reducing from the initial estimate of 13 MB |

The reason for excluding `libfftw3f.dylib` is also recorded in the investigation:
> `libfftw3f` は **いずれの scx/scsynth も依存していないことを otool で確認** → **同梱しない**

The bundle's layout structure preserves SC.app's internal structure:
```
packages/vscode-extension/engine/scsynth/
└── Contents/
    ├── Resources/
    │   ├── scsynth           ← the binary itself
    │   └── plugins/          ← 26 .scx files (+ OrbitLinkAudio.scx when it has been built)
    └── Frameworks/
        └── libsndfile.dylib  ← external dependency
```

This structure is needed to avoid breaking scsynth's hard-coded dylib lookup path of `@loader_path/../Frameworks/libsndfile.dylib`.

---

## Signing / Notarize Strategy

Conclusion of the investigation in Issue #135 (`docs/research/CODESIGN_PIPELINE.md`):

**No re-signing required**. scsynth, libsndfile.dylib, and the .scx files all carry the official signing of the SuperCollider project:

```
Authority=Developer ID Application: Joshua Parmenter (HE5VJFE9E4)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
```

Because the SC project already provides binaries with Apple Developer ID + hardened runtime + notarized, on the OrbitScore side:
- No additional Apple Developer ID acquisition needed
- The only secret in GitHub Actions is `VSCE_PAT` (zero Apple-related secrets)

That was the situation (for the later story about the daemon, see "Consequences revisited").

---

## Use on the VS Code Extension Side

As covered in [III-3](/en/audio/scsynth-bundle) and [IV-1](/en/editor/vscode-architecture), the VS Code extension calls the resolver via `resolveScsynthForUI()`. At 69dc968, however, this call happens only when `orbitscore.engine` is `sc`. The result of resolution is used to display the status bar indicator `bundleStatusItem`:

| engine kind | `resolution.source` | bundleStatusItem display |
|---|---|---|
| `sc` | `'bundle'` | `$(check) scsynth (bundled)` |
| `sc` | `'env'` or `'explicit'` | `$(gear) scsynth (custom)` |
| `sc` | `null` (resolution failed) | `$(error) scsynth: not found` (red background) |
| `rust` | (scsynth is not resolved) | hidden if the daemon resolves; otherwise `$(error) daemon: not found` |

```typescript
// packages/vscode-extension/src/extension.ts:743-767
  bundleStatusItem.show()
  const resolution = resolveScsynthForUI()
  if (!resolution) {
    bundleStatusItem.text = '$(error) scsynth: not found'
    bundleStatusItem.tooltip =
      'Bundled scsynth not found. Reinstall the extension or set orbitscore.scsynthPath to a system scsynth.'
    bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    return
  }
  bundleStatusItem.backgroundColor = undefined
  switch (resolution.source) {
    case 'bundle':
      bundleStatusItem.text = '$(check) scsynth (bundled)'
      bundleStatusItem.tooltip = `Using bundled scsynth\n${resolution.path}`
      break
    case 'env':
    case 'explicit':
      bundleStatusItem.text = '$(gear) scsynth (custom)'
      bundleStatusItem.tooltip = `Using user-overridden scsynth\n${resolution.path}`
      break
    default:
      bundleStatusItem.text = '$(question) scsynth: unknown source'
      bundleStatusItem.tooltip = resolution.path
  }
}
```

Even in `startEngine()` that starts the engine, under the `sc` kind the resolver is called before startup and **the spawn itself is not performed if scsynth is missing** (pre-check), which prevents the double notification of "engine startup failure + resolver error" (from the code review comment in PR #155). Under the `rust` kind, the daemon binary is pre-checked at the same spot (`extension.ts:2053-2088`).

---

## Impact on the dev Environment

Removing the fallback also requires awareness from **developers who already have SC.app installed**:

The "Dev workflow への影響" section of commit `1569110`:

> engine 単独 CLI (`npm run dev:engine`) で SC.app に頼っていた人:
> → `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth`
>   を env で渡すか、`build:bundle` で bundle を抽出してから実行

Two workarounds:

1. **Via environment variable**: add `export ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth` to `.zshenv` or similar
2. **Bundle extraction**: run `npm run build:bundle` first to place the binary in `engine/scsynth/`

Since cutover #108, in addition to this, `ORBITSCORE_ENGINE=sc` (`orbitscore.engine: "sc"` in VS Code) is needed just to select the SC path in the first place.

---

## Consequences revisited (2026-09)

Following the ADR format, this records the consequences after the decision.

### The bundle stays; the path became an opt-out

Cutover #108 on 2026-07-03 (`docs/archive/WORK_LOG_2026-07.md` §6.179) switched the default backend to Rust, but the scsynth bundle itself remains. The engine-kind branching of #377 (`docs/archive/WORK_LOG_2026-07.md` §6.186) records, regarding release.yml, that "the scsynth-related steps (brew install / build:bundle / verify:bundle) are kept unchanged (interim owner decision: keep the scsynth bundle as-is in Phase 1)." Therefore, even at 69dc968, the `.vsix` ships both the SC bundle and the daemon binary.

### The strict resolver pattern was inherited by the daemon

The core of this ADR — "fail loud, no silent fallback, a candidate must be an executable file" — is carried over as-is into `resolveDaemonBinaryPath()`. #306 (`docs/archive/WORK_LOG_2026-07.md` §6.185) added the `.vsix`-bundled daemon as the last candidate, and in review Round 2 of #366 (§6.186) the finding that "it only checks `existsSync` and does not look at the exec bit — asymmetric with `isExecutableFile` on the scsynth side" led to the daemon side also requiring an executable regular file. The candidate order is `explicit → env (ORBIT_AUDIO_DAEMON_PATH) → monorepo-release → monorepo-debug → extension-bundle`.

```typescript
// packages/engine/src/audio/rust-engine/daemon-client.ts:99-99
  source: 'explicit' | 'env' | 'monorepo-release' | 'monorepo-debug' | 'extension-bundle'
```

### The signing question moved to the daemon

The "no re-signing required" conclusion in this ADR was about scsynth, which can keep the SuperCollider project's own signature. The daemon is a fresh build, so the same conclusion does not apply. §6.185 records as a follow-up that "the daemon binary has not been Apple Developer ID signed / notarized; a downloaded `.vsix` may be blocked by Gatekeeper (unverified)."

> NOTE: unverified — whether the daemon's signing / notarization has been done as of 69dc968 was not checked within the scope of this chapter (only the follow-up note in WORK_LOG §6.185 is quoted).

### Consequences in the UI

`bundleStatusItem` is hidden under the `rust` kind as long as the daemon resolves (owner decision 2026-07-17, the comment at `extension.ts:737-739`), so the scsynth status display is now something only people who chose `sc` see. `forceKillScsynth` / `selectAudioDevice` are also gated on `config.orbitscore.engine == 'sc'` in `package.json`'s `commandPalette`.

---

## Related Terms

- [strict mode (scsynth resolver)](/en/glossary#strict-mode-scsynth-resolver) — the core of this ADR. The fail-loud design with no implicit fallback to SC.app
- [bundle (scsynth source)](/en/glossary#bundle-scsynth-source) — the scsynth binary bundled in the `.vsix`. The third-priority candidate of the resolver
- [explicit (scsynth source)](/en/glossary#explicit-scsynth-source) — the resolver's highest priority. The `orbitscore.scsynthPath` setting value
- [env (scsynth source)](/en/glossary#env-scsynth-source) — the `ORBIT_SCSYNTH_PATH` environment variable. The way to specify SC.app in the dev environment
- [ScsynthNotFoundError](/en/glossary#scsynthnotfounderror) — the error class thrown when all three candidates miss
- [ScsynthResolution](/en/glossary#scsynthresolution) — the return type of `resolveScsynthPath()`
- [scsynth](/en/glossary#scsynth) — the protagonist of the bundle. universal binary (arm64 + x86_64)
- [StatusBarItem](/en/glossary#statusbaritem) — the VS Code API used by `bundleStatusItem` to display the bundle resolution status

## Related ADRs

- [ADR-001 Choosing SuperCollider as the Implementation Base](/en/decisions/adr-001-supercollider) — the reason for adopting scsynth. The bundle strategy in this ADR is a consequence of that choice; the post-cutover position is in that ADR's "Consequences revisited"
- [ADR-002 DSL v3 Pivot](/en/decisions/adr-002-dsl-v3-pivot) — the decision that fixed the Audio DSL depending on scsynth

## Next Exploration Candidates

- Implementation of the `build:bundle` script (`scripts/extract-scsynth-bundle.sh`) — details of the processing that extracts and places scsynth from SC.app
- `scripts/copy-daemon-bin.sh` — the daemon-side bundling script. Why it is limited to `darwin-arm64`, and the ordering guarantee in release.yml
- Bundle strategies for Windows / Linux — supporting platforms beyond the macOS-targeted universal binary
- Bundle update flow for SC.app version-up — the Update policy in `SCSYNTH_BUNDLE_MANIFEST.md` (re-extract on Major/Minor bump only)
- Handling of the GPL-3.0 license for the bundled inclusion — the detail of the issue noted in `SCSYNTH_BUNDLE_MANIFEST.md` as "strongly maintain GPL-3.0 aggregation property"
- Status of the daemon's signing / notarization — how the §6.185 follow-up was handled afterward

---

## Sources

- `packages/engine/src/audio/create-audio-engine.ts:17-22` — the branch that makes the SC path an opt-out
- `packages/engine/src/audio/engine-backend.ts:52-53` — definition of `ENGINE_ENV_VAR` (`ORBITSCORE_ENGINE`)
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — file-leading comment: explanation of strict mode's intent and priority
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-98` — implementation of `ScsynthNotFoundError`, `bundleCandidatePath()`, `resolveScsynthPath()`
- `packages/engine/src/audio/rust-engine/daemon-client.ts:99-99` / `:221-250` — the daemon-side source kinds and `resolveDaemonBinaryPath()`
- `packages/vscode-extension/src/extension.ts:653-669` — `getConfiguredEngineKind()`: normalization of the engine kind
- `packages/vscode-extension/src/extension.ts:676-692` — `resolveScsynthForUI()`: front-end-side resolution via runtime require
- `packages/vscode-extension/src/extension.ts:725-766` — `updateBundleStatus()`: engine-kind branch and status bar display switching by `resolution.source`
- `packages/vscode-extension/src/extension.ts:2053-2088` — `startEngine()` pre-check: scsynth for `sc`, the daemon for `rust`
- `packages/vscode-extension/package.json` — the `orbitscore.engine` setting (default `"rust"`) and the `commandPalette` `when` clauses
- commit `1569110` — details of the SC.app/Spotlight fallback removal (motivation, change content, dev impact)
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — adoption of scsynth bundle strict mode
- `docs/archive/WORK_LOG_2026-07.md` §6.179 / §6.185 / §6.186 — cutover #108, bundling the daemon into the `.vsix` (#306), engine-kind branching and keeping the bundle steps (#377)
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` — Issue #134: finalized minimum bundle set (26 plugins + libsndfile)
- `docs/research/CODESIGN_PIPELINE.md` — Issue #135: signing/notarize investigation (conclusion that re-signing is unnecessary)
- `docs/research/SCSYNTH_STANDALONE.md` — Issue #133: validation of standalone startup outside SC.app
