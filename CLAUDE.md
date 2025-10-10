# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 🗣️ コミュニケーションルール

### 言語ポリシー

**ユーザーとAIのコミュニケーション:**
- ✅ ユーザーは**英語でも日本語でも**指示を出せる
- ✅ AIは**常に日本語で**返答する（UTF-8エンコーディング）
- ✅ ユーザーの英語が長文の場合、文法チェックと改善例を提供する

**Issue/Commit/PR:**
- ✅ **Issue**: タイトル・本文ともに**日本語**で記述
- ✅ **Commit**: タイトル・本文ともに**日本語**で記述（type prefixのみ英語）
  - 例: `feat: オーディオ録音機能を追加`
  - 例: `refactor: コード品質向上とテストファイル追加`
- ✅ **PR**: タイトル・本文ともに**日本語**で記述
  - 例: `feat: オーディオ録音機能を追加`
  - 本文に必ず `Closes #<issue-number>` を含める
- ❌ **ブランチ名のみ英語**（ツール互換性のため）
  - 例: `61-audio-playback-testing`

**理由:**
- プロジェクトは日本語話者向け
- コミット履歴・Issue履歴を日本語で統一
- 論文・ドキュメントでの引用が容易

**詳細:** `docs/PROJECT_RULES.md` Section 2, Commit Message Format

---

## 📚 Documentation Reference

**プロジェクトの詳細情報はすべて `./docs/` 配下にあります。**

- **ドキュメントインデックス**: `docs/INDEX.md` - すべてのドキュメントの目次
- **DSL仕様（重要）**: `docs/INSTRUCTION_ORBITSCORE_DSL.md` - 単一信頼情報源
- **プロジェクトルール**: `docs/PROJECT_RULES.md` - 開発ルールと規約
- **開発履歴**: `docs/WORK_LOG.md` - 完全な開発履歴
- **実装計画**: `docs/IMPLEMENTATION_PLAN.md` - 技術ロードマップ
- **ユーザーマニュアル**: `docs/USER_MANUAL.md` - ユーザー向け機能説明

**アーキテクチャ、DSL構文、トラブルシューティングなどの詳細は `docs/INDEX.md` を参照してください。**

---

## ⚠️ COMPACTING CONVERSATION後の必須手順

> **Compacting conversation直後は、以下を必ず実行してください**

```bash
# 1. Onboarding確認
mcp__serena__check_onboarding_performed

# 2. Serenaメモリを使って現在の状況を確認
#    list_memoriesで利用可能なメモリを確認し、
#    必要に応じてread_memoryで読み込む

# 3. Git状態確認
git branch --show-current
git log -1 --oneline

# 4. Issue番号確認
# ブランチ名からIssue番号を抽出（例: 61-audio-playback-testing → Issue #61）
```

**この手順をスキップすると、重要な約束事を忘れたまま実装を進めてしまいます。**

---

## 🔴 CRITICAL: 実装前の必須ワークフロー

> **一行でもコードを書く前に、以下の手順を完了すること**

### 正しい手順（絶対に守る）

```
1. Issue作成（gh issue create）
2. ブランチ作成（git checkout -b <issue-number>-description）
3. 実装開始（Edit/Writeツール使用OK）
4. テスト実行
5. WORK_LOG.md更新
6. コミット
7. PR作成（Closes #N）
```

### ❌ 絶対にやってはいけないこと

- `main`ブランチで実装を開始する
- `develop`ブランチで実装を開始する
- Issueを作成せずに実装を開始する
- ブランチを作成せずに実装を開始する
- Issue番号のないブランチ名を使用する
- **WORK_LOG.mdを更新せずにコミットする**

## 実装開始前の必須チェック

**Edit/Writeツールを使う前に必ず確認:**

1. ✅ Issue作成済み？
2. ✅ ブランチ作成済み？
3. ✅ 現在のブランチは`main`/`develop`ではない？
4. ✅ ブランチ名にIssue番号が含まれている？

**一つでもNoがあれば、実装を開始してはいけない。**

---

## セッション開始時の必須アクション

1. **Serenaプロジェクトをアクティベート**
   ```
   mcp__serena__check_onboarding_performed
   ```

2. **必須ドキュメントを読み込む**
   - `CLAUDE.md`（このファイル）
   - `docs/PROJECT_RULES.md`
   - `docs/INDEX.md`（ドキュメント構造の理解）

3. **Serenaを使ってプロジェクト知識を確認**
   ```
   mcp__serena__list_memories
   ```
   - 必要な知識を`read_memory`で読み込む

4. **現在のブランチを確認**
   ```bash
   git branch --show-current
   ```
   - `main`/`develop`にいる場合は、作業開始前に機能ブランチを作成

---

## Project Overview

**OrbitScore** is an audio-based live coding DSL for modern music production.

**Key Features**:
- Audio File Playback (WAV, AIFF, MP3, MP4) with time-stretching and pitch-shifting
- Live Coding Integration via VS Code extension
- SuperCollider Backend (0-2ms ultra-low latency)
- Polymeter Support (independent time signatures per sequence)

**Technology Stack**: TypeScript, SuperCollider (scsynth), supercolliderjs, VS Code Extension API, Vitest

**Current Status**:
- DSL Version: v3.0 (完全実装済み)
- Test Status: 225 passed, 23 skipped (248 total) = 90.7%
- Main Branch: `main`
- Development Branch: `develop`

**詳細なアーキテクチャ、DSL構文、実装計画は `docs/INDEX.md` を参照してください。**

---

## Common Development Commands

### Building and Testing

```bash
# Build all packages
npm run build

# Run all tests (225 tests, 23 skipped)
npm test

# Run engine in development mode
npm run dev:engine

# Linting and formatting
npm run lint
npm run lint:fix
npm run format
```

### Package-Specific Commands

```bash
# Engine package
cd packages/engine
npm test                    # Run engine tests
npm run build               # Build engine
npm run dev                 # Development mode with watch

# VS Code extension
cd packages/vscode-extension
npm install
npm run build
# Install: Cmd+Shift+P → "Developer: Install Extension from Location..."
```

### Running Individual Tests

```bash
# Run specific test file
npx vitest run tests/parser/syntax-updates.spec.ts

# Run tests matching pattern
npx vitest run -t "Audio Control"

# Watch mode for development
npx vitest watch tests/core/
```

---

## ドキュメント参照の優先順位

**ライブラリ・技術情報が必要な場合、必ず以下の順序で調査する：**

1. ✅ **Context7を最初に試す**
   ```
   mcp__context7__resolve-library-id("library-name")
   mcp__context7__get-library-docs("/org/project", topic="...")
   ```
   - コード例が豊富
   - 信頼性の高いスニペット
   - オフライン参照可能

2. ✅ **Context7で不足している場合のみWebFetch**
   ```
   WebFetch(url="...", prompt="...")
   ```
   - 最新の仕様情報
   - 詳細な設定ドキュメント
   - Context7にない情報

**理由**：
- Context7はコード例とベストプラクティスが充実
- オフラインでも利用可能
- WebFetchは最新情報が必要な場合の補完手段

**例外**：
- プロジェクト固有のドキュメント（このプロジェクトのdocs/）はReadツールで直接参照

---

## Git Workflow

### ブランチ命名規則

- **形式**: `<issue-number>-<descriptive-name>`
- **英語のみ**（日本語禁止）
- **例**:
  - ✅ `61-audio-playback-testing`
  - ✅ `55-improve-type-safety-process-statement`
  - ❌ `feature/type-safety`（Issue番号なし）
  - ❌ `55-型安全性向上`（日本語使用）

### ブランチ作成

```bash
# Create branch from develop
git checkout develop
git pull origin develop
git checkout -b <issue-number>-descriptive-name

# Example
git checkout -b 61-audio-playback-testing
```

### PR作成

- **必ず`Closes #<issue-number>`を含める**
- **`develop`ブランチ向けに作成**
- **タイトル・本文は日本語で記述**
- **例**:
  ```bash
  gh pr create --base develop --title "feat: オーディオ録音機能を追加" --body "Closes #61

  ## 概要
  ライブパフォーマンスでの録音忘れ防止のため、自動録音機能を実装。

  ## 変更内容
  - global.start()で録音開始
  - global.stop()で録音停止・ファイル保存
  "
  ```

### マージポリシー

- **マージ方法**: Squash merge
- **ブランチ削除**: マージ後も削除しない（履歴保持のため）
- **例**:
  ```bash
  gh pr merge <number> --squash
  # ブランチは削除しない
  ```

---

## WORK_LOG.md更新ルール

**Every commit MUST be documented in WORK_LOG.md.**

コミット前に `docs/WORK_LOG.md` を更新：
- 何が変わったか
- なぜ変わったか
- 技術的な決定事項
- コミットハッシュ（最初は `[PENDING]`、後で実際のハッシュに更新）

プロジェクトの状態が変わった場合は `README.md` も更新。

**詳細は `docs/PROJECT_RULES.md` Section 1を参照。**

---

## DSL仕様ルール

**`docs/INSTRUCTION_ORBITSCORE_DSL.md` is the single source of truth.**

機能実装前に：
1. 仕様書に存在することを確認
2. パラメータの順序、型、動作を確認
3. 不明な場合はユーザーに確認

**禁止事項**: ユーザー確認なしに仕様にない機能を追加すること

---

## Hooks

### PreToolUse Hooks

- `Edit|Write` → `main`/`develop`ブランチでの編集をブロック
- `Bash:git commit.*` → Serenaメモリの単独コミットをブロック
- `Bash:git checkout -b.*` → ブランチ命名規則をリマインド

### SessionStart Hook

- セッション開始時に必須アクションをリマインド
- Compacting conversation後の文脈回復を自動化

**詳細**: `.claude/hooks/README.md`

---

## Test-Driven Development

- 新機能には必ずテストを書く
- コミット前にすべてのテストがパスすること
- CI環境: 225 tests pass, 23 skipped (SuperCollider integration tests)

**テスト戦略**:
- **Unit tests**: Parser, timing, audio slicer (自動化、CI互換)
- **Integration tests**: SuperCollider tests (ローカルのみ、CIではスキップ)
- **Manual tests**: Audio playback verification (人間によるリスニングが必要)

---

## 重要なリマインダー

**実装を開始する前に、必ずこのファイルの「実装開始前の必須チェック」を確認してください。**

ワークフロー違反は、ブランチ管理の崩壊、Issue追跡の喪失、PRとIssueの紐付け失敗につながります。

---

## Additional Resources

すべての詳細ルールとドキュメントは以下を参照：
- **📚 `docs/INDEX.md`** - ドキュメント目次（必読）
- **🎵 `docs/INSTRUCTION_ORBITSCORE_DSL.md`** - DSL仕様（単一信頼情報源）
- **📏 `docs/PROJECT_RULES.md`** - 開発ルール（包括的ガイドライン）
- **📝 `docs/WORK_LOG.md`** - 開発履歴（技術的決定事項）
- **🗺️ `docs/IMPLEMENTATION_PLAN.md`** - ロードマップとフェーズ
- **📖 `docs/USER_MANUAL.md`** - ユーザー向けドキュメント
- **🪝 `.claude/hooks/README.md`** - Hooksの説明
