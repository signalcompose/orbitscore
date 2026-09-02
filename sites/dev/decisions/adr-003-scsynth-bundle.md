---
title: "ADR-003 scsynth bundle strict mode"
chapter-id: "adr-003"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

::: warning 2026-09 時点の位置づけ
scsynth の bundle と strict resolver は SuperCollider 経路のものです。2026-07-03 の cutover #108（`docs/archive/WORK_LOG_2026-07.md` §6.179）以降、この経路は **`ORBITSCORE_ENGINE=sc`（VS Code では `orbitscore.engine: "sc"`）で opt-out したときだけ**使われ、既定の Rust 経路では scsynth は解決すらされません。ただし本 ADR が決めた「fail loud の resolver」というパターン自体は `orbit-audio-daemon` の解決にそのまま流用されています（末尾の「Consequences revisited (2026-09)」）。既定経路は [RE-1. daemon アーキテクチャ概観](/rust-engine/) を参照してください。

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

OrbitScore は v1.0 から scsynth (SuperCollider のオーディオサーバーバイナリ) を `.vsix` 拡張パッケージに同梱するようになりました。それと同時に、scsynth の path 解決ロジックから SC.app への暗黙 fallback を **意図的に削除** しています。本章ではその意思決定と実装を読み解きます。

---

## 目次

1. [背景: なぜ scsynth を同梱するのか](#背景-なぜ-scsynth-を同梱するのか)
2. [strict mode とは何か](#strict-mode-とは何か)
3. [SC.app fallback の削除: 意思決定の経緯](#scapp-fallback-の削除-意思決定の経緯)
4. [resolver の実装](#resolver-の実装)
5. [bundle の構成と規模](#bundle-の構成と規模)
6. [署名 / Notarize 戦略](#署名--notarize-戦略)
7. [VS Code 拡張側での使用](#vs-code-拡張側での使用)
8. [dev 環境への影響](#dev-環境への影響)
9. [Consequences revisited (2026-09)](#consequences-revisited-2026-09)

---

## 背景: なぜ scsynth を同梱するのか

OrbitScore が SuperCollider を採用するまでの経緯は [ADR-001](/decisions/adr-001-supercollider) で扱いました。SuperCollider を使う以上、ユーザーは `scsynth` バイナリを何らかの方法で入手する必要があります。

初期の実装では、ユーザーが SuperCollider.app を別途インストールする必要がありました。これには次の問題がありました:

1. **インストール体験の悪さ**: `.vsix` をインストールしただけでは動かない
2. **バージョン管理の困難さ**: ユーザーの SC.app バージョンが異なると動作が変わる
3. **ICMC 発表での実演リスク**: 発表会場で「SC.app がないと動きません」では困る

この問題を解決するため、Issue #131 (Epic: v1.0 ICMC Ready Phase 1) の中で scsynth の最小バンドルを `.vsix` に同梱する方針が決まりました。先例として Sonic Pi が同様のアプローチを採っています。

---

## strict mode とは何か

`scsynth-resolver.ts` のコメントに明確に書かれています:

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

「strict mode」とは **fail-loud アプローチ** のことです:
- scsynth が見つかった → そのパスを返す
- scsynth が見つからない → `ScsynthNotFoundError` を **投げる** (SC.app に silent fallback しない)

---

## SC.app fallback の削除: 意思決定の経緯

fallback 削除の PR は #155 (commit `1569110`) で実施されました。commit メッセージに理由が書かれています:

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

さらに変更の詳細として:

> - `ScsynthSource` を `'explicit' | 'env' | 'bundle'` の 3 段階に縮小
> - `SC_APP_DEFAULT_PATH`, `SPOTLIGHT_TIMEOUT_MS`, `findViaSpotlight()` を削除
> - `child_process.spawnSync` import を削除
> - `ScsynthNotFoundError` のメッセージに dev workaround
>   (`ORBIT_SCSYNTH_PATH=/Applications/.../scsynth`) の案内を追記

fallback が**あると困る理由**を整理すると:

1. **隠蔽問題**: bundle の同梱が失敗していても SC.app があれば動いてしまう
2. **cold-install テストの意味が失われる**: bundle なし + SC.app なし環境でのテストができない
3. **本番環境とdev環境が乖離**: 開発者の手元 (SC.app あり) では動くが、ユーザー環境 (SC.app なし) では動かない

これは古典的な「開発環境だけで動く」問題のオーディオバイナリ版です。

---

## resolver の実装

`scsynth-resolver.ts` の核心部分を見てみましょう:

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

`??` (nullish coalescing) を使った連鎖で優先順位を表現しています:

1. `opts.explicit` — 呼び出し元が明示したパス (orbitscore.scsynthPath 設定値)
2. `process.env['ORBIT_SCSYNTH_PATH']` — 環境変数
3. `bundleCandidatePath()` — `.vsix` に同梱された scsynth

すべてが `null` を返したら `ScsynthNotFoundError` を throw します。`searched` 配列には「検索したけど見つからなかったパスの一覧」が入り、エラーメッセージに含まれます。

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

エラーメッセージに「どのパスを探したか」と「dev 環境での回避方法」が書かれています。

`bundleCandidatePath()` の実装も確認しておきましょう:

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:57-59
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}
```

`__dirname` は実行時の `.js` ファイルのディレクトリです。VS Code 拡張に同梱された場合は:

```
packages/vscode-extension/engine/dist/audio/supercollider/scsynth-resolver.js
```

なので `../../../` は:

```
packages/vscode-extension/engine/dist/  → ../
packages/vscode-extension/engine/       → ../../
packages/vscode-extension/              → ../../../
```

となり、`packages/vscode-extension/engine/scsynth/Contents/Resources/scsynth` を指します。

一方、engine パッケージを単独で実行した場合は `packages/engine/dist/...` なので bundle パスが存在せず、常に miss → `ScsynthNotFoundError` になります。これが意図的な設計です (engine 単独実行では `ORBIT_SCSYNTH_PATH` 環境変数で渡す)。

---

## bundle の構成と規模

Issue #134 での調査 (`docs/research/SCSYNTH_BUNDLE_MANIFEST.md`) で、同梱する最小セットが確定しました:

| 要素 | サイズ | 備考 |
|---|---|---|
| scsynth バイナリ | ~1.5 MB | universal binary (arm64 + x86_64) |
| plugins (non-supernova) | ~5.1 MB | 26 ファイル (.scx) |
| libsndfile.dylib | ~4.9 MB | scsynth の唯一の外部依存 |
| **合計** | **~11.5 MB** | libfftw3f は不要と判明し当初予測 13MB から削減 |

`libfftw3f.dylib` を除外した理由も調査結果に残っています:
> `libfftw3f` は **いずれの scx/scsynth も依存していないことを otool で確認** → **同梱しない**

bundle の配置構造は SC.app の内部構造を保ちます:
```
packages/vscode-extension/engine/scsynth/
└── Contents/
    ├── Resources/
    │   ├── scsynth           ← バイナリ本体
    │   └── plugins/          ← 26 .scx ファイル (+ OrbitLinkAudio.scx が build 済みなら同梱)
    └── Frameworks/
        └── libsndfile.dylib  ← 外部依存
```

`@loader_path/../Frameworks/libsndfile.dylib` という scsynth のハードコードされた dylib lookup パスを壊さないために、この構造が必要です。

---

## 署名 / Notarize 戦略

Issue #135 での調査 (`docs/research/CODESIGN_PIPELINE.md`) の結論:

**再署名は不要**。scsynth, libsndfile.dylib, .scx ファイルはすべて SuperCollider プロジェクトの公式署名が入っています:

```
Authority=Developer ID Application: Joshua Parmenter (HE5VJFE9E4)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
```

SC プロジェクトが既に Apple Developer ID + hardened runtime + notarize 済みのバイナリを提供しているため、OrbitScore 側では:
- 追加の Apple Developer ID 取得不要
- GitHub Actions の secrets は `VSCE_PAT` のみ (Apple 関連 secret ゼロ)

という状況でした (daemon についての後日談は「Consequences revisited」を参照)。

---

## VS Code 拡張側での使用

[III-3](/audio/scsynth-bundle) と [IV-1](/editor/vscode-architecture) で扱ったように、VS Code 拡張は `resolveScsynthForUI()` で resolver を呼び出します。ただし 69dc968 時点では、この呼び出しは `orbitscore.engine` が `sc` のときだけ行われます。resolution の結果は status bar インジケータ `bundleStatusItem` の表示に使われます:

| engine kind | `resolution.source` | bundleStatusItem 表示 |
|---|---|---|
| `sc` | `'bundle'` | `$(check) scsynth (bundled)` |
| `sc` | `'env'` または `'explicit'` | `$(gear) scsynth (custom)` |
| `sc` | `null` (解決失敗) | `$(error) scsynth: not found` (赤背景) |
| `rust` | (scsynth は解決しない) | daemon 解決可なら非表示、不可なら `$(error) daemon: not found` |

```typescript
// packages/vscode-extension/src/extension.ts:742-766
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

engine を起動する `startEngine()` でも、`sc` kind では起動前に resolver を呼んで scsynth がないなら **spawn 自体を行わない** (事前チェック) という設計になっています。これにより「engine 起動失敗 + resolver エラー」という二重通知を防いでいます (PR #155 のコードレビューコメントより)。`rust` kind では同じ位置で daemon バイナリを事前チェックします (`extension.ts:2053-2088`)。

---

## dev 環境への影響

fallback 削除により、**SC.app をインストール済みの開発者も** 意識が必要な変化があります:

commit `1569110` の "Dev workflow への影響" セクション:

> engine 単独 CLI (`npm run dev:engine`) で SC.app に頼っていた人:
> → `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth`
>   を env で渡すか、`build:bundle` で bundle を抽出してから実行

2 通りの回避方法:

1. **環境変数経由**: `.zshenv` 等に `export ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth` を追加
2. **bundle 抽出**: `npm run build:bundle` を先に実行して `engine/scsynth/` にバイナリを置く

cutover #108 以降はこれに加えて、そもそも SC 経路を選ぶために `ORBITSCORE_ENGINE=sc` (VS Code なら `orbitscore.engine: "sc"`) が必要です。

---

## Consequences revisited (2026-09)

ADR の形式にならって、決定後の帰結を記録します。

### bundle は据え置き、経路は opt-out に

2026-07-03 の cutover #108 (`docs/archive/WORK_LOG_2026-07.md` §6.179) で既定バックエンドが Rust に切り替わりましたが、scsynth の bundle そのものは残っています。#377 の engine-kind 分岐 (`docs/archive/WORK_LOG_2026-07.md` §6.186) は release.yml について「scsynth 関連ステップ (brew install / build:bundle / verify:bundle) は無改変で維持 (owner 暫定判断: scsynth 同梱は Phase 1 据え置き)」と記録しています。したがって `.vsix` は 69dc968 時点でも SC bundle と daemon バイナリの両方を同梱する構成です。

### strict resolver のパターンは daemon に継承された

本 ADR の中核だった「fail loud・silent fallback を持たない・候補は実行可能ファイルであること」は、`resolveDaemonBinaryPath()` にそのまま引き継がれています。#306 (`docs/archive/WORK_LOG_2026-07.md` §6.185) で `.vsix` 同梱 daemon を最後の候補として追加し、#366 のレビュー Round 2 (§6.186) で「`existsSync` のみで exec bit を見ていない = scsynth 側 `isExecutableFile` と非対称」という指摘を受けて、daemon 側も executable regular file を要求するよう揃えられました。候補の並びは `explicit → env (ORBIT_AUDIO_DAEMON_PATH) → monorepo-release → monorepo-debug → extension-bundle` です。

```typescript
// packages/engine/src/audio/rust-engine/daemon-client.ts:99-99
  source: 'explicit' | 'env' | 'monorepo-release' | 'monorepo-debug' | 'extension-bundle'
```

### 署名の問いは daemon に移った

本 ADR で「再署名不要」と結論したのは SuperCollider 本家の署名を保持できる scsynth の話でした。daemon は新規ビルドなので同じ結論は使えません。§6.185 は「daemon バイナリは Apple Developer ID 署名・notarize 未実施。ダウンロードされた `.vsix` では Gatekeeper に阻まれる可能性がある (未検証)」をフォローアップとして記録しています。

> NOTE: unverified — daemon の署名 / notarize が 69dc968 時点で実施済みかどうかは、本章の範囲では確認していません (WORK_LOG §6.185 のフォローアップ記述を引いているだけです)。

### UI 上の帰結

`bundleStatusItem` は `rust` kind で daemon が解決できる限り非表示 (owner 判断 2026-07-17、`extension.ts:737-739` のコメント) になり、scsynth の状態表示は `sc` を選んだ人だけが見るものになりました。`forceKillScsynth` / `selectAudioDevice` も `package.json` の `commandPalette` で `config.orbitscore.engine == 'sc'` に gate されています。

---

## 関連用語

- [strict mode (scsynth resolver)](/glossary#strict-mode-scsynth-resolver) — 本 ADR の核心。SC.app への暗黙 fallback を持たない fail-loud 設計
- [bundle (scsynth source)](/glossary#bundle-scsynth-source) — `.vsix` に同梱された scsynth バイナリ。resolver の第 3 優先候補
- [explicit (scsynth source)](/glossary#explicit-scsynth-source) — resolver の最優先。`orbitscore.scsynthPath` 設定値
- [env (scsynth source)](/glossary#env-scsynth-source) — `ORBIT_SCSYNTH_PATH` 環境変数。dev 環境で SC.app を指定する方法
- [ScsynthNotFoundError](/glossary#scsynthnotfounderror) — 3 候補すべて miss 時に throw されるエラークラス
- [ScsynthResolution](/glossary#scsynthresolution) — `resolveScsynthPath()` の返り値型
- [scsynth](/glossary#scsynth) — bundle の主役。universal binary (arm64 + x86_64)
- [StatusBarItem](/glossary#statusbaritem) — `bundleStatusItem` が bundle 解決状態を表示するための VS Code API

## 関連 ADR

- [ADR-001 SuperCollider ベース実装の選択](/decisions/adr-001-supercollider) — scsynth を採用した理由。本 ADR の bundle 戦略はこの選択の帰結。cutover 後の位置づけも同 ADR の「Consequences revisited」に
- [ADR-002 DSL v3 Pivot](/decisions/adr-002-dsl-v3-pivot) — scsynth に依存する Audio DSL が確定した意思決定

## 次の深掘り候補

- `build:bundle` スクリプト (`scripts/extract-scsynth-bundle.sh`) の実装 — scsynth を SC.app から抽出・配置する処理の詳細
- `scripts/copy-daemon-bin.sh` — daemon 側の同梱スクリプト。`darwin-arm64` 限定の理由と release.yml での順序保証
- Windows / Linux での bundle 戦略 — macOS 向け universal binary 以外のプラットフォーム対応
- SC.app バージョン up 時の bundle 更新フロー — `SCSYNTH_BUNDLE_MANIFEST.md` の Update policy (Major/Minor bump のみ re-extract)
- bundle 同梱の GPL-3.0 ライセンス対応 — `SCSYNTH_BUNDLE_MANIFEST.md` に「GPL-3.0 aggregation 性を強く保つ」と記録されている問題の詳細
- daemon の署名 / notarize の実施状況 — §6.185 のフォローアップがその後どう扱われたか

---

## Sources

- `packages/engine/src/audio/create-audio-engine.ts:17-22` — SC 経路が opt-out になる分岐
- `packages/engine/src/audio/engine-backend.ts:52-53` — `ENGINE_ENV_VAR` (`ORBITSCORE_ENGINE`) の定義
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:1-17` — ファイル冒頭コメント: strict mode の意図と優先順位の説明
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:22-98` — `ScsynthNotFoundError`, `bundleCandidatePath()`, `resolveScsynthPath()` の実装
- `packages/engine/src/audio/rust-engine/daemon-client.ts:99-99` / `:221-250` — daemon 側の source 種別と `resolveDaemonBinaryPath()`
- `packages/vscode-extension/src/extension.ts:653-669` — `getConfiguredEngineKind()`: engine kind の正規化
- `packages/vscode-extension/src/extension.ts:676-692` — `resolveScsynthForUI()`: runtime require によるフロントエンド側解決
- `packages/vscode-extension/src/extension.ts:725-766` — `updateBundleStatus()`: engine kind 分岐と resolution.source による status bar 表示切り替え
- `packages/vscode-extension/src/extension.ts:2053-2088` — `startEngine()` の事前チェック: `sc` は scsynth、`rust` は daemon
- `packages/vscode-extension/package.json` — `orbitscore.engine` 設定 (既定 `"rust"`) と `commandPalette` の `when` 句
- commit `1569110` — SC.app/Spotlight fallback 削除の詳細 (動機・変更内容・dev 影響)
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — scsynth bundle strict mode 採用
- `docs/archive/WORK_LOG_2026-07.md` §6.179 / §6.185 / §6.186 — cutover #108、daemon の `.vsix` 同梱 (#306)、engine-kind 分岐と bundle 手順の据え置き (#377)
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` — Issue #134: bundle 最小セット確定 (26 plugins + libsndfile)
- `docs/research/CODESIGN_PIPELINE.md` — Issue #135: 署名 Notarize 調査 (再署名不要の結論)
- `docs/research/SCSYNTH_STANDALONE.md` — Issue #133: SC.app 外でのスタンドアロン起動検証
