---
title: "III-3. scsynth bundle と path resolution"
chapter-id: "III-3"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

::: warning 2026-09 時点の位置づけ
scsynth の bundle と path resolution は SuperCollider 経路の話で、2026-07-03 の cutover #108（`docs/archive/WORK_LOG_2026-07.md` §6.179）以降は **`ORBITSCORE_ENGINE=sc`（VS Code 設定では `orbitscore.engine: "sc"`）で opt-out したときだけ**通る経路です。既定の Rust 経路では、拡張は scsynth を解決せず `orbit-audio-daemon` バイナリを同じ strict パターンで解決します（本章末尾の「daemon 側の対応物」を参照）。既定経路の全体像は [RE-1. daemon アーキテクチャ概観](/rust-engine/) を参照してください。

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

# III-3. scsynth bundle と path resolution

SC 経路では、OrbitScore の `.vsix` をインストールするだけで音が出る。その裏には「scsynth バイナリを extension に同梱する」という設計があります。本章では、なぜ同梱するのか、どう配置されているのか、そして engine がどの順序でバイナリを探して見つけられなければどう振る舞うのかを追います。

[0-2. アーキテクチャ全景](/orientation/architecture-overview) で strict mode の方針には触れました。本章ではその **「なぜその設計にしたか」** の経緯と、resolver コードの詳細を深掘りします。

## なぜ bundle するのか: Issue #136 の問い

OrbitScore の初期設計では、ユーザーが SuperCollider をインストール済みであることを前提としていました。engine は起動時に SC.app (`/Applications/SuperCollider.app/Contents/Resources/scsynth`) が存在すれば使い、なければエラーというシンプルな実装でした。

これを変えた動機が Issue #136 「SC 不要で動く」要件です。`.vsix` を install したユーザーが SuperCollider を別途インストールせずに動いてほしい、という要件です。対応する設計として採択されたのが **scsynth バイナリ + plugin + libsndfile を `.vsix` に同梱する** バンドル戦略でした (PR [#155](https://github.com/signalcompose/orbitscore/pull/155))。

### SC.app fallback を持たない理由

バンドルすると同時に、SC.app への暗黙 fallback を **廃止** しています。その理由は `scsynth-resolver.ts` の先頭コメントが説明しています。

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

SC.app fallback があると「bundle 抽出が失敗したのに SC.app が補填してしまい、production ビルドのバンドル問題がサイレントに隠蔽される」というリスクがあります。fail loud (見つからなければ明示エラー) にすることで、bundle の問題を確実に検知できるようにしています。

## bundle のファイル構造

`.vsix` に同梱される bundle は git 管理外 (`.gitignore:47` の `packages/vscode-extension/engine/`) ですが、`.vscodeignore:36` の `!engine/scsynth/**` で `.vsix` には残され、`BUILD_GUIDE.md` がその構造を定義しています。

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

`Contents/Resources/scsynth` が実行バイナリで、arm64 と x86_64 の universal binary です。`plugins/` は scsynth が音声処理に使うプラグイン群 (`.scx` ファイル) で、LinkAudio 用の `OrbitLinkAudio.scx` は build 済みのときだけ同梱されます。`libsndfile.dylib` はオーディオファイルのデコードに使うダイナミックライブラリで、これがあることで WAV / AIFF 等のデコードが動きます。

bundle は release pipeline で `npm run build:bundle` (`scripts/extract-scsynth-bundle.sh`) を実行して生成します。ソースコードには含まれず、リリース時に都度生成されます。

## resolver の実装: 3 段階の優先順位

`resolveScsynthPath()` は 3 つの候補を順に試します。

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

`??` 演算子でチェーンしていて、左から順に試し、最初に `null` でない値が返れば終了します。3 つすべてが `null` の場合は即時 `ScsynthNotFoundError` を throw します。

### 候補 1: explicit (caller 明示)

`opts.explicit` は caller が直接パスを渡す場合です。VS Code extension の設定 (`orbitscore.scsynthPath`) でユーザーが独自パスを指定したときに使われます。

### 候補 2: env (`ORBIT_SCSYNTH_PATH`)

環境変数 `ORBIT_SCSYNTH_PATH` が設定されていれば、その値を使います。開発時に SC.app を使いたい場合はこの方法を使います。

```bash
ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth npm run dev:engine
```

`const ENV_VAR = 'ORBIT_SCSYNTH_PATH'` で定数化されています。

### 候補 3: bundle (`bundleCandidatePath()`)

`.vsix` 同梱の scsynth を参照します。

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:57-59
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}
```

`__dirname` は実行時にコンパイル済み JS ファイルのディレクトリに解決されます。vscode-extension に同梱される場合は `packages/vscode-extension/engine/dist/audio/supercollider/` が `__dirname` となり、`../../../` で `packages/vscode-extension/engine/` まで上がり、`scsynth/Contents/Resources/scsynth` に到達します。

engine package を単独で使う場合 (`packages/engine/dist/`) は bundle が存在しないため、常に miss → `ScsynthNotFoundError` になります。dev 環境では env 経由で解決します。

### isExecutableFile の実装

各候補は実際のファイルとして存在し、実行権限があるかを確認します。

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

`stat.mode & 0o111` は POSIX の実行権限ビット (owner / group / other の execute bit) のいずれかが立っているかを確認します。ファイルが存在しない場合は `statSync` が例外を投げますが、catch して `false` を返すことで graceful に処理します。

## エラー時の挙動: ScsynthNotFoundError

3 候補すべてが miss すると `ScsynthNotFoundError` が throw されます。

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

エラーメッセージには探索したパス一覧が含まれているため、「どこを探して見つからなかったか」が一目で分かります。`searched` プロパティもエラーオブジェクトに付いているので、catch した側でプログラム的に参照できます。

## extension 側の wrapper: `resolveScsynthForUI()`

VS Code extension は engine の compiled JS を `require()` して resolver を使います。

```typescript
// packages/vscode-extension/src/extension.ts:676-692
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

実装を読んで面白いのは、**extension は engine の compiled JS を `require()` している** という点です。`'../engine/dist/audio/supercollider/scsynth-resolver'` というパスはビルド済みの JavaScript を直接読んでいます。engine プロセスを起動する必要がなく、Extension Host プロセス内で resolver を実行できます。

VS Code の設定 `orbitscore.scsynthPath` が非空ならば `explicit` として渡し、空ならば `undefined` を渡して env → bundle の順に fallback させます。

### engine kind で呼び出しそのものが gate される

ここが 2026-05 時点との大きな違いです。`resolveScsynthForUI()` を **呼ぶかどうか**を、`orbitscore.engine` 設定を正規化した `getConfiguredEngineKind()` が決めます (#377、`docs/archive/WORK_LOG_2026-07.md` §6.186)。正規化は engine 側の `resolveEngineKind()` を runtime `require` して行い、UI と engine で判定がズレないようにしています。

```typescript
// packages/vscode-extension/src/extension.ts:653-669
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

`startEngine()` の事前チェックは、`sc` kind のときだけ scsynth を解決し、`rust` kind では代わりに daemon バイナリを解決します。

```typescript
// packages/vscode-extension/src/extension.ts:2053-2069
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

`sc` kind で `ScsynthNotFoundError` が throw されると `catch` が `null` を返し、`startEngine()` は engine の起動をキャンセルして `maybeShowBundleNotice()` でユーザーに通知します。これが「bundle がなければ fail loud」の extension 側の実現で、2026-05 時点から変わっていません。変わったのは、この分岐に**入るかどうか**が engine kind で決まるようになった点です。

## resolver の優先順位まとめ

```mermaid
flowchart TD
  START[resolveScsynthPath 呼び出し] --> EX{opts.explicit\n非空?}
  EX -->|yes| EXE[explicit パスを使用]
  EX -->|no| ENV{ORBIT_SCSYNTH_PATH\n設定済?}
  ENV -->|yes| ENVE[env パスを使用]
  ENV -->|no| BUN{bundle パス\n実行可能?}
  BUN -->|yes| BUNE[bundle パスを使用]
  BUN -->|no| ERR[ScsynthNotFoundError\nthrow]

  EXE --> OK[ScsynthResolution 返却\n{path, source, searched}]
  ENVE --> OK
  BUNE --> OK
```

各パスは `isExecutableFile()` (存在 + 実行権限) で検証します。「存在するが実行できない」場合は miss として次の候補に進みます。

## 解決結果のステータスバー表示

extension は起動時と設定変更時 (`orbitscore.scsynthPath` / `orbitscore.engine`) に `updateBundleStatus()` を呼びます。`sc` kind では resolver の結果をステータスバーに表示し、source が `'bundle'`, `'env'`, `'explicit'` のいずれかが表示され、未解決なら `$(error) scsynth: not found` と強調表示されます。一方 `rust` kind では **daemon が解決できる限りインジケータ自体を隠します**。

```typescript
// packages/vscode-extension/src/extension.ts:725-741
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

SC.app fallback がないため、「一見動いているように見えて実はおかしい」という状態が発生しにくい設計です。

## daemon 側の対応物: `resolveDaemonBinaryPath()`

`scsynth-resolver.ts` の先頭コメントが「パターンは `daemon-client.ts` の `resolveDaemonBinary()` を流用」と書いているとおり、Rust daemon にも同型の resolver があります。候補は 5 つで、`.vsix` 同梱の daemon (#306、`docs/archive/WORK_LOG_2026-07.md` §6.185) が最後に来ます。

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

scsynth 版との違いは、monorepo の `rust/target/{release,debug}` を挟む点と、bundle の置き場所が `engine/bin/<platform>/` (`darwin-arm64` のみ、`scripts/copy-daemon-bin.sh`) である点です。「見つからなければ fail loud」「候補は実行可能な regular file であること」という規律は共通で、extension 側の wrapper `resolveDaemonForUI()` も `resolveScsynthForUI()` と対称に作られています (`extension.ts:702-710`)。

## 関連用語

- [scsynth](/glossary#scsynth) — 本章が扱うバイナリ本体。universal binary (arm64 + x86_64) として bundle に同梱
- [bundle (scsynth source)](/glossary#bundle-scsynth-source) — `ScsynthSource` の 3 番目の候補。`bundleCandidatePath()` が `__dirname` 相対で解決
- [explicit (scsynth source)](/glossary#explicit-scsynth-source) — resolver の最優先候補。`orbitscore.scsynthPath` 設定値
- [env (scsynth source)](/glossary#env-scsynth-source) — `ORBIT_SCSYNTH_PATH` 環境変数。開発時に SC.app を指定する用途
- [strict mode (scsynth resolver)](/glossary#strict-mode-scsynth-resolver) — SC.app への暗黙 fallback を持たない fail-loud 設計
- [ScsynthNotFoundError](/glossary#scsynthnotfounderror) — 3 候補すべて miss 時に throw されるエラー。`searched` フィールドで探索済みパスを報告
- [ScsynthResolution](/glossary#scsynthresolution) — `resolveScsynthPath()` の返り値型。`path` / `source` / `searched` の 3 フィールド
- [StatusBarItem](/glossary#statusbaritem) — bundle 解決状態を表示する VS Code API。`bundleStatusItem` (priority 99) に解決結果を表示 (`rust` kind で健全なら非表示)

## 関連 ADR

- [ADR-001 SuperCollider ベース実装の選択](/decisions/adr-001-supercollider) — scsynth を採用した理由と SuperCollider 依存の背景、cutover #108 後の位置づけ
- [ADR-003 scsynth bundle strict mode](/decisions/adr-003-scsynth-bundle) — 本章の内容を意思決定の視点から詳説する ADR

## 次の深掘り候補

- **bundle 抽出スクリプト (`scripts/extract-scsynth-bundle.sh`) の詳細**: SC.app からどう scsynth / plugins / libsndfile を抽出しているか。universal binary の確認手順
- **`scripts/copy-daemon-bin.sh` と `resolveDaemonBinaryPath()`**: daemon 側の bundle が `darwin-arm64` 限定である理由と、他 platform への展開
- **`__dirname` の vscode-extension vs engine 単独での違い**: コンパイル後の `__dirname` がどう変わり、bundle パスがどう変わるか。map で整理する
- **Windows / Linux 対応の見通し**: bundle は macOS Mach-O。将来 Windows / Linux に対応する場合の bundle 戦略 (per-platform vsix? system install 必須?)
- **bundle の codesign**: macOS Gatekeeper と notarization。scsynth は SuperCollider 本家の署名を保持するが、daemon は新規ビルド (`docs/archive/WORK_LOG_2026-07.md` §6.185 のフォローアップ②)
- **`ORBIT_SCSYNTH_PATH` の型安全性**: 文字列で受け取り、パスの存在確認は resolver 側。extension の設定 UI で path picker を提供できるか

## Sources

- `packages/engine/src/audio/create-audio-engine.ts:17-22` — SC 経路が opt-out になる分岐
- `packages/engine/src/audio/engine-backend.ts:52-53` — `ENGINE_ENV_VAR` (`ORBITSCORE_ENGINE`) の定義
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — モジュール先頭コメント: strict mode の設計意図と優先順位
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-45` — `ScsynthSource`, `ScsynthResolution`, `ResolveOptions`, `ScsynthNotFoundError` の型定義
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:47-59` — `ENV_VAR` 定数と `bundleCandidatePath()`: `__dirname` 相対パス計算
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:61-69` — `isExecutableFile()`: stat + mode bit 検査
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99` — `resolveScsynthPath()`: 3 段階チェーンの実装
- `packages/engine/src/audio/rust-engine/daemon-client.ts:221-250` — `resolveDaemonBinaryPath()`: daemon 側の同型 resolver (5 候補)
- `packages/vscode-extension/src/extension.ts:653-669` — `getConfiguredEngineKind()`: `orbitscore.engine` の正規化 (engine 側 `resolveEngineKind` を runtime require)
- `packages/vscode-extension/src/extension.ts:676-692` — `resolveScsynthForUI()`: engine compiled JS を require して wrapper 呼び出し
- `packages/vscode-extension/src/extension.ts:702-710` — `resolveDaemonForUI()`: daemon 側の対称 wrapper
- `packages/vscode-extension/src/extension.ts:725-766` — `updateBundleStatus()`: engine kind による分岐と表示切り替え
- `packages/vscode-extension/src/extension.ts:2053-2069` — `startEngine()` の事前チェック: `sc` kind でのみ scsynth を解決
- `packages/vscode-extension/BUILD_GUIDE.md:39-97` — strict mode の説明、抽出手順、bundle 構造
- `.gitignore:47` / `packages/vscode-extension/.vscodeignore:36` — bundle は git 管理外だが `.vsix` には同梱される
- `docs/archive/WORK_LOG_2026-07.md` §6.179 / §6.185 / §6.186 — cutover #108、daemon の `.vsix` 同梱 (#306)、engine-kind 分岐 (#377)
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — strict mode 採用の経緯 (SC.app / Spotlight fallback の廃止)
- Issue [#136](https://github.com/signalcompose/orbitscore/issues/136) — "SC 不要で動く" 要件と strict mode 方針の策定
