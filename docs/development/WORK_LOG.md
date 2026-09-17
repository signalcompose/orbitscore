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

### fix(docs): bundle the end-user docs site into the .vsix so it survives a cold install (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `954-vsix-docs-bundling` / **Issue**: [#954](https://github.com/signalcompose/orbitscore/issues/954)

出荷済みの `.vsix` にサイトのデータが 1 バイトも入っていなかった（`unzip -l *.vsix | grep -c 'sites/'` が 0）。
Docs パネル（WebView）と `get_dev_doc` は cold install で死んでいた。原因は
`mcp-server.ts` の `__dirname/../../..` がモノレポのルート決め打ちだったこと
（インストール済み拡張にはそのパスが存在しない）。

#### 実装した 4 点（owner 裁定どおり）

1. **パス解決を候補リスト化**（`mcp-docs.ts` に `resolveDevDocsLocation` /
   `resolveUserDocsLocation` を追加）。daemon バイナリの解決
   （`daemon-client.ts` の `resolveDaemonBinaryPath`: explicit → env → monorepo → 拡張同梱）と
   同じ「候補を順に existsSync、最初に見つかったものを使う」流儀。**順序はモノレポを先に見る**
   （daemon と同じ順）— こうすると **モノレポ dev host の挙動は一切変わらない**
   （モノレポ候補が常に先に見つかる）。dev サイトは owner 裁定により**同梱しない**ので
   候補は 1 本のみ（`available` で存在有無を返す）
2. **user サイト（Markdown 45 ファイル + built dist）を `.vsix` に同梱**。
   `scripts/copy-user-site.sh` を新設（`copy-daemon-bin.sh` と同じ形: ビルド→コピー、
   `npm run build:copy-user-site` として root package.json に配線、
   `pretest:e2e:cold-install` と `release.yml` の両方から呼ぶ）。コピー先
   `packages/vscode-extension/sites/user/` は `.gitignore` へ追加（`engine/` と同じ扱い —
   ビルド成果物であり手で編集しない）
3. **dev 側の「黙って null」をやめる**。`DEV_DOCS_UNAVAILABLE_MESSAGE` を新設し、
   HTTP 503 の body と `get_dev_doc`/`search_dev_docs` のエラーメッセージの両方に使う
   （公開 URL `https://signalcompose.github.io/orbitscore/dev/` を含む）
4. **`get_user_doc` / `search_user_docs` を新設**（`get_dev_doc`/`search_dev_docs` と同じ形）。
   これで MCP 経由で LLM が user サイト（DSL の使い方）を読む経路ができた

#### 検証

- ユニット/統合テスト: `resolveDevDocsLocation` / `resolveUserDocsLocation` の純粋関数テスト、
  HTTP 経由の `get_user_doc`/`search_user_docs` ラウンドトリップ、`tools/list` の順序テスト
  （23→28 本へ更新）を追加。`npm test` 全件 2588 passed / 79 skipped（既存含め regression 無し）
- `npm run typecheck:e2e` / `npx eslint` とも green
- **実際に `.vsix` をビルドして実測**（このセッションの sandbox 内・`npm run build` は成功した
  — 事前の懸念だった `safe-chain` の EPERM は発生しなかった）:
  `unzip -l orbitscore-darwin-arm64-4.2.0.vsix | grep -c 'sites/'` = **247**（旧: 0）、
  `sites/dev` = **0**（意図どおり同梱していない）、`sites/user/index.md` と
  `sites/user/.vitepress/dist/index.html` の両方が存在。`.vsix` サイズ増分は実測 **+7.08 MB**
  （`vsce package` の内訳表示 `sites/ (247 files) [7.08 MB]`）
- パッケージ済み `.vsix` を展開し、`__dirname` を実際のインストール先レイアウトに見立てて
  `resolveDevDocsLocation`/`resolveUserDocsLocation` を直接叩いて確認:
  `dev.available=false`・`user.source='extension-bundle'`・`get_user_doc` 相当の読み出しが
  実際に本文を返すことを確認した
- 🔴 **VS Code を実際に cold install して起動する E2E（`tests/e2e/vsix-cold-install-gated.spec.ts`）は
  この worktree では走らせていない**（`ORBIT_GATED_COLD_INSTALL` 未設定でスキップ・実機検証は
  main が sandbox 外で行う）。同 spec に `assertDocsBundled`（`get_user_doc` 成功・`get_dev_doc` が
  理由付きエラー・`/orbitscore/` が 200）を追加済みなので、次の cold-install ゲート実行時に
  自動でこの経路もカバーされる

#### 判断に迷った点

- **候補の優先順（モノレポ先 vs 同梱先）**: issue の見出しは「同梱優先 → モノレポ fallback」だったが、
  本文の必須事項は「モノレポでの挙動を変えない」で、同順序は設計判断に委ねられていた。
  daemon の前例（モノレポ→同梱）をそのまま踏襲し、**モノレポを先に見る**順にした
  （`vsce package` を一度ローカルで走らせた後に leftover が `packages/vscode-extension/sites/user/`
  へ残っていても、モノレポ dev host は自分の `sites/user` を見続けるという安全側の理由。
  コード内のコメントに理由を明記した）

---

### docs(index): follow PR #947 — the archive period label stayed at 09-12 (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `claude/docs-sync-pr947` / **追従元**: PR [#947](https://github.com/signalcompose/orbitscore/pull/947)（マージコミット `b89ce0e`）

#947 は docs のみの PR で、実装・テストは 1 行も触っていない（35 files すべて `README.md` /
`docs/` / `sites/`）。したがって仕様・ランタイム・エディタの各層に追従する対象は無い。
ただし **#947 自身がアーカイブの索引を 3 箇所のうち 2 箇所しか更新していなかった**ので、
残り 1 箇所を揃えた。

#### 直したもの（1 行）

| ファイル | 変更 |
|---|---|
| `docs/archive/WORK_LOG_2026-09.md:1` | H1 の期間ラベル `2026-09（前半・09-01〜09-12）` → `09-01〜09-13` |

#947 はアーカイブへ 20 エントリ（219 → 239）を移し、そこには **`(Sep 13, 2026)` の
エントリが 12 本**含まれていた（移設前のアーカイブには 0 本）。本体末尾の索引
（本体末尾 `## Archived sections` の索引行）と `docs/core/INDEX.md:177` は両方 `09-01〜09-13` へ
更新済みだったが、**アーカイブ側 H1 だけが `09-01〜09-12` のまま**だった。

🔴 **これは 3 度目の同じ取り残しである。** 同じ形の追従を過去に 2 回やっている
（`docs/archive/WORK_LOG_2026-09.md:1882` の「期間ラベルを `09-01〜09-06` → `09-01〜09-07`」、
および `:2497` の「docs(index): follow PR #805 — the archive period label stayed at 09-05」）。

原因は仕組みの穴で説明できる:

- `PROJECT_RULES.md` §1a のアーカイブ手順は「本体末尾に参照リンク」と
  「`docs/core/INDEX.md` の表」の 2 つしか挙げておらず、**アーカイブ側 H1 の期間ラベルを
  挙げていない**（`docs/core/PROJECT_RULES.md:118-125`）
- `tests/docs/worklog-size.spec.ts` が突合するのは本体の行数と
  「`## Archived sections` から辿れるファイル名」だけで、**期間ラベルは 3 箇所とも見ていない**
  （`tests/docs/worklog-size.spec.ts:36-50`）

手順に無く、テストも見ていないので、毎回人の注意力だけが防波堤になっている。
手順への追記とラチェット化は仕組みの変更なので、本 PR では**やらずに提案として出す**。

#### 直さなかったもの

- **`docs/user/en/USER_MANUAL.md`**: #947 は `docs/user/ja/USER_MANUAL.md` に
  「プラグイン UI: 右クリック（#939）」節を 16 行足したが en 側には足していない。
  これは片翼ではなく**意図された非対称**で、`README.md:245` が en 版を
  「deprecated, see learning site above」と明記しており、対になる公開文書
  （`sites/user/en/plugins/instrument.md` / `sites/user/en/mixing/effects.md`）は
  #947 が ja と対で更新している
- **直下のエントリ（「docs: fold the two pending docs-sync PRs, and archive 20 entries」）の
  移設前後の表にある「1,093 行 / 19 エントリ」**: 一見実測と合わないが
  （現在 1,159 行 / 20 エントリ）、**移設直後・本エントリ追記前**の値として正しい
  （`git show d67c9a5:docs/development/WORK_LOG.md | wc -l` = 1093）。自己参照の宿命であって誤りではない
- **`docs/design/883-explicit-output-routing-design.md:175` の壊れた行番号参照**: #947 の PR 本文
  §4 が既に owner へ挙げている。設計書は起案時点のスナップショットなので触らない

---

### docs: reconcile OrbitScore (frozen extension) vs OrbitStudio (native app) prose (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `948-orbitscore-orbitstudio-terminology` / **Issue**: #948

2026-09-18 の呼称確定（OrbitScore = 拡張版・OrbitStudio = ネイティブ版）を受けて、それより前の
散文が旧い意味（拡張版）のまま残っている箇所を洗い出した。`grep -rio orbitstudio` は 1,100 件超
（識別子・`OrbitStudio.app` を含む）ヒットするため、5 系統（`sites/user/`・`sites/dev/`・
`docs/`（archive・design 除く）・`docs/design/`・`tests/`）に分けて並行で読み、1 行ずつ文脈判定
した。**一括置換（sed 等）は使っていない。**

**変換**: 34 ファイル・59 箇所を `OrbitStudio` → `OrbitScore` に更新（`docs/` 15・`sites/dev/` 9
（ja/en 対）・`sites/user/` 4（ja/en 対）・`tests/` 3・`rust/crates/orbit-audio-daemon` 2・
`README.md` 1・`vitest.config.ts` 1）。識別子（`orbitstudio-mcp-gated.spec.ts` /
`ORBIT_GATED_ORBITSTUDIO` / `launchIsolatedOrbitStudio` / `dev.orbitscore.OrbitStudio` 等）・
ネイティブ版の計画/設計・`docs/archive/` は対象外のまま。

以下は **意図的に変換しなかった**（いずれも「拡張版を指す散文」ではないため）:
- `docs/development/POST_2.0_*`（12 ファイル）: Epic #292・2026-07 起案の計画文書群。
  `POST_2.0_ENGINE_AND_DISTRIBUTION.md` に「OrbitScore = 言語 / OrbitStudio = 専用アプリ
  （候補名）」の記述があり、当時から今回確定した命名と一致していたため無変換
- `docs/design/656-release-design.md` / `docs/research/EDITOR_HOST_AND_APP_SIZE.md` /
  `docs/planning/2026-09-03-issue-triage.md`: VSCodium フォークを「OrbitStudio」名でリブランド
  していた旧配布パイプライン（#830/#827 で廃止・`docs/planning/NATIVE_MIGRATION_2026-09.md` が
  「`OrbitStudio.app` = VSCodium フォーク」の枠組みを畳むと明記）。`sites/dev/editor/mcp-and-
  gated-e2e.md`（ja/en）にも同じ史実の説明段落があり、そのまま
- `docs/development/evidence/628-gated-evidence.md`: 実行ログの逐語キャプチャ（当時の実際の
  `describe` 名）
- `sessions/claude/20260707-mlts-live-jam/README.md`: 2026-07-07 時点の記録（archive 相当）
- `docs/research/WCTM_AGENT_HARNESS_EXTERNAL_DATA_RESEARCH.md` / `docs/specs-v2/DESIGN_DISCUSSION_RECORD.md`
  §「pi ベースの外部データ受信ハーネス」/ `WCTM_SYSTEM_SPEC_v1.md`: WCTM 文脈の小文字
  `orbitstudio`（対象リポジトリ外の可能性・owner 確認要）
- `CLAUDE.md:38` の「orbitstudio 集約」（Epic #413・private レポ名の可能性）
- `sites/dev/editor/vscode-architecture.md`（ja/en）1 箇所: 「OrbitScore 自身の拡張の宣言は
  効くが、**同居する `anthropic.claude-code` の宣言には効かない**」という対比の文で、後者を
  指す語を当初 fork が `OrbitScore` に変換していたのを **`OrbitStudio` へ差し戻した**（同一文に
  `OrbitScore` が二重に出て「拡張が拡張を同居させる」という意味不明な文になっていたため）。
  ここは今回定義の「OrbitScore」でも「OrbitStudio」でもない**第三の対象**（複数拡張を同居させる
  エディタプロセスそのもの）を指していた。🔴 **owner 裁定により「VS Code」と書き直した**
  （2026-09-18）。ja `:93` / en `:93` の 1 文ずつ。

  同じ行の後半「**OrbitStudio のビルド側で** workspace trust を既定 off にする層 2」
  （`product.overrides.json` + `build_orbitstudio.sh`）は**そのまま残した** — こちらは
  #830 / #827 で廃止済みの VSCodium フォークを当時「OrbitStudio」と呼んでいた**史実**で、
  識別子 `build_orbitstudio.sh` と結びついている

検証: `npm ci` / `npm run docs:build -w @orbitscore/user-site` / `-w @orbitscore/dev-site` /
`npm run docs:check` すべて green（996 citation 検証・0 failed・54 ファイル走査）。

---

### docs: fix the product names — OrbitScore is the extension, OrbitStudio is the native app (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `948-terminology-in-claude-md` / **Issue**: #948

**owner 確定（2026-09-18）**: 呼称が移動した。

| 語 | 指すもの |
|---|---|
| **OrbitScore** | **VS Code 拡張版**（機能凍結・現 4.2.0） |
| **OrbitStudio** | **macOS ネイティブ版アプリ**（これから作る・未着手） |

🔴 **2026-09-18 より前の記述では「OrbitStudio」が拡張版を指している。** 同じ語が 2 つの意味で
使われている状態なので、`CLAUDE.md` 冒頭に用語表を置いて**正本を 1 箇所に固定**した。

#### なぜ正本に書くか

ルーチンのプロンプトにだけ書いても、**同じ取り違えが別の場所で起きる**（実際に main が
この日 1 度やった。下記）。加えて **user サイトを OrbitStudio.app に同梱してローカル LLM に
読ませる計画**があり（設計 `848-docs-structure-design.md`）、**LLM は書いてあることを実行可能だと
解釈する**ので語の二義性はそのまま誤動作になる。

#### 既存記述の棚卸しは #948 へ

`grep -rio "orbitstudio"` で **1,103 箇所 / 176 ファイル**。内訳:

| 種別 | 件数 | 扱い |
|---|---|---|
| `OrbitStudio.app` | 71 | そのまま（ネイティブ版を指す） |
| 識別子（`orbitstudio-mcp-gated.spec.ts` / `ORBIT_GATED_ORBITSTUDIO` / `ORBITSTUDIO_APP` 等） | 597 | **当面そのまま**（本ファイルのマージ前ゲート手順が名指ししている） |
| **散文** | **435** | #948 の対象 |

🔴 **一括置換しない。** `NATIVE_MIGRATION_2026-09.md` と `docs/design/848-*.md` の散文には
**ネイティブ版を指す「OrbitStudio」が混ざっている**。

#### ルーチン（cloud routine `Documentation and test coverage update`）も修正した

`trig_01Qo1CTXp27QqJa6e6175BGS`。CLI（`/schedule` → `RemoteTrigger`）から更新できる
（**削除だけは Web / Desktop でしかできない**）。修正は 3 点:

1. 冒頭に**用語表**（正本は `CLAUDE.md`）と「**既存の記述をついでに書き換えない**」（#948 の仕事）
2. 分類表の「OrbitStudio（凍結版）」→ **「OrbitScore（VS Code 拡張・凍結）」**
3. 🔴 **「追従対象外」の範囲を狭めた**

3 が main の誤りだった。同日先に書いた「新ライン（追従対象外）」は **engine 線（`rust/` /
`packages/engine/`）まで除外してしまう**もので、O-multiout・ラック等の共有層が文書化されず、
**アプリの初回リリース時に一括で書くことになる**。main は直前に「リリーストリガーは差分を
まとめて読むから取りこぼす」と論じておきながら、**自分の制約で同じ状態を作っていた**。

> **除外は先送りであって削除ではない。**

正しくは「**OrbitStudio（ネイティブ app）の新規ディレクトリだけ**が追従対象外」。

#### 検証

`npm test` は pre-commit hook 経由（全件緑）。本 PR は `CLAUDE.md` と本ログのみで、
`sites/` のコード引用に触れていないため `docs:check` の対象差分は無い。

Part of #948

---

### docs: fold the two pending docs-sync PRs, and archive 20 entries (Sep 18, 2026)

**Date**: 2026-09-18 / **ブランチ**: `946-fold-docs-sync-prs` / **Issue**: #946

拡張版の機能凍結（owner 裁定 2026-09-18）を受けて **OrbitStudio**（= macOS ネイティブ版。
今後この語は拡張版を指さない）の開発に入る前に、溜まっていた docs-sync PR 2 本を畳んだ。
`BUNDLE_BRANCH_WORKFLOW.md` §「束を開く前にルーティンの追従 PR を全部消化する」に従う。

| 畳んだ PR | 追従元 | マージ前の状態 |
|---|---|---|
| [#944](https://github.com/signalcompose/orbitscore/pull/944) | #941（右クリックで 1 つの UI / 窓の floating） | `CONFLICTING`・32 files |
| [#945](https://github.com/signalcompose/orbitscore/pull/945) | #943（4.2.0 bump） | `MERGEABLE`・1 file |

衝突したのは `WORK_LOG.md` の 1 ファイルのみで、dev / user サイトの 31 ファイルは auto-merge した。
時系列に合わせて 4.2.0 bump を上、#941 追従をその下（`#940 wiring fix` の直上）に置いた。

#### 🔴 アーカイブが誘発された — 規律が正しく発火した

エントリが 2 つ増えて **`WORK_LOG.md` が 2,017 行**になり、`tests/docs/worklog-size.spec.ts` が
red になって **commit が pre-commit hook で止まった**（`PROJECT_RULES §1a` の上限 2,000 行）。

**この hook 構成には、規律違反を直す途中経過そのものがコミットできないという性質がある。**
2,000 行を超えた状態では何もコミットできないので、アーカイブを別コミットに分けられない。
そのため owner 裁定により**マージとアーカイブを 1 コミットにまとめた**。

移設: 本体 38 エントリのうち**古い 20 エントリ（944 行）**を
`docs/archive/WORK_LOG_2026-09.md` へ（`PROJECT_RULES §1a`「最新 15-20 を残す」に従い 18 本残した）。

| | 移設前 | 移設後 |
|---|---|---|
| 本体 | 2,016 行 / 38 エントリ | **1,093 行 / 19 エントリ** |
| アーカイブ | 12,715 行 | 13,663 行（+948） |

索引は**本体末尾と `docs/core/INDEX.md` の両方**を更新した。この 2 つは
**移設前から範囲表記がずれていた**（本体「09-01〜09-12」/ INDEX「09-01〜09-11」）ので、
どちらも「09-01〜09-13」に揃えた。

#### 参照の張り替え

🔴 **本ログ内の自己参照が、2 度続けてずれた。** #945 のエントリが 4.2.0 bump の版掃除を
`:57` と**行番号で**名指ししていたが、マージで 21 行（→ `:78`）、本エントリの追加でさらに
61 行（→ `:139`）下がった。**追記のたびに壊れる形だった**ので、行番号ではなく
**見出し名（「軸が逆だった」節）で引く**形に変えた。

**次から本ログ内を行番号で自己参照しない。** 本ログは先頭に追記するので、
自己参照の行番号は**書いた瞬間から陳腐化が始まる**。

**直していない壊れた参照が 1 件ある**（発見のみ・報告）:
`docs/design/883-explicit-output-routing-design.md:175` が `docs/development/WORK_LOG.md:967` を
行番号で名指ししているが、行 967 は引用されている owner 発言（「マスターが 1、2 固定」）とは
別の内容を指している。**今回の移設は行 1059 以降を削ったので、この参照は移設前から壊れていた。**
設計書は起案時点のスナップショットなので触らない（`CLAUDE.md`「docs/design/ の過去の設計書を書き換えない」）。

#### 検証

```
npm test                                    → 2577 passed / 79 skipped（hook 経由・0 failed）
npm run docs:check                          → 996 citations verified, 0 failed, 54 files
npm run docs:build -w @orbitscore/user-site → exit 0（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → exit 0（dead link 0）
```

Closes #946

---

### docs: report-only follow-up for the 4.2.0 release bump (#943) (Sep 14, 2026)

**ブランチ**: `claude/docs-sync-pr943` / **追従元**: PR [#943](https://github.com/signalcompose/orbitscore/pull/943)（merge `1276ab1f`）

**doc の追従は不要だった。** #943 は版番号の文字列と本ログのエントリしか変えておらず、
追従先（`CLAUDE.md` / `README.md` / `docs/core` / dev サイト ja+en 6 ページ）は PR 自身が更新済み。
本ログ 4.2.0 bump エントリの「軸が逆だった」節が言う「番号を固定して形を一切仮定しない」grep で検算し、
現在の版を名乗る箇所に `4.1.0` の残りが **0 件**であることを確認した
（`tests/vscode-extension/playhead.spec.ts:136` の `resolve('4.1.0')` は `play()` の引数パスで無関係）。

🔴 直さず報告（PR 本文へ）:

- **`CHANGELOG.md` が 4.2.0 で 6 版分の未記載**（`CHANGELOG.md:34` の `[1.1.0]` が最新）。
  4.1.0 の時（本ログ `:1015`）と同じ理由で、遡って書き起こすかはリリース判断
- **版表記の同期を守らせる仕組みが依然として無い**（#943 自身が `:47` で **4 回目**の取りこぼしを記録）。
  `scripts/check-release-tag-version.mjs` はタグ ↔ `package.json` しか見ず、`tests/docs/` に版の spec は無い

**検証**: `npm ci` / `docs:build`（user・dev）/ `docs:check` すべて exit 0・引用 986 件 0 failed。

---

### chore(release): bump the extension to 4.2.0 (Sep 14, 2026)

**Date**: 2026-09-14 / **ブランチ**: `942-release-4.2.0` / **Issue**: #942

#939 / #940（PR [#941](https://github.com/signalcompose/orbitscore/pull/941)）をマージしたので
拡張を **4.2.0** とする。

#### なぜ minor か

**新機能の追加で破壊的変更は無い**（semver の minor）。

- **#939**: 譜面上のプラグイン名を右クリック → **その 1 つだけ**の UI を開く経路。
  DSL の `ui("name")` は同名の挿入を全部開く（SC.10.10.1 規範 3）ため、人間には個別経路が無かった
- **#940**: VS Code が前面の時だけプラグイン窓を floating に（DAW と同じ振る舞い・
  child 自己完結で wire 変更なし）

DSL の表面・wire・出力の意味論はいずれも変えていない。
`ENGINE_VERSION 2.0.0` と `DSL_VERSION 2.0` は**別軸なので据え置き**
（`docs/design/656-release-design.md` §4.4）。

#### 🔴 版の列挙 — 番号非依存のパターンで洗った

**過去 3 回連続で 1 件落としている**（4.0.1 の post-fix commit / `README.md:55` /
`docs/core/INDEX.md:5` + `vscode-architecture.md` が ja/en とも **2 版分**取り残し）。
いずれも「現在の版番号」や特定の強調記法を狙ったパターンが原因だったので、
今回は **`(拡張|extension)` + 任意の版番号**という番号非依存の形で探した。

🔴 **それでも 4 回目の取りこぼしをした。** 番号を変数にしたが**形を固定した**パターン
（`(拡張|extension)` + 版番号）で探したため、次の **7 箇所**を最初の掃除で落とした:

| 落とした場所 | なぜ形が合わなかったか |
|---|---|
| `sites/dev/orientation/architecture-overview.md:617`（ja/en）— **正本を示す行** | 太字でなくバッククォート `` `4.1.0` `` |
| `sites/dev/decisions/adr-002-dsl-v3-pivot.md:17`（ja/en） | 「拡張」と版番号の間に括弧注記が入る |
| `sites/dev/editor/vscode-architecture.md:1159`（ja/en） | 「拡張 / extension」の語が無い（`— version 4.1.0、`） |
| `README.md:59` | `**` が版番号ではなく行全体を囲む |

**軸が逆だった。** 正しくは**番号（`4.1.0`）を固定して形を一切仮定しない**素の grep で探し、
ノイズ（vendored / lock / 履歴記述）は**後から**除く。検算も同じ方法で行い、
「更新した箇所の数」ではなく**古い番号が 0 件になったこと**を見る。

更新 **23 箇所 / 12 ファイル**:

| 種別 | ファイル |
|---|---|
| 正本 | `packages/vscode-extension/package.json` |
| 目次・仕様 | `CLAUDE.md` / `README.md`（2 箇所）/ `docs/core/INDEX.md` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2 箇所） |
| dev サイト（ja/en） | `orientation/architecture-overview.md`（各 2 箇所）/ `editor/vscode-architecture.md`（各 2 箇所）/ `decisions/adr-002-dsl-v3-pivot.md`（各 1 箇所） |

冒頭 Note（追従履歴）は**過去の記述を書き換えず、追記する**形にした。
`docs/archive/` と WORK_LOG の過去エントリは時点の記録なので触っていない。

#### ついでに直したもの — lockfile が 4 版分取り残されていた

`package-lock.json` の `packages/vscode-extension` が **`2.1.0`** のままだった
（3.0.0 / 4.0.0 / 4.0.1 / 4.1.0 の**どのバンプでも更新されていない**）。
`npm install --package-lock-only` の差分は **1 行だけ**で副作用が無かったので取り込んだ。

⚠️ 実害は確認できていない（`npm ci` は CI で通り続けていた）。
出荷 `.vsix` の版は `packages/vscode-extension/package.json` が担うため、そちらは正しかった。

#### 検証

`npm test` **2577 passed / 79 skipped**・lint 0・`docs:check` 986 引用 0 failed・
ratchet 68 passed。

---

### docs: follow PR #941 (#939 / #940) in the dev and user sites (Sep 14, 2026)

マージ済み PR [#941](https://github.com/signalcompose/orbitscore/pull/941)（`939-plugin-ui-by-cursor` →
main・merge commit `c6b8f75`）への**ドキュメント追従のみ**。`packages/` / `rust/` / `tests/` は 1 行も
触っていない。

#### 🔴 散文の参照が、PR 自身のマージ時点で既に stale だった（4 回目）

#941 は本文のコード引用（` // FILE:START-END ` 付き）を張り直したが、**引用ブロックの外にある
`path:行` 参照**（各章末の「参考にしたコード」・表のセル・本文中の丸括弧）は
`docs:check` の検査対象外なので取りこぼしが残った。しかも PR 内の後続コミットが
`engine-process.ts` を +47 行動かしたため、**PR が自分で更新した参照まで**ずれていた。

`147b742..abbc545` の差分から old→new の行マッピングを作り、**引用ブロック外の参照だけ**を
機械的に張り直した（102 件 + basename 形 14 件 = 116 件・ja/en 対）。内容が動いていない参照は
触っていない。

**取りこぼしていた「内容の誤り」3 件**（行ずれではなく、記述が事実と食い違うもの）:

| 章 | 旧記述 | 実際 |
|---|---|---|
| `editor/vscode-architecture.md:707` ほか計 6 箇所 | 「engine の spawn が env へ積むのは debug フラグと capture seam だけ」 | **`ORBIT_HOST_BUNDLE_ID` が 3 つ目**（#940）。解決できないときは `delete` する |
| `signal-chain/index.md:885` | 「rack child の spawn は `--shm` / `--chain` / `--sample-rate` の 3 引数」 | env があるときだけ **`--host-bundle-id <値>` が付く** |
| `plugin-hosting/plugin-ui.md:153` | 「Accessory ポリシーで立ち上げ、`NSTimer` で service を呼ぶ」＋ appkit.rs:205-221 の引用 | その行範囲は #940 で**前面アプリ observer に入れ替わっており**、`NSTimer` は 234-242 へ移っていた（引用は緑・散文だけが嘘） |

3 件目は「引用が緑でも散文は検査されない」の再演である。**引用を張り直すときは、その引用が
支えている散文を読み直すこと。**

#### 追記した章

- `plugin-hosting/plugin-ui.md`（ja/en）— 「エディタ面: カーソルが乗っている 1 つだけを開く（#939）」と
  「窓を前面に浮かせる（#940）」の 2 節。`pluginUiAddressFor` / `desired_plugin_window_level` /
  `set_plugin_window_level` / `NSTimer` の引用 4 本を追加。frontmatter を `c6b8f75` / 2026-09-14 へ
- `editor/mcp-and-gated-e2e.md`（ja/en）— MCP ツール表に `open_plugin_ui_at_cursor` を追加。
  **登録の述語が #939 で「組」から「1 本ずつ」に変わった**ことを明記（旧 `if (open && close)` は
  片方だけ持つホストで両方消えた）
- `editor/execution-feedback.md`（ja/en）— `var verb = mix.aux` の**レシーバが任意の識別子へ一般化**
  された件（#940 レビュー）。`mix` はただの変数なので、別名の譜面ではバス宣言を取りこぼし、
  「LinkAudio が要る」診断が誤爆していた
- user サイト（ja/en）+ `docs/user/ja/USER_MANUAL.md` — **右クリック → `OrbitScore: Open Plugin UI`**。
  `ui("名前")` が全部開くのに対しカーソルの 1 つだけを開くこと、5 種の loud な失敗、
  macOS で窓がホスト前面時だけ浮くこと

#### 直さず報告に回したもの

- `docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`（UIH の正本）に**ウィンドウレベルの規範が無い**。
  仕様を決める作業なので追従では触らない（PR 本文で質問）
- `sites/dev/decisions/adr-003-scsynth-bundle.md` の `extension.ts:2053-2088` 等 4 件は
  **#887 の分割より前**を指しており、#941 とは無関係の既存 stale
- MCP の `chain_path` / `site` が gated E2E で一度も検査されていない（ユニットのみ）

#### 検証

```
npm ci                                     → exit 0
npm run docs:build -w @orbitscore/user-site → exit 0（dead link 0）
npm run docs:build -w @orbitscore/dev-site  → exit 0（dead link 0）
npm run docs:check                          → 996 citations verified, 0 failed, 54 files
```

引用は 986 → **996**（新規 10 本 = ja 5 + en 5）。

Follows #941 / #939 / #940

---

### fix: make the #940 wiring tests platform-independent, and pin the keyword mirror (Sep 14, 2026)

レビューラウンド 3。**すべて fix 起因**の指摘で、元差分（`main..113ec39e`）起因の
新規指摘は 0 件だった（CLAUDE.md の provenance 規律により、元差分のレビューは収束とみなす）。

#### 🔴 G1 — CI が red だった。手元（macOS）では緑

ラウンド 1 の F3 で足したテスト 2 本が、**実行環境の本物の `process.platform` に依存**していた。

```
FAIL tests/vscode-extension/engine-spawn-runtime.spec.ts
  AssertionError: expected undefined to be 'dev.orbitscore.OrbitStudio'
  AssertionError: expected "spy" to be called with ... "not inside a macOS .app"
Tests  2 failed | 2563 passed
```

`resolvePluginWindowHostBundleId` は `platform !== 'darwin'` で即 return するので、
ubuntu の CI では env も付かずログも出ない。兄弟テストは `'darwin'` を明示的に渡しており踏んでいない。

**直し方**: `process.platform` を `process.execPath` と**同じパターン**で固定する
（`Object.defineProperty` → `afterEach` で復元）。🔴 配線（env に載る / 消える）を見る目的を
失わないため、純関数直呼びには**しなかった** — このテストの存在理由は
「純関数は正しいが**配線だけ**壊れている」を捕まえることである（`setDocumentDirectory` と同型）。

**検証**: main が `process.platform = 'linux'` を setup で固定して再現 → **9 passed**。
「前」の証拠は CI の赤そのもの。

🔴 **これは [[local-gates-and-ci-see-different-layers]] の再発**である。main は実機ゲート 49 passed で
「全ゲート緑」と報告したが、その時 CI は赤だった（pending の時点で見たきり追っていなかった）。

#### G2 — `DSL_KEYWORDS` が engine の正本と何も結ばれていなかった

レビュアー 2 体が独立に指摘。ラウンド 2 で足した `DSL_KEYWORDS` は
`tokenizer.ts:18-27` の `AudioTokenizer.KEYWORDS` のハンドコピーだが、
ポインタコメントも agreement test も無かった。

🔴 **同じ fix 差分の中で F1 は正しいやり方を実践していた** — `engineCatalogOrder()` が
engine の `parseAudioDSL` / `resolveRackValue` を実際に呼んで突き合わせている。

しかも pr-test-analyzer が決定的な事実を出した: **この Set を空にしても 1 語消しても、
当時のテストは 1 件も red にならなかった**（`DSL_KEYWORDS.has(ident)` が真になる経路を
1 つも駆動していなかったため）。

**足したもの（2 種類・別のことを見る）**:
- **agreement test**: `tokenizer.ts:289` の `export const KEYWORDS` と集合が一致すること
  → 「ミラーが古くなったこと」を見る。`import` を 1 語消す変異で red を確認済み
- **振る舞いテスト**: 9 語それぞれ + `effect([...])` が `unresolved-receiver` になること
  → 「ガードが効いていること」を見る

🔴 **拡張のソースから engine を import はしない**（別プロセスなのでミラーは意図的）。
テストからだけ両方を見る。

#### G3〜G6

| id | 何を |
|---|---|
| G3 | `soloWindowLayer` の権限診断が実測 1 ケースから**因果を断定**していた → 「既知の原因の一つ」へ |
| G4 | 既定の `log` を best-effort に（catch 節から呼ばれるので、ログが投げると `startEngine` ごと落ちる）。🔴 **注入された logger は握り潰さない**ことをテストで固定 |
| G5 | `receiverBefore` の docstring が「statement」と書いていたが実装は**行頭**を取るだけ → 一文一行の前提を明記 |
| G6 | `DSL_KEYWORDS` の分類列挙が語と対応していなかった → 目的（全 9 語が receiver ではない）に絞った |

#### 🔴 dev サイトの本文引用 42 件が壊れていた — `docs:check` では捕まらない層

行番号の訂正（下記）を追う過程で発見。`main` では正確だった本文中の参照が、
この PR で **47〜53 行**ずれていた:

| シンボル | main | 現在 |
|---|---|---|
| `resolveDaemonForUI` | 57 | 104 |
| `autoStartConfiguredRustEngine` | 187 | 234 |
| `startEngine` | 255 | 302 |
| `writeCodeToEngine` | 592 | 645 |

🔴 **`docs:check` は構造的にこれを検査できない** — 対象はコードブロック内の
`// file:start-end` だけで、本文中の参照は見ていない。

**直し方**: 一括シフトは**しない**。`main` 時点の開始行の**内容**を取り、それが現在版に
**一意に存在する時だけ**書き換えた（`main` で既に古かった参照は触らない）。
一意に決まらなかった 2 種（`registerTool(` は 7 箇所ある）はシンボルを特定して手作業。

⚠️ **この作業で 2 回壊して戻した**。3 回目に成功。踏んだ順:
1. スクリプトが **fenced 引用まで**書き換えた（`--fix` が既に直した正しいものを壊す）
2. fenced を除外したのに `str.replace` が**ファイル全体の同一文字列を置換**して巻き添えにした
3. fenced 判定の正規表現に**行末アンカー**を付けたため、
   `// ...:404-468 (env の組み立てを省略)` のような**意図的な省略注記つき引用**を
   fenced と認識せず、また壊した ← **過去に同じ形で踏んでいる**

#### 行番号の訂正（main の誤り）

`tests/fixtures/mcp-e2e/output_line_position_matters.orbs` の当該行は **`:39`** であり、
main が書いた `:38` は誤り。しかも main は Fable の引用を「1 行ずれている」と述べたが、
**ずれていたのは main の数え方**だった。設計文書と WORK_LOG の 2 箇所を訂正。

#### 検証

`npm test` **2577 passed / 79 skipped**・lint 0・typecheck:e2e 0・ratchet 68 passed・
`docs:check` 986 引用 0 failed・**Linux 条件の再現 9 passed**。

実機 gated は再実行していない。ラウンド 3 は `process.platform` の固定とテスト追加・
コメント訂正が中心で、**本番経路の振る舞いを変えていない**ため
（直前の全件実行は 49 passed）。

---

### fix: never resolve a DSL keyword as a plugin-UI receiver (Sep 14, 2026)

レビューラウンド 2（1 件）。**ラウンド 1 の F2 修正が入れた新しい故障モード**を潰した。
CLAUDE.md の「fixer の差分は、ラウンドを閉じる前に再点検する — この修正が導入する
新しい故障モードは何か」に従い、main の受け入れ検証で見つけたもの。

#### 何が起きていたか

F2 で入れた正規表現は宣言部を**省略可能**にしていた:

```
^\s*(?:var\s+[A-Za-z_$][\w$]*\s*=\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\b
```

その形に合わない入力では省略可能部分が**後戻り**し、キーワード `var` 自身を掴む:

```
var myRack = effect(["Comp"])   →   receiver = "var"
```

engine へ `"var"` が送られ `Unknown sequence 'var'` になる。黙りはしないが意味不明。
なお `var x = effect([...])` は**そもそも不正な DSL**（`rack.ts` の `resolveCall` は
`effect` を rack 語として受け付けない）なので、実害は文言の質だけ。

#### 直し方 — 後戻りを**構造的に不可能**にした

依頼はキーワード除外だけだったが、実装は 2 段にした:

1. 宣言部 `var <name> = ` を**先に切り落とす**（省略可能な部分が無くなるので後戻りできない）
2. その上で `DSL_KEYWORDS` のガード（防御の二段目）

`DSL_KEYWORDS` は `packages/engine/src/parser/tokenizer.ts:18-28` の
`AudioTokenizer.KEYWORDS` のミラー（9 語すべて一致を main が照合）。
このファイルは `PATH_DIRECT_PREFIXES` など engine の定数をミラーする方針なので、慣習に沿う。
⚠️ **ミラーなので、tokenizer に語が増えると古くなる**（失敗は loud・`Unknown sequence` になる）。

#### 検証

main が dist を**ビルドし直してから** receiver 10 ケースを実測し、退行 0 を確認:
`snare` / `kick` / `sum:drum` / `master` / `kick`(var 経由) / `sum:drums` /
**`null`(var myRack)** / `indented` / 3 連 `drums` / 派生 `sum:d`。

`npm test` **2565 passed / 79 skipped**・lint 0・typecheck:e2e 0・ratchet 68・
`docs:check` 986 引用 0 failed。

実機 gated は再実行していない。変更がキーワード除外に閉じており、
gated フィクスチャの receiver はすべて上のユニットで押さえられているため。

---

### fix: address the review round-1 findings for #939 / #940 (Sep 14, 2026)

レビュー 5 体（`/code:pr-review-team` フル編成 + Fable 監査を**並行**）の指摘を集約し、
main が実機コードで再現を取った 8 件を直した。

🔴 **本体は Critical 1 件 — #939 が防ぐために作られた失敗を、#939 自身が再導入していた。**

#### 何が起きていたか

```
drums.effect(["Echo", ["Echo", "Echo"], "Echo"])
engine の真の並び: [Echo#1, Echo#2, Echo#3, Echo#4] → UIH.5 index 1,2,3,4

  Echo#1 → index 1          ✅
  Echo#2 → FAIL "layer() … serial chains only"   ← layer は書かれていない
  Echo#3 → FAIL 同上
  Echo#4 → index 3, expectedName "Echo"          🔴 3 番目が開く
```

**`expectedName` ガードは名前が同じだと止められない**（`global.ts:1242` は名前しか比べない）。
つまり**エラーも警告も無しに別のインスタンスが開く**。

原因は engine との規則の食い違い。`packages/engine/src/signal-chain/rack.ts:196`:

```ts
return value.elements.flatMap((element) => resolveRackValue(element, env))
```

**素の配列は深さに関係なく親へ平坦化される。階層を作るのは `layer(...)` だけ**
（既存テスト `rack-value-resolution.spec.ts:188` が固定済み）。
スキャナは透過を **「その呼び出し語の最初の `[` か」**（`directArraySeen`）で決めており、
2 つ目以降の素の配列を layer の枝と誤認していた。

**なぜレビューまで残ったか**: フィクスチャが `layer([...])` 経由の入れ子しか持たず、
**`layer` を経由しない素の入れ子配列が 1 つも無かった**。
ユニット 2,542 件・実機 gated 48 件・`/simplify` 4 体を素通りしている。

#### 修正の規則（指摘単位のローカルパッチを避けるため、先に 5 本書いた）

| 規則 | 内容 |
|---|---|
| **P1** | チェーンのアドレスは engine の平坦化規則を 1 つだけ写す。階層を作るのは `layer` だけ |
| **P2** | receiver は **文の起点**で決まる（`.effect(` の直左ではない） |
| **P3** | 機能を黙って無効化しうる解決は、**両方の分岐で**ログを出す |
| **P4** | 登録の述語は、そのツールが**実際に使う**ハンドラだけを名指す |
| **P5** | 観測ヘルパは、絞り込みで空になったら**絞る前**を見せる |

#### 直したもの

| id | 何を |
|---|---|
| **F1** (P1) | `directArraySeen` と `TRANSPARENT_ROOT_ARRAY_WORDS` を**削除**し、`[` の直近 CallFrame が `layer` の時だけ階層を積む |
| **F2** (P2) | receiver を行の文頭から解決。`var <name> =` があれば右辺を起点に。失敗文言から誤った「1 行に書け」案内を削除 |
| **F3** (P3) | `resolvePluginWindowHostBundleId` の 4 分岐（成功 / `.app` 不在 / plist 読めない / キー不在）を `outputChannel` へ。`platform !== 'darwin'` は正常系なので黙る |
| **F4** (P4) | UI 3 ツールをそれぞれ自身のハンドラだけの述語へ分離。**登録順序は維持** |
| **F5** (P5) | `soloWindowLayer` のエラーにフィルタ前の一覧を含め、全 name が空なら画面録画権限を名指す |
| **F6** | `collectDerivedMixerBuses` の「読み手は 1 つ」コメントが**嘘だった**（`dsl-completion-context.ts:195-198` に残っている）。委譲は循環依存（`diagnostics-analysis.ts:8` が逆向きに import）なので**コメントを実態へ訂正** |
| **F7** | gated E2E が `.app/Contents/Info.plist` を `plutil` で読むようにし、bundle id の決め打ちを廃止 |
| **F8** | `.optionAll` は off-screen も含む（`CGWindow.h:137-145`）— コメント訂正 |

#### F2 の実測（訂正前 → 訂正後）

| 入力（すべて 1 行） | 前 | 後 |
|---|---|---|
| `snare.output(verb, thru: true, db: -6).effect(["Comp"])` — **core spec `:1796` の例** | undefined | `snare` |
| `kick.audio("k.wav").effect(["Comp"]).output()` | undefined | `kick` |
| `global.sum("drum").gain(-3).effect(["Comp"])` | undefined | `sum:drum` |
| `drums.effect(["A","B"]).effect(["C"])` の `C` | undefined | `drums` |

🔴 **仮定の話ではなかった。** この形は**リポジトリ自身の実機 E2E フィクスチャ**が使っている
（`tests/fixtures/mcp-e2e/output_line_position_matters.orbs:39`）。
しかも失敗文言が「keep receiver.effect([...]) on one line」— **1 行に書いてあるのに**。

#### テスト

**期待値を手書きしない形にした。** `engineCatalogOrder()` が同じ式を engine の
`parseAudioDSL` → `resolveRackValue` に実際に通し、その平坦順と拡張の index を突き合わせる。

- 素の入れ子 / **同名 4 つ** / 深い入れ子 / `chain()` を含む形（🔴 同名版が**区別するテスト** —
  名前が違う版だけでは `expectedName` が偶然守ってしまう）
- `layer` が引き続き拒否されること
- F2 の表の全行（core spec の行を含む）
- `startEngine` が `ORBIT_HOST_BUNDLE_ID` を env に載せる / 取れない時は**キーが消える**配線
- カーソルツールだけ欠けても既存 2 本が登録されること
- `window-layer` の権限診断（新規 `tests/e2e/window-layer-helper.spec.ts`）
- gated E2E に素の入れ子・同名 4 インスタンス版を 1 本追加（`index: 4` を要求し、
  **index 3 への close が失敗する**ことを確認）

#### 見送り・別 issue

| 指摘 | 判断 |
|---|---|
| `HOST_BUNDLE_ID_ARG` が 2 クレートに重複 | **見送り**。daemon は `orbit-child-runtime` に依存しておらず、共有には依存追加が要る。`--shm` も raw literal で 28 箇所に散っており慣習が無い。値がずれれば child が未知引数で落ちて loud |
| `set_plugin_window_level` が `NSApplication.windows()` **全部**にレベルを掛ける | **別 issue**。JUCE のポップアップ（独自レベル）が巻き込まれうるが、実プラグインでの確認が要る |

#### 🔴 レビュー運用で分かったこと

- **Fable を並行投入した意味があった**: Fable の I-1（receiver）と pr-test-analyzer の C1（入れ子）は
  **どちらも「差分に在るコードの誤り」ではなく「フィクスチャに無かったもの」**だった。
  code-reviewer（Critical 0 / Important 0）は差分を丁寧に追ったが、**無いものは見えない**
- **Codex が read-only sandbox で起動され、何もせず exit 0 で終わった**。`task` に **`--write`** が要る。
  `git status` にコード差分が無いことで気づいた。**「完了」を成果物で検算する**
- **dist が古いまま**で「修正が効いていない」と誤判定しかけた（[[ts-mutations-need-a-rebuild-before-real-machine]] と同型）

---

### refactor: apply the /simplify findings for #939 / #940 (Sep 14, 2026)

`/simplify`（reuse / simplification / efficiency / altitude の 4 体）が出した指摘のうち
4 件を採用、1 件を見送った。**挙動は変えていない**が、1 件は直す過程で**既存側の欠陥**が出た。

#### 🔴 直す過程で見つかった、指摘より重いもの — `mix.` 決め打ち

`plugin-name-diagnostics` が持っていた「3 本目の正規表現」を消す作業で、**既存 2 本の方が
間違っている**ことが分かった:

```
既存: /\bvar\s+(...)\s*=\s*mix\.(?:sum|aux)\b/g   ← 受け側が "mix" 決め打ち
```

`mix` は `var mix = init global.mixer`（SC.2.1）で作る**ただの変数**なので、
譜面が別名を付けた瞬間に **`declaredMixerBusNames` が派生バスを見落とす**。
[`INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md) MX.2 の例
（`var drums = mix.sum`）も `mix` を変数として導入している。受け側を一般の識別子にした。

一本化の先は `diagnostics-analysis.collectDerivedMixerBuses`。**この形を読む場所を 1 つにする**
のが目的で、3 本が文字集合もアンカリングも違っていた（同じ譜面が 3 通りに読まれうる状態）。

#### 採った 4 件

| 対象 | 何をしたか |
|---|---|
| `tests/e2e/helpers/window-layer.ts` | `execFileSync` → **`spawnSync`**。`run-cli.ts:35` が定める規約（`helpers.spec.ts` が pin）に反していた。`execFileSync` は**成功時に stdout しか返さない**ので、`CGWindowListCopyWindowInfo` が画面録画権限の警告を stderr へ出しつつ空配列を返す形が**「窓が無い」と読める**。`error` / `signal` / `status` / `stderr` を個別に見て throw する |
| `plugin-name-diagnostics.ts` | 語彙判定 4 箇所のインライン `\|\|` 連鎖を **3 つの名前付き集合**へ（`CATALOG_ROOT_WORDS` / `TRANSPARENT_ROOT_ARRAY_WORDS` / `ELEMENT_SEPARATOR_WORDS`）。**意図的な差**（`layer` は透過にしない）が並べて見える形になる |
| `diagnostics-analysis.ts` | 上記 `collectDerivedMixerBuses` を新設し、`plugin-name-diagnostics` が委譲 |
| `orbit-child-runtime` | `strip_host_bundle_id_argument` を新設。child 3 種（clap / vst3 instrument・effect rack macos）が持っていた「`--host-bundle-id` を読み捨てる」分岐を削除。**child 固有パーサに関心外のフラグを教えない**。単体テスト 3 件追加（child-runtime **40 passed**） |

#### 見送った 1 件 — `HOST_BUNDLE_ID_ARG` の daemon 側二重定義

daemon が `"--host-bundle-id"` を文字列リテラルで書いている箇所を定数へ寄せる指摘。
**`--shm` が raw literal で 28 箇所**に散っており、CLI 引数名を共有定数にする慣習が
このリポジトリに無い。レビュアー間でも評価が割れていた（reuse は指摘・altitude は
「既存慣習より厳密なので入れない」）ので、慣習を変えるなら別 PR とする。

#### 検証

`npm test` **2542 passed / 78 skipped**・`lint` 0・`typecheck:e2e` 0・
cfg 4 象限すべて緑・`cargo check --target x86_64-unknown-linux-gnu` 0・
実機 gated **48 passed**。

🔴 ファイルサイズ ratchet が 1 件赤になった。`strip_host_bundle_id_argument` の抽出で
`orbit-effect-rack-child/src/macos.rs` が **531 → 529 行**に*減った*のに baseline が
古いままだったため。baseline を下げた（ラチェットは減る方向にしか編集してはいけない、を守る側の発火）。

この追記で本体が **2,034 行**になり `worklog-size.spec.ts`（上限 2,000）も赤になったので、
末尾の 09-12 分 **415 行**を [`WORK_LOG_2026-09.md`](../archive/WORK_LOG_2026-09.md) へ移した。

---

### test(e2e): assert the plugin window level, and add a manual-gate score (#940) (Sep 14, 2026)

🔴 **設計 §5b の前提「窓の重なり順は自動で観測できない」は誤りだった。** それを根拠に
**全部を手動ゲートに置いていた**。owner の「テスト用のコードを書いて」で調べ直して分かった。

#### 何が読めるのか

`CGWindowListCopyWindowInfo` の **`kCGWindowLayer`**（0 = Normal / 3 = Floating）。
🔴 **child に `window.level()` を聞くのとは違う** — あれは*process が信じている値*で、
窓サーバが適用したかは分からない。`kCGWindowLayer` は**窓サーバ側の記録**なので、
レベルが効かなかった場合はここで食い違いとして出る。

実測（同じ child・同じビルド・**前面アプリだけ**を変えた）:

| 前面のアプリ | layer |
|---|---|
| `com.mitchellh.ghostty` | **0 = Normal** |
| `com.microsoft.VSCode` | **3 = Floating** |

#### 足したもの

- `tests/e2e/helpers/window-layer.swift` — 外部リーダ（**0.24 秒**）。1 行 1 JSON で依存を増やさない
- `tests/e2e/helpers/window-layer.ts` — `observeWindows` / `soloWindowLayer`。
  窓が 1 つでなければ **throw**（先頭を黙って選ぶと壊れた状態が数値として通る）
- gated E2E `#940` — ホスト前面 → floating → **別アプリ前面 → normal** → 戻すと floating
- `examples/manual-gates/939-940-plugin-ui.orbs` — 人が触る用（owner 依頼）。
  ⑥ に `twin.ui("CLAP Test Effect")` をコメントで置き、**同名 2 つが両方開く**のと
  右クリックで 1 つだけ開くのを**その場で見比べられる**ようにした

🔴 **区別するアサーションは「別アプリ前面で normal に戻る」。** 常時 floating を掛ける実装でも
「ホスト前面で floating」は通ってしまう。#935 と同型の失敗を避けるための本体。

#### 🔴 owner の環境で「効かない」と見えた理由 — また計測側だった

古いプロセスが残っていた: dev host **8 個** / daemon **2 個** / child 3 個。
child はいずれも **`--host-bundle-id` 無し**（#940 より前に起動したもの）で、
`desired_plugin_window_level` が `Normal` を返すのが**正しい動作**だった。
しかも `start_engine` が **`engine already running`** を返し、新ビルドの daemon は起動していなかった。

全部落として立て直すと、`Info.plist` → daemon の `ORBIT_HOST_BUNDLE_ID=com.microsoft.VSCode` →
child の `--host-bundle-id` → **layer 3** まで通った。**実装は最初から正しかった。**

昨日の「変異版 `dist` で dev host を起動」と**同じ形**。→ [[stale-processes-invalidate-real-machine-results]]

#### 途中で踏んだもの

`CLANG_MODULE_CACHE_PATH` に `/tmp` を使うと、swift が `/private/tmp` と**別物として扱い**
2 回目以降が `module 'Darwin' is defined in both` で落ちる。実体パスに固定した。

#### 検証

実機 gated **48 passed / skip 0**（#940 を含む）/ lint / `typecheck:e2e` /
`docs:check`（986 引用 0 失敗）/ `tests/repo` + `tests/docs` 86 passed。

Part of #940

---

### feat(plugin-ui): float plugin windows above the editor while OrbitScore is frontmost (#940) (Sep 14, 2026)

owner 裁定で **#939 の PR に畳んだ**（「振る舞いとしては同じ関心ですよね」）。
利用者から見れば「楽譜から UI を開く」ひとつの体験で、**#939 の手動ゲート中に発見**された。
加えて**手動ゲートは人手が要る一番高い工程**なので、分けると owner に 2 回やってもらうことになる。

🔴 main が当初「検算の機会で切る」を理由に分離を提案したのは**筋違い**だった。あの規律は
「**振る舞いを変えない**変更を、変える変更と混ぜるな」であり、本件は両方とも変え、互いの検算を潰さない。

#### 方式: child 自己完結 — **wire 変更なし**

child が `NSWorkspace` の `didActivateApplicationNotification` を購読し、
**前面が「ホストまたは自分自身」なら `NSFloatingWindowLevel`** を child の中だけで判定する。
ホストの bundle id は **spawn 時の固定値**（`ORBIT_HOST_BUNDLE_ID` → `--host-bundle-id`）。

🔴 **拡張側でフォーカスを検知する案を採らなかった理由**: `onDidChangeWindowState` は
VS Code のフォーカスしか見ないので、**プラグイン窓をクリックした瞬間に floating が外れる**。
child なら「自分が前面」を直接見られるので、この罠が構造的に起きない。
**wire を使わない方が正しい**という珍しいケース。

判定は純関数 `desired_plugin_window_level(host, child, frontmost, frontmost_is_child)` に切り出し。
**未指定時は `Normal`**（後方互換）。

#### 🔴 Codex が実測で見つけた穴（main の設計に無かった）

standalone の child では **`NSRunningApplication.current.bundleIdentifier` が `nil`** を返す
（Swift で実際に叩いて確認）。bundle id 比較だけでは「**窓自体をクリック**」が成立しない。
同一 `NSRunningApplication` オブジェクトの比較で塞いだ。IPC も host focus 購読も増やしていない。

#### 🔴 main の発注ミス: 500 行ラチェットの規律を書き忘れた

4 ファイルが超過した（`orbit-child-runtime/src/lib.rs` 551/500 ほか）。#939 のブリーフには
「`agent-handlers.ts` に足すな」と書いたのに、#940 では同じ規律が抜けていた。
baseline の書き換えは #888 子 0 の裁定で禁止なので**分割で対応**:

| 新規 | 内容 | コード行 |
|---|---|---|
| `orbit-child-runtime/src/appkit.rs` | AppKit run loop と `NSWorkspace` observer | 214 |
| `orbit-audio-daemon/src/outproc_child_command.rs` | effect child のコマンド構築 | 24 |
| `orbit-audio-daemon/src/outproc_instrument_transport.rs` | instrument の transport context | 18 |
| `orbit-effect-rack-child/src/macos/args.rs` | rack child の `Args` 型 | 6 |

`lib.rs` は **551 → 332 行**。🔴 **3 ファイルが `allowed` と同値**（余裕ゼロ）なので、
次に 1 行足すと赤くなる。レビューで扱う。

#### 引用の追従は `--fix` だけでは終わらなかった

10 件が `--fix` で解決できなかった。**コードが別ファイルへ移動**していたため
（`lib.rs:481-497` → `appkit.rs:205-221`）で、行シフトではない。ヘッダのパスごと直し、
**引用ブロックの中身も実コードから再同期**した。

🔴 `(env の組み立てを省略)` と注記のある**意図的な省略引用**を、再同期スクリプトが
全行で上書きしてしまい 1 度壊した。`git checkout` で戻し、範囲と差分行だけ手で直した。
**注記つきの引用は機械的な再生成の対象にしない。**

#### 🔴 `git add -A packages` で無関係な 18,916 行を巻き込みかけた

未追跡の `packages/sc-link-audio/`（ビルド成果物 + 埋め込み git リポジトリ）が入った。
`git reset` して**変更ファイルを明示**する形に直した（最終 1,424 行）。
memory `dont-use-git-add-all` を自分で破っていた。

#### 検証

`npm test` **2,542 passed / 77 skipped** / lint / `typecheck:e2e` / `docs:check`（986 引用 0 失敗）/
500 行ラチェット 70 passed / `cargo fmt --check` / `clippy --workspace --all-targets -D warnings` /
child-runtime 37 / daemon 305 / std-gain 実機 3 行。

🔴 **窓の重なり順は自動で観測できない。** 手動ゲート 4 項目（VS Code 前面で上に出る /
他アプリ前面で被さらない / **窓自体をクリックしても外れない** / 未指定時は normal）は**未了**。

Part of #940

---

### feat(extension): open one plugin's UI from the cursor position (#939) (Sep 14, 2026)

楽譜上のプラグイン名を右クリックし、`OrbitScore: Open Plugin UI` からそのインスタンスだけを
開く経路を追加した。同名の insert はカーソル位置から `chainPath` で区別し、engine へ渡す直前の
1 箇所だけで UIH.5 index に変換する。標準プラグイン（`Gain(...)`）もチェーン位置を消費し、
派生 sum / aux bus、master、直指定 bus の receiver を解決する。

MCP の `open_plugin_ui_at_cursor` は引数なしで同じ VS Code command id を `executeCommand` し、
メニューと同じ成功・失敗経路を通る。純関数・配線・manifest のユニット、同名 + `Gain` の gated
E2E を追加した。実機 E2E と右クリック手動ゲートは sandbox 外で実施する。

#### main の検証（工程 ④⑤・実装は Codex / 検証は main）

🔴 **委譲先の報告ではなく差分を読んで確かめた。** トラップ 4 点はいずれも正しく処理されていた:

| トラップ | 実装 |
|---|---|
| `Gain(...)` を数える | `,` を数えるのは `effect`/`instrument`/`layer`/`chain` の**フレーム直下のみ**。`Gain(db: -6, label: "x")` 内の `,` は数えず、`Gain(` 自体は要素を 1 つ進める |
| MCP が `executeCommand` を通る | `openPluginUiAtCursorForAgent` が command id を `executeCommand`。モック（`tests/mocks/vscode.ts:229-232`）も**登録済みハンドラへ委譲する形**に直っている |
| E2E の区別力 | `close_plugin_ui(index: 1)` が `no plugin UI opened` で**失敗**することを assert |
| engine 不可侵 | `packages/engine/**` / `rust/**` の差分ゼロ |

既存テストを触った 3 箇所（`mcp-server.spec.ts` / `engine-command-awaits.spec.ts` / `tests/mocks/vscode.ts`）は
**すべて追加または委譲化**で、期待値の変更は 1 つも無い。

🔴 **`npm test` は Codex の環境では完走していない**（sandbox の loopback 制限で
`listen EPERM 127.0.0.1` → `rust-engine-player.spec.ts` が 44 件 timeout）。
main が sandbox 外で回し直して **2,541 passed / 77 skipped / exit 0**。
500 行ラチェットの失敗も**新規ファイルが未追跡だったための人工物**で、index に入れれば 70 passed。
**「委譲先が緑と言った」では済ませない**という規律がそのまま効いた形。

#### main が直した 2 点

1. 🔴 **テスト名が実体と食い違っていた** — `'... the same plugin is inserted three times'` だが、
   フィクスチャは同名 CLAP **2 つ + `Gain`**。設計 §0b でフィクスチャを変えた時に**名前だけ
   取り残されていた**（Codex が報告で指摘してきた）。名前を実体に合わせ、設計側も同期した
2. **本エントリの見出しが日本語だった** — 規約は「タイトルは英語・本文は日本語」

### docs(design): design the cursor-based route to one plugin's UI (#939) (Sep 13, 2026)

**Issue**: #939（#474 の後継）。起案 = Fable subagent / レビュー = main（工程 ①→②）。
設計文書のみ。実装は次。

#### 何が問題か

DSL の `ui("名前")` は**一致する insert を全部開く**（SC.10.10.1 規範 3・仕様どおり）。
しかし**同じプラグインを 2 つ挿すと分離できない**。index 形は SC.10.10 規範 (2) で撤回済み
（ラックは入れ子になり得るので 1 次元では指せない）。
**MCP は `chain_path` で個別に指せるので、LLM は開けて人間だけが開けない。**

#### 方式は右クリック（⌘クリックではない）

仕様 SC.10.10 規範 (2) は ⌘クリックを主経路としているが、**実装手段が両方とも問題を抱える**:
`DefinitionProvider` は **⌘ホバーの peek でも発火**する（名前を見ただけで窓が開く）。
`DocumentLinkProvider` の target に `command:` URI を置く形は**公式 API ドキュメントに記載が無い**
（Context7 で確認）。一方 command URI は**ホバーの `MarkdownString`（`isTrusted`）では公式サポート**。

`contributes.menus` の `editor/context` は**既に存在**する（`orbitscore.rescanPlugins` が入っている）。
🔴 **仕様改訂が要る**（§2.5 に文面・残存 4 箇所を列挙）。

#### main のレビューで変えた 3 点

1. 🔴 **E2E のフィクスチャを `[clap, vst3, clap]` → `[clap, Gain(db: -6), clap]`**。
   旧案は**設計自身が §8 の筆頭に挙げたトラップ（`Gain` を数えない）を検出できない** —
   3 つとも非標準だと index は数え方に関わらず 1/2/3 で同じになる。`Gain` を挟むと、
   数えない実装は 3 つ目に index 2 を割り当て、**index 2 は `targets` に無い**ので loud に落ちる
2. **変異を 1 件 → 2 件**（M2「`Gain` を数えない」を受け入れ条件へ）
3. **手動ゲートに実 VST3 の右クリックを追加**（owner 指摘）。混在チェーンの index 演算は
   `#633 E2E-2` が既に実証済みだが、**VST3 の UI が開くことは自動化できない**
   （フィクスチャ `GainOracle.vst3` の `createView` がヘッドレスで null）

#### main が閉じた穴

起案は「`Gain` が offset を消費する」を **state 経路**（`pluginStateTargets`）から導いていた。
**UI 経路でも成り立つかは書かれていなかった** — `openPluginUi` も `resolvePluginStateEntry` を
呼ぶので index 空間は共有で、規則は有効。ここを確かめずに実装すると根拠が宙に浮いていた。

VS Code の `contextmenu.ts` の引用も **`raw.githubusercontent.com` から取得して逐語一致を確認**した
（委譲先の引用を鵜呑みにしない）。クリック位置が既存選択の外なら `setPosition` する。
ただし**実機は未確認**なので、§3.1 に 1 分の確認手順、§3.2 にホバーへ倒す代案を置いた。
**F1 が偽でも解決器・配線・E2E・MCP は無変更**で済む形にしてある。

#### 規模

**約 900〜1,300 変更行**（起案の 700 行は楽観的）。根拠は `#652` のエディタ側の切片で、
`plugin-name-diagnostics.ts` を新規作成して 324 行 + spec 248 + 配線 102 = **674 行**。
本件はそれを**拡張**する側。**半分近くがテスト**。
**1 PR で通す**（owner 裁定）— 分割すると束 1 が消費者のいない層になる。

Part of #939

---

### docs: bring the README back in line with the shipped 4.1.0 (Sep 13, 2026)

**Issue**: #937。README を実体と 1 行ずつ突き合わせ、**乖離 7 件**を直した。

#### 🔴 最重要: 入門例が鳴らなかった

`README.md` の `Basic DSL Syntax` は `kick.play(...)` を書いて **`.output()` が無かった**。
#883（DSL 2.0・暗黙 master 終端の廃止）以降、**`output()` の無いシーケンスは無音**である。

| | `.output()` |
|---|---|
| `examples/01_getting_started.orbs` | ✅ |
| `sites/user/getting-started/first-sound.md:50` | ✅ |
| **`README.md`** | 🔴 **無し** |

`examples/` の audio 系 10 本はすべて `output(` を含む（0 は MIDI 専用の 2 本のみ）。
**README だけが取り残されていた** — 読者が最初にコピペするコードなので実害が一番大きい。
修正後の例は `parseAudioDSL` に通して **14 statements・エラー 0** を確認した。

#### 直した残り 6 件

| 箇所 | 何が古かったか |
|---|---|
| `Current Implementation Status` | **「2.0.0 is released」** — 同じ節の別行は 4.1.0 を名乗っており自己矛盾していた |
| `Development Status` の Phase 7 | **「SuperCollider Integration」が `<details>` の外**＝現況として読めた（#502 で削除済み） |
| `Testing` の件数 | `2271/58/2329`（2026-09-10）→ **`2497/76/2573`**（実測） |
| 拡張のインストール手順 | **`Developer: Install Extension from Location...` でソースフォルダを読ませていた** — #873 / #878 が露出した層を丸ごと飛ばす経路。`npx vsce package` → `.vsix` へ変更し、`pretest:e2e:cold-install` と同じ手順に揃えた |
| Technical Features | **セッションログ（`.orbslog`）に一言も触れていなかった**（既定 off・`ORBITSCORE_SESSION_LOG=1` で opt-in） |
| `#138` の行 / `Syntax highlighting (2.0.0)` | 前者は自動化済みの注記を追加、後者は無意味な版表記を削除 |

🔴 **ビルド手順も直した** — 旧手順は `cd packages/vscode-extension && npm run build` だったが、
engine の `dist` と daemon / plugin-child のバイナリを拡張へ入れるのは**ルートの `npm run build`**
である。拡張ディレクトリだけでビルドして package すると、中身の入っていない `.vsix` になる。

#### 🔴 自分の誤り: 層を 1 つ見て「存在しない」と判断しかけた

`seq.effect()` / `seq.instrument()` / `seq.ui()` について、`Sequence` クラスの public メソッドを
列挙して**「存在しない」と結論しかけた**。実際は **interpreter の dispatch**
（`packages/engine/src/interpreter/process-statement.ts:281,285`）と
`signal-chain/runtime.ts:53,76` が DSL 表面として扱っており、README の記述は正しかった。
**DSL の表面はクラスのメソッド一覧ではない。** [[enumeration-stops-one-level-too-early]]

同様に検算して**乖離が無かった**もの: `compressor()`/`limiter()`/`normalizer()` の no-op
（`rust-engine-player.ts:1462` が warn only）/ LinkAudio の default off（`Cargo.toml:23`）/
ディレクトリ構造 11 項目 / 参照している issue 番号 10 件の状態。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。

Closes #937

---

### docs: fold the remaining docs-sync PRs and fix the version claims they found (Sep 13, 2026)

**Issue**: #933。#930 / #907 / #902 / #901 / #900 を取り込み、**#904 と #929 は close**した。

#### 🔴 #904 はマージしてはいけなかった — が、発見は正しかった

#904 は「4.0.1 の bump が漏らしたページ」を直す PR で、**main は既に 4.1.0** なので
マージすると**版が巻き戻る**（`+` 側に `4.0.1` が 16 箇所）。
**しかし指摘は当たっていた** — 4.1.0 の bump が届いていない箇所が残っていた:

| 箇所 | 直前の値 | 直した値 |
|---|---|---|
| `docs/core/INDEX.md:5` | 拡張 **3.0.0** / `DSL_VERSION 1.2` | 4.1.0 / `DSL_VERSION 2.0` |
| `sites/dev/{,en/}editor/vscode-architecture.md:15` | package version **3.0.0** | 4.1.0 |
| `sites/dev/{,en/}editor/vscode-architecture.md:1154/1155` | version **3.0.0** | 4.1.0 |

**2 版分（3.0.0 → 4.0.1 → 4.1.0）取り残されていた。** #904 の中身だけ採って 4.1.0 で書いた。

#### 🔴 版の列挙はこれで 3 回連続で漏れている

| 版 | 漏れ | 後始末 |
|---|---|---|
| 4.0.1 | 複数ページ | `10d3c7eb`「follow the bump into the pages it missed」を後出し |
| 4.1.0 | `README.md:55` | PR #928 の中で修正 |
| **今回** | 上の 5 スポット | 本 PR |

原因は毎回同じで、**grep のパターンが「現在の版の数字」や特定の強調記法に依存していた**こと。
`**4.0.1**` と `"version"` を狙ったパターンは、`VS Code 拡張 **3.0.0**` や
`package version 3.0.0` を**構造的に拾えない**（探しているのが「古い版」ではなく
「**版を名乗っている場所**」だから）。

**今後は数字に依存しないパターンで数える**:

```
(拡張|extension)[^0-9]{0,40}[0-9]+\.[0-9]+\.[0-9]+|package version [0-9]+\.[0-9]+\.[0-9]+|Current release
```

24 箇所が挙がり、1 つずつ「現在の版を名乗るのか／履歴記述か」を判定した。
履歴（`DEVELOPMENT_MAP:240` の #883、各 provenance Note、`architecture-overview:620`）は触っていない。

#### ついでに直した 2 件

- `sites/dev/en/editor/vscode-architecture.md` の `contributes.commands` が **(17)** だったが、
  `package.json` の実体は **15**。ja 側は 15 で正しく、**en だけがずれていた**
- `docs/testing/{TESTING_GUIDE,PERFORMANCE_TEST}.md` のインストール例が
  `orbitscore-0.0.1.vsix` のままで、**コピペすると失敗する**。
  `orbitscore-darwin-arm64-*.vsix`（`release.yml:129` の命名と一致）へ直した。
  `docs/user/{ja,en}/GETTING_STARTED.md` にも同じ例があるが、**両方 DEPRECATED 宣言付き**なので触っていない

#### #902 の衝突は「分割前 vs 分割後」だった

HEAD 側が `output.rs:254-260` / `session.rs:691-718` という**分割前のパス**を指したままで、
#902 が `output/lines.rs` / `output/render.rs` / `session/dispatch.rs` へ貼り直していた。
**参照リストは #902 側を採り**、frontmatter は HEAD（`verified-against: f2245bb` が新しい）を採って、
Note は**両側の固有文を文単位で統合**した。

#### #929 は差分 0 だが中身が重要（→ issue へ）

🔴 **E2E-P が裁定 D′ と旧 `√2 · equal_power_pan` 則を区別できない**ことを指摘している。
`hardLeftCh1 / hardLeftCh0 ≤ 0.05` も `centerRms / noPanRms ≈ 1` も**旧則で通る** —
発音側の差は 3 本すべてに等しく掛かるので比を取ると消えるため。
その他の指摘とあわせて issue 化した。

`docs:check` exit 0 / lint exit 0 / `npm test` 全件 pass。

Closes #933

---

### docs: re-anchor the dev-site code pointers onto the #896 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr896`

PR [#896](https://github.com/signalcompose/orbitscore/pull/896)（#888 子 2・`session.rs` 2,605 → 439 /
`output.rs` 2,587 → 322 コード行）へのドキュメント追従。

#896 は `// FILE:START-END` 引用ブロックを分割後のモジュールへ張り直しており、`npm run docs:check`
は 948 件すべて緑である。**しかし `check-citations.mjs` が見ているのは引用ブロックだけ**で、
本文中のインライン参照と各章末「参考にしたコード」の `path:line` は検査対象外だった。
その結果、**dev サイトに 44 箇所の宙に浮いた参照が残っていた**（`output.rs:3290-3322` など、
445 行しかないファイルへの参照）。

本コミットはそれらを**シンボルから引き直して**再アンカーした（ja / en 両方）:

- `sites/dev/rust-engine/index.md` — コマンド表の出典が単一 `match` ではなくなった旨を追記し、
  `session/run_loop.rs` / `session/dispatch.rs` / `dispatch_plugin.rs` / `dispatch_transport.rs` へ分解
- `sites/dev/rust-engine/insert-bus.md` — `InsertBusStage` の 2 つの参照が同一定義に解決するため 1 本へ統合
- `sites/dev/rust-engine/capture-verification.md` — `CAPTURE_RING_SECONDS` / `OutputStream` と
  `render_block_with_sources` が別ファイルへ分かれたため 2 本へ分割
- `sites/dev/signal-chain/mixer-audio-line.md` — post-loop が `output/render_full.rs` へ移った
- `sites/dev/plugin-hosting/plugin-ui.md` — `ClosePluginUI` が `session/dispatch.rs` へ移った
- 上記 5 章の `verified-against` / `verified-at` を `9c29e45` / `2026-09-12` へ更新

`/docs` 側も 2 件:

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — `validate_line_program` の `Pan` 受理と
  バス上 pan 則（`line_pan_coefficients`）を `output/line_program.rs` / `output/dsp.rs` へ
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — 最後の session 切断の判定を
  `session/params_plugin.rs` の `SessionRegistration::disconnect` へ

🔴 **発見: これらの参照は #896 より前から既に壊れていた。** 旧 `path:line` を `9d39d2e`
（#896 の base）で引き直したところ、**確認した 34 箇所のほぼ全部が無関係な行を指していた**
（例: `output.rs:823-846` は「active flag snapshot」と書かれていたが実際は `MasterLine::new`、
`session.rs:1271-1284` は「session 切断 trigger」と書かれていたが実際は outproc frames-clamped の
ticker）。**引用ブロックだけがラチェットで守られ、その隣の散文参照は誰にも検査されずに漂流していた。**
CLAUDE.md「規律を足す時は、同時にそれを守らせる仕組みを足すこと」の未適用箇所である。

**実装・テストは 1 行も変更していない。**

---

### docs: re-anchor the dev-site prose citations that PR #895 moved out of engine_wrap.rs (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr895`

PR [#895](https://github.com/signalcompose/orbitscore/pull/895)（merge commit `9d39d2e`）の
ドキュメント追従。`engine_wrap.rs` は 6,418 → 424 コード行になり、21 の子モジュールへ実体が移った。

### 🔴 `docs:check` が見ていない引用が 40 件残っていた

PR #895 は `// FILE:START-END` の**コードブロック引用**（`docs:check` が文字単位で突合する層）を
すべて直していた。直っていなかったのは、**本文と「参考」節の散文引用**である。

| 層 | #895 で直ったか | 機械検査 |
|---|---|---|
| ` ```rust // path:start-end ` のコードブロック | ✅ | `sites/dev/scripts/check-citations.mjs`（948 件） |
| 本文の `` `engine_wrap.rs:6470-6560` `` 等 | ❌ **40 件が残存** | **無い** |

`check-citations.mjs` はフェンス直後のヘッダ行しか見ないので、散文に書かれた path:line は
**ラチェットの外側**にいる。今回はそこを実ファイルへ手で突き合わせて貼り直した。

🔴 **この 40 件は #895 より前から line がずれていた**（base `0819a88` で実測。例:
`engine_wrap.rs:4455` が指していたのは `path: &std::path::Path,` の行だった）。
ただし #895 で**ファイルそのものが変わった**ので、行ずれではなく到達不能になった。

### 直した範囲

`sites/dev/`（ja）と `sites/dev/en/`（en）の 6 章 × 2 言語:
`rust-engine/index.md` / `rust-engine/insert-bus.md` / `signal-chain/index.md` /
`signal-chain/mixer-audio-line.md` / `plugin-hosting/catalog.md` / `plugin-hosting/plugin-ui.md` /
`glossary.md` / `rust-engine/oop-children.md`。

置換は 40 件の行番号付き引用と 18 件の散文言及で、**ja / en の件数一致を assert して**適用した
（片方だけ直る事故を機械で防いだ）。

### DSL 正本（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）も 5 箇所直した

MX.4 の「今日の現在地」表が `SetBusRouting` の kind 拒否と forward-only 拒否を
`engine_wrap.rs:7212-7216` / `:7237-7241` / `:5802-5806` / `:7207-7211` で引いていた。
実体は `engine_wrap/bus_lines.rs` の `set_bus_routing` にある:

| 規則 | 現在地 |
|---|---|
| `output '<name>' must be a sum bus` | `engine_wrap/bus_lines.rs:299-303` |
| `send '<name>' must be an aux bus` | `engine_wrap/bus_lines.rs:325-329` |
| forward-only（output） | `engine_wrap/bus_lines.rs:292-296` |
| forward-only（send） | `engine_wrap/bus_lines.rs:318-322` |

### frontmatter は触っていない（意図的）

`verified-against` を新しい SHA へ上げると「章全体を再検証した」と主張することになる。
本 PR が突き合わせたのは `engine_wrap/` 配下の引用だけで、同じ章が引いている
`session.rs` / `output.rs` は **PR [#896](https://github.com/signalcompose/orbitscore/pull/896)
（`9d39d2e` の直後にマージ）で分割済み**であり未検証である。`f23eb5d` のまま残すのが正しい。

### docs(dev-site): re-anchor the source pointers left behind by the #888 child-3 split (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr897` / **追従元**: PR [#897](https://github.com/signalcompose/orbitscore/pull/897)（merge `6dcd80bb2086fd6ced22e0c9711a7063e45ee535`）

PR #897 は `orbit-vst3-host/src/lib.rs` / `orbit-plugin-scan/src/lib.rs` /
`orbit-audio-sandbox/src/transport.rs` を分割し、dev サイトの **`// FILE:START-END`
引用ヘッダ 32 件**を移動先へ追随させた。しかし各章末の **`## Sources` / 「Further reading」の
散文ポインタは旧パスのまま**残っていた。

🔴 **`docs:check` はこの取りこぼしを構造的に検出できない。**
`sites/dev/scripts/check-citations.mjs` が突合するのは ```` ```rust ```` ブロック先頭の
`// FILE:START-END` ヘッダだけで、**散文の中のバッククォート付きパスは走査対象外**である。
そのため #897 は `948 citations / 0 failed` で緑のまま、**17 種 34 箇所**（ja / en 対）の
死んだポインタを残せた。

本コミットはその 17 種すべてを移動先へ張り直した（ja / en 対で 8 ファイル・計 34 箇所）:

| 旧 | 新 |
|---|---|
| `transport.rs:79-87`（`EVT_SLOTS`） | `transport/layout.rs:33-41` |
| `transport.rs:265-277`（evt ring / `dirty_epoch`） | `transport/layout.rs:222-234` |
| `transport.rs:359-378`（`ReleaseAcquireSeq`） | `transport/event_ring.rs:37-56` |
| `transport.rs:512-538`（`EventRingChild::service`） | `transport/event_ring.rs:192-218` |
| `transport.rs:1213-1225`（`UiPumpNotification`） | `transport/ui_codec.rs:33-45` |
| `transport.rs:1355-1374`（`UiPumpState`） | `transport/ui_pump.rs:63-82` |
| `transport.rs:113-143,173-288`（`CONTROL_*` / `SharedRegion`） | `transport/layout.rs:67-97,127-239` |
| `transport.rs:2031-2041`（`create_shared`） | `transport/shm.rs:171-186` |
| `plugin-scan/src/lib.rs` 9 件（カタログ型・role 判定・scan dir・dedup・atomic write） | `types.rs` / `dirs.rs` / `clap_scan.rs` / `vst3_scan.rs` / `catalog_io.rs` |

`docs/planning/DEVELOPMENT_MAP.md` の 2 件（`extra_scan_dirs_from_env` の実装位置、
`reset_child_starting` の在処）も同様に張り直した。前者は「`CLAP_PATH` 対応は同じ関数に
1 行並べるだけ」という**着手手順そのもの**を指すポインタで、死んだままだと実装者が迷う。

`verified-against` / `verified-at` は**更新していない**。STYLE_GUIDE §4 の
「小規模 cross-link / 体裁修正のみ: 更新しない（本文内容と code の対応関係に変更がないため）」に
該当する — 純粋な移動なので本文の主張は 1 つも変わっていない。

検証: `npm run docs:build`（user / dev）両方緑 / `npm run docs:check` **948 citations / 0 failed**。
張り直した 17 種は docs:check の対象外なので、`sed -n '<start>p;<end>p'` で各範囲の先頭行・
末尾行を**実ファイルから目視照合**した。

### docs: follow the install-route change into the user site (Sep 12, 2026)

**Date**: 2026-09-12 / **ブランチ**: `claude/docs-sync-pr906`

PR [#906](https://github.com/signalcompose/orbitscore/pull/906)（マージコミット `85f29aa`）の追従。
同 PR で**リリースページが持つ内容が変わった**ため、user site の記述を合わせた。

### 何が食い違ったか

`release.yml` の `--notes-file` が先頭に置くのは、**Assets からの入れ方の 1 行と、正本
（`sites/user/getting-started/installation.md`）へのリンクと、動作環境の注意**である
（`.github/workflows/release.yml:244-264`）。**手順そのものはリリースページに載らない。**

一方 user site の installation 章は、`::: tip` の中で「リリースページを開くと、そのページに
インストール手順も載っています」と書いていた。#906 以前から v4.0.0 で外れていた約束であり、
#906 の後も**手順ではなくリンクが載る**ので、どちらの意味でも成り立たない。

### やったこと

| ファイル | 変更 |
|---|---|
| `sites/user/getting-started/installation.md:33` | tip を「Assets に直接行ける / 先頭に動作環境とこのページへのリンクが置かれる / 手順の正本はこのページ」に書き換え |
| `sites/user/en/getting-started/installation.md:33` | 同内容の英語版（バイリンガル必須） |

### やらなかったこと

- **`docs/user/ja/USER_MANUAL.md:65`** に同じ文が残っているが、この文書は **DEPRECATED で
  「履歴として保持」（#237）**。#906 でも同じ理由で意図的に触れていないため、追従対象から外した
- **`sites/dev/`** — 差分はリリースノートの生成（配布面）であり、dev site の章立て
  （内部構造・評価経路）に該当する節が無い
- **実装・テスト** — 変更なし（本追従はドキュメントのみ）
### docs: fold the four pending docs-sync PRs into one branch (Sep 13, 2026)

**Issue**: #931。bot の docs 同期 PR **4 本**（#923 / #916 / #925 / #915）をまとめて取り込んだ。

#### 🔴 1 本ずつ入れると、入れるたびに残りが衝突し直す

4 本とも `WORK_LOG.md` を触るので、**1 本 main へ入れた瞬間に残り 3 本が衝突する**。
実際 4.1.0 の作業で #927 を入れた直後、4 本が一斉に `CONFLICTING` になった。
1 つの枝で解消すれば、衝突解消もゲートも 1 回で済む。判定は GitHub の
`mergeStateStatus` が `UNKNOWN` を返し続けたので **`git merge-tree --write-tree` で手元実測**した。

#### 🔴 #916 が「黙って」取り込めていなかった

ループで 4 本を merge した時、**#916 だけマージコミットが作られていなかった**。
原因は**サンドボックス**で、#916 は `.claude/hooks/README.md` を触るが、このディレクトリは
**Bash も git も書き込み拒否**される（[[hook-guards-must-check-the-path-not-just-the-branch]]）。
`git merge` はエラーを出していたが、私の `grep -E 'CONFLICT|Merge made'` がその行を落としていた。

**「4 本回した」は根拠にならない。** `git merge-base --is-ancestor <head> HEAD` を
4 本すべてに対して回して初めて分かった。**ループの結果は件数ではなく到達性で検算する。**

#### zsh は未クォート変数を単語分割しない

`U=$(git diff --name-only --diff-filter=U)` を `for f in $U` で回したが、zsh では
**分割されず 1 つの文字列として渡り**、`FileNotFoundError` になった。bash の癖で書いていた。

#### 衝突の解消方針

| 対象 | 方針 |
|---|---|
| `WORK_LOG.md` の新規エントリ同士 | **両側保持**（別の作業の記録なので落とすものが無い） |
| 既にアーカイブ済みの 3 エントリ | **HEAD（空）を採る** — `### ` 見出しの集合演算で本体 × アーカイブの重複 0 を確認 |
| `mcp-and-gated-e2e.md` の Note | HEAD が追従チェーンの上位集合（#917 まで）なので HEAD を採り、#915 固有の分割告知だけ足す |
| アーカイブの索引行 | 両方の説明を統合 |

#### 検査（bot は但し書きを読まない）

#915 の貼り直しは**散文中のファイル参照**で、`docs:check` の対象外（逐語一致するのは
`// file:start-end` の引用ブロックだけ）。**5 件を抜き取って実ファイルと突き合わせ**、
`autoStartConfiguredRustEngine()` / 括弧バランス判定 / `deactivate()` / `EvalMarkBridge` /
`setupErrorHandler` のいずれも正しい位置に着地していることを確認した。

`docs:check` exit 0 / lint exit 0 / `tests/docs` + `tests/repo` 86 passed。
本体が 1,970 行になったので `test: add a file-size ratchet` を 1 件アーカイブへ移した（162 行）。

Closes #931

---

### docs(hooks): follow PR #914 in the hook docs (Sep 13, 2026)

PR [#914](https://github.com/signalcompose/orbitscore/pull/914)（merge commit `7061245`）が
`.claude/hooks/pre-edit-check.sh` の判定を「ブランチ名だけ」から
「ブランチ名 + **編集先が repo 配下か**」に変えたので、フックの挙動を書いている
ドキュメント 2 箇所を実装に追従させた（ドキュメントのみ・実装とテストは変更なし）。

#### 変更内容

- `.claude/hooks/README.md` §1: 「対象外 / 判定できない入力の倒し方」の表を追加。
  plan file（#153）と **repo 外の絶対パス**（#913）が allow、相対パス・`..` を含む絶対パス・
  `file_path` 無しは deny 側へ倒れることを明記。テストの所在（`tests/repo/pre-edit-hook.spec.ts`）も追記
- `CLAUDE.md` "Hook Protection": `pre-edit-check.sh` の説明に「**リポジトリ配下のみ**」を追記

#### 差分外だが同じ節にあった誤り（併せて訂正）

`.claude/hooks/README.md` はブロック方式を **exit 2** と書いていたが、実装は
Issue #119 以降 `permissionDecision: "deny"` の JSON を stdout に出して **exit 0** である
（`.claude/hooks/pre-edit-check.sh:91-92`）。#914 の差分ではないが、書き換えた同じ箇条書きの
中にあったため放置せず訂正した。

#### 追従不要と判断したもの

- `docs/specs-v2/` / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: DSL の構文・意味論は無変更
- `sites/user/` / `sites/dev/`: 両サイトとも `pre-edit-check` / Claude Code hooks に言及していない
  （`grep -rl "pre-edit" sites/` が 0 件）。バイリンガル追従の対象も発生しない
- `docs/archive/WORK_LOG_2026-09.md`: #914 が WORK_LOG の行数上限（2,000 行）のために
  退避した既存エントリ。過去ログなので触らない


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
- [2026-09（前半・09-01〜09-13）](../archive/WORK_LOG_2026-09.md) — #883 束 C のレビュー round 1、#883 束 S / 本体 (#883)、#888 子 1、#878、4.1.0 リリース (#926)、pan を両段とも減衰のみにした裁定 (#921/#922)、E2E-4/E2E-5 の実機実装 (#917) を含む
