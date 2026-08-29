# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 📚 Documentation Structure

**IMPORTANT**: Detailed design and specification documentation is maintained in Japanese in the `/docs` directory. Always refer to `/docs` for:

- **Documentation Index**: [`docs/core/INDEX.md`](docs/core/INDEX.md) - すべてのドキュメントの目次（必読）
- **DSL Specification**: [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) - 単一信頼情報源（Single Source of Truth）
- **Project Rules**: [`docs/core/PROJECT_RULES.md`](docs/core/PROJECT_RULES.md) - 開発ワークフロー、Git規則、コミット規約
- **Work Log**: [`docs/development/WORK_LOG.md`](docs/development/WORK_LOG.md) - 完全な開発履歴と技術的決定事項
- **Implementation Plan**: [`docs/development/IMPLEMENTATION_PLAN.md`](docs/development/IMPLEMENTATION_PLAN.md) - 技術ロードマップとフェーズ
- **Dev Learning Site Brief**: [`docs/development/DEV_LEARNING_SITE.md`](docs/development/DEV_LEARNING_SITE.md) - dev 学習サイト project brief + skill 運用 overrides
- **User Manual**: [`docs/user/ja/USER_MANUAL.md`](docs/user/ja/USER_MANUAL.md) - ユーザー向け機能説明 (日本語版)
- **Context7 Guide**: [`docs/core/CONTEXT7_GUIDE.md`](docs/core/CONTEXT7_GUIDE.md) - 外部ライブラリドキュメント参照ガイド
- **Testing Guide**: [`docs/testing/TESTING_GUIDE.md`](docs/testing/TESTING_GUIDE.md) - テスト手順とガイド

**Documentation Rules**:
1. All documentation in `/docs` must be written in Japanese
2. When updating project design or specifications, update `/docs` files accordingly
3. CLAUDE.md should remain concise and reference `/docs` for details

---

## 🎯 現在進行中: v1.1 Pitch DSL + Session Log + WCTM

**CRITICAL**: ピッチ DSL / MIDI 出力 (v1.1)・セッションログ (.orbslog)・コンサートシステム WCTM の開発が進行中。

> **⚠️ 本番トラック retarget（2026-07-12・統括 [#413](https://github.com/signalcompose/orbitscore/issues/413)）**:
> 藝大コンサート（Max サマースクール・イン・藝大 2026 / 2026-08-07）は **不採択**。旧「ハード締切 2026-08-07・逆算で全工程が決まる」の前提は失効。
> 本番トラックは **ICLC への proposal 提出方向へ retarget**（年次・提出日 ≈8/15・提出形態 work / work+paper はいずれも **要確認**）。
> 藝大の参加条件だった **Max 縛りも消滅**（Max は選択肢の一つで必須ではない。使わないという意味ではない）。
> WCTM 関連作業の切り出し・ICLC/ICMC 提出物・private レポ接続・orbitstudio 集約は **[#413](https://github.com/signalcompose/orbitscore/issues/413)** で追跡。
> Pitch DSL (Phase 1→2→3) は締切と独立に実装済み。

### 正本仕様（`docs/specs-v2/`）を必ずこの順で読む

実装に着手する前に、以下を順に読むこと（**Markdown が正本**・#507 で HTML から移行。埋め込み SVG のアーキテクチャ図も仕様の一部）:

1. [`docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md`](docs/specs-v2/IMPLEMENTATION_INSTRUCTIONS.md) — 作業指示書（フェーズ・依存グラフ・委譲方針・確定済み決定）
2. [`docs/specs-v2/PITCH_DSL_SPEC_v1.1.md`](docs/specs-v2/PITCH_DSL_SPEC_v1.1.md) — Stage 1 (note DSL) の仕様正本
3. [`docs/specs-v2/SESSION_LOG_SPEC_v1.md`](docs/specs-v2/SESSION_LOG_SPEC_v1.md) — 記録 (.orbslog) の仕様正本
4. [`docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md`](docs/specs-v2/WCTM_SYSTEM_SPEC_v1.md) — コンサートシステムの仕様正本
5. [`docs/specs-v2/DESIGN_DISCUSSION_RECORD.md`](docs/specs-v2/DESIGN_DISCUSSION_RECORD.md) — 設計経緯と棄却済み代替案（判断に迷ったときの参照）

### 進捗・タスク管理 = GitHub Epic #224

フェーズ構成・依存関係・受け入れ基準・子 Issue は **Epic #224** で管理。実装着手前に必ず参照する。
各フェーズ専用 Issue: #225(docs)→#226(Phase 0)→#227(Phase R)/#228(Phase 1)+#229(L1)→#230(Phase 2)→#231(Phase 3)→W系(#232-235)。

### 🔴 全フェーズ共通の運用規則（違反禁止）

1. **IMPLEMENTATION_INSTRUCTIONS §7「Known Decisions」(+ DESIGN_DISCUSSION_RECORD の決定ログ #1-32) は確定済み。再設計・再議論しない。** より良い代替案を思いついても実装せず、提案として報告に含める。
2. **フェーズゲート**: 既存テスト全グリーン + 当該フェーズの受け入れ基準を満たすまで、依存する次フェーズに着手しない。
3. **委譲は §5 Delegation Profile に従う**: レキサー/パーサー変更とプロンプト設計は main (Opus) が直列で持つ。純関数（度数解決等）と隔離モジュール（MidiOutput / L1 / Bridge）は Sonnet subagent に並列委譲可。subagent への入力は該当 spec セクション + 対象ファイルに限定し、決定済み事項の再設計を試みたら §7 の表を提示して却下する。
4. 仕様に曖昧さ・矛盾を見つけたら、解釈で埋めずに**選択肢と推奨を添えて質問する**。
5. **audio シーケンスの `play()` 意味論は一切変更しない。**
6. 実装が仕様から逸脱する必要が生じたら、**spec 側を先に更新**してから実装する（spec が正本）。
7. 各フェーズゲート時に core spec ([`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](docs/core/INSTRUCTION_ORBITSCORE_DSL.md)) へ当該機能セクションを反映する（specs-v2 との乖離を作らない）。

### 🔴 Phase 0 の停止条件

Phase 0 (#226) の事前検証4項目のうち、**仕様の前提を崩す結果が出た項目があれば、実装に進まず停止して報告する。**

---

## 🚀 セッション開始時の必須アクション

**CRITICAL: これらのステップを必ず実行すること。プロジェクトの仕様とルールを把握せずに作業を開始してはいけない。**

### ステップ1: Serena オンボーディング確認

```
mcp__serena__check_onboarding_performed
```

Serena のオンボーディング状態を確認し、利用可能なメモリリストを取得する。

### ステップ2: 必須ドキュメントを並行読み込み

**以下のドキュメントとメモリを並行して読み込むこと（1回のメッセージで複数のRead/read_memoryツールを実行）:**

#### 必須ドキュメント（Readツール）
1. [`docs/core/PROJECT_RULES.md`](docs/core/PROJECT_RULES.md) - 開発ワークフロー、Git規則、重要ルール
2. [`docs/core/INDEX.md`](docs/core/INDEX.md) - ドキュメント構造の全体像とその下のファイルによる仕様や設計の確認

#### Serenaメモリの読み込み
1. `check_onboarding_performed` で取得したメモリリストを確認
2. プロジェクト概要、開発ガイドライン、重要パターンなど、タスクに関連するメモリを `mcp__serena__read_memory` で読み込む

**並行実行の例:**
```
並行で以下を実行:
- mcp__serena__check_onboarding_performed (オンボーディング確認とメモリリスト取得)
- Read("docs/core/PROJECT_RULES.md")
- Read("docs/core/INDEX.md")
その後、必要なメモリを並行で読み込む
```

#### タスク依存の追加ドキュメント
必要に応じて以下のドキュメントを読み込む（作業内容に応じて判断）:
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](docs/core/INSTRUCTION_ORBITSCORE_DSL.md) - DSL仕様が必要な場合
- [`docs/development/IMPLEMENTATION_PLAN.md`](docs/development/IMPLEMENTATION_PLAN.md) - 実装計画の確認が必要な場合
- [`docs/development/WORK_LOG.md`](docs/development/WORK_LOG.md) - 過去の実装経緯を確認する場合
- [`docs/core/CONTEXT7_GUIDE.md`](docs/core/CONTEXT7_GUIDE.md) - 外部ライブラリドキュメントが必要な場合
- [`docs/testing/TESTING_GUIDE.md`](docs/testing/TESTING_GUIDE.md) - テスト手順が必要な場合

### ステップ3: 現在のブランチを確認

```bash
git branch --show-current
```

**ブランチ確認後のアクション:**
- ✅ 機能ブランチ（`<issue-number>-*`形式）: そのまま作業可能
- 🔴 `main`ブランチ: 絶対に作業しない。機能ブランチを作成すること

### ステップ4: 作業準備完了の確認

以下を確認してからユーザーに報告:
- [ ] Serena オンボーディング確認完了
- [ ] 必須ドキュメント読み込み完了
- [ ] Serenaメモリリスト確認完了
- [ ] 関連するメモリ読み込み完了
- [ ] 現在のブランチを確認
- [ ] 作業可能な状態であることを確認

**ユーザーへの報告例:**
```
準備完了しました！

✅ Serena: オンボーディング確認済み
✅ 必須ドキュメント: PROJECT_RULES.md 読み込み完了
✅ Serenaメモリ: X件のメモリを確認、関連メモリ読み込み完了
✅ 現在のブランチ: <branch-name>（機能ブランチ）

何かお手伝いできることがあればお申し付けください。
```

### 📋 なぜこれが重要か

1. **仕様遵守**: プロジェクトの仕様とルールを理解せずに実装すると、仕様違反のコードを書いてしまう
2. **ワークフロー違反防止**: Git規則を理解せずに作業すると、protected branchへの直接コミット等の問題が発生
3. **一貫性の維持**: 命名規則やパターンを把握してから実装することで、コードベース全体の一貫性を保つ
4. **効率的な作業**: 必要なドキュメントを事前に把握することで、後から探す時間を削減

### 🚫 やってはいけないこと

- ❌ ドキュメント読み込みをスキップして実装を開始
- ❌ ユーザーが「準備して」と言った時に、ドキュメントを読まずに「準備完了」と返答
- ❌ PROJECT_RULES.mdを読まずにコード変更を開始
- ❌ ブランチ確認をせずに実装を開始

---

## Quick Reference

### Project Overview
**OrbitScore** - Audio-based live coding DSL for modern music production
- DSL Version: v3.0 (SuperCollider Audio Engine)
- Test Status: 1333 passed, 29 skipped (1362 total)
- Branch Strategy: GitHub Flow (`main` + feature branches)

### Development Commands
```bash
npm run build            # Build all packages (incremental)
npm run build:clean      # Clean build (rebuild all files)
npm test                 # Run all tests (1362 tests, 29 skipped)
npm run dev:engine       # Run engine in development mode
npm run lint             # ESLint + Prettier
```

**Note**: Use `npm run build:clean` if you encounter TypeScript incremental build issues (e.g., `cli-audio.js` not generated).

### Technology Stack Summary
- **Frontend/DSL**: TypeScript, VS Code Extension API
- **Audio Backend**: SuperCollider (scsynth), supercolliderjs
- **Testing**: Vitest (Unit + Integration tests)
- **Key Features**: Audio File Playback (WAV/AIFF/MP3/MP4), Time-stretching, Polymeter

**Details**: See [`docs/INDEX.md`](docs/INDEX.md)

### Key Conventions
- **DSL Specification**: [`docs/INSTRUCTION_ORBITSCORE_DSL.md`](docs/INSTRUCTION_ORBITSCORE_DSL.md) - Single Source of Truth
- **Work Log**: Every commit MUST be documented in [`docs/WORK_LOG.md`](docs/WORK_LOG.md)
- **Branch Names**: `<issue-number>-description` (English only, e.g., `61-audio-playback-testing`)
- **Commits/PRs**: Japanese (e.g., `feat: オーディオ録音機能を追加`)

**Details**: See [`docs/PROJECT_RULES.md`](docs/PROJECT_RULES.md)

---

## 🔴 CRITICAL: Implementation Workflow

**NEVER start coding without following these steps:**

### Correct Workflow (MUST FOLLOW)

```
1. Create Issue: gh issue create --title "..."
2. Create Branch: git checkout -b <issue-number>-description
3. Start Implementation (Edit/Write tools OK)
4. Run Tests: npm test
5. Update WORK_LOG.md
6. Commit
7. Create PR: gh pr create --base main --body "Closes #N"
```

### ❌ NEVER DO THESE

- Start implementation on `main` branch
- Start without creating an Issue
- Start without creating a branch
- Use branch names without Issue number
- **Commit without updating WORK_LOG.md**

### Pre-Implementation Checklist

**Before using Edit/Write tools, confirm:**

1. ✅ Issue created?
2. ✅ Branch created?
3. ✅ Current branch is NOT `main`?
4. ✅ Branch name includes Issue number?

**If any answer is No, DO NOT start implementation.**

### Hook Protection

**Automated Guards:**
- `pre-edit-check.sh` blocks Edit/Write on main branch
- `pre-commit-check.sh` blocks Serena memory commits on main
- `session-start.sh` shows reminders at session start

See `.claude/settings.json` for Hook configuration.

**Details**: See [`docs/PROJECT_RULES.md`](docs/PROJECT_RULES.md), [`.claude/hooks/README.md`](.claude/hooks/README.md)

---

## 🔴 工程ごとの担当（#549 / #564 で実測・2026-07-29）

| 工程 | 担当 |
|---|---|
| 設計 | **Fable** |
| 設計のチェック | **main** |
| 実装 | **Codex** |
| 実装のモニタリング | **main** |
| **検証** | **main**（sandbox 外で全テスト + 実機 E2E） |
| レビュー | `/simplify` → `/code:pr-review-team` + **Fable 監査を並行** |

### 🔴 検証を委譲先に任せない（構造的な理由）

Codex は sandbox で **daemon protocol（localhost bind）・MCP 系・実機 E2E が原理的に走らない**。
**「Codex が緑と言った」だけでマージできる PR は構造的に存在しない。**

報告と実測の乖離が実際に3回起きている:

| 事例 | Codex の報告 | main の実測 |
|---|---|---|
| #549 カタログ件数 | plugins 337 / effect 270 | **339 / 272**（`/bin/ps` 拒否による環境要因） |
| #564 分類テスト | 対象テスト green | **1 failed**（sandbox では走らない spec） |

**委譲の価値は実装にあって検証には無い。** 委譲先の green 報告は、
**必ず main が sandbox 外で回し直す**。

### Sonnet チームと Fable は発見クラスが直交する

| 層 | 見るもの |
|---|---|
| Sonnet チーム | 差分に**在る**ものの実行接地検証（変異実走・弱アサーション検出） |
| Fable | 差分に**無い**もの（不在証明）・外部 API の意味論・設計整合 |

- **#549**: Sonnet 4名の後、Fable が **core spec 未更新**と
  **診断が MCP から読めない片翼状態**を発見（後者はゴール記述に直接反していた）
- **#564**: Sonnet 4名が **Critical 0 / Important 0** を出した後、Fable が
  **`aux` が実機で一度も鳴っていない**ことと **暫定行が消せる保証がない**ことを発見

**並行投入する**（順番に回しても発見は早まらない）。

---

## 🔴 PR レビューワークフロー（コード変更時・MUST USE SLASH COMMAND）

**コード変更を含む PR をレビューするときは、以下を必ずスラッシュコマンド（Skill tool）で実行する。Agent tool でのハンドロール代用・反復ループの手動組み立ては禁止。**

1. **`/simplify`** — reuse / simplification / efficiency / altitude の cleanup を適用。
2. **`/code:pr-review-team` ラウンド1（フル編成）と Fable 監査を並行起動する。**
   - **Fable は最後に回さない。** PR #527 で Fable が見つけた既存バグ2件は**ラウンド1の時点から
     存在していた** — 5ラウンド分のコストを払い切った後にしか見つからない配置だった。遅延投入は
     発見を遅らせるだけで何も救わない
   - 両者の発見クラスはほぼ**直交**する（#527 で指摘が重複したのは1件のみ）。直交なら並行でよい
   - Fable への依頼は3問に固定する: ①**不在証明**（登録されるべきハンドラ・契約を列挙し実在を
     照合）②**外部 API の意味論**（戻り値・フラグの契約を一次ソースで確認）③**横断的関心事の
     設計整合**
3. **全指摘を集約し、修正前に設計パスを置く。** エラー封じ込め・診断ポリシー・ガード方針などの
   **横断的関心事**に触る指摘は、**先にポリシーを1段落書いてから**全該当箇所へ一括適用する。
   **指摘単位のローカルパッチは禁止**（振動の主因）。

   🔴 **fixer は Codex → 収束しなければ main（owner 確定 2026-07-31）。Fable は fixer に使わず
   監査に専念させる。**

   1. **Codex に最大3回 fix を出す。** ただし **fix の質は指示の質で決まる**ので、
      **ポリシーの明文化 / 具体的な故障シナリオ / 変異検証の要求 / 検証コマンド /
      「やってはいけないこと」**を毎回書く。「指摘を並べただけ」の発注はしない
   2. 各 fix には次項の確認レビューが伴うので **実質4ラウンド**
   3. **4ラウンド目でも収束しなければ main が直接直す**（グローバル CLAUDE.md の
      「指揮者専任」の例外。memory `fable-main-may-implement-directly` の一般化）

   > **なぜ main か**（owner 2026-07-31）: main はコンテキストを持っており、
   > **4ラウンド目に至る頃には差分を読み終えている**。その段階で fixer へ渡すブリーフを
   > 書き起こすコストは、自分で直すより高い。#591 では main が Fable 宛に
   > 「採るべき案と理由」まで書いており、**転記作業になっていた**。
   >
   > **なぜ Fable を fixer にしないか**: 自分の fix を自分で監査することになり独立性が落ちる。
   > #591 ラウンド2の Important 2件は**すべて Fable 自身の fix 起因**で、Fable 監査は
   > 元差分しか見ていなかった。「Sonnet = 差分に在るもの / Fable = 差分に無いもの」の
   > 分担（下の層別表）は、Fable が書き手になると崩れる。
4. **fixer の差分は、ラウンドを閉じる前に再点検する**（1レビュアーで可）。問いは2つだけ:
   「**この修正が導入する新しい故障モードは何か**」「**新コードはどの実行コンテキストで走るか**」。
   現行フローは fix の欠陥発見が常に次ラウンドまで1ラウンド遅延する構造で、これが振動の増幅器。
5. **ラウンド2以降は provenance で縮小する。** 各指摘を **{original-diff 起因 / fix 起因}** に
   分類し、**original-diff 起因の新規指摘が0になったら元差分のレビューは収束**とみなして、
   **fix-scoped 縮小レビュー**（fix 差分のみ・1レビュアー + 変異実行）へ切り替える。
   **上限は「Codex への fix 3回 + それぞれの確認レビュー」= 実質4ラウンド**（項目3と同じ数え方）。
   超えたら Sonnet / Codex を回し続けず **Fable を fixer 兼裁定者として投入**する。
   「指摘の質が下がったら」のような主観指標は使わない。
6. **CLOSED 判定は変異の実行結果のみを根拠とする。** 差分の読み直しによる自己申告は不可。
   打ち切りを緩めても、この実行主義を維持すれば検出力は落ちない。

#### 層別の得手不得手（PR #527 実測・2026-07-27）

**Sonnet チームは「書かれたものの正しさ」、Fable は「書かれるべきだったもの」を見る。**

| 層 | 得意 | 見落とす |
|---|---|---|
| Sonnet チーム | 差分に**在る**ものの実行接地検証（変異実走・弱アサーション検出・修正の鏡像欠陥） | 差分に**無い**もの（不在）。ラウンド遅延で自分たちの era の fix を後追いする |
| Fable | **不在証明**・**API 意味論**（一次ソース照合）・設計整合の一発判断 | 大量変異の grind はコスト不適合（やらせない） |
| bot | 系統の異なる目（理論上） | #527 では**指摘ゼロかつ偽の完全性判定**をした（「登録済み4ハンドラはすべて正しい」— 5つ目が無いことを見落とし） |

### レビュー通過後（bot レビュー）

7. bot レビューは **optional・スコープ限定**。受けるかどうかと範囲は Fable に相談する。起動したら
   **本文が確定するまでポーリング**する（bot は placeholder を後から更新する方式）。
   **🔴 bot の沈黙・完全性主張を収束の根拠にしてはいけない**（証拠能力を持たせない）。
8. bot 指摘の修正内容を Fable と確認し、**再度 PR レビューが必要か**を判断する。

### 🔴 テストの積み上げ規律（必須・owner 指示 2026-07-27 / **手段を改訂 2026-08-29**）

> いくら作ってもテストが意味をなしてないと先に進めないので、テストの積み上げだけはしっかりしてください。

🔴 **上の引用が owner の指示のすべて**（目的）。**以下は手段であり、owner の指示ではない。**
状況に応じて改訂してよい（実際 2026-08-29 に改訂した。経緯は末尾）。

**「通るテスト」は根拠にならない。** 壊れた実装に対しても通るテストが積み上がると、その上に
建てたものを何も信用できなくなる。**テスト件数は PR ごとに増やす。**

#### 🔴 大前提: 機能にはテストを書く（TDD）

**機能テストは常に書く。実装前に書いて red を確認する。** 以下の層はこれを置き換えるものではない。

**型はテストの代替ではない。** テストは**機能**に対して書き、型は**実装の誤り**を防ぐ。軸が違う。
`() => void` の兄弟コールバック取り違えは型では防げないが、引数付き1本に畳めば防げる —
これは機能テストの有無と無関係の話である。

#### 手段の選択 — 機能テストに**加えて何を足すか**（2026-08-29 owner と合意）

| 対象 | 追加で足すもの |
|---|---|
| **型が保証している誤り** | **何も足さない。** 🔴 **型チェッカが保証することをテストで確かめない**（何のための TypeScript / Rust か） |
| **DSL から決定論的に駆動でき、信号（音・ログ・状態）に出る振る舞い** | 機能テストそのものを**キャプチャ E2E** にする |
| **駆動できない / 信号に出ない内部状態** | **変異検証** |

判定の軸は「聞こえるか」ではなく **「DSL から決定論的に駆動できるか」**。
聞こえても再現手順が組めないなら E2E にならない。組めるなら E2E に寄せる。

**型で潰す作業は「テストを減らす手段」ではなく、設計そのもの**（下の §1）。結果として
防御的な追加テストが要らなくなる、という順序で考える。

🔴 **一律に「新規テストは必ず変異検証」としない**（2026-08-29 撤回）。全件に課すと重すぎて、
かつ**効かない場所に払うことになる**。

##### 1. 型で潰す（設計・テストの代替ではない）

純関数へ抽出してユニットテストを付けても、**その純関数と本物の副作用を繋ぎ直す配線**は
別物であり、抽出しただけでは無防備なまま残る。特に **`() => void` 型の兄弟コールバックは
取り違えても型チェックを通る**（#527 で `setPlayingStatus` / `setReadyStatus` の入れ替えが
ユニット・E2E とも全件 green だった）。

- 同一シグネチャの兄弟を1本の引数付き関数に畳めば
  （例: `setPlayingStatus`/`setReadyStatus` → `setTransportStatus(state)`）取り違えは
  **表現できなくなる**
- 不変条件を「順序の慣習」でなく**データの配置**で強制する（#628 実例: 世代番号を別の atomic から
  退役リストの中へ移したところ、「store を CAS の後ろへ動かす」変異が**書けなくなった**）
- **型が保証している誤りには、防御的な追加テストが要らない。** ただし**機能テストは別途書く** —
  型は「壊れた実装が書けない」ことを保証するだけで、「機能が動く」ことは保証しない

##### 2. キャプチャ E2E（信号に出るもの）

**音はデジタルなので観測できる。** 音量・順序・バッファの漏れ・bit 一致は、すべてキャプチャした
WAV のアサーションで判定できる。タイミング条件も **DSL から意図的に駆動できる**（例:
「バス未有効 → 鳴らす → effect を足して有効化」）ので、偶然を待つ必要はない。

- **実装前に書いて red を確認する**（TDD をそのまま E2E に適用）。これで「アサーションが
  信号を見ていない」ハーネス不備が最初に落ちる — #528 の無音ハーネス事故はこれで防げた
- ここでの E2E は**機能テストそのもの**であって、機能テストへの追加ではない
- ❌ **`evaluate_orbitscore` の `ok` に assert しても何も証明しない**（エンジン側のエラーは
  `get_log` にしか出ない）
- ERROR 件数は `get_log` の固定 500 行窓なので**厳密等価にしない**（`<=` を使う）

##### 3. 変異検証（🔴 **最後の手段**・owner 確定 2026-08-29 夕）

> 実機検証するためにも **MCP ツールを用意してユーザーと同じ動線で試験できるようにしているのは
> 「確実な動作を確認するため」**です。そのためにも変異テストより本来は **DSL を網羅した E2E
> テストを充実**して、そこで**実機の実行に問題がある場合で必要があって初めて**変異テストなど
> になりますが、それも本来は**ちゃんとログを出して異常系を捕まえられる様にすれば良い**のです。

🔴 **順序が決まっている。飛ばしてはいけない。**

```
DSL を網羅した E2E（ユーザーと同じ動線）
  → 実機で問題が出た
    → ログで異常系を捕まえられるようにする
      → それでも捕まらない時に、初めて変異検証
```

**MCP ツールは「テスト用の裏口」ではない。ユーザーと同じ動線を通すための装置**であり、
だからこそ E2E がそこを通ることに意味がある。**動線が違うテストは、確実な動作を確認していない。**

#### 実証（2026-08-29・この規律が正しいことの根拠）

`global.gain()` が **instrument にまったく効いていなかった**。ミキサーの stage から master へ
合流する音が、**master gain を掛けた後に加算されていた**（`output.rs` の post-loop）。

| 手段 | この欠陥を捕まえたか |
|---|---|
| 変異検証 **35件**（80分以上） | ❌ **1件も捕まえていない** |
| ユニットテスト 2149件 | ❌ |
| **キャプチャ E2E で RMS を実測** | ✅ **これだけ** |

**変異検証は「テストが実装を見ているか」しか問えない。** 実装が全層で正しく見えても、
**合成の順序が違えば音は変わらない** — それは端から端まで通して初めて分かる。

🔴 **ログについての正確な但し書き**: この欠陥は**異常系ではなかった**。各層は成功を返し、
ERROR は 1 行も出ていない。**ログは「壊れた時に気づく」ためのものであって、
「正しく見えるが合成が違う」を捕まえるのは E2E だけ**である。だからログの充実は
E2E の**代わりではなく補完**として置く。

#### 以下は、変異検証をやると決めた時の作法（規模ではなく質の話）


> 変異テストにかけている時間が開発のかなりの時間を占めていて、開発速度がすごく下がっている
> というのがとても問題だと思っています。
>
> もちろん変異テストをすることで隠れたバグとか、テストがきちっと動いているのかとか、いろいろ
> いいこともあると思うんですけど、**変異テストを入れることでの弊害の方が現状すごく大きく**
> なっていると考えています。

🔴 **PR ごとに変異検証を回さない。** 実測: #633 の1 PR で**変異だけに 80分以上**を払い、
その3分の1は「**機能を消せば、その機能のテストが落ちる**」という同語反復だった。

**代わりに置くもの:**

| 目的 | 手段 |
|---|---|
| 「このテスト、実は何も見ていないのでは」 | **`cargo-mutants --test-tool nextest --in-diff`**（無人・差分のみ） |
| **振る舞いの保証** | **キャプチャ E2E**（下記の最重要節）。これが本体 |
| 「棄却した設計案に戻す」等、生成器に作れない変異 | **手書き。ただし PR あたり数件まで** |

**手書き変異を許すのは、生成器の語彙に無いものだけ**（棄却案への差し戻し・副作用の順序・
呼び出し回数）。分岐反転や戻り値置換は機械の仕事であって、人が発注して待つものではない。

網羅的な変異が要るなら **PR とは別のタイミングでまとめて**行う（週次など）。

---

以下は、上記の「数件まで」を実施する時の作法である（規模の話ではなく質の話）。

守る対象を壊して **red になることを確認**し、restore して green も確認する。
**実出力を報告に含める**（自己申告は根拠にならない）。

1種類の変異が red になっただけで結論しない。#527 では「ガードを無効化する」変異は殺せたのに、
**別種の変異3つが全件 green のまま生き残った**（同じ副作用を2回呼ぶ / ループの `continue` 削除 /
副作用の順序を完全逆転）。壊し方を変えて試す: **(a) 分岐を反転 / (b) 呼び出し回数を変える
（0回・2回） / (c) 順序を入れ替える / (d) 引数を別の値に差し替える**。

対応するアサーションの原則:
- `toHaveBeenCalled()` ではなく **`toHaveBeenCalledTimes(n)`**。FIFO キューを消費する副作用では
  回数がそのまま正しさである
- **引数まで検証する** — 複数経路から同じ関数が呼ばれるテストでは、呼ばれた事実だけでは
  経路の取り違えを検出できない
- 順序が意味を持つなら **`mock.invocationCallOrder`** で順序を固定する

畳めない配線は **`vscode` モックを介して実際に叩き、観測可能な副作用を検証する**
（`tests/vscode-extension/` に配置）。

#### 改訂の経緯（2026-08-29・同じ誤りを繰り返さないため）

旧版は「**新規テストは必ず変異検証する**」という一律ルールで、owner 指示の見出しの下に
置かれていた。しかし **owner の指示は冒頭の引用（目的）だけ**で、一律ルールは過去セッションが
目的を手段へ翻訳したものだった。**翻訳結果が指示者の名前を引き継いだため、再検討されなくなっていた。**

撤回の根拠（owner との議論で確定）:
- #528 の「ハーネスが無音を出したのに警報が鳴らなかった」事故を、旧版は**変異検証が要る根拠**として
  引いていた。しかしあれは **E2E が信号を見ていなかった**事故であり、キャプチャに RMS の
  アサーションがあれば落ちた。**原因の帰属を一段間違えて、効かない規律を積んでいた**
- 「タイミング条件と bit 一致は E2E に届かない」も誤り。**音はデジタルで取れる**し、
  条件は DSL から駆動できる

🔴 **指示を記録する時は、引用（owner の言葉）と解釈（手段）を見出しレベルで分けること。**

#### 🔴 設計書は本規則を上書きできない（2026-08-29 夕・実害が出たので明文化）

`docs/design/*.md` の「失敗モード ↔ テスト対応表」が全行に変異を課していても、**本節の
規律が優先する。** 設計書は**起案時点の規律**を写し取るため、規律を改訂すると**設計書だけが
旧方針のまま残る。**

**実害**: 2026-08-29 朝に本節を3層へ書き換え「一律に変異検証としない」を撤回したが、
`628-ui-pump-per-index-design.md`（前日に Fable が起案）は35行すべてに変異を課しており、
main はそれに気づかず**撤回済みの旧方針を2ラウンド発注した**。

**対処**: 設計書を読んで発注する時、**§5 相当の表は「テスト対象の一覧」として読み、
検証手段は本節で決め直す。** 表の「変異」列は候補であって指示ではない。
### 🔴🔴 E2E が最重要（owner 強調 2026-07-27 / **2026-08-29 に理由が明文化された**）

> 変異テストよりも **E2E でしっかり DSL が動作しているかどうかを保証する方が、アプリケーション
> としては重要**だと考えています。なぜなら E2E テストというのは、エンドツーエンドで実行が
> 確約されることで、**中のロジックがどういう実装になっているかに関わらず、正しく振る舞って
> いることを保証する**テストだからです。

**この一文が両者の順位を決める。** 変異検証は「**テストが実装を見ているか**」を問う。
E2E は「**振る舞いが正しいか**」を問う。**出荷するのは振る舞いであって、テストの厳密さではない。**

#### 🔴 開発の趣旨は機能開発であって、テストを書くことではない（owner 2026-08-29）

> テストを書きたいというのが開発の趣旨ではなく、**機能開発をしたいのが開発の趣旨**だという
> ことはわかっていますか？
>
> むしろ、**仕様とかその辺をいいようにねじ曲げて、後からそれが発覚する**みたいなことの方が
> 問題ですし、今回ミキサーのロジック、仕様を考えるのをしっかり行ったことで、圧倒的に
> スムーズになったりということもあるので、**仕様をきちっと作成し、その通りに作り、正しい
> 振る舞いをまずは保証する**というのが大事だと思っています。

**したがって投資の順位はこうなる:**

| 順位 | 何に払うか | なぜ |
|---|---|---|
| **1** | **仕様を先に固める** | #643 が実測。仕様を詰めたから実装が速かった。**仕様のねじ曲げが後から出るのが最悪** |
| **2** | **仕様どおりの振る舞いを E2E で保証する** | 実装に依存せず振る舞いを固定できる唯一の層 |
| **3** | 機能テスト（TDD） | 部品の正しさ |
| 4 | 変異検証 | **テストの検査。PR のクリティカルパスに置かない**（上記の節） |

**テストは目的ではなく、完成したロジックが壊れないための保証**である。順位を取り違えると、
機能が進まないままテストの厳密さだけが上がる。

**このプロジェクトで実害を出した失敗は、すべてユニットテストに見えないものだった。**

| 事故 | ユニットテスト | 発覚経路 |
|---|---|---|
| `setDocumentDirectory` の誤分類で**エディタ評価が全滅**（S2 マージ以降） | 全件緑 | 実機で動かして |
| instrument の音が seq バスを通らず **SC.0 が原理的に動かない** | 検出不能 | 設計時の一次情報調査 |
| stale な拡張ホスト × 新 daemon → `DaemonStartupError` | 無関係 | 実機起動 |

ユニットテストは**部品**を検証する。壊れるのは**配線**であり、配線は E2E でしか見えない。

- **E2E は資産として積む。手で MCP を叩いて確認して終わりにしない** — 次の PR で同じ手作業を
  やり直すことになり、退行も防げない
- 積み先は `tests/e2e/orbitstudio-mcp-gated.spec.ts`（`ORBIT_GATED_ORBITSTUDIO=1` でゲート・
  実 OrbitStudio.app を起動し MCP tool 呼び出しだけで駆動）。**並行機構を新設しない**
- ゲート env が未設定なら **skip されること**を確認する（通常の `npm test` を壊さない）
- **その PR が追加した観測可能な表面**を必ず1つ以上 E2E で押さえる。「挙動不変の PR だから
  E2E は既存機能の確認だけ」は**言い訳にならない** — 新しいエラー文言・新しい ID 生成・
  新しい失敗経路はすべてユーザーが到達できる表面である

#### 🔴 これらは仕組みで強制されている（2026-08-29・「知識でなく再現可能な仕組みに」）

**文章は読まれない時がある。** 以下は CLAUDE.md の記述を**テストとスクリプトへ落としたもの**で、
違反すると赤くなる。**規律を足す時は、同時にそれを守らせる仕組みを足すこと。**

| 規律 | 仕組み | 違反すると |
|---|---|---|
| DSL を足したら E2E も足す | `tests/e2e/dsl-e2e-coverage.spec.ts` | **未カバーの語が増えたら red**（ラチェット・減る分は緑） |
| ERROR 件数を厳密等価にしない | `tests/e2e/gated-assertion-hygiene.spec.ts` | 該当行を名指しで red |
| キャプチャしたら数値で判定する | 同上 | capture するのに rms を見ていなければ red |
| stale ガードは正本の解決関数を使う | 同上 | 決め打ちに戻したら red |
| 実機テストは最新ビルドで走る | `package.json` の **`pretest:e2e:gated`** | そもそも**古いバイナリで走らない**（自動ビルド） |
| cfg 4象限をすべて確かめる | `scripts/check-cfg-matrix.sh` | ループを手書きしない（zsh の単語分割で**同日2回**壊した） |
| 公開メソッドは DSL 語彙か内部 API か | `tests/interpreter/signal-chain-dispatch.spec.ts` | 未分類なら red（本日2回発火） |
| capture は異常終了でも開ける | `capture.rs` の定期 header patch + unit | — |

**ラチェットの baseline（未カバー語の一覧）は減らす方向にしか編集してはいけない。**
増やす編集は「DSL を足して E2E を書かなかった」ことなので、レビューで止める。

#### DSL 機能を足したら E2E も足す（owner 指示 2026-07-27）

> DSL の機能を追加したら必ず E2E テストを追加しておかないとこういうことになる。

**DSL の表面（新しい構文・チェーンメソッド・宣言形式）を追加する PR は、その構文を実機で
評価する E2E なしにマージしない。** ユニットテストはパーサ／リゾルバという**部品**しか見ない。
DSL 機能が実際に価値を出すのは「エディタで書く → 評価される → 音が出る」という**配線の全長**で、
そこはユニットテストの視野の外にある。

- 新構文は **`run_selection` 経由で評価**し、結果（音・診断・エラー文言）まで E2E で確認する
- 音を出す機能は **capture WAV のアサーションまで**通す。「エラーが出ない」は音の証明にならない
- #528 がまさにこの怠りの帰結: `setDocumentDirectory` の配線が S2 マージ以降ずっと壊れていたのに、
  ユニットテストは全件緑・レビュー2周も通過し、E2E の音アサーションだけが唯一気づける位置に
  いた（そしてその E2E 自身がハーネス不備で無音になっており、警報が鳴らなかった）
- ❌ **`evaluate_orbitscore` の `ok` に assert しても何も証明しない** — 「受理して書き込んだ」を
  返すだけで、**エンジン側のエラーは `get_log` にしか出ない**。この罠が上表1件目の原因

**弱いアサーションの典型**（いずれも本プロジェクトで実際に出荷された）:
部分一致が偶然マッチし続ける／エラー文言の**説明部分でなく引数名**をアンカーにしている
（引数名は常に先頭に出るので入れ替えても通る）／**捏造した mock 文言**を検証している
（実文言と乖離しても気づけない）／逆方向テストが「分類されていること」しか見ておらず
**分類そのものの誤り**を検出できない。

**実証（#517 S4 PR-1a・1セッションで4件）**: `instanceId` を定数に置換しても全 1634 件が通過／
`normalizePluginInstanceName` を恒等関数に置換しても全件通過／fixer の書いた保持テストが
保持ロジックを壊しても通った／`setDocumentDirectory` の誤分類でエディタ評価が全滅していたのに
逆方向テストは緑のままだった。

### 🔴 マージ前ゲート: ビルド + 実機 E2E（必須・owner 指示 2026-07-27）

**マージ指示を仰ぐ前に、必ずビルドして実機で動かし、その PR の機能が動くことを確認する。**
ユニットテストが全部緑でも実機が壊れていることがある。

手順:

```bash
npm run build          # engine/daemon に変更があれば npm run build:clean

# 🔴 同梱の標準プラグインが実機で鳴ることを確かめる（owner 判断 2026-08-28・#628）
bash rust/crates/orbit-std-gain/bundle-macos.sh
cargo test --manifest-path rust/Cargo.toml -p orbit-effect-rack-child --lib -- --ignored
```

**この 2 行は無条件で回す。**「rust を触った PR のみ」のような**条件分岐を付けない** —
条件付きの手動手順は飛ばされるのがこの repo の実測クラス（列挙が一段手前で止まる型）で、
無条件 19〜67 秒の方が条件判定の認知コストより安い。

**なぜ CI に任せられないか**: `rust-ci.yml` は全ジョブ ubuntu で、この 3 件は
`#[cfg(target_os = "macos")]` なので**存在すらしない**。`release.yml` は macos-14 だが
`pull_request` の paths フィルタに **`rust/**` が無い**ため、**rust だけを触る PR では走らない**。
per-PR の macOS ジョブは owner 方針（コスト）で回さない。**手元がこの 3 件の唯一の実行経路。**

🔴 **`--lib` は load-bearing**（#629）。付け忘れると実機オーディオデバイスを要する
gated テストまで対象になる。

1. **起動中の OrbitStudio を必ず終了してから起動し直す** — 古い extension host が新しい daemon を
   spawn すると `DaemonStartupError: daemon exited before ready (code=null)` になる
2. `ORBITSCORE_MCP_PORT=39123` を付けて起動（この環境変数が無いと MCP サーバーが立たない）
3. `mcp__orbitscore__get_engine_state` でエンジン起動を確認
4. **その PR で追加/変更した DSL 機能を `mcp__orbitscore__evaluate_orbitscore` で実際に評価する**
5. **`mcp__orbitscore__get_log` で ERROR が出ていないことを確認する**

❌ **`evaluate_orbitscore` の `ok` だけで判断しない。** これは「受理して書き込んだ」を返すだけで、
エンジン側のエラーは `get_log` にしか現れない。

**理由（PR #523 で実証）**: 全 suite 1632 緑・`/simplify` 通過・`/code:pr-review-team` 2ラウンド
（4レビュアー）通過の状態で、実機で動かしたら **S2 マージ以降エディタ評価が全滅していた**
（拡張が全評価の先頭に注入する `global.setDocumentDirectory(...)` が DSL 語彙に無く弾かれていた）。
逆方向テストは「全メソッドが DSL 語彙か内部 API 除外リストのどちらかに分類される」ことしか
検査しないため、**除外リストへの誤分類でテストは緑・実行時だけ壊れる**。
机上レビューとユニットテストでは「ホストが注入する経路」は守れない。

### ドキュメントのみの変更

5. **docs のみの変更**は full PR レビュー（simplify + pr-review-team）がオーバーエンジニアリングになる。**advisor と相談してレビュー方法を決める**（例: comment-analyzer のみ / advisor の直接確認 / bot second-opinion 等）。ビルド + 実機 E2E も不要。

### 禁止事項

- ❌ `/simplify` / `/code:pr-review-team` を Agent tool でハンドロールして代用する
- ❌ `/code:pr-review-team` の反復ループを自分で round 分割して手動実行する（スキルに収束まで委ねる）
- ❌ 内部レビュー通過の判定を自己判断で済ませる（独立した再レビュー or bot で裏付ける）
- ❌ **ビルド + 実機 E2E を省いてマージ指示を仰ぐ**（コード変更を含む PR の場合）

### 理由

各 skill には固有の hook（`verify-workflow.sh` 等）が付随し、iteration 収束の計測・security checklist 参照・完了条件チェックを行う。Agent tool でハンドロール代用すると hook が発火せず品質ゲートが形骸化する。過去に PR #121 / #124 で同じ bypass を繰り返した（本セッションでも pr-review-team の 2 周目検証を手組みして指摘を受けた）。

---

### Branch Structure
- `main` - Production (protected, base for PRs)
- `<issue-number>-description` - Feature branches (English only)

### Quick Workflow
```bash
# 1. Create Issue
gh issue create --title "..."

# 2. Create Branch
git checkout -b <issue-number>-description

# 3. Implement & Test
npm test

# 4. Update WORK_LOG.md
# Edit docs/WORK_LOG.md

# 5. Create PR
gh pr create --base main --body "Closes #N"
```

**Details**: See [`docs/PROJECT_RULES.md`](docs/PROJECT_RULES.md) Section 2

---

## 📚 Documentation Reference Priority

**When you need library/technology information, follow this order:**

1. ✅ **Context7 first**
   ```
   mcp__context7__resolve-library-id("library-name")
   mcp__context7__get-library-docs("/org/project", topic="...")
   ```

2. ✅ **WebFetch only if Context7 is insufficient**
   ```
   WebFetch(url="...", prompt="...")
   ```

**Reason**: Context7 has rich code examples and best practices, available offline. WebFetch is supplementary for latest information.

**Exception**: Project-specific docs (`/docs`) use Read tool directly.

**Details**: See [`docs/CONTEXT7_GUIDE.md`](docs/CONTEXT7_GUIDE.md)

---

## 🎓 Skill: vitepress-learning-site の運用

`.claude/skills/vitepress-learning-site/` は [yuichkun/.claude](https://github.com/yuichkun/.claude/tree/main/skills/vitepress-learning-site) 由来の skill (作者承諾済、verbatim install)。
**OrbitScore 用の事前確定事項と運用 overrides** は [`docs/development/DEV_LEARNING_SITE.md`](docs/development/DEV_LEARNING_SITE.md) に集約する。

### 起動前の必須読み込み

`/vitepress-learning-site` または当該 skill を invoke する作業に入る前に、
必ず [`docs/development/DEV_LEARNING_SITE.md`](docs/development/DEV_LEARNING_SITE.md) を読み込むこと。

このファイルには以下が含まれる:
- skill の Phase 1 (interview) で grilling される項目の **事前回答** (audience=self, language=ja, primary source=own codebase 等)
- skill default からの **OrbitScore 固有 override** (cross-LLM-family audit を advisor で代替、site location を `sites/dev/` に固定 等)
- dev 学習サイトの **project brief** (なぜ作るか、章構成、SoT 階層の取り扱い)

### skill 起動時の挙動

skill の Phase 1 interview は `DEV_LEARNING_SITE.md` の決定で skip。
未決の項目があれば対話で確認、決定後は `DEV_LEARNING_SITE.md` に追記して永続化する。

### skill 本体の編集方針

`.claude/skills/vitepress-learning-site/` 配下のファイル (yuichkun 由来) は
**OrbitScore 文脈の都合で編集して構わない** (作者承諾済)。
編集が発生したら以下を更新:
- WORK_LOG.md に変更内容と理由
- 当該ファイルの change 注釈 (差分 origin が分かる程度)

---

## 🚨 Git Workflow 絶対禁止事項

- ❌ **mainブランチへの直接コミット**
- ❌ ISSUE番号のないブランチ名

**ワークフロー**: GitHub Flow（main + feature branches）を採用。
feature ブランチから main への PR でマージする。

### コミット戦略

- **Conventional Commits** 形式を採用（`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`）
- **小さいコミットを積み重ねる**: 1つの論理的変更ごとに1コミット
- 大きな変更は複数の小さなコミットに分割する
- 各コミットは単独でビルド・テストが通る状態を維持する

---

## Commit・PR・ISSUE言語ルール

### 🚨 絶対に守るべき言語ルール

#### コミットメッセージ

- ✅ **タイトル（1行目）**: 必ず英語 (Conventional Commits)
- ✅ **本文（2行目以降）**: 必ず日本語

#### PR（Pull Request）

- ✅ **タイトル**: 英語
- ✅ **本文**: 日本語

#### ISSUE

- ✅ **タイトル**: 英語
- ✅ **本文**: 日本語

### Conventional Commits形式

**フォーマット**:
```
<type>(<scope>): <subject>  ← 英語

<body>  ← 日本語

<footer>
```

**タイプ**:
- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメントのみの変更
- `refactor`: リファクタリング
- `test`: テスト追加・修正
- `chore`: ビルドプロセスやツールの変更

### 正しい例

```bash
git commit -m "$(cat <<'EOF'
feat(dsl): add polymeter support

ポリメーター機能を実装

## 変更内容
- 異なる拍子のパターンを同時再生
- テンポ独立制御
- SuperColliderとの統合

Closes #123
EOF
)"
```

### 間違った例（絶対にやってはいけない）

```bash
# ❌ NG: 本文が英語
feat(dsl): add polymeter support

- Add polymeter pattern support  ← 英語はダメ！
- Support different time signatures  ← 英語はダメ！
```

```bash
# ❌ NG: タイトルが日本語
ポリメーター機能の実装  ← タイトルは英語で！

異なる拍子のパターンを同時再生できるようにしました。
```

---

## Additional Resources

すべての詳細ルールとドキュメントは以下を参照：
- **📚 [`docs/INDEX.md`](docs/INDEX.md)** - ドキュメント目次（必読）
- **🎵 [`docs/INSTRUCTION_ORBITSCORE_DSL.md`](docs/INSTRUCTION_ORBITSCORE_DSL.md)** - DSL仕様（単一信頼情報源）
- **📏 [`docs/PROJECT_RULES.md`](docs/PROJECT_RULES.md)** - 開発ルール（包括的ガイドライン）
- **📝 [`docs/WORK_LOG.md`](docs/WORK_LOG.md)** - 開発履歴（技術的決定事項）
- **🗺️ [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)** - ロードマップとフェーズ
- **📖 [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md)** - ユーザー向けドキュメント
- **📚 [`docs/CONTEXT7_GUIDE.md`](docs/CONTEXT7_GUIDE.md)** - 外部ライブラリドキュメント参照ガイド
- **🪝 [`.claude/hooks/README.md`](.claude/hooks/README.md)** - Hooksの説明
