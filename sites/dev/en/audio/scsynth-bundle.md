---
title: "III-3. scsynth Bundle and Path Resolution"
chapter-id: "III-3"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: This page is a trace of the author's reading as of 2026-09-01. The code is the truth; this page is only a snapshot of understanding at that time.

::: warning Status as of 2026-09
The scsynth bundle and its path resolution belong to the SuperCollider path, which since cutover #108 on 2026-07-03 (`docs/development/WORK_LOG.md` §6.179) is taken **only when you opt out with `ORBITSCORE_ENGINE=sc`** (in VS Code settings, `orbitscore.engine: "sc"`). On the default Rust path the extension does not resolve scsynth at all; it resolves the `orbit-audio-daemon` binary with the same strict pattern (see "The daemon-side counterpart" at the end of this chapter). For the big picture of the default path, see [RE-1. Daemon Architecture Overview](/en/rust-engine/).

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

# III-3. scsynth Bundle and Path Resolution

On the SC path, just installing OrbitScore's `.vsix` produces sound. Behind that is the design of "bundling the scsynth binary into the extension." This chapter follows why we bundle, how it is laid out, in what order the engine searches for the binary, and how it behaves if not found.

In [0-2. Architecture Overview](/en/orientation/architecture-overview), we touched on the policy of strict mode. This chapter dives into **"why this design was chosen"** and the details of the resolver code.

## Why Bundle: the Question of Issue #136

The early design of OrbitScore presupposed that users had SuperCollider installed. The engine was a simple implementation that, on startup, used SC.app (`/Applications/SuperCollider.app/Contents/Resources/scsynth`) if it existed and errored otherwise.

What changed this was the requirement of Issue #136 "works without SC": users who install the `.vsix` should have it work without separately installing SuperCollider. The design adopted to meet this was the bundle strategy of **including the scsynth binary + plugins + libsndfile in the `.vsix`** (PR [#155](https://github.com/signalcompose/orbitscore/pull/155)).

### Why There is No SC.app Fallback

At the same time as bundling, the implicit fallback to SC.app has been **abolished**. The reason is explained in the leading comment of `scsynth-resolver.ts`.

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

If there were a SC.app fallback, "even though bundle extraction failed, SC.app would compensate, and bundle problems in production builds would be silently hidden." By failing loud (raising an explicit error if not found), we make sure that bundle problems are reliably detected.

## File Structure of the Bundle

The bundle shipped in the `.vsix` is outside git management (`packages/vscode-extension/engine/` at `.gitignore:47`), but `!engine/scsynth/**` at `.vscodeignore:36` keeps it in the `.vsix`, and `BUILD_GUIDE.md` defines its structure.

```
packages/vscode-extension/engine/scsynth/
├── Contents/
│   ├── Resources/
│   │   ├── scsynth                (1.5 MB, universal arm64+x86_64)
│   │   └── plugins/               (26 stock .scx + OrbitLinkAudio.scx if built)
│   └── Frameworks/
│       └── libsndfile.dylib       (4.9 MB)
├── LICENSE.GPL-3.0                (legal/scsynth-LICENSE.GPL-3.0 から copy)
└── NOTICE                          (legal/scsynth-NOTICE から copy)
```

`Contents/Resources/scsynth` is the executable binary, a universal binary of arm64 and x86_64. `plugins/` is the set of plugins (`.scx` files) that scsynth uses for audio processing; `OrbitLinkAudio.scx` for LinkAudio is included only when it has been built. `libsndfile.dylib` is the dynamic library used to decode audio files; thanks to it, decoding of WAV / AIFF and so on works.

The bundle is generated by running `npm run build:bundle` (`scripts/extract-scsynth-bundle.sh`) in the release pipeline. It is not included in the source code; it is generated each time a release is made.

## Resolver Implementation: a Three-Stage Priority

`resolveScsynthPath()` tries three candidates in order.

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

Chained with the `??` operator, it tries from left to right, ending as soon as the first non-`null` value is returned. If all three are `null`, it immediately throws `ScsynthNotFoundError`.

### Candidate 1: explicit (caller-specified)

`opts.explicit` is when the caller passes a path directly. It is used when the user specifies a custom path via the VS Code extension's setting (`orbitscore.scsynthPath`).

### Candidate 2: env (`ORBIT_SCSYNTH_PATH`)

If the environment variable `ORBIT_SCSYNTH_PATH` is set, that value is used. To use SC.app during development, this is the method.

```bash
ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth npm run dev:engine
```

It is constantized as `const ENV_VAR = 'ORBIT_SCSYNTH_PATH'`.

### Candidate 3: bundle (`bundleCandidatePath()`)

References the scsynth bundled in the `.vsix`.

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:57-59
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}
```

`__dirname` resolves at runtime to the directory of the compiled JS file. When bundled into vscode-extension, `__dirname` is `packages/vscode-extension/engine/dist/audio/supercollider/`; going up three levels with `../../../` reaches `packages/vscode-extension/engine/`, ultimately arriving at `scsynth/Contents/Resources/scsynth`.

When using the engine package standalone (`packages/engine/dist/`), the bundle does not exist, so it always misses → `ScsynthNotFoundError`. In a dev environment, it is resolved via env.

### isExecutableFile Implementation

Each candidate is verified for actual existence as a file and execute permission.

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:61-69
function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p)
    if (!stat.isFile()) return false
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}
```

`stat.mode & 0o111` checks whether any of the POSIX execute permission bits (owner / group / other execute bits) is set. If the file does not exist, `statSync` throws an exception; by catching it and returning `false`, the case is handled gracefully.

## Behavior on Error: ScsynthNotFoundError

If all three candidates miss, `ScsynthNotFoundError` is thrown.

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

The error message includes the list of searched paths, so "where it looked and didn't find it" is visible at a glance. The `searched` property is also attached to the error object, so the catching side can inspect it programmatically.

## The Wrapper on the Extension Side: `resolveScsynthForUI()`

The VS Code extension uses the resolver by `require()`-ing the engine's compiled JS.

```typescript
// packages/vscode-extension/src/extension.ts:677-693
function resolveScsynthForUI(): { path: string; source: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const resolverModule = require('../engine/dist/audio/supercollider/scsynth-resolver') as {
      resolveScsynthPath: (opts?: { explicit?: string }) => { path: string; source: string }
    }
    const userOverride = vscode.workspace
      .getConfiguration('orbitscore')
      .get<string>('scsynthPath', '')
      .trim()
    return resolverModule.resolveScsynthPath(userOverride ? { explicit: userOverride } : undefined)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ scsynth resolver failed: ${reason}`)
    return null
  }
}
```

What is interesting when reading the implementation is that **the extension `require()`s the engine's compiled JS**. The path `'../engine/dist/audio/supercollider/scsynth-resolver'` directly reads the built JavaScript. There is no need to start the engine process; the resolver can be executed inside the Extension Host process.

If VS Code's setting `orbitscore.scsynthPath` is non-empty, it is passed as `explicit`; if empty, `undefined` is passed and the env → bundle fallback chain is taken.

### The Call Itself is Gated by the Engine Kind

This is the big difference from the 2026-05 reading. **Whether** `resolveScsynthForUI()` is called at all is decided by `getConfiguredEngineKind()`, which normalizes the `orbitscore.engine` setting (#377, `docs/development/WORK_LOG.md` §6.186). The normalization runtime-`require`s the engine's `resolveEngineKind()` so that the UI and the engine never disagree.

```typescript
// packages/vscode-extension/src/extension.ts:654-670
function getConfiguredEngineKind(): 'rust' | 'sc' {
  const raw = vscode.workspace.getConfiguration('orbitscore').get<string>('engine', 'rust')
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const backendModule = require('../engine/dist/audio/engine-backend') as {
      resolveEngineKind: (raw: string | undefined) => 'supercollider' | 'rust'
    }
    return backendModule.resolveEngineKind(raw) === 'supercollider' ? 'sc' : 'rust'
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(
      `⚠️ engine-backend resolver unavailable — falling back to local normalization: ${reason}`,
    )
    const v = raw?.trim().toLowerCase()
    return v === 'sc' || v === 'supercollider' ? 'sc' : 'rust'
  }
}
```

The pre-check in `startEngine()` resolves scsynth only under the `sc` kind; under the `rust` kind it resolves the daemon binary instead.

```typescript
// packages/vscode-extension/src/extension.ts:2054-2070
  // engine kind (#377): scsynth is only relevant under the 'sc' kind. Under
  // 'rust' (default since cutover #369), skip the scsynth pre-check entirely —
  // the native daemon doesn't need scsynth to be resolvable.
  const engineKind = getConfiguredEngineKind()

  // Pre-check: scsynth / daemon が解決できない場合は engine spawn を行わず、エラー
  // Notification のみ表示する。spawn してから boot 失敗するとユーザーに
  // 二重通知 (resolver エラー + engine 終了ログ) が出てしまうのを防ぐ
  // (claude-review on PR #155 の Significant 指摘 #2)。
  // 解決できた場合はその path を engine spawn に再利用 (Minor #1: 二重 fs.statSync 回避)。
  let scResolution: { path: string; source: string } | null = null
  if (engineKind === 'sc') {
    scResolution = resolveScsynthForUI()
    if (!scResolution) {
      void maybeShowBundleNotice()
      return false
    }
```

Under the `sc` kind, when `ScsynthNotFoundError` is thrown, the `catch` returns `null`, and `startEngine()` cancels the engine launch and notifies the user via `maybeShowBundleNotice()`. This is the extension-side realization of "fail loud if there is no bundle," unchanged from the 2026-05 reading. What changed is that **whether this branch is entered** is now decided by the engine kind.

## Resolver Priority Summary

```mermaid
flowchart TD
  START[resolveScsynthPath called] --> EX{opts.explicit\nnon-empty?}
  EX -->|yes| EXE[use the explicit path]
  EX -->|no| ENV{ORBIT_SCSYNTH_PATH\nset?}
  ENV -->|yes| ENVE[use the env path]
  ENV -->|no| BUN{bundle path\nexecutable?}
  BUN -->|yes| BUNE[use the bundle path]
  BUN -->|no| ERR[ScsynthNotFoundError\nthrow]

  EXE --> OK[return ScsynthResolution\n{path, source, searched}]
  ENVE --> OK
  BUNE --> OK
```

Each path is verified by `isExecutableFile()` (existence + execute permission). For "exists but not executable" cases, it is treated as a miss and proceeds to the next candidate.

## Displaying Resolution Result on the Status Bar

The extension calls `updateBundleStatus()` at startup and on configuration change (`orbitscore.scsynthPath` / `orbitscore.engine`). Under the `sc` kind it shows the resolver result on the status bar: one of `'bundle'`, `'env'`, or `'explicit'` is shown as the source, and if unresolved, `$(error) scsynth: not found` is shown emphasized. Under the `rust` kind, on the other hand, **the indicator itself is hidden as long as the daemon resolves**.

```typescript
// packages/vscode-extension/src/extension.ts:726-742
function updateBundleStatus(): void {
  if (!bundleStatusItem) return
  if (getConfiguredEngineKind() === 'rust') {
    const daemonResolution = resolveDaemonForUI()
    if (!daemonResolution) {
      bundleStatusItem.show()
      bundleStatusItem.text = '$(error) daemon: not found'
      bundleStatusItem.tooltip =
        'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.'
      bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
      return
    }
    // 既定（Rust・健全）ではインジケータ自体を出さない（owner 判断 2026-07-17: 常時表示の
    // 意味がない）。daemon 不在エラーと SC バックエンド時のみ表示する。
    bundleStatusItem.hide()
    return
  }
```

Because there is no SC.app fallback, the situation of "appears to be working but is actually misconfigured" is hard to occur.

## The Daemon-Side Counterpart: `resolveDaemonBinaryPath()`

As the leading comment of `scsynth-resolver.ts` says ("the pattern is borrowed from `resolveDaemonBinary()` in `daemon-client.ts`"), the Rust daemon has a resolver of the same shape. There are five candidates, and the daemon bundled in the `.vsix` (#306, `docs/development/WORK_LOG.md` §6.185) comes last.

```typescript
// packages/engine/src/audio/rust-engine/daemon-client.ts:221-250 (extension-bundle 候補の説明コメントを省略)
export function resolveDaemonBinaryPath(explicitPath?: string): DaemonBinaryResolution {
  const searched: string[] = []
  const candidates: DaemonBinaryResolution[] = []
  if (explicitPath) candidates.push({ path: explicitPath, source: 'explicit' })
  const envPath = process.env.ORBIT_AUDIO_DAEMON_PATH
  if (envPath) candidates.push({ path: envPath, source: 'env' })
  // monorepo root (this file は packages/engine/src/audio/rust-engine/) から 4 階層
  const monorepoRoot = path.resolve(__dirname, '../../../../../')
  candidates.push({
    path: path.join(monorepoRoot, 'rust/target/release/orbit-audio-daemon'),
    source: 'monorepo-release',
  })
  candidates.push({
    path: path.join(monorepoRoot, 'rust/target/debug/orbit-audio-daemon'),
    source: 'monorepo-debug',
  })
  // ...
  const platform = `${process.platform}-${process.arch}`
  candidates.push({
    path: path.join(__dirname, '../../../bin', platform, 'orbit-audio-daemon'),
    source: 'extension-bundle',
  })
```

The differences from the scsynth version are that the monorepo's `rust/target/{release,debug}` is inserted in between, and that the bundle location is `engine/bin/<platform>/` (`darwin-arm64` only, `scripts/copy-daemon-bin.sh`). The discipline — "fail loud if not found" and "a candidate must be an executable regular file" — is shared, and the extension-side wrapper `resolveDaemonForUI()` is built symmetrically to `resolveScsynthForUI()` (`extension.ts:702-710`).

## Related Terms

- [scsynth](/en/glossary#scsynth) — the binary itself that this chapter handles. Bundled as a universal binary (arm64 + x86_64)
- [bundle (scsynth source)](/en/glossary#bundle-scsynth-source) — the third candidate of `ScsynthSource`. Resolved by `bundleCandidatePath()` relative to `__dirname`
- [explicit (scsynth source)](/en/glossary#explicit-scsynth-source) — the resolver's highest-priority candidate. The `orbitscore.scsynthPath` setting value
- [env (scsynth source)](/en/glossary#env-scsynth-source) — the `ORBIT_SCSYNTH_PATH` environment variable. Used to specify SC.app during development
- [strict mode (scsynth resolver)](/en/glossary#strict-mode-scsynth-resolver) — the fail-loud design with no implicit fallback to SC.app
- [ScsynthNotFoundError](/en/glossary#scsynthnotfounderror) — the error thrown when all three candidates miss. Reports the searched paths via the `searched` field
- [ScsynthResolution](/en/glossary#scsynthresolution) — the return type of `resolveScsynthPath()`. The three fields `path` / `source` / `searched`
- [StatusBarItem](/en/glossary#statusbaritem) — the VS Code API displaying the bundle resolution status. The resolution result is displayed in `bundleStatusItem` (priority 99); hidden under a healthy `rust` kind

## Related ADRs

- [ADR-001 Choosing SuperCollider as the Implementation Base](/en/decisions/adr-001-supercollider) — the reason scsynth was adopted, the background of the SuperCollider dependency, and its position after cutover #108
- [ADR-003 scsynth Bundle Strict Mode](/en/decisions/adr-003-scsynth-bundle) — the ADR that explains this chapter's content from the perspective of decision-making

## Next Exploration Candidates

- **Details of the bundle extraction script (`scripts/extract-scsynth-bundle.sh`)**: how scsynth / plugins / libsndfile are extracted from SC.app. The procedure to verify the universal binary
- **`scripts/copy-daemon-bin.sh` and `resolveDaemonBinaryPath()`**: why the daemon-side bundle is limited to `darwin-arm64`, and expansion to other platforms
- **Difference of `__dirname` between vscode-extension and engine standalone**: how `__dirname` changes after compilation, and how the bundle path changes. Organize as a map
- **Outlook for Windows / Linux support**: the bundle is macOS Mach-O. The bundle strategy when supporting Windows / Linux in the future (per-platform vsix? system install required?)
- **Bundle code signing**: macOS Gatekeeper and notarization. scsynth keeps the SuperCollider project's own signature, but the daemon is a fresh build (follow-up ② in `docs/development/WORK_LOG.md` §6.185)
- **Type safety of `ORBIT_SCSYNTH_PATH`**: received as a string, with path existence checked on the resolver side. Whether the extension settings UI can offer a path picker

## Sources

- `packages/engine/src/audio/create-audio-engine.ts:17-22` — the branch that makes the SC path an opt-out
- `packages/engine/src/audio/engine-backend.ts:52-53` — definition of `ENGINE_ENV_VAR` (`ORBITSCORE_ENGINE`)
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — module-leading comment: design intent and priority of strict mode
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-45` — type definitions of `ScsynthSource`, `ScsynthResolution`, `ResolveOptions`, `ScsynthNotFoundError`
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:47-59` — the `ENV_VAR` constant and `bundleCandidatePath()`: `__dirname`-relative path computation
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:61-69` — `isExecutableFile()`: stat + mode bit check
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99` — `resolveScsynthPath()`: implementation of the three-stage chain
- `packages/engine/src/audio/rust-engine/daemon-client.ts:221-250` — `resolveDaemonBinaryPath()`: the daemon-side resolver of the same shape (5 candidates)
- `packages/vscode-extension/src/extension.ts:653-669` — `getConfiguredEngineKind()`: normalization of `orbitscore.engine` (runtime require of the engine's `resolveEngineKind`)
- `packages/vscode-extension/src/extension.ts:676-692` — `resolveScsynthForUI()`: requires the engine's compiled JS and calls the wrapper
- `packages/vscode-extension/src/extension.ts:702-710` — `resolveDaemonForUI()`: the symmetric daemon-side wrapper
- `packages/vscode-extension/src/extension.ts:725-766` — `updateBundleStatus()`: branch by engine kind and display switching
- `packages/vscode-extension/src/extension.ts:2053-2069` — `startEngine()` pre-check: scsynth is resolved only under the `sc` kind
- `packages/vscode-extension/BUILD_GUIDE.md:39-97` — explanation of strict mode, extraction procedure, and bundle structure
- `.gitignore:47` / `packages/vscode-extension/.vscodeignore:36` — the bundle is outside git but shipped in the `.vsix`
- `docs/development/WORK_LOG.md` §6.179 / §6.185 / §6.186 — cutover #108, bundling the daemon into the `.vsix` (#306), engine-kind branching (#377)
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — the background of adopting strict mode (removal of SC.app / Spotlight fallback)
- Issue [#136](https://github.com/signalcompose/orbitscore/issues/136) — the "works without SC" requirement and the formulation of the strict mode policy
