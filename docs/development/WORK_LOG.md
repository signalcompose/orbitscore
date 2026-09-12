# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### fix(mcp): restore the tool registration order the split had changed (Sep 13, 2026)

Fable 監査が、Sonnet レビュアー 8 体が全員通した後に **MCP ツール一覧の順序の変化**を検出した。

#### 何が起きていたか

分割前の `mcp-server.ts` は docs 系 3 本（`get_dev_doc` / `search_dev_docs` /
`register_mcp_server`）を **plugin 系 6 本より後ろ**（23–25 番）に登録していた。
束 F で `registerEditorTools` に docs 系を含めたため、**17–19 番へ繰り上がり、
plugin 系 6 本が 3 つ後ろへずれた。**

MCP SDK の `tools/list` は `Object.entries(this._registeredTools)` を返す
= **登録順がそのまま一覧の順序**なので、これは**クライアントに見える観測可能な変化**である。

#### 🔴 なぜ 8 体が見落としたか — done 条件の検証コマンドが条件を見ていなかった

設計 §7.7 の done 条件は「25 本・**順序も**同一」と書いていたが、
指定していた検証コマンドが

```
grep -oE "'[a-z_]+'" | sort
```

で、**`| sort` が順序の情報を消していた。** レビュアーも私も Codex も
「集合が diff ゼロ」までしか確かめておらず、**順序は誰も見ていなかった**
（「列挙は一段手前で止まる」の形）。

**done 条件を書く時は、それを検査するコマンドが本当にその条件を見ているかを確かめること。**

#### 直し方

`registerDocsTools(server, handlers, docsSourceRoot)` を `mcp-tools-editor.ts` 内に切り出し、
`buildServer` を **engine → editor → plugins → docs** の 4 呼び出しにした。
これが分割前の 25 本の順序を再現する唯一の並びである。
副作用として `registerEditorTools` から `docsSourceRoot` が外れ、署名が揃った。

**恒久対策**: `mcp-server.spec.ts` に `tools/list keeps the exact registration order` を追加。
実サーバを立てて `tools/list` を叩き、順序を配列で固定する。
退行を再現する変異（docs を plugins の前へ）で red を確認済み。

#### 同時に直した 1 件

`extension.ts` の export が 27 → 28 に増えていた（`export type { EngineViewProvider }` を
分割時に足していた）。葉の `extension-state.ts` が根から型を取る形は設計が棄却した向きなので、
本籍の `engine-view-provider.ts` から取るようにし、根の型 re-export を落とした。
**main と HEAD の export 集合が完全一致（対称差が空）** になった。

#### 🔴 自分の件数主張が誤っていた

PR 本文と束 A のコミットに書いた「**31 箇所の代入を setter 化**」は再現できない。
実測は main の直接代入 **37 件** / HEAD の setter 呼び出し **32 件**。
設計 §14 の「件数の主張を書かない。何を変えたかを書く」に従い、
**数値を別の数値に差し替えず、主張自体を落とす**。

#### 別 issue に切り出した 1 件

散文の `## Sources` 参照 **110 件が存在しない行を指すようになった**（#911）。
`docs:check` はコードブロックのヘッダ引用しか見ないため、**982 件が緑のまま**起きていた。
108 件はこの分割が壊したもの。「振る舞い不変の分割」と「#887 より前から在る腐りの修復」を
同じ束に混ぜると双方の検算ができなくなるので分けた（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。

#### 検証

`npm test` 2,491 passed（既存の期待値は 1 つも変えていない）/ lint 緑 /
`tsc --noEmit` 緑 / `typecheck:e2e` 緑 / `docs:check` 982 引用 0 失敗 /
ファイルサイズのラチェット 64 passed。

---

### fix(extension): remove a docblock that was copy-pasted from extension.ts, and mechanize the check (Sep 12, 2026)

`/simplify` のラウンド 1（4 観点並行）で見つかった 1 件を直し、同じ欠陥クラスを機械化した。

#### 何が起きていたか

`diagnostics-provider.ts` と `dsl-providers.ts` に、**`extension.ts` を説明する docblock が
そのまま複製**されていた。死んだ `// import * as os from 'os'` 行まで一緒に付いてきていた。

どちらのファイルにも**正しいファイル固有の doc が先頭に既にある**ので、複製は 2 つ目に居た。
先頭が正しいと、人は 2 つ目を読み飛ばす。

`// import * as os from 'os'` は main の `extension.ts:6` に元からあったもので、
`extension.ts` 側は触っていない（この PR の持ち込みではない）。
複製された 2 ファイルは**この PR で新規追加**したので、両方とも分割作業でのコピペである。

#### 🔴 最初に書いた検査は何も見ていなかった

`module-doc-purity.spec.ts` に足した最初の版は**先頭の doc ブロックだけ**を見ていた。
複製は 2 つ目に居るので、**実際の欠陥を戻す変異を当てても緑のまま通った**。
「新しいテストが緑」は「そのテストが何かを検査している」証明にならない
（memory `test-assertions-must-discriminate` の 3 回目）。

書き直して**ファイル内のすべての doc ブロック**を対象にし、変異 3 種で red を確認した:

| 変異 | 結果 |
|---|---|
| TS 間のコピペ（実際に起きた欠陥を戻す） | red・両ファイルを名指し |
| baseline の組を解消して表から消さない | red（厳密等価の向き） |
| 無関係な Rust 2 ファイル間のコピペ | red・両ファイルを名指し |

#### baseline は 2 組

364 ファイル / 1,355 ブロックを走査して衝突は 2 件だけで、どちらも effect / instrument の
並行実装（同じ構造の同じフィールドに同じ説明）という正当なもの。`KNOWN_SHARED_DOCS` に明示した。
**厳密等価**にしてあるので、解消したら表から消さないと red になる。

#### 引用の追随

2 ファイルから 8 行 / 7 行を削ったので、引用 20 件が落ちた。`--fix` の後、
**start と end が同じだけ動いたこと**（範囲の長さが変わった引用 0 件）と、
**オフセットが実際の削除行数と一致すること**（−8 が 12 件 / −7 が 8 件・ファイル単位で一意）を
検算した。`--fix` が別ブロックへ着地した形は排除できている。

#### `__*ForTest` は減っていない（実測）

#887 本文が「何が実際に困るか」として挙げたテスト専用の裏口は、
**分割前 13 本 → 分割後 13 本で 1 本も減っていない**（本文の「14 本」は末尾が `...` の概数）。
裏口を外すにはテストを書き直す必要があり、それは「既存テストの期待値を 1 つも変えていない」
という #887 の検算そのものを壊す。**分割では解消しない**ことを記録しておく。

#### 検証

`npm test` 2,490 passed（2,488 + 新規 2 件・**既存の期待値は 1 つも変えていない**）/
lint 緑 / `tsc --noEmit` 緑 / `docs:check` 982 引用 0 失敗。

---

### refactor(extension): split mcp-server.ts — the TS split is complete (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 F（最終）**。**`packages/vscode-extension/src/` の全ファイルが 500 コード行以下**に
なった（超過 **0 件**）。

| ファイル | コード行 |
|---|---|
| `mcp-server.ts` | 1,161 → **271** |
| `mcp-tools-editor.ts` | 251 |
| `mcp-tools-plugins.ts` | 217 |
| `mcp-types.ts` | 148 |
| `mcp-tools-engine.ts` | 140 |
| `mcp-docs.ts` | 129 |
| `mcp-sdk.ts` | 96 |

### `buildServer` は 616 コード行の単一関数だった

ファイルを分けても 1 つの式なので閾値を満たせない。`session.rs` の `handle_command`
（1,028 行の単一 `match`）と同じ問題で、**owner 裁定（#888 子 2）に倣い中身を引数付きの
`register*Tools` へ切った**。`registerTool` の本文はインデントも含めて不変。

Codex が **ツール名 25 本の一覧が diff ゼロ**であること、および条件付き登録の 3 群
（`save_plugin_state` / `open_plugin_ui`・`close_plugin_ui` / `register_mcp_server`）の
述語が byte 単位で一致することを確認した。

### #887 全体の成果

| ファイル | 前 | 後 |
|---|---|---|
| `extension.ts` | 2,779 | **301**（89% 削減） |
| `mcp-server.ts` | 1,161 | **271**（77% 削減） |

新設 **19 モジュール**。ラチェットの baseline は 19 → **17 件**（`packages/vscode-extension/src/`
からは 1 件も残っていない）。

🔴 **`npm test` は 7 束すべてで 2,488 passed。既存テストの期待値の変更は 0 件。**
これが分割の検算そのものである。

### 引用と散文

引用は束ごとに壊れ、合計 **約 300 件**を直した。手順は
`--fix`（行番号）→ 本文一致で再アンカー → 本文をソースから再生成、の 3 段。

🔴 **散文の帰属は 4 束連続で腐っていた**（`extension.ts` の…と書いてあるものが別モジュールへ移った）。
`docs:check` は行が合っているかしか見ない。束 F では `buildServer` の `registerTool` 群と
docs 配信部の帰属を直した。

### refactor(extension): extension.ts is under 500 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 E**。**`extension.ts` が 2,779 → 301 コード行（89% 削減）**になり、
ラチェットの baseline から外れた。

| 新設 | コード行 |
|---|---|
| `dsl-providers.ts` | **302**（補完・quick fix・hover の登録） |
| `diagnostics-provider.ts` | **127**（`updateDiagnostics`） |

`extension.ts` に残ったのは `activate` / `deactivate` / `showCommands` / `restartEngine` /
`reloadWindow` / `isTransportCommand` と、import・再輸出ブロックだけ。

### 🔴 この束は main が直接やった

Codex の発注が sandbox の `EPERM`（companion のログ書き込み）で**起動しなかった**
（memory `codex-rescue-sandbox-broker-gotcha`）。残りが小さかったので main が実装した
（CLAUDE.md「4 ラウンド目は main が直す」の一般化）。

### 🔴 import は「推測」せず「引き写す」

新モジュールに import を**自分で書こうとして名前を 5 つ外した**
（`detectPitchScopeContext` / `detectPlayArgContext` / `detectOutputArgContext` /
`detectEffectArgContext` / `analyzeMissingOutput` の受け方）。

そこで**束 E 前の `extension.ts` の import 群 111 行をそのまま引き写し**、
未使用分を `eslint --format json` の指摘で機械的に刈る方式へ切り替えた。**推測が 0 になった。**
残った型エラー 2 件（`registerHoverProvider` / `updateDiagnostics` に `export` が必要）も
コンパイラが名指ししたものだけを直した。

### 散文参照は「範囲を保てない限り動かさない」

束 D で範囲を 1 点に潰した失敗を踏まえ、**束 E 前の内容と一致した場合のみ**移す実装にした。
今回は 12 件すべて一致せず（散文の行番号がもっと古い版を指している）、**据え置いた**。
壊すより据え置く方が良い。

### 検証

`npm test` **2,488 passed**（6 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`dsl-completion-provider.spec` 15 passed / `output-code-action.spec` 1 passed /
`public-surface.spec` 38 passed（設計 §7.6 の done 条件）。

**残るは `mcp-server.ts`（1,161）= 束 F。**

### refactor(extension): move evaluation and agent handlers out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 D**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `agent-handlers.ts` | **392**（`*ForAgent` 17 本 + `__pluginUiForAgentForTest`） |
| `run-selection.ts` | **152** |
| `mcp-register-command.ts` | **152** |
| `plugin-commands.ts` | **127** |

`extension.ts` は 1,461 → **715** コード行（開始時 2,779 の **26%**。目標 500 まであと 215）。

Codex は全 10 塊を `9143a233` と **verbatim 一致**で照合し、27 export の維持も確認している。
`activate().handlers` のオブジェクトリテラルは byte-for-byte 不変。

### 🔴 Codex に `npm test` の全件を頼んだのが間違いだった（束 0〜C）

束 C の Codex が構造的な事実を報告した:

```
Error: listen EPERM: operation not permitted 127.0.0.1:<port>
Tests  107 failed | 2381 passed
```

**sandbox が loopback の listen を禁じるので、localhost を使う 4 スイート（107 テスト）は
原理的に走らない。** CLAUDE.md が「Codex は sandbox で daemon protocol（localhost bind）・
MCP 系・実機 E2E が原理的に走らない」と明記しているとおりで、**私が読んでいたはずのこと**。

束 B / C の Codex はどちらも「2,488 passed は自分の出力ではない」と明記して報告を拒んだ。
**正しい態度である。** 束 D からブリーフを focused な spec だけに変えたところ、
**衝突なしで完走した。**

### 🔴 散文の参照は「範囲を潰さずに」直す

散文中に `extension.ts:3000-3032` のような**行範囲つきの参照**が 12 件あり、これは引用 header
ではないので `docs:check` が一切見ない。機械的に「関数の定義行 1 点」へ置き換えたところ
`3000-3032` → `592` のように**範囲が潰れた**。**劣化なので取り消した。**

取り消しに `git checkout -- sites/dev` を使って**引用の再アンカーまで巻き戻し**、やり直した。
さらにその過程で `extension.ts:654-654`（`} else {` の 1 行）という**潰れた引用**を作ってしまい、
元の 50 行（`run-selection.ts:63-112`）へ復元した。

**範囲を保って移せた 2 件だけを移し、残り 10 件は据え置いた。** 内容が一致しないものを
機械で動かすと、今回のように壊す。

### 検証

`npm test` **2,488 passed**（5 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`public-surface.spec` 38 passed / `start-engine-for-agent.spec` 4 passed。

### refactor(extension): move view, docs and flash out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 C**。純粋な移動。

| 新設 | コード行 |
|---|---|
| `engine-view-provider.ts` | **243** |
| `flash-config.ts` | **222** |
| `docs-panels.ts` | **104** |

`extension.ts` は 1,991 → **1,461** コード行（開始時 2,779 の **53%**）。

🔴 既存の `engine-view.ts` へは入れていない。あれは header で「vscode 非依存」を宣言した
純モジュールで、vscode に触る配線は**対になる新ファイル**へ置く（設計 §4.1 / D4）。

### 🔴 引用が緑でも散文は検査されない（3 回目）

`vscode-architecture.md` が「`engine-view.ts` の純関数がノードを組み立て、**`extension.ts` の**
`EngineViewProvider` がそれを `vscode.TreeItem` に写します」と書いていた。ja/en とも直した。

**3 束連続で同じ形の腐りが出ている**（束 A: 行数と状態の置き場所 / 束 B: stdout ルータの帰属 /
束 C: `EngineViewProvider` の帰属）。`docs:check` は**行が合っているか**しか見ないので、
**移した関数名で散文を横断検索する**のを各束の手順に入れている。

### 🔴 委譲先と同じツリーで作業して衝突させた（main の運用ミス）

束 B の Codex が正直に報告した: 検証中に main（私）が `npm test` を並走させ、さらに
コミットまでしたため、**Codex は一度も全テストを完走できなかった**（exit 130 で停止）。
Codex は「2,488 passed は自分の出力ではない」と明記して報告を拒んでいる。**正しい態度である。**

memory `delegate-work-needs-its-own-worktree` がそのまま当たっている。
検証は main の仕事なので結果に影響は無いが、**委譲先の時間を無駄にした**。
以後の束では、ブリーフから「全テストを回す」を外し、**focused な spec だけを求める**。

なお Codex は **AST 比較で 26 関数すべての本文が IDENTICAL** であることを確認しており、
これは main の residual 分類より強い証拠である。

### 検証

`npm test` **2,488 passed**（4 束連続で不変・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`engine-command-awaits.spec` 10 passed（設計 §7.4 の追加 done）/ `public-surface.spec` 38 passed。

### refactor(extension): move the engine wiring out of extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 B**。束 A で代入を setter に替えたので、ここは**純粋な移動**。

| 新設 | コード行 | 中身 |
|---|---|---|
| `engine-handlers.ts` | **321** | stdout / stderr / exit / error のハンドラ 9 本 |
| `engine-process.ts` | **423** | engine パス解決・`startEngine` / `stopEngine` / `toggleEngine` ほか 11 本 |

`extension.ts` は 2,662 → **1,991** コード行。

### 🔴 `engine-lifecycle.ts` へ戻さなかったことが、テストで証明された

issue #887 の本文は「stdout/exit ハンドラは `engine-lifecycle.ts`（既存）へ」と書いていたが、
設計（Fable 起案・main が `grep` で裏取り）がこれを覆した。
`extension-wiring.spec.ts:48` が `engine-lifecycle` を `vi.mock` して `applyEngineExit` /
`applyEngineError` を spy にしており、**同一モジュール内の呼び出しは mock を通らない**。
戻した瞬間に spy が一度も呼ばれなくなり、テストを書き換えるしかなくなる。

**`extension-wiring.spec.ts` が 58 passed であることが、mock 境界の外側に置けた証拠**である。

### 引用 122 件 — 束 A で作った手順がそのまま効いた

`--fix`（行番号のみ）70 → 本文をソースから再生成して再アンカー 52。
束 A で書いた再アンカー手順を `$TMPDIR` のスクリプトとして再利用した。

🔴 **引用が緑でも散文は検査されない（2 回目）。** `plugin-ui.md` が
「**`extension.ts` の** stdout ルータはこの結果行を拾います」と書いているのに、
引用は `engine-handlers.ts` を指していた。ja/en とも帰属を直した。
移した関数名 7 つで横断検索し、他に同型が無いことも確認した。

### 検証

`npm test` **2,488 passed**（束 0 / A と同値・**既存テストの期待値の変更 0 件**。
`tests/` の差分はラチェットの baseline のみ）/ `npm run lint` / `npm run typecheck:e2e` /
`npm run build` / `npm run docs:check` 982 引用 / `extension-wiring.spec` 58 passed /
`public-surface.spec` 38 passed。

### refactor(extension): move module state to a leaf and turn 31 assignments into setters (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887 の**束 A**。分割の核心で、以降の束が「純粋な移動」になるための前提。

### 読みは live binding・書きは setter

ES module の import 束縛は**代入できない**が、読みは常に最新値が見える。そこで:

- **読み出し約 220 箇所の本文は 1 文字も変えていない**
- **代入 31 箇所だけ**が `setX(v)` になった

新設は `extension-state.ts`（103 コード行・leaf）と `playhead-decorations.ts`（124）。
`__*ForTest` **13 本**は名前も引数も本文も変えず、閉じている状態と同じモジュールへ移し、
`extension.ts` が `export { … } from` で再輸出する。**テスト側 239 箇所の変更は 0**。

`extension.ts` は 2,779 → **2,662** コード行。

### residual 322 行をすべて分類した

設計 §7.2 の done 条件。**未分類 0**:

| 分類 | 行数 |
|---|---|
| setter の定義と本体 | 54 |
| setter の呼び出し | 32 |
| 局所定数化 / 旧宣言 | 31+ |
| import / 再輸出 | 89 |
| 宣言・関数に `export` を前置（移動） | 25 |
| doc / コメント | 11 |

分類中に `outputChannel.appendLine` → `channel.appendLine` が一度「未分類」に落ちたが、
設計 §4.5 が予告した **narrowing のための局所定数化**だった
（`const channel = vscode.window.createOutputChannel(...)` の直後に `setOutputChannel(channel)`。
**同一オブジェクト**であることを実物で確認）。

### 🔴 今朝作った L-3 ガードが、今日のうちに TS 側で仕事をした

新設 2 ファイルが `git add` 前だったため、ラチェットが**名指しで検出**した
（`docs/design/888-file-size-ratchet-design.md` §13.10）。Rust 側で踏んだ穴が TS でも同じ形で出る。

### 引用 124 件が壊れた — 3 段階で直した

| 手段 | 解決 |
|---|---|
| `--fix`（行番号のみ） | 88 |
| 本文一致で移動先を特定（`export` 前置を剥がす） | 12 |
| 先頭行・末尾行を鍵にした再アンカー + **本文をソースから再生成** | 22 |
| 手で 1 組 | 2 |

🔴 途中で relocate スクリプトが **`/tmp` の一時パスを markdown に書き込んだ**（2 件）。
候補ディレクトリに `/tmp` を渡した私の使い方の誤りで、直した。

🔴 **引用が緑になっても散文は検査されない。** `vscode-architecture.md` が
「`extension.ts` は 4,115 行の大きなファイルで、状態はモジュールレベル変数に置かれています」と
書いており、**分割後は両方とも事実でない**。ja/en とも実態に合わせた。

### 検証

`npm test` **2,488 passed**（束 0 と同値・**既存テストの期待値の変更 0 件**）/
`npm run lint` / `npm run typecheck:e2e` / `npm run build` / `npm run docs:check` 982 引用 /
`grep -cE '^let ' extension.ts` = **0**。

### test(extension): freeze the public surface before splitting extension.ts (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `887-extension-split`

#887（TS 分割）の**束 0 = 道具を先に置く**。**ソースは 1 行も動かしていない**
（`git diff --stat main -- packages/` が空）。

### 🔴 Rust で 2 度踏んだ欠陥の TS 版を先に塞ぐ

Rust では `pub` 項目が `pub(crate) use` 経由で crate 外から消え、**全ゲート緑のまま通過**した。
TS に `pub(crate)` は無いが、同型の欠陥は「再輸出ブロックから 1 本抜ける」「型だけ export されて
値が消える」形で出る。しかも **`tests/vscode-extension/` は一度も型検査されていなかった**
（`tsconfig.tests.json` の include は `tests/e2e/**` のみ）。

`tests/vscode-extension/public-surface.spec.ts` を置き、**tsc と vitest の 2 層**に通した。
凍結したのは `extension.ts` **27** + `mcp-server.ts` 値 **11** = **38 値**と、型 **25**。
（設計文書の一覧を写さず、現物を `grep -E '^export'` して突き合わせた結果が一致）

main が実測した fail-before **3 件**:

| 変異 | 検出した層 |
|---|---|
| 存在しない export を import | tsc **TS2724** |
| 型を値として使う | tsc **TS2693** |
| 🔴 **実際に `export` を 1 本消す** | vitest（実行時に `undefined`） |

3 番目が本題。Rust で踏んだ欠陥はこの形だった。

### 引用追随スクリプトもリポジトリへ

`sites/dev/scripts/relocate-citations.mjs`。引用は `extension.ts` **248 箇所** /
`mcp-server.ts` **46 箇所**あり、全束で動く。`--fix` は**行番号しか直せない**ので、
移動先を中身から特定するこれが要る。Rust 分割では scratchpad に置いていて毎回探していた。

### 検証

`npm test` **2,488 passed**（main の基準 2,450 + surface spec 38・**既存テストの期待値の変更 0 件**）/
`npm run typecheck:e2e` / `npm run lint` / `npm run docs:check` 982 引用。

### docs: link the install guide from README and every release (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `905-install-route-links`

owner の指摘から。「インストール手順は**リリースページに書く**のではなく、**マニュアルに載せて
README やリリースからリンクする**」という裁定に従った（#905）。

### 🔴 手書きの定型は次の版まで生き残らなかった

v3.0.0 のリリースページには **45 行の丁寧な手順**が手書きされていたが、**v4.0.0 では丸ごと消えた**。
`release.yml` は `gh release create --generate-notes` だけなので、**自動では何も付かない**。
v3.0.0 のものは後から手で書き足したものだった。

**これが「リリースページに書く」案を採らない実測の根拠**である。私は当初そちらを提案したが、
owner の案（正本へリンク）の方が正しい。複製は必ず本体より遅れる。

### やったこと

| 対象 | 変更 |
|---|---|
| `release.yml` | `--notes-file` で短い定型（動作環境 + 正本へのリンク）を先頭に置き、`--generate-notes` の changelog をその後ろへ。**次の版から自動で付く** |
| `README.md` | 既存の「Just want to use it?」節に正本へのリンクを足した |

正本は `sites/user/getting-started/installation.md`（版に依存しない書き方・公開済み。
https://signalcompose.github.io/orbitscore/getting-started/installation が 200 を返すことを確認）。

🔴 **heredoc の字下げを検証した。** YAML の `run: |` ブロック内に heredoc を書くと、字下げ次第で
markdown が丸ごとコードブロックになる。YAML を実際に展開して列 0 に揃うことを確認し、
生成物も実行して目視した。

### 🔴 やらなかったこと 2 件

- **README に新しい `## Install` 節を作らない** — 一度作ったが、既存の「Just want to use it?」と
  合わせて**三つ目の複製**になると気づいて取り消した
- **`docs/user/ja/USER_MANUAL.md` を直さない** — scsynth の記述など明らかに腐っているが、
  この文書は **DEPRECATED で「履歴として保持」（#237）** と明記されている。一度書き換えてから
  気づいて戻した。腐りは冒頭の 2 つのバナーが既に無効宣言しており、さらに「リリースページに
  手順が載っています」という 65 行目の約束は、上の `release.yml` の変更で**再び真になる**

### chore(release): bump the extension to 4.0.1 — the Rust split ships (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-release-4.0.1`

#888 の Rust 分割（子 0〜3）を 4.0.1 として出す。**patch である** — 振る舞いも DSL も
変えていないため（`/goal` の確定事項「4.0.1 は Rust 分割のみ」）。

| 軸 | 値 | 動いたか |
|---|---|---|
| 拡張（`.vsix` と git タグ・**正本**） | **4.0.0 → 4.0.1** | ✅ |
| `ENGINE_VERSION`（セッションログの meta） | 2.0.0 | 別軸・同期しない |
| `DSL_VERSION`（spec 版） | 2.0 | 別軸・同期しない |

`docs/design/656-release-design.md` §4.4 のとおり 3 つは別軸。
`node scripts/check-release-tag-version.mjs v4.0.1` が緑。

🔴 **歴史的記述は変えていない。** 「#883 で拡張を 4.0.0 に上げた」という記述は事実なので
そのまま残し、**「現在の版は〜」と現在形で述べている箇所だけ**を 4.0.1 にした
（README / CLAUDE.md / core spec 2 箇所 / dev サイト 4 箇所）。

### docs: land the four routine docs-sync PRs as one roundup (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `893-docs-sync-roundup`

#882 / #891 / #892 / #893 を 1 本に畳んだ。**4 本とも CONFLICTING** で、#888 の分割が main に
入った直後だったため放置すれば腐る一方だった（owner の指摘で着手）。前例は #867（9 本の roundup）。

衝突は 2 種類:

- **WORK_LOG**（4 本とも Recent Work へ追記）— 両方残す
- **`vscode-architecture.md` の「どの PR まで追従したか」の Note 行** — #884 / #885 / #889 の
  3 本すべてを反映した 1 文にまとめた。HEAD 側に残っていた「束 S（#885）はまだ反映していません」は
  **#885 を取り込んだ時点で古くなっていた**（2 段目の取り込みで前段の宣言が嘘になる型）

🔴 引用は 8 件壊れていたが、**すべて `extension.ts`** で #888 の Rust 分割とは無関係だった
（PR の base が古かったための一様な **+27 行**シフト）。`--fix` の着地先 4 件は散文と突き合わせて
確認済み — `updateDiagnostics` の `analyzeMissingOutput` ループ / `registerOutputCodeActionProvider`
の `provideCodeActions` / 補完候補の組み立て / トリガ文字の登録。

検証: `npm test` 2,450 passed / `npm run lint` / `npm run docs:check` **982 引用**（4 本が +34 件）。

### docs: follow PR #889 into the chapters and guides that still said `spawn('node')` (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr889`
**担当**: docs 追従ルーティン（マージ済み PR [#889](https://github.com/signalcompose/orbitscore/pull/889) を追う）

PR #889（#878・engine を VS Code 同梱の Node で起動）は dev サイトの引用ブロックを追従させたが、
**引用を囲む本文と図が古いまま**だった。`docs:check` は引用のアンカーしか見ないので red にならない
（`docs/core/PROJECT_RULES.md` の「ルーティンは機械が見ていない層を見ている」）。

#### 1. `spawn('node')` と言い続けていた本文・図

| 場所 | 何が古かったか |
|---|---|
| `sites/dev/orientation/architecture-overview.md:60` | mermaid のラベルが `child_process.spawn('node', ...)` / `env は debug フラグと capture seam のみ` |
| `sites/dev/editor/vscode-architecture.md:606` | 「debug フラグと capture seam（#307）だけを env へ積んで spawn します」 |

どちらも spawn の第 1 引数が `process.execPath` になり、env に `ELECTRON_RUN_AS_NODE` /
`ELECTRON_NO_ASAR` が加わった時点で事実でなくなっている。

#### 2. `daemonEnv()` が説明なしで引用に現れていた

`architecture-overview.md` の `spawnDaemon()` 引用には PR #889 で `env: daemonEnv(process.env)` が
入ったが、**`daemonEnv()` が何かを述べる本文が 1 行も無かった**。関数本体の引用と、
「自分が足したものを自分の出口で戻す」という根拠（および「ホスト由来の変数を第三者へ渡さない」を
根拠にしていない理由）を書いた。

#### 3. cold install ゲートがどの doc にも無かった

`npm run test:e2e:cold-install`（`ORBIT_GATED_COLD_INSTALL=1`）は CLAUDE.md のマージ前ゲートには
入ったが、**gated E2E を説明する章**（`sites/dev/editor/mcp-and-gated-e2e.md`）と
**テスト手順の doc**（`docs/testing/TESTING_GUIDE.md`）には無かった。前者に 1 節
（dev host が構造的に通らない 3 経路・strict / finder の差・オラクルが `ok` でなく RMS）を、
後者に実行手順を足した。

日英とも同一ターンで更新。`node sites/dev/scripts/check-citations.mjs` は 956 citations / 0 failed。

---

### docs: follow PR #885 in the user site, the manual and the editor chapters (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr885`
**担当**: docs-sync ルーチン（追従元 = PR [#885](https://github.com/signalcompose/orbitscore/pull/885)・マージ commit `f575f27`）

PR #885（暗黙 master 終端の廃止・#883 束 S）に、**ドキュメントだけ**を追従させた。実装・テストは
一切触っていない。

#### 1. ユーザー向けの記述が仕様と正反対のまま残っていた

#885 は `AudioLine.program()` の暗黙 `output(master)` 合成を削除したが、**ユーザーサイトは
「`output()` を 1 つも書かなかった場合は、線の最後に `output("master")` があるものとして
扱われます」と書いたまま**だった。ja / en の 4 箇所:

| ファイル | 旧記述 |
|---|---|
| `sites/user/mixing/routing.md:97` | 「これは今までどおりの動きです」 |
| `sites/user/en/mixing/routing.md:97` | 同上（en） |
| `sites/user/reference/methods.md:443` | 「線の最後に `output("master")` があるものとして扱われます」 |
| `sites/user/en/reference/methods.md:399` | 同上（en） |

いずれも「出口の無い線は無音」へ書き換え、`routing.md` には**出口を書き忘れたときの節**を新設した
（`output-missing` / `dry-not-routed` の 2 診断と quick fix、sum / aux バス自身にも出口が要ること）。
「音が鳴らない」は `troubleshooting.md` の先頭カテゴリなので、そこにも原因 1 件として足した。

同じ章の**譜面例そのもの**も 2 件古かった。`routing.md` の `send()` 節は「元の音自体は消えず、
そのまま master（または sum）へ流れ続けます」と書いており、これは #883 X3 が塞いだ挙動の説明に
なっていた。`send()` は今も分岐（`thru: true`）だが、その先に出口が無ければ dry はどこにも
届かない。`sum` の最初の例と `projects/import.md` の例も、バス自身の `output()` が無いため
**そのまま写すと無音**になる状態だった。

`docs/user/ja/USER_MANUAL.md` の instrument 節は「instrument の音は master へ直接ミックス
されます」と**無条件に**書いていた。#885 以降は出口を書いたときだけなので条件付きに直し、
「音が出ない」の原因リストにも出口の書き忘れを先頭で足した。

#### 2. dev サイトの診断章が旧仕様（LinkAudio 限定の Error）のままだった

#885 は `analyzeLinkAudioMissingOutput`（LinkAudio ファイル限定・Error・instrument 除外）を
`analyzeMissingOutput`（全ファイル・Warning + Information・**instrument は対象**・quick fix 付き）へ
置き換えたが、`sites/dev/editor/execution-feedback.md` の診断 6-8 節と 9 種の表は旧記述のまま
だった。表の行・守備範囲・severity の理由を書き換え、`code` の 3 分岐・severity 写像・
CodeActionProvider の節を足した（ja / en）。

- `sites/dev/editor/vscode-architecture.md`: `activate()` に増えた
  `registerOutputCodeActionProvider(context)` の 1 行を IntelliSense / 診断の登録節へ
- `sites/dev/editor/mcp-and-gated-e2e.md`: `get_diagnostics` が返す `DiagnosticEntry` に
  `code?` が増えたこと（エージェントが文言でなく識別子で分岐できる）

3 章とも `verified-against` を `f575f27` へ、`verified-at` を 2026-09-12 へ更新した。

#### 追従不要と判断したもの

- `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` / `DESIGN_DISCUSSION_RECORD.md`（決定 #78 / #79）は
  **束 S より前に更新済み**で、#885 の振る舞いと一致している
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` は #885 自身が更新済み（診断の「⏳ 未実装」→「✅ 実装済み」）
- `sites/dev/signal-chain/mixer-audio-line.md` ほか dev サイトの 20 章は #885 自身が更新済み
  （`SourceDest::None` / `FeedDest::Discard` / `PROTOCOL_VERSION 0.3` まで反映されている）
- `docs/design/883-explicit-output-routing-design.md` は起案時点のスナップショットなので触らない

#### 検証

`npm run docs:build`（user / dev）と `npm run docs:check` を通した。結果は PR 本文に貼ってある。

---

### docs(dev-site): follow PR #884 in the dev site and repair a mangled citation (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `claude/docs-sync-pr884`（docs 追従ルーチン・main 宛 draft）
**対象**: PR [#884](https://github.com/signalcompose/orbitscore/pull/884)（#883 束 0+C・マージコミット `82acaa3`）

マージ済み PR #884 に dev 学習サイトを追従させた。**実装とテストは一切変更していない。**

#### 1. `sites/dev/pipeline/evaluation.md` の引用が壊れていた（🔴 docs:check は緑だった）

PR #884 で `check-citations.mjs --fix` が `evaluate-method.ts:58-145` を再アンカーした際、
**直前の別 docblock の末尾（` * ``` ` / ` */ `）を引用の先頭に取り込み、末尾は
`if (sawNamedArg) {` で切れていた**。引用は実ファイルと**文字単位で一致していた**ので
`docs:check` は 0 failed のまま通る — **この検査は「引用が意味のある単位か」を見ない。**

実ファイルを読み直し、`60-159`（`NAMED_ARG_SCHEMA` の docblock から `processArguments()` の
閉じ括弧まで）へ引用し直した。

#### 2. 追従した内容

| 章 | 足したもの |
|---|---|
| `pipeline/evaluation.md` | 名前付き引数だけの `output(db: -6)` で options 袋が**宛先の位置に座る**問題と、`output` / `send` に限って `undefined` を unshift して宛先位置を空ける処理（`evaluate-method.ts:145-158`）。判定に使う `isOutputDest()` が core 側と同一関数であること |
| `signal-chain/mixer-audio-line.md` | 新節「宛先の省略と『実現の省略』」— `output()` の宛先省略（既定引数であって暗黙要素ではない）/ `isOutputDest()` の 1 点賭け / `assertSendDestination()` が両 `send()` の契約であること / `lineNeedsBus()` による実現の省略と `gain`・`pan` 引き継ぎへの副作用 |
| `editor/vscode-architecture.md` | 補完を **3 系統 → 4 系統**に更新。`.output(` の宛先補完（`output-string` / `output-node` の 2 コンテキスト・`mixerNode` 除外の理由・トリガ文字 `(` の追加） |

ja / en 両方（STYLE_GUIDE のバイリンガル要件）。3 章の frontmatter の
`verified-against` / `verified-at` を `f575f27` / `2026-09-12` に更新した。

#### 3. 🔴 引用は `f575f27`（#885 マージ後の main）基準である

追従の起点は #884 だが、**束 S（PR [#885](https://github.com/signalcompose/orbitscore/pull/885)）が
既に main へ入っている**ため、branch を main から切った時点で `sequence.ts` /
`audio-line.ts` / `extension.ts` の行番号が動いていた。行ずれだけのものは `--fix` で再アンカーし、
**内容が変わっていた `lineNeedsBus()`（#885 が `isPlainMasterOutput()` を切り出した）は
実ファイルを読み直して引用し直した**。束 S 自身の追従（`AudioLine.program()` からの
暗黙 master 撤去・診断 2 種・版 4.0.0）は**このコミットには入っていない**。

#### 4. 追従できていない点（PR 本文に書き出しただけ・直していない）

- `.output()`（宛先省略）は E2E カバレッジのラチェットに**見えない** — 走査が
  `/\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/` なので `.output()` と `.output("drum")` が同じ 1 語に潰れる
- `output(db: -6)` / `send(db: -6)`（名前付き引数だけの形）は unit のみ。**実機 gated E2E に無い**
- 実現の省略の目的（`.output()` 必須化で 8 本のプールを食い潰さない）を押さえる E2E が無い —
  X2 は 1 シーケンスの等価性しか測っていない

### docs: carry the install-route fix into the legacy ja manual (PR #880 追従) (Sep 11, 2026)

ルーティン docs 追従。追従元は PR [#880](https://github.com/signalcompose/orbitscore/pull/880)
（マージコミット `4e661467b0ff8997fc67b4b9bd6f31f1ef33e8d5`・docs のみ・CI 4/4 緑）。

#### 追従した 1 点

PR #880 は資産名の実物合わせ（`orbitscore-<version>.vsix` → `orbitscore-darwin-arm64-<version>.vsix`）を
**4 箇所**に入れたが、**`docs/user/ja/USER_MANUAL.md` が漏れていた**。

| 直した箇所 | 旧 | 新 |
|---|---|---|
| `docs/user/ja/USER_MANUAL.md:59` | `orbitscore-*.vsix` | `orbitscore-darwin-arm64-*.vsix` + Assets / releases/latest の導線 |
| 同 `:63`（CLI） | `code --install-extension orbitscore-*.vsix` | 同上のファイル名 |
| 同 `:65` | 「将来は VS Code Marketplace と Open VSX からも install 可能になる予定」 | **公開しない**（owner 2026-09-10・#880 の WORK_LOG に記録） |

接尾辞 `darwin-arm64` は `release.yml:45` の `VSIX_TARGET` を `vsce package --target` へ渡した結果であり
（`release.yml:118`）、**リリース資産にのみ付く**。版番号は #880 の方針どおり固定していない。

#### 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/user/{ja,en}/GETTING_STARTED.md:72` の `orbitscore-0.0.1.vsix` | **ローカルビルドの `.vsix`**（直前が `npm run build`）。`--target` を渡さない `vsce package` には接尾辞が付かないので #880 の資産名は当たらない。版が古いのは別件 |
| `docs/user/en/USER_MANUAL.md` | `.vsix` のダウンロード導線を**そもそも持たない**（build-from-source のみ）。ja と対になる記述が無い |
| `docs/user/ja/USER_MANUAL.md:55` の scsynth 同梱 | #502 の失効範囲。冒頭バナーが既にカバーしており、#880 の差分ではない |
| `sites/user/**`・`README.md`・`packages/vscode-extension/README.md` | #880 が ja / en とも更新済み |
| DSL / ランタイム / OrbitStudio の各層 | #880 は **docs のみ**（5 ファイル）。構文・意味論・MCP・評価経路のいずれも触っていない |

検証: `docs:build`（user / dev）緑・`docs:check` 944 / 0 failed。
### fix(plugin-scan): re-export vst3_scan publicly — my sed excluded digits (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c3-vst3-host`

🔴 **Fable 監査の指摘を「既に直っている」と却下したが、誤りだった。** 私は**束 1 のブランチで**
検査しており、そこでは `orbit-plugin-scan` がまだ分割されていなかった（分割は束 3）。
stack 先端では `scan_vst3_bundle` / `dedup_entries` / `VstScanResult` が **E0603** で落ちる。

原因は私の `sed` の文字クラス:

```
s/^pub(crate) use \([a-z_]*\)::\*;$/pub use \1::*;/
```

`[a-z_]*` に**数字が入っていない**ため、`vst3_scan` だけが一致していなかった。
他 11 モジュールは直り、その 1 つだけが残った。

**今日置いたばかりの `tests/public_surface.rs` が stack 先端でこれを捕まえた。**
検算の道具を先に作ったことが効いている。

🔴 **教訓は 2 つ**: (a) **stacked PR では、下流の変更を含む先端で検算する**。上流の枝で
「無い」と言っても、下流で初めて現れる欠陥は見えない。(b) **機械的置換の網羅性は、置換対象の
一覧と突き合わせて確かめる**（`grep -c 'pub(crate) use'` が 0 になったことだけを見ていた）。

併せて `module-doc-purity.spec.ts` の「0 件なら必ず宣言せよ」という逆方向を外した。
カウンタが測れるのは**修飾子の絶対数**であって「分割で変えたか」ではなく、`pub(crate)` は
分割前から付いていることがある（`playback.rs` の `set_callback_alive`）。検証できる主張だけを残す。

### refactor(rust): split the last three Rust files — #888 child 3 done (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c3-vst3-host`

🎯 **#888 子 3 完了。目標 6 ファイルがすべて 500 コード行以下になった。**

| ファイル | 前 | 後 | 新モジュール（コード行） |
|---|---|---|---|
| `orbit-vst3-host/src/lib.rs` | 2,388 | **455** | `setup` 466 / `effect` 406 / `instrument` 303 / `interfaces` 280 / `events` 276 / `probe` 232 |
| `orbit-plugin-scan/src/lib.rs` | 1,652 | **44** | `scan_run` 271 / `artifact_probe` 237 / `child_probe` 193 / `vst3_scan` 186 / `process` 180 / `macho` 175 / `types` 135 ほか 5 |
| `orbit-audio-sandbox/src/transport.rs` | 1,416 | **36** | `ui_pump` 478 / `mailbox` 374 / `event_ring` 218 / `shm` 160 / `layout` 93 / `ui_codec` 92 |

`npm test` は **2,445 passed で不変**（既存テストの期待値を 1 つも変えていない）。
cargo fmt / cfg 4 象限 / `clippy --workspace --all-targets -D warnings` / `cargo test --workspace`（93 スイート）/
lint / docs:check（948 引用）すべて緑。dev サイトの引用 32 件は `relocate-citations.mjs` で追随。

### 🔴 public API が黙って消える — `pub(crate) use` の罠

`pub fn` を private な子モジュールへ移し `pub(crate) use child::*;` で再エクスポートすると、
**crate 内はコンパイルが通るのに crate 外からは見えなくなる**。`cargo clippy -p <crate>` は
下流を見ないので捕まらない。実際 `orbit-vst3-host` の `probe_factory_descriptors` は
この形で public API から落ち、`orbit-plugin-scan` の 15 件は dead_code 警告で初めて露見した。

対処は `pub use child::*;`（低い可視性の項目はそのまま低いまま再エクスポートされる）。
検算として **分割前後で `^pub (fn|struct|enum|const|type|trait)` の集合を diff** し、
3 crate とも同一であることを確認した。

### 🔴 ラチェットが緑のまま閾値超過を見逃した — `git ls-files` は index を見る

新設した `host/interfaces.rs` は **576 コード行**あったが、`git add` 前だったため
`git ls-files` の列挙に現れず、**ラチェットは 11 テスト全緑**だった。設計 §13.10 が
この帰結を予告していたのに、実作業で踏んだ。真空防止（`minFiles`）は塞げない —
追跡済みファイルだけで件数のしきい値は満たされるからで、**L-1 / L-2 と同じ
「分割が成功した瞬間に実害化する」構造**をしている。

`listUntrackedMeasuredFiles` を足し、測定対象の未追跡ファイルが 1 つでもあれば赤にした
（**L-3**）。未追跡の `.rs` を置いて red、消して green を実測。設計 §13.10 に追記済み。
### fix(daemon): restore nine public items the split had hidden (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-b1-engine-wrap`

レビュー（`/code:pr-review-team` + Fable 監査）の指摘への対応。

### 🔴 公開面が 9 件、黙って crate 外から見えなくなっていた（Fable 監査）

`engine_wrap` は `lib.rs` で `pub mod` として公開されている。`BusKind` / `BusLineDest` /
`BusLineOp` / `SourceRoutingTarget` / `StreamGuard` / `StreamConfigSnapshot` /
`DEFAULT_{AUX,EFFECT,SUM}_BUS_POOL_PREFIX` は main では crate 外から見えていたが、
private な子モジュールへ移して `pub(crate) use` で再エクスポートしたため **E0603** になる。
**下流にまだ消費者が居ないので、全ゲートが緑のまま通過していた。**

🔴 **「分割前後で `^pub (fn|struct|…)` の集合を diff して同一」という私の検算は無効だった。**
宣言は `pub` のままで、**到達経路だけが失われる**からである。正しい検算は
**crate の外側からコンパイルすること** — 統合テストは外部 crate なので、そこで `use` できる
ことが到達可能性そのものの証明になる。

`tests/public_surface.rs` を 4 crate（daemon / sandbox / plugin-scan / vst3-host・計 143 項目）に
置いて main 時点の公開面を固定した。書く過程でもう 1 つ踏んだ: **統合テストでは `cfg(test)` が
真だが、参照先の lib は `--test` 無しでコンパイルされるので偽**。定義側の `#[cfg(any(test, X))]`
をそのまま写すと E0432 になる（`test` 項を落としてある）。

### module doc の 7 件が実態とずれていた（comment-analyzer）

最悪は `startup.rs` / `startup_instrument.rs` で、**可視性変更の説明がまるごと入れ替わって**いた
（前者が名指しした 2 関数はどちらも後者にある）。個別パッチではなく設計 §14 に開示ポリシーを
置き、21 モジュールへ一括適用した。**「N 行を除いて純粋な移動である」という件数の主張を禁じた** —
件数は doc が追随せず必ずずれる（書いている最中に自分でも 1 件ずらした）。
`tests/repo/module-doc-purity.spec.ts` で機械に突き合わせさせる。

### refactor(daemon): re-cut role.rs after the simplify review (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-b1-engine-wrap`

`/simplify` の altitude 指摘に対応。`role.rs` に同居していた**ストリーム/デバイスの
ライフサイクル型**（`StreamGuard` / `StreamConfigSnapshot` / `DeviceSwitchRequest` /
capture パス解決）166 行を、その主題そのものである `device_link.rs` へ移した。
併せて `engine_wrap/outproc_instrument.rs` を `outproc_instrument_slots.rs` へ改名
（crate 直下の同名 supervisor との衝突解消）、実態とずれた module doc 3 件を訂正、
`LoadedSample` を生成元の `playback.rs` へ移した。

🔴 **単一象限の unused 警告で import を消してはいけない。** デバイス群を移した後
`use role::*;` が default 象限で unused になったので消したところ、`outproc-*` 両 feature
象限が **E0432 で落ちた**（他象限のインラインテストが `super::ChildSlot` 等でこの glob 経由の
名前に到達している）。`#[allow(unused_imports)]` で戻し、理由をコメントに残した。
この赤は `check-cfg-matrix.sh ... | tail -2` で**終了コードが隠れて**おり、出力を読んで気づいた。

🔴 レビュー指摘の前提が誤っていた例: 「`LoadedSample` の消費者は `playback.rs` だけ」は
**`session.rs` が型名を書かずに（型推論で）使っている**ため誤り。名前の grep には掛からない。
### refactor(native): split output.rs — 2,587 to 322 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c2-output`

🎯 **#888 子 2 完了。`output.rs` が 2,587 → 322 コード行。** 9 ファイルすべて 500 以下
（`device.rs` 327 / `lines.rs` 258 / `line_program.rs` 293 / `render.rs` 406 /
`render_full.rs` 237 / `dsp.rs` 173 / `bus_topology.rs` 156 / `startup.rs` 477）。

**これで 6 ファイル中 3 つが目標達成**（`engine_wrap.rs` 424 / `session.rs` 439 / `output.rs` 322）。

### 🔴 引用の追随が 68 件 — 自動化しないと回らない規模

`output.rs` は dev サイトから **34 箇所 ×2 言語**引用されていた。手で直すのは非現実的なので、
**引用ブロックの中身から移動先を特定して header を書き換える**スクリプトを書いた
（scratchpad の `relocate-citations.mjs`）。段階的に強化した経過:

| 版 | 方式 | 解決 | 残り |
|---|---|---|---|
| 1 | 先頭行が**一意に**一致する候補ファイルを探す | 50 | 18 |
| 2 | 先頭 5 行の連続一致で照合 | +0 | 18 |
| 3 | 🔴 **可視性修飾（`pub(super) ` 等）を剥がして照合** | +16 | 2 |
| 手動 | シグネチャが複数行に折り返された 2 件 | +2 | 0 |

版 2 が 1 件も増やさなかったのが示唆的で、**問題は「先頭行の曖昧さ」ではなく「行そのものが
変わったこと」**だった。分割で `pub(super) ` が前置されるので、素の文字列比較では永久に一致しない。

### 移動の内訳

デバイス解決 / ライン機構 / ラインプログラム / render 経路 / 最大の render 1 関数 /
DSP ヘルパー（ゲイン・パン・加算）/ bus topology 検証 / 起動系。
可視性は第 9〜11 束で確立した手法（フィールドまで含めた一括付与 →
**コンパイラの指摘行を使った収束ループ**）で処理した。

**検証**: cfg 4 象限緑 / `cargo fmt --check` / **`cargo clippy --workspace -D warnings` 緑** /
`cargo test --workspace --lib` **476 passed** / `npm test` **2,445 passed**（不変）/ lint /
`docs:check` 948 引用 0 failed。


### refactor(daemon): split session.rs — 2,605 to 439 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c2-session`

🎯 **#888 子 2 の前半完了。`session.rs` が 2,605 → 439 コード行。** 7 ファイルすべて 500 以下
（`dispatch.rs` 411 / `dispatch_plugin.rs` 498 / `dispatch_transport.rs` 158 /
`params.rs` 289 / `params_plugin.rs` 413 / `run_loop.rs` 476）。

### 🔴 ここで初めて「純粋な移動」を超えた（owner 裁定 2026-09-12）

`handle_command` は **1,028 コード行の単一 `match` 式**だった。ファイルを分けても 1 つの式なので、
**行数だけでは閾値 500 を満たせない**。owner に諮り「**アームを関数へ切り出す**」を選んだ。

切り出した形（`dispatch_plugin.rs` / `dispatch_transport.rs`）:

```rust
pub(super) async fn handle_plugin_command(...) -> Option<Value> {
    Some(match method {
        "LoadPlugin" => { ... }     // アーム本体は 1 行も書き換えていない
        _ => return None,           // 該当しなければ親の match へ戻す
    })
}
```

🔴 **アーム本体は 1 行も書き換えていない。** 変わったのは (a) 関数シグネチャ (b) 呼び出し側の
3 行 (c) 早期 `return err(...)` を `return Some(err(...))` に包んだこと（**21 + 12 箇所**）。
**「既存テストの期待値を 1 つも変えていない」という検算は維持されている。**

(c) の包み直しは、第 11 束で確立した**コンパイラの指摘行を使うループ**でやった。
E0308 の行番号を抜いて該当行だけを包む処理を収束するまで回す。手で探すと必ず取りこぼす。

### 引用の追随 6 件

3 件は移動先が別ファイル、3 件は**範囲がファイル外**（`session.rs` が短くなったため
`range 2412-2413 is outside the file (2120 lines)`）。引用ブロックの中身から移動先を検索して
特定し、第 9 束で書いた再生成スクリプトで本文を同期した。**6 件とも着地先を目視で照合済み。**

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): finish splitting engine_wrap.rs — 6,418 to 424 code lines (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-ui-types`

🎯 **#888 子 1 完了。`engine_wrap.rs` が 6,418 → 424 コード行（閾値 500 以下）。**
baseline から削除した。子モジュール **21 本**、いずれも 500 以下。

第 12 束（最終）で移したもの: wire に載る公開型（`wire_types.rs` 130）/ `EngineWrap` の構築と
OOP プラグインの load 本体（`build_and_load.rs` 303）/ エフェクトバス stage の構築（`bus_stages.rs`）。

### 子 1 の全経過

```
6,418 → 6,014 → 5,585 → 5,127 → 4,409 → 3,655
      → 3,417 → 2,857 → 2,362 → 1,989 → 1,468 → 995 → 424
```

### 🔴 12 束を通して分かったこと

1. **「純粋な移動」は目標ではなく性質。** 相互依存があれば可視性の変更は避けられない。
   大事なのは**変更を最小に留め、それが residual に見えること**（第 4 束以降）
2. **必要な作業は対象の種類で変わる。** メソッド（1〜7 束）→ 自由関数（8 束）→
   構造体フィールド（9 束）→ トレイト（11 束）と、`pub(super)` を付ける対象が深くなった。
   元が 1 つの巨大モジュールだったので、内部の結合が可視化されていなかっただけ
3. 🔴 **境界の失敗には検出可能性の差がある。** 属性の分断は**コンパイルエラー**になるが、
   doc コメントの分断は **`cargo fmt --check` しか捕まえない**（第 4 束で実際に残った）
4. 🔴 **構文を正規表現で判定するのをやめ、コンパイラの指摘行を使う**方式に切り替えたら速くなった
   （第 11 束）。子 0 の **D9**（heuristic を改良せず基準を言語の正規実装に置く）と同じ転換
5. **cfg は定義側と一致させる** — 第 9・10 束で 2 度同じ誤りをした。
   毎回 `check-cfg-matrix.sh` を回していたので 2 回とも即座に検出できた

**検証**（全 12 束で毎回実施）: cfg 4 象限 + `clap-host` 単独 / `cargo fmt --check` /
`cargo test` / `npm test` **2,445 passed**（**12 束を通して 1 件も変わっていない**）/ lint /
`docs:check` 948 引用。


### refactor(daemon): move the OOP role abstraction into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-role-traits`

#888 子 1 の**第 11 束**。`OutProcRole` トレイトとその 2 実装、`StreamGuard`、
リトライ付き push（696 行）を `engine_wrap/role.rs`（483 コード行）へ。
🔴 **`engine_wrap.rs` が 1,000 行を切った**（1,468 → **995** コード行）。

### 🔴 トレイトの中では `pub(super)` が使えない

一括で `pub(super)` を付けたところ **E0449「visibility qualifiers are not permitted here」が 33 件**
出た。トレイト定義の本体とトレイト実装ブロックのメソッドは、**可視性がトレイト側で決まる**ので
修飾子を書けない。これまでの束は inherent impl（`impl EngineWrap`）だったので出なかった。

**対処**: 正規表現で構文を判定するのをやめ、**コンパイラの指摘行をそのまま使って**外した。
`cargo clippy` の出力から `role.rs:<行>` を抜き、その行の `pub(super) ` を削るループを回して収束させた。
同じ手法を「フィールドが private」47 件にも使い、エラーメッセージから
`struct 名 + フィールド名` を抜いて該当行だけに付けた。

**再エクスポート 2 件**: `DeviceSwitchRequest`（`main.rs` から）と `ClapPluginRole`（`session.rs` から）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the instrument slot types and plugin UI wiring out (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-instrument-slot-types`

#888 子 1 の**第 10 束**。instrument slot の型群とプラグイン UI の配線（606 行）を 2 ファイルへ
（`instrument_slot_types.rs` 392 / `plugin_ui_wiring.rs` 144）。
`engine_wrap.rs` は **1,989 → 1,468** コード行。

**可視性**: `pub(super)` を 63 箇所（第 9 束の知見どおり**フィールドにも**）。
`PluginUiWiring` 等 5 つは `outproc_effect.rs` / `outproc_respawn_guard.rs` からも使われるので
`pub(crate)` のまま、親から再エクスポート。

🔴 **再エクスポートの cfg を狭く書いて 1 象限落とした。** `outproc-instrument` と書いたが、
定義側は `any(outproc-effect, outproc-instrument)` だった。**cfg は定義側と一致させる** —
第 9 束と同じ誤りを繰り返した。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the effect slot types and env parsing into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-effect-slot-types`

#888 子 1 の**第 9 束**。`OutProcControl` / `EffectSlotEntry` / `BusKind` 系の型と
`ORBIT_*` 環境変数の解析（512 行）を `engine_wrap/effect_slot_types.rs`（390 コード行）へ。
🔴 **`engine_wrap.rs` が 2,000 行を切った**（2,362 → **1,989** コード行）。

### 🔴 構造体フィールドの可視性 — 第 8 束より一段深い

第 8 束は関数と型に `pub(super)` を付ければ済んだが、本束は **187 件が「フィールドが private」**
のエラーだった。親が構造体のフィールドを**直接触っている**ため、**フィールド 44 個**にも
`pub(super)` が要った（関数・型 30 個と合わせて 74 箇所）。

### 🔴 `session.rs` からの外部参照 — 再エクスポートが要った

`BusKind` / `BusLineDest` / `BusLineOp` / `SourceRoutingTarget` は **`session.rs` が
`crate::engine_wrap::` から名前で import** していた。親から `pub(crate) use` で再エクスポートした。

**cfg は定義側と一致させる必要があった**: `SourceRoutingTarget` だけ
`any(test, all(outproc-effect, outproc-instrument))` で他の 3 つと条件が違い、
まとめて 1 行にすると default ビルドで `unresolved import` になった。

### 🔴 引用の追随に新しい型が出た — 行番号ではなく**本文**が変わる

`pub(super)` を付けると**引用しているコード行そのものが変わる**。`--fix` は行番号しか直さないので
効かない。1 行ずつ置換したが**収束しなかった**（8 ラウンド回して残った）ので、
**引用ブロックの本文を実ファイルから再生成する**スクリプトを書いて解決した
（scratchpad の `resync-citations.mjs`）。差分は追加 40 / 削除 40 で対応しており、
**引用の追随以外の変更が無い**ことを確認済み。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the out-of-process slot helpers into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-slot-helpers`

#888 子 1 の**第 8 束**。`impl EngineWrap` の**外**にある自由関数・小さな型（598 行）を
2 ファイルへ（`slot_helpers.rs` 397 / `slot_errors.rs` 122）。
`engine_wrap.rs` は **2,857 → 2,362** コード行。

### 🔴 これまでの束と性質が違う — モジュールレベルの item

第 1〜7 束は `impl` の**メソッド**を動かしてきたが、本束は**モジュールレベルの item**
（自由関数・`enum`・`struct`・`type`）が対象。2 つの新しい対処が要った:

1. **`pub(super)` を 35 箇所**に付けた（モジュールレベル 22 + `impl` 内 13）。
   メソッドと違い、自由関数は親と兄弟の両方から名前で呼ばれている
2. 🔴 **`use slot_helpers::*;` を親に足す必要があった。** `pub(super)` は**可視性を上げるだけで、
   名前をスコープへ持ち込まない**。これが無いと `cannot find function ... in this scope` になる

### 🔴 `clap-host` 単独ビルドで import が未使用になった

このモジュールの item は全部 `#[cfg(any(outproc-effect, outproc-instrument))]` なので、
`clap-host` 単独だと**中身が空になり `use super::*;` が未使用**になる。CI は `-D warnings` なので
落ちる。`#[allow(unused_imports)]` を付けた（中身が feature 次第で空になるモジュールの定型）。

### rustfmt の折り返し

`pub(super)` を足すと行が長くなり、rustfmt が引数の折り返しを要求する。
該当パッケージにだけ `cargo fmt` をかけた（`git diff --stat` で**他のファイルが変わっていない**ことを確認済み）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the startup variants into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-start-lifecycle`

#888 子 1 の**第 7 束**。cfg feature ごとの `start*()` variant（645 行）を 2 ファイルへ
（`startup.rs` 292 / `startup_instrument.rs` 276）。
`engine_wrap.rs` は **3,417 → 2,857** コード行。

**可視性の変更 2 行**（E3′）: `resolve_outproc_both_buffer_frames`（親のテスト 3 箇所）と
`start_outproc_both_with_options`（親に残る `start_with_options`）。

### 🔴 抽出範囲を 2 度取り違えた — 複数行属性の罠

`#[cfg(all(\n  feature = …,\n  …\n))]` は**複数行に跨る 1 つの属性**である。
`pub fn` の行から遡って「`#[` で始まる行」だけを見ると、**属性の途中で切ってしまう**。
実際 2 度失敗した:

1. 終端を 5657 に取り、`))]` だけを親に残した → **`expected item after attributes`**
2. 開始を 5017（`pub fn` の行）に取り、`#[cfg(all(` 〜 `))]` を親に残した → 同じエラー

**正しい境界**は「doc コメントの先頭」から「次の item の属性が始まる直前」。
第 4 束の doc コメント分断（fmt でしか気づけなかった）と違い、**こちらはコンパイルエラーになる**
ので気づける。属性の分断と**コメントの分断は検出可能性が違う**。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move device switching and Link tempo into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-device-link`

#888 子 1 の**第 6 束**。オーディオデバイス切替と Link テンポ（317 行）を
`engine_wrap/device_link.rs`（242 コード行）へ。
`engine_wrap.rs` は **3,655 → 3,417** コード行。

**可視性の変更 2 行**（E3′）: `record_stream_config`（親の `finish_start` から）と
`record_device_switch_result`（親のインラインテスト 3 箇所から）を `pub(super)` に。

🔴 **第 5 束の教訓を仕組みにした**: 抽出範囲の開始を手で選ぶのをやめ、
**doc コメントと属性を遡って item の真の開始行を求める関数**で決めた。
第 4 束の doc コメント分断は、開始行を目で選んだために起きていた。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed（1 件を再アンカー）。


### refactor(daemon): move the instrument slots and plugin UI into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-outproc-instrument`

#888 子 1 の**第 5 束**。out-of-process インストゥルメントとプラグイン UI（839 行）を 2 ファイルへ。
`engine_wrap.rs` は **4,409 → 3,655** コード行（`outproc_instrument.rs` 455 / `plugin_ui.rs` 307）。

### 🔴 第 4 束の欠陥を見つけて直した — doc コメントを途中で切っていた

第 4 束で `load_outproc_plugin` の doc コメントを**分断**しており、頭 7 行が
`engine_wrap.rs` に item を持たない孤児として残っていた。第 5 束の `cargo fmt --check` が
その位置の重複空行を指摘して発覚した。

**原因**: 抽出範囲の開始を「doc コメントの途中の行」に取っていた。設計 E1 が
「属性と doc コメントを置き去りにするな」と警告していたのは**属性の付き替え**の話だったが、
**コメント自体の分断**も同じ型の失敗である。孤児コメントは**コンパイルエラーにならない**ので、
cfg 4 象限も `cargo test` も通ってしまった。

**検出したもの**: `cargo fmt --check`（重複空行）。**振る舞いを変えない欠陥は fmt しか捕まえない。**

### 可視性の変更 2 行（E3′ の適用）

- `teardown_outproc_instrument_resources` — 親のインラインテスト 2 箇所から呼ばれる
- `resolve_outproc_slot` — 兄弟 `plugin_ui.rs` から呼ばれる

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。
🔴 引用は**2 段階**で直した — 移動による 2 件と、**doc コメントを繋ぎ直したことで生じた 7 行ずれ**の 3 件。


### refactor(daemon): move the out-of-process effect slot lifecycle into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-outproc-effect`（base = `888-split-engine-wrap`）

#888 子 1 の**第 4 束**。out-of-process エフェクトの load / chain / replace / unload（799 行）を
3 ファイルへ:

| ファイル | コード行 |
|---|---|
| `engine_wrap/outproc_effect_slots.rs` | 297 |
| `engine_wrap/outproc_effect_chain.rs` | 216 |
| `engine_wrap/outproc_effect_replace.rs` | 217 |

`engine_wrap.rs` は **5,127 → 4,409** コード行。`excluded` 7,730 で不変。

### 🔴 3 ファイルに割った理由（設計 §13.9 の制約 1）

1 ファイルにまとめると **724 コード行**で閾値 500 を超える。§13.9 は「**分割で生まれる新ファイルも
同じ PR 内で 500 以下**」と定めている（「粗く割ってから細かく」の 2 段階は取れない）。
2 ファイルでも `slots` が **510 行**で 10 行超えたので、`load_outproc_effect_chain_impl` を
3 つ目へ分けた。

### 🔴 可視性の変更 3 行（E3′ の適用）

このグループは相互依存していて、**純粋な移動だけでは成立しなかった**。`pub(super)` を 3 つ:

| メソッド | 呼び出し元 | 理由 |
|---|---|---|
| `apply_outproc_effect_chain_with_timeout` | 親のインラインテスト `effect_rack_tests` | **親は子の private を呼べない** |
| `teardown_outproc_effect_slot` | 兄弟 `outproc_effect_slots.rs` | **兄弟同士も private は見えない** |
| `load_outproc_effect_chain_impl` | 兄弟 `outproc_effect_slots.rs` | 同上 |

**変更を必要最小の 3 行に留めた**ことが residual にそのまま出ている（`fn` → `pub(super) fn`）。
これは隠すべきものではなく、**レビュアーが読むべき行**である。

**residual**: moved+ 794 / moved− 795 / residual 60（doc コメント 40 行を除くと**約 20 行**）。
ゲート (i) は 1 行差で NG になったが、多重集合の照合で「**削除されたが追加されていない行は
上記 3 メソッドのシグネチャのみ**」= `pub(super)` を付けた行であり、**コードの欠損は 0** と確定した。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed（**5 箇所を再アンカー**）。


### refactor(daemon): move note dispatch and sample playback into child modules (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-notes-samples`（base = `888-split-engine-wrap`）

#888 子 1 の**第 3 束**。🔴 **純粋な移動**。2 グループを 2 ファイルへ:

- プラグインへのノート送出（CLAP / out-of-process instrument）→ `engine_wrap/notes.rs`（286 コード行）
- サンプル再生・トランスポート・オフライン render → `engine_wrap/playback.rs`（180 コード行）

`engine_wrap.rs` は **5,585 → 5,127** コード行。`excluded` は 7,730 で不変。

### 🔴 設計 E3「可視性の変更 0 件」には条件がある（第 3 束で実測）

「**子モジュールは親の private に到達できる**」は正しいが、**逆は成り立たない**。
親は子の private メソッドを呼べない。

`lock_active_notes`（`#[cfg(feature = "outproc-instrument")]` の private ヘルパー）を
`notes.rs` へ動かしたところ、`engine_wrap.rs` に残った 2 箇所とインラインテスト 2 箇所から
呼べなくなり **`outproc-instrument` の 2 象限が E0624 で落ちた**。

**残る側が使うヘルパーは移さない**（親へ戻す）のが正しい。`pub(super)` にするのは
「移動」ではなく「変更」なので residual に出る。設計文書に **E3′** として記録した。

### 🔴 ゲート (i) が発火した（`moved+ 602 ≠ moved− 603`）— 調査手順が定まった

1 行差だったので、**削除行と追加行を多重集合で照合**したところ
「**削除されたが追加されていない行 = 0 件**」で、コードは 1 行も失われていなかった。
新規追加 24 行はすべて新設モジュールのヘッダと `mod` 宣言。
git のブロック照合が空行を片方だけ移動と認めたための **false positive** である。

**正しい向きの false positive**（「怪しいから見ろ」と言われて見たら確定的に否定できた）。
この多重集合判定を**子 0b の `move-residual.sh` に組み込む**価値がある。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed（4 件を再アンカー）。


### refactor(daemon): move the bus-routing methods into a child module (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-bus-lines`（base = `888-split-engine-wrap`）

#888 子 1 の**第 2 束**。🔴 **純粋な移動**。

`device_dest_from_wire` / `render_dest_rejected` / `link_dest_rejected` / `set_bus_line` /
`set_bus_routing` / `set_source_routing`（元 6956-7451・496 行）を
`src/engine_wrap/bus_lines.rs` へ。**ヘルパー 3 本を一緒に動かした**のは、置いていくと
モジュールを跨いで `pub(crate)` 化が要り、それは「移動」ではなく「変更」だから。

| | before | after |
|---|---|---|
| `engine_wrap.rs` | 6,014 コード行 | **5,585** |
| `engine_wrap/bus_lines.rs` | — | 433 |
| `excluded` | 7,730 | **7,730** |

**residual**: 素の変更行 1,013 → moved+ 496 == moved− 496 → **residual 21**
（うち 15 行は新設 doc コメント = **実質 6 行**）。ゲート (i) 通過。

🔴 **引用が 14 件落ちた**（7 箇所 ×2 言語）。第 1 束と違い、**移動したコード自体が引用されていた**ので
4 箇所は**ファイルパスごと** `bus_lines.rs` へ向け直した。残り 3 箇所は行番号のずれ。
`docs:check` は**先頭行しか照合しない**ので、末尾が関数シグネチャの途中で終わっていた 1 件を
引用元の文脈まで読んで確認した（「関数コメントが機構を一文で言い切っている」を見せる意図なので
doc コメント + シグネチャで正しい）。

**検証**: cfg 4 象限緑 + `clap-host` 単独 / `cargo fmt --check` / `cargo test` 58 passed /
`npm test` **2,445 passed**（不変）/ lint / `docs:check` 948 引用 0 failed。


### refactor(daemon): move the stats/health accessors out of engine_wrap.rs (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `888-c1-stats`（base = `888-split-engine-wrap`）
**担当**: 設計 = Fable / 実装・検証 = main

#888 子 1 の**第 1 束**。設計は `docs/design/888-child1-first-extraction.md`。
🔴 **純粋な移動**（本文は 1 行も書き換えていない）。

- `impl EngineWrap` の 40 メソッド（`clap_post_peak` 〜 `output_channels`・元 8972-9550）を
  **子モジュール** `src/engine_wrap/stats.rs` へ。`use super::*;` + `impl EngineWrap { … }` で包む
- 🔴 **可視性の変更 0 件**。子モジュールは親の private フィールド・private `use` に到達できる
  （兄弟モジュールにすると `pub(crate)` 化が多数必要で、それは「移動」ではなく「変更」）
- **インラインテスト mod は動かさない**（コード行に数えられず目標に寄与しない）。`excluded` は 7,730 で不変
- `mod stats;` は**先頭ではなく impl の閉じ括弧の直後**に置いた。先頭だと行番号が +2 ずれて
  dev サイトの引用が約 20 箇所動く

**結果**: `engine_wrap.rs` **6,418 → 6,014** コード行 / `stats.rs` 408（500 以下なので baseline 無し）。

**residual**（§5.1a の新ルールで初の実測）:

```
素の変更行 1,176  →  moved+ 579 == moved− 579  →  residual 18
```

うち 11 行は新設モジュールの doc コメントなので**実質 7 行**。移動した 579 行は 1 行も residual に出ていない。
ゲート (i) `moved+ == moved−` 通過。

**検証**（main が sandbox 外で実行）: `cargo fmt --check` / `clippy --all-targets -D warnings` /
**`scripts/check-cfg-matrix.sh` 4 象限緑** + `clap-host` 単独 / `cargo test -p orbit-audio-daemon` /
`npm test` **2,445 passed**（前と同数 = 期待値不変）/ lint / `docs:check` 948 引用 0 failed。

🔴 **`docs:check` は一度落ちた**（4 件 = 引用 2 箇所 ×2 言語）。ソースを動かすと引用が必ず動く。
`--fix` は行番号を合わせるだけなので、**新しい行を grep で探し、着地先の中身を目視で照合してから**
書き換えた（構造体が `}` で閉じ、メソッドが `}` で閉じることを確認）。
ずれ幅が −578 と −580 の 2 種類あるのは、`mod stats;` の挿入位置の前後で変わるため。

🔴 **cfg 4 象限を手書きループで確かめようとして壊した**（zsh は未クォートのパラメータを単語分割
しないので `--features clap-host` が 1 引数として渡り、全象限が偽の FAIL になった）。
CLAUDE.md が「ループを手書きしない」と記録しているとおりで、`scripts/check-cfg-matrix.sh` を使った。


### test: add a file-size ratchet for Rust and TS sources (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `888-file-size-ratchet`
**担当**: 設計 = Fable / 実装 = Sonnet subagent（🔴 **Codex CLI は一度も起動していない**。
`codex:rescue` のラッパが自分で実装した。`codex-companion status` の `recent` が空で
`latestFinished` が null であることで確認）/ 検証・裁定 = main

#888 子タスク 0「仕組みだけ入れる（振る舞い不変）」。設計は
`docs/design/888-file-size-ratchet-design.md`。ソースは1行も変えていない。

**やったこと**:

- `tests/repo/code-lines.ts`: 「コード行」を数える純関数 `countCodeLines`。行単位の状態機械
  （通常 / 文字列 / raw 文字列 / テンプレートリテラル / ブロックコメント）で、空行・コメント
  専用行を除き、複数行の文字列やテンプレートリテラルの内側は中身に関わらず数える。Rust の
  `#[cfg(test)] mod`（`#[cfg(all(test, ...))]` を含む）はブロックごと除外する。終端で異常状態
  （閉じていない文字列・test mod）のまま終わったら例外を投げる（迷ったら数える側に倒す）。
- `tests/repo/file-size-targets.ts`: `git ls-files -z`（`:(glob)` magic 付き）で測定対象を列挙。
  Rust は `rust/crates/**/*.rs` から `tests/` `examples/` `benches/` `build.rs` `src/**/tests.rs`
  を除いたもの、TS は `packages/*/src/**/*.ts`。真空防止（除外適用前の生の列挙件数で判定）。
- `tests/repo/file-size-baseline.json`: 閾値超過ファイルだけを列挙した baseline（25件・Rust 15 /
  TS 10）。**実装のカウンタが出した現寸をそのまま登録**した。
- `tests/repo/file-size-ratchet.spec.ts`: 既存3本（`worklog-size.spec.ts` /
  `dsl-e2e-coverage.spec.ts` / `planning-issue-state.spec.ts`）と同型のラチェット+honesty。
  baseline を超えた成長は red、baseline が古くなった（消えた・実際より緩い）ら red。
- `tests/repo/code-lines.spec.ts`: `countCodeLines` の機能テスト（設計 §9.1 の F-1〜F-19 相当）。
- `tests/repo/file-size-targets.spec.ts`: 列挙そのもののテスト（設計 §9.2 の L-1 / L-2）。
  **レビューで未実装が判明して後から足した**（下記）。

**設計からの逸脱・補足**:

- 真空防止の閾値判定は、`tests/` 等の除外を適用した**後**の件数ではなく、`git ls-files` の
  **生の**結果に対して行うよう修正した。除外後の件数（Rust 95件）で判定すると、正当な除外で
  100件を割り、真空防止が誤って発火する。
- `listMeasuredFiles` に既定値付きの第2引数（pathspec 差し替え口）を足した。L-2 が真空防止の
  発火そのものを確かめるための注入口で、既定の挙動は変わらない。
- 🔴 **baseline の数値は設計文書 §5.1 の試作値と 25 件中 8 件で食い違い、main が「実装側が正しい」と
  裁定した**（設計 §11 の反証条件がそのまま発火したケース。設計文書の表は実装値に差し替え済み）。根拠:
  - **TS 10 件**: TypeScript 自身の**パーサ**を独立オラクルにして測り（`ts.createSourceFile` の葉
    トークンが占める文字を印し、JSDoc ノードは除外）、**実装の値と 10/10 完全一致**。
    `extension.ts` は **2,779**（試作の 3,004 は正規表現リテラル未対応による過大）
  - **Rust**: main が独立に `#[cfg(test)] mod` の除外レンジを列挙し 4 件中 3 件で一致。唯一ずれた
    `engine_wrap.rs` は **main の列挙の側のバグ**だった（Rust のフォーマット文字列の中の `{` `}` を
    brace として数え、`mod outproc_load_error_test_support` を 12279 行で早期終了。実際の終端は
    12557 行で、差の 278 行が実装との差と正確に一致した）

**🔴 レビューで塞いだ穴 — 「仕事が成功した時に開く」型**:

初回実装には設計 §4.1・§9.2 が名指しで要求していた **L-1（列挙に既知の代表ファイルが含まれることの
検査）が無かった**。真空防止のしきい値（Rust/TS とも 100 件）だけでは、pathspec が `:(glob)` magic を
欠いて `src/` 直下を落とす事故を**検出できない** — TS は非 glob でも 109 件（> 100）返るためである。

いまは `extension.ts` が baseline にあるため honesty 検査が偶然 red にするが、**子 4/5 でそのファイルを
分割して baseline から外した瞬間にその防御は消える。** main が再現した fail-before: baseline から 2 件を
外し（= 分割後の姿）`:(glob)` を落とすと、**23 ファイルが黙って測定対象から消えたままスイートは緑**
だった。L-1 を足した後は、同じ条件で red（exit=1）になることを main が確認している。

**検証**（すべて main が sandbox 外で実行。委譲先の緑は根拠にしていない）:
`npx vitest run --dir tests --config vitest.config.ts tests/repo`（**36件緑**）/
`npm test`（**166 files・2424 passed / 76 skipped**）/ `npm run lint`（緑）/
`npm run docs:check`（948 引用・0 failed）。**既存テストの期待値は 1 つも変えていない。**

変異検証（main が実行・5 件すべて red → restore 後 緑・baseline は byte 一致）: baseline 値の
+1 / −1 / エントリ削除 / 架空パス追加 / `threshold` を 600 へ。

**`/simplify` で適用した整理**（4 観点を並行レビュー・PR #894）:

- `code-lines.ts`: `pendingBuffer: Array<{isCode:boolean}>` → `pendingCount: number`。
  バッファに積まれる行は `isTestCfgAttrLine` / `ATTRIBUTE_LINE` / `MOD_OPEN_LINE` のどれかに
  **完全一致**した行だけで、行コメントや末尾コメント付きの行は一致しない。よって `isCode` は
  常に `true` で、持つ意味が無かった（main が正規表現を読んで検算）
- `file-size-ratchet.spec.ts`: 2 つの `it` が独立に呼んでいた `measureAll()` を `beforeAll` へ集約。
  同じ PR の `file-size-targets.spec.ts` が既に測定を共有しており、**同一 PR 内で同じ問題に 2 つの
  書き方が混在**していた。`beforeAll` を選んだのは、`measureAll()` が throw した時に collection
  エラーではなく**ファイル名付きのテスト失敗**として出るため
- `code-lines.spec.ts`: 3 つの `it` が共有していた `F-18` ラベルを `F-18a/b/c` に分けた
  （設計 §9.1 の F-18 は 1 行で 3 シナリオを束ねているので重複自体は仕様に忠実だが、識別できない）

**却下した指摘 1 件**（altitude 観点・`listMeasuredFiles` の第 2 引数が #887 の `__*ForTest` と同型という指摘）:

1. #887 が問題視しているのは**出荷される** `extension.ts` の裏口。`tests/repo/file-size-targets.ts`
   はテスト基盤そのもので出荷されない。既定値付き引数は通常の引数化である
2. 提案された「真空防止を純関数へ切り出す」は、**`listMeasuredFiles` がそれを呼んでいるかの配線が
   検証されなくなる**（CLAUDE.md が名指しで警告している形）
3. 指摘の「該当言語の pathspec が無ければチェックが素通りする」は事実誤認。ループは
   `Object.keys(MIN_FILES_PER_LANG)`（固定の `{rust, ts}`）を回しており、片方が欠ければ
   `0 < 100` で throw する（穴ではなくガードが働いている姿）

**リファクタ後の再検証**（main が実行）: 変異 5 件すべて再び red / `code-lines.ts` の
`commitPending` を殺す変異 2 種も red（除外側 4 件・code 側 2 件）/ `npm test` 2424 passed /
lint・`docs:check`・`typecheck:e2e` 緑。**baseline 25 件の値は 1 つも変わっていない**
（honesty 検査が `baseline == 実際` を要求するので、これが振る舞い保存の検算になる）。

**`/code:pr-review-team`（4 名）+ Fable 設計監査（並行）のラウンド 1**:

Critical 0。Important 5 件・Minor 17 件を main が集約し、**故障の向き**で仕分けた。

🔴 **修正前に置いたポリシー**（CLAUDE.md「横断的関心事は先にポリシーを書いてから一括適用」）:

> ラチェットの信用は「数え方が正しい」ことに依存する。数え方の誤りは **(a) 多く数える = 安全** /
> **(b) 少なく数える = 穴** に分かれ、§3.3 は (b) を禁じている。しかし heuristic を含む字句解析で
> (b) を*構成的に*排除することはできない。したがって **heuristic を改良するだけで済ませず、
> 独立したオラクルで全件を検算する**形に変える。

**直した 6 件**:

| # | 内容 |
|---|---|
| **F-1** | 🔴 **`code-lines-oracle.spec.ts` 新設** — TypeScript の**パーサ**を独立オラクルにして TS 全 132 件を検算。既知の差は shebang 1 件のみで許容リストに明示（設計 D9・§3.4） |
| **F-2** | **入れ子テンプレートリテラルで黙って少なく数える**穴を塞いだ。`templateStack` で `${…}` 置換の brace 深さを追う |
| **F-3** | 真空防止を **pathspec エントリ単位**にした。従来は lang 合計だったので、将来足すエントリが `:(glob)` を忘れて 0 件でも既存 132 件が支えて緑だった |
| **F-4** | ラチェット判定を純関数 `findViolations` / `findHonestyProblems` に切り出し、**合成データで §5.2 (a)〜(f) を網羅**。実データの 2 つの `it` は同じ関数を呼び続ける（配線を失わない） |
| **F-5** | throw メッセージに**壊れ始めた行番号**を入れた（設計 §8.1 が要求していたが未実装だった） |
| **F-6** | baseline JSON の**キー辞書順**を honesty 検査で強制（設計 §5.1 が要求） |

**直さなかった 3 件**（いずれも**安全側**に倒れ、現リポジトリに該当 0 件）:
`=>` 直後の正規表現（**throw する**）/ BOM のみの行（多く数える）/ `#[cfg(test)]` と `mod` の間の空行（除外されず多く数える）。

🔴 **Fable 監査が main の検証の穴を突いた**（設計 §13.8 に反映）: main の敵対ケース 4 件は
すべて「ブロックを塊のまま動かす」形だった。塊を崩す 2 型は residual をすり抜ける —
**(E) 1 文を関数間で移動**（振る舞いが変わるのに residual 0。git は 20 英数字以上なら 1 行でも
移動と認める）/ **(F) 消して 2 回足す**（複製が見えない）。対策として §13.4 に
`moved+ == moved−` と「短い moved ブロックは residual 扱い」の 2 ゲートを追加。
Fable はまた **TS オラクルを baseline の 10 件ではなく測定対象 132 件全件**に適用して
131/132 一致を確認しており、main の検証範囲が狭かったことも示した。

**設計文書の訂正**（main）: §3.1 の「誤判定は必ず例外で red になる」という**安全性の主張を撤回**
（偶数個のクォート / backtick で黙って通る経路が実在）・§4.2「Rust 96 件」→ **95 件**
（文書自身の算式も実測も 95）・§13.8〜§13.10 を新設・決定表に **D9 / D10** を追加。

**検証**（すべて main が sandbox 外で実行・委譲先の緑は根拠にしていない）:
`npm test` **167 files・2445 passed / 76 skipped**（+21 件）/ lint・`docs:check`（948 引用 0 failed）・
`typecheck:e2e` 緑 / `tests/repo` **57 件**。

**マージ前ゲート**（main が sandbox 外で実行）: `npm run build` ✅ / `bundle-macos.sh` + 
`rack-child --lib -- --ignored` **3 passed** + `--lib` **16 passed** ✅ /
**実機 gated E2E 45 passed / 1 skipped / 0 failed** ✅ / **cold install 2 passed** ✅ /
CI 3/3 pass ✅。

🔴 **実機 E2E は 1 回目が「走っていなかった」。** sandbox 内で `mktemp` が
`Operation not permitted` になり、しかも `| tail` のせいで **exit code 0 に化けていた**
（タスク通知も「completed (exit code 0)」と報告した）。出力の中身を読んで気づき、
sandbox 外で `set -o pipefail` 付きで回し直した。**終了コードと通知だけでは区別がつかない。**

### 🔴 owner 裁定: 分割束の上限は residual で数える（2026-09-12）

> フルレビュー 40 回はちょっと作業として重すぎる

`BUNDLE_BRANCH_WORKFLOW.md` に **§5.1a** を制定した。分割（純粋な移動）の束は
**residual 行数で 1,500 を判定**し、加えて **(i) `moved+ == moved−`**（複製・移動先の作り忘れ）と
**(ii) K 行未満の短い moved ブロックは residual 扱い**（1 文の関数間移動）の 2 ゲートを課す。
**最終防波堤は「既存テストの期待値を 1 つも変えていない」。**

根拠は実測（設計 §13.6〜§13.8）: 実素材の抽出で **686 変更行 → residual 2 行（0.3%）**。
敵対ケース 4 件は全部捕まえるが、**Fable 監査が見つけた抜け道 2 型**（1 文の関数間移動 = residual 0 /
消して 2 回足す = 複製が見えない）は追加ゲートが要る。

**見込み**: #888 の子 1〜3 は素の変更行なら約 40 束、residual なら **8〜9 束**。
fail-before / pass-after を main が再現: 入れ子テンプレート **4 → 5**・throw メッセージの行番号・
**オラクルが状態機械の破壊 2 種を検出**・honesty の `(f)` 分岐の変異が **red**（修正前は緑）・
baseline 変異 5 件がリファクタ後も全件 red。**baseline 25 件の値は 1 つも変わっていない。**

### refactor/test(engine): fold the #889 review rounds — env containment, wiring coverage, a trigger (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `878-engine-spawn-without-path`（PR [#889](https://github.com/signalcompose/orbitscore/pull/889)）
**担当**: レビュー = `/simplify` 4 観点 + pr-review-team 4 体 + Fable 監査（並行）/ 裁定と fix = main

#878 の修正本体（1 つ前の項）に対するレビュー 3 波を畳んだ記録。**本項が無かったのは
`simplify-commits-still-need-worklog` の再発**で、Fable 監査に指摘されて足している。

#### 1. 🔴 `ELECTRON_RUN_AS_NODE` が daemon とプラグイン子まで漏れていた（altitude）

`spawnDaemon()` は `env` を渡しておらず全継承だった。Rust 側は `Command::new` の際に
`env_clear` / `env_remove` を**一切呼んでいない**（実測 0 件）ので、**第三者のプラグイン
ホストまで**届いていた。Node ↔ ネイティブの唯一の受け渡し地点に `daemonEnv()` を置いて断つ。

🔴 **根拠は「自分が足したものを自分の出口で戻す」**に限定した。Fable 監査の指摘どおり、
「ホスト由来の変数を第三者へ渡さない」を根拠にすると**不十分**である — 拡張ホストの env には
`VSCODE_*` や他の `ELECTRON_*` も乗っており（VS Code 自身は端末を起こす時
`sanitizeProcessEnvironment` で `/^(ELECTRON|VSCODE)_.+$/` を丸ごと落とす）、ここは素通しする。
そこまでやるなら別の設計判断。

#### 2. 🔴 純関数は守られ、**配線が無防備**だった（変異で実証）

| | 結果 |
|---|---|
| `env: daemonEnv(process.env)` → `env: process.env`（呼び出し側が helper を迂回） | **62 件すべて緑** |

`consumerless-code-is-unprotected` そのもの。既存の実 spawn ハーネス（`#484 D1` の argv
recorder）に env のダンプを足し、**子プロセスの env を直接見る**テストを追加。同じ変異で
**red**、復元で **green（63/63）** を実走で確認した。

🔴 「`ELECTRON_RUN_AS_NODE` が無いこと」だけを見ると env ごと空にする実装でも通るので、
**他の変数が届いていること**（`PATH=`）まで見る。

#### 3. 🔴 cold install テストに**実行の引き金が無かった**

`ORBIT_GATED_COLD_INSTALL` を参照する npm script も workflow も**存在しなかった** —
`a-test-that-exists-may-never-run` の形で、#878 の修正を守る唯一のテストが誰にも
走らされない位置にあった。

- `npm run test:e2e:cold-install`（`pretest:` で build → `.vsix` パッケージ）を追加
- CLAUDE.md のマージ前ゲートに**無条件の 1 行**として追記

レビュアーは `release.yml`（macos-14）への追加を提案したが、**GitHub の macOS runner には
VS Code が入っておらず音声デバイスも無い**。`test:e2e:gated` と同じく**手元が唯一の実行経路**
であることを明記した。

#### 4. 一次ソースで裏を取った 3 件

| 問い | 結果 |
|---|---|
| Electron の `runAsNode` fuse を VS Code が将来切ったら偽の「起動した」になるのでは（silent-failure レビュー） | **切れない**。VS Code 自身の CLI が `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI"` で動き（`Contents/Resources/app/bin/code`）、拡張ホストの fork（`out/bootstrap-fork.js`）も依存する。切れば `code` が壊れる |
| N-API prebuild が読めたのは偶然か | **偶然ではない**。ローダは `node-gyp-build` ではなく **`pkg-prebuilds`** で、**N-API の時は Electron 判定へ入らず** `node-napi-v7.node` に決定論的に落ちる（`pkg-prebuilds/bindings.js`） |
| 素の node との意味論差は無いか | **1 つある**。`ELECTRON_RUN_AS_NODE` の子では asar フックが生きており、`fs` が「`.asar` で終わるディレクトリ」をアーカイブ扱いする。engine は利用者の与えたパスを読むので、`ELECTRON_NO_ASAR=1` を併記して差を消した |

#### 5. 直した事実誤り

- コメントの「VS Code **1.104 系**」→ **1.134.0**（この機の実測値。出典を足したコミットで版を間違えていた）
- `resetExtensionEngineTestState()` が `__set*ForTest` の**全部ではなく 4 本**であること、残り 2 本の
  使い手、**完全性を強制する仕組みが無い**ことを明記（誤解を与える記述だった）
- `656-release-design.md` の**7 箇所**が「PATH の `node`」のまま（§2 現在地 / §9 データの通り道 /
  §10 grep 貼付 / §14 PR-C2 / §15 確信度 / §16 裁定待ち / §6.3 冒頭）。`IMPLEMENTATION_PLAN` と
  `USER_OUTCOMES` の PR-S-C2 行にも注記。**裁定を更新したのに追従していない層**が残る
  （`one-layer-of-the-spec-lags-the-ruling`）を、今回は 7 層で踏んでいた

#### 6. 🔴 自分で作った CI の赤

`/simplify` で `extension.ts` の 1 行を畳んだ後、`docs:check` を回し直さずに push し、
**CI で 74 件**落として初めて気づいた。`pre-push` に `docs:check` を足して仕組みで止めた
（🔴 **rust ゲートより前**に置く — 後ろだと rust を触らない push で走らない）。

#### 採らなかった指摘

| 指摘 | 裁定 |
|---|---|
| 遅延クラッシュが auto-start 経路でしか通知されない | #533 からの**既存構造**で本 PR 起因ではない。#890 へ切り出し |
| ユニット 3 本を 1 本に畳む | 畳むと最初の `expect` で止まり残り 2 つの結果が見えない。回帰ゲートには独立した失敗信号の方が価値がある |
| 拡張の `package.json` に `engines.node` を足す | **逆効果**。VS Code 同梱の Node を使う以上、利用者に node を要求しない方が正しい |
| `selectRootPids` での teardown | `--user-data-dir` が `mkdtemp` で一意なので blanket `pkill` の故障モードが成立しない |
| 起動フラグ列の共通定数化 | 45 本の gated suite 本体を触る。#888 へ |
| `which claude`（`extension.ts`）も同じ PATH 依存 | 同じ故障クラスだが node ではなく、直すには設計が要る（別 issue 候補） |

`npm test` **2,354 passed / 0 failed**・lint 緑・`typecheck:e2e` 緑・引用 **948 / 0 failed**・
**cold install 2/2**（`npm run test:e2e:cold-install` で実走）。実機 gated は main と同一の
既知 red 1 件（`ph654`・PR #884 が修正済み）。

Part of #878

---

### fix(extension): start the engine with VS Code's own Node instead of PATH (#878) (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `878-engine-spawn-without-path`（base = `main`）
**担当**: 実測・実装・検証 = main

#883 の cold install 検証（4.0.0 のリリース前倒し確認）の副産物として、**#878 が確定で再現する条件を
特定した**ので直した。

#### 何が壊れていたか

`extension.ts` は engine をこう起動していた:

```ts
child_process.spawn('node', [enginePath, ...args], { ... })
```

**`node` を PATH から引いている。** Finder / launchd から起動された VS Code の PATH は `/etc/paths` の
最小構成で、`nodenv` / Homebrew で node を入れている環境（珍しくない）ではそこに node が無い。
engine は `spawn node ENOENT` で起動せず、**症状は「エンジンが起動しない」だけ**なので原因が PATH だとは
利用者にまず分からない。

#878 は「VS Code のシェル環境解決に救われて**実際には通った**」と記録されていた。本日、**通らない条件**を
実測で特定した:

| 起動のしかた | 結果 |
|---|---|
| `Contents/MacOS/Code`（Finder 相当） | 音が出る |
| `bin/code`（CLI ラッパ）+ node の無い PATH | 🔴 **`spawn node ENOENT`** |
| `bin/code` + `SHELL` あり + node の無い PATH | 🔴 **同じく起動しない** |

CLI ラッパ経由だと VS Code は**ログインシェルの環境解決を省く**（端末から引き継ぐ前提）。
`code .` を、nodenv を初期化しないログインシェルから叩けば同じ条件になる。

#### 直し方 — 🔴 裁定を更新した（Q-656-8b）

`docs/design/656-release-design.md` §6.3 は同じ問題に対して **(A) `process.execPath` +
`ELECTRON_RUN_AS_NODE=1`** と **(B) node を同梱** を挙げ、**2026-09-03 に owner が B を裁定**していた。

**その裁定の前提は 2026-09-10（#827）で変わっている。** 当時の配布物は VSCodium フォークの `.app` で、
指定された同梱先も `.app/Contents/...` だった。フォークを畳んで**拡張線は `.vsix` のみ**になった今、
`.vsix` は Node を持っているホスト（VS Code）の中で動くので、B は 50MB 超の同梱と署名対象 +1 を払って
**ホストが既に持っているもの**を二重に運ぶことになる。

→ owner 裁定（2026-09-12・**Q-656-8b**）: **拡張線は A**。B は**ネイティブ `.app` 向けとして残る**
（借りる VS Code が無いのでそちらでは A が使えない）。配布物が違うので矛盾しない。

#### A が成立することの実測（仮定していない）

| 確かめたこと | 結果 |
|---|---|
| `process.execPath` は素のままで Node か | ❌ **ならない**（`Unable to find helper app` で落ちる）→ `ELECTRON_RUN_AS_NODE=1` が要る |
| VS Code 同梱の Node 版 | **24.18.1**（本リポジトリの要求は `>=22.0.0`）✅ |
| ネイティブアドオン（`@julusian/midi` の N-API v7 prebuild）が読めるか | ✅ **素の node と同じ**（port count 14 で一致）。`electron-` prefix の prebuild は無いので事前に疑ったが、実際には解決された |
| PATH 依存の spawn が他に無いか | ✅ **1 箇所だけ**（`fork()` も Rust 側からの node 起動も無し） |

#### 積んだテスト

- `tests/vscode-extension/engine-spawn-runtime.spec.ts`（3 本・ユニット）— 何を spawn したか。
  「絶対パスであること」だけを見ると `/usr/local/bin/node` 決め打ちでも通るので、**`process.execPath`
  そのもの**であることと `ELECTRON_RUN_AS_NODE=1` を見る
- 🔴 `tests/e2e/vsix-cold-install-gated.spec.ts`（2 本・`ORBIT_GATED_COLD_INSTALL=1` でゲート）—
  **dev host はこの層を構造的に通らない**（`dev-host-is-blind-to-the-packaged-artifact`）。
  空の extensions-dir へ `.vsix` を入れ、`--extensionDevelopmentPath` **無し**で起動して
  **capture WAV の RMS まで**見る。**strict**（CLI ラッパ + node の無い PATH + `SHELL` 無し）が #878 を、
  **finder**（app 本体を直接起動）が #873 を守る

#### 変異検証（実走・自己申告ではない）

| | 結果 |
|---|---|
| 変異（`process.execPath` → `'node'`・env を戻す）→ 再パッケージ → strict | 🔴 **red**（`🛑 Engine process error: spawn node ENOENT`） |
| 復元 → 再パッケージ → 2 本とも | ✅ **green**（19.4 s） |

#### ゲート

`npm test` **2,350 passed / 69 skipped / 0 failed**・`typecheck:e2e` 緑・lint 緑・
引用 948 / 0 failed・**cold install 2/2**（strict / finder）。

dev サイトの 6 箇所は `--fix` では直らなかった（行番号ではなく**中身**が変わったため）ので、
引用ブロックと本文・mermaid ラベルを手で追従させた。

Closes #878
### fix(dsl): make the missing-output diagnostic read the whole chain (#883 束 S・レビュー round 1) (Sep 12, 2026)

**Date**: 2026-09-12
**ブランチ**: `883-explicit-output-semantics`（PR [#885](https://github.com/signalcompose/orbitscore/pull/885)）
**担当**: レビュー = pr-review-team 4 体 + Fable 監査（並行）/ 裁定と fix = main

束 S のレビュー round 1。**5 体の指摘を 4 つの機構に畳んで一度に当てた**（指摘単位のローカル
パッチはしない）。

#### 1. 診断がチェーンの途中の出口を読めていなかった（Important・**3 体が独立に到達**）

`analyzeMissingOutput()` のレシーバ判定は、**「行がこのシーケンスのものか」と「どのメソッドか」を
1 本の正規表現で兼ねていた**。名前の直後しか見ないので、チェーンの途中に置いた出口が消える。
`.output(` だけが `chainReceiver` でチェーン対応しており、**非対称がそのまま残っていた**のが証拠。

実測（fix 前・5 件とも red）:

| 譜面 | 出ていた診断 | 正しい診断 |
|---|---|---|
| `kick.audio("k.wav").send("verb", -12)` | `output-missing`（"it will be silent"） | `dry-not-routed` |
| `kick.gain(-3).master` | `output-missing` | なし（裸形 master は正当な出口） |
| `kick.gain(-3).drums` | `output-missing` | なし |
| `kick.send("verb",-12).send("drums",-6)` | `dry-not-routed` | なし（2 本目が sum） |
| `kick.audio("k.wav").play(1)`（出口なし） | **なし** | `output-missing` |

最後の 1 行は逆方向の取りこぼしで、**発火点の `play(` 自体がチェーン途中だと 1 件も警告されない**。
レビュアー 2 体はここに触れていない — main が probe で列挙して見つけた。

**直し方**: レシーバの 2 つの仕事を分けた。行の帰属は `\b<name>\b`、メソッドは
レシーバを含まないモジュール定数（`OUTPUT_CALL` / `MASTER_ACCESS` / `SEND_CALL` / `PLAY_CALL` /
`MIDI_CALL`）。**バス名のパターンも文書ごとに 1 度だけ**組み立てる（打鍵ごとに走る診断なので、
シーケンス数 × 行数 × バス数 の再コンパイルを避ける）。1 行に 2 つ置いた `send` を両方読めるように
なったのは副次効果。

#### 2. 「無音へ倒す」時に痕跡を残す（Important 1 + Minor 1）

§2.6 は「表現できない routing は無音」だが、**仕様上の無音と不変条件違反は区別が付かなければ
ならない**。ライブ中に「書き忘れ」と「バグ」を切り分ける手段が要る。

| 箇所 | 直す前 | 直した後 |
|---|---|---|
| `output.rs` `SourceDestCell::encode` の範囲外 fallback | `debug_assert!` のみ。`[profile.release]` は `debug-assertions` を上書きしていない（既定 false）ので**出荷ビルドでは何も残らない** | `eprintln!` を併記（`encode` の呼び手は制御プレーンのみ・実測） |
| `output.rs` `decode` | — | **据え置き**。RT コールバック（`collect_source_feeds`）から呼ばれる。唯一の書き手が `encode` なので追える旨をコメントに |
| `sequence.ts` `instrumentSourceRoutingTarget()` の inconsistent route | 無言で `{kind:'none'}` | 既存の `logSkipOnce()` を再利用（per-reason dedup 付き） |

#### 3. wire の版を上げた（Fable 監査・②-4）

本 PR で `SetSourceRouting.target` が非互換になった（`null` / 生文字列を受け付けない）のに
`PROTOCOL_VERSION` は scaffold 以来 `'0.2'` のままだった。**版を上げないとずれは handshake ではなく
最初の `SetSourceRouting` まで露見せず、その間 instrument は旧既定の master で鳴り続ける**
（孤児 daemon を掴んだ時に実際に起きうる）。`'0.3'` へ。不一致は `daemon-client.ts` の
両経路で loud に落ちる（実装済みの機構・新設ではない）。

#### 4. 記録と前提条件

- `tests/vscode-extension/output-code-action.spec.ts` が**ディスクにあるのに一度もコミットされて
  いなかった**（pr-test-analyzer）。D8 の quick fix 配線が無防備だった。コミットに含めた
- `InsertBusStage::with_output_target` / `with_sends` に前提条件を明記（`[Rack]` 既定の stage に
  対しては前者が黙って捨て、後者が panic する）
- `resolveDispatchChannel()` の skip を **LinkAudio 抜き**で押さえる unit を 1 本追加（既存の
  1 本は `global.linkAudio()` を先に呼んでおり、LinkAudio ゲートと区別が付かなかった）

#### D15 の変異表（Fable 監査が実走・各 1 行変異 → 対象 test → `git checkout --` で復元）

設計 §2.6 の 6 箇所（+ `#[default]`）を Master に戻すと red になることの記録。**テストは効いており、
欠けていたのは記録だけ**だった。

| 変異 | red になった test |
|---|---|
| `encode` の範囲外 fallback `NONE` → `MASTER`（`output.rs`） | `source_dest_cell_roundtrips_every_destination_and_defaults_invalid_values` |
| `decode` の `_ => None` → `Master` | 同上 |
| `SourceDest` の `#[default]` を `None` → `Master` | 同上 |
| `default_bus_line_ops` → `legacy(Master, &[])` | `tagged_event_with_unattached_bus_is_consumed_without_reaching_hardware` |
| Bus 位置なしの `map_or(Discard, …)` → `Hardware` | `unregistered_source_bus_is_silent_…` |
| `Link(_) => Discard` → `Hardware` | `unwired_link_source_is_silent_…` |
| slot 解放時の `store(None)` → `store(Master)` ×2（`engine_wrap.rs`） | `r1_replace_migrates_all_unit_destinations_then_resets_every_freed_unit` |

#### 採らなかった指摘と理由

| 指摘 | 裁定 |
|---|---|
| 変数参照の `send(v, -6)` で `dry-not-routed` が沈黙する（silent-failure-hunter Important） | **誤検知**。`extractDeclaredBusNames()` は `scanVarDeclarations` で `var v = mix.aux(...)` も拾う。実測で `dry-not-routed` が出る |
| `_insertBus` が一度確保すると解放されない（Minor） | 本 PR 以前からの性質。プール上限そのものは #663（撤廃）の土俵なので別 |
| LinkAudio で `output-missing` が Error → Warning（Minor） | **仕様どおり**。owner の収束条件 3 が「Warning + quick fix」と明示している |
| legacy `SetBusRouting` に暗黙 master が 1 箇所残る（Fable ③-2） | **本 PR では触らない**。#852 以降 DSL からは到達不能な legacy wire コマンドで、正しい翻訳は「拒否」か「出口なしの line」かの判断が要る。別 issue（下記）に切り出し、コマンドの撤去と一緒に閉じる |
| `kick.output(1)`（render のみ）でエディタと実行時が逆を向く | #598 周辺。別 |

`npm test` **2,383 passed / 74 skipped / 0 failed**・lint 緑・`cargo test --workspace`
**627 passed / 0 failed**・引用 948 / 0 failed。

Part of #883

---

### feat(dsl)!: drop the implicit master terminal — the score text is the whole truth (#883 bundle S) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: 実装・実機検証完了（レビュー前）
**版**: 🔴 **4.0.0 / `DSL_VERSION` 2.0**（破壊的変更）
**担当**: 実装 = Codex（`gpt-5.6-sol` / effort **xhigh**）/ 裁定と検証 = main

#883 の**振る舞いを変える**半分。束 0+C（PR #884）の上に載る。

#### 閉じた 4 実体（§0.1）— **1 箇所ではない**

| 実体 | 変更 |
|---|---|
| **A** `program()` の暗黙終端 | 合成を削除（`[rack]` の前置は残す） |
| **B** バス無し audio の直接描画 | `resolveDispatchChannel()` に skip。🔴 **`isNoteSequence()` の早期 return より後ろ**（前だと MIDI が無音・#282 の再発） |
| **C** daemon のバス既定ライン | `legacy(Master, [])` → **`[Rack]`（無音）** |
| **D** instrument の source routing | `SetSourceRouting.target` を**明示 3 値**（`none` / `master` / `bus`）へ。🔴 **一方通行の wire 変更** |

#### 🔴 横断規則を 6 箇所へ適用（main の審査で要求したもの）

> routing 状態が「書かれていない」「表現できない」「失われた」いずれかの時、その信号はどこにも加算されない。
> **master へ倒すことは最下層に暗黙 master を作り直すこと**である。

| 箇所 | 実装 |
|---|---|
| `SourceDestCell::encode` | `Bus(_) \| Link(_) => Self::NONE` ← **Fable の監査も見ていなかった箇所** |
| `SourceDestCell::decode` | `_ => SourceDest::None` |
| `SourceDest::default()` | `#[default] None` |
| `FeedDest` 変換 ×2 | `None => Discard` / `Link(_) => Discard` |
| slot 解放時 | `store(SourceDest::None)` ×2 |

**除外は master トラック自身の device 出口のみ**（owner 裁定で 1,2 固定＝定数なので規則の定義域外）。

#### 🔴 実機 gated が 4 件落ちた — **すべて譜面・harness の誤り**（実装は無変更）

| 失敗 | 原因 |
|---|---|
| 既存 `sum-bus insert across restart` | **移行漏れ** — 束 S で「出口を書かない sum は無音」になったので `sum("drum").output()` が要る |
| X1 / X4 / X5 | 🔴 **`LOOP()` は追加ではなく置換** — `LOOP(a)` の次の `LOOP(b)` が a を止める。根拠は `calculateLoopDiff()`（`process-statement.ts:679`）→ `stopSequences(toStop)`（`:777`） |

**main が先に潰した仮説**（unit で実測）: `ref883.output()` は skip されず（`{kind:'hardware'}`）、
4 イベントをスケジュールし、`loop()` も throw しない。**TS 層は正しい**。
崩れたのは「では実機の無音は実装のせい」という推論の方で、**`LOOP` の意味論**が抜けていた
（個別に `loop()` を呼ぶ unit では原理的に再現しない形）。

Codex は同じ誤用があった **X8 も落ちる前に先回りで修正**し、**静的回帰テストも追加**した
（`gated-assertion-hygiene.spec.ts:557`）。

⚠️ **ただしその検査は名指しの 4 ファイルしか守らない。** 3 本の新 fixture が揃って踏んだ性質なので、
**一般化する価値がある**（例: gated fixture 内に `LOOP(` が 2 回以上現れたら red）。別途扱う。

#### 実機 gated の実測（main が sandbox 外で）

```
Tests  45 passed | 1 skipped (46) | 0 failed

[#883 X1] explicit-reference + orphan RMS: 0.08701663328815765      ← 漏れれば 2 倍
[#883 X2] omitted=0.0870166332954772  explicit=0.08701663328808863
[#883 X3] sendRms=0.0436116233054862  plainRms=0.0870166332927243
          ratio=0.5011872058848396                                   ← 期待 10^(-6/20)=0.5012
[#883 X4] reference + unterminated-sum member RMS: 0.087016633295434
[#883 X5] withSilentInstrument=0.08701663329662541  refRms=0.08701663329662539
```

🔴 **X3 が #883 の実害そのもの**（`send(sum)` の dry が master へ二重に届く）**を実測で塞いだ証拠**。
🔴 **X5 は小数点以下 16 桁が一致** — 出口を書かない instrument は基準の音に **1 bit も足していない**。

#### ゴールの収束条件

1 ✅（X1/X4/X5）/ 2 ✅（X3）/ 3 ✅（X6）/ 4 ✅ / 5 は次（4.0.0 リリース）。

---

### feat: require explicit output routing across TS, wire, and the Rust runtime (#883) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ 束 S 実装

出口を書かない audio / instrument と、出口を持たない sum / aux を無音にした。routing の
未設定・表現不能・喪失は master へ倒さず discard する 1 規則に統一し、wire の source routing は
`none` / `master` / `bus` の明示 3 値になった。MIDI は audio の skip より先に hardware dispatch を
確定するため、#282 の挙動を維持する。

編集時には出口無しを Warning (`output-missing`)、aux send だけを Information
(`dry-not-routed`) として `.play()` に示し、どちらにも `.output()` の quick fix を提供する。
実機 gated E2E X1 / X3 / X4 / X5 / X6 / X8 は追加のみ行い、sandbox 外で実行する。

この互換性のない変更に合わせ、拡張を **4.0.0**、`DSL_VERSION` を **2.0** にした。
`ENGINE_VERSION` は独立軸なので **2.0.0** のまま。

### fix: make send() require a destination in both implementations (#883 round 2) (Sep 12, 2026)

**Date**: 2026-09-12
**Status**: ✅ ラウンド 2 収束（PR #884）

#### 🔴 縮小レビューが **fix 起因の Critical** を捕まえた

ラウンド 1 で置いたポリシーを、main が**片翼にしか適用していなかった**。

| | ガード |
|---|---|
| `Sequence.send()` | ✅ あり |
| `MixerBusHandle.send()` | ❌ **無い** |

レビュアーが実際に走らせて wire の中身まで示した:

```
mix.sum('drum').send(db: -6)
  → processArguments が [undefined, {db:-6}] に整形（ラウンド 1 の修正）
  → MixerBusHandle.send(undefined, ...) → resolveDest(undefined) → {kind:'master'}
  → setBusLine に output(master, thru:true, -6dB) が**追加で 1 本**
  → 既存の直結と合わせて **master へ二重に鳴る**
```

🔴 **#883 が消そうとしている「dry が master へ漏れる」の派生形を、修正が自分で作っていた。**

#### 直し方 — 契約を 1 関数へ

```ts
// audio-line.ts — この 1 関数が両方の send() の契約
export function assertSendDestination(value: unknown, call: string): void
```

`send()` の宛先は **`output()` と違い必須**（どこにも送らない send は無い）。両方の `send()` が
これを呼ぶので、**片翼だけに書けるコードでなくなった**。

あわせて `resolveDest` / `send` のエラー文言が常に「null」と決め打ちしていたのを、
**実際に来た型**を出すよう直した（数値や真偽値を渡した人に嘘の情報を与えていた）。

#### 変異検証（main が実走）

| 変異 | 結果 |
|---|---|
| `MixerBusHandle` のガードを削除 | **red**（1 件） |
| 文言を "null" 決め打ちに戻す | **red**（3 件） |
| restore | **green**（4 件） |

#### 波及

Codex がラウンド 1 で書いたテスト 2 箇所が**旧文言**を期待していたので整合させ、
「なぜ `send()` は `output()` と文言が違うのか」と**この Critical への回帰検査であること**を
コメントに残した。

#### 🔴 実機 gated が 1 回 flake した（規律どおり再実行して確定させた）

1 回目: `#611 E2E-3` が **`ENGINE_LOCK_CONTENTION`** で落ちた。

```
[warning] ENGINE_LOCK_CONTENTION: engine lock contention (1 total);
          a block was silently zero-filled — this self-heals next block
```

これは **`severity=warning` として設計された事象**（`rust/crates/orbit-audio-daemon/tests/protocol.rs:1204`）
だが、`mem:stderr-is-classified-as-error`（engine の warn は全部 ERROR 行）により
`expectNoNewErrors` が ERROR として数える。

**`mem:implementation-right-oracle-wrong`（赤を実装のせいにする前に同じテストを走らせる）に従い、
断定せず再実行** — load 5.62 → 2.76 で**緑**。孤児 daemon 0 / 残存 dev host 0 も確認済み。

🔴 **残る論点（この束とは独立）**: `expectNoNewErrors` は「新規 ERROR が 0」を要求するが、
CLAUDE.md の規律は「ERROR 件数は固定 500 行窓なので**厳密等価にしない**（`<=`）」。
`ENGINE_LOCK_CONTENTION` は負荷次第で正当に発生するので、**分類器が warning を ERROR へ畳んでいる**
ことを別途扱う余地がある。

#### 検証（すべて main が sandbox 外で実測）

```
npm test    2364 passed | 68 skipped | 0 failed
lint 緑 / docs:check 948 引用 0 failed
実機 gated  39 passed | 1 skipped | 0 failed
[#883 X2] omittedRms=0.08701663329564219  explicitRms=0.08701663329564278
```

---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
- [2026-07](../archive/WORK_LOG_2026-07.md)
- [2026-08](../archive/WORK_LOG_2026-08.md)
- [2026-09（前半・09-01〜09-11）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1 を含む
