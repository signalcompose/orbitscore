# 設計: 文書（user / dev サイト）の保持構造 — 両版の共存・アプリ同梱・追従ルーチン（#848 別冊）

**対象 issue**: #848（ネイティブ版の設計・計画・地図）の別冊
**関連**: [`848-native-orbitstudio-design.md`](848-native-orbitstudio-design.md)（本体・D-9 / §9.1 / §10.3 / §14 (15)〜(20) から参照）/ [`IMPLEMENTATION_PLAN_NATIVE.md`](../planning/IMPLEMENTATION_PLAN_NATIVE.md)（R-app N4-e・docs の連続 PR ①〜③）/ [`NATIVE_DEVELOPMENT_MAP.md`](../planning/NATIVE_DEVELOPMENT_MAP.md) §4.G
**状態**: 設計（実装しない）・2026-09-18・main `1276ab1f` 実測
**起案 / 審査**: Fable（effort: high）/ main。**owner 裁定待ちは §10**。
**用語**: **OrbitStudio = macOS ネイティブ版アプリ**（owner 2026-09-18）。VS Code 拡張は「拡張版」（4.2.0・機能凍結）。

> 🔴 **読み方**: §1 の owner 要件 4 点が制約のすべて。§2 は本書の核（「実装依存 / 非依存」は 1 軸ではなく 2 軸に割れる）。
> §3〜§7 がブリーフの Q1〜Q4 への答え。§9 に確信度と反証、§10 に裁定待ち。「実測」はすべて `path:line` か実行コマンドを併記した。
> main の見立て（ブリーフ §5.3）は**入力**として扱い、同意する箇所も反対する箇所も理由を書いた。

---

## 0. 実測 — 現状の文書とその配布（2026-09-18・main `1276ab1f`）

| 項目 | 事実 | 出典 |
|---|---|---|
| user サイト | **21 章（ja）・153,918 bytes**。en は同じ 21 章。frontmatter は `title` / `description` のみ | `find sites/user -name '*.md'` / `cat … \| wc -c` / `sites/user/STYLE_GUIDE.md:43-52` |
| dev サイト | **27 章（ja）・1,193,871 bytes**。en あり。frontmatter は `title` / `chapter-id` / `verified-against` / `verified-at` / `status`。全章 `draft`（`index.md` のみ `stable`・`what-is-orbitscore.md` は `stub`） | `grep -H "^status:" sites/dev/**/*.md` / `sites/dev/STYLE_GUIDE.md:52-89` |
| 引用の機械検証 | dev サイトのみ。`// <file>:<start>-<end>` 付きコードブロックを実ファイルと突合（`npm run docs:check`）。user サイトは対象外（`SKIP_DIRS` と `walk()` は `sites/dev` 配下だけ） | `sites/dev/scripts/check-citations.mjs:1-50` / `docs/development/USER_LEARNING_SITE.md:110`（user は line range 引用を採らない） |
| 公開 | **GitHub Pages・`main` への push で即 deploy**（`paths: sites/**`）。user = `/orbitscore/`・dev = `/orbitscore/dev/` | `.github/workflows/deploy-sites.yml:15-22,56-70` |
| 版の分岐 | **無し**。`base` は固定（`'/orbitscore/'` / `'/orbitscore/dev/'`）。locales は ja / en のみ | `sites/user/.vitepress/config.ts:11,18-69` / `sites/dev/.vitepress/config.ts:6,14` |
| `.vsix` への同梱 | 🔴 **無し**。`.vscodeignore` が `../../**` と `../*/**` を除外 | `packages/vscode-extension/.vscodeignore:20,28` |
| 拡張の Docs 機能 | Docs パネル / `openDocs` / `get_dev_doc` / `search_dev_docs` は **`__dirname/../../..`（= モノレポ root）の `sites/*/.vitepress/dist` と `sites/dev` ソース**を読む → cold install では**動かない** | `packages/vscode-extension/src/mcp-server.ts:89,137-138` / `mcp-docs.ts:29-36,90-101,103-136` / `docs-panels.ts:17-26` |
| Docs 機能の E2E | **0 本**（gated suite に `get_dev_doc` / `search_dev_docs` の呼び出し無し） | `grep -n "get_dev_doc\|search_dev_docs" tests/e2e/orbitstudio-mcp-gated.spec.ts` = 0 件 |
| リリースノートの導線 | インストール手順は `installation.md` を正本にし、リリースノートは**リンクだけ**（v4.0.0 で手書き手順が消えた #905 の教訓） | `.github/workflows/release.yml:245-252` |
| 版の表記の現状 | user サイトは `#883 / DSL 2.0`・`v3.0 以降`・`2.0.0 時点の仕様 — post-2.0 で見直し予定`・`配布されている OrbitScore（.vsix）では …` など**自由文で 4 種以上の形** | `sites/user/mixing/routing.md:20,41,100` / `basics/live-coding.md:172` / `midi/mode-scale.md:10-12` / `midi/link-audio.md:11` |
| 版の掃除の実績 | 4.2.0 のバンプで**形を狙った grep が 4 回連続で取りこぼし**、番号固定の素の grep でしか全件を拾えなかった | `docs/development/WORK_LOG.md`「版の列挙 — 番号非依存のパターンで洗った」（2026-09-14） |
| 追従ルーチン | Claude Code の cloud routine が **PR マージをトリガー**に `claude/docs-sync-pr<N>` で draft PR を出す。9 本 / 7 本をまとめて取り込んだ実績（#867 / #933） | `docs/archive/WORK_LOG_2026-09.md:264-268,1125,1481,1503` / `git log --merges`（`931-fold-docs-sync-prs` / `933-fold-remaining-docs-sync`） |
| ルーチンの手順本文 | **確認できず**（cloud 側・リポジトリ外。2026-09-18 に main が追記した「凍結線」の 2 行 + 2 行も本文はリポジトリに無い。`grep -rn "追従対象外" docs .github` = 0 件） | — |
| 翻訳の追従 | `TRANSLATION_STATUS.md` が章単位で `done` / `outdated` を持ち、ja が更新されたら `outdated` に切り替える運用 | `docs/development/TRANSLATION_STATUS.md:3-4` |
| 一次情報の階層 | code → DDD 文書（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` 2,334 行・`docs/user/ja/USER_MANUAL.md` 843 行）→ user サイト / dev サイト（derivative） | `docs/development/USER_LEARNING_SITE.md:32-44` |

---

## 1. owner 要件（2026-09-18）と、それが決める制約

| # | 要件 | 制約として読むと |
|---|---|---|
| R-1 | **user サイト等を OrbitStudio アプリに同梱し、ローカルの LLM に参照させたい** | (a) 同梱物は**オフラインで完結**する（online 取得に頼らない）。(b) LLM が読む形式は **Markdown**（HTML は hydration 用の JS と `base` 付き URL を含み、LLM には雑音）。(c) 「同梱物 = そのリリースの真実」なので、**そのリリースに無い機能を書かない**（F-11） |
| R-2 | **DSL とエンジンの情報は OrbitStudio の方が先に進む**（拡張版は凍結） | 版のずれは**恒常的**で、「一時的な差」ではない。engine 線（O-multiout・ラック・render・.orbslog）は全部アプリだけに入る |
| R-3 | **拡張版を将来メンテナンスする可能性は残す** | 拡張版の読者向けの記述を**消せない**。「アプリ主語へ全面書き換え」（設計 §10.3 初版）はこれに反する |
| R-4 | 「出荷済みのものだけを書く」が理想だが、**リリース後に文書を更新するとリリース成果物に乗らない** | 同梱物は必ず「同梱した時点」で止まる。**止まることを隠さず**（manifest に commit を刻む）、**止まる前に未リリースを混ぜない**（マーカーの 0 件検査）の 2 つで受ける |

**R-1 と R-4 は同じ話の表裏**: 同梱は「ある commit のスナップショット」なので、問題は「古くなる」ことではなく「**スナップショットに未来（未リリース）が混ざる**」こと。サイトは `main` から deploy されている（§0）ので、`main` の文書は**常に未リリースを含む**。ここが Q3 と Q4 が繋がる点。

---

## 2. 🔴 本書の核 — 「実装依存 / 非依存」は 1 軸ではなく 2 軸

main の見立て（Q1）は「DSL / エンジンの章 = 非依存、editor / getting-started / 配布 = 依存」だった。全 21 + 27 章を読んで分けると、**依存には性質の違う 2 種類**があり、1 軸に畳むと「非依存に見えて依存」が必ず漏れる。

| 軸 | 何に依存するか | 粒度 | 例（実測） |
|---|---|---|---|
| **軸 A: host 表面** | どのエディタ / アプリで操作するか（コマンドパレット・ステータスバー・Activity Bar・電球アイコン・`.vsix`） | **段落**（章丸ごとは少ない） | `basics/live-coding.md:14`「VS Code（または Cursor）での基本操作は `Cmd+Enter`」/ `plugins/instrument.md:37`・`mixing/effects.md:59`「コマンドパレットから **OrbitScore: Rescan Plugin Catalog**」/ `mixing/routing.md:145`「クイックフィックス（電球アイコン）」/ `troubleshooting.md:23,62,72,76,132` |
| **軸 B: 可用性（配布線 × 版）** | その機能が**どの配布線のどの版**から使えるか | **機能**（章をまたぐ・DSL の章に**最も多く**現れる） | `midi/link-audio.md:11`「**配布されている OrbitScore（`.vsix`）では LinkAudio の音声送出が動きません**」（エンジンは同じバイナリでも `link-audio` feature が配布ビルドで off・CLAUDE.md「LinkAudio」）/ `plugins/instrument.md:98-100`「オフラインレンダ先の指定は未対応 / LinkAudio チャンネルへの `output()` も未対応」（engine 線で先にアプリへ入る）/ `getting-started/engine-settings.md:33`「バッファサイズの変更 … は未実装」（性能項目はネイティブ版が引き継ぐ・memory `performance-work-moves-to-the-native-line`）/ `midi/mode-scale.md:10-12`「2.0.0 時点の仕様 — post-2.0 で見直し」/ `reference/methods.md:435,460`「`seq.output(n)` は仕様上撤回済み」 |

**帰結**:

1. **軸 A は章の分類でよい**（editor / getting-started / 配布に集中し、DSL の章には**段落**として散在する）。段落は「拡張版: … / OrbitStudio: …」の**併記**で済み、DSL の記述は二重化しない。
2. **軸 B は章の分類では捕まらない**。DSL 仕様の章（`basics/` `midi/` `mixing/` `reference/`）こそ engine 線の進みが最初に現れる場所で、「非依存」と分類した瞬間に**アプリで先行した機能が拡張版にも在るかのように読まれる**。軸 B は**機能単位の可用性表記**（§5）で受ける。
3. したがって Q1 の答えは「妥当だが不十分」: **章の分類（軸 A）+ 機能の可用性表記（軸 B）の 2 段**にする。

🔴 **main の見立てが誤っている箇所**（積極的に探した結果）:

| 見立て | 実測 | 判定 |
|---|---|---|
| `midi/` は非依存 | `midi/link-audio.md` は**配布ビルドの feature flag** に依存（`.vsix` では動かない・`orbit-link-audio` は同梱されない）。アプリ版で有効化するかは未決（memory `link_licensing_and_plugin_route_2026_09_11`）→ **軸 B で最も強く依存する章** | 誤り（軸 B） |
| `reference/` は非依存 | `reference/methods.md:360` LinkAudio 行・`:435,460` 撤回済み `output(n)`・`:451` エディタの `output-missing` 警告と**クイックフィックス**（軸 A） | 部分的に誤り（両軸） |
| `basics/` は非依存 | `basics/live-coding.md:12-36` は章の 1/4 が `Cmd+Enter` の**操作説明**で「VS Code（または Cursor）」を名指し（軸 A）。⌘Enter 自体はアプリでも同じ（設計 §7.1）だが、subject-block の意味論を層 2 に移す（設計 §5.4）ので**振る舞いは同じ・表記だけ host 依存** | 部分的に誤り（軸 A・段落） |
| `mixing/` は非依存 | `mixing/routing.md:41,145` 診断名 `dry-not-routed` / `output-missing` とクイックフィックスの表示（軸 A・計算は層 2 で同じ = 設計 §5.5） | 部分的に誤り（軸 A・段落） |
| `plugins/` は非依存 | `plugins/instrument.md:37` コマンドパレット（軸 A）・`:97-100` 未実装リスト（軸 B・engine 線で先にアプリへ） | 誤り（両軸） |
| `getting-started/` は依存 | `first-sound.md` の DSL 部分（`:41-54,106-119`）と `engine-settings.md` の**エンジンの振る舞い**（`:44-62` デバイス切替の縮退規則 = 層 1 の規則）は非依存。依存なのは手順（`:29-35,62-64,96-98`）と UI の置き場（`engine-settings.md:12-20`） | 粗い（章内に両方） |
| `rust-engine/` `signal-chain/` は非依存（dev） | 引用は `rust/` 中心で `packages/vscode-extension` の引用は 0〜1 件。**ただし layer 1 の wire は engine 線で v0.2 → v0.3 に進んだ**（`protocol.rs:8`）ので、dev サイトは「拡張版では v0.2 相当のまま」を表せない。dev サイトは `verified-against` で commit を刻む（`STYLE_GUIDE.md:91-99`）ので**軸 B は既に持っている**（章単位・commit 粒度） | 正しい（軸 B は既存機構が受ける） |
| `editor/` は依存（dev） | `editor/vscode-architecture.md`（`packages/vscode-extension` 引用 65 件）/ `execution-feedback.md`（39）/ `mcp-and-gated-e2e.md`（50）。**ただし後 2 章の半分は層 2 の話**（MCP ツールの意味論・gated ハーネス）で、ネイティブ線でも生きる | 正しいが、章の**中**で層 2 と層 3 が混ざる |

---

## 3. Q1 — 章の分類（軸 A: host 表面）

### 3.1 分類の定義

| 値 | 意味 | 同梱 | 書き方 |
|---|---|---|---|
| `both` | 両版で同じ内容。host 依存の**段落**があれば併記 | ✅ | DSL の記述は 1 本。段落は `拡張版: … / OrbitStudio: …` |
| `app` | OrbitStudio だけの章（インストール・アプリの環境設定・Docs パネル・右クリック） | ✅ | 拡張版の読者には見出しで分かる |
| `ext` | 拡張版だけの章（`.vsix` のインストール・VS Code の設定・Activity Bar） | ❌（アプリには同梱しない） | 凍結版の bug fix 以外は触らない |
| `both+split` | 章は共通だが、手順の節が版で分かれる（`first-sound.md` の「ステップ 2: VS Code でフォルダを開く」等） | ✅（`ext` 節は同梱時に落とす・§6.3） | 節見出しに host を書く（§5.2） |

frontmatter に **`host: both | app | ext | both+split`** を持たせ（§5.3）、同梱スクリプトが機械で選ぶ。

### 3.2 user サイト 21 章の判定（ja・en は同じ）

| # | 章 | 行数 | 軸 A（host） | 軸 B（可用性・機能単位で §5 の行が要る箇所） | 根拠 |
|---|---|---|---|---|---|
| 1 | `index.md` | 92 | **both**（主語 `VS Code の上で` `:8,40,90`・動作環境 `:84-86` は併記へ） | — | `:3,8,40,59,84-86,90` |
| 2 | `getting-started/installation.md` | 94 | **ext**（`.vsix` の入れ方だけ）。**`app` 版の章を新設**（`.dmg`・Gatekeeper・cold-install = 設計 D-7） | — | 全文 |
| 3 | `getting-started/first-sound.md` | 125 | **both+split**（DSL `:41-54,106-119` は共通。手順 `:8,12,29-35,62-64,96-98` は分岐） | — | 同 |
| 4 | `getting-started/engine-settings.md` | 63 | **both+split**（起動 UI `:12-20` は分岐。デバイス縮退規則 `:44-62` は層 1 で共通） | `:33` バッファ / SR / マルチチャンネル（性能はネイティブ線・memory `performance-work-moves-to-the-native-line`・#848） | 同 |
| 5 | `basics/patterns.md` | 165 | both | — | host 語 0 件 |
| 6 | `basics/multiple-sequences.md` | 165 | both（`:124` `Cmd+Enter` 1 箇所 → 併記不要・キーは同じ） | — | `:124` |
| 7 | `basics/polyrhythm.md` | 134 | both | — | 0 件 |
| 8 | `basics/audio-manipulation.md` | 276 | both | — | 0 件 |
| 9 | `basics/live-coding.md` | 268 | **both**（`:12-36` の `Cmd+Enter` 節で「VS Code（または Cursor）」を併記に。振る舞いは層 2 で共通・設計 §5.4） | `:172`「v3.0 以降」（既に版付き・文法を §5 に揃える） | `:14,36,124,126,162,190,255` |
| 10 | `midi/index.md` | 151 | both | `:8,95-97`「2.0.0 時点の仕様 — post-2.0 で見直し」 | 同 |
| 11 | `midi/pitch-dsl.md` | 212 | both | — | 0 件 |
| 12 | `midi/mode-scale.md` | 136 | both | `:10-12,69-71` 同上 | 同 |
| 13 | `midi/voicing.md` | 190 | both | `:74` `.orbslog` は既定 off（L 束で変わる） | 同 |
| 14 | `midi/link-audio.md` | 178 | both | 🔴 **章全体が配布ビルドに依存**（`:11-24` `.vsix` では送出しない・アプリ版で有効化するかは未決）。§5 の行を章頭に置き、両線の値を書く | `:11,18,124,128,167,171` |
| 15 | `midi/quantize.md` | 100 | both | — | 0 件 |
| 16 | `plugins/instrument.md` | 113 | **both**（`:37` コマンドパレット → 併記） | `:22` `.component` 未対応 / `:97-100` CC・render・LinkAudio 未実装（engine 線で先にアプリへ） | 同 |
| 17 | `mixing/effects.md` | 148 | **both**（`:59` コマンドパレット → 併記） | — | `:59` |
| 18 | `mixing/routing.md` | 182 | **both**（`:41,145` 診断名とクイックフィックスの**表示**は併記。計算は共通） | `:20,41,100` `#883 / DSL 2.0`（文法を揃える） | 同 |
| 19 | `projects/import.md` | 92 | both | `:35` 同上 | 同 |
| 20 | `reference/methods.md` | 506 | **both**（`:451` クイックフィックス → 併記） | `:143` v3.0 / `:268` v2.0.0 / `:360` LinkAudio / `:435,460-461` 撤回済み `output(n)` | 同 |
| 21 | `troubleshooting.md` | 132 | **both+split**（`:23,62` UI の置き場・`:66-76` `Cmd+Enter` が動かない = 拡張固有の節・`:132` `View → Output → OrbitScore`） | `:14` `#883 / DSL 2.0` | 同 |

集計: `both` 14 / `both+split` 4 / `ext` 1（→ `app` を 1 章新設）/ `app` 0（→ 少なくとも `installation`・「アプリの環境設定」・「Docs パネルと LLM」の 3 章が増える見込み。**表面が確定する A-parity 後に書く**・設計 §14 (20)）。**軸 B の行が要る章は 11**（うち DSL / エンジンの章が 9）— これが「非依存に見えて依存」の実数。

### 3.3 dev サイト 27 章の判定

dev サイトは読者が開発者で、`verified-against`（commit）が既に軸 B を章単位で持つ（`sites/dev/STYLE_GUIDE.md:91-99`）。軸 A の分類だけ足す。

| Part | 章 | 軸 A | 根拠（`packages/vscode-extension` の引用件数） |
|---|---|---|---|
| 0 | `orientation/what-is-orbitscore.md`（stub） | both | 0 |
| 0 | `orientation/architecture-overview.md` | **both+split**（拡張 = 層 3-a の図が 19 件。ネイティブ線の図を**足す**） | 19 |
| I | `pipeline/text-to-ast.md` / `evaluation.md` | both | 0 / 0 |
| I | `pipeline/selective-execution.md` | **both+split**（`runSelection` の subject-block = 層 2 へ移る意味論・設計 §12 補正。拡張の配線 14 件は歴史的読解に） | 14 |
| II | `scheduling/*`（4 章） | both（`transport.md` の 3 件は status bar の写し） | 0 / 0 / 0 / 3 |
| III | `rust-engine/*`（4 章） | both（層 1） | 0〜1 |
| IV | `signal-chain/*`（2 章） | both | 1 / 0 |
| V | `plugin-hosting/index.md` / `plugin-ui.md` | both（`plugin-ui.md` の 5 件は `open_plugin_ui` = 層 2 のツール） | 0 / 5 |
| V | `plugin-hosting/catalog.md` | **both+split**（補完の配線 19 件は層 3。カタログの読み書きは層 2・設計 §3.1） | 19 |
| VI | `editor/vscode-architecture.md` | **ext**（歴史的読解として残す。ネイティブ線の章 `editor/native-architecture.md` を**新設**・地図 §4.G） | 65 |
| VI | `editor/execution-feedback.md` | **both+split**（flash / playhead decoration は層 3・`playhead.ts` の pure 部分は WebView へ） | 39 |
| VI | `editor/mcp-and-gated-e2e.md` | **both+split**（MCP ツールの意味論とハーネスは層 2 / 台帳で共通。`--extensionDevelopmentPath` 起動は `vscode` ターゲット固有・設計 §10.2） | 50 |
| VII | `audio/audio-file-playback.md`（SC 経路・削除済み） | 歴史的読解 | 1 |
| VIII | `decisions/adr-00[1-3]` / `glossary.md` | 歴史的読解 / both | 2 / 2 / 14 / 0 |

**dev サイトの同梱は推奨しない**（§6.1）。上の分類は「ネイティブ線の章をどこに足すか」の材料として使う。

### 3.4 併記の書き方（軸 A の段落）

```markdown
::: tip カタログ名が候補に出ないとき
- **拡張版**: コマンドパレットから **OrbitScore: Rescan Plugin Catalog** を実行します
- **OrbitStudio**: Catalog パネルの **Rescan** を押します（`rescan_plugins` と同じ）
:::
```

DSL の説明本文は触らない。併記は **`::: tip` / `::: warning` の中か、手順の節見出し**に閉じる（本文に散らすと同梱時に落とせない）。

---

## 4. Q2 — 版のずれをどう表現するか

### 4.1 選択肢

| 案 | 形 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **V-A** | **サイトは 1 本。本文に可用性を固定文法で書く**（main の見立てを、自由文でなく**固定文法 + frontmatter**にしたもの・§5） | DSL の記述が 1 本（腐らない）/ VitePress の設定を触らない / LLM は本文中で読む / **grep で検算できる**（版の掃除で 4 回取りこぼした形依存 grep への答え） | 凍結版の読者はアプリ専用の記述を**読み飛ばす**必要がある | ✅ **推奨** |
| V-B | 版でサイトを分岐（`/orbitscore/v4/` `/orbitscore/app/`） | 読者は自分の版だけ読む | 🔴 DSL の記述を二重化し片方が腐る（main の (a)）/ VitePress に版切替が無い（`base` 固定・§0）/ 同梱先の LLM は 1 版しか読まないので分岐の恩恵が無い | 棄却 |
| V-C | 別ページの互換性表 | 本文が汚れない | 🔴 LLM が本文だけ読んで表を見ない（main の (c)）/ 表と本文の**二重管理**（既に自由文の版表記が 4 種以上ある・§0） | 棄却 |
| V-D | **凍結スナップショット**: 4.2.0 タグ時点の user サイトを `/orbitscore/ext/` に**静的配信**（編集しない） | 凍結版の読者は**自分の版そのもの**を読む / 編集しないので腐らない（タグの成果物）/ V-A と**併用できる** | `deploy-sites.yml` にタグ checkout のジョブ + `base` の env 化が要る / 凍結版に bug fix が出たら再スナップショット | **追加案**（今は出さない・§10 (17)） |
| V-E | VitePress custom container（`::: availability ext=4.2.0 app=0.1.0`） | 見た目を制御できる | markdown-it-container の設定が要る / LLM には V-A と同じ情報量 / 文法が VitePress 依存 | 棄却（V-A で足りる） |

### 4.2 推奨 = V-A（+ 必要になれば V-D を足す）。理由

1. **DSL の記述を 1 本に保つ**のが R-2 / R-3 の両立の唯一の形。V-B は R-3（拡張版の記述を残す）を満たすが R-2（アプリで先行する DSL）を書くたびに 2 本直す。
2. **同梱先は LLM**（R-1）。LLM は「この機能はどの版から」を**その段落の中で**読む必要がある。別ページ（V-C）は読まれる保証が無い — main の見立て (c) に同意。
3. main の見立てに**反対する 1 点**: 「本文に書く」を**自由文**にすると、既に 4 種以上ある表記（§0）が 5 種目になり、**リリース bump PR での置換が grep で出来ない**（4.2.0 の版掃除の実測: 形を狙った grep は 4 回連続で取りこぼした・`WORK_LOG.md` 2026-09-14）。**固定文法**（§5）にして、番号固定の grep 1 本で全件を拾えるようにする。
4. V-D は**後から足せて、足しても V-A の本文は変わらない**（戻れる側）。凍結版に bug fix リリースが実際に出て「4.2.1 の読者が何を読むべきか」が問題になった時に足す。

### 4.3 V-D を足す時の形（設計だけ置く・実装しない）

- `deploy-sites.yml` に job `snapshot-ext`: `actions/checkout@v4` with `ref: v4.2.0`（凍結タグ）→ `SITE_BASE=/orbitscore/ext/ npm run docs:build -w @orbitscore/user-site` → `dist-pages/ext/` へ
- `sites/user/.vitepress/config.ts:11` の `base` を `process.env.SITE_BASE ?? '/orbitscore/'` に（**タグ側の config を触れないので、env 対応はタグより前に main に入れておく必要がある** — 今入れなければ 4.2.0 タグでは使えず、次の凍結版タグ 4.2.1 からになる。これが「今決めなくてよい」の唯一の但し書き）
- 一方通行ではない: 出すのをやめれば job を消すだけ

---

## 5. 可用性表記の仕様（軸 B・固定文法）

### 5.1 目的

- 人間と LLM が**本文中で**「拡張版 / OrbitStudio のどの版から」を読める
- **番号固定の grep 1 本**で全件を列挙できる（版の掃除・未リリースの検査・同梱時の選別）
- VitePress の設定に依存しない（Markdown の blockquote 1 行）

### 5.2 文法（1 行・固定）

```
> **対応**: 拡張版 4.2.0 以降 / OrbitStudio 0.1.0 以降
> **対応**: OrbitStudio 0.2.0 以降（拡張版には入りません）
> **対応**: 拡張版 4.2.0 以降（OrbitStudio では 0.1.0 から動作が変わります — 下記）
> **対応**: 未リリース（OrbitStudio）— main にマージ済み・次のリリースから
> **対応**: 未リリース（拡張版 4.2.1）— 凍結版の bug fix
```

- 行頭 `> **対応**:` を**唯一のアンカー**にする（形を仮定した grep をしない・memory `version-sweep-fix-the-number-not-the-shape`）
- 配布線は `拡張版` / `OrbitStudio` の 2 語だけ。版は semver の 3 桁
- **`未リリース（<線>）` は暫定値**。リリース bump PR がその線の版番号に置換する（§7.3）。en は `> **Availability**:` で同じ規則（`sites/user/en`）
- 置く場所: **機能の見出しの直下**（章頭ではない。1 章に複数の機能があるため）。章全体が 1 つの機能なら章頭

### 5.3 frontmatter（章単位）

```yaml
---
title: LinkAudio（Ableton Live への音声出力）
description: …
host: both            # both | app | ext | both+split（§3.1）
---
```

`host` は**必須**にする（無ければ lint が red）。`since:` は章単位では持たない（機能単位の行で足りる。章に持たせると行と二重になる）。

### 5.4 lint — `sites/user/scripts/check-availability.mjs`（新設・`npm run docs:check` に連結）

| 検査 | red の条件 |
|---|---|
| frontmatter `host` | 無い / 4 値以外 |
| `> **対応**:` の文法 | 上の 5 形以外（配布線の綴り・版の桁） |
| `未リリース` の残存 | **タグ時（`release-app.yml` の preflight・`verify-app.sh`）に 1 件でも在れば red**。通常の `docs:check` では警告のみ（main には未リリースが**在ってよい**・§7） |
| ja / en の対応 | ja の `> **対応**:` の件数 ≠ en の `> **Availability**:` の件数（翻訳の取りこぼし。`TRANSLATION_STATUS.md` の `outdated` 運用の機械化） |

🔴 「ラチェット」にはしない: 行の**件数**は増減してよい（機能が増えれば増える）。検査するのは**形**と**タグ時の未リリース 0 件**だけ。CLAUDE.md「規律を足す時は仕組みを足す」に従い、文法を STYLE_GUIDE に書くと同時にこの lint を置く。

### 5.5 既存の自由文の版表記をどうするか

`#883 / DSL 2.0`・`v3.0 以降`・`2.0.0 時点の仕様`・`配布されている OrbitScore（.vsix）では…` は、**本文としては残してよい**（説明の一部）。ただし各機能に §5.2 の行を**足す**ので、可用性の**正本は行の方**になる。一括置換はしない（memory `handoff-claims-need-primary-source-recheck`「一括置換はしない」）。

---

## 6. Q3 — アプリ同梱の具体

### 6.1 何を同梱するか（推奨 A・§10 (15)）

| 対象 | 同梱 | 理由 |
|---|---|---|
| **user サイト（ja + en）の Markdown**（`host` が `both` / `app` / `both+split` の章。`ext` の章と `both+split` の `ext` 節は落とす） | ✅ | R-1 の本体。LLM が読むのは「何を書けばどう鳴るか」 |
| **user サイトのビルド済み HTML**（VitePress dist・同じ commit） | ✅ | 人間向けの Docs パネル（設計 §7.4）。層 2 の HTTP リスナーが今日の `mcp-server.ts:180-200` と同じ形で配信する。`file://` で SPA を開けない問題を層 2 の配信で避ける |
| **DSL 仕様** `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`（2,334 行） | ✅ | 正本。user サイトが省いた規則（例外・優先順位）を LLM が引ける。`manifest.json` で `normative: true` と印を付ける |
| `docs/user/ja/USER_MANUAL.md`（843 行） | ❌（既定） | user サイトの primary source だが、同梱すると**同じ内容が 3 系統**になり LLM が矛盾を拾う。owner が「仕様寄りの 1 本」を望むなら DSL 仕様の代わりにこれ、という選択肢として §10 (15) に載せる |
| **dev サイト** | ❌（既定） | 1.19 MB・読者は開発者・引用は `path:line` でソースが無いと検証できない。`get_dev_doc` の互換のため **`--docs-dir` を複数指定可**にしておき（計画 N-3）、開発者が手元のモノレポを指せる形にする |
| `examples/*.orbs` | ✅（小さい） | user サイトが「primary source」として参照する（`sites/user/STYLE_GUIDE.md:68`）。LLM に完動例を与える |

### 6.2 形式とレイアウト

```
OrbitStudio.app/Contents/Resources/docs/
  manifest.json          # 索引（§6.4）。commit・builtAt・appVersion・章の一覧（path / title / description / host / lang）
  user/                  # Markdown（LLM 向け・`docs.get` / `docs.search` の対象）
    ja/…  en/…
  user-site/             # VitePress dist（人間向け・層 2 が /orbitscore/ で配信）
  spec/INSTRUCTION_ORBITSCORE_DSL.md
  examples/*.orbs
```

- **Markdown と HTML を二重に持つ**理由: 形式の変換（HTML → Markdown）を実行時にしない。両方を**同じ commit から同じ段で**生成するので乖離しない（F-11 の観測は manifest の `commit` 1 つで足りる）
- LLM 向けの**別索引は manifest で足りる**: 今日の `search_dev_docs` は行の部分一致で `.md` を走査する（`mcp-docs.ts:103-136`）だけで、章の `title` / `description`（user サイトは全章が持つ）を返せない。manifest に `description` を載せれば LLM は**目次から章を選べる**。全文検索の高度化（埋め込み等）は**やらない**（153 KB は LLM が丸ごと読める量）

### 6.3 いつ生成するか — `make-bundle.sh` の段 2（設計 §9.2）

1. `npm run docs:build -w @orbitscore/user-site`（既存・`sites/user/package.json`）
2. **`scripts/build-docs-bundle.mjs`**（新設）: `sites/user/**.md` を frontmatter `host` で選別 → `both+split` の `ext` 節（節見出しに `<!-- host: ext -->` を置く規約）を落とす → `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` と `examples/` をコピー → `manifest.json` を書く（`git rev-parse HEAD`・`apps/OrbitStudio/VERSION`・日付）
3. `make-bundle.sh` が `Contents/Resources/docs/` へ置く → **署名の前**（656 裁定 7「署名の後にバンドルを触らない」）

`deploy-sites.yml` とは**別経路**（Pages は `main` の push、同梱は R-app のタグ）。同じ `docs:build` を呼ぶので**ビルドの実装は 1 本**（656 §5.4「CI に別実装を書かない」と同じ原則）。

### 6.4 検査（D-9）

| 検査 | どこで | red の条件 |
|---|---|---|
| `manifest.json` と `user-site/index.html` の実在 | `verify-app.sh`（設計 §9.0） | 無い |
| `未リリース` 0 件 | `verify-app.sh`（`check-availability.mjs --release`） | 1 件でも在る（→ リリース bump PR で置換し忘れ） |
| `manifest.commit` == ビルド時の `HEAD` | `verify-app.sh` | 不一致（→ 古い dist を拾った。`isDocsDistStale` #480 と同じクラス・`mcp-docs.ts:167-190`） |
| cold install で `docs.get`（`get_dev_doc`）が 1 章を返す | cold-install E2E（設計 D-7 の `.app` 版） | `null` |
| Docs パネルがネットワーク無しで開く | 同上（`ORBIT_GATED_TARGET=native`） | 開かない |

### 6.5 リリース後に文書が更新された場合

| 案 | 内容 | 判定 |
|---|---|---|
| **U-A** 1 リリース遅れを許容 | 同梱物はそのリリースの commit で止まる。`manifest.commit` と `builtAt` を Docs パネルの隅と `docs.get` の応答に出す（**古さを隠さない**） | ✅ **推奨（v1）** |
| U-B 上書きディレクトリ | `--docs-dir` を複数指定可にし（計画 N-3）、`~/Library/Application Support/OrbitStudio/docs/` が在れば**先勝ち**。配る手段（zip の署名・入手経路）は別途 | 設計には置く（1 行の解決順）。**表面（環境設定・ダウンロード）は v1 で作らない**・§10 (19) |
| U-C online 取得 | 起動時に Pages から差分を取る | 棄却: R-1「ローカルの LLM」= オフライン前提と噛み合わない。ネットワーク依存と「同梱 vs 最新」の曖昧さを持ち込む |

**「1 リリース遅れ」の実態を正確に言うと**: 追従ルーチンが PR マージ直後に文書を書く（§7）ので、**リリース時点の同梱物はそのリリースの機能を全部書いている**。遅れるのは「リリース後の typo 修正・説明の改善」だけで、**機能の記述が遅れるのではない**。この区別が U-A を許容できる根拠。

---

## 7. Q4 — 追従ルーチンのトリガー設計

### 7.1 現状（確認できた範囲）

- トリガー = **PR マージ**。1 PR ずつ `claude/docs-sync-pr<N>` で draft PR（`docs/archive/WORK_LOG_2026-09.md:1125,1481,1503,1531,1551,1591`）
- 溜まると衝突するので main が**まとめて取り込む**運用（#867 = 9 本・#931 / #933 = 7 本 + 5 本・memory `routine-prs-must-be-folded-in-immediately`）
- サイトは `main` から即 deploy（§0）→ **ルーチンが書いた瞬間、未リリースの機能が公開サイトに載る**（今日既にそう）
- ルーチンの手順本文は**リポジトリ外**（cloud routine）。main が 2026-09-18 に追記した凍結線の行（「OrbitStudio（凍結版・現 4.2.0）」「新ライン（追従対象外）」「`sites/user/` と `docs/user/` は出荷済みの拡張版についてだけ書く」「やってはいけないこと 2 行」）も本文は**確認できず**（ブリーフの記述のみ）

### 7.2 選択肢

| 案 | トリガー | 同梱物への効き方 | 取りこぼし | 判定 |
|---|---|---|---|---|
| **T-A** PR マージ（現状）+ **`未リリース（<線>）` マーカー必須** + リリース bump PR で置換 | 1 PR = 1 追従 | リリース時点の同梱物は**そのリリースの機能を全部含む**（マーカーが版番号に置換済み） | PR 単位で差分が小さい → 少ない | ✅ **推奨** |
| T-B リリース公開（owner 案） | 1 リリース = 1 追従 | 🔴 追従 PR はリリース**後**にマージされる → その文書は**次のリリース**の同梱物にしか乗らない = **構造的に 1 版古い**（main の (a) に同意） | 🔴 1 回で複数 PR 分（4.1.0 → 4.2.0 の間で 12 merge・`git log --merges`）の差分を読む → 落ちる（main の (b) に同意）。cloud の実行回数は減るが 1 回が重い（(c) は**確認できず** — 実行制限の仕様はリポジトリ外） | 棄却 |
| T-C PR マージ + **新ラインは追従対象外**（main の 09-18 暫定行） | 拡張版の PR だけ | 拡張版は凍結なので追従対象がほぼ**無くなる**。engine 線の束（O-multiout・ラック・render・.orbslog）が main に入っても文書化されず、**アプリの初回リリース時にまとめて書く**ことになる | 🔴 T-B と同じ取りこぼしを**別の形で**作る（数十 PR 分を一度に） | 棄却（暫定として置くなら前提条件つき・§7.4） |
| T-D PR マージ + タグ時に**もう 1 回**（置換の検算だけ） | 2 段 | T-A の置換をルーチンに任せる | — | T-A の変形。置換は**リリース bump PR の中で人（main）が grep で**やる方が確実（§0 の版掃除の実績）。ルーチンには任せない |

### 7.3 推奨 = T-A の具体

1. ルーチンの手順に足す 1 行: **「新しく書く機能の見出し直下に `> **対応**: 未リリース（<線>）— main にマージ済み・次のリリースから` を必ず置く。線は PR が触ったパスで決める（`packages/vscode-extension/**` だけなら拡張版、それ以外は OrbitStudio）」**
2. リリース bump PR（例: `chore(release): bump OrbitStudio to 0.2.0`）の手順に足す 1 行: **`grep -rn "未リリース（OrbitStudio）" sites docs` を全件置換し、0 件を検算する**（番号固定・形非依存）。`verify-app.sh` が最後の砦（§6.4）
3. **公開サイトに未リリースが載る**のは今日と同じ（`main` deploy）。マーカーが付く分だけ**改善**する（読者は「まだ無い」と分かる）。V-D（凍結スナップショット）を足せば凍結版の読者には見えなくなる
4. en の追従: ルーチンは ja / en を同時に書く（`sites/dev/STYLE_GUIDE.md:300-305` の規則を user にも適用済み・`TRANSLATION_STATUS.md`）。マーカーは `> **Availability**:` で同時に置く。lint が ja / en の件数差を検出（§5.4）

### 7.4 main が 2026-09-18 に追記した暫定行の評価

| 追記（ブリーフ §5.3 の記述） | 評価 | 提案 |
|---|---|---|
| 分類表に「OrbitStudio（凍結版・現 4.2.0）」 | 🔴 **用語が owner 確定（OrbitStudio = ネイティブ版）と逆**。ルーチンがこの語で拡張版を指すと、サイト上の「OrbitStudio」が両方を意味する | 「**拡張版**（凍結・4.2.0）」に改める |
| 分類表に「新ライン（追従対象外）」 | 🔴 T-C の問題（§7.2）。engine 線の束が文書化されない期間が続く | 「**OrbitStudio（新ライン）— 追従する。可用性は `未リリース（OrbitStudio）` で書く**」に改める |
| 「`sites/user/` と `docs/user/` は出荷済みの拡張版についてだけ書く」 | 暫定としては理解できる（アプリの表面が無い今、アプリの**操作**は書けない）。ただし **DSL / エンジンの機能**は今から書ける（§2 軸 B）。**前提条件が無い暫定は消えない**（memory `interim-markers-need-their-precondition`） | 「**アプリの操作手順（軸 A の `app` 節）は A-parity まで書かない。DSL / エンジンの機能（軸 B）はマーカー付きで書く**」と条件を明記 |
| 「やってはいけないこと」2 行（本文未確認） | 確認できず | 本文を `docs/development/` に写して**リポジトリ内に正本を持つ**ことを提案（ルーチンの手順がリポジトリ外にあると、この設計との整合を検算できない） |

---

## 8. 失敗モードと観測手段（検証手段は CLAUDE.md「テストの積み上げ規律」で決め直す・本表は対象の一覧）

| # | 失敗 | 兆候 | 観測手段 |
|---|---|---|---|
| G-1 | 同梱物に未リリースの機能が載る | LLM が存在しない構文を勧める | `verify-app.sh` の `未リリース` 0 件（§6.4） |
| G-2 | 同梱物が古い commit から作られた | manifest の commit と HEAD の不一致 | `verify-app.sh`（`isDocsDistStale` #480 と同じクラス） |
| G-3 | `ext` の章・節がアプリに同梱される | Docs パネルに `.vsix` の入れ方が出る | `build-docs-bundle.mjs` のユニット（`host: ext` を落とす・`<!-- host: ext -->` 節を落とす） |
| G-4 | 可用性の行の文法がばらける | grep で拾えない | `check-availability.mjs`（§5.4） |
| G-5 | ja だけ更新され en が古い | 英語の LLM が古い可用性を読む | ja / en の件数差 lint + `TRANSLATION_STATUS.md` の `outdated` |
| G-6 | ルーチンが「OrbitStudio」を拡張版の意味で使う | サイト上で語が両義になる | §7.4 の用語修正 + `check-availability.mjs` が `OrbitStudio（凍結版` の並びを red に |
| G-7 | Docs パネルが `file://` で SPA を開けない | 空白ページ | 層 2 の HTTP 配信（今日の `mcp-server.ts:180-200` と同じ形）。N3 Docs パネルの最初の小 PR で実測 |
| G-8 | DSL 仕様と user サイトが矛盾する | LLM が 2 つの答えを出す | manifest の `normative: true`（仕様を優先する規則を LLM 向けの `README` に 1 行）。矛盾自体は既存の運用（user サイトは USER_MANUAL / 仕様から逸脱しない・`sites/user/STYLE_GUIDE.md:94-102`）で防ぐ |

---

## 9. 確信度と反証方法

| 主張 | 確信度 | 反証方法（何を観測すれば誤りと分かるか） |
|---|---|---|
| 「実装依存 / 非依存」は軸 A（host）と軸 B（可用性）に割れ、DSL の章は軸 B に依存する | 高（§2 の実測表: `link-audio.md:11` / `instrument.md:97-100` / `engine-settings.md:33` / `methods.md:435,460` が非依存に分類された章の中に在る） | 上の行が**アプリ版と拡張版で同じ値になる**なら軸 B は要らない。具体的には LinkAudio の egress がアプリ版でも off のまま **かつ** O-multiout / ラック / render がアプリの初回リリースに入らない場合 |
| user サイトは 1 本のまま固定文法で両版を表せる（V-A） | 高（DSL の記述は両版で同一・層 2 の意味論を共有する設計 §10.3） | 「拡張版でだけ**振る舞いが違う** DSL」が 2 つ以上現れたら（今は #883 系の破壊的変更が 4.0.0 で凍結版にも入っており 0 件）。その時は V-D（スナップショット）を足す |
| 固定文法なら版の掃除が grep 1 本で済む | 高（`WORK_LOG.md` 2026-09-14 の実測: 番号固定の素の grep だけが全件を拾った） | リリース bump PR で `> **対応**:` を置換した後に**別の形の版表記が残って**利用者に見える |
| docs 系ツールは cold install で動かない | 高（`mcp-server.ts:137-138` / `.vscodeignore:20,28`） | 凍結版 `.vsix` を cold install して `get_dev_doc` が `null` 以外を返す |
| Markdown + HTML の二重同梱で乖離しない | 高（同じ commit・同じ段で生成） | manifest の commit と dist の `base + '/assets/'` 指標（`isDocsDistStale`）が食い違う |
| 153 KB の user サイトは LLM が丸ごと読める量なので索引は manifest で足りる | 中（ja 153,918 bytes・en は未計測〔`du` で 164 KB〕。合わせて約 300 KB ≒ 100k トークン弱） | ローカル LLM の context が 32k 以下なら章単位の選択が要る → manifest の `description` が**その選択の材料**なので、索引を別に作る必要は変わらない |
| T-B（リリーストリガー）は同梱物を構造的に 1 版古くする | 高（追従 PR はリリース後にしかマージできない） | ルーチンがリリース**前**（タグ打ちの前）に走り、その PR をタグの前にマージする運用が可能なら誤り。ただしそれは「タグを打つ前に手で待つ」= T-A の置換と同じ人手が要る |
| T-C（新ライン追従対象外）は取りこぼしを別の形で作る | 中（engine 線の束が main に入る頻度に依る。O-multiout が最初の束・裁定 §12.3） | アプリの初回リリースまで engine 線の束が 2 つ以下しか入らないなら、まとめて書いても取りこぼしは小さい |
| ルーチンの実行制限（main の (c)） | **確認できず**（cloud 側の仕様はリポジトリに無い） | — |
| dev サイトを同梱しなくても LLM の用は足りる | 中（読者が開発者・引用がソース前提、という性質からの推論） | アプリ利用者の LLM が「なぜそう鳴るか」（実装）を聞かれる頻度が高ければ誤り → `--docs-dir` の追加で後から足せる（戻れる側） |

---

## 10. 🔴 owner 裁定待ち（設計 §14 (15)〜(20) と同じ番号・ここが詳細）

| # | 問い | 選択肢 | 推奨と理由 |
|---|---|---|---|
| (15) | アプリに同梱する文書の範囲 | **A** user サイト（ja + en）+ DSL 仕様 + `examples/` / B A + dev サイト / C user サイトのみ / D DSL 仕様の代わりに `USER_MANUAL.md` | **A**（§6.1）。dev サイトは `--docs-dir` の追加で後から足せる |
| (16) | 可用性表記の形 | **A** 固定文法 1 行 + frontmatter `host:` + lint / B custom container / C 別ページの互換性表 | **A**（§5）。grep 1 本で検算できる形にする |
| (17) | 凍結スナップショット（`/orbitscore/ext/`）を出すか | **A** 今は出さない / B 出す | **A**（§4.3）。ただし `base` の env 化だけは**タグより前に main に入れる**必要があるので、B に転ぶ可能性が少しでもあるなら env 化だけ先に入れる（1 行・戻れる） |
| (18) | ルーチンのトリガーと 09-18 の暫定行 | **A** PR マージ維持 + `未リリース（<線>）` 必須 + 暫定行を §7.4 のとおり修正 / B リリース公開 / C 暫定行のまま | **A**（§7.2・§7.3）。🔴 暫定行のうち「OrbitStudio（凍結版）」は**用語が owner 確定と逆**なので、裁定を待たず直してよいと考える |
| (19) | リリース後の docs 更新をアプリに届ける経路 | **A** v1 は 1 リリース遅れを許容（manifest で古さを表示）/ B 上書きディレクトリを v1 で有効化 / C online 取得 | **A**（§6.5）。`--docs-dir` の複数指定（計画 N-3）だけ先に入れる |
| (20) | user サイトの主語と host 依存段落の時期 | **A** 段落は今（併記）・主語と `app` 章は A-parity 後 / B 全部 A-parity 後 / C 今すぐ全面 | **A**（§3.2）。段落の併記は DSL を二重化しない。`app` の章（インストール・環境設定・Docs パネル）は表面が確定してから |
| (21) | ルーチンの手順本文をリポジトリ内に写すか | A 写す（`docs/development/DOCS_SYNC_ROUTINE.md`）/ B cloud 側だけ | **A**。本設計との整合を検算できる場所が今は無い（§7.1「確認できず」） |

---

## 11. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-18 | 初版（#848 別冊・Fable 起案・effort high・main `1276ab1f`）。Q1〜Q4 の答え・軸 A / 軸 B の分離・user 21 章 / dev 27 章の分類・固定文法・同梱の形・ルーチンのトリガー・裁定待ち (15)〜(21) |
