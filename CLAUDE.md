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
- **User Manual**: [`docs/core/USER_MANUAL.md`](docs/core/USER_MANUAL.md) - ユーザー向け機能説明
- **Context7 Guide**: [`docs/core/CONTEXT7_GUIDE.md`](docs/core/CONTEXT7_GUIDE.md) - 外部ライブラリドキュメント参照ガイド
- **Testing Guide**: [`docs/testing/TESTING_GUIDE.md`](docs/testing/TESTING_GUIDE.md) - テスト手順とガイド

**Documentation Rules**:
1. All documentation in `/docs` must be written in Japanese
2. When updating project design or specifications, update `/docs` files accordingly
3. CLAUDE.md should remain concise and reference `/docs` for details

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
- Test Status: 220 passed, 23 skipped (243 total) = 90.5%
- Branch Strategy: GitHub Flow (`main` + feature branches)

### Development Commands
```bash
npm run build            # Build all packages (incremental)
npm run build:clean      # Clean build (rebuild all files)
npm test                 # Run all tests (220 tests, 23 skipped)
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

## Git Workflow Summary

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
