# #887 設計: `extension.ts` / `mcp-server.ts` の分割（#888 の子 4）

**起案**: Fable（effort: high）・2026-09-12 / **対象ブランチ**: `main`（4.0.1 出荷済み・`0f930f36`）
**実装**: Codex（`/codex:rescue --model gpt-5.6-sol --effort high`）/ **検証**: main（sandbox 外）
**置き場**: `docs/design/887-extension-split-design.md`（本ファイルは scratchpad に書いた。`main` 上の Edit/Write を hook が止めたため。`887-*` ブランチで `cp` してからコミットする）

> 本書の数値は**すべて 2026-09-12 の `main` を実際に読んで数えた値**である。コード行は
> `tests/repo/code-lines.ts` の `countCodeLines(src, 'ts')` を範囲ごとに当てて測った
> （ブリーフ・issue の見積もりと食い違う箇所は §2.4 に列挙した）。

---

## 0. 確定事項と、本設計が決めたこと

### 0.1 確定事項（再議論しない）

| # | 事項 | 出典 |
|---|---|---|
| C1 | 閾値 = **コード行 500**（空行・コメント専用行を除く） | #888 owner 裁定 |
| C2 | **振る舞いを変えない。** 検算は「既存テストの期待値を 1 つも変えていない」（`npm test` の件数と中身が不変） | #887 / ブリーフ |
| C3 | **新しい抽象を発明しない**。既にある兄弟モジュールへ戻すのが基本 | #888 |
| C4 | 束は **residual** で数え、目安 1,500。各コミットが単独でビルド・テストを通る | `BUNDLE_BRANCH_WORKFLOW.md` §5.1a |
| C5 | 分割で生まれる新ファイルも**同じ PR 内で 500 以下** | 設計 888 §13.9 の 1 |
| C6 | module doc に「N 行を除いて純粋な移動」という**件数の主張を書かない** | 設計 888 §14 |
| C7 | `__*ForTest` の **import 先が変わるのは可。呼び出しの意味が変わるのは不可** | ブリーフ |

### 0.2 本設計が決めたこと（根拠は §3〜§7）

| # | 決定 | 一言 |
|---|---|---|
| D1 | **状態は leaf モジュール `extension-state.ts` へ移し、読みは ES module の live binding、書きは setter 12 本** | ES module の import binding は**代入できない**（言語の制約）。読み出し ~220 箇所の本文は 1 文字も変えず、代入 **31 箇所**だけが `setX(v)` になる（§3） |
| D2 | **`__*ForTest` 13 本は名前も意味も変えず、それぞれが閉じる状態と同じモジュールへ移す。`extension.ts` は `export { … } from` で全部を再輸出する** | テスト側 239 箇所の変更 **0**（ブリーフの案 (b)）。案 (a)(c) を捨てた理由は §3.5 |
| D3 | 🔴 **`setup*Handler` を `engine-lifecycle.ts` へ戻してはいけない**（ブリーフ・issue の見立てを覆す） | `extension-wiring.spec.ts` が `engine-lifecycle` を `vi.mock` して `applyEngineExit` を spy している。同じモジュール内の呼び出しは mock を通らないので、戻した瞬間に spy が一度も呼ばれなくなり**テストを書き換えるしかなくなる**（§4.2） |
| D4 | 兄弟モジュール 20 本はすべて「vscode 非依存の純関数」として設計されている。**vscode に触る配線は、その純モジュールと対になる新しい配線ファイルへ置く**（13 本） | 純モジュールへ vscode 依存を持ち込むのは「戻す」ではなく「壊す」（§4.1） |
| D5 | `mcp-server.ts` の `buildServer`（**616 コード行の単一関数**）は、`session.rs` の前例（owner 裁定・アームを関数へ切り出す）に倣い **3 つの `register*Tools(server, handlers)` へ切る**。`registerTool` 呼び出しの本文は 1 行も書き換えない | §5 |
| D6 | **公開面の凍結は 1 ファイル `tests/vscode-extension/public-surface.spec.ts`** で行い、tsc（`tsconfig.tests.json` に include）と vitest の**両方**に通す | 実測: tsc は「無い export」(TS2724) と「型だけの export を値として使う」(TS2693) を捕まえる。vitest は実行時に `undefined` を捕まえる（§6） |
| D7 | 束は **0 → A → B → C → D → E**（`extension.ts`）→ **F**（`mcp-server.ts`）。束 A で**代入を setter へ替えてから**動かすので、B 以降は純粋な移動になる | §7 |
| D8 | 束 0（道具を先に置く）で public-surface spec と引用の追随スクリプトを入れる | Rust 子 3 の教訓「検算の道具を先に作ったことが効いた」（§7.1） |
| D9 | 短い moved ブロックの閾値 **K = 5 行**（この束群での値。TS 側で初めて決める） | §8.1 |
| D10 | `isTransportCommand`（未参照の関数・5 行）は**この issue では消さない**（移動でない変更を混ぜない）。分割完了後に別コミットで消す | §2.5 |

---

## 1. 到達点（1 文）

`packages/vscode-extension/src/extension.ts` が **2,779 → 約 280 コード行**、`mcp-server.ts` が **1,161 → 約 260 コード行**になり、新設した 19 ファイルがすべて 500 以下で、`tests/repo/file-size-baseline.json` から 2 エントリが消え、**`npm test` の件数と `tests/` 配下の差分が束 0 以降 1 行も動いていない**。

---

## 2. 現在地（一次情報・本書が前提にするもの）

### 2.1 大きさ

| ファイル | 生の行 | コード行 | export | うちテスト以外の消費者 |
|---|---|---|---|---|
| `extension.ts` | 3,902 | **2,779** | 27（`__*ForTest` **13** + 14） | `activate` / `deactivate`（VS Code host が `dist/extension.js` を読む）のみ |
| `mcp-server.ts` | 1,403 | **1,161** | 36（型 25 + 値 11） | `extension.ts` が型 18 + `startOrbitScoreMcpServer` / `DOCS_PUBLIC_BASE`；`engine-state-bridge.ts` が `EngineState`；`daemon-client.ts` が `AudioDeviceInfo` |

🔴 **`__*ForTest` は 14 本ではなく 13 本**（`grep -c '^export function __'`）。issue / ブリーフの「14」は誤り。名前は §3.3 に全列挙した。

### 2.2 テストが `extension.ts` に触る形

| spec | import の形 | 使う export |
|---|---|---|
| `extension-wiring.spec.ts`（203 箇所） | `import * as ext`（静的） | `__set/get*` 8 種 + `setup*Handler` 5 本 + `stopEngine` / `deactivate` |
| `engine-command-awaits.spec.ts`（17） | **`vi.resetModules()` 後に動的 `import()`** | `__set*` 4 種 + `__getDeviceSwitchBridgeForTest` + `activate` / `deactivate` |
| `start-engine-for-agent.spec.ts`（3） | 静的 | `startEngineForAgent` / `toggleEngine` / `__getEngineProcessForTest` |
| `engine-spawn-runtime.spec.ts`（1） | 静的 | `startEngineForAgent` / `__setEngineProcessForTest` |
| `dsl-completion-provider.spec.ts` | 静的 + 動的 | `dslCompletionItemProvider` / `registerCompletionProviders` |
| `output-code-action.spec.ts` | 静的 | `registerOutputCodeActionProvider` |
| `tests/helpers/extension-engine-mocks.ts`（12） | 構造型 `ExtensionTestHooks` で受ける | `__set*` 4 種 |

`ForTest` の出現は `tests/vscode-extension/*.ts` + `tests/helpers/*.ts` で **239**（コメント・型名を含む）。

### 2.3 🔴 `vi.mock` されているモジュール（= 配線を**戻してはいけない**先）

| mock 対象 | どの spec が | 何を差し替えるか |
|---|---|---|
| `engine-lifecycle` | `extension-wiring.spec.ts:48` | `applyEngineExit` / `applyEngineError` を **pass-through spy** に。`vi.mocked(engineLifecycle.applyEngineExit)` で `effects` オブジェクトを捕捉（958 行・1198 行） |
| `plugin-catalog-reader` | `extension-wiring.spec.ts:58` | `terminateActivePluginScans` を spy |
| `engine-startup-runtime` | `engine-command-awaits` / `start-engine-for-agent` / `engine-spawn-runtime` | `resolveDaemonBinaryForExtension` / `extensionEngineFileExists` を差し替え |
| `child_process` | 上 3 本 + `plugin-catalog-reader.spec.ts` | `spawn` / `execFile` |
| `vscode` | 全 spec（root `vitest.config.ts` の alias → `tests/mocks/vscode.ts`） | — |

vitest の `vi.mock` は**モジュール境界**で差し替える。同じファイルの中の呼び出しはローカル束縛を直接呼ぶので mock を通らない。したがって **呼び出し側を mock 対象のファイルへ移すと、spy が一度も呼ばれなくなる**（§4.2）。

### 2.4 ブリーフ / issue の見積もりとの突合

| 項目 | ブリーフ / issue | 実測 | 影響 |
|---|---|---|---|
| `__*ForTest` の本数 | 14 | **13** | 名前の列挙で確定（§3.3） |
| 1251–1578 の行き先 | `engine-lifecycle.ts`（既存） | 🔴 **不可**（§2.3） | 新設 `engine-handlers.ts` へ（§4） |
| 1633–1926 の行き先 | `engine-view.ts`（既存） | 純モジュール（header に「Kept vscode-free」）。戻すと 20 箇所超の `vscode.*` 値参照が入る | 新設 `engine-view-provider.ts` へ |
| 169–291 の行き先 | `playhead.ts`（既存） | 純モジュール（「pure helpers」）。同上 | 新設 `playhead-decorations.ts` へ |
| 149–167 `pushLogRing` の行き先 | `log-ring.ts` | `pushLogRing` は `outputLogRing`（可変状態）に閉じる。状態と一緒に `extension-state.ts` へ | `log-ring.ts` は純関数のまま |
| 3752– `updateDiagnostics` | `diagnostics-analysis.ts` か | `vscode.Diagnostic` を組み立てる配線（117 行） | 新設 `diagnostics-provider.ts` へ |
| `npm test` | 2,450 passed | 本書では再計測していない。**束 0 の前に main が測って記録する**（§7.1） | — |

### 2.5 その他の事実

- `.eslintrc.cjs` に `max-lines` / `max-lines-per-function` は**無い**（設計 888 §6 の子 0b は未着手）。本設計は関数の分割を要求しない（最大は `configureFlash` 167 / `startOrbitScoreMcpServer` 167 / `activate` 150）
- `isTransportCommand`（3361–3373・5 コード行）は**どこからも参照されていない**（D10）
- `scripts/repo/move-residual.sh` は**リポジトリに存在しない**（`BUNDLE_BRANCH_WORKFLOW.md` §5.1a が参照しているが未作成）。Rust の各束は生の `git diff --color-moved` で測った（§8.1 にコマンドを写した）
- dev サイトの引用: `extension.ts` **248 箇所（一意な範囲 103）**、`mcp-server.ts` **46 箇所（18）**。**すべての束で必ず動く**。`--fix` は行番号のずれしか直せず、ファイルをまたぐ移動は本セッションの scratchpad にある `relocate-citations.mjs` でしか直せない（§7.1 で束 0 に入れる）
- `tsconfig.tests.json`（`npm run typecheck:e2e`・CI 実行）の `include` は `tests/e2e/**` だけ。`tests/vscode-extension/` の spec は**一度も型検査されていない**（esbuild で剥がして実行するだけ）
- ラチェット L-3: 新設ファイルは **`git add` してから `npm test`** を回さないと測られない（設計 888 §13.10）

---

## 3. Q1 — `__*ForTest` 13 本とモジュールスコープ可変状態をどう畳むか

### 3.1 言語の制約が形を決める

`extension.ts` の 109–148 行にある可変状態は **22 個**: `let` が 12、`const` が 10（bridge 5・`outputLogRing`・playhead の Map/Set 4）。

ES module では **`import { x }` した束縛に代入できない**（TS: `Cannot assign to 'x' because it is an import`）。読むのは live binding で常に最新値が見える（TS の CommonJS 出力も `state_1.x` というプロパティ参照になるので同じ）。つまり:

- **`const`（bridge・Map・配列）は export するだけでよい**。参照側の本文は変わらない
- **`let` は、書く側だけが形を変える**。読む側の本文は変わらない

そこで「読みは live binding・書きは setter」に決めた（D1）。代入箇所を数えると **31 箇所**しかない:

| `let` | 代入している行（現行） | 件数 |
|---|---|---|
| `engineProcess` | `activate` 296 / `engineTerminationEffects` 1509 / `startEngine` 2025 / `stopEngine` 2080 | 4 |
| `outputChannel` | `activate` 302 | 1 |
| `statusBarItem` | `activate` 331 | 1 |
| `bundleStatusItem` | `activate` 339 | 1 |
| `devDocsPanel` | `openDevDocsPanel` 579・591 / `deactivate` 509 | 3 |
| `isLiveCodingMode` | 297 / 1510 / 2043 / 2082 | 4 |
| `globalInitialized` | 298 / 1511 / 2044 / 2083 / `writeCodeToEngine` 2759 | 5 |
| `transportPlaying` | 299 / `setupStdoutHandler` 1366 / 1512 / 2045 / 2084 | 5 |
| `mcpServerHandle` | `activate` 447 / `deactivate` 504 | 2 |
| `engineViewProvider` | `activate` 380 | 1 |
| `engineGeneration` | `startEngine` 2040 / `stopEngine` 2076（`+= 1`） | 2 |
| `pluginCatalogHintShown` | `rescanPlugins` 2216 / `registerCompletionProviders` 3457 | 2 |
| | | **31** |

読み出しは同じ 12 個で **約 220 箇所**（`outputChannel?.appendLine` が最多）。**220 箇所の本文を 1 文字も変えない**のがこの案の要点である。

### 3.2 `extension-state.ts`（新設・leaf）

```ts
// 依存: bridge 4 クラス（値）+ `type EngineViewProvider`（型のみ・循環しない）+ vscode / child_process の型
export let engineProcess: child_process.ChildProcess | null = null      // 109–148 の 12 本の let をそのまま
export let outputChannel: vscode.OutputChannel | null = null
…
export const selectAudioDeviceBridge = new DeviceSwitchBridge()          // const 6 本（bridge 5 + outputLogRing）
…
export function pushLogRing(line: string): void { … }                   // 149–167（outputLogRing に閉じる）
export function isEngineRunning(): boolean { … }                        // 1579–1590（engineProcess に閉じる）

// 書く側の入口 — 12 本。名前は `set` + 変数名（`bumpEngineGeneration` だけ += 1）
export function setEngineProcess(p: child_process.ChildProcess | null): void { engineProcess = p }
…
export function bumpEngineGeneration(): void { engineGeneration += 1 }

// 1096–1133 の 8 本（本文そのまま・この状態に閉じる seam）
export function __setEngineProcessForTest(…) / __getEngineProcessForTest / __setStatusBarItemForTest /
  __setOutputChannelForTest / __setEngineViewProviderForTest / __getDeviceSwitchBridgeForTest /
  __getPluginUiBridgeForTest / __setLiveCodingModeForTest
```

🔴 **setter と `__set*ForTest` を統合しない。** `__setStatusBarItemForTest` は `Pick<…,'text'|'tooltip'>` を受けて `as unknown as` で押し込む（テストのモックを通す**ための**緩い型）。本番の setter は本物の型だけを受ける。統合すると本番コードが緩い型を受け入れる = 振る舞いは同じでも**契約が変わる**。

🔴 **`vi.mock('./extension-state')` を禁じる**（module doc に書く）。`{ ...actual, x: vi.fn() }` の spread は `export let` の値を**その時点でコピー**するので live binding が切れる。今そうしている spec は無い。

playhead の Map/Set 4 本以外の状態はここに集める。playhead の 4 本は `playhead-decorations.ts` が所有する（`deactivate` が `playheadDecorationTypes` に直接触るので export はする）。`pluginCatalogHintShown` は書き手が 2 モジュールに跨るので `extension-state.ts` に置く。

### 3.3 `__*ForTest` 13 本の行き先（名前・引数・本文は不変）

| seam | 閉じている状態 | 行き先 |
|---|---|---|
| `__setEngineProcessForTest` / `__getEngineProcessForTest` | `engineProcess` | `extension-state.ts` |
| `__setStatusBarItemForTest` | `statusBarItem` | 同 |
| `__setOutputChannelForTest` | `outputChannel` | 同 |
| `__setEngineViewProviderForTest` | `engineViewProvider` | 同（`import type { EngineViewProvider }`） |
| `__getDeviceSwitchBridgeForTest` | `selectAudioDeviceBridge` | 同 |
| `__getPluginUiBridgeForTest` | `pluginUiBridge` | 同 |
| `__setLiveCodingModeForTest` | `isLiveCodingMode` | 同 |
| `__pluginUiForAgentForTest` | `pluginUiForAgent`（関数） | `agent-handlers.ts` |
| `__setPlayheadActiveRangeForTest` | playhead の Map | `playhead-decorations.ts` |
| `__getPlayheadActiveRangeCountForTest` | 同 | 同 |
| `__getPlayheadTimeoutCountForTest` | 同 | 同 |
| `__resetPlayheadStateForTest` | 同 | 同 |

`extension.ts` は次の再輸出ブロックを持つ（1084–1095 の警告コメントごと移す）:

```ts
export {
  __setEngineProcessForTest, __getEngineProcessForTest, __setStatusBarItemForTest,
  __setOutputChannelForTest, __setEngineViewProviderForTest, __getDeviceSwitchBridgeForTest,
  __getPluginUiBridgeForTest, __setLiveCodingModeForTest,
} from './extension-state'
export {
  __setPlayheadActiveRangeForTest, __getPlayheadActiveRangeCountForTest,
  __getPlayheadTimeoutCountForTest, __resetPlayheadStateForTest,
} from './playhead-decorations'
export { __pluginUiForAgentForTest, startEngineForAgent } from './agent-handlers'
export { setupStdoutHandler, createLinePrefixer, setupStderrHandler, setupStdinErrorHandler,
  setupExitHandler, setupErrorHandler } from './engine-handlers'
export { stopEngine, toggleEngine } from './engine-process'
export { registerCompletionProviders, registerOutputCodeActionProvider,
  dslCompletionItemProvider } from './dsl-providers'
```

これで `extension.ts` の **27 export は名前も型も変わらない**。テストの import 先を変える必要は無く（C7 は「変えてよい」であって「変えろ」ではない）、**`tests/` の差分 0** が検算になる。

なぜ再輸出を残すか: (1) `extension-wiring.spec.ts` は「extension が正しい実装を配線したか」を検査する spec で、`ext` を単位として扱っている。(2) 27 本のうち 13 本はテスト専用 seam で、それが `extension.ts` に**一覧として見える**こと自体が 1084–1095 の警告（「新しい importer を足す前にこの注記を読め」）の前提。(3) 再輸出ブロックはコード行にして 20 行程度。

### 3.4 `engine-command-awaits.spec.ts` の `vi.resetModules()` は壊れない

`vi.resetModules()` は登録済みモジュールを全部捨て、次の `import('…/extension')` が `extension-state.ts` ごと**新しいインスタンス**を作る。状態が別モジュールへ移っても、この spec が期待する「毎テスト新品の状態」は保たれる（むしろ今より隔離が強い）。

### 3.5 採らなかった案

| 案 | 捨てた理由 |
|---|---|
| **(a) 状態を 1 つの可変オブジェクトに集めて export** | 読み出し **約 220 箇所**が `st.engineProcess` の形に変わる。residual が 250 行超になり、レビュアーが「機械的な置換か」を読んで確かめることになる（正規化して diff すれば機械にできるが、道具を 1 つ増やす）。setter 案は変更を**代入の 31 箇所**に限定でき、しかもそれは状態遷移の場所なのでレビューで見る価値がある行である |
| **(c) 状態を引数で渡す（DI）** | 全 spec の `__set*ForTest` 呼び出しが意味を失い、239 箇所を書き換えることになる。C2 の検算そのものが消える。ブリーフの判断どおり不採用 |
| **(b′) 状態を `extension.ts` に残し、子モジュールが `./extension` から live binding を import** | 循環 import（`extension` ⇄ 子）。実行時には動く（参照は呼び出し時のプロパティ参照）が、`vi.resetModules` + 動的 import と循環の組み合わせは読み手が追えず、Fable 監査 / レビューチームが必ず指摘する。leaf の状態モジュールなら循環は構造的に無い |
| **setter を `__set*ForTest` と統合** | §3.2 の理由（緩い型を本番に流し込む） |
| **`setup*Handler` を `engine-lifecycle.ts` へ戻す**（ブリーフの表） | §2.3 / §4.2 の理由。テストを書き換えずには成立しない |

---

## 4. Q4 — `extension.ts` の行き先の地図

### 4.1 原則

1. **兄弟 20 本は純モジュール**（header に「vscode-free」「pure helpers」「Pure module」と明記）。**戻すのは「その純モジュールが本来持っていたはずの純粋なロジック」だけ**で、そういうものは `extension.ts` にはもう残っていない（残っているのは全部 vscode / child_process に触る配線）。
2. 配線は、**対になる純モジュールと同じ主題の名前**で新ファイルにする。命名は既存に倣う（`engine-view.ts` ↔ `engine-view-provider.ts`、`playhead.ts` ↔ `playhead-decorations.ts`、`engine-lifecycle.ts` ↔ `engine-handlers.ts`）。
3. **import は DAG**。`extension-state.ts` が leaf、`extension.ts` が root。子同士の依存の向きを §4.4 に固定した。
4. 各ファイル 500 以下（C5）。余裕を 100 以上取る（後続の変更で超えないため）。

### 4.2 🔴 mock 境界を跨いで戻してはいけない（D3）

`extension-wiring.spec.ts:48`:

```ts
vi.mock('../../packages/vscode-extension/src/engine-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<…>()
  return { ...actual, applyEngineExit: vi.fn(actual.applyEngineExit), applyEngineError: vi.fn(actual.applyEngineError) }
})
…
const applyEngineExitSpy = vi.mocked(engineLifecycle.applyEngineExit)   // 958 行
const effects = vi.mocked(engineLifecycle.applyEngineError).mock.calls[0][2]   // 1198 行
```

`setupExitHandler` が `applyEngineExit` を呼ぶのは **import 越し**だから spy に当たる。`setupExitHandler` を `engine-lifecycle.ts` の中へ移すと、呼び出しは同一モジュール内のローカル束縛になり **spy には一度も届かない**。この spec の該当 2 テストは落ち、直すには spec を書き換えるしかない → C2 違反。

同じ理由で:
- `resolveDaemonForUI` / `getEnginePath` を `engine-startup-runtime.ts` へ入れない
- `deactivate` / `rescanPlugins` / `listPluginsForAgent` / `rescanPluginsForAgent` / `browsePlugins` を `plugin-catalog-reader.ts` へ入れない

### 4.3 地図（行は現物・コード行は実測）

| 現行の行 | 塊 | コード行 | 行き先 | 依存（import する先） |
|---|---|---|---|---|
| 1–108 | header / import | 103 | `extension.ts`（縮む） | — |
| 109–148 | 可変状態 22 本 | 18 | **`extension-state.ts`**（playhead の 4 本は下へ） | bridge クラス / 型のみ |
| 149–168 | `pushLogRing` | 6 | `extension-state.ts` | — |
| 169–291 | playhead 装飾 + Map/Set 4 本 | 93 | **`playhead-decorations.ts`** | `playhead.ts` / vscode |
| 292–518 | `activate` / `deactivate` | 168 | **残す** | 全部 |
| 519–636 | docs / walkthrough パネル | 93 | **`docs-panels.ts`** | state（`mcpServerHandle` 読み・`devDocsPanel` 読み書き） |
| 637–653 | `resolveDaemonForUI` | 9 | `engine-process.ts` | `engine-startup-runtime`（mock 境界の外側に留まる） |
| 654–687 | `updateBundleStatus` / `showCommands` / `restartEngine` / `reloadWindow` | 29 | **残す** | `engine-process` |
| 688–873 | `configureFlash` | 167 | **`flash-config.ts`** | vscode のみ（状態に触らない） |
| 874–955 | `toggleEngine` / `getEnginePath` / `showEngineBuildTime` / `loadAudioDeviceConfig` | 57 | `engine-process.ts` | state / `engine-startup-runtime` |
| 956–1060 | `shouldFilterLine` | 81 | **`engine-handlers.ts`** | — （純関数。本文は状態に触らない。1061–1095 のコメントが状態名を挙げているだけ） |
| 1084–1133 | seam 8 本 + 警告コメント | 30 | `extension-state.ts` | — |
| 1134–1159 | `__pluginUiForAgentForTest` | 8 | `agent-handlers.ts` | — |
| 1160–1250 | playhead seam 4 本 | 24 | `playhead-decorations.ts` | — |
| 1251–1274 | `logHandlerFailure` | 18 | `engine-handlers.ts` | state |
| 1275–1578 | `setup*Handler` 5 本 + `createLinePrefixer` + `engineTerminationEffects` | 190 | `engine-handlers.ts` | state / `playhead-decorations` / `engine-lifecycle`（import 越し） |
| 1579–1590 | `isEngineRunning` | 3 | `extension-state.ts` | — |
| 1591–1632 | `resolveAudioDeviceSetting` / `autoStartConfiguredRustEngine` | 31 | `engine-process.ts` | `fetchAudioDevicesForView`（同ファイル） |
| 1633–1678 | `fetchAudioDevicesForView` | 34 | `engine-process.ts`（🔴 `engine-view-provider` ではない） | `resolveDaemonForUI`（同ファイル）/ child_process |
| 1679–1926 | `EngineViewProvider` + `engineView*` 4 本 + `writeAudioDeviceSetting` | 209 | **`engine-view-provider.ts`** | `engine-view.ts` / state / `engine-process` / `engine-handlers`（`logHandlerFailure`） |
| 1927–2138 | `startEngine` / `startEngineDebug` / `stopEngine` | 111 | **`engine-process.ts`** | state / `engine-handlers` / `playhead-decorations` |
| 2139–2241 | `browsePlugins` / `rescanPlugins` | 84 | **`plugin-commands.ts`** | `plugin-catalog-*` / state |
| 2242–2420 | MCP 登録（型 + `performMcpRegistration` + `registerMcpServer`） | 126 | **`mcp-register-command.ts`** | `mcp-registration.ts` / state |
| 2421–2636 | `getLineSubject` / `runSelection` | 134 | **`run-selection.ts`** | state / `engine-process`（`writeCodeToEngine`） |
| 2637–2783 | `send*Meta` 4 本 + `writeCodeToEngine` | 123 | `engine-process.ts` | state |
| 2784–3360 | `*ForAgent` 25 本 + `ENGINE_STATE_QUERY_BUDGET_MS` | 425 | **`agent-handlers.ts`**（下の 4 本を除く → 約 325） | state / `engine-process` / `run-selection` / `plugin-commands` / `mcp-register-command` / `flash-config` |
| ↳ 2942–2980 | `listPluginsForAgent` / `rescanPluginsForAgent` | 31 | `plugin-commands.ts` | |
| ↳ 3038–3093 | `configureFlashForAgent` | 52 | `flash-config.ts` | |
| ↳ 3136–3153 | `runSelectionForAgent` | 12 | `run-selection.ts` | |
| ↳ 3344–3360 | `registerMcpServerForAgent` | 13 | `mcp-register-command.ts` | |
| 3361–3373 | `isTransportCommand`（未参照） | 5 | **残す**（D10） | — |
| 3374–3751 | 補完 / code action / hover + `dslCompletionItemProvider` + `getPitchScopeCompletions` | 281 | **`dsl-providers.ts`** | `completion-context` / `dsl-*` / `plugin-catalog-*` / state |
| 3752–3902 | `updateDiagnostics` | 117 | **`diagnostics-provider.ts`** | `diagnostics-analysis` / `plugin-name-diagnostics` |

新設 13 本の見込みサイズ（コード行）:

| ファイル | 見込み | ファイル | 見込み |
|---|---|---|---|
| `extension-state.ts` | ~95（状態 18 + 関数 9 + setter ~36 + seam 30） | `engine-view-provider.ts` | ~210 |
| `playhead-decorations.ts` | ~120 | `plugin-commands.ts` | ~115 |
| `docs-panels.ts` | ~95 | `mcp-register-command.ts` | ~140 |
| `flash-config.ts` | ~220 | `run-selection.ts` | ~150 |
| `engine-process.ts` | ~370（57+9+31+34+111+123） | `agent-handlers.ts` | ~330 |
| `engine-handlers.ts` | ~290（81+18+190） | `dsl-providers.ts` | ~285 |
| `diagnostics-provider.ts` | ~120 | **`extension.ts`（残り）** | **~280**（activate 150 + deactivate 18 + 小コマンド 29 + isTransportCommand 5 + import/再輸出 ~80） |

各値に import 行（10〜40）が乗る。**最大は `engine-process.ts` の ~400** で 500 に対し余裕がある。

### 4.4 import の向き（循環を作らないための固定）

```
extension-state  ←  playhead-decorations  ←  engine-handlers  ←  engine-process  ←  engine-view-provider
      ↑                                                              ↑         ↑          ↑
      └──────── docs-panels / flash-config / plugin-commands / mcp-register-command / run-selection
                                                                     ↑
                                                              agent-handlers  ←  extension (root)
```

- `engine-process` は `engine-view-provider` を import **しない**（`fetchAudioDevicesForView` を `engine-process` 側に置いたのはそのため。`autoStartConfiguredRustEngine` → `fetchAudioDevicesForView` の呼び出しがあり、逆向きに置くと循環する）
- `engine-handlers` は `engine-process` を import **しない**（`startEngine` が `setup*Handler` と `logHandlerFailure` を呼ぶので向きは process → handlers）
- `agent-handlers` は他の子を import するが、他の子は `agent-handlers` を import しない
- `extension-state` は `type EngineViewProvider` を **`import type`** で受ける（実行時の辺は無い）

### 4.5 `startEngine` の代入は narrowing を壊さない形に

現行 2025–2059:

```ts
engineProcess = child_process.spawn(process.execPath, […], {…})   // ここで非 null に narrowing
…
setupStdoutHandler(engineProcess, effectiveDebugMode)              // narrowing に依存
…
const spawnedProcess = engineProcess
```

setter 化すると `engineProcess`（import された `ChildProcess | null`）は narrowing しない。**`spawn` の戻りを局所定数に受けてから setter に渡し、以後の同関数内の参照は局所定数を使う**:

```ts
const spawned = child_process.spawn(process.execPath, […], {…})
setEngineProcess(spawned)
…
setupStdoutHandler(spawned, effectiveDebugMode)
```

`stopEngine` は既に `const proc = engineProcess` で受けてから null にしているので `setEngineProcess(null)` の 1 行だけ。`activate` の `outputChannel = vscode.window.createOutputChannel(…)` も同型で、302–328 の `outputChannel.appendLine(...)` 約 12 行が局所定数 `channel` を参照する形になる（`statusBarItem` 5 行・`bundleStatusItem` 3 行も同じ）。**これらは束 A の residual として現れ、レビュアーが読む行である**（隠さない）。

---

## 5. Q4b — `mcp-server.ts`（1,161 コード行）の切り方

### 5.1 構造（実測）

| 行 | 塊 | コード行 |
|---|---|---|
| 1–98 | header / SDK の `require` shim（`McpServer` / `StreamableHTTPServerTransport` / `z`）+ `McpServerLike` `TransportLike` `ZodTypeLike` | 52 |
| 99–291 | wire 型 25 本 + `OrbitScoreToolHandlers` | 141 |
| 292–352 | `errorResult` / `resolveMcpPluginUiIndex` / `toToolResult` / `McpServerHandle` | 48 |
| 353–536 | docs 配信ヘルパー（`DOCS_PUBLIC_BASE` … `isDocsDistStale` + `staleCheckCache`） | 131 |
| 537–1160 | **`buildServer` — 1 関数 616 行**（`registerTool` 25 回） | 616 |
| 1161–1403 | `SessionEntry` + `startOrbitScoreMcpServer`（167）+ `isInitializeRequest` / `readJsonBody` | 195 |

`buildServer` は `session.rs` の `handle_command`（1,028 行の単一 `match`）と同じ問題で、**ファイルを分けても 1 つの式なので閾値を満たせない**。owner 裁定（子 2）に倣い、関数の中身を**引数付きの登録関数へ切る**。

### 5.2 切り方（D5）

```ts
// mcp-tools-engine.ts   — 545–687（136 行）: evaluate / start / stop / get_engine_state / list & select device / configure_flash
export function registerEngineTools(server: McpServerLike, handlers: OrbitScoreToolHandlers): void {
  server.registerTool('evaluate_orbitscore', { … }, async (args) => { … })   // ← 本文は 1 行も書き換えない
  …
}
// mcp-tools-editor.ts   — 688–868 + 1081–1160（245 行）: open_file … get_log + get_dev_doc / search_dev_docs / register_mcp_server
export function registerEditorTools(server, handlers, docsSourceRoot: string): void
// mcp-tools-plugins.ts  — 869–1080（206 行）: save_plugin_state / open & close_plugin_ui（条件付き登録ごと）/ analyze_audio / list & rescan_plugins
export function registerPluginTools(server, handlers): void
```

`buildServer` は残り 7 行 + 3 呼び出しになる。**インデント深さが同じ（2 スペース）なので `registerTool` 呼び出しの行は byte 単位で一致し、moved として検出される。**

共有物の置き場:

| 物 | 行き先 | 理由 |
|---|---|---|
| SDK `require` shim + `McpServerLike` / `TransportLike` / `ZodTypeLike` / `z` | **`mcp-sdk.ts`** | 3 つの tools ファイル全部が `z` と `McpServerLike` を使う（`z` の参照 36 箇所） |
| 型 25 本 + `OrbitScoreToolHandlers` | **`mcp-types.ts`** | `extension.ts` / spec / `engine-state-bridge` / `daemon-client` が import する。`mcp-server.ts` から `export type { … } from './mcp-types'` で**再輸出し、import 先は変えない** |
| `errorResult` / `toToolResult` / `resolveMcpPluginUiIndex` / `McpServerHandle` | `mcp-sdk.ts` に同居（`ToolResult` 型と一緒） | tools 3 本と `startOrbitScoreMcpServer` が使う。`resolveMcpPluginUiIndex` は spec と gated E2E が `mcp-server` から import するので再輸出 |
| docs 配信ヘルパー 353–536 | **`mcp-docs.ts`** | `startOrbitScoreMcpServer`（1254–1292）と editor tools（1092・1115）が使う。9 本の export は `mcp-server.ts` から再輸出 |

残る `mcp-server.ts` ≈ header + `buildServer` shell + `SessionEntry` + `startOrbitScoreMcpServer` + `isInitializeRequest` / `readJsonBody` + 再輸出 ≈ **260**。新設 6 本はいずれも 250 以下。

🔴 `ZodTypeLike` の header コメント「**使う builder を増やしたらここも増やすこと**」（`npm run build` だけが落ちる）は `mcp-sdk.ts` へ**そのまま**移す。

### 5.3 引用 `src/mcp-server.ts:538-1147`（`buildServer` 丸ごと）

2 言語 ×1 箇所。3 ファイルへ割れるので relocate では直らない。**その章の散文を読んで、`buildServer` shell（残る側）を引くか 3 ファイルの 1 つを引くかを決める**（束 F の手作業 1 件として明記）。

---

## 6. Q3 — TS で「export が黙って消える」欠陥を何で固定するか（D6）

### 6.1 欠陥の形（Rust との対応）

| Rust（実際に 2 回踏んだ） | TS の同型 | 今それを捕まえるもの |
|---|---|---|
| `pub(crate) use` で crate 外から消える | 再輸出ブロックから 1 本抜ける / 名前が変わる | **消費者が居れば** tsc（packages 側）か vitest 実行時。`createLinePrefixer` / `USER_DOCS_PUBLIC_BASE` / `resolveUserDocsRoot` / `matchDocsRequest` / 型 `FlashConfig` `DiagnosticEntry` `PluginCatalogEntryInfo` `DevDocSearchMatch` は**消費者が居ない**ので誰も気づかない |
| — | `export type { X }` で再輸出したものを値として使う | tsc のみ（vitest は esbuild で型を剥がすので `undefined` になるまで沈黙） |
| — | 再輸出の連鎖が循環で `undefined` | 実行時のみ |

`tests/vscode-extension/` の spec は**型検査されていない**（§2.5）。つまり「spec が import している」は型レベルの保証にならない。

### 6.2 決定: 1 ファイルで 2 層

`tests/vscode-extension/public-surface.spec.ts`（新設・束 0）:

```ts
// main 時点（2026-09-12）の公開面。意図的に非公開へ変えるときはここからも消す（消さずに通ることはない）。
import {
  activate, deactivate, toggleEngine, stopEngine, startEngineForAgent,
  setupStdoutHandler, createLinePrefixer, setupStderrHandler, setupStdinErrorHandler,
  setupExitHandler, setupErrorHandler, registerCompletionProviders,
  registerOutputCodeActionProvider, dslCompletionItemProvider,
  __setEngineProcessForTest, /* … 13 本 … */
} from '../../packages/vscode-extension/src/extension'
import {
  startOrbitScoreMcpServer, resolveMcpPluginUiIndex, DOCS_PUBLIC_BASE, USER_DOCS_PUBLIC_BASE,
  resolveDocsRoot, resolveUserDocsRoot, resolveDocsFilePath, readDevDoc, searchDevDocs,
  matchDocsRequest, isDocsDistStale,
  type EvaluateResult, /* … 型 25 本 … */
} from '../../packages/vscode-extension/src/mcp-server'

export type McpTypeSurface = [EvaluateResult, CommandResult, /* … */]   // 型は「名前が解決する」ことだけ見る

const surface = { activate, deactivate, /* … 値 27 + 11 … */ }
describe('public surface of extension.ts / mcp-server.ts', () => {
  it.each(Object.entries(surface))('%s is a value at runtime', (_name, value) => {
    expect(value).toBeDefined()          // 再輸出が途切れると esbuild は undefined を返す
  })
})
```

- **tsc 層**: `tsconfig.tests.json` の `include` に `"tests/vscode-extension/public-surface.spec.ts"` を足す（`npm run typecheck:e2e`・CI 済み）。実測（本セッション・リポジトリ内の `.probe-887/` で試して削除済み）:
  - 名前が無い → `TS2724: has no exported member named 'createLinePrefixerX'`
  - 型だけの名前を値に使う → `TS2693: 'OrbitScoreToolHandlers' only refers to a type, but is being used as a value`
  - `vscode` の型は `types` に足さなくても解決する（`moduleResolution: node` が `@types/vscode` をモジュールとして引く）
- **vitest 層**: 上の `it.each` が実行時の `undefined` を捕まえる

🔴 **`import type` で受ける名前は「型だけである」ことも固定される**（値 import に書き換えると TS2693 で落ちる）。逆に、値を型として import すると `verbatimModuleSyntax: false` のため通ってしまうので、**値は必ず値として import する**（上の形）。

### 6.3 何を凍結するか（一覧・本書の §2.1 と一致）

- `extension.ts` **27**: `activate` `deactivate` `toggleEngine` `stopEngine` `startEngineForAgent` `setupStdoutHandler` `createLinePrefixer` `setupStderrHandler` `setupStdinErrorHandler` `setupExitHandler` `setupErrorHandler` `registerCompletionProviders` `registerOutputCodeActionProvider` `dslCompletionItemProvider` + `__*ForTest` 13
- `mcp-server.ts` 値 **11**: `resolveMcpPluginUiIndex` `DOCS_PUBLIC_BASE` `USER_DOCS_PUBLIC_BASE` `resolveDocsRoot` `resolveUserDocsRoot` `resolveDocsFilePath` `readDevDoc` `searchDevDocs` `matchDocsRequest` `isDocsDistStale` `startOrbitScoreMcpServer`
- `mcp-server.ts` 型 **25**: `EvaluateResult` `CommandResult` `EngineState` `AudioDeviceInfo` `AudioDevicesResult` `FlashConfigInput` `FlashConfig` `FlashConfigResult` `SelectionInput` `EditReplaceInput` `EditorState` `DocumentText` `DiagnosticSeverityLabel` `DiagnosticEntry` `FileDiagnostics` `AnalyzeAudioResult` `PluginCatalogEntryInfo` `ListPluginsResult` `RescanPluginsResult` `SavePluginStateResult` `PluginUiResult` `RegisterMcpServerInput` `OrbitScoreToolHandlers` `McpServerHandle` `DevDocSearchMatch`

Codex は実装時に `grep -E '^export' ` で**この一覧を現物と突き合わせてから**書く（本書の一覧を写すのではない）。

### 6.4 採らなかった案

| 案 | 理由 |
|---|---|
| `src/index.ts` を作って公開面を宣言 | 消費者の居ない層は守られない（memory）。宣言の場所を増やしても検査にはならない |
| ESLint `import/no-unused-modules` | plugin 未導入・`vscode` 解決を切っている設定（`import/no-unresolved: off`）で誤検知が読めない |
| `tests/vscode-extension/**` 全部を `tsconfig.tests.json` に入れる | 望ましいが**別 issue**。今の spec が型検査に通る保証が無く、直すのは「振る舞いを変えない分割」の範囲を超える |

---

## 7. Q2 — 束の切り方と順序（D7・D8）

### 7.1 束 0 — 道具を先に置く（移動は 1 行もしない）

| 内容 | 理由 |
|---|---|
| `tests/vscode-extension/public-surface.spec.ts` + `tsconfig.tests.json` の include | §6。**分割の前に**置く（Rust 子 3: 先に置いた `public_surface.rs` が stack 先端で欠陥を捕まえた） |
| `sites/dev/scripts/relocate-citations.mjs` を scratchpad からリポジトリへ | 引用 294 箇所（248 + 46）がすべての束で動く。`--fix` は行番号しか直せない。scratchpad は消える |
| `npm test` の件数を **main で測って WORK_LOG に書く** | 以後の全束の期待値。ブリーフの 2,450 を鵜呑みにしない |

done の条件: `npm test` が緑で件数 = 測った値 + surface spec の件数、`npm run typecheck:e2e` 緑、`npm run lint` 緑。
検証: 上 3 コマンド + `git diff --stat main -- packages/` が**空**（ソースを 1 行も触っていない）。

### 7.2 束 A — 状態と playhead（代入を setter に替えるのはここだけ）

新設: `extension-state.ts` / `playhead-decorations.ts`。`extension.ts` の 31 箇所の代入を setter 呼び出しへ、`activate` / `startEngine` の narrowing 依存を局所定数へ（§4.5）。再輸出ブロックを置く。

| done | 検証 |
|---|---|
| `extension.ts` が `extension-state` / `playhead-decorations` を import し、**`let` が 1 本も残っていない** | `grep -cE '^let ' packages/vscode-extension/src/extension.ts` = **0** |
| 27 export 不変 | `public-surface.spec.ts` 緑 + `typecheck:e2e` 緑 |
| テスト不変 | `git diff --stat <base>...HEAD -- tests/` が**空**・`npm test` 件数 = 束 0 の値 |
| residual の中身が「setter 定義・setter 呼び出し・局所定数化・import / 再輸出・module doc」**だけ** | §8.1 の出力を PR 本文に貼り、行ごとに上の 5 分類に振る。**分類できない行が 1 行でもあれば移動に紛れた変更** |
| 新設 2 本が 500 以下 | `npm test`（ラチェット）。🔴 **`git add` してから** |

residual の見込み: setter ~36 + 呼び出し 31 + 局所定数化 ~25 + import / 再輸出 ~40 + doc ~20 ≈ **150**。

### 7.3 束 B — engine の配線（純粋な移動）

新設: `engine-handlers.ts`（956–1060 / 1251–1578）/ `engine-process.ts`（637–653 / 874–955 / 1591–1678 / 1927–2138 / 2637–2783）。約 **615 コード行**が動く。

| done | 検証 |
|---|---|
| `extension-wiring.spec.ts` の `applyEngineExit` / `applyEngineError` spy が**呼ばれている** | `npm test` 緑（958 行・1198 行のテストが通る = mock 境界の外側に置けた証拠） |
| 移動が純粋 | residual = import / 再輸出 / module doc **のみ**。`moved+ == moved−` |
| 循環なし | `grep -l "from './engine-process'" packages/vscode-extension/src/engine-handlers.ts` が**空** |

### 7.4 束 C — view / docs / flash（純粋な移動）

新設: `engine-view-provider.ts`（1679–1926）/ `docs-panels.ts`（519–636）/ `flash-config.ts`（688–873 + 3038–3093）。約 **520 行**。

done / 検証は束 B と同じ形。追加: `engine-command-awaits.spec.ts` の「`internal error in engineViewSelectDevice`」を含む行のアサーションが通る（`logHandlerFailure` の handlerName 文字列が動いていない）。

### 7.5 束 D — 評価と agent（純粋な移動）

新設: `run-selection.ts`（2421–2636 + 3136–3153）/ `plugin-commands.ts`（2139–2241 + 2942–2980）/ `mcp-register-command.ts`（2242–2420 + 3344–3360）/ `agent-handlers.ts`（2784–3360 の残り + 1134–1159）。約 **730 行**。

追加の done: `activate` の `handlers: { … }` オブジェクトリテラル（451–475）は**触らない**（各 `*ForAgent` を import するだけ）。`__pluginUiForAgentForTest` は `agent-handlers.ts` に置き `extension.ts` が再輸出。

### 7.6 束 E — 言語機能（純粋な移動・`extension.ts` 完了）

新設: `dsl-providers.ts`（3374–3751）/ `diagnostics-provider.ts`（3752–3902）。約 **400 行**。

| done | 検証 |
|---|---|
| `extension.ts` ≤ 500 | `file-size-baseline.json` から **`extension.ts` のエントリを削除**して `npm test` 緑（honesty 検査が「baseline が実際より緩い」と言わない） |
| `dsl-completion-provider.spec.ts` / `output-code-action.spec.ts` 緑 | 上 2 本は `registeredCompletionProviders` 等を `tests/mocks/vscode.ts` から観測する。provider 登録の順序・回数が不変であること |

### 7.7 束 F — `mcp-server.ts`（§5）

新設: `mcp-sdk.ts` / `mcp-types.ts` / `mcp-docs.ts` / `mcp-tools-engine.ts` / `mcp-tools-editor.ts` / `mcp-tools-plugins.ts`。

| done | 検証 |
|---|---|
| 36 export 不変（型 25 は再輸出） | `public-surface.spec.ts` + `typecheck:e2e` + **`npm run build`**（`ZodTypeLike` の header が言う「build だけが落ちる」経路） |
| `registerTool` 25 回の**本文**が不変 | residual = 3 関数のシグネチャ + `buildServer` shell の呼び出し 3 行 + import / 再輸出 / doc **のみ** |
| ツール一覧が不変 | base と HEAD で `grep -A1 "registerTool($" … \| grep -oE "'[a-z_]+'" \| sort` が**同一**（25 本・順序も） |
| 条件付き登録（`if (savePluginState)` / `open_plugin_ui` / `register_mcp_server`）が同じ条件で行われる | `mcp-server.spec.ts` 緑（handlers を省いた時にツールが出ないことを既に検査している） |
| 引用 `538-1147` を散文と突き合わせて再アンカー | 手作業 1 件（§5.3） |

### 7.8 束のマージ単位

- **1 束 = 1 PR**（base = `887-extension-split` 統合ブランチ・draft）。束 PR は統合ブランチ → main。
- 🔴 **束 A は「振る舞いを変えない配線入れ替え」の性質を持つ唯一の束**（setter 化）。B 以降の純粋な移動と同じ統合ブランチでよいが、**A だけは residual の全行を main が読む**。
- stacked では**先端で検算する**（Rust 子 3 の教訓: 上流の枝で「無い」と言っても下流で現れる欠陥は見えない）。

---

## 8. 各束共通の検算（main が sandbox 外で回す・Codex の緑は根拠にしない）

### 8.1 residual（`move-residual.sh` が無いので生で叩く）

```bash
git -c color.diff.new=green -c color.diff.old=red \
    -c color.diff.newMoved=magenta -c color.diff.oldMoved=cyan \
    -c color.diff.newMovedAlternative=magenta -c color.diff.oldMovedAlternative=cyan \
    diff --color=always --color-moved=zebra --color-moved-ws=allow-indentation-change \
    <base>...HEAD -- packages/vscode-extension/src > "$TMPDIR/cm.txt"
printf 'moved-=%s moved+=%s residual-=%s residual+=%s\n' \
  "$(grep -cE $'^\e\\[36m-' "$TMPDIR/cm.txt")" "$(grep -cE $'^\e\\[35m\\+' "$TMPDIR/cm.txt")" \
  "$(grep -cE $'^\e\\[31m-' "$TMPDIR/cm.txt")" "$(grep -cE $'^\e\\[32m\\+' "$TMPDIR/cm.txt")"
grep -E $'^\e\\[3[12]m[-+]' "$TMPDIR/cm.txt" | sed -E $'s/\e\\[[0-9;]*m//g'   # residual の中身（PR 本文へ貼る）
```

- ゲート (i): `moved+ == moved−`。1 行差は空行の片寄せの false positive がありうる（Rust 第 3 束）。差があれば**削除行と追加行を多重集合で照合**し「削除されたが追加されていない行 = 0」を確認する
- ゲート (ii) **K = 5**（D9）: `--color-moved` の moved ブロックで **5 行未満のもの**は residual として列挙し読む。TS の import 行（1 行）や `export { x } from` は必ずここに入るので、期待される短いブロックは「import / export / setter 呼び出し」だけ

### 8.2 テスト不変

| 検査 | コマンド | 期待 |
|---|---|---|
| `tests/` を触っていない | `git diff --stat <base>...HEAD -- tests/` | **空**（束 0 だけ例外: surface spec の追加） |
| 件数 | `npm test 2>&1 \| grep -E 'Tests +[0-9]+ passed'` | 束 0 で測った値と**同一** |
| 27 + 36 の export | `npm run typecheck:e2e` + `public-surface.spec.ts` | 緑 |
| ラチェット | `npm test`（`git add` 後） | 緑・baseline の diff に `+` 行が**無い** |
| lint / build | `npm run lint` / `npm run build` | 緑（`import/order` は warn だが直す） |
| 引用 | `npm run docs:check` | 0 failed（`--fix` → relocate → 残りは手で・着地先を目視） |

### 8.3 実機（束の締めのみ）

`npm run test:e2e:gated` 全件 + `npm run test:e2e:cold-install`（`.vsix` の `activate()` が走ること — dev host は同梱物を見ていない）。小 PR では「その PR が足した E2E」が無いので回さない（足していない）。

---

## 9. 実装指示（Codex 向け）

### 9.1 進め方（各束共通）

1. **抽出範囲の開始は doc コメントの先頭、終端は次の item の doc コメントの直前**（Rust 第 4・5・7 束の分断事故と同型。TS でも JSDoc の分断は `prettier` しか捕まえない）
2. 新ファイルは `git add` してから `npm test`
3. import の追加は `import/order`（alphabetize せず・グループ間に空行）に合わせる。既存の import 順序は変えない
4. module doc（§14）: 本文は 1 行も書き換えていない旨 + **移動でない変更**（setter 呼び出し・局所定数化・関数シグネチャ）を**種類**で述べる。件数を書かない。名指しするなら実在を確かめる
5. PR 本文に §8.1 の residual 出力と §8.2 の表を貼る

### 9.2 やってはいけないこと

- ❌ `setup*Handler` を `engine-lifecycle.ts` へ、`resolveDaemonForUI` / `getEnginePath` を `engine-startup-runtime.ts` へ、`rescanPlugins` 系を `plugin-catalog-reader.ts` へ入れる（§4.2）
- ❌ 純モジュール（`playhead.ts` / `engine-view.ts` / `engine-lifecycle.ts` / `log-ring.ts` / `mcp-registration.ts`）に `import * as vscode` を足す
- ❌ `tests/` を 1 行でも触る（束 0 の surface spec 以外）。`__*ForTest` の名前・引数・本文を変える
- ❌ `__set*ForTest` と本番 setter を統合する（§3.2）
- ❌ 状態を `extension.ts` に残して子から `./extension` を import する（循環）
- ❌ `isTransportCommand` を消す・dead code を掃除する・`any` を直す・console.log を消す（移動でない）
- ❌ 新ファイルを 500 超で作ってから「次の束で割る」（C5）
- ❌ `activate` の `handlers: {…}` リテラル・`registerCommand` の並びを整える
- ❌ baseline の値を増やす / エントリを足す

### 9.3 各束の完了報告に含めるもの

residual の生出力・`moved+/-` の値・`npm test` の件数・`grep -cE '^let '` の値（束 A）・ツール一覧の diff（束 F）・新設ファイルのコード行（`countCodeLines`）。**「純粋な移動です」という言葉は根拠にならない。数字と出力だけを書く。**

---

## 10. 失敗モード = レビューで見るもの

| # | 失敗 | どこで捕まるか |
|---|---|---|
| F1 | 再輸出から 1 本抜ける | `public-surface.spec.ts`（tsc: TS2724 / vitest: undefined） |
| F2 | 値を `export type` で再輸出 | tsc: TS2693（値として使う行がある） |
| F3 | `setup*Handler` が `engine-lifecycle.ts` に入り spy に届かない | `extension-wiring.spec.ts` 958・1198 行のテストが赤 |
| F4 | setter 化で代入を 1 箇所取りこぼす（`x = v` が子モジュールに残る） | tsc: `Cannot assign to 'x' because it is an import`（**コンパイルエラー**・黙らない） |
| F5 | 子モジュールに `let` を新設して状態を二重化 | 束 A の done「`extension.ts` に `let` 0」+ レビュー: `grep -E '^let ' packages/vscode-extension/src/*.ts` が `extension-state.ts` 以外で増えていない |
| F6 | 循環 import で実行時 `undefined` | `public-surface.spec.ts`（値が undefined）+ §4.4 の向き検査 |
| F7 | `startEngine` の narrowing 崩れを `!` で潰す | レビュー: residual に `engineProcess!` が現れたら差し戻し（局所定数を使う・§4.5） |
| F8 | 新ファイルが 500 超 | ラチェット（`git add` 後） |
| F9 | 未追跡ファイルのまま `npm test` が緑 | ラチェット L-3（`listUntrackedMeasuredFiles`）が赤 |
| F10 | JSDoc を途中で分断して孤児コメントが残る | `prettier --check` / lint。**コンパイルは通る**ので residual の doc 行を読む |
| F11 | `buildServer` の切り出しで `docsSourceRoot` の計算位置がずれる | `mcp-server-docs-http.spec.ts`（`get_dev_doc` 経由で読める） |
| F12 | 条件付き登録の条件が落ちる | `mcp-server.spec.ts`（handlers 無しでツールが出ない検査） |
| F13 | 引用 294 箇所のうち別関数へ着地 | `docs:check` は先頭行しか見ない。relocate の着地先を目視（memory: `--fix` は別の関数へ着地しうる） |

---

## 11. 採らなかった案（設計全体）

| 案 | 理由 |
|---|---|
| **兄弟モジュールへ戻す**（issue / ブリーフの表どおり） | §2.3 / §4.1。mock 境界と純粋性の 2 つの理由で、戻せるものが実際には無い。「既存機構に沿う」の解釈を「既存の**命名と対応関係**に沿う」に置いた（`engine-view.ts` ↔ `engine-view-provider.ts`） |
| **ファイル数を減らすため大きめに束ねる**（例: `agent-handlers` に `run-selection` / `plugin-commands` を同居） | `agent-handlers` が 450 を超え、次の機能追加で必ず割ることになる。Rust 子 1 は 21 本に割って収まった |
| **`extension.ts` を 500 ではなく issue の受け入れ条件「1,000 以下」で止める** | #888 の閾値裁定（500）が issue の案（1,000）より後で、優先する |
| **束を 1 本（全部一度に）** | residual 合計は ~400 で収まるが、**A（setter 化）と B〜E（純粋な移動）を混ぜると A の検算（residual の全行を読む）が B〜E の移動に埋もれる**。§5.1 の「検算の機会で切る」 |
| **`mcp-server.ts` を後回し（#888 子 5）** | issue #887 は対象外としていたが、ブリーフで対象に入った。同じ道具（surface spec・relocate）で済むので同じ統合ブランチで続ける |

---

## 12. 確信度と反証可能性

| 主張 | 確信度 | 反証する方法 |
|---|---|---|
| 代入は 31 箇所で、読みは live binding で足りる（D1） | **高** | `grep -nE '^\s*(engineProcess\|outputChannel\|…12 本) (=\|\+=)' extension.ts` の件数が 31 でなければ誤り。setter 化の後に tsc が `Cannot assign` 以外の理由で落ちれば設計の穴 |
| `setup*Handler` を `engine-lifecycle.ts` に入れると spy が届かない（D3） | **高** | 試しに `setupExitHandler` を `engine-lifecycle.ts` に移して `npm test` を回す。`extension-wiring.spec.ts` の 958 行付近が緑のままなら本書が誤り |
| `vi.resetModules` + leaf state で `engine-command-awaits` が通る（§3.4） | 中〜高 | 束 A で当該 spec が赤になれば誤り。原因候補は `vi.mock('engine-startup-runtime')` の巻き上げと state の import 順 |
| tsc の 1 ファイルで TS2724 / TS2693 が出る（D6） | **高（実測済み）** | `.probe-887/` で再現した。`include` に足して `npm run typecheck:e2e` が緑にならなければ、`tests/vscode-extension` の spec 固有の設定（globals 等）が原因 |
| 新設ファイルの見込みサイズ（§4.3） | 中 | import と module doc で各 +10〜40。`engine-process.ts` が 500 を超えたら `send*Meta` 4 本 + `writeCodeToEngine`（123）を `engine-stdin.ts` へ分ける（予備の切り口） |
| `registerTool` の行が byte 一致で moved になる（§5.2） | 中〜高 | 束 F の residual に `registerTool` 本文の行が出れば、インデント深さが変わっている。`--color-moved-ws=allow-indentation-change` を付けているので深さの変化は許容されるはずだが、それでも出るなら prettier が折り返しを変えている |
| K = 5 で TS の「1 文の移動」を捕まえられる（D9） | 中 | 束 A で `setX(v)` の 1 行が moved と判定されたら K を上げる。逆に import 行が大量に residual に出て読めないなら K を下げる |
| 引用の追随に relocate で足りる | 中 | Rust 子 2 では 68 件中 2 件が手作業。TS も同程度（数件）は残ると見る。`538-1147` は確実に手作業 |

---

## 13. owner / main に問うこと（着手は待たない）

1. `sites/dev/scripts/relocate-citations.mjs` をリポジトリへ入れる（束 0）ことに異論はあるか。無ければ `docs:check` の README に 1 行足す
2. `tests/vscode-extension/**` 全体を `tsconfig.tests.json` に入れるかは**別 issue**として立てるか（本書は surface spec 1 本だけを入れる）
3. `isTransportCommand`（未参照）を分割完了後の 1 行コミットで消してよいか（D10）
4. `module-doc-purity.spec.ts` の「件数の主張を書かない」検査を `packages/vscode-extension/src/*.ts` にも広げるか（Rust 限定のまま運用で守るか）

---

## 付録 A — 本書の数値を再現するコマンド

```bash
# コード行（範囲ごと）: scratchpad の count-regions.ts（countCodeLines を範囲に当てるだけ）
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","esModuleInterop":true}' \
  npx ts-node --transpile-only <scratchpad>/count-regions.ts packages/vscode-extension/src/extension.ts 1-3902 292-488 …
# 状態変数ごとの参照行
for v in engineProcess outputChannel …; do echo "$v: $(grep -nw $v packages/vscode-extension/src/extension.ts | cut -d: -f1 | tr '\n' ' ')"; done
# export と消費者
for n in $(grep -oE '^export (async )?(function|class|const|type|interface) [A-Za-z_]+' packages/vscode-extension/src/extension.ts | awk '{print $NF}'); do
  echo "$n <- $(grep -rlw $n tests packages --include='*.ts' | grep -v src/extension.ts | tr '\n' ' ')"; done
# vi.mock の対象
grep -rnE "vi\.(mock|doMock)\(" tests/vscode-extension tests/helpers
# 引用
grep -rho 'src/extension.ts:[0-9]*-[0-9]*' sites/dev --include='*.md' | wc -l   # 248
```
