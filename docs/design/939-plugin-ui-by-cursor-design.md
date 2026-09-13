# #939 — カーソル位置で個別のプラグイン UI を開く（右クリック）設計

> **Status**: 起案（2026-09-13・Fable）。owner が確定させた 3 点（方式は右クリック / 目的は「同名が複数あっても個別に開ける」/ E2E は「正しい方を開いた」を区別できる）は
> [#939](https://github.com/signalcompose/orbitscore/issues/939) が正本で、本書はそれを実装可能な形に落とすもの。**再議論しない。**
> **位置づけ**: #474 の後継（§2.6）。仕様 SC.10.10 規範 (2) の改訂（Cmd+Click → 右クリック・§2.5）を伴う。
> **関連**: [`../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`](../specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md) UIH.5 / [`../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](../specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10.10 / [`../specs-v2/PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md`](../specs-v2/PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md) P5。
> **検証手段の決め方**: CLAUDE.md「テストの積み上げ規律」の**現行版**に従う（型で潰す → 機能テスト → E2E が本体。変異検証は最後の手段・§5.4 の 1 件のみ）。

---

## 0b. main のレビュー（工程②・2026-09-13）

起案 = Fable subagent / レビュー = main。**独立第二意見として main が一次ソースで検算した結果**。

### 裏が取れた主張

| 主張 | 検算 |
|---|---|
| `Gain(...)` も offset を消費する | ✅ `global.ts:857-863` の `forEach((slot, offset) => { if (isStandardElement(slot)) return; ... })` |
| 🔴 **その規則が UI 経路でも成り立つ** | ✅ **main が閉じた穴**。起案は state 経路（`pluginStateTargets`）から導いていたが、`openPluginUi` も `resolvePluginStateEntry` を呼ぶので **index 空間は共有**。規則は有効 |
| `normalizePluginInstanceName` の内容 | ✅ `effect-slot.ts:971-977` と逐語一致 |
| モックの `executeCommand` がスタブ | ✅ `tests/mocks/vscode.ts:232` `executeCommand: async () => undefined` |
| `agent-handlers.ts` が 500 行に近い | ✅ 総行 518・`file-size-baseline.json` に未載（= コード行は 500 未満）。助言は妥当 |
| VS Code の `contextmenu.ts` の引用 | ✅ **main が `raw.githubusercontent.com` から取得して逐語一致を確認**（捏造ではない） |
| `set_selection` / `get_editor_state` の base | ✅ **どちらも 1-based**（`mcp-tools-editor.ts:37-51`, `:113-117`）。§5.3 の `開始列 + 2` も正しい |
| 既存フィクスチャに `output()` / `audio()` が要らない | ✅ `#633 E2E-1`（`:2432-2437`）が `effect()` だけでプラグインをロードしている |

### main が変更を入れた 3 点

1. **E2E のフィクスチャを `[clap, vst3, clap]` → `[clap, Gain(db: -6), clap]`**（§5.3）。
   旧案では **§8 の筆頭トラップ（M2）が緑のまま通る**
2. **変異を M1 の 1 件 → M1 + M2 の 2 件**（§5.4）
3. **手動ゲートに実 VST3 の右クリックを追加**（§5.5）。owner の指摘「VST を試さないで大丈夫？」に対し、
   混在チェーンの index 演算は `#633 E2E-2` が既に実証済みだが、**VST3 の UI が開くことは
   自動化できない**（フィクスチャの `createView` が null）ので、手動ゲートが唯一の層

あわせて **正規化コーパスにパス形を必須化**（§2.2）— 拡張子を落とす分岐は素のカタログ名では発火しない。

### 規模の見積もり（main・前例の実測から）

**約 900〜1,300 変更行**（起案の見込み 700 行は楽観的）。根拠は `#652` のエディタ側の切片 —
`plugin-name-diagnostics.ts` を**新規作成**して 324 行 + その spec 248 行 + 配線 102 行 = **674 行**。
本件はそのスキャナを**拡張**する側だが、解決器・コマンド・MCP・E2E・仕様改訂が乗る。
**半分近くがテスト**（ユニット 300–420 + E2E 90–130）。

**1 PR で通す**（owner 裁定 2026-09-13）。束 1「スキャナ + 解決器 + ユニット」/ 束 2「表面 + E2E」に
割る案は、**束 1 が単独では何も検算できない**（消費者のいない層になる）ので採らない。
1,500 行を超えそうになった時点で E2E と仕様改訂を後続へ切り出す。

---

## 0. 一次ソースで確かめた事実（設計はここに立つ）

| # | 事実 | 出典 | 確度 |
|---|---|---|---|
| F1 | **右クリックはカーソルを動かす** — ただし**クリック位置が既存の選択範囲の中にある時だけ動かさない**。対象は `CONTENT_TEXT` / `CONTENT_EMPTY` / `TEXTAREA` | VS Code `src/vs/editor/contrib/contextmenu/browser/contextmenu.ts` `_onContextMenu`（2026-09-13 に main ブランチを取得・§3 に逐語引用） | 高（一次ソース）。**実機での反証手順は §3** |
| F2 | engine の chain index は**標準プラグイン（`Gain(...)`）も 1 つ分消費する**。`append` は `isStandardElement` を skip するが `offset` は進む。したがって `effect(["A", Gain(db: -6), "B"])` の B は **index 3** | `packages/engine/src/core/global.ts:857-863` / `:925-946`（`pluginEntriesForReceiver` も `offset + 1`） | 高 |
| F3 | 同名 2 つのラック `uiRackSeq.effect([name, name])` は**既に実機 E2E で通っている**（#633 E2E-1）。gated spec `:1618` の「one-effect-per-receiver limits」コメントは #628 以前の残骸で、現行の制約ではない | `tests/e2e/orbitstudio-mcp-gated.spec.ts:2436-2470` | 高（3 つ目を足す分は §5.3 の E2E そのものが検算） |
| F4 | `expectedName` の照合は `expectedName.normalize('NFC') === resolved.identity.normalizedName`。`normalizedName` は `normalizePluginInstanceName(spec)` = trim → NFC → `\`→`/` → basename → 既知拡張子（`.clap` / `.vst3` / `.component`）を落とす | `global.ts:1239-1248` / `packages/engine/src/core/global/effect-slot.ts:971-977` | 高 |
| F5 | `var drums = mix.sum` は `Global.sum('drums')` を通る（変数名がそのままバス名）。receiver 表記は `sum:drums` | `packages/engine/src/signal-chain/runtime.ts:288-294` / UIH.5 receiver 名前空間 | 高 |
| F6 | `layer` は v1 で loud エラー（`layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only`） | `effect-slot.ts:138-147` | 高 |
| F7 | `editor/context` から起動されたコマンドは**クリック位置を受け取らない**（渡るのは「関連リソース」= document URI）。カーソルは `vscode.window.activeTextEditor.selection.active` から読む | Context7 `/websites/code_visualstudio_api` contributes.menus | 中（公式記述は「関連リソース」までで、位置が来ないことは Monaco の `MenuItemAction.run` が `_options.arg` / 転送引数しか積まないことから） |
| F8 | MCP `open_plugin_ui` の `chain_path` は `length(1)`。`[n]` → `index n + 1`。**index への潰しは `resolveMcpPluginUiIndex` の 1 箇所** | `packages/vscode-extension/src/mcp-sdk.ts:80-110` / `mcp-tools-plugins.ts:72-84` | 高 |
| F9 | `editor/context` に `orbitscore` グループが既にあり `orbitscore.rescanPlugins` が `when: resourceExtname == .orbs` で入っている。UI を開くコマンドは無い（15 個） | `packages/vscode-extension/package.json` `contributes.menus` / `contributes.commands` | 高 |
| F10 | `tools/list` は**登録順がそのまま順序**で、テストがピン留めしている。条件付き登録の 4 本（`save_plugin_state` / `open_plugin_ui` / `close_plugin_ui` / `register_mcp_server`）はスタブでは現れない | `tests/vscode-extension/mcp-server.spec.ts:411-449`（順序）/ `:453`（件数） | 高 |
| F11 | 既存スキャナ `findCatalogSpecSites` は**フレームスタックで role を運ぶが、`[` / `]` / `,` を追跡しない**。チェーン内の位置と receiver は持っていない | `packages/vscode-extension/src/plugin-name-diagnostics.ts:163-232` | 高 |
| F12 | 既存テストは site の**射影**（`map`）や `objectContaining` で判定しており、`CatalogSpecSite` にフィールドを**足しても壊れない** | `tests/vscode-extension/plugin-name-diagnostics.spec.ts:80-116` | 高 |
| F13 | 500 行ラチェットの baseline に `packages/vscode-extension/` のファイルは**1 つも無い**（= 全部 500 コード行以下）。`agent-handlers.ts` は総行 518 で最も閾値に近い | `tests/repo/file-size-baseline.json` / `wc -l` | 高 |
| F14 | このセッションの computer-use MCP は **IDE を "click" tier** で許可する（左クリックのみ・**右クリック不可**）。Claude の computer-use から VS Code を右クリックすることは**できない** | セッションの MCP server instructions（computer-use） | 高（環境依存・§5.5） |
| F15 | `get_editor_state` は `cursor: {line, character}`（1-based）を返す | `packages/vscode-extension/src/agent-handlers.ts:353-375` | 高 |

---

## 1. 🔴 完了条件（何を満たせば done か・何を検証すれば正しいと言えるか）

すべて満たして done。「通るテスト」ではなく、条件ごとに検証手段を固定する。

| # | 条件 | 検証手段（層） |
|---|---|---|
| D1 | `.orbs` を右クリックすると `OrbitScore: Open Plugin UI` が `orbitscore` グループに出る。`.orbs` 以外では出ない | `package.json` ユニット（§5.1 T3）+ 手動ゲート §5.5 |
| D2 | **同名が 3 つ**あるラックで、カーソルを **3 つ目**に置いて実行すると **3 つ目だけ**が開く。`close_plugin_ui(receiver, index: 3)` が成功し、`index: 1` の close は失敗する | 実機 gated E2E（§5.3）。**「開いた」だけでは不可** |
| D3 | 解決器は **パス**（`chainPath: number[]`）を返し、index への潰しは 1 箇所（§2.2）。`layer` の入れ子はパス長 > 1 になり、v1 では engine と同じ文言で loud に落ちる | 純関数ユニット（§5.1 T1）+ 型（`chainPath` は `readonly number[]`・index を持たない） |
| D4 | 解決できない位置は**すべて loud**（§2.3 の表の全行）。黙って no-op しない | vscode モック配線テスト（§5.1 T2）— 各行に 1 ケース |
| D5 | MCP `open_plugin_ui_at_cursor` は**メニュー項目と同じコマンド id を `executeCommand` で起動**し、同じ結果オブジェクトを返す（§2.4） | 配線テスト（`executeCommand` が `orbitscore.openPluginUiAtCursor` を 1 回呼ぶ）+ E2E §5.3 |
| D6 | `tests/vscode-extension/plugin-name-diagnostics.spec.ts` の合意テストが**無変更で**緑 | `npm test`（そのファイルに差分が無いことを PR で確認） |
| D7 | 仕様 SC.10.10 規範 (2) と core spec PH.2c の「Cmd+Click」が改訂され、`grep -rn "Cmd+Click" docs/` の残存が §2.5 の列挙と一致する | grep の実出力を PR に貼る |
| D8 | #474 本文が畳まれ、#939 の PR に `Closes #474` が入る | PR 本文 |
| D9 | 右クリックが**クリック位置**を開くこと（前のカーソル位置ではない） | **手動ゲート 1 本**（§5.5・F14 により自動化しない）。手順と結果を PR に記録 |
| D10 | `tools/list` の順序ピン（F10）が壊れない・件数テストが更新される | `mcp-server.spec.ts` |

---

## 2. 決定 6 項目

### 2.1 コマンド名・メニューのラベル・`when` 句

| 項目 | 決定 | 理由 |
|---|---|---|
| command id | `orbitscore.openPluginUiAtCursor` | 既存の `orbitscore.<camelCase>` に揃える。「AtCursor」を id に含めるのは、MCP ツール名 `open_plugin_ui_at_cursor` と **1:1 で対応させる**ため（§2.4） |
| title（= メニューのラベル） | `OrbitScore: Open Plugin UI` / `category: "OrbitScore"` / `icon: "$(window)"` | 隣の `OrbitScore: Rescan Plugin Catalog` と同じ接頭辞。「at cursor」はラベルに出さない — 右クリックした場所が対象なのは UI 上自明で、ラベルに書くと「別の Open がある」ように読める |
| `editor/context` | `{ "command": "orbitscore.openPluginUiAtCursor", "when": "resourceExtname == .orbs", "group": "orbitscore" }` | 隣の項目と**同じ述語**にする（グループ内で述語を 2 種類にしない）。`.orbs` 以外では出ない |
| `commandPalette` | 隠さない | パレットからでもカーソル位置で動く。隠す理由が無い |
| メニュー内の順序 | 指定しない | `orbitscore` グループ内の並びは VS Code 任せ。ユニットテストは id / when / group だけをピンする（順序をピンすると VS Code 側の並び規則に依存する） |

**`editorLangId == orbitscore` を採らない理由**: untitled（拡張子なし）の文書でも出せる利点はあるが、隣の項目が `resourceExtname` で、グループ内の述語を揃える方が「.orbs 以外で出ない」の検算（T3）を 1 種類にできる。ハンドラ側では `runSelection` と同じく `languageId !== 'orbitscore'` を loud に弾く（`run-selection.ts:43-47` の型）。

### 2.2 解決器の署名と返す形 — **パスを返し、index への潰しは 1 箇所**

**置き場所**: `packages/vscode-extension/src/plugin-name-diagnostics.ts` の既存スキャナを**拡張**する（別スキャナを立てない・DRY）。`CatalogSpecSite` に 2 フィールドを足す（F12 により既存テストは壊れない）:

```ts
export interface CatalogSpecSite {
  readonly spec: string
  readonly role: CatalogSpecRole
  readonly line: number
  readonly startCol: number
  readonly endCol: number
  /** #939: UIH.5 の receiver 表記（`drums` / `master` / `sum:drums` / `aux:verb`）。同一行で決められなければ undefined。 */
  readonly receiver: string | undefined
  /** #939: 囲む `effect(` / `instrument(` の引数内での要素パス。直列チェーンなら長さ 1。`layer` の入れ子で伸びる。 */
  readonly chainPath: readonly number[]
}
```

**解決器**（新規モジュール `packages/vscode-extension/src/plugin-ui-at-cursor.ts`・純関数）:

```ts
export type PluginUiCursorTarget =
  | { readonly kind: 'instrument'; readonly receiver: string; readonly expectedName: string; readonly site: CatalogSpecSite }
  | { readonly kind: 'effect'; readonly receiver: string; readonly chainPath: readonly number[]; readonly expectedName: string; readonly site: CatalogSpecSite }

export type PluginUiCursorResolution =
  | { readonly ok: true; readonly target: PluginUiCursorTarget }
  | { readonly ok: false; readonly reason: PluginUiCursorFailure; readonly message: string }

export type PluginUiCursorFailure =
  | 'not-on-plugin-name'      // カタログ名リテラルの上に無い
  | 'standard-plugin'         // `Gain(` のような大文字始まりの呼び出し語の上（SC.10.8 規範 5）
  | 'state-file'              // `instrument("x", "tone.vstpreset")` の第 2 引数
  | 'selection-spans-outside' // 選択が 1 つのリテラルに収まっていない（§3 の F1 但し書き）
  | 'unresolved-receiver'     // `.effect(` の左が同一行で決まらない

/** 0-based の vscode.Position をそのまま受ける。選択があれば active 側を使う。 */
export function resolvePluginUiTargetAtCursor(
  text: string,
  selection: { readonly active: { line: number; character: number }; readonly anchor: { line: number; character: number } },
): PluginUiCursorResolution
```

**index への潰し（唯一の場所）** — 同じモジュールに置き、コマンドと MCP ツールの両方がここを通る:

```ts
export function pluginUiAddressFor(target: PluginUiCursorTarget):
  | { ok: true; receiver: string; index: number; expectedName: string }
  | { ok: false; message: string } {
  if (target.kind === 'instrument') return { ok: true, receiver, index: 0, expectedName }
  if (target.chainPath.length !== 1)
    return { ok: false, message: 'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only' }
  return { ok: true, receiver, index: target.chainPath[0] + 1, expectedName }
}
```

`layer` が来た時に変えるのは **この関数と `resolveMcpPluginUiIndex`（F8）の 2 箇所だけ**。解決器・E2E・配線は触らない。これが「index に潰さずパスを返す」理由である。

**チェーン内位置の数え方**（F2 と一致させる・スキャナに足す状態）:

- `effect(` / `instrument(` フレームを開いた時、そのフレームに **要素カウンタのスタック `[0]`** を持たせる
- フレーム直下（丸括弧の深さがフレームと同じ）で `[` → カウンタを push（新しいチェーン階層）、`]` → pop、`,` → 先頭カウンタを +1
- **`,` を数えるのは「そのフレームの直下」だけ**。`plugin("A", enabled: false)` や `Gain(db: -6, label: "x")` の中の `,` は丸括弧が 1 段深いので数えない
- 文字列リテラルを site として push する時、`chainPath` = その時点のカウンタスタックの**コピー**（`effect("A")` は `[0]`・`effect(["A", Gain(db:-6), "B"])` の B は `[2]`・`layer([[...],["X"]])` の X は `[k, 1, 0]`）
- `Gain(...)` は要素として**数える**（F2: engine は標準プラグインも offset を消費する）。ここを「カタログ名だけ数える」に書くと **index が 1 つずれて別のプラグインを開く**（`expectedName` が同名なら止まらない）。§8 の筆頭

**receiver の決め方**（`effect(` / `instrument(` を開いた瞬間、その行の左側を見る）:

| 左側のテキスト（末尾） | receiver |
|---|---|
| `<ident>.` | `<ident>` — ただし文書内に `var <ident> = <x>.sum` / `.aux`（SC.2.1 の派生宣言・F5）があれば `sum:<ident>` / `aux:<ident>` |
| `global.` | `master`（SC.2.1 規範 (4): master のラックは `global.effect([...])` が指す） |
| `sum("x").` / `global.sum("x").` | `sum:x`（`aux` も同様） |
| 上のどれでもない（複数行に割れたチェーン等） | `undefined` → 解決器が `unresolved-receiver` |

**import 越しの宣言は追わない**（v1）。`import { drums } from "./mixer.orbs"` の `drums` は sequence として送られ、engine が `Unknown sequence 'drums'; a same-named mixer bus exists. Use 'sum:drums' ...`（`global.ts:929-936`）を返す。これは**黙らない**ので受け入れる（§2.3）。

**`expectedName` の作り方**: F4 を拡張側でミラーする `normalizePluginInstanceNameForGuard(spec)`（trim → NFC → `\`→`/` → basename → `.clap/.vst3/.component` を落とす）。`plugin-name-diagnostics.ts` は既に engine の `plugin-resolver.ts` をミラーしている module なので、そこに置く（合意テストの同じ考え方: **engine の `normalizePluginInstanceName` と同一コーパスで一致を固定する**ユニットを 1 本足す。T1 に含める）。

🔴 **コーパスには必ずパス形を入れる**（main のレビュー 2026-09-13）。拡張子を落とす分岐は
**パス形の指定でしか発火しない** — 素のカタログ名（`"ValhallaRoom"`）では `path.extname` が空なので
その行を一度も通らない。最低限これを含めること:

| 入力 | 期待 |
|---|---|
| `"ValhallaRoom"` | `ValhallaRoom`（拡張子分岐を通らない基準） |
| `"~/Library/Audio/Plug-Ins/VST3/GainOracle.vst3"` | `GainOracle`（**`.vst3` を落とす**） |
| `"./plugins/CLAPTestEffect.clap"` | `CLAPTestEffect`（**`.clap` を落とす**） |
| `"/abs/path/Some.component"` | `Some`（**`.component` を落とす**） |
| 大文字小文字が混ざった拡張子（`.VST3`） | engine は `toLowerCase()` してから判定する（F4）ので同じ結果 |

ここがずれると**正当な open が全部 `expected normalized name ... but the current slot is ...` で落ちる**
（`global.ts` の UI 実装冒頭のガード）。

### 2.3 解決できない位置の倒し方 — **すべて loud・同じ結果オブジェクト**

コマンドは `PluginUiAtCursorResult` を**返り値として返し**、失敗は `vscode.window.showErrorMessage('OrbitScore: ' + message)` + output channel `❌` の**両方**に出す（`plugin-commands.ts:129-132` の `rescanPlugins` と同じ型）。MCP ツールは同じオブジェクトを `errorResult(message)` で返す（§2.4）。**人間と LLM で文言を分けない**。

| 状況 | 判定する層 | 文言（先頭に `OrbitScore: `） |
|---|---|---|
| アクティブエディタ無し / `languageId !== 'orbitscore'` | コマンド | `Open an OrbitScore (.orbs) file and place the cursor on a plugin name.` |
| カーソルがカタログ名リテラルの上に無い | 解決器 `not-on-plugin-name` | `The cursor is not on a plugin name. Place it on a "name" inside effect([...]) or instrument(...).` |
| `Gain(` 等の標準プラグイン語の上 | 解決器 `standard-plugin` | `Standard plugins (Gain, ...) have no UI; their parameters live in the score (SC.10.8).` |
| `instrument("x", "tone.vstpreset")` の第 2 引数 | 解決器 `state-file` | `"tone.vstpreset" is a saved state file, not a plugin. Place the cursor on the plugin name.` |
| 選択が 1 つのリテラルからはみ出す | 解決器 `selection-spans-outside` | `Collapse the selection to a cursor on one plugin name.` |
| receiver が同一行で決まらない | 解決器 `unresolved-receiver` | `Could not tell which sequence or bus this chain belongs to; keep receiver.effect([...]) on one line.` |
| `layer` の入れ子（パス長 > 1） | `pluginUiAddressFor` | engine と同じ文言（F6） |
| engine 未起動 | `pluginUiForAgent`（既存ガード） | 既存文言 `engine is not running — start the engine first` |
| 未評価 / 一致 0 / チェーンが楽譜とずれている | **engine**（既存）: `Unknown sequence ...` / `Plugin chain index N is invalid ... Valid indices: ...` / `expected normalized name ... re-evaluate first` | engine の文言をそのまま。`Valid indices` が自己修正の材料（UIH.5 規則 3） |
| 既に開いている | engine（MCP 経路は冪等にしない・UIH.5.1 確定 2） | engine の文言をそのまま。右クリックは「開け」という明示操作なので MCP と同じ扱い（DSL の冪等化は再評価が常態だから。右クリックは常態ではない） |

「未評価」を**エディタ側で先読みしない**（474 設計 P5 の決定を維持: グレーアウトのための状態同期は作らない）。engine の loud エラーが答えになる。

### 2.4 `open_plugin_ui_at_cursor` — **足す。中身は `executeCommand('orbitscore.openPluginUiAtCursor')`**

| 項目 | 決定 |
|---|---|
| 是非 | **足す** |
| inputSchema | **引数なし** |
| 実装 | ハンドラ `openPluginUiAtCursor()` は `vscode.commands.executeCommand<PluginUiAtCursorResult>('orbitscore.openPluginUiAtCursor')` を呼ぶだけ。**関数を直接呼ばない** |
| 成功時の返り値 | `{ receiver, index, chain_path, normalizedName, site: { line, startCol, endCol }（1-based に直す）, ...engine の result }` |
| 失敗時 | `errorResult(message)`（message は人間に出したものと同一） |
| 登録位置 | `registerPluginTools` の `close_plugin_ui` の直後。**`openPluginUi && closePluginUi && openPluginUiAtCursor` が揃った時だけ**登録（既存の条件付き登録と同じ型）。F10 の無条件 21 本のピンは**動かない**。件数テスト（`:453`）は +1 |

**なぜ `executeCommand` か**: `editor/context` の項目が押された時に VS Code がやることは `commandService.executeCommand(item.command.id)` である（Context7 で読んだ `MenuItemAction.run`）。MCP ツールも同じ id を `executeCommand` で起動すれば、**メニュー項目と MCP の経路の差は「クリック」だけ**になる。関数を直接呼ぶ形だと「コマンド登録の配線」が E2E の視野から外れる（#614 / #528 の型）。

**なぜ汎用の「コマンド実行」ツールではないか**: 汎用ツールはテスト用の裏口であり、LLM が任意のコマンドを叩ける面を作る。`open_plugin_ui_at_cursor` は「利用者がいま指している 1 つを開く」という**それ自体が意味を持つ操作**で、LLM にとっても `get_editor_state` → `open_plugin_ui_at_cursor` が自然な動線になる。

**副作用の扱い**: MCP 経由でも `showErrorMessage` のトーストは出る（コマンドが出す）。これは意図した振る舞い — LLM の操作が失敗したことを人間が同じ場所で見る。成功時のトーストは出さない（開いた窓が結果そのもの）。

**`close_plugin_ui_at_cursor` は v1 では作らない**。人間は窓を閉じる（safepoint は close 経路で発火する・UIH.2a）。LLM は `close_plugin_ui(receiver, chain_path)` を持っている。474 設計 P5 の「Close Plugin UI」項目は本 issue の範囲外（#939 本文「本命 = Open UI のみ」）。

### 2.5 仕様改訂の文面

**`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.10.10 規範 (2)** — 現行:

> (2) **プラグイン UI は、楽譜上のプラグイン名を Cmd+Click して開く**のを主経路とする。エディタが構文木の位置からパスを解決するため、**DSL に index やパスを露出させない**（PH.2c の `ui([index])` の **index 形は撤回**する）。

改訂後:

> (2) **プラグイン UI は、楽譜上のプラグイン名を右クリックし、コンテキストメニューの `OrbitScore: Open Plugin UI` で開く**のを主経路とする（#939・2026-09-13 改訂。旧: Cmd+Click）。エディタがカーソル位置から構文木上の位置（receiver とチェーン内のパス）を解決するため、**DSL に index やパスを露出させない**（PH.2c の `ui([index])` の **index 形は撤回**する）。**同名のプラグインが複数挿さっていても、カーソルが乗っている 1 つだけを開く** — `ui("名前")`（SC.10.10.1）が一致を全部開くのと対になる経路である。

**直後の解説ブロック** — 現行「**なぜ Cmd+Click か**」を「**なぜ右クリックか（Cmd+Click から改訂・#939）**」にし、末尾に 1 段落足す:

> Cmd+Click を主経路としない理由: VS Code で Cmd+Click を実装する手段は `DefinitionProvider` か `DocumentLinkProvider` だが、前者は **Cmd+ホバーの peek でも発火**し（名前を見ただけで窓が開く）、後者の `command:` URI target は**公式 API に記載が無い**。`editor/context` は既存で、`.orbs` 限定のグループも切ってある。

**`:428`「LLM は Cmd+Click できない」** → 「LLM は右クリックできない」に置換（意味は不変）。

**`docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1452-1456`**（PH.2c）:

> - **主経路は右クリック**（SC.10.10 規範 2・#939）: 楽譜上のプラグイン名を右クリック → `OrbitScore: Open Plugin UI` で当該インスタンスの UI が開く。エディタがカーソル位置から receiver とチェーン内のパスを解決するので、**書き手が数えなくてよい**。**同名が複数あってもカーソルの 1 つだけ**を開く（`ui("名前")` は全部開く）。DSL の `ui()` を残すのは、**LLM が DSL 経路で駆動できる**ようにするため。
>   - MCP からは `open_plugin_ui_at_cursor`（引数なし）が同じコマンドを起動する。

「🔴 現在地（2026-08-28）: Cmd+Click は #633 で実装する」の 2 行は**削除**（#633 は実装せず、#939 が置き換えた）。

**残存の列挙（D7 の対象）**: `SIGNAL_CHAIN_DSL_SPEC_v1.md:399, 403, 428` / `INSTRUCTION_ORBITSCORE_DSL.md:1452-1456`。`PLUGIN_UI_HOSTING_SPEC_v1.md:528, 553` は既に「右クリック」で無変更。`PLUGIN_UI_IMPLEMENTATION_DESIGN_474.md` P5 は経緯文書なので本文は変えず、冒頭に「実装は `docs/design/939-plugin-ui-by-cursor-design.md`」の 1 行を足す。

### 2.6 #474 の扱い

1. **#474 本文の先頭に「状態」ブロックを足す**（本文の下は残す・履歴として）:
   - 論点 1（GUI ホスティングの所有者）→ #474 P1–P4c で解決（child が開く・daemon 経由 `OpenPluginUI`）
   - 論点 3（ライフサイクル）→ UIH.6 / #617・#619 で解決
   - 論点 4（macOS runloop）→ #474 P3 で解決（`objc2-app-kit`）
   - 論点 2（ロード済みの事前検知）→ **意図的にやらない**（474 設計 P5・§2.3 の最終行）
   - メニュー候補（Close / Bypass / Reveal / Reload / Show info）→ **作らない**（474 設計 §8 Q4 の裁定）
   - 右クリック経路の実装 → **#939 へ引き継ぎ**
2. #939 の PR 本文に `Closes #939` と **`Closes #474`** の両方を書く。同じマージで両方閉じる（#474 だけ先に閉じると、PR がマージされる前に「後継が無い closed issue」になる時間ができる）。

---

## 3. 🔴 最初に潰す不確実性 — 右クリックはカーソルを動かすか

> ### ✅ 実機の結果（main + owner・2026-09-14）— **F1 は真**
>
> `set_selection(1,1)` でカーソルを 1 行目に置き、**エディタにフォーカスがある状態で**
> 6 行目の 3 つ目のプラグイン名を右クリック → Esc:
>
> ```
> cursor = line 6, char 64     ← 3 つ目のリテラル（53-71 列）の中
> ```
>
> **右クリック単体でカーソルがクリック位置へ動く。** `contextmenu.ts` の `setPosition` の
> 読みどおりで、**§3.2 の代案（ホバー）は発動しない**。メニュー 1 段で完結する。
>
> 🔴 **main の交絡（訂正）**: 最初の計測は「動かなかった」と出て、main は **F1 を偽と 2 回断定し
> 設計にもそう書いた**。原因は**エディタが非フォーカスだった**こと — 非フォーカスのウィンドウへの
> 最初のクリックは**前面化に消費され**、カーソルが動かない。**条件を揃えずに測って前提を
> 覆しかけた**。→ [[measure-with-focus-before-declaring-a-ui-premise-false]]
>
> ### 手動ゲートの実測（2026-09-14・§5.5 の全項目）
>
> | 確認 | 結果 |
> |---|---|
> | メニュー項目が実在してコマンドを起動する | ✅ |
> | **右クリック単体**（左クリック不要） | ✅ |
> | effect・同名 2 つ + `Gain` → 3 つ目で **index 3** | ✅ |
> | effect・実 VST3（`ValhallaVintageVerb`） | ✅ |
> | **instrument・実 VST3**（`Kontakt 8` = `kit:0`） | ✅ |
>
> 🔴 **main のもう 1 つの事故**: 最初の手動ゲートは**変異 M1 を当てたままの `dist/` で走っていた**。
> gated 実行後にソースは復元したが **`npm run build` を回さずに dev host を起動**したため、
> dev host（`--extensionDevelopmentPath` は `dist/` を読む）が変異版を動かしていた。
> 「3 つ目を指しても index 1」「窓が開かない」はすべてこれで説明がつき、**実装は正しかった**。
> → [[ts-mutations-need-a-rebuild-before-real-machine]]

## 3.1 実機での確認手順（実装前・所要 1 分・**現行ビルドで可能**）

1. gated 手順どおり dev host を起動し、`.orbs` を開く
2. `set_selection(start_line: 1, start_char: 1)` でカーソルを 1 行目先頭に置く
3. **手で** 3 行目の途中を右クリックし、Esc でメニューを閉じる
4. `get_editor_state` の `cursor` が**3 行目のクリック位置**になっていれば F1 は真（1 行目のままなら偽）
5. 追加: 3 行目の単語をダブルクリックで選択 → その選択内を右クリック → Esc → `selection` が保たれていれば但し書きも真

この結果（真 / 偽）を **PR 本文に日付つきで記録する**。

### 3.2 倒れた場合の代案（F1 が偽だった時）

**ホバーの command リンク**へ寄せる: `HoverProvider` が site を知っているので、`MarkdownString`（`isTrusted: true`）に `command:orbitscore.openPluginUiAtCursor?{"line":L,"character":C}` を埋め、コマンドは引数の位置を優先する（§3 の「任意引数」がここで効く）。command URI + 引数は公式サポート（ブリーフ記載・Context7 で確認済み）。解決器・配線・E2E・MCP ツールは**無変更**で、変わるのは表面（メニュー → ホバー）と仕様文面だけ。左クリック前提（`DocumentLinkProvider`）は target の `command:` が公式に無記載なので採らない。

---

## 4. 実装の形

### 4.1 モジュール配置（500 行ラチェット・F13 を守る）

| ファイル | 変更 | 行の見込み |
|---|---|---|
| `plugin-name-diagnostics.ts` | スキャナに `receiver` / `chainPath` を足す。`normalizePluginInstanceNameForGuard` を足す | 308 → 約 400 |
| **新規** `plugin-ui-at-cursor.ts` | `resolvePluginUiTargetAtCursor` / `pluginUiAddressFor` / コマンド本体 `openPluginUiAtCursor(editor, arg?)`（`showErrorMessage` + output channel + `pluginUiForAgent('open', ...)`）/ `openPluginUiAtCursorForAgent`（`executeCommand`）| 約 200 |
| `extension.ts` | `registerCommand('orbitscore.openPluginUiAtCursor', ...)` 1 行 + MCP handlers に `openPluginUiAtCursor` 1 行 | +2 |
| `mcp-types.ts` | `PluginUiAtCursorResult` 型 + `openPluginUiAtCursor?()` | +15 |
| `mcp-tools-plugins.ts` | `open_plugin_ui_at_cursor` 登録（条件付き） | +30 |
| `package.json` | `contributes.commands` +1・`contributes.menus.editor/context` +1 | +12 |
| `agent-handlers.ts` | **触らない**（総行 518・閾値に最も近い） | 0 |

### 4.2 データフロー

```
右クリック ──▶ VS Code: executeCommand('orbitscore.openPluginUiAtCursor')
MCP open_plugin_ui_at_cursor ──▶ executeCommand('orbitscore.openPluginUiAtCursor')   ← 同じ id
                                            │
                                            ▼
                     openPluginUiAtCursor(editor = activeTextEditor, arg?)
                       ├ languageId ガード（loud）
                       ├ resolvePluginUiTargetAtCursor(doc.getText(), selection)   ← 純関数・パスを返す
                       ├ pluginUiAddressFor(target)                                 ← index へ潰す唯一の場所
                       └ pluginUiForAgent('open', receiver, index, expectedName)    ← 既存（extension.ts:275 と同じ関数）
                                            │
                                            ▼
                     //#pluginUi メタ行 → engine Global.openPluginUi → daemon → child（既存・無変更）
```

**engine 以下は 1 行も触らない**（UIH.5 の層分離）。

### 4.3 スキャナの拡張（F11 に足すもの）

`CallFrame` に `elementCounters: number[] | undefined`（catalog frame のみ）と `receiver: string | undefined` を持たせる。`(` で frame を push する時、`roleForCallWord` が `effect` / `instrument` を返した場合だけ `receiverBefore(text, wordStart)`（同一行の左側を §2.2 の表で解釈）と `elementCounters = [0]` を初期化する。`plugin` / `layer` / `chain` は親の `receiver` を継承し、`layer(` は親のカウンタを継承（`layer([` の `[` で 1 段深くなる）。`[` `]` `,` の処理は「現在のフレームが catalog frame で、丸括弧の深さがそのフレームの直下」の時だけ行う。

文字列を site として push する時: `receiver = frame.receiver`、`chainPath = [...frame.elementCounters]`。

`analyzeUnknownPluginNames` は新フィールドを読まない（診断は無変更）。

---

## 5. テスト設計（層別）と失敗モード ↔ 検証手段

### 5.1 ユニット / 配線 / 登録

| id | 層 | 置き場所 | 何を固定するか |
|---|---|---|---|
| T1 | 純関数 | `tests/vscode-extension/plugin-ui-at-cursor.spec.ts` | (a) 同名 3 つで 3 つ目 → `chainPath [2]`・1 つ目 → `[0]` (b) `Gain` を挟むと後ろの要素が +1（F2）(c) `plugin("A", enabled: false)` 内の `,` を数えない (d) `layer([[...],["X"]])` → 長さ 3 のパス・`pluginUiAddressFor` が loud (e) receiver: `drums.` / `global.` → `master` / `sum("x").` / `var d = mix.aux` → `aux:d` / 複数行 → `unresolved-receiver` (f) 失敗 5 種（§2.3）それぞれ 1 ケース (g) 選択: リテラル内に収まる → ok / はみ出す → `selection-spans-outside` (h) `expectedName` が engine の `normalizePluginInstanceName` と同一コーパスで一致（`"TAL Software/TAL Reverb 4"` / `"./fx/Room.clap"` / NFC）|
| T2 | vscode モック配線 | 同上または `extension-wiring.spec.ts` | (a) `registeredCommandHandlers` に `orbitscore.openPluginUiAtCursor` がある (b) 失敗時に `showErrorMessage` が **1 回**・`pluginUiForAgent` が **0 回**（`toHaveBeenCalledTimes`）(c) 成功時に `pluginUiForAgent('open', 'drums', 3, 'ValhallaRoom')` と**引数まで**一致 (d) MCP ハンドラが `executeCommand('orbitscore.openPluginUiAtCursor')` を 1 回呼び、その返り値をそのまま返す。モックの `executeCommand` は現状 `async () => undefined`（`tests/mocks/vscode.ts:232`）なので、**呼び出しを記録し登録済みハンドラへ委譲する**形に拡張する（`registerCommand` が既に Map に積んでいるので委譲は 3 行） |
| T3 | `package.json` | `tests/vscode-extension/plugin-ui-context-menu.spec.ts`（`playhead.spec.ts:208` の `readExtensionManifest` を再利用）| `contributes.commands` に id がある / `editor/context` に `{command, when: 'resourceExtname == .orbs', group: 'orbitscore'}` が**ちょうど 1 つ**ある / `editor/context` の全項目の `when` が `resourceExtname == .orbs` を含む |
| T4 | `tools/list` | `mcp-server.spec.ts` | 順序ピン（無条件 21 本）は**無変更**。フルハンドラでの件数を +1。`open_plugin_ui_at_cursor` の inputSchema が空 |
| T5 | 合意テスト | `plugin-name-diagnostics.spec.ts` | **差分ゼロ**で緑（D6） |

**型で潰すもの（テストを足さない）**: `PluginUiCursorTarget` は `index` を持たない（持てるのは `pluginUiAddressFor` の返り値だけ）。`chainPath` は `readonly number[]`。失敗は `reason` の判別共用体で、`switch` の網羅性を TS に見させる。

### 5.2 失敗モード ↔ 検証手段

| # | 失敗モード | 検証手段 | 備考 |
|---|---|---|---|
| M1 | 解決器が**最初の一致**を返す（同名を区別しない） | **E2E §5.3**（`close_plugin_ui(index: 3)` が成功・`index: 1` が失敗）+ T1(a) | **本件の核心**。§5.4 の変異はこれに対して 1 件だけ |
| M2 | `Gain(...)` を数えず index が 1 ずれる | T1(b) + E2E §5.3 の変形（フィクスチャに `Gain(db: -6)` を挟む・任意） | 同名なら `expectedName` が止めない — ユニットが本体 |
| M3 | `plugin("A", enabled: false)` の `,` を数えて 1 ずれる | T1(c) | |
| M4 | `layer` を index に潰して別のものを開く | T1(d) + 型（パス長で拒否） | v1 では engine も拒否する（二重の安全網） |
| M5 | receiver 取り違え（`sum:x` を sequence `x` として送る） | T1(e) + engine の loud エラー（`global.ts:929-936`） | import 越しは v1 で既知の限界 |
| M6 | 失敗を黙って no-op にする | T2(b)（`showErrorMessage` 1 回・open 0 回） | |
| M7 | メニューが `.orbs` 以外で出る / command id の綴り違い | T3 | |
| M8 | MCP ツールが関数を直接呼び、コマンド登録の配線が死んでも緑 | T2(d)（`executeCommand` 経由を固定）+ E2E §5.3（MCP → コマンド → engine の全長） | |
| M9 | `tools/list` の順序が動く | T4（既存ピン） | |
| M10 | 選択がある時に前のカーソル位置を開く | T1(g) | F1 の但し書き |
| M11 | 右クリックがクリック位置でなく前のカーソル位置を開く | **手動ゲート §5.5**（D9） | 自動化しない（F14） |
| M12 | `expectedName` の正規化が engine とずれて正当な open が落ちる | T1(h) | 落ちる方向なので silent ではないが、機能が使えない |

### 5.3 🔴 実機 gated E2E（本体）— `tests/e2e/orbitstudio-mcp-gated.spec.ts` に 1 本

**置き場所**: `#633 E2E-2` の**直後**（共有セッションを使う既存群の並びに入れる。自前アプリを起動しない）。名前: `'#939 E2E opens only the plugin under the cursor when the same plugin is inserted twice around a standard Gain'`。
🔴 起案時の名前は `... inserted three times` だったが、§0b でフィクスチャを `[clap, Gain, clap]` へ変えた時に
**名前だけが取り残されていた**（実プラグインは 2 つ）。テスト名は名乗りでしかないので実体に合わせる。

**フィクスチャ**（`tmpRoot` に `939-cursor.orbs` を書く。`#643` の `dslPath` の作法・`:1000-1011`）:

```text
var global = init GLOBAL
var cursorSeq = init global.seq
cursorSeq.effect(["<clapEffectName>", "<vst3EffectName>", "<clapEffectName>"])
```

- 1 つ目と 3 つ目が**同名の CLAP**（UI を開けるのは CLAP fixture。VST3 fixture はヘッドレスで `createView` が null・`:2493-2496`）
- 🔴 **真ん中は VST3 ではなく `Gain(db: -6)`**（main のレビュー 2026-09-13）。理由は 3 つ:
  1. **§8 の筆頭トラップ（M2「`Gain` を数えない」）を、この E2E が殺せるようになる。**
     `[clap, vst3, clap]` は 3 つとも非標準なので、`Gain` を数えようが数えまいが index は 1/2/3 で
     **同じになり、M2 が緑のまま通る**。`Gain` を真ん中に置くと、数えない実装は 3 つ目に
     `chainPath [1]` → `index 2` を割り当て、**index 2 は `targets` に無い**ので
     `resolvePluginStateEntry`（`global.ts`）が loud に落ちる
  2. **F3（同名 3 つのラック）の外挿が消える** — 実プラグインは 2 つになる。child spawn も 2 つなので
     `sleep(8000)` は #633 E2E-1（2 spawn）の実証値がそのまま使える
  3. VST3 のヘッドレス挙動への依存が消える
- **VST3 のカバレッジは失われない**（main が実測・2026-09-13）: 「別フォーマットの要素が index を占める」
  「フォーマットをまたいで index 演算が合う」は **`#633 E2E-2` が既に実機で通している**
  （`first = vst3EffectName` / `kept = clapEffectName` で、`first` を落とした後に `kept` を新 index で閉じる）。
  真ん中の要素は本設計でも UI を開かないので、VST3 に固有の経路は元から通らない
- `Gain(db: -6)` をチェーンに混ぜる形は gated suite に既に 5 箇所ある（`:2128` / `:2176` / `:2278` / `:2322` / `:2346`）
- **`evaluate_orbitscore` に同じ 3 行を渡して評価する**（楽譜と engine のチェーンを一致させる）。`await sleep(8000)`（child spawn・既存と同じ）

**手順**:

1. `open_file(path)` → `set_selection(start_line: 3, start_char: <3 つ目のリテラルの開始列 + 2>)`（`text.lastIndexOf(JSON.stringify(clapEffectName))` から算出・決め打ちしない）
2. `get_editor_state` で `cursor.line === 3` を確認（前提の検算）
3. **`open_plugin_ui_at_cursor()`** → `isError === false`。返り値の `index === 3` / `receiver === 'cursorSeq'` を `toMatchObject`
4. `await sleep(2000)`
5. 🔴 **区別するアサーション**: `close_plugin_ui({ receiver: 'cursorSeq', index: 1 })` が **失敗**し `no plugin UI opened` を含む（1 つ目は開いていない）
6. `close_plugin_ui({ receiver: 'cursorSeq', index: 3 })` が **成功**し `completion: 'safepoint-completed'`
7. `close_plugin_ui({ receiver: 'cursorSeq', index: 3 })` を再度 → **失敗**（1 回目が no-op でなかった）
8. 失敗経路を 1 つ: `set_selection(start_line: 1, start_char: 1)` → `open_plugin_ui_at_cursor()` → `isError === true` かつ `not on a plugin name` を含む（§2.3 の文言はここに**実装からコピー**する規約）
9. ERROR 件数は `toBeLessThanOrEqual(errorsBefore)`（`gated-assertion-hygiene` の規則）

**なぜ手順 5 が要るか**: 「index 3 の close が成功」だけだと、**全部開く**実装（`ui("名前")` 相当）でも通る。手順 5 が「1 つ目は開いていない」を固定して初めて「カーソルの 1 つだけ」が証明される。手順 3 の返り値 `index === 3` は補助で、close のオラクルの代わりにはならない（返り値は自己申告）。

**ハーネスの規律**: `set_selection` の列を決め打ちしない（fixture 名の長さは環境で変わる）。`sleep` は既存 E2E と同じ値。`-t '#939'` は**自己完結ではない**（共有セッション依存）ので、開発中は `#633` 群ごと回すか全件。

### 5.4 変異（**2 件**・受け入れ条件として要求するもの）

CLAUDE.md の現行規律により全行に変異を課さない（「手書き変異は PR あたり数件まで」）。
**要求するのは M1 と M2 の 2 件**（main のレビュー 2026-09-13 で M2 を追加）。

#### M2 — `Gain(...)` を数えない（§8 の筆頭）

- スキャナの要素カウンタを「**カタログ名リテラルだけ数える**」に壊す（標準プラグインの `,` を飛ばす）
- **期待**: `[clap, Gain(db: -6), clap]` フィクスチャで、3 つ目が `chainPath [1]` → `index 2` になり、
  **E2E 手順 6 の `close_plugin_ui(index: 3)` が失敗して red**（index 2 は `targets` に無く
  `resolvePluginStateEntry` が落ちる）。ユニット T1 の該当ケースも red
- 🔴 **この変異を要求する理由**: 設計自身が §8 の筆頭に挙げた失敗モードが、変異で守られていない
  状態を残さないため。**旧フィクスチャ `[clap, vst3, clap]` ではこの変異が緑のまま通った**

#### M1 — 最初の一致を返す

- 解決器の「カーソルが乗っている site を選ぶ」を「**同名の最初の site を返す**」に壊す（`sites.find(s => s.spec === specAtCursor)` 相当）
- **期待**: T1(a) が red・**E2E §5.3 の手順 5 または 6 が red**（index 3 の close が `no plugin UI opened` で落ちる）
- 実出力（red の行）を PR に貼る。restore 後の green も貼る

これは「E2E が旧則と新則を区別できる」ことの検算であり（#935 と同型の失敗の防止）、テストの厳密さを上げるためではない。

### 5.5 手動ゲート 1 本（computer use に相当する層）— **何をここでしか見られないか**

**ここでしか見られないもの**: 「マウスの右クリック位置 → カーソル → メニュー項目 → コマンド」の**最初の 2 段**。下の層は全部 `set_selection` でカーソルを置いており、**マウスがカーソルを動かすこと（F1）と、メニュー項目が VS Code の chrome に実在してコマンドを起動すること**は原理的に見えない。

🔴 **Claude の computer-use MCP では実行できない**（F14: IDE は "click" tier・右クリック不可）。したがって **owner または main が手で行い、結果を PR 本文に記録する**（`cliclick` / osascript による自動化は座標依存で脆く、1 本のために持ち込まない — 将来 Accessibility ベースで安定に組めるなら別 issue）。

手順（マージ前ゲートの手順 1–5 の中で行う）:

1. §5.3 のフィクスチャを開き、engine を起動して 3 行を評価する
2. `set_selection(1, 1)` で**カーソルを 1 行目に置く**（前のカーソル位置と区別するため）
3. **3 つ目の名前を右クリック** → `OrbitScore: Open Plugin UI` を選ぶ
4. MCP `close_plugin_ui({ receiver: 'cursorSeq', index: 3 })` が成功・`index: 1` が失敗
5. `get_log` に ERROR が増えていない

4 の結果が逆（1 が成功）なら F1 が偽 = メニューは前のカーソル位置を見ている → §3.2 へ。

#### 🔴 6. VST3 の UI も右クリックで開く（main のレビュー 2026-09-13 で追加）

**なぜここでしか見られないか**: テスト用 VST3 フィクスチャ `GainOracle.vst3` は
ヘッドレスで `IEditController::createView("editor")` が **null を返す**（`:2495-2496` に実機確認の記録）。
したがって **VST3 の UI が開くことは自動 E2E では原理的に確かめられない**。
CLAP だけで閉じると「VST3 の insert を右クリックしたら何が起きるか」が**どの層からも見えない**まま出荷される。

手順（上の 1–5 に続けて・**実プラグインを使う**）:

1. 別のシーケンスに**実在する VST3 の effect** を 1 つ挿して評価する
   （owner 環境の例: `~/Library/Audio/Plug-Ins/VST3/` の `242R Chorus (dev).vst3` /
   `SuaraPortal Fx.vst3`。**カタログ名で書く**。テスト用フィクスチャ `GainOracle.vst3` は使わない）
2. その名前を右クリック → `OrbitScore: Open Plugin UI`
3. **VST3 のウィンドウが実際に表示されること**を目視で確認する
4. `close_plugin_ui` で閉じ、`get_log` に ERROR が増えていないこと

これも結果を PR 本文に日付つきで記録する。ここが倒れた場合は #939 のスコープ外
（VST3 の UI ホスティング自体の問題）として切り出し、**CLAP だけで出荷してよいかを owner 裁定に上げる**。

---

## 5b. 🔴 追補: プラグイン窓を OrbitStudio の前面に出す（#940・owner 裁定 2026-09-14 で本 PR に畳む）

### なぜ本 PR に入れるか

owner 裁定: 「**振る舞いとしては同じ関心**」。利用者から見れば「楽譜から UI を開く」ひとつの体験で、
**本設計の手動ゲート中に発見された**。加えて**手動ゲートは人手が要る一番高い工程**なので、
分けると owner に 2 回やってもらうことになる。

main が当初「§6 の検算の機会で切る」を理由に分離を提案したのは**筋違い**だった — あの規律は
「振る舞いを**変えない**変更を、変える変更と混ぜるな」であり、本件は両方とも変え、互いの検算を潰さない。

### 現状（一次ソースで確認・2026-09-14）

`rust/crates/orbit-child-runtime/src/window.rs:138` が `makeKeyAndOrderFront` を呼ぶだけで、
**ウィンドウレベルは既定（`NSNormalWindowLevel`）のまま**。プラグイン UI は**別プロセス（child）**が
持つので、VS Code をクリックすると VS Code が前面に来てプラグイン窓が裏に回る。

### 方式: child 自己完結 — **wire 変更なし**

| 前提 | 確認 |
|---|---|
| child が `NSApplication` runloop を持つ | ✅ `orbit-child-runtime/src/lib.rs:3, 481` |
| 活性化ポリシー | `NSApplicationActivationPolicy::Accessory`（`:482`）— Dock に出ない |
| spawn に引数を足せる | ✅ `--shm` / `--chain` / `--sample-rate` の列（`outproc_effect.rs:656-661`） |

child が `NSWorkspace` の `didActivateApplicationNotification` を購読し、
**前面が「ホストまたは自分自身」なら `NSFloatingWindowLevel`、それ以外なら `NSNormalWindowLevel`** を
**child の中だけ**で判定する。ホストの bundle id は **spawn 時に 1 回渡す固定値**。

🔴 **ライブな wire コマンドを作らない理由**: 拡張の `onDidChangeWindowState` は
**VS Code ウィンドウのフォーカスしか見ない**ので、**プラグイン窓をクリックすると
VS Code が非フォーカスになり floating が外れる**。child なら「自分が前面」を直接見られるので、
この罠が**設計上そもそも発生しない**。

### 決めること

1. ホスト bundle id の渡し方（`--host-bundle-id` 引数 / env）。**daemon がどこから得るか**も決める
   （拡張 → daemon の spawn 時。拡張は自分の実行ファイルパスから `.app` を辿れる）
2. 未指定時の既定。🔴 **黙って floating にしない** — 指定が無ければ**従来どおり normal**（後方互換）
3. 開いている**全窓**に適用する保持（child は複数窓を持ち得る）
4. child は複数プロセスあり得る（effect rack / CLAP instrument / VST3 instrument）が、
   **各 child が独立に判定する**ので broadcast は不要

### 失敗モード ↔ 検証手段

| 失敗モード | 検証 |
|---|---|
| bundle id の受け渡しが壊れる | **ユニット**（引数パース・未指定時の既定） |
| 前面判定の論理が逆 / 自分自身を数えない | **ユニット**（前面 bundle id → 期待レベルの純関数に切り出す） |
| 🔴 **窓の重なり順が実際に変わるか** | **手動ゲートのみ**（重なり順は自動で観測できない） |

🔴 **自動テストで窓の重なり順は観測できない。** 純関数に切り出せる部分（前面 bundle id → 期待レベル）
だけをユニットで固定し、**実際の重なりは手動ゲート**で見る。ここを E2E で見たことにしない。

### 手動ゲート（§5.5 に追加する項目）

1. VS Code を前面 → **プラグイン窓が上に出る**
2. 他アプリ（ブラウザ等）を前面 → **被さらない**
3. 🔴 **プラグイン窓自体をクリック → floating が外れない**（上記の罠の確認）
4. ホスト bundle id を渡さないビルド → **従来どおり normal**（後方互換）

---

## 6. 束の切り方・触るもの・触らないもの

- **1 PR**（差分 700 行程度の見込み・1,500 以下）。振る舞いを変えない配線入れ替えは含まないので分割の理由が無い
- 順序: T1 を先に書いて red（TDD）→ スキャナ拡張 → T2 / T3 / T4 → コマンド + MCP → E2E を書いて red → 配線 → green → §5.4 の変異 → 仕様改訂（§2.5）→ #474（§2.6）
- **触らない**: engine / daemon / child、`agent-handlers.ts`、`plugin-name-diagnostics.spec.ts`、`ui()` の意味論、MCP の `receiver` / `index` / `chain_path` の体系、`resolveMcpPluginUiIndex`
- **`tests/e2e/dsl-e2e-coverage.spec.ts`**: DSL 語彙を足さないのでラチェットは動かない（MCP ツールは対象外）

---

## 7. 確信度と反証可能性

| 主張 | 確度 | 反証はこう出る |
|---|---|---|
| 右クリックはカーソルを動かす（F1） | 高（一次ソース） | §3.1 手順 4 で `cursor` が 1 行目のまま |
| `Gain` は index を消費する（F2） | 高（コード直読） | `effect(["A", Gain(db:-6), "B"])` を評価して `open_plugin_ui(index: 2, expectedName: "B")` が成功したら誤り（正しければ index 2 は `Valid indices` に出ず失敗する） |
| 同名 3 つのラックは engine が受ける（F3 の外挿） | 中〜高 | §5.3 の評価が落ちる（child 数の上限に当たる等）。その時は「同名 2 + 別名 1」ではなく **同名 2 つ**で「2 つ目にカーソル → index 2 成功 / index 1 失敗」に縮める（区別力は保てる） |
| `editor/context` のコマンドに位置は渡らない（F7） | 中 | ハンドラの第 1 引数を log して `Position` が来ていれば誤り — 来ても `arg` 優先の設計（§3）なので設計は変わらない |
| `executeCommand` が MCP と menu を同一経路にする（§2.4） | 高 | `registerCommand` を外して E2E が緑なら誤り（T2(d) が先に落ちる） |
| import 越しの receiver は engine のエラーが名指す（§2.2） | 高（`global.ts:929-936`） | sequence も同名バスも無い時は `Unknown sequence` のみで `sum:` の案内は出ない — これは「一致 0」の loud であり黙ってはいない |

---

## 8. 実装が最も落としやすい箇所（発注時にブリーフへ写すこと）

1. **`Gain(...)` を数えない**（M2）。「カタログ名だけを数える」方が自然に見えるが engine は標準プラグインも offset を消費する（F2）。同名を挟んだ時 `expectedName` は止めない
2. **`plugin("A", enabled: false)` / `Gain(db: -6, label: "x")` の内側の `,` を数える**（M3）。カウントは「フレーム直下の丸括弧深さ」だけ
3. **MCP ハンドラで関数を直接呼ぶ**（M8）。`executeCommand` を通すこと。モックの `executeCommand` を委譲型に直すのが先
4. **E2E に手順 5（index 1 の close が失敗）を入れ忘れる**（M1）。これが無い E2E は「全部開く」実装でも緑
5. **`receiver` を右辺の変数名で決めてしまう**（`var d = mix.sum` の `d` は sum バス・F5）。文書内の `var` 行を先に集める
6. **`agent-handlers.ts` に足して 500 行を超える**（F13）。新規モジュールへ
7. **仕様の `Cmd+Click` を 1 箇所直して残りを忘れる**（D7）。`grep -rn "Cmd+Click" docs/` の実出力を貼る
