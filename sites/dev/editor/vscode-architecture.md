---
title: "IV-1. VS Code 拡張アーキテクチャ"
chapter-id: "IV-1"
verified-against: a2ac724
verified-at: "2026-09-11"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡で、2026-09-04 に #385（PR [#730](https://github.com/signalcompose/orbitscore/pull/730)・`capabilities.untrustedWorkspaces` の宣言）まで、2026-09-06 に #385 層 2 の繰り延べ（PR [#750](https://github.com/signalcompose/orbitscore/pull/750)）と #756（PR [#776](https://github.com/signalcompose/orbitscore/pull/776)・`ERROR:` 前置の行単位化）まで、2026-09-08 に #773（PR [#811](https://github.com/signalcompose/orbitscore/pull/811)・stdout bridge 封筒の行単位化）まで、2026-09-11 に #873（PR [#874](https://github.com/signalcompose/orbitscore/pull/874)・拡張自身の実行時依存の同梱）まで追従しました。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# IV-1. VS Code 拡張アーキテクチャ

OrbitScore の VS Code 拡張 (`packages/vscode-extension`、package version 2.1.0) は、どのようにして起動し、エンジンとどのようにつながっているのでしょうか。本章ではその内部構造を extension の activation から engine プロセスとの通信まで順を追って読み解きます。2026-05 の初稿から最も変わったのは「engine kind の分岐」「engine ライフサイクルの vscode 非依存モジュールへの抽出」「MCP サーバ・playhead・Engine ビューといった周辺機能の増加」で、末尾に drift の一覧をまとめました。

---

## 目次

1. [Extension Host の基礎](#extension-host-の基礎)
2. [activation と activationEvents](#activation-と-activationevents)
3. [workspace trust と untrustedWorkspaces](#workspace-trust-と-untrustedworkspaces)
4. [モジュールレベルの状態](#モジュールレベルの状態)
5. [`activate()` 関数の全体像](#activate-関数の全体像)
6. [Status Bar: 2 本のインジケータ](#status-bar-2-本のインジケータ)
7. [Command 登録](#command-登録)
8. [IntelliSense と診断の登録](#intellisense-と診断の登録)
9. [バイナリ解決: daemon](#バイナリ解決-daemon)
10. [Engine プロセスの spawn](#engine-プロセスの-spawn)
11. [Engine との通信プロトコル](#engine-との通信プロトコル)
12. [Engine の停止とライフサイクルの識別ガード](#engine-の停止とライフサイクルの識別ガード)
13. [アーキテクチャ全体図](#アーキテクチャ全体図)
14. [2026-09 時点の drift](#2026-09-時点の-drift)

---

## Extension Host の基礎

VS Code 拡張は **Extension Host** と呼ばれる専用の Node.js プロセス上で動きます。Renderer プロセス (エディタ UI) から fork されていて、DOM へのアクセスはありませんが、Node.js の全機能 (`fs`, `child_process` 等) が使えます。OrbitScore 拡張はこの Extension Host から別途 `child_process.spawn` で engine プロセスを起動し、engine がさらに音声プロセスを起動するため、プロセスは 3 層になります:

```
VS Code Renderer (UI)
    └── Extension Host (Node.js)  ← 拡張コードが動く
            └── engine process (node engine/dist/cli-audio.js repl)  ← OrbitScore DSL エンジン
                    └── orbit-audio-daemon (Rust・唯一のバックエンド・WebSocket)
```

音声プロセスは `orbit-audio-daemon` の 1 択です。かつては `orbitscore.engine` 設定 (既定 `"rust"`) で scsynth (SuperCollider・OSC) を選べ、その分岐が本章の随所に顔を出していましたが、設定・分岐とも [#840](https://github.com/signalcompose/orbitscore/pull/840)（#502）で削除されました。以下、その分岐に触れる箇所には削除済みである旨を添えています。

---

## activation と activationEvents

`package.json` が `activationEvents` フィールドで「どのタイミングで起動するか」を宣言します。

OrbitScore が使っているのは 2 種類です:

- `"onStartupFinished"`: VS Code 起動が完了した時点で無条件に起動
- `"onLanguage:orbitscore"`: `.orbs` ファイル (language ID: `orbitscore`) を開いた瞬間に起動

`onStartupFinished` があるため、OrbitScore ファイルを開いていなくても拡張は常時ロードされます。Status bar インジケータが常に表示されているのはこのためです。

---

## workspace trust と untrustedWorkspaces

`activationEvents` が決めるのは「いつ起動するか」でした。では「そもそも起動してよいか」は誰が決めるのでしょうか。それが VS Code の **workspace trust** (ワークスペースの信頼) です。信頼されていないワークスペースでは拡張は既定で「制限付き」になり、`activate()` そのものが呼ばれません。

ここで問題になるのが、フォルダを開かずに `.orbs` を 1 本だけ渡す起動 (`orbs file.orbs`) です。この形は VS Code 側では **ad-hoc な未信頼ワークスペース**として扱われるため、`capabilities.untrustedWorkspaces` を宣言していない拡張はそこで activate されません。利用者からは「何も起きない」ようにしか見えないので、**実害は拒否ではなく沈黙**でした (#385)。

宣言は `package.json` の `engines` と `main` のあいだに置かれています。

```json
// packages/vscode-extension/package.json:32-38
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": true,
      "description": "OrbitScore starts a native audio engine and loads the audio plugins named by the score, the same way a DAW opens a project. Evaluation works in untrusted workspaces; only the settings that choose which executable runs are restricted.",
      "restrictedConfigurations": []
    }
  },
```

`supported: true` は「未信頼でも制限しない」という宣言です。裁定の根拠は「一般的な DAW の挙動に併せて」で (`docs/design/656-release-design.md` §16 (1))、DAW はプロジェクトを開くときに信頼を問わずプラグインを読みます。OrbitScore も未信頼ワークスペースで engine を起動し、譜面の `instrument(path)` を読みます。そのため `startEngine()` の側に信頼を確かめるガードは置かれていません。ライブコーディングは評価を繰り返す行為なので、1 回の確認ダイアログが「毎回の中断」になってしまうからです。

`restrictedConfigurations` は `supported` の値とは独立に効き、挙げた設定キーは未信頼ワークスペースで**ワークスペース側の設定値が無視され、ユーザー設定の値が使われます**。かつてここには `orbitscore.scsynthPath`（実行ファイルのパスそのもの）と `orbitscore.engine`（`"sc"` に倒すと `scsynthPath` を有効化する）の 2 件が挙がっていましたが、**両方とも #502 で SC 経路ごと削除**されたため、**2026-09-10 時点では空配列**です。唯一残るバックエンド（Rust daemon）を選ぶ実行ファイルはワークスペースの設定値では変わらないため、restrict すべき設定が無くなりました。

面白いのは、この宣言がコードからは一度も読まれないという点です。放っておくと「誰も読まない設定」になってしまうので、`tests/vscode-extension/untrusted-workspace-capability.spec.ts` の 6 本がマニフェストを直接読んで検査しています。`restrictedConfigurations` を配列として取り出せない形になったらその場で落とす、という書き方になっているのは、`?? []` へフォールバックすると宣言が丸ごと消えたときに `for...of` が 0 周して green になってしまうためです。

ただし**この層が保証するのは宣言の内容までです**。「実際に未信頼ワークスペースで activate され、しかも普通に音が出る」ことは実機の gated E2E (`E2E-D1`) が押さえる予定で、こちらは #735 へ分離されました。`--extensionDevelopmentPath` で起動する開発モードは workspace trust の制限を迂回するため、そこで書いた E2E は `capabilities` ブロックを丸ごと削除しても緑になってしまう、というのが 2026-09-04 の実測です。

さらに、**この宣言が効くのは OrbitScore 自身の拡張だけです**。OrbitStudio には `anthropic.claude-code` が同居しますが、`docs/planning/DEVELOPMENT_MAP.md` §4.J (PR [#750](https://github.com/signalcompose/orbitscore/pull/750)) の記録によれば、そちらは `untrustedWorkspaces.supported: false` を宣言していて、Anthropic 管理なので**こちらから宣言を足せません**。つまり loose-file 起動では OrbitScore は activate しても **LLM 側が黙って activate しない**ままで、LLM を第一級ユーザーに置く方針では出荷ブロッカーになります。そのため #385 は**宣言 (層 1) で完了ではなく**、OrbitStudio のビルド側で workspace trust そのものを既定 off にする**層 2** (`product.overrides.json` + `build_orbitstudio.sh`・計画上は PR-S-T2・設計は `docs/design/656-release-design.md` §3.4) が残っています。層 2 は #656 の出荷前に入れる予定で、ステージ 1 (音の経路の must-fix) では触らないと決まりました (owner 2026-09-05)。

---

## モジュールレベルの状態

`extension.ts` は 4,115 行の大きなファイルで、状態はモジュールレベル変数に置かれています。先頭付近の宣言を見ると、この拡張が何を抱えているかの索引になります。

```typescript
// packages/vscode-extension/src/extension.ts:107-118
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let bundleStatusItem: vscode.StatusBarItem | null = null
let devDocsPanel: vscode.WebviewPanel | null = null
let isLiveCodingMode: boolean = false
// Tracks whether `var global = init GLOBAL` has been evaluated in the current engine session.
// Used to decide if `global.setDocumentDirectory(...)` can be prepended safely.
let globalInitialized: boolean = false
let transportPlaying: boolean = false
// Optional MCP control server (Agent Bridge). Non-null only while running.
let mcpServerHandle: McpServerHandle | null = null
```

この後に、engine の stdout に乗って返ってくる JSON 行を待ち受ける **bridge** が 4 つ続きます (`DeviceSwitchBridge` / `PluginStateBridge` / `PluginUiBridge` / `EvalMarkBridge`)。いずれも「stdin にメタ行を書き、stdout の対応する 1 行 JSON で resolve する」FIFO で、engine が死んだら `drainAll()` で全部を失敗させます。engine の `stop → start` を素早く繰り返したときに古いプロセスの応答が新しい engine の要求にマッチしてしまう競合 (#501 / #528) を防ぐための構造です。

---

## `activate()` 関数の全体像

エントリポイントは `extension.ts` の `activate()` です。VS Code が extension を読み込んだ直後に一度だけ呼ばれます。前半を見てみましょう。

```typescript
// packages/vscode-extension/src/extension.ts:290-343
export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  engineProcess = null
  isLiveCodingMode = false
  globalInitialized = false
  transportPlaying = false

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')

  // Tap appendLine/append into the ring buffer so the MCP get_log tool can read
  // recent output without a separate logging sink (#388). Installed before the
  // version banner below so get_log's history starts from activation.
  const rawAppendLine = outputChannel.appendLine.bind(outputChannel)
  outputChannel.appendLine = (value: string) => {
    pushLogRing(value)
    rawAppendLine(value)
  }
  const rawAppend = outputChannel.append.bind(outputChannel)
  outputChannel.append = (value: string) => {
    for (const line of value.split('\n')) {
      if (line) pushLogRing(line)
    }
    rawAppend(value)
  }

  // Show version info
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  const buildTime = fs.statSync(__filename).mtime.toISOString()
  outputChannel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  outputChannel.appendLine(`🎵 OrbitScore Extension v${packageJson.version}`)
  outputChannel.appendLine(`📦 Build: ${buildTime}`)
  outputChannel.appendLine(`📂 Path: ${__dirname}`)
  outputChannel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  outputChannel.appendLine('')

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.text = '🎵 OrbitScore: Stopped'
  statusBarItem.tooltip = 'Open Audio Engine Settings'
  statusBarItem.command = 'orbitscore.showCommands'
  statusBarItem.show()

  // Bundle status indicator (priority 99 → 既存 100 の左隣に並ぶ)。daemon
  // が解決できない時だけ表示するエラー・インジケータ（健全時は非表示）。
  bundleStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  bundleStatusItem.command = {
    command: 'workbench.action.openSettings',
    title: 'Open OrbitScore settings',
    arguments: ['orbitscore'],
  }
  updateBundleStatus()
```

面白いのは Output Channel の `appendLine` / `append` を **monkey-patch** している箇所です。拡張には中央のログ sink が無いので、MCP の `get_log` ツール (#388) が読めるように、Output Channel に流れる行をリングバッファ (`outputLogRing`、上限は `log-ring.ts` の `OUTPUT_LOG_RING_MAX = 1000`) にも積んでいます。

`activate()` の残りは大きく 5 つの仕事です:

1. 設定変更リスナー (`orbitscore.playheadPalette`) の登録 — SC 経路の設定 (`scsynthPath` / `engine`) は #502 で削除済み
2. コマンドと TreeView provider の登録 (次節)
3. IntelliSense (補完・ホバー) プロバイダの登録
4. 診断 (`DiagnosticCollection`) の登録と、開いているドキュメントへの初期パス (#384)
5. MCP サーバの起動 (port が非ゼロのときのみ) と、Rust engine の自動起動

最後の 2 つはこう書かれています。

```typescript
// packages/vscode-extension/src/extension.ts:431-484 (MCP ツールのハンドラ表を省略)
  // Optional MCP control server (Agent Bridge, #388) — dev/agent-integration
  // only, gated behind a nonzero port. The `ORBITSCORE_MCP_PORT` env var takes
  // precedence over the `orbitscore.mcpServer.port` setting so the extension can
  // be launched from the CLI (e.g. Extension Development Host) with the port set
  // without editing settings. Lets an external agent (e.g. Claude Code) drive
  // OrbitScore operations for E2E testing.
  const envMcpPort = Number(process.env.ORBITSCORE_MCP_PORT)
  const mcpPort =
    Number.isInteger(envMcpPort) && envMcpPort > 0
      ? envMcpPort
      : vscode.workspace.getConfiguration('orbitscore').get<number>('mcpServer.port', 0)
  if (mcpPort && mcpPort > 0) {
    // ...
  }

  void autoStartConfiguredRustEngine()
}
```

省略したブロックが `startOrbitScoreMcpServer()` に 25 個のハンドラ (`evaluate` / `startEngine` / `getLog` / `analyzeAudio` / `listPlugins` …) を渡す表です。MCP サーバの中身と gated E2E は [IV-3. MCP サーバと実機 gated E2E](/editor/mcp-and-gated-e2e) に譲ります。`autoStartConfiguredRustEngine()` は `rust` kind で出力デバイスが保存済みなら engine を自動起動し、5 秒後に生存確認をします (`extension.ts:1699-1723`)。

### 出荷物では `activate()` の手前で落ちていた (#873)

ここまで読んできた `activate()` ですが、素の VS Code に `.vsix` を入れた状態では **1 行も走っていませんでした**。PR [#874](https://github.com/signalcompose/orbitscore/pull/874) が cold install — `--extensionDevelopmentPath` を使わず、インストール済みの拡張として起動する形 — を試して見つけた不具合です。例外は `activate()` の中身ではなく、モジュールの読み込みそのもので出ます。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
  at Object.<anonymous> (.../local.orbitscore-3.0.0/dist/extension.js:74:22)
```

なぜ読み込みの時点なのでしょうか。`extension.ts` は `./mcp-server` から import していて (`extension.ts:43`)、その `mcp-server.ts` は MCP SDK をトップレベルの `require` で読み込むからです。

```typescript
// packages/vscode-extension/src/mcp-server.ts:52-58
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as {
  McpServer: new (info: { name: string; version: string }) => McpServerLike
}
const { StreamableHTTPServerTransport } =
  require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
    StreamableHTTPServerTransport: new (opts: {
```

`require` は関数の中ではなくファイルのトップレベルに置かれているので、MCP サーバの起動 (前節の 5 番目の仕事) まで遅延されることはありません。SDK が同梱から抜けていれば、`activate()` は最初の 1 行に到達する前に例外で終わります。MCP の port が 0 でも、`.orbs` を 1 本も開いていなくても同じです。

抜けた理由は npm workspaces の hoisting でした。`packages/vscode-extension/package.json` は `@modelcontextprotocol/sdk` と `zod` を実行時依存として宣言していますが、どちらもリポジトリルートへ hoist されます。`.vscodeignore` は `../../**` と `../*/**` でパッケージの外を全部落とすので、`vsce package` が同梱した `extension/node_modules` は `@types` と `undici-types` の 2 つだけだった、というのが #874 の実測です。

対策は、ビルドの最後に拡張自身の依存を同梱先へ入れ直すことです。

```json
// packages/vscode-extension/package.json:419-421
    "build": "npm run build:engine && tsc -p tsconfig.json && bash ../../scripts/install-extension-deps.sh",
    "build:clean": "npm run build:engine:clean && tsc -p tsconfig.json && bash ../../scripts/install-extension-deps.sh",
    "build:engine": "cd ../engine && npm run build && bash ../../scripts/install-engine-deps.sh && bash ../../scripts/copy-daemon-bin.sh",
```

`install-engine-deps.sh` (engine 用) と `install-extension-deps.sh` (拡張用) はどちらも薄い wrapper で、実体は共有の `scripts/install-bundle-deps.sh` です。やっていることは「ワークスペース root を持たない一時ディレクトリで `npm install` し、できた `node_modules` を同梱先へ移す」— hoist 先が無い場所で入れるので、宣言した依存が必ずローカルに書かれます。同型の事故は engine 側で 2 度起きていて (WORK_LOG 6.119 の `@julusian/midi` / `uuid` / `ws`、6.422 の `yaml`)、拡張側だけが無防備だった、という位置づけです。

面白いのは**置き場所**で、拡張の依存は `dist/node_modules` に入ります (`install-extension-deps.sh:37-40`)。理由は 2 つあると script のヘッダに書かれています。1 つは `vsce package` がパッケージ直下の `node_modules` を無条件に除外し、`.vscodeignore` の `!node_modules/**` では上書きできないこと (入れ子の `engine/node_modules` や `dist/node_modules` は普通に入ります)。もう 1 つは Node の解決順で、`dist/mcp-server.js` から見て `dist/node_modules` が最初の候補になるため、パスの書き換えが要らないことです。あわせて `vsce package` には `--no-dependencies` が付き、hoist 先を返してくる依存探索そのものを止めてあります (`.github/workflows/release.yml:118`)。

退行を捕まえる側も入れ替わりました。`release.yml` の post-package 検証は、以前は `packages/engine/package.json` の依存名を数えてディレクトリの有無を見るだけでしたが、いまは `node scripts/check-vsix-bundled-deps.mjs` が**出荷物の中の実ファイルを起点に解決**します。保証の深さが一様でないことは script 自身が明記していて、depth 1 は本物の `require.resolve()` (壊れた `exports` map やエントリポイント欠落もここで落ちる)、depth > 1 は Node と同じ歩き方でディレクトリを探すだけ (ESM-only の transitive package は present なら通る) です。全 edge を本気で解決する案は、CJS 側が一度も require しない ESM-only の transitive package でリリースを赤くするため棄却され、`import` グラフそのものを歩く esbuild への移行が #875 に切られました。

::: warning この経路は gated E2E では踏めません
実機 gated E2E は `--extensionDevelopmentPath` で VS Code を起動します (`tests/e2e/orbitstudio-mcp-gated.spec.ts:728`)。この形だと依存は常にリポジトリルートの hoist 先から解決できてしまうので、**同梱が空でも緑になります**。cold install でしか通らない経路がここにもう 1 つある、ということです (もう 1 つは daemon の `extension-bundle` 分岐 — `--extensionDevelopmentPath` ではリポジトリの `rust/target/release` を引くので、やはり踏めません)。#874 の cold install 検証は手で行われ、自動テストとしては積まれていません。
:::

---

## Status Bar: 2 本のインジケータ

Status bar インジケータは **2 本** あります。priority の値が違い、右端から並ぶ順が決まります:

| 変数 | priority | 役割 | クリック時 |
|---|---|---|---|
| `statusBarItem` | 100 (右端) | エンジン動作状態 (`Stopped` / `Ready` / `▶️ Playing`、debug なら `🐛` 付き) | `showCommands` (Engine ビューを focus) |
| `bundleStatusItem` | 99 (その左) | daemon バイナリ解決状態 | `orbitscore` 設定 |

**2026-09-10 の裁定（#827 / #502）で SC 経路・`getConfiguredEngineKind()` による分岐は削除**されました。`bundleStatusItem` の表示を決める `updateBundleStatus()` はもう engine kind を見ず、daemon の解決結果だけを見ます。

```typescript
// packages/vscode-extension/src/extension.ts:651-664
function updateBundleStatus(): void {
  if (!bundleStatusItem) return
  const daemonResolution = resolveDaemonForUI()
  if (!daemonResolution) {
    bundleStatusItem.show()
    bundleStatusItem.text = '$(error) daemon: not found'
    bundleStatusItem.tooltip =
      'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.'
    bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    return
  }
  // 既定（健全）ではインジケータ自体を出さない（owner 判断 2026-07-17: 常時表示の意味がない）。
  bundleStatusItem.hide()
}
```

daemon が見つかる (= 通常の状態) ときはインジケータを **隠します**。見つからない時だけ `$(error) daemon: not found` を表示します ([ADR-003 scsynth bundle strict mode](/decisions/adr-003-scsynth-bundle) 参照。ADR が扱う scsynth resolver 自体は 2026-09-10 の裁定 #827 / #502 で削除済みで、歴史的記録として残っています)。

---

## Command 登録

`activate()` が登録しているコマンドを整理します。`contributes.commands` に載る 15 個と、TreeView のノードからだけ呼ばれる内部コマンド 2 個があります（`forceKillScsynth` / `selectAudioDevice` は #502 で削除）。

```typescript
// packages/vscode-extension/src/extension.ts:355-390
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.toggleEngine', toggleEngine),
    vscode.commands.registerCommand('orbitscore.showCommands', showCommands),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.stopEngine', stopEngine),
    vscode.commands.registerCommand('orbitscore.restartEngine', restartEngine),
    vscode.commands.registerCommand('orbitscore.reloadWindow', reloadWindow),
    vscode.commands.registerCommand('orbitscore.startEngineDebug', startEngineDebug),
    vscode.commands.registerCommand('orbitscore.configureFlash', configureFlash),
    vscode.commands.registerCommand('orbitscore.registerMcpServer', registerMcpServer),
    vscode.commands.registerCommand('orbitscore.rescanPlugins', rescanPlugins),
    vscode.commands.registerCommand('orbitscore.browsePlugins', browsePlugins),
    // viewsWelcome コンテンツは view に provider が登録されて初めて描画される
    // （空 TreeView で十分 — 章ツリーの本実装は #451 確定後の follow-up）。
    vscode.window.registerTreeDataProvider('orbitscore.learningView', {
      getChildren: () => [],
      getTreeItem: (element: vscode.TreeItem) => element,
    }),
    // Engine ビュー（#484 D3）: エンジン停止中は空を返し viewsWelcome（Start/Debug/Stop ボタン）を
    // 出す（viewsWelcome は tree が空の時だけ描画される — 上の学習ビューと同じ制約）。起動中は
    // engine 状態 + Output Device セクションを TreeView として描画する。
    (() => {
      engineViewProvider = new EngineViewProvider()
      return vscode.window.registerTreeDataProvider('orbitscore.engineView', engineViewProvider)
    })(),
    vscode.commands.registerCommand('orbitscore.engineViewSelectDevice', engineViewSelectDevice),
    vscode.commands.registerCommand('orbitscore.engineViewToggleEngine', engineViewToggleEngine),
    vscode.commands.registerCommand('orbitscore.engineViewToggleDebug', engineViewToggleDebug),
    vscode.commands.registerCommand('orbitscore.openDocs', openUserDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocs', openDevDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocsPanel', () => openDevDocsPanel(context)),
    vscode.commands.registerCommand('orbitscore.openWalkthrough', openWalkthrough),
    statusBarItem,
    bundleStatusItem,
  )
```

| コマンド ID | 関数 | 説明 | palette 表示 |
|---|---|---|---|
| `orbitscore.toggleEngine` | `toggleEngine` | エンジン起動/停止トグル | 非表示 (`editor/title` ボタン) |
| `orbitscore.showCommands` | `showCommands` | `rust`: Engine ビューを focus / `sc`: QuickPick | (status bar から) |
| `orbitscore.runSelection` | `runSelection` | 選択コード/現在ブロック実行 (Cmd+Enter) | 表示 |
| `orbitscore.stopEngine` | `stopEngine` | エンジン停止 | 非表示 |
| `orbitscore.restartEngine` | `restartEngine` | stop → 2.2 秒待ち → start (recovery) | 非表示 (Engine ビューの Recovery) |
| `orbitscore.reloadWindow` | `reloadWindow` | `workbench.action.reloadWindow` | 非表示 (Engine ビューの Recovery) |
| `orbitscore.startEngineDebug` | `startEngineDebug` | デバッグモードで起動 | 非表示 |
| `orbitscore.configureFlash` | `configureFlash` | フラッシュエフェクト設定 | 表示 |
| `orbitscore.registerMcpServer` | `registerMcpServer` | `.mcp.json` に Claude Code 用エントリを書く (#388) | 表示 |
| `orbitscore.rescanPlugins` | `rescanPlugins` | plugin catalog の再スキャン (#463) | 表示 + `editor/context` |
| `orbitscore.browsePlugins` | `browsePlugins` | catalog から名前を選んで挿入 (#638) | 表示 |
| `orbitscore.engineViewSelectDevice` | `engineViewSelectDevice` | Engine ビューのデバイスノードをクリック (#484 D3) | 非表示 |
| `orbitscore.openDocs` | `openUserDocs` | user 向け学習サイトをブラウザで開く | 表示 + `editor/title` |
| `orbitscore.openDevDocs` | `openDevDocs` | dev 学習サイト (本サイト) をブラウザで開く (#450) | 表示 |
| `orbitscore.openDevDocsPanel` | `openDevDocsPanel` | 同上を Webview タブで開く (#457) | 表示 |
| `orbitscore.openWalkthrough` | `openWalkthrough` | `orbitscore.learnOrbitScore` walkthrough (4 ステップ) を開く (#457) | 表示 |
| `orbitscore.engineViewToggleEngine` / `engineViewToggleDebug` | — | Engine ビューのノードから呼ばれる内部コマンド | `contributes.commands` に無し |

`orbitscore.runSelection` には `package.json` でキーバインドが設定されています:

```json
{
  "key": "cmd+enter",
  "command": "orbitscore.runSelection",
  "when": "editorTextFocus && editorLangId == orbitscore"
}
```

`when` 条件で `editorLangId == orbitscore` が指定されているため、`.orbs` ファイルにフォーカスがある時のみ有効です。

Activity Bar には 2 つのコンテナ (`orbitscore` = Learning view、`orbitscore-engine` = Audio Engine Settings view) が生えています。Learning view は空の TreeView で、`viewsWelcome` のボタン (Open Learning Site / Start the Walkthrough) だけを出す入口です。Engine ビューの方は `engine-view.ts` の純関数がノードを組み立て、`extension.ts` の `EngineViewProvider` がそれを `vscode.TreeItem` に写します。

```typescript
// packages/vscode-extension/src/engine-view.ts:47-54
export function buildRootNodes(engineRunning: boolean): EngineViewNode[] {
  return [
    buildEngineStatusNode(engineRunning),
    buildDebugToggleNode(false),
    buildDeviceSectionNode(),
    buildRecoverySectionNode(),
  ]
}
```

デバイスをクリックしたときの意味論は「選択 = 電源」で、同じデバイスをもう一度クリックすると停止、未起動なら起動、起動中なら走行中切替、と `resolveDeviceClickAction()` (`engine-view.ts:207-216`) が決めます。走行中の切替は `//#selectAudioDevice` メタ行で engine に依頼します (次々節)。

---

## IntelliSense と診断の登録

`registerCompletionProviders(context)` と `registerHoverProvider(context)` が IntelliSense を担当します。補完は 3 系統に増えました。

1. **メソッドチェーン文脈補完**: `completion-context.ts` の `analyzeMethodChain()` と `getContextualCompletions()`。`.` をトリガに、チェーンのどの段階かを見て候補を並べ替えます
2. **pitch scope 補完**: `.play(` の括弧が閉じていない位置で `).` と打ったときは `getPitchScopeCompletions()` に切り替わります (`extension.ts:3652-3672`)
3. **plugin catalog 名前補完**: `effect(` / `instrument(` の文字列引数の中で `"` をトリガに catalog の名前を出します (#463 C3、`extension.ts:3689-` 以降)。深掘りは [PH-3. プラグインカタログと差し替え](/plugin-hosting/catalog)

`MethodChainContext` は 2026-05 から 3 フラグ増えています。

```typescript
// packages/vscode-extension/src/completion-context.ts:6-18
interface MethodChainContext {
  hasAudio: boolean
  hasChop: boolean
  hasPlay: boolean
  hasBeat: boolean
  hasLength: boolean
  hasTempo: boolean
  hasRun: boolean
  hasOutput: boolean
  hasLinkAudio: boolean
  hasQuantize: boolean
  lastMethod: string
}
```

補完候補の語彙は `dsl-method-catalog.ts` に複製されていて、engine 側の `SEQUENCE_DSL_METHODS` / `GLOBAL_DSL_METHODS` / `BUS_DSL_METHODS` と一字一句一致することをテストが強制します。拡張プロセスは engine のモジュールを import しない設計なので、複製は避けられず、代わりにテストで乖離を赤にする、という割り切りです。

```typescript
// packages/vscode-extension/src/dsl-method-catalog.ts:1-14
/**
 * DSL メソッド補完の候補表（#495 第1段）。
 *
 * 🔴 **正本は engine 側**（`packages/engine/src/signal-chain/runtime.ts` の
 * `SEQUENCE_DSL_METHODS` / `GLOBAL_DSL_METHODS` / `BUS_DSL_METHODS`）。
 *
 * ここに複製があるのは、拡張が engine を**プロセス境界越しに**使う設計だから
 * （`plugin-catalog-reader.ts` も同じ理由で "deliberately independent" と書いている）。
 * 拡張プロセスは engine のモジュールを import しない。
 *
 * 複製は乖離する。それを防ぐため **`tests/vscode-extension/dsl-method-catalog.spec.ts` が
 * engine の語彙と一字一句一致することを検査する**。DSL にメソッドを足してここを更新し忘れると
 * テストが red になる（`seq.ui()` を足したのに補完に出ない、を構造的に防ぐ）。
 */
```

診断 (`updateDiagnostics`) は、2026-05 時点では `onDidChangeTextDocument` だけで駆動していましたが、#384 で「開いたとき」「閉じたとき」「activation 時に既に開いていたもの」にも広がりました。

```typescript
// packages/vscode-extension/src/extension.ts:400-429
  // Compute diagnostics on open and change; clear them on close (#384).
  // Diagnostics must not wait for the first edit — files opened from the CLI,
  // restored tabs, or the activation-time initial pass below all need
  // errors/warnings surfaced immediately.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isOrbitscoreDocument(document)) {
        updateDiagnostics(document, diagnosticCollection)
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isOrbitscoreDocument(event.document)) {
        updateDiagnostics(event.document, diagnosticCollection)
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isOrbitscoreDocument(document)) {
        diagnosticCollection.delete(document.uri)
      }
    }),
  )

  // Initial pass over documents already open at activation (#384): the
  // extension activates on `onLanguage:orbitscore`, so the triggering document
  // is already open and would otherwise never fire onDidOpenTextDocument.
  for (const document of vscode.workspace.textDocuments) {
    if (isOrbitscoreDocument(document)) {
      updateDiagnostics(document, diagnosticCollection)
    }
  }
```

チェック内容は行内 3 種 + 横断解析 6 種の計 9 種です。詳細は [IV-2](/editor/execution-feedback#リアルタイム診断-updatediagnostics) を参照してください。

---

## バイナリ解決: daemon

engine を spawn する前に、拡張は「音声プロセスの実行ファイルが本当にあるか」を事前チェックします。ここに面白い実装パターンがあります。**Extension Host の JS (TypeScript にコンパイル済) が、engine パッケージの compiled JS を `require` でランタイムロードする** という構造です。**2026-09-10 の裁定（#827 / #502）で削除される前**は、この wrapper が scsynth (`resolveScsynthForUI()`) と daemon (`resolveDaemonForUI()`) の 2 つ symmetric な形で存在していましたが、SC 経路の削除により **`resolveDaemonForUI()` だけが残ります**。

```typescript
// packages/vscode-extension/src/extension.ts:634-642
function resolveDaemonForUI(): { path: string; source: string } | null {
  try {
    return resolveDaemonBinaryForExtension()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ daemon resolver failed: ${reason}`)
    return null
  }
}
```

daemon 側の `require` は `engine-startup-runtime.ts` という小さなモジュールに切り出されています。ユニットテストがこの境界を差し替えられるようにするためで、拡張のビルド成果物 (`engine/dist/`) が無い環境でも `startEngine()` のロジックをテストできます。

```typescript
// packages/vscode-extension/src/engine-startup-runtime.ts:14-24
export function resolveDaemonBinaryForExtension(): EngineBinaryResolution {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const daemonModule = require('../engine/dist/audio/rust-engine/daemon-client') as {
    resolveDaemonBinaryPath: (explicitPath?: string) => EngineBinaryResolution
  }
  return daemonModule.resolveDaemonBinaryPath()
}

export function extensionEngineFileExists(enginePath: string): boolean {
  return fs.existsSync(enginePath)
}
```

daemon の resolver は `explicit > env > monorepo-release > monorepo-debug > extension-bundle > throw` です。silent fallback を持たず、見つからなければ例外で fail loud します ([ADR-003](/decisions/adr-003-scsynth-bundle) — かつての scsynth resolver の意思決定記録。scsynth 側は #502 で削除済み)。

::: warning scsynth 側の resolver は拡張から消えた (#836 → #838・2026-09-10)
まず [#836](https://github.com/signalcompose/orbitscore/pull/836) が、`packages/engine/scripts/sync-dist.js` に「engine を拡張へ同期するたびに `engine/scsynth` と同期先の `dist/audio/supercollider/` を削除する」処理を入れました。この時点で出荷された `.vsix` では

- `bundle` 候補のパス (`<engine root>/scsynth/Contents/Resources/scsynth`) が存在しない
- 拡張が `require` していた `../engine/dist/audio/supercollider/scsynth-resolver` **そのものが存在しない**

という状態になり、拡張側の TypeScript は #836 では触られていなかったため、`resolveScsynthForUI()` は require 失敗を catch して `❌ scsynth resolver failed: …` を outputChannel に出し `null` を返していました。

続く [#838](https://github.com/signalcompose/orbitscore/pull/838)（束 [#840](https://github.com/signalcompose/orbitscore/pull/840)）で **`resolveScsynthForUI()` は関数ごと削除**され、`packages/vscode-extension/src/` に `scsynth` の参照は 1 件も残っていません。これは `tsc` を通らない実行時 `require` だったので、engine 側のソースを消しただけでは型検査が緑のまま実行時に落ちる構造でした（#840 本文の「実行時 `require` の罠」）。いま残るバイナリ解決は daemon 側 (`resolveDaemonForUI()`) だけです。
:::

---

## Engine プロセスの spawn

`startEngine(debugMode?, agentOpts?)` が実際に engine を子プロセスとして起動します。2026-05 との違いは、`async` になって `boolean` を返すこと、engine kind で事前チェックが分岐すること、MCP からの `capture_wav` を受け取ることです。

事前チェックは削除済みの旧 III-3 章（[ADR-003](/decisions/adr-003-scsynth-bundle) に記録）に引用したので、ここでは引数と env の組み立てから spawn までを読みます。

```typescript
// packages/vscode-extension/src/extension.ts:1973-1986
  // Build args
  const args = ['repl']
  if (audioDevice && audioDevice !== '__default__') {
    args.push('--audio-device', audioDevice)
  }
  if (effectiveDebugMode) {
    args.push('--debug')
  }

  // Set environment
  const env = { ...process.env }
  if (effectiveDebugMode) {
    env.ORBITSCORE_DEBUG = '1'
  }
```

engine CLI (`engine/dist/cli-audio.js`) は `repl` サブコマンドで起動され、出力デバイスは `--audio-device` 引数で渡されます (`orbitscore.audioDevice` 設定が優先、無ければ `.orbitscore.json`)。`__default__` は「OS の既定出力」を意味する番兵です。

```typescript
// packages/vscode-extension/src/extension.ts:1982-2005
  // Set environment
  const env = { ...process.env }
  if (effectiveDebugMode) {
    env.ORBITSCORE_DEBUG = '1'
  }

  // Capture seam (#307): the daemon records the master output to this WAV while
  // the stream runs. Only set when explicitly requested (MCP start_engine tool)
  // — inherited env stays authoritative otherwise.
  if (agentOpts?.captureWav) {
    env.ORBIT_CAPTURE_WAV = agentOpts.captureWav
    outputChannel?.appendLine(`🎙️ Capture: ${agentOpts.captureWav}`)
  }

  outputChannel?.appendLine('🦀 Audio backend: rust (orbit-audio-daemon, native)')

  // Spawn engine process
  try {
    engineProcess = child_process.spawn('node', [enginePath, ...args], {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
  } catch (err) {
```

**2026-09-10 の裁定（#827 / #502）で `engineKind` による分岐・`ORBITSCORE_ENGINE` の明示 set・`ORBIT_SCSYNTH_PATH` の受け渡しはすべて削除**されました。唯一のバックエンドである Rust daemon 向けに、debug フラグと capture seam（#307）だけを env へ積んで spawn します。

`stdio: ['pipe', 'pipe', 'pipe']` が重要です。stdin/stdout/stderr をすべて pipe にすることで、Extension Host から直接 write/read できます。spawn 直後にはハンドラを 5 本付け、`process.nextTick` を 1 回またいでから「まだ同じプロセスが生きているか」を確認します。

```typescript
// packages/vscode-extension/src/extension.ts:2020-2031
  // Setup handlers
  setupStdoutHandler(engineProcess, effectiveDebugMode)
  setupStderrHandler(engineProcess)
  setupExitHandler(engineProcess)
  setupStdinErrorHandler(engineProcess)
  setupErrorHandler(engineProcess)

  const spawnedProcess = engineProcess
  await new Promise<void>((resolve) => process.nextTick(resolve))
  if (!engineProcess || engineProcess !== spawnedProcess || engineProcess.killed) {
    return false
  }
```

`setupErrorHandler` (#533) は spawn 失敗 (`ENOENT` 等) の `'error'` イベントを受けるもので、これが無いと `engineProcess` が non-null のまま残って `isEngineRunning()` が嘘をつきます。

### stderr を「行」に戻す — `createLinePrefixer` (#756)

5 本のうち `setupStderrHandler` は、engine の stderr を Output Channel へ `ERROR:` を前置して写す役目です。ここには一段の仕掛けが入っています。pipe から届くのは **chunk (受信のたびに切れた文字列断片)** であって行ではないので、chunk のまま前置すると 1 つの chunk に 2 行入ったときに **2 行目以降へ `ERROR:` が付きません**。Output Channel は本章冒頭で見た ring buffer 経由で MCP の `get_log` に読まれ、gated E2E はその `ERROR:` を数えて「この操作は ERROR を増やさなかった」を主張しているので、前置の取りこぼしはそのまま **過小カウント (偽緑)** になります。

そこで chunk 列を行へ組み直す小さなヘルパが挟まっています。

```typescript
// packages/vscode-extension/src/extension.ts:1415-1435
export function createLinePrefixer(emit: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let partial = ''
  return {
    push(chunk: string): void {
      partial += chunk
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') emit(line)
      }
    },
    flush(): void {
      const remaining = partial
      partial = ''
      if (remaining.trim() !== '') emit(remaining)
    },
  }
}
```

読みどころは 3 つです。1 つ目は `partial` の持ち越しで、素朴に `chunk.split('\n')` するだけでは **chunk 境界と行境界が一致しない**ため、行の後半が独立した 1 行として扱われて `ERROR:` が二重に付いてしまいます。2 つ目は `flush()` の存在で、行に整えると「**改行で終わらない最後の出力**」が buffer に残ったままプロセスが終わります。過小カウントを直すはずの変更が逆方向に同じ穴を開けることになるので、`end` イベントで必ず吐き出します。3 つ目は空行を emit しない判定で、`ERROR: ` だけの行を作ると今度は件数が**水増し**されます。

`setupStderrHandler` 側は、この `push` / `flush` を `logHandlerFailure` で包んで繋ぐだけになりました。

```typescript
// packages/vscode-extension/src/extension.ts:1451-1473
export function setupStderrHandler(process: child_process.ChildProcess): void {
  const prefixer = createLinePrefixer((line) => {
    outputChannel?.appendLine(`ERROR: ${line}`)
  })
  process.stderr?.on('error', (err) => {
    logHandlerFailure('setupStderrHandler', err)
  })
  process.stderr?.on('data', (data) => {
    try {
      prefixer.push(data.toString())
    } catch (err) {
      logHandlerFailure('setupStderrHandler', err)
    }
  })
  // 改行で終わらなかった最後の 1 行を取りこぼさない。
  process.stderr?.on('end', () => {
    try {
      prefixer.flush()
    } catch (err) {
      logHandlerFailure('setupStderrHandler', err)
    }
  })
}
```

ちなみに、この「chunk 列 → 行」の経路はリポジトリ全体で **4 つ**あります。実装のコメントが 4 つとも列挙していて、`createLinePrefixer` を直しただけで全部揃ったと思わないように、と注意書きが付いています。engine stderr のここ、daemon stderr の `createDaemonStderrLineRouter` (`packages/engine/src/audio/rust-engine/daemon-client.ts`、[#777](https://github.com/signalcompose/orbitscore/issues/777))、engine stdout の `setupStdoutHandler` ([#773](https://github.com/signalcompose/orbitscore/issues/773))、そして本章冒頭で見た ring proxy (`append` を `value.split('\n')` して ring へ写す部分) です。拡張パッケージは `@orbitscore/engine` に依存しないので、少なくとも前 2 つは今のところ共有できません。改行コード・空行・末尾 flush の判断は 4 箇所すべてへ波及しうる、というのが実装コメントの結論です。

### stdout の bridge 封筒も行へ戻す (#773)

3 つ目の `setupStdoutHandler` は、2026-09-08 の [#811](https://github.com/signalcompose/orbitscore/pull/811) (束 O-wire) で `createLinePrefixer` を使う側に回りました。それまでは chunk を `output.split('\n')` して、その場で `{"savePluginState"` / `{"pluginUi"` / `{"evalMark"` / `{"engineState"` の 4 分岐へ流していたので、**bridge の JSON 封筒が chunk 境界で割れると両方の断片が失われました**。前半は prefix チェーンのどれにも一致せず、後半は `{` で始まらないので、やはりどれにも一致しないからです。

```typescript
// packages/vscode-extension/src/extension.ts:1272-1279
export function setupStdoutHandler(process: child_process.ChildProcess, debugMode: boolean): void {
  // #773: Bridge envelopes are line-framed, but stdout data events are not.
  // Keep this buffer inside the handler so a stale process can never donate a
  // partial line to the current process. Only bridge dispatch is buffered:
  // applyEngineStdoutChunk still receives each raw chunk immediately below.
  const bridgeLines = createLinePrefixer((rawLine) => {
    const trimmedLine = rawLine.trim()
    const isCurrent = engineProcess === process
```

読みどころは、`bridgeLines` が **ハンドラの中で作られている**ことです。モジュールレベルに置くと、`stopEngine()` → `startEngine()` の間に古いプロセスが残した半端な行が、新しいプロセスの buffer に混ざります。stale ガードが `engineProcess === process` の同一性で判定できるのは、buffer がプロセスごとに独立しているからです。

もう 1 つの仕掛けが `StringDecoder` です。

```typescript
// packages/vscode-extension/src/extension.ts:1309-1312
  // Decode only the buffered bridge-dispatch path across Buffer boundaries. The log/playhead path
  // below intentionally keeps its historical per-chunk `data.toString()` timing and values.
  // stderr has the same UTF-8 boundary hazard but remains out of scope for this change.
  const bridgeDecoder = new StringDecoder('utf8')
```

`data.toString()` は chunk を単独で UTF-8 として解釈するので、マルチバイト文字が chunk をまたぐと **その場で `U+FFFD` に化けます**。行を繋ぎ直しても文字が壊れたあとでは戻りません。`StringDecoder` は不完全なバイト列を次の chunk まで持ち越すので、その手前で守れます。コメントが明言しているとおり、この置き換えは **bridge dispatch の経路だけ**で、ログと playhead へ渡す `output` / `lines` は従来どおり `data.toString()` のままです。既存の呼び出し規約とタイミングを変えないための線引きで、stderr 側の同じ危険はこの変更の対象外だとも書かれています。

```typescript
// packages/vscode-extension/src/extension.ts:1327-1328
      const bridgeOutput = bridgeDecoder.write(data)
      if (bridgeOutput) bridgeLines.push(bridgeOutput)
```

そして stderr 側と同じく、`end` で必ず吐き出します。`bridgeDecoder.end()` が先に来るのは、decoder が抱えている未完のバイト列を文字へ戻してから prefixer へ渡さないと、最後の 1 行が化けたまま emit されるからです。

```typescript
// packages/vscode-extension/src/extension.ts:1371-1379
  process.stdout?.on('end', () => {
    try {
      const bridgeRemainder = bridgeDecoder.end()
      if (bridgeRemainder) bridgeLines.push(bridgeRemainder)
      bridgeLines.flush()
    } catch (err) {
      logHandlerFailure('setupStdoutHandler', err)
    }
  })
```

---

## Engine との通信プロトコル

Extension Host と engine プロセスの通信は **stdin/stdout パイプ** で行われています。行指向ですが、2026-05 時点より語彙が増えました。

- **Extension → Engine (stdin)**: DSL テキストを `write(text + '\n')` で送信。加えて `//#` で始まる **メタ行** がいくつかあります
  - `//#documentDirectory <path>` — 基準ディレクトリを帯域外で先渡し (#456 I3)。`import` 文はどの statement よりも先に評価されるので、DSL 注入では間に合わない
  - `//#selectAudioDevice <name>` — 走行中の出力デバイス切替 (#484 D2.5)
  - `//#savePluginState` / `//#pluginUi` — plugin 状態保存・UI 開閉
  - `//#evalMark {"requestId":...}` — 直前のコードの評価完了と診断を返してもらう (#614)
- **Engine → Extension (stdout)**: 人間向けログに混じって、`{"selectAudioDevice":...}` / `{"savePluginState":...}` / `{"pluginUi":...}` / `{"evalMark":...}` の 1 行 JSON と、playhead 用の `[STEP] <seq> <argPath> <atEpochMs>` 行が流れます

送信部分は editor の Run Selection と MCP の `evaluate_orbitscore` が共有する `writeCodeToEngine()` に集約されています。

```typescript
// packages/vscode-extension/src/extension.ts:2708-2746
function writeCodeToEngine(rawCode: string, documentDir: string | undefined): boolean {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    // 呼び出し側ガード通過後に engine が死んだ稀な競合。黙って no-op すると
    // palette 実行では「実行したのに無反応」になるので、ここで必ず痕跡を残す。
    outputChannel?.appendLine('⚠️ Engine stdin is not writable — code was NOT sent (engine died?)')
    return false
  }
  let codeToSend = rawCode
  if (documentDir) {
    // I3 (#456): REPL メタ行で基準ディレクトリを帯域外で先渡しする。import 文（IM.2）は
    // どの statement よりも先に評価されるため、下の DSL 注入（statements として実行）では
    // 間に合わない — メタ行だけが import の基準（IM.6）を初回 eval から確定できる。
    // DSL 注入も残す（audio() 等の既存経路の実績を変えない・同値の冪等再設定）。
    codeToSend = `//#documentDirectory ${documentDir}\n` + codeToSend
    const setDirCommand = `global.setDocumentDirectory("${documentDir.replace(/\\/g, '\\\\')}")`
    const globalInitMatch = codeToSend.match(/(var\s+global\s*=\s*init\s+GLOBAL[^\n]*)/)
    if (globalInitMatch) {
      const insertPos = globalInitMatch.index! + globalInitMatch[0].length
      codeToSend =
        codeToSend.slice(0, insertPos) + '\n' + setDirCommand + codeToSend.slice(insertPos)
      globalInitialized = true
    } else if (globalInitialized) {
      codeToSend = setDirCommand + '\n' + codeToSend
    }
  }

  // #611 §5.7: every evaluated chunk is one audio-line batch (#649 §10.2's cursor rules
  // key off "one evaluation", not one statement) — wrap it so `repl-mode.ts` can open/close
  // that batch on every declared line. Placed after the `//#documentDirectory` prefix (and
  // the `setDocumentDirectory(...)` injection above) so both land inside the frame.
  codeToSend = `//#evalBegin\n${codeToSend}\n//#evalEnd`

  // Debug: log what we're sending if in debug mode (check status bar text for 🐛)
  if (statusBarItem?.text.includes('🐛')) {
    outputChannel?.appendLine(`📤 Sending: ${JSON.stringify(codeToSend)}`)
  }
  engineProcess.stdin.write(codeToSend + '\n')
  return true
}
```

返り値の `true` は「stdin に届いた」までしか意味しません。パースエラーや実行エラーは engine が非同期に stderr / stdout に出すだけです。人間ならエディタ上の赤線や Output Channel で気づけますが、MCP 経由の LLM には `ok` しか届かない、というのが #614 で `//#evalMark` が足された理由です。REPL は行を FIFO で処理する (#476) ので、コードの直後にマーカーを送れば「マーカーに到達した時点で評価は終わっている」と言えます。

```typescript
// packages/vscode-extension/src/eval-mark-bridge.ts:14-23
 * 🔴 「どこまで待つか」を時間で決めない
 *
 * REPL は行を **FIFO** で処理する（#476）。コードの直後にマーカーを送れば、
 * **マーカーに到達した時点で先行コードの評価は完了している**。したがって settle 時間や
 * 「エラーが出ないこと」を待つ必要がない。長い評価（instrument 6 本の attach で 30 秒超）
 * でも、待つのは「実際に終わるまで」であって誤検知しない。
 *
 * timeout は最後の安全網としてのみ置く。詰まったキューは #608 の stall reporter が
 * 別途「塞いでいる行」を名指しして報告する。
 */
```

受信側の `setupStdoutHandler()` は、まず bridge 系の JSON 行を prefix で振り分け、残りを `engine-lifecycle.ts` の `applyEngineStdoutChunk()` に渡します。この関数は vscode に依存しない純粋なロジックで、行を分類して「何をすべきか」を effects コールバックに指示します。

```typescript
// packages/vscode-extension/src/engine-lifecycle.ts:76-85
export function classifyEngineStdoutLine(rawLine: string): EngineStdoutLineIntent {
  const step = parseStepLine(rawLine)
  return {
    rawLine,
    step,
    stoppedSequence: step ? null : (rawLine.match(/⏹\s+(\S+)/)?.[1] ?? null),
    globalStopped: !step && rawLine.includes('✅ Global stopped'),
    selectAudioDeviceCandidate: !step && rawLine.trim().startsWith('{"selectAudioDevice'),
  }
}
```

```typescript
// packages/vscode-extension/src/extension.ts:1330-1366 (effects の中身を一部省略)
      applyEngineStdoutChunk(output, lines, isCurrent, {
        handleStep: handleStepLine,
        clearSequence: clearPlayheadForSequence,
        clearAllPlayheads: clearAllPlayheadDecorations,
        handleSelectAudioDeviceLine: (rawLine) => selectAudioDeviceBridge.handleLine(rawLine),
        // ...
        setTransportStatus: (state) => {
          transportPlaying = state === 'playing'
          statusBarItem!.text = transportStatusText(state, debugMode)
        },
      })
```

`setTransportStatus(state)` が引数付きの 1 本になっているのは #527 レビューの帰結です。#527 レビュー前は `setPlayingStatus` / `setReadyStatus` という同一シグネチャの兄弟で、配線を取り違えても型チェックを通ってしまいました。1 本に畳めば取り違えは表現できなくなります。文字列の描画も `transportStatusText()` の exhaustive switch に委ね、未知の状態が来たら黙って "Ready" にせず throw します。

```typescript
// packages/vscode-extension/src/engine-lifecycle.ts:35-46
export function transportStatusText(state: TransportState, debugMode: boolean): string {
  switch (state) {
    case 'playing':
      return debugMode ? '🎵 OrbitScore: ▶️ Playing 🐛' : '🎵 OrbitScore: ▶️ Playing'
    case 'ready':
      return debugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
    default: {
      const _exhaustive: never = state
      throw new Error(`Unhandled transport state: ${String(_exhaustive)}`)
    }
  }
}
```

実行フィードバック (選択行のフラッシュ、playhead、診断) については [IV-2 インライン実行とフィードバック](/editor/execution-feedback) で詳しく扱います。

---

## Engine の停止とライフサイクルの識別ガード

`stopEngine()` は SIGTERM → (2 秒後) SIGKILL という 2 段階のシャットダウンを行います。2026-05 と比べると、bridge の drain と playhead のクリアが増え、SIGKILL の条件が直っています。

```typescript
// packages/vscode-extension/src/extension.ts:2045-2093
export function stopEngine(): boolean {
  engineGeneration += 1
  if (engineProcess && !engineProcess.killed) {
    // Capture process reference before nulling module-level variable
    // (the SIGKILL timeout needs this reference after engineProcess is set to null)
    const proc = engineProcess
    engineProcess = null
    isLiveCodingMode = false
    globalInitialized = false
    transportPlaying = false
    clearAllPlayheadDecorations() // #390: don't wait for the exit event
    // #501 review Critical #1: drain here too — `stopEngine()` nulls
    // `engineProcess` immediately (before the `exit` event fires), so a caller
    // awaiting `sendSelectAudioDeviceMeta()` would otherwise hang until the
    // 10s timeout instead of failing fast.
    selectAudioDeviceBridge.drainAll('engine was stopped before responding to //#selectAudioDevice')
    pluginStateBridge.drainAll('engine was stopped before responding to //#savePluginState')
    pluginUiBridge.drainAll('engine was stopped before responding to //#pluginUi')
    evalMarkBridge.drainAll('engine was stopped before responding to //#evalMark')
    engineStateBridge.drainAll('engine was stopped before responding to //#getEngineState')

    // Send graceful shutdown signal (SIGTERM)
    // This allows the engine to clean up the audio backend properly
    proc.kill('SIGTERM')

    // Force kill after 2 seconds if still running.
    //
    // #532: `proc.killed` means "a signal was successfully SENT", not "the
    // process has exited" (`node_modules/@types/node/child_process.d.ts`
    // documents this explicitly). `proc.kill('SIGTERM')` above already makes
    // `killed === true` the instant the signal is delivered, so `!proc.killed`
    // here was always false and this SIGKILL never fired — a process that
    // ignores or hangs on SIGTERM was never escalated to, orphaning it.
    // `exitCode` / `signalCode` are the correct signal: both stay `null`
    // until the process has actually terminated.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }, 2000)

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    engineViewProvider?.refresh()
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
    return true
  }
  return false
```

#532 のコメントが指摘するとおり、2026-05 時点の `if (!proc.killed)` は「シグナルを送れたか」を見ていたので、SIGKILL は一度も発火しませんでした。`exitCode` / `signalCode` が両方 `null` かどうかが「まだ生きている」の正しい判定です。

`exit` イベント側は `applyEngineExit()` に委ねられ、**プロセスの同一性** (`engineProcess === process`) で共有状態の更新を gate します。`stop → start` を素早く行うと、古いプロセスの `exit` が新しい engine を spawn した後に届くことがあり、無条件に `engineProcess = null` すると新しい engine が孤児になるからです (#528)。

```typescript
// packages/vscode-extension/src/engine-lifecycle.ts:177-192
export function applyEngineExit(
  code: number | null,
  isCurrent: boolean,
  effects: EngineExitEffects,
): void {
  effects.logExit(code)
  if (!isCurrent) return
  effects.clearEngineState()
  effects.clearAllPlayheads() // #390: nothing is sounding anymore
  // #501 review Critical #1: drain any //#selectAudioDevice requests still
  // awaiting a response — otherwise a stale resolver could FIFO-match the
  // next engine instance's response.
  effects.drainDeviceBridge('engine process exited before responding to //#selectAudioDevice')
  effects.showStoppedStatus()
  effects.refreshEngineView()
}
```

`deactivate()` は engine を `kill()` し、playhead の decoration type と MCP サーバ、Webview panel を dispose します (`extension.ts:500-521`)。

---

## アーキテクチャ全体図

```mermaid
flowchart TD
    A["VS Code Renderer\n(UI / Editor)"] -->|"Extension API calls"| B

    subgraph ExtHost["Extension Host (Node.js)"]
        B["activate()"]
        B --> C["StatusBarItem × 2"]
        B --> D["Command 17 個 + TreeView 2 つ"]
        B --> E["IntelliSense providers\n(chain / pitch scope / plugin catalog)"]
        B --> F["DiagnosticCollection\n(open / change / close / 初期パス)"]
        B --> MCP["MCP server\n(port 非ゼロ時のみ)"]
        LC["engine-lifecycle.ts\n(純関数・identity guard)"]
        BR["bridges × 4\n(FIFO / timeout / drain)"]
    end

    B --> H1["resolveDaemonForUI()\n→ engine/dist/.../daemon-client.js"]

    D -->|"startEngine()"| N["child_process.spawn\n(node engine/dist/cli-audio.js repl)"]
    N -->|"stdin: DSL + //# メタ行"| O["Engine Process\n(OrbitScore REPL)"]
    O -->|"stdout: ログ / JSON 行 / [STEP]"| LC
    LC --> P["Output Channel + log ring"]
    LC --> BR
    LC --> PH["playhead decorations"]
    O -->|"WebSocket"| Q1["orbit-audio-daemon\n(唯一のバックエンド)"]
    MCP -->|"evaluate / run_selection / get_log …"| B
```

---

## 2026-09 時点の drift

2026-05-05 の初稿 (0a4b598) から 69dc968 までに拡張へ入った主な変更を、1 行ずつ出典付きで並べます。深掘りは各リンク先に譲ります。

| 変更 | Issue | 出典 |
|---|---|---|
| `.vsix` に `orbit-audio-daemon` を同梱し、`resolveDaemonBinaryPath()` の最終候補に追加 | #306 | `docs/archive/WORK_LOG_2026-07.md` §6.185 (2026-07-03) |
| `orbitscore.engine` 設定 (既定 `rust`) と `getConfiguredEngineKind()` による 4 サイトの分岐、`ORBITSCORE_ENGINE` の明示 set | #377 / #366 | §6.186 (2026-07-07)、`extension.ts:653-669` |
| 診断を open / close / activation 時にも実行 | #384 | §6.187 (2026-07-07)、`extension.ts:414-443` |
| MCP control server (Agent Bridge)、`evaluate_orbitscore` から始まり 25 ハンドラへ、`get_log` 用 log ring、`.mcp.json` 登録コマンド | #388 | §6.188-6.192 (2026-07-07)、`extension.ts:445-495`、`log-ring.ts` → [IV-3](/editor/mcp-and-gated-e2e) |
| `[STEP]` 行による live playhead highlight (per-seq 色・nested argPath・`orbitscore.playheadPalette`) | #390 | §6.194-6.197 (2026-07-07)、`playhead.ts`、`extension.ts:150-284` |
| dev 学習サイトのローカル配信と `openDevDocs` / Webview panel / Walkthrough / Activity Bar の Learning view | #450 / #457 | §6.260-6.261 (2026-07-17)、`extension.ts:530-651` |
| `//#documentDirectory` メタ行で基準ディレクトリを帯域外先渡し (import 対応) | #456 | §6.266 (2026-07-17)、`extension.ts:3009-3013` |
| plugin catalog の名前補完 + `rescanPlugins` (3 面: コマンド / 右クリック / MCP) | #463 | §6.279 (2026-07-17)、`extension.ts:3689-` |
| REPL 行処理の FIFO 直列化 (evalMark の前提) | #476 | §6.271 (2026-07-17) |
| Engine ビュー (`orbitscore.engineView`)、デバイス表示/選択、走行中デバイス切替 (`DeviceSwitchBridge`)、選択=電源モデル、auto-start | #484 D2.5 / D3 / D3.5 | §6.280-6.283 (2026-07-17/18)、`engine-view.ts`、`device-switch-bridge.ts` |
| engine ライフサイクルの判断を `engine-lifecycle.ts` に抽出、identity guard、handler 例外の隔離、`setTransportStatus(state)` への畳み込み | #528 / #527 | §6.295-6.300 (2026-07-27) |
| spawn `'error'` ハンドラ、`proc.killed` 誤用の修正 (SIGKILL 昇格) | #532 / #533 | §6.301 (2026-07-27)、`extension.ts:2228-2242` |
| `get_log` の silent truncation をやめ、上限をリング容量 1000 に | #567 | `log-ring.ts:1-18` |
| `//#evalMark` による評価結果の相関 (`EvalMarkBridge`)、stdout の独立分岐 | #614 | `eval-mark-bridge.ts:1-23`、`extension.ts:1501-1509` |
| `browsePlugins` コマンドと未知プラグイン名の診断 | #638 | §6.412 (2026-08-29)、`extension.ts:2285-2298`、`extension.ts:4095-4112` → [PH-3](/plugin-hosting/catalog) |
| `capabilities.untrustedWorkspaces` の宣言 (`supported: true`・`restrictedConfigurations` は 2 件)。フォルダ無しの loose-file 起動でも activate する | #385 (PR [#730](https://github.com/signalcompose/orbitscore/pull/730)) | `docs/archive/WORK_LOG_2026-09.md` "fix(studio): declare untrusted-workspace capability (#385 PR-S-T1)"（本体はローテーション済み）、`package.json:34-43` |
| 拡張自身の実行時依存 (`@modelcontextprotocol/sdk` / `zod`) を `dist/node_modules` へ同梱。cold install では hoist によりこれらが `.vsix` に入らず、`activate()` がモジュール読み込みの時点で落ちていた | #873 (PR [#874](https://github.com/signalcompose/orbitscore/pull/874)) | `docs/development/WORK_LOG.md` "fix(release): ship the extension's own runtime deps so the .vsix can activate (#873)"、`packages/vscode-extension/package.json:419-420`、`scripts/install-bundle-deps.sh` |

初稿の「8 つのコマンド」「診断は 3 種 (+2)」「`startEngine` は同期で scsynth 必須」はいずれも 69dc968 では成り立ちません。

---

## 関連用語

- [activate() / deactivate()](/glossary#activate--deactivate) — VS Code 拡張のライフサイクル関数。本章で詳説する `activate()` がすべての登録を行う
- [activationEvents](/glossary#activationevents) — `"onStartupFinished"` と `"onLanguage:orbitscore"` の 2 種類で常時起動を実現
- [workspace trust (untrustedWorkspaces)](/glossary#workspace-trust-untrustedworkspaces) — 未信頼ワークスペースで activate してよいかの宣言。`supported: true` と、#502 以降は**空**の `restrictedConfigurations`
- [Extension Host](/glossary#extension-host) — 拡張コードが動く Node.js プロセス。engine プロセスの親プロセス
- [StatusBarItem](/glossary#statusbaritem) — `statusBarItem` (priority 100) と `bundleStatusItem` (priority 99) の 2 本を管理
- [language ID (orbitscore)](/glossary#language-id-orbitscore) — `.orbs` ファイルに割り当てた言語 ID。IntelliSense・診断・キーバインドがすべてこの ID でフィルタリング
- [DiagnosticCollection](/glossary#diagnosticcollection) — `updateDiagnostics()` が書き込む診断コレクション。open / change / close で更新
- [scsynth](/glossary#scsynth) — `sc` kind のときだけ `resolveScsynthForUI()` が起動前に解決していたオーディオサーバーバイナリ。#502 で解決経路ごと削除済み（歴史的読解）
- [strict mode (scsynth resolver)](/glossary#strict-mode-scsynth-resolver) — バイナリが見つからなければ spawn 自体をキャンセルする fail-loud 設計。scsynth 側の実装は #502 で削除されたが、daemon resolver がこの方針を継いでいる
- [MethodChainContext](/glossary#methodchaincontext) — IntelliSense が文脈に応じた補完候補を出すためのメソッドチェーン状態表現

## 関連 ADR

- [ADR-001 SuperCollider ベース実装の選択](/decisions/adr-001-supercollider) — engine の音声バックエンドの経緯と cutover #108 後の位置づけ
- [ADR-003 scsynth bundle strict mode](/decisions/adr-003-scsynth-bundle) — `resolveScsynthForUI()` / `resolveDaemonForUI()` の fail-loud 設計の意思決定。scsynth 側は #502 で削除され、いまは `resolveDaemonForUI()` だけがこの設計を実装している

## 次の深掘り候補

- `setupStdoutHandler` の bridge 振り分け (`{"savePluginState"` / `{"pluginUi"` / `{"evalMark"`) と `applyEngineStdoutChunk` の 2 段構成 — なぜ bridge 系だけ手前で拾うのか
- `EngineViewProvider` (`extension.ts` 側) と `engine-view.ts` の純関数の境界 — `DeviceFetchState` の lazy fetch と `--list-audio-devices` の spawn
- `autoStartConfiguredRustEngine()` の `engineGeneration` による「後から起きた操作を誤警告しない」仕組み
- `registerCompletionProviders` の 3 系統の優先順位 — `.play(` の括弧バランスで pitch scope に切り替える判定の境界ケース
- `deactivate()` と detached な plugin scanner プロセス (`terminateActivePluginScans()`) の関係
- `tests/vscode-extension/` の 28 spec が `vscode` モックでどこまで配線を検証しているか (`extension-wiring.spec.ts`)

---

## Sources

- `packages/vscode-extension/package.json` — version 2.1.0、`activationEvents`、`contributes.commands` (15)、`viewsContainers` / `views` / `viewsWelcome`、`walkthroughs`、`menus`、`keybindings`、`configuration` (`mcpServer.port` / `playheadPalette` 等。`orbitscore.engine` / `orbitscore.scsynthPath` は #502 で削除)
- `packages/vscode-extension/package.json:34-43` — `capabilities.untrustedWorkspaces` の宣言 (#385)
- `tests/vscode-extension/untrusted-workspace-capability.spec.ts:1-125` — 宣言を検査する 6 本 (`restrictedConfigurations` を `?? []` に落とさない理由もここ)
- `tests/helpers/vscode-extension-manifest.ts:1-53` — マニフェスト読み取りの共有ヘルパー (`readExtensionManifest()` / `declaredConfigurationKeys()`)
- `packages/vscode-extension/src/extension.ts:104-134` — モジュールレベル状態と 4 つの bridge
- `packages/vscode-extension/src/extension.ts:150-284` — live playhead の decoration 管理 (#390)
- `packages/vscode-extension/src/extension.ts:286-498` — `activate()` 全体: log ring の monkey-patch・status bar・設定リスナー・command / TreeView 登録・診断・MCP サーバ・auto-start
- `packages/vscode-extension/src/extension.ts:500-521` — `deactivate()`
- `packages/vscode-extension/src/extension.ts:628-642` — `resolveDaemonForUI()` (`getConfiguredEngineKind()` / `resolveScsynthForUI()` は #502 で削除)
- `packages/vscode-extension/src/extension.ts:644-664` — `updateBundleStatus()` (`maybeShowBundleNotice()` は scsynth 専用だったため #502 で削除)
- `packages/vscode-extension/src/extension.ts:666-683` — `showCommands()` (engine kind による分岐は #502 で削除・常に Engine ビューを focus) / `restartEngine()` / `reloadWindow()`
- `packages/vscode-extension/src/extension.ts:1479-1587` — `setupStdoutHandler()`: `createLinePrefixer` + `StringDecoder` による bridge 振り分けと `applyEngineStdoutChunk` 呼び出し (#773)
- `packages/vscode-extension/src/extension.ts:1589-1642` — `createLinePrefixer()`: chunk 列を行へ戻す (`partial` の持ち越し・`flush()`・空行を emit しない) と、実装コメントによる「chunk → 行」4 経路の列挙 (#756 / #773)
- `packages/vscode-extension/src/extension.ts:1644-1680` — `setupStderrHandler()`: `ERROR:` の行単位前置と `end` での flush
- Issue [#773](https://github.com/signalcompose/orbitscore/issues/773) / PR [#811](https://github.com/signalcompose/orbitscore/pull/811) — stdout の bridge 封筒が chunk 境界で割れて両断片とも失われる問題
- `tests/vscode-extension/extension-wiring.spec.ts` — 行単位前置を留める 4 本 (PR [#772](https://github.com/signalcompose/orbitscore/pull/772))
- `packages/vscode-extension/src/extension.ts:1699-1723` — `autoStartConfiguredRustEngine()`
- `packages/vscode-extension/src/extension.ts:2044-2198` — `startEngine()`: engine kind 事前チェック・args / env・spawn・ハンドラ・nextTick ガード
- `packages/vscode-extension/src/extension.ts:2204-2252` — `stopEngine()`: drain・SIGTERM・`exitCode`/`signalCode` 判定の SIGKILL
- `packages/vscode-extension/src/extension.ts:3000-3032` — `writeCodeToEngine()`: `//#documentDirectory` メタ行と `setDocumentDirectory` 注入
- `packages/vscode-extension/src/extension.ts:3638-3700` — `registerCompletionProviders()`: chain / pitch scope / plugin catalog の 3 系統
- `packages/vscode-extension/src/engine-lifecycle.ts:35-46` / `:76-85` / `:113-152` / `:177-192` — `transportStatusText` / `classifyEngineStdoutLine` / `applyEngineStdoutChunk` / `applyEngineExit`
- `packages/vscode-extension/src/engine-startup-runtime.ts:14-24` — daemon resolver の runtime require 境界
- `packages/vscode-extension/src/engine-view.ts:47-54` / `:207-216` — Engine ビューのルートノードとデバイスクリックの意味論
- `packages/vscode-extension/src/completion-context.ts:6-18` — `MethodChainContext` インターフェース
- `packages/vscode-extension/src/dsl-method-catalog.ts:1-14` — 補完語彙の複製とテストによる一致強制
- `packages/vscode-extension/src/eval-mark-bridge.ts:1-23` — `//#evalMark` の設計理由 (FIFO)
- `packages/vscode-extension/src/log-ring.ts:20-24` — `OUTPUT_LOG_RING_MAX = 1000` / `DEFAULT_LOG_LINES = 50`
- `packages/vscode-extension/src/mcp-server.ts:52-80` — MCP SDK と `zod` のトップレベル `require`。`activate()` より前に評価されるので、同梱漏れは activation 全体を落とす (#873)
- `packages/vscode-extension/package.json:419-420` — `build` / `build:clean` の末尾に付いた `install-extension-deps.sh` (#873)
- `scripts/install-bundle-deps.sh:13-37` — hoist 問題そのものの説明と、engine 2 件 / 拡張 1 件の事故の対応表、esbuild への移行 (#875) を stopgap と呼ぶ理由
- `scripts/install-extension-deps.sh:10-28` — 同梱先が `dist/node_modules` である 2 つの理由と、`--no-dependencies` に至った経緯
- `scripts/check-vsix-bundled-deps.mjs:83-98` — post-package ゲートの保証が depth 1 と depth > 1 で一様でないことの明示
- `.github/workflows/release.yml:118` / `:188` — `vsce package --no-dependencies` と、出荷物から解決する依存ゲートの呼び出し
- Issue [#873](https://github.com/signalcompose/orbitscore/issues/873) / PR [#874](https://github.com/signalcompose/orbitscore/pull/874) — cold install で `activate()` がまったく走らなかった不具合
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts:91-98` — `explicit > env > bundle > throw` 優先順位チェーン（**#502 でファイルごと削除**。commit `58f558f5` 以前の位置。現存する対応物は次行の daemon resolver）
- `packages/engine/src/audio/rust-engine/daemon-client.ts:221-250` — daemon 側の 5 候補チェーン
- `docs/archive/WORK_LOG_2026-07.md` §6.185-6.187, §6.188-6.192, §6.194-6.197, §6.260-6.261, §6.266, §6.271, §6.279-6.283, §6.295-6.301 / `docs/archive/WORK_LOG_2026-08.md` §6.412 — drift 表の出典
- PR [#155](https://github.com/signalcompose/orbitscore/pull/155) — scsynth strict mode 採用・二重通知防止のコードレビューコメント
