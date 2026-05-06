---
title: "ADR-003 scsynth bundle strict mode"
chapter-id: "adr-003"
verified-against: 0a4b598
verified-at: "2026-05-05"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-05-05. The code is the truth; this page is merely a snapshot of understanding at that point in time.

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
    │   └── plugins/          ← 26 .scx files
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

That is the situation.

---

## Use on the VS Code Extension Side

As covered in [IV-1](/en/editor/vscode-architecture), the VS Code extension calls the resolver via `resolveScsynthForUI()`. The result of resolution is used to display the two status bar indicators:

| `resolution.source` | bundleStatusItem display |
|---|---|
| `'bundle'` | `$(check) scsynth (bundled)` |
| `'env'` or `'explicit'` | `$(gear) scsynth (custom)` |
| `null` (resolution failed) | `$(error) scsynth: not found` (red background) |

Even in `startEngine()` that starts the engine, a design where the resolver is called before startup and **the spawn itself is not performed if scsynth is missing** (pre-check) prevents the double notification of "engine startup failure + resolver error" (from the code review comment in PR #155).

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

- [ADR-001 Choosing SuperCollider as the Implementation Base](/en/decisions/adr-001-supercollider) — the reason for adopting scsynth. The bundle strategy in this ADR is a consequence of that choice
- [ADR-002 DSL v3 Pivot](/en/decisions/adr-002-dsl-v3-pivot) — the decision that fixed the Audio DSL depending on scsynth

## Next Exploration Candidates

- Implementation of the `build:bundle` script — details of the processing that extracts and places scsynth from SC.app
- Implementation of `isExecutableFile()` — execute permission check via `stat.mode & 0o111`
- Bundle strategies for Windows / Linux — supporting platforms beyond macOS-targeted universal binary
- Bundle update flow for SC.app version-up — the Update policy in `SCSYNTH_BUNDLE_MANIFEST.md` (re-extract on Major/Minor bump only)
- Handling of the GPL-3.0 license for the bundled inclusion — the detail of the issue noted in `SCSYNTH_BUNDLE_MANIFEST.md` as "strongly maintain GPL-3.0 aggregation property"

---

## Sources

- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — file-leading comment: explanation of strict mode's intent and priority
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-98` — implementation of `ScsynthNotFoundError`, `bundleCandidatePath()`, `resolveScsynthPath()`
- `packages/vscode-extension/src/extension.ts:113-129` — `resolveScsynthForUI()`: front-end-side resolution via runtime require
- `packages/vscode-extension/src/extension.ts:138-163` — `updateBundleStatus()`: status bar display switching by `resolution.source`
- `packages/vscode-extension/src/extension.ts:692-695` — `startEngine()` pre-check: early return when scsynth is unresolved
- commit `1569110` — details of the SC.app/Spotlight fallback removal (motivation, change content, dev impact)
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — adoption of scsynth bundle strict mode
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` — Issue #134: finalized minimum bundle set (26 plugins + libsndfile)
- `docs/research/CODESIGN_PIPELINE.md` — Issue #135: signing/notarize investigation (conclusion that re-signing is unnecessary)
- `docs/research/SCSYNTH_STANDALONE.md` — Issue #133: validation of standalone startup outside SC.app
