# OrbitScore 開発地図 — ネイティブ線（NATIVE DEVELOPMENT MAP）

**制定**: 2026-09-11（起案: Fable subagent〔effort: xhigh〕/ 検収: main / 裁定: owner・#848）/ 改訂: 2026-09-18（Fable〔effort: high〕・`1276ab1f` — 🔴 09-14 の 4.2.0 マージで 09-18 の main ではない）/ **改訂: 2026-10-23（起案: fresh subagent / 審査: main・main `7410dcb0`・拡張 4.4.0）** / **改訂: 2026-10-26（owner 裁定 第 2 回・起案: fresh subagent / 審査: main）**
**位置づけ**: **凍結線を越えた後の開発計画の正本。** 改訂: 凍結線は初版の「O-surface 完了」から #883 で 4.0.0 へ動き、**拡張 4.2.0 で凍結された**（owner 2026-09-18・`packages/vscode-extension/package.json`・PR #943）。改訂（10-23）: 凍結後も owner の個別例外で **4.3.0**（DSL の乱数ピッチ）と **4.4.0**（MCP の `document_path`・VST3 の state 形式・PR #993・`7410dcb0`）が出た。凍結は「表面が止まる」ではない。**この地図の期間は始まっている。** 凍結版は [`DEVELOPMENT_MAP.md`](DEVELOPMENT_MAP.md)（拡張版の地図）が正本のまま。**両者は同時に生きる**が、主語が違う（拡張版 = 凍結と `.vsix` の保守 / 本地図 = **OrbitStudio**〔= ネイティブ版アプリ・owner 用語確定 2026-09-18〕と層 1 / 2 の続き）。文書（user / dev サイト）の保持構造は [`848-docs-structure-design.md`](../design/848-docs-structure-design.md)（別冊）。
**入力**: [`848-native-orbitstudio-design.md`](../design/848-native-orbitstudio-design.md)（設計・完了条件）/ [`IMPLEMENTATION_PLAN_NATIVE.md`](IMPLEMENTATION_PLAN_NATIVE.md)（段・束）/ [`NATIVE_MIGRATION_2026-09.md`](NATIVE_MIGRATION_2026-09.md) §12（裁定）/ 旧地図 §3・§4（engine 線の節を**番号で**参照する）

> **この地図が答える 4 つの問い**
> 1. **現在地** — 何が在って何が無いか（§3・証拠は `path:line` か PR / commit。**推測では書かない**）
> 2. **リリースまでの筋** — 第 1 リリースが閉じるまでの 1 本の順序（§3）
> 3. **本線と枝葉** — 何を先に、何を後に、何をやらないか（§2・§5・§6）
> 4. **新規起票の判断基準** — 地図に無い作業はまず地図を直す（旧地図 §0.2 と同じ運用）
>
> **書かないこと**: 個別 PR の実装詳細（計画と設計の仕事）・日程・工数・可否（owner の領分）。

---

## 0. 使い方と運用規則

- **記号・運用規則は旧地図 §0.1 / §0.2 をそのまま使う**（✅ 実装済み / 📐 設計済み / ○ 未着手 / ❓ 未確認 / 🔴 塞いでいる / 🚪 リリース前に必要）。起票前に本地図の節を探し、無ければ地図を直す PR が先。issue 本文の先頭に `NMAP §4.X` と書く（旧地図の `MAP §4.X` と区別する）
- 🔴 **「実測」は出典（日付 / PR / commit / ファイル:行）を併記する**（旧地図 §0.2 規則 8）
- 🔴 **事実が変わった瞬間に更新する**（旧地図 §0.2 規則 7・`BUNDLE_BRANCH_WORKFLOW.md` §5.1b）
- 🔴 **凍結版に触らない**: 本地図から起きる作業は `packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts` を変更しない（設計 §10.3）。凍結版の bug fix は旧地図の運用で
- `tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に本地図と `IMPLEMENTATION_PLAN_NATIVE.md` を足す（設計 D-8・**main の follow-up**・本 PR は `tests/` を触らない）

### 0.1 旧地図との関係

| 文書 | 扱い |
|---|---|
| `DEVELOPMENT_MAP.md`（拡張版） | **凍結版の正本**。§3 の `release-gate` 連鎖（ラック・配布）は**本地図 §3 が引き継ぐ**。§4 の engine 線の節（4.A ミキサー / 4.B ラック / 4.D パラメータ / 4.E DSL 拡張 / 4.F 診断 / 4.G E2E / 4.H 可視化 / 4.I 堅牢性 / 4.L audio DSL / 4.O 性能 / 4.P 入力）は**中身をここに写さず番号で参照**する |
| `IMPLEMENTATION_PLAN_2026-09.md`（拡張版） | 凍結版の計画。engine 線の PR は**正本のまま**。拡張側に触る行の付け替えは `IMPLEMENTATION_PLAN_NATIVE.md` §4.1 |
| `NATIVE_MIGRATION_2026-09.md` | 移行の判断と根拠。**§12 が裁定**。本地図はその上に立つ |
| `POST_2.0_ORBITSTUDIO_PLAN.md` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md` | VSCodium 版の歴史的計画。**新しい判断の根拠にしない**（フォークは畳んだ・裁定 2.6） |
| `docs/design/656-release-design.md` | 配布の設計。**再設計しない**。裁定 10 件と回答 8 件を引き継ぐ / 失効に仕分けした表は設計 §9.0。VSCodium 前提の部分（§3.4・§4 の段 3〜7・§5.4 (b)・§6.2・§16 (4)(5) の bundle id・(7)）が失効 |
| `docs/development/POST_2.0_ROADMAP_NOTES.md` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md` | **engine-first** と層 1 の確定事項。引き継ぐ（設計 §0b） |
| `docs/research/EDITOR_HOST_AND_APP_SIZE.md` | 「自作しない」の結論は裁定 2.2 で失効。**vscode 依存 4,405 行の内訳**（= 編集面の配線）は §4.B パリティの母集団として引き継ぐ |
| `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md` | Tracktion / VSCodium は失効。「動機の核心が未検証なら併記する」作法を引き継ぐ |
| `docs/planning/post-icmc/ELECTRON_APP_PLAN.md` / `RUST_ENGINE_MIGRATION_PLAN.md` / `AUDIO_ENGINE_CORE_ARCHITECTURE.md` | Electron / Tauri / CodeMirror は棄却。**Engine-as-a-Service（複数フロント・背骨 1 つ）と「橋渡しはプロトコル」**は引き継ぐ。機能列挙は §4.B |
| `docs/research/DAW_AUDIO_ARCHITECTURE.md` | 「graph は engine が所有し UI は描くだけ」を層 3 の境界として引き継ぐ |
| `docs/planning/USER_OUTCOMES_2026-09.md` | ユーザー視点の到達点の粒度。§3.3 に同じ形の表 |
| `docs/planning/post-icmc/COLLABORATION_FEATURE_PLAN.md` | 範囲外。層 2 の中を変えずに後から乗せられることだけ確認（設計 §0b） |
| Serena `orbitstudio_phase0_phase1_2026-07-07` / `orbitstudio_phase2_spike_2026-07-07` | VSCodium 版 Phase 0〜2 は一度成立していた（失効）。bundle id `com.signalcompose.orbitstudio` は §7 の裁定材料 |

---

## 1. 再設計しない確定事項（本地図の前提）

| 事項 | 内容 | 正本 |
|---|---|---|
| 8 項目の裁定 | macOS のみ / Swift・AppKit / Monaco / Rust engine 不変 / 拡張は凍結 / フォークは畳む / モノレポ / claude-code 非同梱 | `NATIVE_MIGRATION` §2 |
| 凍結線と新ラインの順序 | 凍結線 = O-surface → **4.0.0（#883）→ 4.2.0 で凍結**（改訂 10-23: その後 owner の個別例外で 4.3.0 / 4.4.0）/ O-multiout が新ラインの最初の束 / ステージ 3〜7 は生きる / ステージ 8 は再定義 / 凍結の翌日から新ライン（**= 今**） | 同 §12（§12.8 が例外の条件）・`DEVELOPMENT_MAP.md:236-241`・PR #943 / #977 / #993 |
| リリースの前提 | **ラックはリリースの前提**（新ラインに対して生きる）。**凍結版 ≠ リリース** | 同 §12.2 / memory `racks-are-a-release-gate` |
| GUI | GUI の操作結果は必ず DSL テキストに落ちる（#681）。確認・停止を挟まない。窓は勝手に開閉しない | 旧地図 §1 / memory |
| LLM | 第一級ユーザー。DSL 経由。MCP はユーザーと同じ動線 | 旧地図 §1 / memory `orbitstudio-shared-medium-human-llm` |
| 投資の順位 | 1 仕様 → 2 E2E → 3 機能テスト → 4 変異（PR のクリティカルパスに置かない） | CLAUDE.md |
| 拡張版との関係（10-26） | 関門は「**DSL が実行された結果は拡張版と同じ**」と「能力が減らない」。MCP ツールの名前・引数・戻りは v1 だけ関門。評価の区切り方・画面・ログの文言は参照。拡張版は**回帰の検算台**で、書き直さない（凍結のまま退役まで） | 設計 §1.1・§10・§14.0（第 2 回の 1・6） |
| 暫定物（10-26） | 最終形でないまま動くものは台帳に載せ、期限と強制する仕組みを持つ。足場が残るとリリースが落ちる | 設計 §1.4・D-11 |
| 層の責務 | 層 1 = 発音（不変）/ 層 2 = セッション（`packages/session`・Node・host が所有）/ 層 3 = 編集（Swift シェル + WebView） | 設計 §3・§4 |
| プロトコル | JSON-RPC 2.0 over WebSocket・双方向・単一スキーマ・strict version。改訂（10-23）: 形を設計で確定（状態を持たない `session.evaluate`・`transport.step` の `source`・`log.line` の `level` / `kind`）・**`/rpc` と `/mcp` にトークン + Origin**。改訂（10-26・裁定 4）: LLM は**同梱の中継**（stdio・1 回だけ登録）から **UDS** の `/rpc` に入る。TCP の `/mcp` は v1 に無く、TCP の `/rpc`（WebView 専用）は Host + Origin〔欠落も拒否〕+ トークン。`session.evaluate` に省略可能な `target` | 設計 §4.7・§5（S-rpc の締めは設計との一致を確かめる） |

---

## 2. 全体図 — 何が何の前提か

矢印は「左が終わらないと右が着手できない」。**同じ行に並ぶものは順序を持たない。** 節番号は §4。

```
  ┌── 凍結版（旧地図の領分）✅ 凍結（2026-09-14 4.2.0・owner 凍結確定 2026-09-18）────────────────────────┐
  │  O-surface（PR-O4）✅ ── SC 削除（#502）✅ ── README 導線（#937）✅ ── #883 → 4.0.0 ✅ ── 4.2.0 ✅          │
  │  例外（owner の個別判断）: 4.2.1 user サイト同梱 ✅ ── 4.3.0 乱数ピッチ ✅ ── 4.4.0 document_path ほか ✅ │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
        ↓ 凍結の翌日から（ブランチも実機も共有しない）— ここが現在地

  [A] 層 2 セッション   N1 S-rpc 🔴 ─→ S-mcp 🔴 ─→ S-editor ─→ S-eval 🔴（段階 2・#997 の評価のかたち・10-26）
                          │              └─→ headless で engine 線の E2E が回る（§4.F の束が使う）   ↑ #997 の設計（docs）
  [B] アプリ            N0 spike 🔴 ─────────────→ N2 A-skeleton 🔴 ─→ N3 A-document ─→ A-panels ─→ A-parity 🚪
                          （IME が崩れたら Electron 検討へ・設計 §1.3）        ↑ [A] S-editor が先
  [C] プロトコル        N0-b ─→ S-rpc（v1 確定）─→ 以降は MINOR 追加のみ
  [D] 配布             N0-c ─→ R-app 🚪（bundle id / tag / node 同梱 = owner 裁定・§7）
  [E] E2E・パリティ     S-mcp（headless ターゲット + 台帳）─→ A-skeleton（native ターゲット）─→ A-parity（D-1〜D-5・D-10・D-12）
  [F] engine 線         O-multiout ─→ L ─→ R ─→ V ─→ Q/K 🚪 ─→ P   （旧地図 §4.A / 4.B / 4.D / 4.E / 4.F / 4.H / 4.O）
                        T-1（N0-d・10-26）の判定が「ゲート」なら Q（#428）も 🚪。#996（daemon の Origin・親の死）は A-parity の前
  [G] docs             文法 + frontmatter（別冊 §5）─→ 章の分類と併記（別冊 §3）─→ ルーチン手順（別冊 §7）─→ 同梱（R-app N4-e・D-9）
                          （主語の書き換えは A-parity 後・設計 §14 (20)。「アプリ主語へ全面改訂」は改訂で撤回）

  🚪 第 1 リリース = [B] A-parity ∧ [D] R-app ∧ [F] K（ラック #635 → #636・#669）
                    ∧ 暫定物の台帳の `release-1` が全部閉じる（設計 D-11・[A] S-eval を含む）∧（T-1 がゲートなら）Q
```

**🔴 foundation の一覧（塞いでいる相手つき）**

| 項目 | 塞いでいるもの |
|---|---|
| N0-a Monaco + IME | [B] 全部 |
| S-rpc（プロトコル v1） | [A] の残り・[B] N2・[E] headless |
| S-mcp（MCP を層 2 へ・台帳） | [E] 全部・[F] の headless 検証 |
| A-skeleton | [B] N3 |
| owner 裁定 (3)(4)(10)（node / tag / bundle id） | [D] R-app。✅ 10-26 に 3 件とも裁定済み（(3) は第 2 回） |
| K（ラック） | 🚪 |
| #997 の設計（10-26） | [A] S-eval |
| S-eval（10-26） | [B] A-parity・🚪（D-11） |
| N0-d T-1（10-26） | [F] Q の位置（ゲートにするか） |

---

## 3. 🚪 現在地からリリースまでの筋

### 3.1 現在地（2026-10-23・main `7410dcb0`・拡張 4.4.0・改訂で再測）

🔴 旧版（09-18 改訂）が「main `1276ab1f`（09-18）」と書いた値は、**09-14 の 4.2.0 マージ**の値である（設計 §2）。下の表は 10-23 の値で置き換えた。

| 領域 | 現在地 | 証拠 |
|---|---|---|
| ネイティブ線の成果物 | **何も無い**。`apps/` `protocol/` `packages/session/` は存在しない（`packages/` は `engine` と `vscode-extension` の 2 つ） | `git ls-tree --name-only 7410dcb0 packages/`（2026-10-23） |
| 設計・計画・地図 | 📐 3 本（初版 09-11・改訂 09-18・改訂 10-23・改訂 10-26）+ 別冊（文書構造）。10-23 改訂でプロトコルの形とセキュリティ（トークン + Origin）を確定。10-26 に owner 裁定 2 回（第 1 回 27 件・第 2 回 7 件）を反映し、**owner 裁定待ちで止まる束は無くなった**。新しい issue: **#996**（daemon の Origin と親の死・engine 線・OPEN）/ **#997**（評価のかたちの設計・OPEN） | `docs/design/848-…` / `docs/planning/IMPLEMENTATION_PLAN_NATIVE.md` / 本書 / `docs/design/848-docs-structure-design.md` |
| gated ハーネスの起動先 | ✅ stock VS Code（フォーク非依存） | PR #831 / `orbitstudio-mcp-gated.spec.ts:830,836` |
| フォークのビルドスクリプト | ✅ 削除済み | 同上 |
| 凍結 | ✅ **拡張 4.2.0 で凍結**（O-surface ✅ / #502 SC 削除 ✅ / README 導線 #937 ✅ / #883 = 4.0.0 ✅ / 4.1.0 pan ✅ / 4.2.0 #939・#940 ✅）。改訂（10-23）: **owner の個別例外で 4.2.1（user サイト同梱・#954）/ 4.3.0（乱数ピッチ・#967）/ 4.4.0（`document_path`・`//#documentDirectory` の空値 = クリア・VST3 の `.vstpreset`・#984〜#986 / #989）**が出た。#987（`[STEP]` の出どころ）が次の例外として提案中（OPEN） | `packages/vscode-extension/package.json` `version` = 4.4.0 / `git tag --list 'v4*'` / PR #943・#962・#977・#993 |
| 拡張の規模 | **43 ファイル 10,810 行**（09-14 の 41 ファイル 10,471 行から +2 本: `correlated-line-bridge.ts`・`evaluate-document-directory.ts`）。500 行超は `engine-process` 703 / `agent-handlers` 551 / `engine-handlers` 546 の 3 本 | `git ls-tree` + `wc -l`（設計 §2） |
| 層 2 の抽出可能性 | `vscode` 非依存は **28 ファイル 6,358 行**、依存は **15 ファイル 4,452 行**。🔴 非依存 = 移す、ではない: **移す 17 本 4,553 行 + 新規 95 行 / 消える 9 本 1,437 行（ブリッジ・child-engine の stdout 経路）/ WebView へ 1 本 273 行**。依存側からも約 800 行の意味論（補完・subject-block・カーソル下プラグイン解決・`*ForAgent`）が層 2 へ落ちる | 設計 §3.1 |
| MCP 層 | **8 ファイル 1,885 行が pure**。ツール **28**（4.2.1 で `get_user_doc` / `search_user_docs`）。`tools/list` の順序は `mcp-server.spec.ts:396-480` が固定（無条件 23 + 条件付き 5）。実装は **`OrbitScoreToolHandlers`** 1 インタフェース。🔴 HTTP は Host 許可リストだけで **Origin を見ていない**（MCP 仕様 2025-11-25 の MUST を満たさない） | `mcp-types.ts:184-235` / `mcp-server.ts:156-199` / 設計 §4.7 |
| プロトコルの現行 | `//#` メタ行 **8 種**（`//#documentDirectory` は 4.4.0 から 3 値: 設定 / 空 = クリア / 省略 = 前回値を保持）+ stdout **4 系統**（人間向けのログ行を含む）。相関ブリッジは **共通骨格 + 5 本 = 6 ファイル 576 行**（✅ #757 は凍結版で CLOSED・PR #985・2026-10-23）。daemon protocol **v0.3**（変わらず） | `repl-mode.ts:66-80` / `engine-handlers.ts:43-155` / `gh issue view 757` / `protocol.rs:8` |
| engine の spawn | **VS Code 同梱の Node**（`process.execPath` + `ELECTRON_RUN_AS_NODE`・#878）。PATH の node に依存しない。daemon は stdin `'ignore'` で起動され、親の死を知る経路が無い（設計 §4.4 の engine 線への申し送り） | `engine-process.ts:407-416` / `daemon-client.ts:853-856` |
| gated E2E | **v4.4.0 で 56 `it` / 7,855 行**（4.2.0 の 49 から +7）。**実機の passed 数は未測**（09-14 の 48 passed の出典 `WORK_LOG.md:452` は #947 の archive 移動で別の内容を指す）。cold-install E2E あり（`vsix-cold-install-gated.spec.ts`・#873・`assertDocsBundled` は #954） | `grep -cE "^ +(it\|test)…" tests/e2e/orbitstudio-mcp-gated.spec.ts` |
| 文書の同梱 | ✅ **user サイトは `.vsix` に同梱**（4.2.1・#954 / PR #955・2026-09-18: Markdown 45 本 + ビルド済み dist を `packages/vscode-extension/sites/user/` へ）。**dev サイトは owner 決定で意図的に同梱しない**（cold install では `DEV_DOCS_UNAVAILABLE_MESSAGE` で公開 URL を案内）。旧版の「凍結版は docs を同梱していない」は旧版の日付当日に偽になっていた | `scripts/copy-user-site.sh` / `mcp-server.ts:151-154` / `mcp-docs.ts:46-48` / `vsix-cold-install-gated.spec.ts:155-175` |
| 文書サイトの現状 | user 21 章（ja・153 KB）/ dev 27 章（ja・1.19 MB）・両方 ja/en。`deploy-sites.yml` が **main の push で** GitHub Pages へ（= サイトは常に main = 未リリース含む）。VitePress の版分岐は無し（`base` 固定）（09-18 の測定・10-23 は再測していない） | `sites/*/.vitepress/config.ts` / `.github/workflows/deploy-sites.yml:15-22` |
| 署名の材料 | Developer ID `ZWULF5LA37`・ASC API キーは手元にある。entitlements は未確認 | `656-release-design.md` §5.2-5.3 |
| 未検証（裁定 §9） | Monaco × WKWebView × **IME**（10-23: WKWebView は textarea 経路を通るので拡張版の実績は予測にならない・D-6 を再現手順に）/ **WebView の配信元ごとの Origin の値と ATS の要否**（10-23 追加）/ スキーマ生成ツール / 同梱 node の hardened runtime（#878 で Electron 同梱 Node が N-API を読めた傍証あり・素の node は未実測）/ 層 2 の多クライアント同時性（**実測は S-mcp**）/ Swift の CI | `NATIVE_MIGRATION` §9 / 設計 §7.3・§13 |
| D-8 の follow-up | ○ **未実施**: `planning-issue-state.spec.ts` の `DOCUMENTS` は今も旧地図と旧計画の 2 本だけで、本地図と `IMPLEMENTATION_PLAN_NATIVE.md` は走査されない（閉じた issue を未着手と書いても機械は捕まえない） | `tests/docs/planning-issue-state.spec.ts:41-44` |

### 3.2 筋（順序だけ・日程は書かない）

```
 ① N0 spike（IME・スキーマ・署名・T-1）──→ ② S-rpc ──→ ③ S-mcp（中継を含む）──→ ④ S-editor ──→ ⑤ A-skeleton
 ──→ ⑥ A-document ──→ ⑦ A-panels ──→ ⑧ A-parity（D-1〜D-5・D-10・D-12）──→ ⑨ R-app（D-7・D-11）
 ∥ ④ の後: ④' S-eval（#997 の設計の後・⑧ の前）
 ∥ engine 線: O-multiout → L → R → V → Q/K（🚪 ラック）→ P   （headless で検証・③ の後）
 ──→ 🚪 第 1 リリース（⑨ ∧ K）
```

- ① は今すぐ着手できる（裁定待ち 0・計画 §6）
- 改訂（10-26）: クラウド（Linux）に続けて渡せる順は計画 §7。② 〜 ④・④' の実装と unit はクラウドで、実機の検算は手元で
- ② 〜 ④ は拡張を触らないので凍結版と衝突しない
- ⑤ で **Electron へ戻るかの判断**が出る（設計 §1.3）。戻る場合も ② 〜 ④ は無駄にならない（transport は WebSocket のまま）
- engine 線は ③ の後、**アプリを待たずに** headless で E2E が回る。V6 / V7 / V10（可視化の表面）だけは ⑦ の後（計画 §4.1）

### 3.3 各段が終わるとユーザーは何ができるか（`USER_OUTCOMES_2026-09.md` と同じ粒度）

**凡例**: 🎵 音・操作が変わる / 👀 見える / 🧱 土台・変化なし / 📄 仕様・文書。「何も変わらない」は正直にそう書く。

| 段 | 見え方 | 終わるとできること |
|---|---|---|
| N0 spike | 📄 | 何も変わらない。Monaco が WKWebView で日本語込みで動くか・スキーマ生成・同梱 node の署名の答えが文書に載る |
| N1 S-rpc | 🧱 | 何も変わらない（利用者からは）。`orbitscore session` が単体で立ち、evaluate に応える |
| N1 S-mcp | 👀 | **エディタを開かずに** `orbitscore session` と、1 回だけ登録した**中継**で、今日と同じ MCP ツールを LLM が使える（改訂 10-26）。アプリや session を立ち上げ直しても登録し直さない。既存譜面は同じ音 |
| N1 S-editor | 🧱 | 何も変わらない。エディタが繋がった時の診断・補完・⌘Enter の中身が層 2 に揃う |
| N1 S-eval（10-26） | 🎵 | **評価の区切り方が #997 の評価のかたちになる**（区切りの単位・途中のエラー・`@import` をまたぐ評価）。正しい DSL の音は変わらない。凍結版の「バグ的な振る舞い」（#965 / #620 / #695 ほか）が直る |
| N2 A-skeleton | 🎵 | **`OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動く**。日本語が打てる。保存・タブ・設定はまだ無い |
| N3 A-document | 👀 | フォルダをプロジェクトとして開ける・開く・保存・自動保存・タブ・最近使った書類・環境設定が使える |
| N3 A-panels | 👀 | デバイス選択・engine の起動停止・ログ・プラグインカタログ・**同梱 docs（オフライン）**がアプリの中で見える。右クリックでその 1 つのプラグイン UI が開く。flash と playhead の色が設定できる |
| N3 A-parity | 🎵 | **拡張でできたことが全部アプリでできる**（台帳が緑）。LLM がアプリと同じセッションに入って同じ譜面を評価できる |
| N4 R-app | 👀 | 署名・公証済み `.dmg` を GitHub Releases から落として、node が無い Mac でも開いて音が出る |
| engine 線（O-multiout → L → R → V → Q/K → P） | 🎵 / 👀 | 旧 `USER_OUTCOMES_2026-09.md` のステージ 2 後半〜7 の表がそのまま（アプリでも headless でも同じ DSL） |

### 3.4 `release-gate` と `must-fix`（ラベルの写像）

| ラベル | 本地図で付く先 |
|---|---|
| `release-gate` | R-app の一方通行 3 件（N-7〜N-9）/ K（#635 / #636 / #669）/ A-parity。改訂（10-26）: **#996**（推奨・main が付ける・設計 §14.0 Q-r2-3）/ **#428**（T-1 の判定が「ゲート」の時だけ・設計 §4.6）/ 暫定物の台帳の `release-1` の行（ラベルではなく `verify-app.sh` が強制・設計 D-11） |
| `must-fix` | 凍結版の演奏が壊れるもの（旧地図の運用）。**ネイティブ線では A-parity までは付けない**（利用者がまだ到達できない）。改訂（10-26）: この行は A-parity の束 PR で外す（計画 §2.1 の A-parity） |
| `foundation` | §2 の表 |

---

## 4. 領域ごとの地図

各節: **正本** / **現在地** / **前提** / **未決**。

### 4.A 層 2 セッション（`packages/session`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| プロトコル v1 + WebSocket サーバ + `session.evaluate` + イベント + CLI（改訂 10-23: 評価の単位の写し + 差分テスト・トークン + Origin・F-1 の機構・F-12 の層 2 側。改訂 10-26: 写しは**段階 1 の足場**・暫定物の台帳の仕組み・UDS + TCP の 2 リスナー・`target`・`protocol/LICENSE`） | 設計 §4・§5 / 計画 S-rpc | ○ | N0-b |
| MCP を層 2 へ（改訂 10-23: ツール **28**・4.2.1 で `get_user_doc` / `search_user_docs`。全ターゲットで凍結版と同じ順序に 28 本を登録・`/mcp` にトークン + Origin。改訂 10-26: MCP を話すのは**中継**〔stdio・UDS の RPC クライアント・RL-1〜RL-8〕で、TCP の `/mcp` は無い。ツールは v1 だけ凍結版と同じ〔`mcp-tools-v1.spec.ts`〕） | 設計 §6・§4.7 / 計画 S-mcp | ○（MCP 層 **8 ファイル 1,885 行が pure**・`OrbitScoreToolHandlers` を層 2 で実装する形・実測 2026-10-23） | S-rpc |
| document 同期・診断・補完・subject-block・カーソル下プラグイン解決（層 2 の言語サービス） | 設計 §5.4-5.5 / 計画 S-editor | ○（`diagnostics-analysis.ts` / `plugin-name-diagnostics.ts` は pure。`completion-context.ts` 290 行・`run-selection.ts` の `getLineSubject`・`plugin-ui-at-cursor.ts` の解決部が vscode 依存を剥がす対象） | S-mcp |
| 同時性（FIFO・後勝ち・出自の記録・エディタは 1 つ） | 設計 §5.6 | 📐 | S-rpc で実装・S-mcp で実測 |
| MIDI スケジューラ / transport の Rust 化 | 裁定 §3 / 設計 §4.6 | ○・**§9「聞こえているか」の実測が先**。受け皿は doc 428（PR-Q）。改訂（10-26）: 実測は **N0-d（T-1）**・判断の規則も設計 §4.6 に置いた。評価の実装言語は #997 で開いたまま | N0-d |
| 評価のかたち（段階 2・10-26） | #997 / 設計 §4.5.1 / 計画 S-eval | ○（#997 OPEN・設計はこれから） | S-editor・#997 の設計 |
| 暫定物の台帳（10-26） | 設計 §1.4 | ○（仕組みは S-rpc の N1-a0 で入れる） | — |
| #757（bridge の重複） | 旧地図 §4.J.1 | ✅ **凍結版で共通骨格に畳んで CLOSED**（PR #985・2026-10-23）。新ラインでは wire の request id で骨格ごと不要（設計 §15） | — |

**未決**: 改訂（10-26）: なし — (1) detach = A 含めない / (2) rename = A しない / (8) 複数エディタ = A 1 つまで（1 クライアントが複数の document）/ (9) `protocol/` ライセンス = 定義だけ Apache-2.0（設計 §14.0）。

### 4.B アプリ（`apps/OrbitStudio`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| N0-a Monaco + IME（改訂 10-23: D-6 の再現手順・Monaco の版の固定）+ WebView の配信元ごとの Origin の実測 + ATS の要否 | 設計 §1.2 D-6・§1.3・§7.3 / 計画 N0 | ○・🔴 **最大の未知数** | — |
| N2 walking skeleton（1 窓・Monaco・音・playhead・IME） | 設計 §1.3 / 計画 A-skeleton | ○ | S-editor・N0-a |
| N3 `NSDocument`・プロジェクトの窓・タブ・メニュー・環境設定 | 設計 §7.1・§7.4・§7.5 / 計画 A-document | ○ | A-skeleton |
| N3 パネル（Engine / Log / Catalog / Docs）・flash・status | 設計 §7.4 / 計画 A-panels | ○（`engine-view.ts` / `playhead.ts` / `log-ring.ts` は pure で再利用可） | A-document |
| N3 パリティ台帳の完走（D-1〜D-5） | 設計 §1.2 / 計画 A-parity | ○ | A-panels |
| GUI = DSL テキストの編集面（#681・旧地図 §4.N） | 旧地図 §4.N | ○（#681 の (1) 落とし方は**アプリ線でも未決のまま**。最初の実例 #664 は engine 線） | #681 |

**未決**: 改訂（10-26）: なし — (11) は推奨どおり 5 項目とも（設計 §14.0）。台帳への転記は A-parity の N3-c2。

### 4.C プロトコル（`protocol/`）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| スキーマ形式（JSON Schema 2020-12）と生成ツール | 設計 §5.8 / 計画 N0-b | ○（ツールは spike で確定） | — |
| v1 の確定（一方通行 N-1） | 設計 §5.2-5.3 / 計画 S-rpc | ○ | N0-b |
| `x-surfaces` と D-4 の検査 | 設計 §1.2 D-4 | ○ | S-rpc |
| 生成物のコミットと `protocol:check` | 設計 §5.8 | ○ | S-rpc |
| `protocol/LICENSE`（定義だけ Apache-2.0・10-26） | 設計 §5.8 / 計画 N-14 | ○ | S-rpc の N1-a1（スキーマと同じ PR） |
| daemon protocol（層 1） | `protocol.rs:8` | **v0.3**（改訂: 初版の v0.2 から engine 線で進んだ）。アプリ線は触らない（裁定 2.4）。engine 線の束が進める。本地図の対象外 | — |

### 4.D 配布（ステージ 8 の再定義）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| N0-c 同梱 node の署名 spike（entitlements の実測表） | 設計 §9.2 / 計画 N0 | ○ | — |
| `make-local-release.sh`（app 版）・署名・公証・dmg | 設計 §9.2 / 656 §5.1-5.3 / 計画 R-app | ○（旧フォーク用の `make-local-release.sh` は作業ツリーに untracked で残っているだけ・裁定 §12.3「役目を終える」） | N0-c・owner 裁定 (3)(10) |
| `release-app.yml`（`app-v*`） | 設計 §9.3 / 計画 R-app | ○ | ✅ (4)(6) 裁定済み（10-26・(6) は tag 時の GitHub を頻度とコストで決める） |
| cold-install E2E（成果物に gated `native`・PATH を絞る） | 設計 D-7 / 656 §6 | ○（改訂: 凍結版には同型の `npm run test:e2e:cold-install` が在る・#873 / #878。その `.app` 版） | R-app |
| docs 同梱（`Contents/Resources/docs/`・D-9） | 別冊 §6 / 計画 R-app N4-e | ○（改訂 10-23: 凍結版は 4.2.1 で user サイトを `.vsix` に同梱済み・dev は意図的に非同梱。アプリはその同梱を引き継ぐ） | ✅ (15)(16) 裁定済み（10-26） |
| #656 / #659 / #138（🚪） | 旧地図 §4.J | 🔴 **ネイティブ app の配布として書き直す**（裁定 §12.3）。書き直しは本地図の節から起票 | — |
| 自動更新 | 設計 §14 (5)・§9.3 | ○・🔴 **第 1 リリースに含める**（10-26 owner 裁定 B・既定で有効・opt-out） | R-app |
| Marketplace / Open VSX（#197 / #184） | 旧地図 §3 | 凍結版の話（**本地図の対象外**） | — |

### 4.E E2E・パリティ（拡張版を回帰の検算台として使う・10-26 改訂: 旧「拡張を仕様書として使う」）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| `ORBIT_GATED_TARGET = vscode \| native \| headless` | 設計 §10.2 / 計画 S-mcp・A-skeleton | ○（`vscode` は今日の形・`orbitstudio-mcp-gated.spec.ts:604-610`） | S-rpc |
| `native-parity-ledger.ts`（基準タグの `it` 題名を全列挙・未分類 red） | 設計 D-1・§5.7 / 計画 S-mcp | ○（改訂 10-23: 基準タグは定数 `PARITY_BASELINE_TAG` 1 か所・**v4.4.0 の 56 `it`**。実機の passed 数は未測。改訂 10-26: 分類の規則 = DSL の実行結果・音・能力は `native-required` / 拡張版の形だけは理由つきで `not-applicable`） | 基準タグ（v4.4.0・✅） |
| MCP ツールの v1 関門（`mcp-tools-v1.spec.ts`・10-26） | 設計 §6.1 | ○ | S-mcp |
| 暫定物の台帳の spec（`native-provisional-ledger.spec.ts`・10-26） | 設計 §1.4.2 | ○ | S-rpc の N1-a0 |
| goldens の共有（native / headless で動かないこと） | 設計 D-2 | ○（`output-line-expectations.ts` / `rack-chain-gain-expectations.ts` は既存） | S-mcp |
| D-4（`x-surfaces`）/ D-5（モーダル無し）/ 改訂 10-23: D-10（接続の認証） | 設計 §1.2・§4.7 | ○ | S-rpc / A-parity |
| ラチェット・衛生検査・台帳（旧地図 §4.G） | `gated-sources.ts` / `dsl-e2e-coverage.spec.ts` / `gated-assertion-hygiene.spec.ts` | ✅ そのまま効く（走査対象は `gated-sources.ts` が持つのでターゲット追加で壊れない） | — |

### 4.F engine 線（層 1 / 2・旧地図の節をそのまま使う）

**中身は写さない。** 順序は計画 §4.2。

| 束 | 旧地図の節 | 本地図での位置 |
|---|---|---|
| O-multiout（PR-O5 / O6） | §4.A | **最初の束**（裁定 §12.3）。headless 不要（既存 `vscode` ターゲットでも回る） |
| L-record / L-replay | §4.A.3 | S-mcp の後は headless で検証。PR-L1b / L7 の拡張側は付け替え（計画 §4.1） |
| R-live / R-offline / R-p3 | §4.A.3 | 同上 |
| V（可視化・設定・性能） | §4.H / §4.O | 表面（V6 / V7 / V10）は A-panels の後 |
| Q / K（queue・PDC・layer・instrument rack・標準プラグイン） | §4.D / §4.B | 🚪 **K がリリースゲート** |
| P（プラグイン境界・DSL Plugin） | §4.E | DSL Plugin の登録先は層 2（`packages/session`） |
| D（診断の整合） | §4.F | PR-D2 / D6 の拡張側は付け替え（計画 §4.1） |
| I（daemon / child 堅牢性） | §4.I | 変わらない |
| 入力（レコーディング） | §4.P | 着手しない（旧地図の裁定） |

### 4.G docs（改訂 2026-09-18・正本は別冊 [`848-docs-structure-design.md`](../design/848-docs-structure-design.md)）

| 段 | 正本 | 現在地 | 前提 |
|---|---|---|---|
| 可用性表記の固定文法 + frontmatter `host:` + lint（`check-availability.mjs`） | 別冊 §5 | ○ | owner 裁定 (16) |
| user サイト全章の分類（host 依存段落の併記・機能の可用性行） | 別冊 §3 の表 | ○（🔴 「アプリ主語へ全面改訂」は**撤回**。主語は A-parity 後・(20)） | 上の文法 |
| docs 追従ルーチンの手順更新（PR マージ維持 + 「未リリース（OrbitStudio）」マーカー・暫定行の扱い） | 別冊 §7 | ○（ルーチンは PR マージトリガーで稼働中・`docs/archive/WORK_LOG_2026-09.md:264` 等） | owner 裁定 (18) |
| docs 同梱（`build-docs-bundle.mjs`・`manifest.json`・`verify-app.sh` の検査・D-9） | 別冊 §6 / 計画 R-app N4-e | ○ | (15)・R-app |
| 凍結スナップショット（`/orbitscore/ext/`・タグから静的配信） | 別冊 §4.3 | ○・**出さない**（推奨 A・(17)） | 凍結版の bug fix リリースが出た時に再検討 |
| dev サイト `sites/dev/editor/`（`vscode-architecture.md` 1,197 行ほか）にネイティブ線の章 | dev STYLE_GUIDE | ○ | S-rpc（プロトコルが確定してから） |
| `CLAUDE.md` を層ごとに（`packages/session/` `apps/OrbitStudio/` `protocol/`・中身は「置かないもの」だけ） | 設計 §8 | ○ | 各束の最初の小 PR で |
| CLAUDE.md マージ前ゲートに `swift build` を足す | 設計 §9.4 | ○（docs・main 直行） | N0-a で sandbox の可否を確認してから |

---

## 5. 何が本線で何が枝葉か

| | 内容 | なぜ |
|---|---|---|
| **本線** | §3.2 の ①〜⑨ + engine 線の K | 第 1 リリースの条件そのもの |
| **本線だが順序を持たない** | engine 線の O-multiout → L → R → V → P | アプリ線と独立。headless で先に進められる |
| **枝葉（第 1 リリースに要らない）** | detach（設計 §14 (1)）/ 複数エディタ（改訂 10-26: 自動更新は owner 裁定で第 1 リリースへ移った） / MIDI スケジューラの Rust 化（改訂 10-26: T-1 の判定が「ゲート」なら PR-Q は本線へ移る・設計 §4.6）/ engine の別リポジトリ切り出し（裁定 §6「後」）/ `packages/engine` の rename。改訂（10-26）: 「拡張を薄いクライアントに」は裁定 (7) で §6 の「やらないこと」へ移した | 戻れる側に倒し、リリース後に足せる |
| **枝葉（事務・並行）** | CLA 自動化 / `LICENSES/` 全文配置 / Link 申請の要否（裁定 §5「並行して進む事務」）。改訂（10-26）: `protocol/` のライセンスは裁定 (9) で決まり、S-rpc の N1-a1 に入った（本線） | 実装を止めない |

---

## 6. やらないこと（本地図の期間中）

| やらない | 根拠 |
|---|---|
| Windows / Linux 対応・`cfg` 抽象の温存 | 裁定 2.1 |
| Mac App Store | サンドボックスがプラグインホスティングを許さない（`POST_2.0_ENGINE_AND_DISTRIBUTION.md` §5・裁定 2.5） |
| JUCE / Tracktion / Electron / Tauri / CodeMirror / `NSTextView` 自作 / VSCodium rebuild | 裁定 2.2・2.3・2.4・2.6・§10（設計 §0b の仕分け）。Electron は **Monaco × WKWebView × IME が崩れた時だけ**再検討 |
| 656 の配布設計の再設計 | 差分だけ（設計 §9.0）。署名・公証・cold-install の手順は 656 が正本のまま |
| 層 2 の Rust 移植・Rust に JS エンジン埋め込み | 設計 §4.2 D / E。境界を先に固定し、必要が生じたときに |
| 拡張への新機能・`extension.ts` の分割 | 裁定 2.5・§4.2。凍結版は bug fix のみ |
| 拡張版を新しい層 2 の窓口に書き直す（10-26） | 設計 §14.0 (7) = 書き直さない。凍結のまま退役まで保つ。他のエディタから繋ぐ日は、公開したプロトコルに繋ぐ一般の窓口として作る（設計 §10） |
| `//#` メタ行プロトコルの延命・Swift での再実装 | 設計 §5.1 P-A |
| MCP を GUI プロトコルにする・LSP 化 | 設計 §5.1 P-C / P-D |
| 常駐サービス（detach）を第 1 リリースで | 設計 §4.2 C・§14 (1) |
| per-PR の macOS ランナー | owner 方針（`rust-ci.yml:1-24`） |
| WCTM 本体・ICLC | 旧地図 §4.M（このリポジトリでは進めない） |
| 入力（レコーディング #679） | 旧地図の裁定「今はやらない」 |
| Marketplace / Open VSX の判断 | 凍結版の話（旧地図 §3 要裁定）。本地図は触らない |

---

## 7. 確認できなかったこと（❓・推測で埋めていない）

| 項目 | 何を確認すれば確定するか |
|---|---|
| Monaco が WKWebView で IME 込みで動く | N0-a（owner 実機確認） |
| ~~`file://` origin から `ws://127.0.0.1` へ接続できる~~ → 改訂（10-23）: 問いを置き換えた。**WebView の配信元 3 つ（`http://127.0.0.1:<port>/app/` = 本命 / `file://` / 独自スキーム）で WebSocket が送る Origin の実際の値** | N0-a（node の `ws` サーバに記録させる・設計 §7.3）。`file://` は `Origin: null` になる見込みで、正規のクライアントと区別できないので代替にしない |
| ATS の `NSAllowsLocalNetworking` が loopback の WebView の通信に要るか（10-23 追加） | N0-a。macOS 14 以降 ATS は IP アドレスへの接続を既定で許さない（Apple の文書）。loopback と WKWebView に掛かるかは未確認 |
| stdin の EOF で session が親の SIGKILL の後に終わるか（10-23 追加） | S-rpc の unit（パイプを閉じる）+ N2 の実機（Swift 本体を SIGKILL）。daemon 側の同じ機構は engine 線への申し送り（設計 §4.4） |
| TextMate 文法を Monaco で流用できる（`monaco-textmate` + oniguruma WASM）か Monarch に書き直すか | N0-a（20 譜面のトークン列比較） |
| JSON Schema → TS / Swift の生成ツール | N0-b |
| 同梱 node に要る entitlements（JIT 等） | N0-c（656 §5.3 の手順） |
| Codex の sandbox で `swift build` が通るか | N0-a の最初の小 PR |
| Swift シェルの実行数（数千行のオーダーか） | N2 / N3 で `wc -l` |
| `transport.step` の通知頻度が WebSocket で詰まらないか | N2 で 1 秒あたりの通知数を実測 |
| ~~拡張が同梱している docs の実体と、アプリでの同梱形~~ | ✅ 改訂（10-23）で訂正: 09-18 の「同梱していない」は誤り。**4.2.1（#954 / PR #955）で user サイトを同梱**、dev サイトは owner 決定で非同梱（`scripts/copy-user-site.sh`・`mcp-server.ts:151-154`）。アプリでの同梱形は別冊 §6 |
| 同梱 docs の Markdown を WKWebView / 層 2 の HTTP でどう配信するか（HTML と Markdown の二重同梱で足りるか） | N3 Docs パネルの最初の小 PR（別冊 §6.2 の形で始め、サイズを `verify-app.sh` で記録） |
| docs 追従ルーチンの実行制限（PR マージ 1 件あたりの消費）が新ライン込みで足りるか | ルーチンの実行履歴（cloud 側・リポジトリ外・**確認できず**） |
| 5 ms ポーリングの MIDI が演奏で聞こえているか（裁定 §9） | capture のオンセット位置で実測（受け皿は PR-Q）。改訂（10-26）: **N0-d（T-1）**として名前つきの作業にした。🔴 既存の `onsets`（20 ms 窓・`wav-analysis.ts:63-65`）では測れないので、サンプル単位の読み手（`orbitstudio-mcp-gated.spec.ts:647-704`）を使う（設計 §4.6）。外部 MIDI（RtMidi）は音が daemon を通らないので capture では測れない |
| ~~W-22（node 同梱）の裁定が新ラインにも及ぶか~~ | ✅ 10-26 owner 裁定（第 2 回）: **A 同梱**（設計 §14.0 の 5） |
| ~~bundle id / アプリ名 / 配布物名~~ | ✅ 10-26 owner 裁定: bundle id は `com.signalcompose.orbitstudio`（設計 §14 (10) A） |
| ~~#848 本文の出力先 `847-…` と本 PR の `848-…` の食い違い~~ | ✅ 解消済み（#848 の本文に `847` は 0 件・`gh issue view 848 --json body` を 2026-10-26 に確認） |
| ~~DSL の Apache-2.0 の範囲（10-26 第 2 回の裁定 7 の owner の意見）~~ | ✅ owner 確定（2026-10-26）: **DSL の仕様書（文法と意味の文書）だけ**。実装 `packages/engine` はルートのライセンスのまま。扱いは **#998**（設計 §14.0） |

---

## 8. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案）。凍結線の先の地図として新設。engine 線は旧地図の節を番号で参照 |
| 2026-09-18 | 改訂（Fable・effort high・main `1276ab1f`）。凍結を ✅（4.2.0）に。§3.1 現在地を再測（40 ファイル / 15 依存 / MCP 層 8 本 / メタ行 8 種 / ブリッジ 5 本 654 行 / protocol v0.3 / gated 49 `it` / #878 の spawn / docs 未同梱）。§2 [G] と §4.G を別冊（文書構造）の順序に置き換え、「アプリ主語へ全面改訂」を撤回。§7 の docs 行を確定に |
| 2026-10-23 | 改訂（起案: fresh subagent / 審査: main・main `7410dcb0`・拡張 4.4.0）。比較元 `1276ab1f` の日付を 09-14（4.2.0 マージ）に訂正。凍結に 4.2.1 / 4.3.0 / 4.4.0 の例外を記録（§0 前置き・§1・§2）。§3.1 現在地を再測（43 ファイル 10,810 行 / MCP 28 / ブリッジ 6 ファイル 576 行・#757 CLOSED / gated 56 `it` / user サイト同梱済み / `/mcp` は Origin 未検証 / D-8 の follow-up は未実施）。§4 の MCP・#757・N0-a・docs・台帳・D-10 の行、§7 の確認できなかったことを更新 |
| 2026-10-26 | owner 裁定を反映（審査: main）: 自動更新を第 1 リリースへ（§14 (5) = B）・(4)(6)(15)(16) 裁定済み・bundle id 確定。詳細は設計 §14.0 |
| 2026-10-26（第 2 回） | 改訂（起案: fresh subagent / 審査: main）。owner 裁定 第 2 回を反映: §1 に拡張版との関係（関門 = DSL の実行結果と能力・回帰の検算台・書き直さない）と暫定物の行 / §2 に S-eval・#997・T-1・#996 と 🚪 の D-11 / §3 に S-eval の行・`release-gate` の候補（#996・#428）/ §4.A〜4.E の未決を裁定済みへ・中継・v1 の関門・台帳の spec / §5・§6 で「拡張を薄いクライアントに」を「やらない」へ / §7 の (12)・W-22 を解消済みへ。クラウドへ渡す順は計画 §7 |
