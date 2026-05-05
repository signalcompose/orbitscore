---
title: "III-3. scsynth bundle と path resolution"
chapter-id: "III-3"
verified-against: 0a4b598
verified-at: "2026-05-05"
status: draft
---

> **Note**: 本ページは 2026-05-05 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# III-3. scsynth bundle と path resolution

OrbitScore の `.vsix` をインストールするだけで音が出る。その裏には「scsynth バイナリを extension に同梱する」という設計があります。本章では、なぜ同梱するのか、どう配置されているのか、そして engine がどの順序でバイナリを探して見つけられなければどう振る舞うのかを追います。

[0-2. アーキテクチャ全景](/orientation/architecture-overview) で strict mode の方針には触れました。本章ではその **「なぜその設計にしたか」** の経緯と、resolver コードの詳細を深掘りします。

## なぜ bundle するのか: Issue #136 の問い

OrbitScore の初期設計では、ユーザーが SuperCollider をインストール済みであることを前提としていました。engine は起動時に SC.app (`/Applications/SuperCollider.app/Contents/Resources/scsynth`) が存在すれば使い、なければエラーというシンプルな実装でした。

これを変えた動機が Issue #136 「SC 不要で動く」要件です。`.vsix` を install したユーザーが SuperCollider を別途インストールせずに動いてほしい、という要件です。対応する設計として採択されたのが **scsynth バイナリ + plugin + libsndfile を `.vsix` に同梱する** バンドル戦略でした (PR [#155](https://github.com/signalcompose/orbitscore/pull/155))。

### SC.app fallback を持たない理由

バンドルすると同時に、SC.app への暗黙 fallback を **廃止** しています。その理由は `scsynth-resolver.ts` の先頭コメントが説明しています。

```typescript
// scsynth-resolver.ts:1-17
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

`.vsix` に同梱される bundle は git 管理外 (`.gitignore:36`) ですが、`BUILD_GUIDE.md` がその構造を定義しています。

```
packages/vscode-extension/engine/scsynth/
├── Contents/
│   ├── Resources/
│   │   ├── scsynth                (1.5 MB, universal arm64+x86_64)
│   │   └── plugins/               (26 .scx ファイル、5.1 MB)
│   └── Frameworks/
│       └── libsndfile.dylib       (4.9 MB)
├── LICENSE.GPL-3.0
└── NOTICE
```

`Contents/Resources/scsynth` が実行バイナリで、arm64 と x86_64 の universal binary です。`plugins/` は scsynth が音声処理に使うプラグイン群 (`.scx` ファイル) です。`libsndfile.dylib` はオーディオファイルのデコードに使うダイナミックライブラリで、これがあることで WAV / AIFF 等のデコードが動きます。

bundle は CI / release pipeline で `npm run build:bundle` を実行して生成します。ソースコードには含まれず、リリース時に都度生成されます。

## resolver の実装: 3 段階の優先順位

`resolveScsynthPath()` は 3 つの候補を順に試します。

```typescript
// scsynth-resolver.ts:76-99
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
// scsynth-resolver.ts:57-59
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}
```

`__dirname` は実行時にコンパイル済み JS ファイルのディレクトリに解決されます。vscode-extension に同梱される場合は `packages/vscode-extension/engine/dist/audio/supercollider/` が `__dirname` となり、`../../../` で `packages/vscode-extension/engine/` まで上がり、`scsynth/Contents/Resources/scsynth` に到達します。

engine package を単独で使う場合 (`packages/engine/dist/`) は bundle が存在しないため、常に miss → `ScsynthNotFoundError` になります。dev 環境では env 経由で解決します。

### isExecutableFile の実装

各候補は実際のファイルとして存在し、実行権限があるかを確認します。

```typescript
// scsynth-resolver.ts:61-69
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
// scsynth-resolver.ts:34-45
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
// extension.ts:113-129
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

`ScsynthNotFoundError` が throw されると `catch` が受け取り `null` を返します。`null` を受け取った `startEngine()` は engine の起動をキャンセルし、ユーザーに通知します。これが「bundle がなければ fail loud」の extension 側の実現です。

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

extension は起動時と設定変更時に `updateBundleStatus()` を呼び、resolver の結果をステータスバーに表示します。source が `'bundle'`, `'env'`, `'explicit'` のいずれかが表示され、未解決なら `$(error) scsynth: not found` と強調表示されます。SC.app fallback がないため、「一見動いているように見えて実はおかしい」という状態が発生しにくい設計です。

## 関連用語

- [scsynth](/glossary#scsynth) — 本章が扱うバイナリ本体。universal binary (arm64 + x86_64) として bundle に同梱
- [bundle (scsynth source)](/glossary#bundle-scsynth-source) — `ScsynthSource` の 3 番目の候補。`bundleCandidatePath()` が `__dirname` 相対で解決
- [explicit (scsynth source)](/glossary#explicit-scsynth-source) — resolver の最優先候補。`orbitscore.scsynthPath` 設定値
- [env (scsynth source)](/glossary#env-scsynth-source) — `ORBIT_SCSYNTH_PATH` 環境変数。開発時に SC.app を指定する用途
- [strict mode (scsynth resolver)](/glossary#strict-mode-scsynth-resolver) — SC.app への暗黙 fallback を持たない fail-loud 設計
- [ScsynthNotFoundError](/glossary#scsynthnotfounderror) — 3 候補すべて miss 時に throw されるエラー。`searched` フィールドで探索済みパスを報告
- [ScsynthResolution](/glossary#scsynthresolution) — `resolveScsynthPath()` の返り値型。`path` / `source` / `searched` の 3 フィールド
- [StatusBarItem](/glossary#statusbaritem) — bundle 解決状態を表示する VS Code API。`bundleStatusItem` (priority 99) に解決結果を表示

## 関連 ADR

- [ADR-001 SuperCollider ベース実装の選択](/decisions/adr-001-supercollider) — scsynth を採用した理由と SuperCollider 依存の背景
- [ADR-003 scsynth bundle strict mode](/decisions/adr-003-scsynth-bundle) — 本章の内容を意思決定の視点から詳説する ADR

## 次の深掘り候補

- **bundle 抽出スクリプト (`extract-scsynth-bundle.sh`) の詳細**: SC.app からどう scsynth / plugins / libsndfile を抽出しているか。universal binary の確認手順
- **`__dirname` の vscode-extension vs engine 単独での違い**: コンパイル後の `__dirname` がどう変わり、bundle パスがどう変わるか。map で整理する
- **Windows / Linux 対応の見通し**: bundle は macOS Mach-O。将来 Windows / Linux に対応する場合の bundle 戦略 (per-platform vsix? system install 必須?)
- **bundle の codesign**: macOS Gatekeeper と notarization。`.vsix` 同梱のネイティブバイナリが Gatekeeper に引っかかるリスクと現在の対応状況
- **`ORBIT_SCSYNTH_PATH` の型安全性**: 現在は文字列、パスの存在確認は resolver 側。extension の設定 UI で path picker を提供できるか

## Sources

- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — モジュール先頭コメント: strict mode の設計意図と優先順位
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-45` — `ScsynthSource`, `ScsynthResolution`, `ResolveOptions`, `ScsynthNotFoundError` の型定義
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:47-59` — `ENV_VAR` 定数と `bundleCandidatePath()`: `__dirname` 相対パス計算
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:61-69` — `isExecutableFile()`: stat + mode bit 検査
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99` — `resolveScsynthPath()`: 3 段階チェーンの実装
- `packages/vscode-extension/src/extension.ts:113-129` — `resolveScsynthForUI()`: engine compiled JS を require して wrapper 呼び出し
- `packages/vscode-extension/BUILD_GUIDE.md:39-82` — strict mode の説明、bundle 構造、抽出手順
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — strict mode 採用の経緯 (SC.app / Spotlight fallback の廃止)
- Issue [#136](https://github.com/signalcompose/orbitscore/issues/136) — "SC 不要で動く" 要件と strict mode 方針の策定
