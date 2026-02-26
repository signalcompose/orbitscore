# OrbitScore Project Rules

## 🔴 CRITICAL RULES - MUST FOLLOW

### 1. WORK_LOG.md Updates (最重要)

**EVERY commit MUST be documented in WORK_LOG.md**

- Update WORK_LOG.md BEFORE committing
- Document what was changed, why, and the commit hash
- Keep chronological order
- Include technical decisions and challenges
- **MUST update README.md when WORK_LOG.md is updated** to keep project status current

### 1a. WORK_LOG.md Archiving (アーカイブ管理)

**When WORK_LOG.md exceeds ~2,000 lines or ~100KB, archive older sections:**

- **Keep recent work** (latest 15-20 sections) in main `docs/WORK_LOG.md`
- **Archive older sections** to `docs/archive/WORK_LOG_YYYY-MM.md` by month
  - Example: `docs/archive/WORK_LOG_2025-09.md` for September 2025 work
- **Add reference link** at the end of main WORK_LOG.md pointing to archived files
- **Add header to archived file** with:
  - Archive period (start date - end date)
  - Link back to main WORK_LOG.md
  - Clear indication this is an archived version

**Purpose:**
- Maintain readability of main WORK_LOG.md
- Preserve complete development history for academic papers
- Keep technical information accessible but organized
- Reduce file size for better editor performance

**Archive File Header Format:**
```markdown
# OrbitScore Development Work Log - [Month] [Year] Archive

**Archive Period**: [Start Date] - [End Date]
**Note**: This is an archived version of the work log. For recent work, see [../WORK_LOG.md](../WORK_LOG.md)

---
```

### 2. English Instruction Verification (英文チェック)

**When the user provides instructions in English:**

- **Respond in Japanese using UTF-8 encoding**
- Provide "Suggested English" to improve the user's English writing skills
- Check if the English is grammatically correct
- If incorrect, provide the corrected version
- Suggest rephrasing for clarity
- Example response: "I believe you meant: '[corrected sentence]'. Would you like me to proceed with this understanding?"
- Help the user improve their English communication skills
- Always be respectful and supportive when making corrections
- **Purpose: To enhance the user's English writing ability through continuous feedback**

### 3. Specification Adherence (仕様遵守)

**MUST verify with specification before implementation:**

- **Primary specification**: `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- **Required verification for undefined items**:
  - Default values for parameters
  - Error handling methods
  - Value ranges and constraints
  - Method chaining possibilities
- **PROHIBITED**: Adding features not in specification without confirmation
  - Example violations: `config()` method, `offset()` method
- **When specification is unclear**: MUST ask user for clarification
- **When implementation is blocked or encountering errors**: MUST check official documentation first
  - Check library/framework documentation (e.g., SuperCollider docs, supercolliderjs docs)
  - Search for similar issues or examples
  - Verify API usage and parameter formats
  - Only ask user after exhausting documentation resources

**DSL Code Writing (DSLコード記述時の必須ルール):**

- **BEFORE writing any `.osc` file or DSL code**: MUST read the relevant section in `docs/INSTRUCTION_ORBITSCORE_DSL.md`
- **NEVER guess DSL syntax**: Always verify with specification first
- **When creating examples or patterns**:
  1. Check `examples/` directory for similar patterns
  2. Read DSL specification for the methods you intend to use
  3. Verify parameter order, types, and expected values
  4. Understand what each method does (e.g., `beat()` sets time signature, NOT rhythm pattern)
- **Common mistakes to avoid**:
  - `beat()` is for time signature and **MUST use "n by m" notation** (e.g., `beat(4 by 4)` = 4/4)
  - **NEVER use single argument** like `beat(4)` - this will cause an error
  - This notation is essential for polymeter support where different time signatures create independent bar lengths
  - Rhythm patterns are defined in `play()` (e.g., `play(1, 0, 0, 0)`)
  - Don't invent new syntax or methods without checking specification
- **Purpose**: Prevent syntax errors, save time, and maintain consistency with specification

### 4. Documentation First

- Update relevant docs (README, IMPLEMENTATION_PLAN, etc.) with each change
- Documentation is as important as code
- Keep specifications in sync with implementation

### 5. Test-Driven Development

- Write tests for new features
- Ensure all tests pass before committing
- Golden files for regression testing

**Testing Strategy:**

1. **Automated Unit Tests** (CI環境で実行)
   - パーサー、タイミング計算、オーディオスライサー等
   - 高速実行、自動化可能
   - リグレッション検出に有効

2. **SuperCollider Integration Tests** (ローカル環境のみ)
   - SuperColliderサーバー起動が必要
   - CI環境ではスキップ (`describe.skipIf(process.env.CI === 'true')`)
   - 数値計算ロジックは他のテストでカバー
   - 例: `tests/audio/supercollider-gain-pan.spec.ts`

3. **Audio Playback Tests** (将来実装予定)
   - リファクタリング完了後に実装
   - 実際に音を鳴らして期待通りの音が出ているか確認
   - 音色、タイミング精度、エフェクト効果等をテスト
   - 人間の耳による確認が必要

**Note**: SuperCollider関連テストはCI環境で複雑なセットアップが必要（Xvfb、ダミーオーディオドライバ等）のため、ローカル環境での手動確認を推奨。

### 6. Tutorial and Example File Management

**チュートリアルファイルの参照を必須とする:**

- **新しい`.osc`テストファイルを作成する前に、必ず既存のチュートリアルファイル（`examples/01_*.osc` - `examples/08_*.osc`）を確認すること**
- チュートリアルファイルに正しい構文例が記載されているため、それを参考にすること
- 特に以下を確認：
  - `var global = init GLOBAL` の初期化（`global`ではなく`GLOBAL`）
  - `.audio()` メソッド（`sample()`ではない）
- `global.start()` の呼び出しタイミング
  - メソッドチェーンの正しい使い方
- **目的**: 構文エラーや混乱を防ぎ、お互いの時間を節約する

### 7. User Confirmation Required (ユーザー確認必須)

**CRITICAL: NEVER proceed with actions without explicit user confirmation**

- **When asking "〜しますか？" (Shall I do X?), ALWAYS wait for user's response**
- **NEVER execute the action immediately after asking**
- Examples of actions requiring confirmation:
  - Creating a PR
  - Merging a PR
  - Deleting branches
  - Pushing to remote
  - Making significant changes
  - Running destructive operations
- **Only proceed after receiving explicit "yes", "go ahead", "お願いします" or similar confirmation**
- If no response, ask again or wait
- **Purpose**: Respect user's decision-making and avoid unwanted actions

### 8. Tool Confirmation Policy (ツール確認ポリシー)

**読み取り専用ツール（確認不要 - Read-only tools, no confirmation needed）:**

- **Serena系すべて** - `find_symbol`, `find_referencing_symbols`, `search_for_pattern`, `get_symbols_overview`, `list_dir`, `find_file`, `read_memory`, `list_memories`
- **ファイル読み取り** - `Read`, `Grep`, `Glob`, `LS`, `SemanticSearch`
- **外部ドキュメント** - `Context7` (resolve-library-id, get-library-docs)
- **Git情報取得** - `git status`, `git log`, `git diff` (読み取り専用)

**書き込み・実行系ツール（確認必要 - Write/Execute tools, confirmation required）:**

- **コード編集** - `StrReplace`, `MultiStrReplace`, `Write`, `Delete`
- **Serena編集** - `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `write_memory`, `delete_memory`
- **Shell実行** - 特に破壊的操作 (rm, git push, npm publish など)
- **Git操作** - `git commit`, `git push`, `gh pr create`

**⚠️ 禁止事項（AIエージェントは実行してはいけない）:**

- **PRのマージ** - `gh pr merge` は原則として実行しない
  - ユーザーが「all check passed」を確認してからマージします
  - AIエージェントはマージの準備（PR作成、レビュー対応）までを行い、マージ実行はユーザーに委ねます
  - 理由: テスト結果、ビルド結果、BugBotのコメントなど、最終的な品質確認はユーザーが行うべき
  - **例外**: ユーザーが明示的に「マージしてください」「マージをお願いします」と依頼した場合は実行可能
- **ブランチの削除** - `git branch -d` や `gh pr merge --delete-branch` は原則として実行しない
  - ブランチは履歴追跡のため保持します
  - **例外**: ユーザーが明示的に「ブランチを削除してください」と依頼した場合は実行可能

**理由:**

- 読み取り専用ツールはプロジェクトに変更を加えないため、確認なしで実行しても安全
- 書き込み・実行系ツールは意図しない変更を防ぐため、確認が必要
- 作業効率と安全性のバランスを取る
- **品質保証**: マージは最終的な品質確認を経てから実行されるべき

**注意:** MCPツールの確認設定はCursor/エディタ側で管理されるため、このポリシーはAIエージェントとユーザー間の共通理解として機能する

## 📋 Development Workflow

### Multi-Model Development Workflow (推奨)

**役割分担による効率的な開発サイクル:**

```
┌─────────────────────────────────────────────────────────┐
│ Phase X-Y リファクタリング/実装サイクル                      │
└─────────────────────────────────────────────────────────┘

1. 【実装担当: Auto (Sonnet 3.5)】
   - Issue/ブランチ作成
   - Serenaメモリ更新（進行中ステータス）
   - コード実装
   - テスト実行
   - コミット
   - PR作成（`Closes #<issue-number>`）
   
   ⚠️ 問題発生時（ループ/ハルシネーション/行き詰まり）
   ↓ エスカレーション（ユーザー判断）
   
   【問題解決: Claude 4.5 Sonnet】
   - 問題の分析と診断
   - 解決策の提案と実装
   - Autoに戻すための明確な指示を残す
   - Serenaメモリに解決策を記録
   
   ↓ 解決後、Autoに戻る（ユーザー判断）
   
   【実装再開: Auto (Sonnet 3.5)】
   - 4.5の指示とSerenaメモリを参照
   - 実装を継続
   ↓

🔄 **【モデル切り替え依頼: Auto (Sonnet 3.5)】**
   - 実装完了後、ユーザーに以下を依頼:
     "実装が完了しました。評価・修正のためにClaude 4.5 Sonnetに切り替えてください。"
   - ユーザーがCursorでモデルを4.5 Sonnetに切り替え
   ↓

2. 【評価・修正: Claude 4.5 Sonnet】
   - コーディング規約チェック
   - 設計パターン検証
   - テスト結果確認
   - リンターエラー修正
   - 必要に応じて追加修正
   - コミット（修正があった場合）
   ↓

3. 【レビュー: BugBot（自動）】
   - PR上で自動レビュー実行
   ↓

4. 【レビュー受け渡し: ユーザー】
   - BugBotのコメントを確認
   - 必要に応じて以下のコマンドで取得:
     gh pr view <PR番号> --comments
   - レビュー内容を4.5 Sonnetに伝える
   ↓

5. 【レビュー対応: Claude 4.5 Sonnet】
   - BugBotの指摘に対応
   - 修正実装
   - テスト実行
   - コミット
   ↓

6. 【マージ: ユーザー】
   - "all check passed"を確認
   - マージ実行（squash）
   ↓

7. 【次フェーズ準備: Claude 4.5 Sonnet】
   - Serenaメモリ更新（完了ステータス）
   - 次のPhaseの準備
   - セッション終了報告
```

**利点:**
- ✅ **コスト効率**: 実装はSonnet 3.5、評価・レビュー対応はSonnet 4.5で最適化
- ✅ **品質保証**: 複数段階のチェック（評価 → BugBot → レビュー対応）
- ✅ **明確な役割分担**: 各ステップで責任が明確
- ✅ **自動化**: BugBotが自動レビュー、Issueも自動クローズ
- ✅ **エスカレーション**: 問題発生時に4.5 Sonnetが介入して解決

**🔄 正常完了時のモデル切り替え依頼（Auto → 4.5 Sonnet）:**

**Autoが実装を完了した場合、必ずユーザーに以下を依頼:**

```
✅ 実装が完了しました。

次のステップ: 評価・修正のためにClaude 4.5 Sonnetに切り替えてください。

【完了した作業】
- Issue作成・ブランチ作成
- コード実装
- テスト実行（115 passed, 15 skipped）
- コミット・PR作成

【4.5 Sonnetで実行する作業】
- コーディング規約チェック
- 設計パターン検証
- リンターエラー修正
- 必要に応じて追加修正

Cursorでモデルを4.5 Sonnetに切り替えてから、評価・修正を開始してください。
```

**🚨 エスカレーション判断基準（Auto → 4.5 Sonnet）:**

**Autoが以下の状況を検出した場合、ユーザーに報告すべき:**

1. **ループ検出**
   - 同じエラーが3回以上繰り返される
   - 同じ修正を何度も試している
   - 進捗がないまま10回以上のツール呼び出し

2. **ハルシネーション**
   - 存在しないAPI/メソッドを使おうとする
   - ドキュメントにない機能を実装しようとする
   - Context7やSerenaで確認できない情報を使用

3. **行き詰まり**
   - テストが通らず原因が特定できない
   - 複雑な設計判断が必要
   - 複数の解決策があり選択が困難

4. **仕様不明確**
   - DSL仕様（`INSTRUCTION_ORBITSCORE_DSL.md`）に記載がない
   - 設計パターンの選択が必要
   - アーキテクチャレベルの判断が必要

**エスカレーション時のAuto報告フォーマット:**
```
⚠️ エスカレーション推奨

【問題】: [問題の簡潔な説明]
【試行回数】: X回
【試したこと】:
- 試行1: [内容] → [結果]
- 試行2: [内容] → [結果]
【現在の状態】: [コードの状態、エラー内容]
【判断が必要な点】: [何を決める必要があるか]

4.5 Sonnetへのエスカレーションを推奨します。
```

**4.5 Sonnet解決後のハンドオフ:**

**評価・修正完了後:**
- Serenaメモリに評価結果を記録（`refactoring_plan`を更新）
- 修正内容をコミット（修正があった場合）
- ユーザーに「評価・修正完了」を報告
- 次のPhaseの準備またはPRマージの準備

**エスカレーション解決後:**
- Serenaメモリに解決策を記録（`current_issues`または新規メモリ）
- 明確な次のステップを文書化
- Autoが参照できる形で指示を残す
- ユーザーに「Auto (Sonnet 3.5)に戻してください」を依頼

**補助ツール（オプション）:**
```bash
# BugBotレビュー取得を簡単にするエイリアス
alias review-get='gh pr view --comments | grep -A 100 "bugbot"'
```

### Traditional Workflow (For Each Phase):

1. Review IMPLEMENTATION_PLAN.md
2. Create todo list
3. Implement features
4. Write/update tests
5. **Update WORK_LOG.md** (before committing, use `[PENDING]` for commit hash)
6. **Update README.md** (sync with WORK_LOG.md status)
7. Update other documentation
8. **Serenaを使って重要な変更を保存** (必要に応じて)
9. **Update USER_MANUAL.md** (if user-facing changes)
10. **Commit all changes including docs**
11. **Get the commit hash** (`git rev-parse --short HEAD`) - this is the "実コミット"
12. **Update WORK_LOG.md with the first commit hash** (replace `[PENDING]` with the hash from step 11)
13. **Amend the commit** (`git add docs/WORK_LOG.md && git commit --amend --no-edit`)

**Important**: 
- Record the **first commit hash** (from step 11) in WORK_LOG.md, not the final amended hash
- This hash represents the "actual commit" with all changes
- The amend only adds the commit hash reference to WORK_LOG.md
- This avoids infinite loop of updating hashes

**Note**: With Git Workflow (feature branches + PRs), we commit everything together before pushing, then create PR for review.

### Git Workflow and Branch Protection:

**CRITICAL: Always create a feature branch before starting work**

**Branch Structure (GitHub Flow):**
- `main` - Production-ready code (protected, base for PRs)
- `<issue-number>-description` - Feature/fix/refactor branches

**Branch Protection Rules (main):**
- ✅ Pull Request required before merging
- ✅ At least 1 approval required
- ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Administrators cannot bypass these settings
- ✅ Status checks must pass before merging (if configured)

**Creating a new feature branch:**
```bash
# Create and switch to new feature branch from main
git checkout main
git pull origin main
git checkout -b <issue-number>-descriptive-name

# Example branch names:
# - 78-migrate-github-flow
# - 55-improve-type-safety
# - 61-audio-playback-testing
```

**Development Workflow (GitHub Flow):**
```
1. Create feature branch from main
2. Implement changes
3. Commit and push to origin
4. Create PR to main
5. Request review (Claude Code Review provides feedback)
6. Address review comments
7. Merge to main after approval
```

**Creating PRs:**
```bash
# Push branch to GitHub
git push -u origin feature/branch-name

# Create PR to main (with automatic Issue closing)
gh pr create --base main --title "feat: description" --body "Closes #<issue-number>

detailed description"
```

**Automatic Issue Closing:**
- **ALWAYS include `Closes #<issue-number>` in PR body** to automatically close the related Issue when PR is merged
- Keywords that work: `Closes`, `Fixes`, `Resolves` (case-insensitive)
- Example: `Closes #14` will automatically close Issue #14 when PR is merged
- **Benefits**:
  - ✅ Never forget to close Issues
  - ✅ Clear connection between PR and Issue
  - ✅ Automatic workflow (GitHub handles it)
- **Workflow**: Issue → Branch → PR (with `Closes #N`) → Merge → Issue auto-closes

**Merging PRs:**
```bash
# Merge with squash (DO NOT delete branch)
gh pr merge <number> --squash

# ❌ NEVER use --delete-branch flag
# ✅ Keep branches for historical reference
```

**Important:**
- **ALWAYS create a branch before starting work** - never commit directly to main
- **ALWAYS create PR to main** - GitHub Flow workflow
- **Branch names MUST be in English only** - no Japanese characters (日本語禁止)
  - ✅ Good: `11-refactor-audio-slicer-phase-2-1`
  - ❌ Bad: `11-refactor-audio-slicertsをモジュール分割phase-2-1`
  - Reason: Japanese characters in branch names can cause issues with some tools and environments
- **Branches are kept for history** - do not delete after merge
- **Cursor BugBot** automatically provides change summaries on PRs (not actual code reviews)
- User typically handles merging, but agent may assist with complex implementations
- Always use `--squash` for clean commit history on main branch
- **Branch protection prevents accidental direct pushes** to main

### Commit Message Format:

**Language: Japanese (日本語)**

```
<type>: <日本語での説明>

<詳細な説明>

<何が変わったか>
<なぜ変わったか>
<影響>
```

Types: feat, fix, docs, test, refactor, chore

**Important**: 
- Commit messages MUST be written in Japanese
- Only the type prefix (feat, fix, etc.) remains in English
- This applies to both commit titles and detailed descriptions

### Progress Reporting

- ハンドオフメッセージやサマリーでは、開発進捗をフェーズ別にパーセンテージで明示する（例: “Phase 4: 70%”）。
- パーセンテージの分母は `docs/IMPLEMENTATION_PLAN.md` のマイルストーンに基づいて定義する。

## 🎯 Core Principles

### 1. Code Organization and Architecture

#### Single Responsibility Principle (SRP)
- **One Function, One Purpose**: Each function should do exactly one thing
- **Small Functions**: Aim for functions under 50 lines
- **Clear Names**: Function names should clearly describe their single purpose
- **Example**: `preparePlayback()` only prepares, `runSequence()` only executes

#### DRY (Don't Repeat Yourself)
- **Extract Common Logic**: If code appears in 2+ places, extract it to a shared function
- **Shared Utilities**: Create utility modules for reusable logic
- **Refactoring Trigger**: Duplicate code is a signal to refactor immediately

#### Module Organization
- **Group by Feature**: Organize related functions in feature directories
- **Clear Directory Structure**: Use descriptive directory names
  ```
  feature/
  ├── operation-a.ts
  ├── operation-b.ts
  └── shared-utility.ts
  ```
- **Example**:
  ```
  sequence/
  ├── playback/
  │   ├── prepare-playback.ts
  │   ├── run-sequence.ts
  │   └── loop-sequence.ts
  └── audio/
      └── prepare-slices.ts
  ```

#### Function Design
- **Pure Functions**: Prefer pure functions without side effects when possible
- **Explicit Dependencies**: Pass dependencies as parameters, not globals
- **Return Values**: Return results rather than mutating state when possible
- **Type Safety**: Use TypeScript interfaces for function options
  ```typescript
  export interface PreparePlaybackOptions {
    sequenceName: string
    audioFilePath?: string
    // ...
  }
  
  export async function preparePlayback(
    options: PreparePlaybackOptions
  ): Promise<PlaybackPreparation | null>
  ```

#### Reusability Guidelines
- **Descriptive Names**: Use names that describe what the function does, not where it's used
  - ✅ Good: `preparePlayback()`, `scheduleEvents()`
  - ❌ Bad: `helper1()`, `doStuff()`
- **Generic Parameters**: Use options objects for flexibility
- **Documentation**: Add JSDoc comments explaining purpose and usage
- **Export Public APIs**: Export functions that might be useful elsewhere

#### Class Design
- **Thin Controllers**: Keep class methods thin (under 30 lines), delegate to utility functions
- **Composition over Inheritance**: Prefer composing functionality from modules
- **Example**:
  ```typescript
  class Sequence {
    async run(): Promise<this> {
      const prepared = await preparePlayback({ /* options */ })
      if (!prepared) return this
      
      const result = runSequence({ /* options */ })
      this._isPlaying = result.isPlaying
      return this
    }
  }
  ```

#### Refactoring Triggers
When you see these patterns, **refactor immediately**:
1. **Duplicate Code**: Same logic in 2+ places → Extract to shared function
2. **Long Methods**: Methods over 50 lines → Break into smaller functions
3. **Multiple Responsibilities**: Function does many things → Split by responsibility
4. **Hard to Test**: Complex logic in class → Extract to pure function
5. **Hard to Reuse**: Logic tied to specific context → Generalize with parameters

### 2. Degree System Philosophy

- **0 = rest/silence** - Musical value, not just "no sound"
- 1-12 = chromatic scale (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)
- This is a defining feature of OrbitScore

### 3. Precision

- 小数第3位まで (3 decimal places)
- Random with seed for reproducibility

### 4. Contract-Based Design

- IR types are frozen contracts
- Breaking changes require new versions

## 📁 File Structure Rules

### Test Files:

- Location: `tests/<module>/<feature>.spec.ts`
- Naming: descriptive, ends with `.spec.ts`

### Source Files:

- Location: `packages/<package>/src/`
- Exports: Explicit, no default exports

### Documentation:

- WORK_LOG.md - Development history (UPDATE WITH EVERY COMMIT!)
- README.md - User guide
- IMPLEMENTATION_PLAN.md - Technical roadmap
- INSTRUCTIONS_NEW_DSL.md - Language specification
- PROJECT_RULES.md - This file

## 🚫 Things to Avoid

1. **NEVER** commit directly to main branch - always create a feature branch first
2. **NEVER** commit without updating WORK_LOG.md
3. **NEVER** change IR types without version consideration
4. **NEVER** skip tests for new features
5. **NEVER** use magic numbers - use constants
6. **NEVER** leave TODO comments without tracking
7. **NEVER** delete branches after merging (use `--squash` without `--delete-branch`)

## ✅ Checklist Before Committing

- [ ] Tests pass (`npm test`)
- [ ] WORK_LOG.md updated
- [ ] README.md updated (MUST reflect current status from WORK_LOG.md)
- [ ] Documentation updated if needed
- [ ] **Serenaを使って重要な変更を保存** (必要に応じて)
- [ ] Commit message is descriptive
- [ ] No console.log left in production code
- [ ] Types are properly defined

## 🔄 Continuous Practices

1. **Regular Testing**: Run tests frequently during development
2. **Incremental Commits**: Small, focused commits
3. **Documentation Sync**: Keep docs in sync with code
4. **Code Review**: Review your own code before committing

## 🔄 Session Continuity and Information Handoff

### 基本方針
Resume機能に依存せず、Serenaメモリとドキュメントで情報を引き継ぐ。

### 作業中の情報保存（AIエージェントの責務）

以下のタイミングで重要な情報をSerenaメモリに保存する：

1. **複雑なアーキテクチャを理解した時**
   - `serena-write_memory`で要約を保存
   - 例：パーサーの設計、オーディオエンジンの仕組み

2. **重要な設計決定をした時**
   - 理由と経緯を記録
   - 例：ライブラリ選定、実装アプローチの変更

3. **大きなタスクが完了した時**
   - 実装の詳細と注意点を保存
   - 例：新機能の実装完了、リファクタリング完了

4. **コミット時（必須）**
   - WORK_LOGに詳細を記録
   - Serenaを使って重要な決定事項や変更を保存

### セッション開始時（AIエージェントの責務）

1. **既存メモリの確認**
   - `serena-list_memories`で保存されている知識を確認
   - 関連するメモリがあれば`serena-read_memory`で読み込む

2. **最新状況の把握**
   - WORK_LOGの最新エントリを確認（必要に応じて）
   - 現在の実装フェーズを把握

3. **前回の作業内容の理解**
   - Serenaメモリから前回の知見を取得
   - 継続作業の場合は文脈を復元

### Resume機能の使用判断（ユーザー判断）

**基本方針：新規セッションを推奨**

- 独立したタスク → 新規セッション
- 時間が経過 → 新規セッション
- 異なるトピック → 新規セッション

**Resumeを使うべき例外的ケース：**

- 複雑な議論・設計決定の途中
- 大規模リファクタリングの段階的実施中
- デバッグの試行錯誤を継続する必要がある時

**理由：**

- Serenaメモリで構造化された知識として蓄積
- 新鮮な視点で問題を見られる
- トークン効率が良い
- 会話履歴の管理が不要

## 📝 Documentation Sync Rules

### WORK_LOG.md Structure

Each phase section should include:

- Overview with date
- Work content details
- Technical decisions
- Challenges and solutions
- File changes
- Test results
- Commit history with hashes
- Next steps

### README.md Must Always Include:

- Current development status (sync with WORK_LOG.md phases)
- Completed features list
- Test count and status
- Installation/usage instructions
- **MUST be updated whenever WORK_LOG.md changes**

## 🎵 Domain-Specific Rules

### Music DSL:

- Degree 0 is sacred - it represents musical silence
- All durations are musical values
- Precision matters for timing

### MIDI:

- Note range: 0-127
- PitchBend range: -8192 to +8191
- Channel 0 is reserved (use 1-15 for MPE)

---

**Remember**: This project values documentation and history as much as code. Every change tells a story that should be preserved in WORK_LOG.md!
