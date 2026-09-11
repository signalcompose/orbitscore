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

### release: tag v3.0.0 — the extension line is frozen as stable (#827) (Sep 11, 2026)

owner 裁定 2026-09-10（#827・正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12）の凍結線に到達した。
以降のネイティブ OrbitStudio.app は新ライン。

#### 裁定（2026-09-11）— §12.7 が未決として残していた 2 件

| 未決だったもの | 裁定 |
|---|---|
| バージョン | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離は新ラインで（§12.3）。`release.yml` は `v*` トリガーのままで変更不要 |

残り 3 件は裁定待ちではなく解消済み: SC 削除 = #840 / gated ハーネス = #831 / README = #842。
Marketplace publish は「行わない」（owner 2026-09-10）で、`PUBLISH_MARKETPLACE` 未設定のため
publish ステップは skip される（`gh variable list` で実測）。

#### タグ直前の実測（main `61f947d7`）

| 確認 | 結果 |
|---|---|
| `npm test` | **2,347 passed / 67 skipped / 0 failed** |
| `npm run lint` | 緑 |
| `check-citations.mjs`（素で実行） | **944 / 0 failed** |
| `.vsix` の依存ゲート | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| 出荷物の `scsynth` / `supercollider` 参照 | **0** |
| タグ照合ガード（#853） | `v3.0.0` vs `3.0.0` → `{ok: true}` |
| マージ前ゲート（`orbit-effect-rack-child`） | `--ignored` **3 passed** / 通常 **16 passed** |

#### 🔴 凍結は 1 日延びた — cold install がブロッカーを出した

タグを打つ直前に cold install を回したところ、**`.vsix` が activate すらできなかった**（#873）。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
```

**この時点でビルド・ユニット 2,338 件・lint・引用・`release.yml` の post-package ゲート全項目が
緑だった。** npm workspaces が拡張の実行時依存をルートへ hoist し、`vsce package` が同梱する
`extension/node_modules` には `@types` と `undici-types` しか入っていなかった。engine 側には
同型の事故が 2 回あり対策もあったのに（WORK_LOG 6.119 / 6.422）、**拡張自身の依存だけ無防備**だった。
MCP サーバ（#388）が入った時点から壊れていた可能性が高い。

**dev host は構造的にここを見ない**:

| 経路 | dev host（`--extensionDevelopmentPath`） | cold install |
|---|---|---|
| daemon の解決 | `monorepo-release`（リポジトリの `rust/target/release`） | **`extension-bundle`** |
| 拡張の実行時依存 | ルートに hoist されたものが walk-up で見つかる | **`.vsix` に入っているものだけ** |

#874 で直し、**ゲートを「宣言を数える」から「出荷物の中で実際に解決する」へ変えた**。
同一の壊れたツリー（sdk の推移依存 `express` を削除）に対して旧ゲートは exit 0、新ゲートは exit 1。

#### 今日 main に入ったもの

| PR | 内容 |
|---|---|
| #868 | ルーティン docs 追従 **9 本**を 1 本に統合（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866） |
| #870 | `loop-quantize` の 1ms レース（CI を間欠的に赤くしていた真因） |
| #871 | 拡張 3.0.0 / DSL 1.2 + リリース直前の README 2 件 |
| **#874** | **`.vsix` が activate できなかったブロッカー** + それを守るゲートとテスト |
| #876 / #872 | 上記の docs 追従 |

#### 新ラインへ送ったもの

| # | 内容 |
|---|---|
| #875 | esbuild でバンドルし、copy-a-node_modules の機構ごと退役させる |
| #877 | cold install を再実行できる gated spec にする（#138 を #656 から切り離す） |
| #878 | `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` のフォールバックが無い |
| #849 | ネイティブ macOS OrbitStudio の設計 |


#### 収束条件の最終確認 — **公開された資産**で cold install

ローカルビルドではなく **GitHub Release からダウンロードした `.vsix`**（利用者が受け取るもの）で検証した。

| 検証 | 結果 |
|---|---|
| 資産の版 vs タグ | `3.0.0` = `v3.0.0` |
| 依存ゲート（`check-vsix-bundled-deps.mjs`） | engine 5/5・extension 2 宣言 + **3 specifier 解決** |
| `scsynth` / `supercollider` の参照 | **0** |
| activate | `Cannot find module` **0 件** |
| MCP サーバ | **4 秒**で listen |
| engine ログ | `ERROR:` **0 行** |
| **音** | capture **34.09 s**・非ゼロ **24.2%**・**RMS 0.038183**・peak 1.133490 |

🔴 **起動は Finder 相当の最小 PATH で行った**
（`/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin`）。
`extension.ts:2000` の `spawn('node', …)` が PATH 依存なので（#878）、シェルから起動すると
この条件を検証したことにならない。

**`--extensionDevelopmentPath` は使っていない。** dev host はリポジトリの
`rust/target/release` から daemon を引き、依存もルートの hoist 先から walk-up で見つけるため、
**`extension-bundle` 解決と同梱依存のどちらも通らない**。#873 はまさにそこに隠れていた。

#### 🔴 署名・公証の実測（#881 を起票）

同梱ネイティブバイナリ 8 個は **ad-hoc 署名のみ**（`linker-signed` / `TeamIdentifier=not set`）。

| 確認 | 結果 |
|---|---|
| `spctl -a -vv -t execute` | **rejected** |
| quarantine を付けて実行 | **exit 137（SIGKILL）**+ 「Apple は…検証できませんでした」ダイアログ |
| VS Code の `--install-extension` 後の `xattr` | **0 件** → 実行 exit 0 |
| `ditto -x -k` / `/usr/bin/unzip` で展開 | **quarantine が伝播する** |

**動いているのは、VS Code の `.vsix` 展開が quarantine を付けないから**であって、署名が
通っているからではない。他社実装への暗黙の依存で、#878（`spawn('node')` が VS Code の
シェル環境解決に救われている）と同じ形。ネイティブ `.app` のラインでは逃げ道が無く必須になる。

### docs: follow the 3.0.0 / DSL 1.2 bump into the docs the bump missed (PR #871 追従) (Sep 11, 2026)

ルーティン docs 追従。追従元は PR [#871](https://github.com/signalcompose/orbitscore/pull/871)
（マージコミット `56c34c3`・head `d5decc2`）。**実装とテストは触っていない**（docs と dev サイトのみ）。

#871 は正本 3 箇所（`packages/vscode-extension/package.json` = 3.0.0 /
`packages/engine/src/version.ts` の `DSL_VERSION` = 1.2 / `ENGINE_VERSION` は据え置き）を動かし、
`CLAUDE.md`・root `README.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`・dev サイトの
`version.ts` 引用 4 箇所を追従させた。**引用ブロックは更新されたが、その引用を説明している
散文が 1.1 / 2.1.0 のまま残っていた**ページがある。

| 直した箇所 | 何が食い違っていたか |
|---|---|
| `docs/core/INDEX.md:5` | 表紙が `DSL_VERSION 1.1` / 拡張 `2.1.0` を名乗ったまま |
| `README.md:55` | `Post-2.0 (shipped on main, extension 2.1.0)` |
| `sites/dev{,/en}/orientation/architecture-overview.md` | 引用ブロックは `1.2` なのに、直下の箇条書きが `DSL spec 1.1` / 拡張 `2.1.0` |
| `sites/dev{,/en}/decisions/adr-002-dsl-v3-pivot.md` | 同上（Sources 行が `DSL_VERSION = '1.1'`・導入の「ちなみに」段落が v1.1 / product 2.0.0） |
| `sites/dev{,/en}/editor/vscode-architecture.md` | 冒頭と Sources の `package version 2.1.0` |

いずれも「3 つは別軸で同期しない」（`docs/design/656-release-design.md` §4.4）を本文に書き足して、
次に読む人が #871 と同じ取り違え（WORK_LOG の「私は一度これを間違えた」）を繰り返さないようにした。
dev サイトは日英両方。frontmatter の `verified-against` / `verified-at` を更新した 3 章（6 ファイル）は、
Note 行に「**バージョン節だけ**追従した」と明記して、章全体を再検証したと読まれないようにしてある。

**直さずに報告に回したもの**（仕様の判断であって追従作業ではない）:

- `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md:5` の docmeta が `"version":"1.1"`。`DSL_VERSION` は 1.2 に
  なったが、**1.2 の spec 文書は存在しない**。spec 正本をどう扱うかは owner 裁定事項
- `docs/specs-v2/SESSION_LOG_SPEC_v1.md:51` のメタヘッダ例が `"dslVersion":"1.1"`。同じ行の
  `"engineVersion":"1.1.0"` は #871 と無関係に古く（§5-5 で version 自動同期は #276 deferred と明記）、
  片方だけ直すと実在しないサンプルになる
- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:3,5` の `Product version: OrbitScore 2.0.0`。#871 で
  `CLAUDE.md` は「Product: 拡張 3.0.0」に変わったので、「product version」という軸を残すのかが未決

### docs: PR #870 のドキュメント追従レビュー — 追従不要（Sep 11, 2026）

マージ済み PR #870（`f56e02e7d03306f7d811b2d2edac9814baa38ee5`）に対するドキュメント追従レビュー。

**ドキュメントの追従は不要**と分類した。差分 2 ファイルの内訳は
`tests/core/loop-quantize.spec.ts`（モックの時計を固定するテストのみの変更）と
`docs/development/WORK_LOG.md`（PR 自身が記載済み）で、出荷物・DSL の意味論・MCP の表面・
OrbitStudio の評価経路のいずれにも差分が無い。`nextQuantizedTime()` の実装は無変更で、
`sites/dev/scheduling/transport.md:388-410` の記述と `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:316-354`
は現行実装と一致している。

ただし**実機 E2E の穴**は残っている。この PR が固定した LOOP quantize の起動境界は、
`tests/e2e/dsl-e2e-coverage.spec.ts` の baseline 上で今も未カバーである
（`loop`/`quantize` が seq・global 両方に、`transport-loop` が構文側に載ったまま）。
詳細と再現手順は本コミットの PR 本文に記載した。**baseline は編集していない。**

### fix(release): ship the extension's own runtime deps so the .vsix can activate (#873) (Sep 11, 2026)

🔴 **凍結版リリースのブロッカー。** cold install（#138・ゴールの最終段）で発見した。
素の VS Code に `.vsix` を入れると、**拡張が activate せずに落ちていた**。

```
Error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'
  at Object.<anonymous> (.../local.orbitscore-3.0.0/dist/extension.js:74:22)
```

#### 原因 — npm workspaces の hoisting

`packages/vscode-extension/package.json` は `@modelcontextprotocol/sdk` と `zod` を実行時依存として
宣言しているが、どちらも npm workspaces が**リポジトリルートへ hoist** する。`.vscodeignore` は
`../../**` と `../*/**` でパッケージ外を全部落とすので、`vsce package` が同梱する
`extension/node_modules` は **`@types` と `undici-types` の 2 つだけ**だった（実測）。

`require` は遅延ではない: `dist/extension.js:74` → `require("./mcp-server")` →
`dist/mcp-server.js:51-53` がトップレベルで SDK と zod を要求する。よって activate が無条件に落ちる。

#### engine 側では 2 回起きていた事故が、拡張側だけ無防備だった

| 出典 | 欠けた依存 | 症状 |
|---|---|---|
| WORK_LOG 6.119 (Jun 17, 2026) | `@julusian/midi` / `uuid` / `ws` | engine が MIDI 初期化で落ちる |
| WORK_LOG 6.422 (Aug 30, 2026) | `yaml` | #654 の実機ゲートで発見。engine が最初の evaluate で落ちる |
| **#873** | **`@modelcontextprotocol/sdk`** | **activate() がそもそも走らない** |

対策の `scripts/install-engine-deps.sh` は **engine の依存しか見ていなかった**。ロジックを
`scripts/install-bundle-deps.sh` へ抽出し、engine と拡張の両方がそこを通るようにした（DRY）。

#### 置き場所が `dist/node_modules` なのには理由が 2 つある

1. **`vsce package` はパッケージ直下の `node_modules` を無条件に除外する。**
   `.vscodeignore` に `!node_modules/**` と書いても**上書きできない**（実測）。
   `engine/node_modules` や `dist/node_modules` のような入れ子は特別扱いされず普通に入る
2. **Node の解決順で最初に当たる。** `dist/mcp-server.js` から見て `dist/node_modules` は
   1 つ目の候補なので、パスの書き換えが要らない

パッケージ直下へ入れると**パッケージング自体が壊れる**: 依存が hoist 先とローカルの 2 箇所で
解決できるようになり、`vsce` の依存探索が 1 つの `.vsix` エントリに 2 つの元パスを出して
`the following files have the same case insensitive path` で失敗する。だから
`vsce package` には **`--no-dependencies`** を付け、探索そのものを止めてある。

#### CI が捕まえられなかった理由と、足したゲート

`release.yml` の post-package 検証は `packages/engine/package.json` の依存しか突合していなかった。
同型の検査を**拡張自身の依存**にも足した（`extension/dist/node_modules/<dep>` の実在確認）。
この PR は `packages/vscode-extension/**` と `release.yml` の両方を触るので、
release smoke が本 PR 上で実際に `.vsix` を作ってこのゲートを通す。

#### 検証 — cold install で音が出るところまで

空の `--extensions-dir` に `.vsix` を入れ、**`--extensionDevelopmentPath` を使わず**
インストール済み拡張として素の VS Code を起動し、MCP だけで駆動した。

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件 |
| MCP サーバ | ✅ 2 秒で listen |
| daemon の解決 | ✅ `/private/tmp/orbcold-e-*/local.orbitscore-3.0.0/engine/bin/darwin-arm64/orbit-audio-daemon` |
| 評価 | ✅ `ok` |
| **音** | ✅ capture 36.10 s・非ゼロ **46.7%**・**RMS 0.053537**・peak 1.133490 |

🔴 **daemon が拡張バンドルから解決された**ことが、cold install でしか通らない経路の確認にあたる。
dev host（`--extensionDevelopmentPath`）はリポジトリの `rust/target/release` を引くため、
`extension-bundle` 分岐を一度も通らない。#138 がここまで「⏳ Pending」だった穴がこれ。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed
（`release.yml` に行を足したので `signal-chain/index.md` の `184-193` を `204-213` へ再アンカー。
着地先が標準プラグイン同梱ゲートであることを目視で確認済み）。

Closes #873


#### `/simplify` の反映（4 エージェント並行・#874）

| 指摘 | 対応 |
|---|---|
| `--prune` / merge の分岐を**どの呼び出し元も使っていない**（両方 `--prune`） | 削除。`dist/node_modules` へ寄せる前の探索の残骸だった。常に置き換える形に一本化 |
| `install-bundle-deps.sh` が `DEST_DIR` を作らないので wrapper が `mkdir` を持たされていた | `mkdir -p "$DEST_DIR"` にした |
| `release.yml` の依存検査ループが engine / extension で重複（同型が計 3 箇所） | 1 ループに畳んだ。`"<label>:<package.json>:<vsix 内の node_modules>"` の表を回す |
| `npm run build` のたびに `npm install` が 2 回走る | 宣言した依存の spec を `node_modules/.orbitscore-bundle-deps.json` に刻み、一致していれば skip。実測で 2 回目以降は `already current — skipping install` |
| 同じ JSON を `node -e` で 2 回読んでいた | 1 回に畳んだ（書き出しと同じ pass で名前も出す） |
| レジストリへの往復 | `npm install` に `--prefer-offline` を足した |
| esbuild という深い解が検討された形跡が残らない | **#875** を立て、`install-bundle-deps.sh` のヘッダから指した |

**見送ったもの**:

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部（CLAUDE.md の手動ゲート・root の `pretest:e2e:gated`・dev サイト）が名前で呼ぶので残す必要がある。`install-extension-deps.sh` を消すと、**「なぜ `dist/node_modules` なのか」という実測 2 件の知識**を `package.json` の 1 行に添える場所が無くなる。名前付きファイルに置く方の価値を取った
- **`scripts/orbitstudio/make-local-release.sh` が同じ機構を再実装している** — git 管理外（未追跡）で、`scripts/orbitstudio/` ごと畳む予定（正本 §12.7 の 3）。なお `extension/node_modules/$DEP` を見ているので、**黙って壊れた成果物を作るのではなく loud に落ちる**（安全な側）

#### 整理後にもう一度 cold install を通した

| 確認 | 結果 |
|---|---|
| activate | ✅ `Cannot find module` 0 件・MCP は 4 秒で listen |
| 評価 | ✅ `ok` |
| 音 | ✅ capture 15.04 s・非ゼロ **46.5%**・**RMS 0.052550**・peak 1.133490（前回と同一） |

CI ゲートの**負の確認**も取れている: 修正前の `.vsix` を展開したディレクトリに同じループを当てると
`::error::extension runtime dependency '@modelcontextprotocol/sdk' missing` で exit 1 になった。


#### レビューラウンド 1（4 レビュアー + Fable 監査を並行）と、その fix

**Critical 2 件はどちらも main（自分）の手が原因だった。**

| # | 誰が | 指摘 |
|---|---|---|
| C1 | silent-failure-hunter | `/simplify` で 2 つのループを 1 本に畳んだ際に足した `|| {}` が、**`dependencies` を読めない時に「何も検査せず緑」**を作っていた。旧 engine 版には `|| {}` が無く `TypeError` → `set -e` で落ちていた。`package.json` の typo 1 つで、この PR が塞いだ欠陥クラスがゲート側に復活する |
| C2 | comment-analyzer | 出典の `#209` / `#654` が**無関係の issue**（#209 = LinkAudio の feature、#654 = playhead の修正）。既存コメントの誤帰属を「3 回刺さった」という目立つ表へ増幅していた |

**Fable が Sonnet 4 体と直交して見つけたもの:**

- ゲートは**宣言された最上位の依存しか見ない**。sdk の推移依存 17 個が欠けても緑のまま MCP が落ちる
- **出荷版が lockfile と乖離**（sdk 1.29.0→1.30.0 / zod 4.4.3→4.6.2 / yaml 2.8.3→2.9.0 / midi 3.6.1→3.8.1）。**テストしたのと別の版を凍結版として出す**ことになっていた
- **ゲート自身を守るテストが無い**。同型の child バイナリのゲートには `bundled-child-binaries.spec.ts` があり、台帳照合とゲートの bash 実走の両方をやっている
- `release.yml` の `pull_request.paths` に install スクリプトが無く、それだけを触る PR は smoke が走らない

一方 **`vsce` の挙動についての実測クレームは、vsce 2.32.0 のソースで裏付けが取れた**（`collectAllFiles` が `.vscodeignore` 適用**前**に `node_modules/**` をハードコード除外し、そのパターンは入れ子にマッチしない）。ただし「無条件」は `--no-dependencies` 下でのみ真。

#### 設計パス（指摘ごとのローカルパッチにしない）

> **ゲートは「宣言を数える」のではなく「出荷物の中で実際に解決できるか」を検査する。
> チェックリストが空になったら「依存が無い」ではなく「読み方を間違えた」として loud に落とす。
> そしてゲート自身を守るテストを同じ PR に置く。**

`scripts/check-vsix-bundled-deps.mjs` を新設（前例: `check-release-tag-version.mjs`）。`release.yml` の
インライン 14 行はその呼び出し 1 行になり、**C1 の `|| {}` ごと消えた**。検査は
`createRequire(<出荷物内の実 require 元>).resolve(<実 specifier>)` で、解決した各パッケージの
`dependencies` を再帰的に辿る（コードは実行しない）。

#### 受け入れ検証（main が sandbox 外で実走・自己申告は根拠にしない）

🔴 **同一の壊れたツリーに対する新旧の比較**（`dist/node_modules/express` = sdk の推移依存を削除）:

| ゲート | 結果 |
|---|---|
| 旧（宣言された最上位ディレクトリのみ） | `all declared dependencies present — PASS` / **exit 0** |
| 新（出荷物内で実際に解決） | **exit 1** |

**検出力が名目でなく実際に増えている。**

壊し方を 3 通り試して全部 exit=1（原因を名指し）: 宣言依存の削除（`zod`）/ **推移依存の削除（`express`）** / engine 依存の削除（`yaml`）。

C1 の変異: `dependencies` → `dependencyes`（#873 と同型の typo）で **exit=1**、戻して **exit=0**。

lockfile 固定の実測 — 7 件すべて一致し、`uuid` は罠を回避（`packages/engine/node_modules/uuid` の
**13.0.2**。`node_modules/mermaid/node_modules/uuid` の 11.1.1 ではない）:

| 依存 | lockfile | 出荷 | 修正前 |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | **1.29.0** | 1.30.0 |
| `zod` | 4.4.3 | **4.4.3** | 4.6.2 |
| `uuid` | 13.0.2 | **13.0.2** | — |
| `yaml` | 2.8.3 | **2.8.3** | 2.9.0 |
| `@julusian/midi` | 3.6.1 | **3.6.1** | 3.8.1 |

cold install をやり直し（**Finder 相当の最小 PATH** で起動）: activate ✅ / `Cannot find module` 0 件 /
MCP 4 秒 / `evaluate` ok / **engine ログの `ERROR:` 0 行** / capture 16.04 s・非ゼロ **42.7%**・
**RMS 0.050784**。

`npm test` **2,347 passed / 67 skipped / 0 failed**（+9）・lint 緑・`typecheck:e2e` 緑・
引用 944 / 0 failed（`release.yml` の行が動いたので 4 件を再アンカーし、着地先が
「実 Gain テスト」と「標準プラグイン同梱ゲート」であることを目視確認。散文の行参照も追従させた）。

#### 見送り・切り出し

- **wrapper 2 本を 1 本に畳む** — `install-engine-deps.sh` は外部が名前で呼ぶので残す必要があり、
  `install-extension-deps.sh` を消すと「なぜ `dist/node_modules` なのか」という実測 2 件の知識を
  置く場所が無くなる
- **#877**: cold install を再実行できる gated spec にする（#138 を #656 へ吸収する計画から切り離す —
  #656 はネイティブ `.app` 配布で別物・後の話）
- **#878**: `extension.ts:2000` の `spawn('node', …)` が PATH 依存で `process.execPath` の
  フォールバックが無い。実測では VS Code の shell 環境解決に救われて通ったが、**出荷の前提が
  他社実装の詳細に乗っている**
- **#875**: esbuild でバンドルして本機構ごと退役させる（宣言されていない import は今の機構では
  原理的に見えない）


#### fix 差分の再点検（ラウンドを閉じる前・1 レビュアー）

問いは 2 つだけ: 「この修正が導入する新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」。
**Critical 0 / Important 3**。いずれも同じ向き — **保証が深さ 1 では本物で、深さ 2 以上で宣言検査へ退化する**。

🔴 **加えて、main 自身が 1 件見つけた**: `.vscodeignore` に**未コミットの変更が残っていた**。
`git commit` した**後**に Codex が書いたもので、「完了通知は稼働終了を意味しない」の実例。
内容は `!engine/node_modules/**` の削除で、理由として「入れ子は普通に入る」と書かれていた。

**実測したら理由が誤りだった**: 否定指定を外すと `engine/node_modules` の同梱が **422 → 317 件**へ減る。
つまり否定指定は load-bearing で、`**/*.ts` 等の一般規則が効いているのを打ち消していた。
ただし失われる 105 件の内訳は **`.ts` が 104 個とスタンプ 1 件**で、`.js` / `.node` /
パッケージの `package.json` は 1 つも落ちない。**変更自体は実害のないサイズ削減**（9.4 → 9.34 MB）
なので採用し、**コメントを実態に書き直した**（数字つきで）。

| 指摘 | 対応 |
|---|---|
| 推移依存の版が固定されていない（temp install に lockfile が無く range で再解決される） | **限界として明記**。宣言層の乖離（sdk 1.30.0 / zod 4.6.2 対 lockfile の 1.29.0 / 4.4.3）は潰れており、そこが譜面の振る舞いに効く層。グラフ全体の固定は lockfile の合成が要るので #875 へ |
| 深さ 2 以上は `require.resolve` ではなくディレクトリ探索（存在すれば通る） | **限界として明記**。全辺を実解決する案は**試して却下**されている — CJS が実際には require しない ESM-only の推移パッケージで**偽の赤**になり、リリースを理由なく止める |
| `catch {}` が内側のエラーを捨て、どの推移パッケージが欠けたか分からない | **直した**。`reason` を持ち回って診断に出す |

再点検後の実測 — `dist/node_modules/express`（sdk の推移依存）を削除:

```
::error::extension runtime specifier '@modelcontextprotocol/sdk/server/mcp.js' cannot be
resolved from extension/dist/mcp-server.js in the packaged .vsix
  — express cannot be resolved from .../node_modules/@modelcontextprotocol/sdk/package.json
```

**どの推移パッケージが欠けたかがログだけで分かる。** 以前は最上位の specifier しか出なかった。

`npm test` 2,347 passed / 0 failed・lint 緑・引用 944 / 0 failed・ゲートは実 `.vsix` で exit 0。

#### 🔴 CI が 3 回走っていなかった

`f83aa658` / `b99c1d04` / `af19ac93` の push で CI が 1 度も起動していなかった。原因は
**PR が `DIRTY`**（main と衝突）だったこと — GitHub は merge commit を計算できない PR では
`pull_request` ワークフローを走らせない。**緑でも赤でもなく「無」だったので、`gh pr checks` は
`no checks reported` としか言わない。** main をマージして解消した。

**教訓**: `gh pr checks` が「no checks reported」と言う時は、待つのではなく
`gh pr view --json mergeStateStatus` を見る。

### test(core): freeze the clock in the loop-quantize mock (#869) (Sep 11, 2026)

`tests/core/loop-quantize.spec.ts` の「snaps to the same boundary already crossed when
currentTime equals a boundary」が CI で間欠的に落ちていた（PR #847 の `code-review` ジョブ・
run 34560570537）。**#847 は docs 7 ファイルのみ**で、コードに触れていない。

#### 原因は `Date.now()` を 2 回呼んでいたこと

モックの `startTime` が getter で、アクセスのたびに `Date.now() - elapsedMs` を再計算していた。
呼ぶ側（`prepare-playback.ts:73-75`）はその直後に**別の `Date.now()`** を呼ぶ。この 2 回の間に
ミリ秒が繰り上がると `currentTime = elapsedMs + 1` になる。

このテストだけが **`elapsedMs = 2000`（小節境界ちょうど）** を突くので、+1ms で
`nextQuantizedTime` が「境界を過ぎた」と判定し、次の境界 **4000** を返す。他のテストは境界の
途中（1500 等）なので 1ms では判定が変わらない。

**プロダクションコードの欠陥ではない。** 実機の `startTime` は保存された数値で、読むたびに
動いたりしない。壊れていたのはモックの側。

#### 4000 には犯人候補が 2 つあった

`expected 4000 to be close to 2000` は、**(a) +1ms で次の小節**でも
**(b) 直前のテストの `global.quantize('2bar')` が漏れた**でも同じ値になる。(b) を潰してある:
`QuantizeManager._value` は private なインスタンスフィールド（既定 `'bar'`）で、`beforeEach` が
`Global` ごと作り直すため漏れる経路が無い（`packages/engine/src/core/global/quantize-manager.ts:75-76`）。

#### 機構の実測

旧モックと同じ 2 回読みを 500 万回回すと、**109 回**（0.0022%）で
`currentTime !== elapsedMs` になった。手元ではこの頻度だが、負荷のかかった CI runner では
2 回の `Date.now()` の間隔が広がるので、実際の発火率はこれより高い。

#### 直したもの

describe 全体で `Date.now` を固定値に固定し、`startTime` の getter も同じ定数から引く。
**両方が揃って初めて成立する** — getter だけ定数にして `Date.now` を生かすと、
`currentTime` が巨大な値になる。`afterEach` の `vi.restoreAllMocks()` が復元する。

検証: `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
引用 938 / 0 failed。

Closes #869

### chore(release): bump the extension to 3.0.0 and the DSL spec to 1.2 (#843) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 A-1）: **`v3.0.0` / DSL 1.2**。

## 🔴 動かしたのは 1 つだけ — 正本は拡張の package.json

`docs/design/656-release-design.md` §4.4 が版の所在を確定させている:

| 場所 | 規則 | 今回 |
|---|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ | **2.1.0 → 3.0.0** |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。同期しない | **2.0.0 のまま** |
| `DSL_VERSION` | **別軸**（spec 版）。同期しない | 1.1 → **1.2**（別軸の理由で動かす） |
| ルート `package.json` | `private: true` で配布物にならない | 触らない（裁定待ち (7)） |

`DSL_VERSION` を上げたのは「拡張が 3.0.0 になったから」ではなく、**DSL の表面が変わったから**
（`send` の dB 化・`output(dest, thru, db)` の導入・`pan` のライン要素化）。理由が別なので
数字も揃わない。

🔴 **私は一度これを間違えた。** 「拡張 package.json・`ENGINE_VERSION`・`DSL_VERSION` の 3 つを
揃える」と報告し、`/simplify` の Altitude が §4.4 を示して正した。
`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

## なぜ major か

- `ORBITSCORE_ENGINE` 環境変数・`orbitscore.engine` / `scsynthPath` 設定・
  `Force Kill scsynth` コマンド・MCP `force_kill_scsynth` を**削除**した（#502）
- `send` が**線形係数から dB へ**変わり、既存の譜面の意味が変わる

## 追従した記述

root `README.md`（2 箇所）・`CLAUDE.md`・`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所）・
dev サイトの `version.ts` 引用 4 箇所。いずれも「3 つは別軸」と明記して、
次に読む人が同じ取り違えをしないようにした。


#### owner 裁定（2026-09-11）と、リリース直前の README 2 件

正本 `docs/planning/NATIVE_MIGRATION_2026-09.md` §12.7 が **未決**として残していた 2 件に
裁定が出た。

| 未決だったもの | 裁定 |
|---|---|
| バージョン番号 | **3.0.0 / DSL 1.2**（`send()` の dB 化で既存譜面の意味が変わるので semver では major） |
| タグ名前空間 | **`v3.0.0`**。`ext-v*` / `app-v*` の分離はネイティブ版の新ラインで行う（§12.3）。`release.yml` のトリガーは `v*` のままでよく、ワークフローの変更は不要 |

残り 3 件は裁定待ちではなく既に解消済み: SC 削除 = #840 / gated ハーネス = #831 /
README の導線 = #842。Marketplace publish は「行わない」（owner 2026-09-10）で、
リポジトリ変数 `PUBLISH_MARKETPLACE` が未設定のため publish ステップは skip される（実測）。

**ついでに直した README 2 件** — どちらも「これから打つタグが何をするか」と食い違っていた:

- `tag push で全 channel に自動 publish` → 当時の計画である旨と、現在は GitHub Release だけが
  作られることを明記
- 「ICMC v1.1.0 bundle release」節の見出しに historical を付け、表が挙げている scsynth 同梱は
  #502 で削除済みで**現在の `.vsix` に scsynth は入っていない**という注記を足した

出荷される `packages/vscode-extension/README.md` は元から SC 参照 0 件で、Marketplace 非公開も
正しく書かれている（実測）。直したのはリポジトリ表紙の側。

ガードの実測: `checkTagAgainstVersion('v3.0.0', '3.0.0', 'darwin-arm64')` → `{ok: true}` /
`('v3.0.0', '2.1.0')` → 版が食い違うと fail（#853）。**バージョンバンプがタグより前に入る必要がある**
ことをこのガードが担保している。

検証: `npm test` 2,338 passed / 0 failed・`npm run lint` 緑・引用 944 / 0 failed。

### docs: land the nine routine docs-sync PRs as one roundup (#867) (Sep 11, 2026)

凍結版リリース（#827）のタグを打つ前に、溜まっていたルーティン docs 追従 PR **9 本**
（#837 / #844 / #847 / #856 / #858 / #862 / #864 / #865 / #866）を統合ブランチ
`867-docs-sync-roundup` で 1 本にまとめて main へ入れた。**docs のみ**で `packages/` `rust/`
`tests/` `.github/` は触っていない。学習サイトはリリースの一部なので、タグ前に反映させる必要がある
（owner 2026-09-11）。

#### なぜ 1 本にまとめたか — 逐次マージだと兄弟の内容が消える

9 本すべてが `WORK_LOG.md` を触り、#844 と #856 は 13 ファイルを共有、#837 / #862 / #865 は
`sites/dev/editor/mcp-and-gated-e2e.md` の**同じ Note 行と同じ節**に追記していた。1 本ずつ main へ
入れると残り 8 本を毎回再同期することになり、しかも従来の解決規則「WORK_LOG は両側・他は追従側を
採る」は、**main 側に兄弟 PR の内容が入った後では兄弟の内容を落とす**（規則が前提にしていた
「main 側 = 古い baseline」が成り立たなくなるため）。

#### 衝突の解決（全 22 hunk・いずれも同じ事実の別表現か、同じアンカーへの独立追記）

| 種別 | 解決 |
|---|---|
| WORK_LOG の同一アンカーへの独立エントリ（4 箇所） | 両方残す |
| #844 × #856 の SC 削除記述（11 ファイル・18 hunk） | hunk ごとに**情報量の多い側**を採る。`glossary.md` の Sources 一覧（ja/en）と `index.md` の Part VII 行（ja/en）は #844 側（#836 / #838 の粒度と `daemon-client.ts` の行がある）、残りは #856 側 |
| `mcp-and-gated-e2e.md` の Note 追従リスト（ja/en） | #830・#860・#855 の 3 件を**合併**。frontmatter は最新の `a6e1f13` / 2026-09-11 |
| 同じ章の新設節（#862 の `###` 節 × #865 の散文） | 両方残す。#865 の散文を先（直前の #756 段落から続く）、#862 の `###` 節を後 |

🔴 **1 件だけ「両方残す」では壊れた**: #865 は #857 の WORK_LOG エントリを Recent Work の先頭へ
**移動**していたので、素朴に両側を残すと同じエントリが 2 箇所に出る。移動先を残して旧位置
（54 行）を削除した。**「両側を残す」は追記には正しく、移動には正しくない。**

#### 検証

`node sites/dev/scripts/check-citations.mjs` **944 citations verified / 0 failed**（`--fix` は
使わず素で実行）/ `npm test` **2,338 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`docs:build` dev・user 両方緑。

Closes #867

### docs(sites): re-anchor three citations #859 left pointing at the wrong code (Sep 11, 2026)

PR [#860](https://github.com/signalcompose/orbitscore/pull/860)（merge `e4d4199`）の追従。
#860 自身が `34e12b3` で dev サイトを更新しているが、**引用の再アンカーが 3 箇所ずれていた**。
`check-citations.mjs` は「引用文字列が実ファイルと一致するか」しか見ないので、
**別の関数に一致してしまった引用は緑のまま通る**。

| 箇所 | 何が起きていたか |
|---|---|
| `sites/dev{,/en}/signal-chain/mixer-audio-line.md` | bus post-loop の `LineOp::Output` 腕を引用していたはずが、`execute_master_line`（master 側）の `LineOp::Output` 腕に再アンカーされていた。直後の本文「`Output` として実行されるのは `Master` / `Bus` / `Device` の 3 つ」と引用が食い違う（master 側は `Device` 以外を `debug_assert!(false)` で落とす）。`output.rs:2566-2592` へ戻した |
| 同上（pan 節） | `apply_line_pan` の引用が切り詰められ、直後の本文が指す **`√2`** が引用内に無くなっていた。`√2` は #859 で `line_pan_coefficients` へ切り出されたので、その関数（`output.rs:2227-2243`）の引用を足した |
| `sites/dev{,/en}/rust-engine/index.md` | `render_block_with_sources` の引用が 4 行はみ出して `execute_master_line` のシグネチャを含んでいた。`1846-1932`（関数の閉じ括弧）で止めた |

あわせて、#859 が**コード引用だけ更新して本文を更新しなかった**箇所を直した
（`sites/dev{,/en}/rust-engine/index.md` の `advance_gain` 節）。旧本文の
「block が ramp より長ければ 1 回で目標へ到達」は、いまはブロック**終端**の値の話であって、
ブロック内は `ramp_frames` サンプルかけて補間される。これは #859 が直した欠陥そのものなので、
そのまま残すと修正前の振る舞いを説明する文が残ることになる。

4 章の `verified-against` / `verified-at` を `e4d4199` / 2026-09-11 に更新。

検証: `npm run docs:check` **938 citations / 0 failed** / `docs:build`（user / dev）両方緑。
### docs(sites): follow PR #861 — record the mirror-image consequence of line-wise ERROR prefixing (Sep 11, 2026)

PR [#861](https://github.com/signalcompose/orbitscore/pull/861)（#860・merge `5ed3ce5`）の追従。

IV-3 章（`sites/dev/editor/mcp-and-gated-e2e.md`）は #756 の「`ERROR:` 前置が chunk 単位
だったので ERROR 件数が**構造的に過小**だった」までを書いていたが、**その裏返し**を
書いていなかった。行単位になったということは「engine の stderr に出た行はすべて `ERROR:`」
であり、**正常系の `warn!` 1 行で件数テストが巻き添えになる**。#861 はまさにそれで、
`query_note_port_index` の warn が `default-baseline cycle must add no ERROR: lines`
（`tests/e2e/orbitstudio-mcp-gated.spec.ts:3426-3430`）を落としていた。

ja / en の両方に節を追加（STYLE_GUIDE のバイリンガル必須）。ERROR 会計という 1 本の
計測系に**測定器の側**（前置の粒度）と**被測定側**（engine のログレベル）の 2 つの入口が
あり、**直す場所が正反対**であることを本文に残した。

`verified-against` は据え置き。1 節の追記であって章本文の書き直しではなく、STYLE_GUIDE
§4「小規模 cross-link / 体裁修正のみは更新しない」と「実質的に書き直したとき」の中間に
あたるため、章冒頭の Note（この章が従来から追従履歴を書いている場所）に #861 を追記する
方式を採った。

検証: `npm run docs:build`（user / dev）緑 / `npm run docs:check` 緑。

### docs: follow PR #852 in the user site and the diagnostics chapter (Sep 11, 2026)

マージ済み PR [#852](https://github.com/signalcompose/orbitscore/pull/852)（束 B・`611-dsl-surface` →
main・merge commit `ded9709`）の追従。**ドキュメントのみ**の変更で、`packages/` `rust/` `tests/` は触っていない。

#852 は core spec（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2 / MX.3 / MX.4 / MX.5）と
specs-v2（`SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.4）を自分で更新していたが、**ユーザー向けの 3 ファイルが
旧仕様のまま残っていた** — いずれも「dB 化は決まったが未実装」「send は post-fader 固定」と書いており、
実装済みの今は**読んだ人が逆の行動を取る**記述になっていた。

## 直したもの

| ファイル | 何が古かったか |
|---|---|
| `sites/user/mixing/routing.md` / `en/` | `send(name, amount)` が線形・dB 化は未実装・post-fader 固定 |
| `sites/user/reference/methods.md` / `en/` | 同上 + `output()` の宛先が sum のみ・`thru:` / `db:` 不在 |
| `docs/user/ja/USER_MANUAL.md` | `output()` / `send()` の宛先を「sum バス」と書いていた |
| `sites/dev/editor/execution-feedback.md` / `en/` | 診断 6 がミキサー宛先を除外するようになったこと（#852 の `diagnostics-analysis.ts:257-262`）が未記載 |

追記した利用者から見える表面（すべて #852 の差分から読み取れるもの）:

- `send(aux, db)` の単位が **dB**（線形 `0.3` 相当は `-10.5`）。`amount:` は loud に throw
- `send(aux, db, enabled: false)` はチェーン上の位置を保持したまま送出を止める
- `output(dest, thru:, db:)`。`thru: false`（既定）が終端・`thru: true` がタップ
- `send(name, db)` ≡ `output(name, thru: true, db: db)`
- 宛先の解決順: 解決済みノード → `"master"` → 宣言済み sum/aux → `"L,R"` → LinkAudio channel
- `effect()` / `gain()` / `pan()` / `send()` / `output()` は**書いた順に 1 本の線**に並ぶ
- `sum` / `aux` バスも `output()` / `send()` / `gain()` / `pan()` を受ける（`BUS_DSL_METHODS`）
- `master` はミキサーノード名として予約・`mix.output(1, 2)` はデバイスであって master ではない
- `mix.output(n)` の 1 引数形はモノラル（L+R マージ）

## 書かなかったこと（PR 本文の「確認してほしい点」へ回した）

- core spec MX.5 の「sum ネスト不可」と、同 PR が MX.2.2 に書いた「sum が別の sum へ出せる ✅」が
  **食い違って見える**。どちらが正しいかは仕様の判断なので追従作業では直さない
- `gain()` / `pan()` の固定値が**バス未確保の audio シーケンスでは発音側に留まる**という条件分岐は、
  ユーザー向けページには書いていない（内部の割り当て事情で、書くと「位置が効かない場合がある」と
  読めてしまう）

検証: `npm run docs:build -w @orbitscore/user-site` 緑 / `-w @orbitscore/dev-site` 緑 /
`npm run docs:check` **938 citations verified, 0 failed**。

### docs(sites): follow PR #857 — a benign warn is an input to the release gate (#855) (Sep 11, 2026)

マージ済み PR [#857](https://github.com/signalcompose/orbitscore/pull/857)（merge commit `a6e1f13`）への
ドキュメント追従。**実装とテストは変更していない。**

## 追従先

**`sites/dev/editor/mcp-and-gated-e2e.md` / `sites/dev/en/editor/mcp-and-gated-e2e.md`**（ja/en 両方）。

この PR が直したのは engine 内部の TOCTOU だが、**観測可能な表面は ERROR 件数**である。
IV-3 の「`get_log` とリングバッファ」節は、この計数が信用できない理由を 2 つ挙げていた
（固定窓による false green・#756 以前の chunk 単位前置による**構造的な過小**）。#855 は
その 3 つ目で、向きが逆の**構造的な過大**にあたるので、同じ節に並べて書いた。

- `temp-file-manager.ts:98-118` を引用し、per-entry の `try` が ENOENT だけを飲む形を示す
- #840 のマージ前ゲートで `expected 9 to be less than or equal to 8` として出た実測を明記
- ループ全体を囲む `try` だと ENOENT 1 件で残りが掃除されない副次問題も残す
- 一般則を #756 と対にして締める:
  **engine のどこかの `console.warn` 1 行が、そのままリリース可否ゲートの入力になる**

frontmatter は `verified-against: a6e1f13` / `verified-at: 2026-09-11` へ更新し、
冒頭 Note の追従リストにも #855 を足した。

## WORK_LOG の並びを直した

#857 の WORK_LOG エントリ（Sep 11）が、マージ時のコンフリクト解消（`1c3056a`）で
**Sep 10 の #611 エントリ群の間**に入っていた。本文は変えず、位置だけ Recent Work の
先頭へ移した。#857 は #860 / #852 より後のマージなので、そこが時系列上の正しい位置になる。

## 追従不要と判断したもの

| 対象 | 理由 |
|---|---|
| `docs/specs-v2/` `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | DSL の構文・意味論・`.orbslog` 形式に変更が無い |
| `sites/user/` `docs/user/ja/USER_MANUAL.md` | ユーザーが書く語に変更が無い。temp 掃除は DSL から不可視 |
| `rust/` 側の章 | diff は TypeScript の engine のみ。MCP ツールの引数・返り値・エラー挙動は不変 |
| `sites/dev/audio/audio-file-playback.md` | slicing 章だが SC 経路の歴史的読解で、`TempFileManager` を扱っていない |

### fix(engine): stop a benign temp-dir race from inflating the ERROR count (#855) (Sep 11, 2026)

#840 のマージ前ゲートで実機 gated が 2 件落ち、うち 1 件がこれだった。

```
AssertionError: expected 9 to be less than or equal to 8
ERROR: Failed to cleanup old directories: Error: ENOENT: no such file or directory,
       stat '.../T/orbitscore_1789065642138_xx52jsw'
```

**原因は TOCTOU**（`temp-file-manager.ts:93-110`）。`readdirSync` で列挙してから `statSync`
する間に、**別のエンジンインスタンスの同じ掃除**が同じディレクトリを消す。gated suite は
エンジンを何度も起動・停止するので、複数インスタンスが同じ temp root を奪い合う。

`catch` は「Ignore errors during cleanup」と書いているのに `console.warn` を出しており、
engine の stderr 分類で **`ERROR:` 行になる**（memory `stderr-is-classified-as-error` の再発）。
**ディレクトリが既に無いのは、このループが望んでいた結果そのもの**で失敗ではない。

**副次**: `try` がループ全体を囲んでいたので、**1 件 ENOENT が出た時点で残りを見ずに抜けて**
いた。孤児が溜まる。

## 🔴 変異検証が別の穴を見つけた

修正のテストに変異をかけたところ、**`orbitscore_` 接頭辞の判定を外しても全テストが緑**だった。
この掃除は**共有の `os.tmpdir()`** を舐めて **1 時間以上前のディレクトリを消す**ので、
接頭辞判定は**他アプリの temp を消さない唯一の歯止め**である。テストを足した。

| 変異 | 結果 |
|---|---|
| ENOENT も含め全部握り潰す | 1 failed |
| ENOENT も再送出（元の挙動へ戻す） | 1 failed |
| 1 時間の条件を外す（新しい dir も消す） | 1 failed |
| **接頭辞の判定を外す** | **最初は 4 passed（すり抜け）→ テスト追加後 1 failed** |
| restore | 5 passed・baseline とバイト一致 |

## テストはモックを使わず実物のファイルシステム条件で書いた

`os.tmpdir` も `fs.statSync` も **再定義できない**（`Cannot redefine property`）ので、
最初に書いた `vi.spyOn` 版は動かなかった。差し替えではなく**本物の条件**を作った:

| 条件 | 作り方 | Node が出すもの |
|---|---|---|
| レース | dangling symlink | 本物の `ENOENT` |
| レースでない失敗 | 自己参照 symlink | 本物の `ELOOP` |
| temp root の差し替え | `process.env.TMPDIR`（POSIX は呼び出しごとに読む） | — |

`chmod 444` は使えなかった — constructor 自身の `mkdirSync` が先に落ちて **cleanup に到達しない**。

捏造した mock 文言を検証するのは、このプロジェクトが列挙している弱いアサーションの典型なので、
結果的に良い方向へ転んだ。

`npm test` 2,283 passed / 0 failed・lint 緑・`typecheck:e2e` 緑・引用 934 / 0 failed。

Closes #855

### docs(sites): re-anchor the release.yml line references shifted by #853 (Sep 11, 2026)

PR [#853](https://github.com/signalcompose/orbitscore/pull/853)（タグと `.vsix` の版を照合する
release ガード）が `.github/workflows/release.yml` の `Setup Node.js` の直後に **10 行**挿入した。
旧 58 行目以降がすべて **+10** ずれている。

## #853 が直したもの・残したもの

| 種別 | 追従状況 |
|---|---|
| ` ```yaml // .github/workflows/release.yml:84-90` 形式の引用ブロック 2 箇所 | ✅ #853 が `94-100` / `184-193` へ更新済み（`docs:check` が突合するため) |
| 本文中の散文的な行参照 | ❌ 取り残された。`docs:check` はフェンス付き引用しか見ないので red にならない |

## 直した 4 行

| ファイル | 変更 | 参照先の実体（現行 release.yml） |
|---|---|---|
| `sites/dev/rust-engine/index.md:329` | `:88` → `:90` | `cargo build ... --features outproc-effect,outproc-instrument` |
| `sites/dev/en/rust-engine/index.md:338` | 同上 | 同上 |
| `sites/dev/signal-chain/index.md:1616` | `:86-98,191-200` → `:88-100,184-193` | 実 Gain テストのステップ / `.vsix` 内 `std-plugins/Gain.clap` の同梱ゲート |
| `sites/dev/en/signal-chain/index.md:1653` | 同上 | 同上 |

いずれも**執筆時点では正しかった**（`28606fa` 時点で `release.yml:88` は features 行、
`84a29a5` 時点で `86-98` / `191-200` は当該ステップ）。行ドリフトで腐っただけで、
記述の内容そのものは変わっていない。したがって章の `verified-against` / `verified-at` は
**更新していない** — 章全体を検証し直してはいないため。

## 追従不要と判断したもの

- `docs/design/656-release-design.md` の行参照（`:114` `:224` `:245-248` 等）も +10 ずれているが、
  **設計書は起案時点のスナップショット**なので書き換えない（routine 規則）。報告のみ
- `docs/planning/IMPLEMENTATION_PLAN_2026-09.md:239` の `release.yml:116-207` も同様に +10 ずれ（→ `126-217`）。計画文書なので報告のみ
- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — #853 は DSL の構文も意味論も
  変えていない（`packages/engine/` に差分なし）
- `sites/user/` / `docs/user/ja/USER_MANUAL.md` — ユーザーが書く語に変更なし

### fix(clap-host): stop warning on the normal path for effects without note ports (#860) (Sep 11, 2026)

束 B の最終ゲートで `auto-records and restores all five plugin receiver kinds` が落ちた。

```
AssertionError: default-baseline cycle must add no ERROR: lines
  → expected 10 to be less than or equal to 9

[daemon] WARN orbit_clap_host::controller: [orbit-clap-host] NotePortsExtension なし; port 0 を使用
```

## 正常系で警報が鳴っていた

`query_note_port_index`（`controller.rs:400`）は **すべての CLAP ロードで無条件に**
呼ばれる（`:246`）。**エフェクトが note ポートを持たないのは正常**で、port 0 という
フォールバックも CLAP の慣習どおり機能する。それを `warn!` で報せていた。

## なぜ ERROR 件数に乗るか

拡張は engine の stderr を**全行 `ERROR:` として**出力する（`extension.ts:1453`）。
これは**意図的な設計**で、#756 の記録が理由を書いている:

> `outputChannel.append('ERROR: ' + chunk)` と chunk 単位で前置していた。1 つの chunk に
> 複数行入ると 2 行目以降に `ERROR:` が付かず、gated E2E の ERROR 会計が**構造的に
> 過小カウント**する（= 偽緑）

つまり「実エラーを取りこぼさない」ために全行前置している。**分類側を緩めるのは筋が悪い**
（取りこぼす方向へ戻る）。

🔴 したがって**ノイズは源で止める**。`warn!` → `debug!`。
memory `stderr-is-classified-as-error` は「engine の warn は全部 ERROR 行」を
**4 回目の再発**として記録しているが、これまでの対処はテスト側だった。今回は発生源を直した。

## 失う情報

instrument が note ポートを持たない場合も debug になる。ただし port 0 のフォールバックは
機能するので、これは「動かない」ではなく「既定を使った」の報告であり、debug が妥当。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-clap-host --all-targets -- -D warnings` 緑 /
`cargo test -p orbit-clap-host --lib` **29 passed**。

### fix(native): interpolate gain and pan ramps inside the block (#859) (Sep 11, 2026)

owner 裁定 2026-09-11（#851 B-1・**案 A**）。E2E-7 が測っていたのは**実装の欠陥**であって
オラクルの欠陥ではなかった。

## 何が壊れていたか

ゲインは**ブロックあたりスカラー 1 個**として掛かっていた。`ramp_frames` は 5 ms = 240 で、
実機のブロック長は **512**。`frac = min(512/240, 1.0) = 1.0` なので
**ランプが 1 ブロックで完了する**（= ブロック境界の段差）。

`gain(-40)` → `gain(0)` は振幅が 0.01 → 1.0 に**1 サンプルで跳ぶ**。
実測: 切替時の一次差分 `0.6996` vs 信号自身の最大スルー `0.0407` → **17 倍**。

`advance_ramped_gain` の doc は "One block of the **click-free** gain ramp" と書いていたが、
**出荷時のバッファ長ではこの記述は偽**だった。

## 🔴 私の最初の推奨（案 D）は誤りだった

「出力バッファ長を env 化して E2E-7 を 64 フレームで回す」を推奨していたが、owner の
「rampの粒度がそれでいい根拠を説明して」で一次ソースを読み直し、**2 つの理由で撤回**した。

1. **出荷される振る舞いを何も変えない。** 512 で走るユーザーには段差が残る
2. **E2E-7 すら通らない見込み。** 64 でも `frac = 64/240 = 0.2667` で 4 段の階段になり、
   最大段差 0.264 × ピーク振幅 0.707 = **0.187** > 閾値 `4 × 0.0407 = 0.163`

推奨する前にこの算数をやるべきだった。

## 案 A の要点: ブロック終端をビット一致させる

現行式 `current += (target - current) × min(frames/ramp_frames, 1)` は
「ブロック先頭の距離を `ramp_frames` で割った固定ステップ」と等価なので:

```
step  = (target - start) / ramp_frames
at(f) = end                if f >= min(frames, ramp_frames)
        start + step * f   otherwise
```

`end` は**現行式をそのままの演算順序で 1 回だけ**計算した値。したがって
`at(frames) == end` がブロックの長短どちらでも成り立ち、**既存の実機 goldens
（E2E-2/3/6/G/P/S/10）は動かない**。これが検算そのもの。

## コスト

| 状態 | 現在 | 案 A |
|---|---|---|
| 定常（圧倒的多数） | 乗算 1（`gain == 1.0` なら省略） | **同じ**（`is_settled()` で同じ経路へ） |
| ランプ中 | 乗算 1 | 乗算 1 + 加算 1 を 240 サンプル分だけ |

pan は**位置ではなく L/R 係数**を線形補間する（位置を補間すると `equal_power_pan` の
cos/sin が毎サンプルになる）。`pan == 0.0` → `(1.0, 1.0)` の unity 早道は維持したので、
中央 pan と pan 無指定のビット一致も保たれる。

## 検証（🔴 main が sandbox 外で実行）

`cargo fmt --check` 緑 / `cargo clippy -p orbit-audio-native --all-targets -- -D warnings` 緑 /
`cargo test -p orbit-audio-native --lib` **88 passed** /
`cargo test -p orbit-audio-daemon --features outproc-effect --lib` **220 passed**。

実機 E2E-7 は束 B と合わせて main が本ツリーで確認する。

Closes #859
### fix(dsl): separate the master track from the device it outputs to (#611) (Sep 11, 2026)

🔴 **owner の訂正（2026-09-11）**。私が「1,2 ch は master の領分だから `mix.output(1,2)` は
master として扱う」と裁定を仰ぎ、owner が「master であり、それはつまりデバイスの 1,2 に
なるのでは」と応じた後、**その実装が概念を取り違えている**ことを owner が指摘した。

> マスタートラックとデバイスっていう概念を、トラックなのかデバイスなのかっていうのを
> ちゃんと分けた方がいいんじゃないですか。
>
> マスターっていうのは要するにシーケンスのトラックやサミング、オグジュアリーのトラックとかと
> 同じように、マスターのトラックですよね。

## 正しいモデル

```
kick ──┐
snare ─┼→ master トラック: [rack][gain][pan] → output → デバイス 1,2
hat  ──┘                    ↑ ここに合流する

pad  ─────────────────────────────────→ デバイス 3,4（トラックを経由しない）
```

- `output(master)` は **master トラックの頭に合流**する。その後 master のラックと
  `global.gain()` を通り、master が自分の出口として持っているデバイスへ出る
- `mix.output(1, 2)` は **デバイスの 1,2 ch を名指す**。トラックではない

**実装も元からそうだった**（`default_master_line_program()` は bus と同じ形の
`[Rack, Gain, Output]`）。混同していたのは **DSL の側**だった。

## 何が焼き付いていたか（直した順）

| 場所 | 旧 | 新 |
|---|---|---|
| `process-statement.ts` の糖衣 | `(1,2)` を `{kind:'master'}` に読み替え | `physicalOutputDest()` で**常にデバイス** |
| 同・引数経路 | `(1,2)` の特例が**無い**（糖衣と食い違い） | 同じヘルパを通す |
| `MixerRuntimeNode` | master = `{kind:'output', channels:[1,2]}` = **デバイスノード** | **`{kind:'master'}` = 第 3 の種類** |
| `registerMixerNode` | `var master = mix.output(...)` は**合法**（#523 IMPORTANT 6） | **拒否**（sum/aux と同じ理由） |
| `resolveMixerNode` | 明示ノードが 1 つでもあれば master を解決**しない** | 常に解決する |

🔴 **最後の行が一番効いている。** 旧実装には「この Global に明示ノードが 1 つでもあれば
`master` を解決しない」というガードがあった。これは master が**デバイスノードだった時代の
名前衝突対策**で、`var master = mix.output(...)` が宣言されうる前提だった。
`master` を予約語にした今は衝突が起きず、ガードは
**「sum を 1 つ宣言した瞬間に `kick.master` が壊れる」という宣言順依存**だけを残していた。

## master の出口は 1,2 固定のまま（owner 2026-09-11）

> マスターが1、2固定にしておかないと、一般的な DAW の操作とか設定で 1、2 じゃなくなって
> しまっているみたいなことが起こると、デバイスの変更で困ってしまうので

**固定であることと、「1,2 という名前が master を意味する」ことは別**。
master トラックの DSL ハンドル（`master.output(...)` / `master.effect(...)`）は
凍結線に入れない — 下の配線（daemon の `SetBusLine("master", ...)`）は既に通っているので、
新ラインで表面だけ足せる。

## 旧モデルを固定していたテスト 9 件を書き直した

`signal-chain-dispatch.spec.ts` 5 件 + `mixer-runtime.spec.ts` 4 件。
うち 1 件はテスト名自体が混同を記録していた:
「sum/aux を master と名付けるのは拒否するが、**output を master と名付けるのは合法に保つ**」。

## 変異検証

| 変異 | 結果 |
|---|---|
| `master` の予約を外す | 1 failed |
| `master` を解決しない（旧ガード相当） | **6 failed** |
| `(1,2)` の特例を復活させる | 1 failed |
| restore | 32 passed・baseline とバイト一致 |

`npm test` **2,325 passed / 67 skipped / 0 failed**・lint 緑・`typecheck:e2e` 緑・
引用 936 / 0 failed。

Part of #611

### fix(dsl): keep the instrument reschedule off the push-success path (#611) (Sep 11, 2026)

束 B の fix ラウンド（Codex）を **sandbox 外で回し直して**出た赤 1 件。

```
× gain() during LOOP clears pending notes via the plugin scheduler (clearOwner)
  → expected "clearOwner" to be called with arguments: [ 'synth' ]
     Number of calls: 0
```

🔴 **Codex の `npm test` にはこれが見えていなかった。** sandbox が localhost の bind を拒否し、
mock daemon / MCP HTTP 系が `listen EPERM` で **108 件落ちた**中に埋もれていた。
CLAUDE.md の「委譲先の緑は実機の緑ではない」が、そのままの形で出た。

## 何が起きたか

Codex は C5（push 失敗時に値がどこにも無くなる）を直すため、発音側の中立化を
**push 成功後**へ動かした。これは正しい。しかし `seamlessParameterUpdate` の呼び出しも
**一緒に**動かしてしまった。

元のコードのコメントが、動かしてはいけない理由を明示していた:

> instrument sequences have NO event-side gain path to conflict with the line's ramp (§5.2) —
> but they DO rely on seamlessParameterUpdate's immediate reschedule for an **unrelated reason**
> (clearing pending scheduled notes via the plugin scheduler's clearOwner)

**instrument の即時 reschedule は gain とは無関係の関心事**（保留中のノートを消す）なので、
**push の成否に依存させてはいけない** — daemon が拒否してもノートは消す必要がある。
テストの mock には Rust バックエンドが無いので `setBusLine` が必ず throw し、
`adoptLineOnFirstBus()` に到達せず `clearOwner` が 0 回になっていた。

## 直し方

2 つの関心事を分けた。

| 関心事 | どこで発火するか |
|---|---|
| 発音側の中立化（ライン側と二重に掛からないように） | **push 成功後**（`adoptLineOnFirstBus`・Codex の正しい部分） |
| 即時 reschedule（`clearOwner`） | **`gain()`/`pan()` の中**・push の成否と無関係 |

audio + バス有りだけ `skipReschedule=true` のまま（ライン側の ramp が継ぐ）。

## fixer は main が直接やった

CLAUDE.md の「fixer は Codex → 収束しなければ main」に対し、これは**新しい指摘**で
2 回落ちたものではない。ただし**差分を読み終えており**、ブリーフを書き起こすコストの方が
自分で直すより高い（`fable-main-may-implement-directly` の一般化）と判断した。

検証: `npm test` **2,322 passed / 67 skipped / 0 failed**・lint 緑・`typecheck:e2e` 緑・
引用 936 / 0 failed。

Part of #611

### fix(extension): stop warning that working output() targets have no effect (#611) (Sep 11, 2026)

束 B のレビューで Fable が見つけた片翼。**出荷物の欠陥だったので、後回しにせず凍結線に含めた。**

`analyzeOutputWithoutLinkAudio`（`diagnostics-analysis.ts:218`）の正規表現は

```js
/\.output\s*\(\s*["']([^"']*)["']\s*\)/g
```

で、**`"master"` も宣言済み sum/aux 名も `"3,4"` も除外していなかった**。凍結線の看板機能を書くと:

```
kick.output("master")
      ⚠️ seq.output() requires global.linkAudio() to be declared in this file.
         Without LinkAudio mode the channel name has no effect.
```

🔴 **同梱 README は「LinkAudio は出荷ビルドで動作せず、音も出ない」と明記している。**
つまりエディタは、**動いているコードに「効かない」と警告し、動かない機能を指さしていた。**
ユーザーが最初に見る面でこれが起きる。

**直し方**: #611 §2.1/§3.3 の解決順（`OutputDest` → `"master"` → 宣言済み sum/aux →
`"L,R"` 対 → LinkAudio）で **LinkAudio より前に解決する名前を除外**した。
sum/aux の宣言は 2 形式とも拾う（`global.sum("x")` の文字列形と `var x = mix.sum` の変数形 —
**後者は変数名がバス名**）。

宣言の収集は**ファイル全体**から行う（呼び出し行より上だけではない）。ライブコーディングの
ファイルは丸ごと再評価され、`global.sum(...)` はそれを使う sequence より**下**に書かれることが
普通にあるため。2 行下で宣言される名前を警告するのはノイズ。

**検証**（変異は `$TMPDIR` へバックアップしてから）:

| 変異 | 結果 |
|---|---|
| `master` の除外を削除 | 1 failed |
| sum/aux の除外を削除 | 3 failed |
| `"L,R"` の除外を削除 | 1 failed |
| 常に除外（警告そのものを殺す） | **5 failed** |
| コメント行も宣言として拾う | 1 failed |
| restore | 51 passed・baseline とバイト一致 |

4 番目が効いているのが要点で、**「除外しすぎ」も捕まる**（未宣言の名前は今も警告される）。

`npm test` 2,369 passed / 0 failed（+6）・lint 緑・`typecheck:e2e` 緑・引用 1,034 / 0 failed。

### refactor(dsl): apply the /simplify cleanup to the bundle-B line surface (#611) (Sep 11, 2026)

束 B（PR #852）に `/simplify` を回した。4 体（reuse / simplification / efficiency / altitude）
の指摘は 14 件、重複を畳んで 9 件。**3 体が同じ 1 件を指した**ので、そこから直した。

| # | 指摘 | 何体 | 対応 |
|---|---|---|---|
| 1 | 自己バッチの 4 行が `Sequence.upsertLine` と `MixerManager.applyLineElement` に逐語重複 | **3** | `AudioLine.upsertAutoBatch()` へ移した |
| 2 | `resolveLineDest` と `resolveDest` が同じ §3.3 の解決を二重に持つ | 2 | 共有 `resolveNamedOutputDest(value, lookupBus)` |
| 3 | `allLines` が `Set` で、破棄された行がプロセス寿命だけ残る | 2 | `Set<WeakRef<AudioLine>>` + 反復時の剪定 |
| 4 | `firstInBatch` は `cursor === 0` から導出できる | 1 | getter 化 |
| 5 | `outputs()` が本番から呼ばれていない | 1 | 削除（テストは `program()` 全体で見る形へ） |
| 6 | output 段取りの 5 行が 3 メソッドに重複 | 1 | `stageOutputElement()` |
| 7 | `gain()`/`pan()` の instrument insert-bus ブロックが重複 | 2 | `ensureInsertBusForInstrument()` |
| 8 | `MixerOutputOptions`/`MixerSendOptions` が `OutputOptions`/`SendOptions` の複製 | 1 | 共有版へ統合 |
| 9 | capture 定数がテストで再定義 | 1 | `capture-windows.ts` から export して import |

## 争点が 1 件あり、自分で検算した

指摘 8 について **reuse 側は「循環しないので統合できる」、simplification 側は
「循環 import があるので複製が正当」と逆の判断**をした。複製側のコメント自身が
「circular import を避けるため」と書いていた。

実際に読むと `audio-line.ts` の import は `audio-gain-utils` と `audio/types` の 2 本だけで、
**`sequence.ts` にも `global.ts` にも `mixer-manager.ts` にも依存していない葉**。
両者が既にここから import している以上、型をここへ置いても循環は起きない。
**reuse 側が正しく、コメントの正当化根拠は成立していなかった。**
simplification 側は `sequence.ts → global.ts → mixer-manager.ts` の向きだけを確認して、
両者が共通で依存する葉の存在を見落としていた。

## 指摘 4 は「フラグを消す」ではなく「導出を明示する」形にした

`firstInBatch` を単に消すと、「`cursor` はバッチ中 0 に戻らない」という不変条件が
暗黙になる。getter にして**その不変条件を doc に書いた**（`beginBatch()` だけが 0 にし、
どの `upsert` 経路も `<index> + 1`（index >= 0）を代入し、splice 分岐の `-= 1` は必ず
対の `+= 1` を伴う）。フラグという 2 つ目の写しは持たないが、根拠は残る。

## 🔴 `WeakRef` は tsconfig の `lib` に触れた

`WeakRef` は ES2021 で、この repo の `target` は ES2020 だった。最初 engine の
tsconfig だけに `"lib": ["ES2021"]` を足したところ engine は通ったが、
**`npm run typecheck:e2e` が `tsconfig.tests.json` で同じエラーを出した**
（memory `consumerless-code-is-unprotected` の「正本は `npm run typecheck:e2e`」どおり）。

`tsconfig.base.json` に 1 箇所だけ置いた。`target` は ES2020 のまま
（`WeakRef` はランタイムグローバルであって構文ではないのでダウンレベルは不要）。
そもそも root package.json が **Node >= 22 を要求**しているので、型面を ES2020 に絞るのは
実際のランタイムより狭い宣言だった。

## ラチェットが 1 件発火した

`tests/interpreter/signal-chain-dispatch.spec.ts` が `stageOutputElement` を
「未分類の Sequence メソッド」として赤にした。TS の `private` は実行時に残るので
prototype に見える。`ensureInsertBusForInstrument` と併せて内部 API 側に分類した。

検証: `npm test` **2,363 passed / 67 skipped / 0 failed** / `npm run lint` 緑 /
`npm run typecheck:e2e` 緑 / 引用 1,034 verified / 0 failed。
### docs: follow the merged #834 in the core spec, specs-v2 and the dev site (Sep 11, 2026)

マージ済み PR [#834](https://github.com/signalcompose/orbitscore/pull/834)（#611 束
O-surface の前半・merge commit `f23eb5d`）にドキュメントを追従させた。**実装とテストは
一切触っていない**（docs のみ）。

**追従した事実**（すべて #834 の差分から読み取れるもの）:

| 差分 | 直した先 |
|---|---|
| `SetBusLine` の op が 3 種（rack / gain / output）→ **4 種**（`pan` 追加）・`session.rs:358` のエラー文言も変わった | `sites/dev/rust-engine/index.md` と en の「op は 3 種」の段 |
| `dest.device` の `channels` が 2 要素固定 → **1 要素（mono）も受理**（`session.rs:423` の `matches!(channels.len(), 1 \| 2)`・範囲検証は `right` があるときだけ distinct を要求） | 同上（段を新設） |
| `validate_line_program` の `Pan` 拒否が外れ、RT で `√2 · equal_power_pan(p)` を掛けるようになった（`output.rs:2148-2182`） | 同上 + `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.4 |
| `LineProgram::with_seeds` / `line_republish_seeds` で再 publish が実効値を引き継ぐようになった | `sites/dev/rust-engine/index.md`（master gain の節が「§5.1 の機構は PR-O4 と同時に入る」と未来形で書いていた）と en |
| 引用行のずれ（`engine_wrap.rs:3262-3284` → `:3349-3371`・`:9479-9488` → `:9741-9750`・`daemon-client.ts:86-96` → `:86-97`） | RE-1 ja / en の本文と further-reading（**中身を base と突合して「その記述が指すもの」だと確かめられた 3 件だけ**。RE-1 / SC-2 の further-reading には #834 より前から中身と合っていない範囲が他にもあるが、機械的にずらすと**別の誤りへ移すだけ**になるので触っていない） |
| MX.4 の ⚠️「`pan` と mono 宛先はまだ wire に無い」 | `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（**wire には入ったが TS に呼び出し元が無い**ことを明記） |
| SC.1 の「v1 の現在地」 | `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`（同上・現在地そのものは変わらない理由を書いた） |

🔴 **「wire に入った ≠ 譜面から見える」を毎回書いた。** `packages/engine` に `setBusLine` の
呼び出し元は 0 件（`grep -rn setBusLine packages --include=*.ts` は `daemon-client.ts` のみ）。
`seq.pan()` は今日も発音側の `Scheduler` を通る。

**あわせて直した既存の綻び**（#834 の差分起因ではない・PR 本文で開示）:
`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` MX.2.2 の `engine_wrap.rs:5809-5813` / `:5828` は
**#834 より前から** `SelectAudioDevice` の stream 差し替えを指していた（WORK_LOG 2026-09-10 の
行も「壊れていた」と記録している）。MX.4 側だけが実測値へ直され、MX.2.2 の表が取り残されていた
ので、同じ実測値（`:7212-7216` / `:7237-7241`）へそろえた。

**frontmatter**: #834 は SC-2 / RE-3 の本文を書き換えたのに `verified-against` /
`verified-at` を据え置いていたので、4 ファイル（ja / en）を `f23eb5d` / 2026-09-11 へ更新した。

**追従不要と判断したもの**: `sites/user/reference/methods.md` と
`docs/user/ja/USER_MANUAL.md` の `pan(-100..100)`（DSL 表面は無変更）、
`docs/design/611-o-surface-bundle-design.md`（起案時点のスナップショットなので後から直さない）。

**検証**: `npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` /
`npm run docs:check`（936 → 引用の増減なし・0 failed）。

---

### docs(native): correct the current_gains serialization table (#611) (Sep 11, 2026)

束 A のレビューラウンドを閉じる前の **fix 差分再点検**（1 レビュアー・問いは
「新しい故障モードは何か」「新コードはどの実行コンテキストで走るか」の 2 つ）で
出た Minor 1 件を直した。Critical / Important は 0。

**何が間違っていたか**: `LineControl::current_gains()` に付けた「どの mutex で
直列化されているか」の表が、1 行目を `EngineWrap::set_global_gain` としていた。
実際の `set_global_gain`（`engine_wrap.rs:9747`）は `master_gain` atomic へ store
するだけで、`master_line_program` にも `LineExchange` にも触れていない。
`current_gains()` の呼び出し元は 2 つとも `EngineWrap::set_bus_line`
（`engine_wrap.rs:6980`）の中 — `bus == "master"` 分岐（7047）と named-bus 分岐（7141）。

🔴 **なぜ実害になりうるか**: この表は「呼び手が install と直列化する契約であり
型では強制していない」ことを将来の監査者へ伝えるために足したもの。PR-O4 はまさに
`set_global_gain` を `SetBusLine("master", …)` へ切り替える予定なので、その担当者が
表を読んで「既に `master_line_program` で直列化されている」と誤解しうる。
**この PR が対処しようとした「規約を知らない 4 つ目の呼び出し元」問題を、
コメント自身の不正確さで再生産していた。**

**変更**: 表を 2 つに分けた。①`current_gains()` を呼ぶ経路（2 件・どちらも
`set_bus_line`）②同じ `LineExchange` へ install する経路（3 件・`current_gains()` を
呼ばない `set_bus_routing` を含む）。②が全部同じ mutex を取ることが「install どうし」も
「読む → install」も直列化される根拠なので、①だけでは説明が閉じない。
`set_global_gain` が現状この表に**入らない**ことと、PR-O4 で触るときに契約を新たに
満たす必要があることを明記した。

検証: `cargo fmt --check` 緑 / `cargo clippy -p orbit-audio-native --all-targets -- -D warnings` 緑。

### chore(docs): rotate WORK_LOG before closing the bundle-A review (#611) (Sep 11, 2026)

`tests/docs/worklog-size.spec.ts` が **2,104 行**で赤くなった（上限 2,000）。
PROJECT_RULES §1a どおりアーカイブへ回した。

**移設**: `Sep 7, 2026` 以前の 18 エントリ・1,326 行を
`docs/archive/WORK_LOG_2026-09.md` の先頭へ。本体は **2,103 → 775 行**。
アーカイブの期間ラベルを `09-01〜09-06` → `09-01〜09-07` に更新し、本体末尾の索引と
`docs/core/INDEX.md` の表も揃えた。

🔴 **一度失敗した手順を記録しておく**（同じ落とし穴を踏まないため）。移設範囲の終端を
`s.index("## Archived sections")` で取ったところ、**過去エントリの本文が引用している
同じ見出し**を拾って、18 件のうち 3 件しか移らなかった。`rindex`（最後の出現）で取り直した。
**WORK_LOG は自分自身の構造を語るので、見出し文字列は本文にも現れる。**

### fix(daemon): build the master default line in exactly one place, too (#611) (Sep 11, 2026)

`/code:pr-review-team` ラウンド 1（4 レビュアー）を束 A（PR #834）に回した。
**Critical 1 / Important 4 / Minor 2**。fixer は main。

#### 🔴 Critical — mono デバイスで seed が実体と食い違い、この機構が防ぐはずのポップを再導入する

`MasterLine::new` は初期 program の `dest.right` を **`Some(1)` に固定**していた。一方 daemon 側の
shadow `default_master_line_program(output_channels)` は `(output_channels > 1).then_some(1)` を
返していた。**1ch デバイスでは `dest` が食い違う**ので、`line_republish_seeds` の Output 照合が
外れ、新しい master Output の seed が既定の **0.0** に落ちる。鳴っていた master が一瞬無音から
5 ms かけてフェードインし直す — 設計 §4.3 が名指ししている失敗モードそのもの。

**2ch では偶然一致するので、開発機の実機検証でも顕在化しない。**

さらに `add_to_device` の境界検査は `debug_assert` だけなので、**実 1ch デバイスでは
`right: Some(1)` が RT で範囲外アクセスになる**（`device_base + 1` が mono バッファを超える）。

**対処**: `default_master_line_ops(output_channels)` を `orbit-audio-native` から export し、
`MasterLine::new` と daemon の shadow の**両方がこれを呼ぶ**ようにした。`MasterLine::new` は
`output_channels` を受け取る（呼び出し 11 箇所・production の 1 箇所は同スコープに `channels` が居た）。
**同じ日にバス側で `legacy_line_ops` へ統一したのと同じ手当てを master にも当てた**
— reviewer が「是正の一貫性の欠落」として指摘したとおり。

固定するテスト `master_line_starts_from_the_shared_default_ops_for_any_channel_count` を足し、
**旧バグ（`right: Some(1)` 固定）を再現する変異で赤・戻して緑**を実走で確認した。

#### Important — 設計 §11 が挙げた 6 件のうち 2 件がまだ未実装だった

前回の Fable 監査が 3 件を埋めた**その一段外側**に、`channels` の要素数（0 個 / 3 個以上）の拒否と
**mono の `left` が範囲外**の拒否が残っていた（既存テストは stereo ペアしか通しておらず
`right: None` の枝に到達していなかった）。
`set_bus_line_wire_rejects_device_channel_arity_and_mono_out_of_range` を追加。
**2 種類の変異（要素数制限を外す / mono 上限を外す）で赤**を確認。

**列挙は一段手前で止まる。** 同じ設計文書の同じ表で、2 回続けて起きた。

#### Important — 「center は unity」を近似で検査していた

`line_program_pan_is_normalized_and_executes_in_rt` の許容差は `1e-6` で、
`apply_line_pan` の中央早期リターンを消しても `sqrt(2)*cos(pi/4)` の **6e-8** のずれが埋もれて
**そのまま通った**。設計 §4.1 の「center は unity」は近似ではないので、**ビット一致**で見る形に
変えた。変異で `1.4142134` と `1.4142135` の 1 ulp を捉えることを確認。

#### Important — dev サイトが裁定と逆のことを書いていた（comment-analyzer の Critical）

「`EngineWrap` はこのハンドルを `SetBusLine("master", …)` だけでなく **`SetGlobalGain` からも**
呼ぶ」と書いてあったが、現在の `set_global_gain` は `master_gain.store(...)` の 1 行だけで、
line-program installer を**呼ばない**。ユニットテスト
`set_global_gain_only_updates_the_compatibility_atomic` が「must not republish」を assert している。
PR #823 の時点では正しかったが、O-wire-b のレビュー修正（`9e22e427`）で戻り、裁定 F2（写さない）で
確定していた。**文書だけが 1 層取り残されていた**（ゴールが警告している型）。ja / en とも訂正。

#### そのほか

- `line_republish_seeds` への行番号参照がずれていた（`2162-2193` → 実体は 2157-2188）ので、
  **行番号をやめて関数名で参照する**ようにした
- TS の `daemon-client-line-wire.spec.ts` が、この束が広げた型（`pan` op・mono の `channels: [number]`）を
  **1 件も通していなかった**。設計 §11 が検証コマンドとして名指ししているファイルなのに
  「実行はされるが変更点は通らない」状態だった。1 件追加
- `LineControl::current_gains()` の直列化契約を、**どの mutex かまで表で明記**した
  （code-reviewer の Minor: 「規約を知らない 4 つ目の呼び出し元が追加されると壊れる」）

#### レビュアー別

| | 結果 |
|---|---|
| code-reviewer | **Critical 0 / Important 0**（mutex 経路を追い直して UAF なしと確認・cargo で 31 件を実走） |
| silent-failure-hunter | **Critical 1** / Important 1 / Minor 2 |
| pr-test-analyzer | Important 3 / Minor 1 |
| comment-analyzer | **Critical 1** / Important 2 |

**検算**: `cargo test -p orbit-audio-native --lib` **84 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **220 passed** /
`cargo fmt --check` 緑 / TS wire spec 2 passed。

#### 持ち越し（issue 化する）

silent-failure-hunter の Important #2: `LineExchange::install` は RT へ swap した**後**に
`retired` mutex を取るので、その mutex が poison すると **RT は新 program で鳴っているのに
呼び出し元へ Err が返る**。この束が新設した「shadow は install 成功時だけ前進する」不変条件は、
その既存の非 atomic 失敗経路では成立しない。発生確率は低いが**ログが 1 行も出ない**。
束 A の差分の外（既存仕様）なので **#850** に切り出した。

### refactor(daemon): build the default bus line in exactly one place (#611) (Sep 11, 2026)

束 A（PR #834）に `/simplify` を回した。**引き継ぎに「レビュー済み」とあったのを検算せず信じていた**
（記録を見ると `/simplify` も `/code:pr-review-team` も痕跡が無かった）。owner の指摘で気づいた。
memory `handoff-claims-need-primary-source-recheck` の再発である。

#### 🔴 Reuse と Altitude が**独立に同じ 1 点**を指摘

`default_bus_line_program()`（`engine_wrap.rs`）が `legacy_line_ops(BusTarget::Master, &[])` と
**同じ ops 列を手書きで再定義**していた。すぐ下の `initial_bus_line_shadows` のコメントは

> 🔴 The shadow is what a later `SetBusLine` seeds effective gains from. If it disagreed with
> what the bus is actually running, seeding would restore the wrong value and reintroduce the
> jump it exists to prevent — **so build it in exactly one place**

と書いているのに、**実装は 2 箇所で作っていた**。`legacy_line_ops` 側だけが変わると shadow が
旧い形で残り、未設定バスへの最初の `SetBusLine` が誤った seed から republish する
— **この機構が防ごうとしているポップを、この機構自身が再導入する**。
`legacy_line_ops` の呼び出しに置き換えた（1 行）。コメントの約束が実際に成立するようになった。

#### Efficiency — 中央パンの早道

`apply_line_pan` に unity の早期リターンが無く、`LineOp::Gain` が `gain != 1.0` で同じことを
しているのと非対称だった。RT コールバックのたびに `frames × 2` 回の無駄な乗算になる。

🔴 **副次的に丸め誤差が消える**。f32 では `sqrt(2) * cos(pi/4) = 0.99999994` で **1.0 ちょうどに
ならない**（実測）。省くことで `pan(0)` を書いた譜面が書かない譜面と一致し、設計 §4.1 の
「center で `(1, 1)`（unity）」が**文書どおり**になる。

#### Simplification — wire parse の形をそろえた

`pan` だけ「取得はアーム内にインライン・範囲検証は別関数」という、`gain`（1 関数）と違う分割に
なっていた。`parse_set_bus_line_pan` に揃えてアームを 1 行にした。エラーコードは
`PARAM_OUT_OF_RANGE` のまま残す（範囲外は「形が壊れている」ではない。`gain` 側を寄せるかは
既存挙動を巻き込むので本 PR では触らない）。

#### 🔴 到達できない入力でガードを検査していたテストを直した

`!pan.is_finite()` の枝を `validate_set_bus_line_pan(f64::NAN)` で検査していたが、
**非有限の pan は wire から到達できない**（2026-09-11 実測）: JSON に NaN / Infinity の
リテラルは無く、`serde_json` は `1e400` を `Error("number out of range")` として
**parse 時点で拒否する**。実際に来る形（数値でない → `MALFORMED_REQUEST`）を固定し直した。
ガード自体は型が保証していないので防御として残す。

#### 見送り

`#[inline]` が無いという指摘は**誤検知**（既に付いている。差分だけを読んだため）。
master line と bus post-loop の実行器 2 本を 1 本に畳む案は、Altitude が
「本 PR 以前からある構造で、`Pan` はそれに素直に追従しただけ。畳むなら Gain / Output も含む
別 PR」と判定したので見送る。

**検算**: `cargo test -p orbit-audio-native --lib` **83 passed** /
`-p orbit-audio-daemon --features outproc-effect --lib` **219 passed** /
`cargo fmt --check` 緑 / `cargo clippy --all-targets -- -D warnings` 緑。

### fix(e2e): copy the whole audio asset directory into the gated workspace (#611) (Sep 11, 2026)

**`#611 E2E-7` の無音の原因**。実機 gated で capture 20.2 s が **1,939,456 サンプルすべてゼロ**
だった。素材の長さでも DSL でもなく、**ハーネスが一時ワークスペースへ `kick.wav` だけを
コピーしていた**ため、`sine_440.wav` が存在しなかった。

#### 切り分けの経路（記録）

| 手順 | 結果 |
|---|---|
| capture を直接読む | 20.2 s・非ゼロサンプル **0** 件。「小さすぎて拾えない」ではなく完全な無音 |
| `gainDbToAmplitude(-40)` | **0.01**。下限クランプ無し。ゲインは原因でない |
| バスプールの枯渇を疑う | 枯渇時は throw する実装（`effect-slot.ts` の `BusPool.acquire`）で、ログにその文言なし |
| `mix.sum` の node 形を疑う | `registerMixerNode` は `mixerGlobal[kind](variableName)` を呼ぶだけで、**文字列形と同一経路**（`runtime.ts`） |
| 🔴 **エンジンを直接叩くプローブ** | 同じ譜面が**鳴った**。peak **0.007071** = `gainDbToAmplitude(-40) × equal_power_pan(0)` = 0.01 × 0.7071。譜面もエンジンも正常 |
| ハーネスの workspace 準備を読む | `prepareWorkspace` が `test-assets/audio/kick.wav` **1 ファイルだけ**を写していた（3 箇所とも） |

#### 直した形

**ディレクトリごと `fs.cpSync`** にした（3 箇所）。1 ファイルずつ列挙する設計をやめる。
**列挙は必ず一段手前で止まる** — 新しい fixture が新しい素材を使うたびにハーネスを直す形に
しない（memory `enumeration-stops-one-level-too-early`）。

#### あわせて足した観測手段

E2E-7 の `waitForSound` が落ちた時に **`get_log` の末尾を例外に添える**ようにした。
今回は「音が出ないまま時間切れ」としか言わず、原因の特定に実機実行を 2 本払った。
規律の順序（DSL を網羅した E2E → 実機で問題 → **ログで異常系を捕まえられるようにする**）
のとおり、まずログを出せるようにする。

#### 同じ実行で直したもう 2 件

- **`#661 D-2` / `D-3`**: 音の判定はすべて通っているのに、後始末の `ENOTEMPTY` だけで赤かった。
  `child.kill()` は SIGTERM を送るだけで、VS Code の agent host はその後も
  `<user-data-dir>/.../sdk-cache/` へ書き続ける。`force: true` は **ENOENT しか抑えない**。
  子の終了を待ってから消し、それでも残ったら警告して続ける `removeHarnessTree()` を置いた。
  **後始末でテストを落とさない。** 残骸は `/tmp/orbe2e-` 前置きなので次回開始時の掃除が拾う
- **`#611 E2E-7` の譜面**: `RUN` + 固定 sleep(300ms) → `LOOP` + `play(1, 0, 1, 0)` +
  **音が出るのを待つ**形へ。gated スイートで `RUN(` を使う譜面はこれ 1 本だけで、他は全部
  音を追いかけていた。`sine_440.wav` はちょうど 1.000 s（実測）なので、1.0 s 間隔の
  `play(1, 0, 1, 0)` なら隙間なく連なり、440 Hz は 1 s でちょうど 440 周期でつなぎ目の位相も連続する

### test(e2e): add the three O-surface E2E the freeze line requires (#611) (Sep 10, 2026)

凍結線の収束条件「O-surface E2E-2〜7 + E2E-10 が緑」の未達部分。B2 本体は時間制約で
この 3 本を落としていた。

| # | 何を固定するか | 判定式 |
|---|---|---|
| **E2E-6** | **位置が意味を持つこと**。`output(verb, thru: true)` を `effect([Gain(db: -12)])` の**前に**書くか**後に**書くかで混合が変わる | `g = 10^(-12/20)` として `total_A / total_B = (1 + g) / (2g)` ≈ 2.49。許容 `relativeDelta <= 0.12` |
| **E2E-7** | **再 publish の seed**。`gain(-40)` で鳴らしている最中に `gain(0)` へ切り替えてもクリックが出ない | 切替窓（±50 ms）の `max\|x[n]−x[n−1]\|` <= 定常窓の同 × 4 |
| **E2E-10** | daemon を `SIGKILL` しても音が戻り、**台数が 1 に収まる** | `relativeDelta(after, before) <= 0.05` かつ respawn 後の daemon PID が 1 個 |

**E2E-6 がなぜ `(1+g)/(2g)` か**（テストにも導出を書いた）: A は `output(verb, thru:true)` が
先なので **verb へ分岐した後に** Gain が掛かり、dry 側だけが減衰する → `total = g + 1`。
B は Gain が先なので**両方に**掛かる → `total = 2g`。これは評価フレームがあって初めて成立する
（選択範囲全体が 1 つのバッチになり、行の並び順が信号順になる）。

**E2E-7 が raw PCM を読む理由**: -40 dB → 0 dB の跳びは 1 サンプルの不連続なので、
20 ms の RMS / peak 窓では解像できない。`readCaptureForAnalysis` の float32 を直接読み、
**信号から切替点を特定する**（peak 0.01 の -40 dB は閾値 0.1 を跨がないので、envelope crossing が
そのまま `gain(0)` のランプ位置になる）。MCP 往復の壁時計に依存しない。

**E2E-10 の判断**: `expectNoNewErrors` を**呼ばない**。`SIGKILL` は意図的な fault injection で、
daemon の死そのものが ERROR に分類されるログを出す（既存の D-2 / D-3 も同じ扱い）。
`runScore()` は毎回 engine を止め直すため使えず、E2E-K3 と同じ手動 open/select/run で
1 セッションに収めた。capture は daemon 側のタップなので respawn で作り直される —
**before の RMS は kill の前に読み切る**（設計 §8.1 の注記どおり、1 本の `CaptureWindows` に
しない）。

🔴 **main が直した点**: 台数の待ちと判定が**同語反復**になっていた。`waitUntil` が
`currentPids.length === 1` を待ち、その後に `toHaveLength(1)` を assert していたので、
2 台で落ち着いた場合は waitUntil の timeout になり「respawn しなかった」という**誤った診断**が
出る。待つ条件を `>= 1` に緩め、**台数が 1 であることは assert 側で見る**ようにした。

**検算**（main が sandbox 外で実行）: `npm test` **2362 passed / 67 skipped / 2429**
（skip が 64 → 67 = 新規 3 本）・`lint` 緑・`typecheck:e2e` 緑・引用 1034 件 / 0 失敗・
gated env 未設定で spec の 39 件すべて skip。

### test(e2e): follow the dB send unit in the #643 E2E-4 golden (#611) (Sep 10, 2026)

**main が実機で回して見つけた**（委譲先の緑は実機の緑ではない）。束 B2 の実機 gated:
**33 passed / 2 failed / 1 skipped (36)**。

| 赤 | 判定 |
|---|---|
| `#643 E2E-4 preserves instrument contributions through output(sum) plus send(aux, gain)` | 🔴 **本束が動かした。追従漏れ** |
| `steps the live playhead through an instrument() sequence, rests included` | 既知の baseline 赤（設計 §8.4 の台帳。束 A の実機でも同じ 1 本だけが赤だった）。原因は fixture が `instrument()` + degree を書きながら `global.key()` を宣言していないこと＝**オラクル側の欠陥**で、本束の退行ではない |

**追従漏れの中身**: PR-O4 で `send` の第 2 引数が**線形係数から dB へ**変わった。
`#643 E2E-4` の譜面は `routeWet643.send("aux643", 0.5)` と書いており、旧解釈では 50%、
新解釈では **+0.5 dB（≈ ×1.06）**。したがって `total/dry` が 1.5 から **2.06** へ上がり、
`toBeLessThan(1.65)` で落ちた。

**直し方**: 同じ比を dB で書き直した（`send("aux643", -6)` → `10^(-6/20) = 0.501` →
`total/dry = 1.501`）。判定は式で書き、許容 ±0.15 は据え置き。**値を変えずに単位を変えた**ので、
このテストが守っていた「sum と aux の寄与が両方生きている」という性質は変わらない。

`send` を経路張りにだけ使っている 3 箇所（`fx625` / `fx628`）は送出量を判定していない
（oracle は ERROR 件数と child プロセスの有無）ので値は変えず、**dB として読むこと**を
先頭の 1 箇所に注記した。

### test(daemon): add the three bundle-A tests the design listed but never got (#611) (Sep 10, 2026)

Fable の受け入れ監査（束 A / PR #834）が **Important #1** として「設計 §11 が PR-A1 / PR-A2 の
検証として列挙したテストのうち 3 件が実在しない」ことを一次ソースで確認した。うち 2 件は
**「1 層だけ追従しない」退行の検出器そのもの**だった。

| 追加 | 何を数値で見るか |
|---|---|
| `output.rs` `master_line_pan_op_positions_the_master_buffer` | master line を `execute_master_line` へ直接流し、`Pan(-1.0)` 後の hw が `(√2, 0)` になること。buffer を全て 1.0 に揃えているのでゲインがそのまま出る |
| `session.rs` `set_bus_line_wire_pan_op_is_parsed_with_its_own_value` | `{"op":"pan","pan":0.25}` が受理され、`BusLineOp::Pan` の**中身が 0.25 と一致する**こと |
| `engine_wrap.rs` `set_bus_line_seed_for_a_new_gain_without_a_match_defaults_to_unity` | 旧に Gain が無い republish で、新 Gain の seed が既定 1.0 になること（0.5 でも 0.0 でもない） |

**なぜ必要だったか**: `LineOp` を match する実行器は master（`execute_master_line`）と
bus post-loop の **2 箇所**あり、既存テストは `render_tagged_line` 経由で **bus しか通って
いなかった**。master アームを `LineOp::Pan(_) => {}` に戻しても全件緑になる。wire 側も
形の不正（MALFORMED）しか見ておらず、`item.get("pan")` を `item.get("value")` に
取り違えても全件緑だった。

**変異検算**（3 件とも壊して赤・戻して緑を実走）:

| テスト | 変異 | 赤の実出力 |
|---|---|---|
| T1 | master 側 Pan アームを `LineOp::Pan(_) => {}` | `hard-left L=1` |
| T2 | `item.get("pan")` → `item.get("value")` | `'line[].pan' must be a number`（MALFORMED） |
| T3 | 対応無しの既定値 `1.0` → `0.0` | `left: [0.0, 0.0] / right: [1.0, 1.0]` |

production コードは **0 行**（変異は都度復元・`git diff --stat` で確認）。

**設計文書側も直した**: §4.1 に「√2 の合成が成り立つのは scheduler が鳴らす audio event に
限る」という**適用範囲**を書き足した（Fable Important #2）。`collect_source_feeds` が集める
instrument の feed は schedule 時の pan を通らないので、ライン上の Pan は
`√2 · equal_power_pan(p)` がそのまま出て、**両端で +3.01 dB** になる。中央比では
どちらも同じ等パワー則だが、絶対レベルが違う（audio event は中央が既に −3 dB）。
フルスケールの instrument を端まで振ると 0 dBFS を超えるので、**束 B の締めまでに
owner 裁定**とした（束 A では TS が `SetBusLine` を送らないので到達不能）。
§11 には欠落の経緯と「設計の検証欄を実装後にチェックリストとして突き合わせる」教訓を残した。
### feat(dsl): output(dest, thru, db), send in dB, pan as a line element (#611) (Sep 10, 2026)

`Sequence.output(dest, { thru, db })` / `send(aux, db, { enabled })` / `gain(db)` / `pan(v)` を
doc 611 §2-§3 の凍結表面へ切り替えた。解決順は `OutputDest` 解決済み → `"master"` 予約語 →
宣言済み sum/aux 名（aux も `output()` で指せるよう拡張）→ `"L,R"` 物理アウト対 → LinkAudio
channel 名（今日どおり）。数値 render bus の分岐は #611 §14 (1) のとおり解決順の外に残した
（撤回は別 PR-R 系のスコープ）。`mix.output(n)` の mono 宣言をパーサ・`MixerRuntimeNode` に足し、
`output(cue)`（`cue = mix.output(3,4)` のようなノード変数）は interpreter が
`state.mixers.nodes` を引いて `{kind:'device', channels}` へ解決してから `output()`/`send()` に
渡す。`MixerBusHandle`（sum/aux）にも同じ `output`/`send`/`gain`/`pan` を実装し、
`BUS_DSL_METHODS` へ追加した。

🔴 **`send` の dB 化で既存譜面の意味が変わる。** `kick.send("rev", 0.3)` は今日まで線形
0.3（30%）だったが、**+0.3 dB**（`10 ** (0.3/20) ≈ 1.0351` 倍・ほぼ素通し）と読まれる。名前付き
引数 `amount:` は改名されたとして loud に throw する（`db:` を使う）。golden `send`
（`tests/e2e/output-line-expectations.ts`）は `legacyTotalOverDry`（`1 + 0.3 = 1.3`）から
`dbTotalOverDry`（`1 + 10 ** (0.3/20) ≈ 2.0351`）へ切り替えた。

🔴 **`pan`/`gain`（固定値）は8本しかない insert bus プールを守るため無条件にライン要素へしない。**
`_insertBus` を持たない audio シーケンス（`effect()`/`output()`/`send()` 未宣言）では今日どおり
発音側に適用し、`_line` には要素として記録するだけに留める。バスが後から確保された瞬間
（`adoptLineOnFirstBus()`）に発音側をリセットし、`seamlessParameterUpdate` を即時再スケジュール
して二重適用を防ぐ。instrument は発音側の適用経路が無いため常にバスを確保する。
`examples/07_audio_control.orbs`（17 シーケンス・`gain()` 28 回）はこの分岐がないと 9 本目で
`pool exhausted` する。

`//#evalBegin` / `//#evalEnd` メタ行を `extension.ts`（`writeCodeToEngine`）と `repl-mode.ts`
（`AudioLine.beginBatchAll()`/`endBatchAll()`）に追加し、評価単位全体を 1 つのカーソルバッチに
した。フレーム外（生 stdin・単体テストの直接呼び出し）では各 DSL 呼び出しが自分だけの
1 要素バッチを開閉する（`Sequence.upsertLine()`）ので、`output("drums")` → `output("cue")` の
ような再宣言が今日どおり置換として効く。ガードは 2 つ: `beginBatch()` は開いたままのバッチを
暗黙に閉じてから開く。フレーム途中で拡張が落ちても、次の `//#evalBegin` が自己修復する
（統計評価文の内部エラーは `executeCurrentBuffer` の try/catch に吸収され `//#evalEnd` まで
届くので、`finally` の追加は不要だった）。ユニットで両系列を固定した
（`tests/cli/repl-eval-frame-meta.spec.ts`）。

goldens の分類（`tests/e2e/output-line-expectations.ts`）:
- `noBus` / `sumOutput` / `sequenceGainWithEffect` / `globalGainInstrument`: **不動**。
  バス無し audio は発音側適用のまま（音は同値）・`global.gain()` は atomic のまま（F2 裁定「写さない」）。
- `send`: **動く**（上記の式）。

`MixerBusHandle.output()`/`.send()`（旧 `routeOutput`/`routeSend`）は、拒否された push を
ロールバックせず「TS 側の宣言が真実・次呼び出しで全量再送」する自己修復方式へ揃えた
（`Sequence` が B1 で既に持っていた `_busLineStale` と同じ規律）。

判断を保留した点・設計との食い違い:
- `send(aux, ...)` の文字列解決は aux/sum バス名限定にし、`"master"`/`"3,4"`/LinkAudio へは
  広げなかった（設計は `OutputDest | string` としか書いておらず、aux 専用に狭めた）。
- E2E-4/E2E-5（4ch 以上のデバイス要）は `it.skip` + `console.warn` のプレースホルダのみ
  追加し、本体は書いていない（本機に該当デバイスが無く実装しても検証できない）。
- E2E-6（チェーン順序）・E2E-7（seed のポップ回避）・E2E-10（daemon respawn）・E2E-11（master
  gain の残響窓）は時間の制約で見送った。追加したのは E2E-2 / E2E-3 / E2E-S / E2E-S0 / E2E-G /
  E2E-P（実機は main が回す・未検証）。
- dev 学習サイト（`sites/dev/signal-chain/mixer-audio-line.md` 他）は多数の引用が本 PR で
  ずれたため `--fix` の機械的な再アンカーに加え、コード引用そのものを新しい実装へ差し替えた。
  ただし `SetBusRouting` 節と「Try it」節の周辺散文は歴史的経路の記録として残し、全面書き直しは
  行っていない（更新コールアウトで明示）。

### refactor(engine): route buses through SetBusLine without changing the DSL surface (#611) (Sep 10, 2026)

`AudioLine` に宛先・rack・gain・pan・output の型、評価バッチ内のカーソル規則、暗黙の rack / master
補完、wire 変換を集約した。規則 2 では要素削除後に cursor を 1 つ戻し、単文先頭の終端 output は
既存終端を同じ位置で置換する。同じ宛先の ordinal はバッチ内で数えるため、同一宛先への複数 output
も順序どおり保持できる。

`Sequence` / `Global` / `MixerBusHandle` の routing は `SetBusLine` を送るようにし、respawn 後も最後の
line intent を再送する。`Sequence.output(string | number)`、`send(name, amount)` の線形 amount、LinkAudio
と render bus の解決順は変更していない。送る program も従来の
`[rack, output(sum|master, thru: sends>0), sends…]` と同じである。

DSL 表面をこの段階で変えないのは、`OUTPUT_LINE_GOLDENS` / O0-1〜O0-4 が 1 つも動かないことを
配線の検算に使うためである。線形 send の dB 化や output の新しい引数を同時に入れると、golden が
動いた原因を「配線の誤り」と「単位・表面の変更」に切り分けられなくなるため、それらは次の PR に残した。

### feat(daemon): wire pan and mono device into SetBusLine, and carry effective gain across re-publish (#611) (Sep 10, 2026)

`SetBusLine` の wire 契約を拡張し、`pan` と 1 要素の device channels（L+R の mono merge）を
受理できるようにした。バスと master の RT では、発音側の center pan と重ねても音量が変わらない
`√2 × equal-power` の係数を block ごとに計算し、pan 位置そのものを 5 ms ramp する。

line の再 publish では、旧 program の実効値を atomic で読み、新旧 op を Gain/Pan の出現序数と
Output の宛先・出現序数で対応付けて seed する。これが無いと、演奏中に send を追加しただけで既存の
−12 dB send が一度 unity に跳ねてから戻り、約 5 ms の +12 dB burst と可聴の pop が生じるためである。
対応の無い新 Output は 0.0 から fade-in し、Gain は 1.0、Pan は指定位置から始める。旧
`SetBusRouting` の `LineProgram::legacy` / `settled` 経路は変更していない。

---
### ci(release): fail a tag push whose version disagrees with the .vsix (#843) (Sep 11, 2026)

**追記（`/simplify` 後・2026-09-11）**: cleanup 4 体のうち 2 体が実質的な指摘を出した。

🔴 **Altitude — 正本設計が既に同じ照合を規定していた。** `docs/design/656-release-design.md`
§4.4 が「`git describe --exact-match` があるとき、その tag が `v<拡張の version>` と一致すること」を
**`make-local-release.sh` のローカル preflight**（= **タグを作る前**）に置く設計として確定させていた。
私はそれを確認せずに CI 側だけを書いた。

**押された後より前に止まる方が良い** — タグ push は準公開的な行為で、間違えると remote タグの
削除と re-tag が要る。ただし手でタグを打つ経路が残る限り CI 側も**最後の砦**として意味がある。
そこで **`checkTagAgainstVersion` / `versionCore` を export したまま**にし、
設計文書の §4.4 に「preflight はこれを import すること・同じ規則を書き起こさないこと」を明記した。

🔴 **§4.4 は私の bump 計画の誤りも正した。** 私は「拡張 package.json・`ENGINE_VERSION`・
`DSL_VERSION` の 3 つを揃える」と書いていたが、§4.4 は明確に:

| 場所 | 規則 |
|---|---|
| `packages/vscode-extension/package.json` | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ |
| `ENGINE_VERSION` | **別軸**（セッションログの meta ヘッダ）。**同期しない** |
| `DSL_VERSION` | **別軸**（spec 版）。**同期しない** |

`ENGINE_VERSION 2.0.0` と拡張 `2.1.0` の食い違いは**事故ではなく設計**だった。

**Simplification** — `versionCore()` を package.json 側にも適用しているのに、
**接尾辞付きの package.json を渡すテストが 1 本も無かった**（裏づけの無い汎用性）。
テストを 1 本足して明示した（7 → 8 件）。

**Reuse / Efficiency** — 指摘なし。Reuse の Minor 1 件（テストの `REPO_ROOT` が
`bundled-child-binaries.spec.ts` と重複）は**見送った**: 実質 2 行で、
かつ**この PR の範囲外のファイル**に触ることになるため。



`release.yml` が**タグ名と `packages/vscode-extension/package.json` の version を
照合していなかった**。`vsce package` は資産名を package.json から取るので、`v3.0.0` を
打っても package.json が `2.1.0` のままなら、**Release のタイトルは v3.0.0・唯一の資産は
`orbitscore-darwin-arm64-2.1.0.vsix`** になる。どこにもエラーは出ず、
**ダウンロードした人にしか見えない**。

**照合は X.Y.Z のコアだけ**にした。既存タグを実測したところ、この repo の規約は
「prerelease の接尾辞はタグにだけ付き、package.json は素の X.Y.Z」だった:

| タグ | その時点の package.json |
|---|---|
| `v1.1.0-rc1` / `-rc2` / `-rc3` | `1.1.0` |
| `v1.0.1-rc1` | `1.0.1` |
| `v2.0.0` | `2.0.0` |

タグ全体を照合すると、この規約に沿った rc タグがすべて落ちる。

🔴 **ロジックをワークフローに埋めず `scripts/check-release-tag-version.mjs` へ出した。**
埋め込むと (a) タグを打つ前に手元で確かめられない (b) テストが書けない。
スクリプトなら `node scripts/check-release-tag-version.mjs v3.0.0` で事前に確認できる。

置き場所は **Setup Node.js の直後・`npm ci` の前**。約 25 分のビルドの手前で数秒で落ちる。
Setup Node.js より後にしたのは、runner イメージ同梱の Node ではなく**ピン留めした Node**で
走らせるため。

**検証**（変異は `$TMPDIR` へバックアップしてから実施）:

| 変異 | 結果 |
|---|---|
| 照合を `if (false)` に無効化 | 2 failed |
| workflow がスクリプトを呼ばなくなる | 1 failed |
| 接尾辞の除去をやめる（rc タグが落ちる） | 2 failed |
| エラー文から資産名を伏せる | 1 failed |
| restore | 7 passed・両ファイル baseline とバイト一致 |

🔴 **記録**: 最初の変異検証で `git checkout` を restore に使い、**新規ファイル（未追跡）は
戻らず、tracked なワークフローは自分の未コミット編集ごと消えた**。
`mutation-backup-must-use-tmpdir` の「コミット済みなら `git checkout --` が確実」は
**裏を返すと未コミットなら確実に壊す**。未コミットの作業に変異をかけるなら
`$TMPDIR` へコピーしてから。
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
- [2026-09（前半・09-01〜09-10）](../archive/WORK_LOG_2026-09.md)
