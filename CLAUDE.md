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

   🔴 **fixer は ラウンド1から Fable を使う**（owner 確定 2026-07-30）。**Codex を fixer に
   使わない。** 難所の実装では安い fixer だとラウンドが積み重なり、**上限の3ラウンドを
   超えても収束しない現象**が実測された。**回数を減らす方が総コストが低い** — 次項が言う
   「fix の欠陥発見が1ラウンド遅延する」構造を短くする唯一の手段が、fix 自体の質である。
   なお**実装は Codex のまま**（変わるのは fixer だけ）。
4. **fixer の差分は、ラウンドを閉じる前に再点検する**（1レビュアーで可）。問いは2つだけ:
   「**この修正が導入する新しい故障モードは何か**」「**新コードはどの実行コンテキストで走るか**」。
   現行フローは fix の欠陥発見が常に次ラウンドまで1ラウンド遅延する構造で、これが振動の増幅器。
5. **ラウンド2以降は provenance で縮小する。** 各指摘を **{original-diff 起因 / fix 起因}** に
   分類し、**original-diff 起因の新規指摘が0になったら元差分のレビューは収束**とみなして、
   **fix-scoped 縮小レビュー**（fix 差分のみ・1レビュアー + 変異実行）へ切り替える。
   **フルラウンドの上限は3。** 超えたら Sonnet を回し続けず **Fable を裁定者として投入**する。
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

### 🔴 テストの積み上げ規律（必須・owner 指示 2026-07-27）

> いくら作ってもテストが意味をなしてないと先に進めないので、テストの積み上げだけはしっかりしてください。

**「通るテスト」は根拠にならない。** 壊れた実装に対しても通るテストが積み上がると、その上に
建てたものを何も信用できなくなる。

1. **新規テストは変異検証する** — 守る対象を壊して **red になることを確認**し、restore して green も
   確認する。実出力を報告に含める。**変異で落ちなかったテストは設計をやり直す**
2. **テスト件数は PR ごとに増やす**

#### 変異は「壊し方の種類」を変えて複数試す（#527 ラウンド2 の教訓・2026-07-27）

1種類の変異が red になっただけで「意味のあるテスト」と結論しない。#527 では
「ガードを無効化する」変異は殺せたのに、**別種の変異3つが全件 green のまま生き残った**:

| 生き残った変異 | 見逃した原因 |
|---|---|
| 同じ副作用を **2回** 呼ぶ | `toHaveBeenCalled()` が回数を見ていない |
| ループの `continue` を削除（余分な行が別経路へ流れる） | 同上（引数も見ていない） |
| 副作用の順序を**完全に逆転** | 個別 mock のアサーションのみで順序を見ていない |

最低限、以下の4種を試すこと: **(a) 分岐を反転** / **(b) 呼び出し回数を変える**
（0回・2回）/ **(c) 順序を入れ替える** / **(d) 引数を別の値に差し替える**。

対応するアサーションの原則:
- `toHaveBeenCalled()` ではなく **`toHaveBeenCalledTimes(n)`** を使う。FIFO キューを消費する
  副作用（`DeviceSwitchBridge.handleLine` 等）では回数がそのまま正しさである
- **引数まで検証する** — 複数経路から同じ関数が呼ばれるテストでは、呼ばれた事実だけでは
  経路の取り違えを検出できない
- 順序が意味を持つなら **`mock.invocationCallOrder`** で順序を固定する

#### 配線（wiring）はロジックと別にテストする

純関数へ抽出してユニットテストを付けても、**その純関数と本物の副作用を繋ぎ直す配線**は
別物であり、抽出しただけでは無防備なまま残る。特に **`() => void` 型の兄弟コールバックは
取り違えても型チェックを通る**（#527 で `setPlayingStatus` / `setReadyStatus` の入れ替えが
ユニット・E2E とも全件 green だった）。

- 可能なら **型で潰す** — 同一シグネチャの兄弟を1本の引数付き関数に畳めば
  （例: `setPlayingStatus`/`setReadyStatus` → `setTransportStatus(state)`）取り違えは
  **表現できなくなる**。これが最も安いので最初に検討する
- 畳めない配線は **`vscode` モックを介して実際に叩き、観測可能な副作用を検証する**
  （`tests/vscode-extension/` に配置）

### 🔴🔴 E2E が最重要（owner 強調 2026-07-27）

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
```

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
