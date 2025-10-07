# OrbitScore Project Rules

## 🔴 CRITICAL RULES - MUST FOLLOW

### 1. WORK_LOG.md Updates (最重要)

**EVERY commit MUST be documented in WORK_LOG.md**

- Update WORK_LOG.md BEFORE committing
- Document what was changed, why, and the commit hash
- Keep chronological order
- Include technical decisions and challenges
- **MUST update README.md when WORK_LOG.md is updated** to keep project status current

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

### 4. Documentation First

- Update relevant docs (README, IMPLEMENTATION_PLAN, etc.) with each change
- Documentation is as important as code
- Keep specifications in sync with implementation

### 5. Test-Driven Development

- Write tests for new features
- Ensure all tests pass before committing
- Golden files for regression testing

### 6. Tutorial and Example File Management

**チュートリアルファイルの参照を必須とする:**

- **新しい`.osc`テストファイルを作成する前に、必ず既存のチュートリアルファイル（`examples/01_*.osc` - `examples/08_*.osc`）を確認すること**
- チュートリアルファイルに正しい構文例が記載されているため、それを参考にすること
- 特に以下を確認：
  - `var global = init GLOBAL` の初期化（`global`ではなく`GLOBAL`）
  - `.audio()` メソッド（`sample()`ではない）
  - `global.run()` の呼び出しタイミング
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
- **Git操作** - `git commit`, `git push`, `gh pr create`, `gh pr merge`

**理由:**

- 読み取り専用ツールはプロジェクトに変更を加えないため、確認なしで実行しても安全
- 書き込み・実行系ツールは意図しない変更を防ぐため、確認が必要
- 作業効率と安全性のバランスを取る

**注意:** MCPツールの確認設定はCursor/エディタ側で管理されるため、このポリシーはAIエージェントとユーザー間の共通理解として機能する

## 📋 Development Workflow

### For Each Phase:

1. Review IMPLEMENTATION_PLAN.md
2. Create todo list
3. Implement features
4. Write/update tests
5. **Update WORK_LOG.md** (before committing, use `[PENDING]` for commit hash)
6. **Update README.md** (sync with WORK_LOG.md status)
7. Update other documentation
8. **Update Serena memory** (important changes, issues, decisions)
9. **Commit all changes including docs and Serena memory files** (`.serena/memories/*.md`)
10. **Get the commit hash** (`git rev-parse --short HEAD`) - this is the "実コミット"
11. **Update WORK_LOG.md with the first commit hash** (replace `[PENDING]` with the hash from step 10)
12. **Amend the commit** (`git add docs/WORK_LOG.md && git commit --amend --no-edit`)

**Important**: 
- Record the **first commit hash** (from step 10) in WORK_LOG.md, not the final amended hash
- This hash represents the "actual commit" with all changes
- The amend only adds the commit hash reference to WORK_LOG.md
- This avoids infinite loop of updating hashes

**Note**: With Git Workflow (feature branches + PRs), we commit everything together before pushing, then create PR for review.

### Git Workflow and Branch Protection:

**CRITICAL: Always create a feature branch before starting work**

**Branch Structure:**
- `main` - Production-ready code (protected)
- `develop` - Integration branch (protected)
- `feature/*` - Feature development branches
- `fix/*` - Bug fix branches
- `refactor/*` - Refactoring branches
- `docs/*` - Documentation only changes
- `test/*` - Test additions/fixes

**Git Worktree Setup:**

This project uses Git Worktree to maintain separate working directories for `main` and `develop` branches:

```bash
# Directory structure
/Users/yamato/Src/proj_livecoding/
├── orbitscore/          # develop branch (main working directory)
└── orbitscore-main/     # main branch (production environment)

# View worktrees
git worktree list

# Switch between environments
cd /Users/yamato/Src/proj_livecoding/orbitscore       # develop
cd /Users/yamato/Src/proj_livecoding/orbitscore-main  # main
```

**Benefits:**
- Complete separation between develop and main environments
- No need to switch branches (no file changes)
- Can test both environments simultaneously
- Prevents accidental commits to main branch
- Stable production environment always available

**Branch Protection Rules (main & develop):**
- ✅ Pull Request required before merging
- ✅ At least 1 approval required
- ✅ Dismiss stale pull request approvals when new commits are pushed
- ✅ Administrators cannot bypass these settings
- ✅ Status checks must pass before merging (if configured)

**Creating a new feature branch:**
```bash
# Create and switch to new feature branch from develop
git checkout develop
git pull origin develop
git checkout -b feature/descriptive-name

# Example branch names:
# - feature/vst-plugin-support
# - fix/audio-timing-issue
# - refactor/parser-cleanup
```

**Development Workflow:**
```
1. Create feature branch from develop
2. Implement changes
3. Commit and push to origin
4. Create PR to develop
5. Request review (Cursor BugBot provides change summary)
6. Address review comments
7. Merge to develop after approval
8. (Release) Create PR from develop to main
9. Merge to main after approval
```

**Creating PRs:**
```bash
# Push branch to GitHub
git push -u origin feature/branch-name

# Create PR to develop
gh pr create --base develop --title "feat: description" --body "detailed description"

# Create PR to main (for releases)
gh pr create --base main --title "release: version X.Y.Z" --body "release notes"
```

**Merging PRs:**
```bash
# Merge with squash (DO NOT delete branch)
gh pr merge <number> --squash

# ❌ NEVER use --delete-branch flag
# ✅ Keep branches for historical reference
```

**Important:**
- **ALWAYS create a branch before starting work** - never commit directly to main or develop
- **ALWAYS create PR to develop first** - main is only for releases
- **Branches are kept for history** - do not delete after merge
- **Cursor BugBot** automatically provides change summaries on PRs (not actual code reviews)
- User typically handles merging, but agent may assist with complex implementations
- Always use `--squash` for clean commit history on main/develop branches
- **Branch protection prevents accidental direct pushes** to main and develop

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
- [ ] **Serena memory updated** (current issues, architectural changes, important decisions)
- [ ] **Serena memory files staged** (`.serena/memories/*.md` included in commit)
- [ ] Commit message is descriptive
- [ ] No console.log left in production code
- [ ] Types are properly defined

## 🔄 Continuous Practices

1. **Regular Testing**: Run tests frequently during development
2. **Incremental Commits**: Small, focused commits
3. **Documentation Sync**: Keep docs in sync with code
4. **Code Review**: Review your own code before committing

## 🧠 Serena Memory Management

### When to Update Serena Memory (コミット時):

**MUST update before committing when there are:**

1. **Critical Issues** (現在の重大な問題)
   - Bugs that affect core functionality
   - Performance issues
   - Broken features that need fixing
   - Example: "`global.stop()` not working properly"

2. **Architectural Changes** (アーキテクチャ変更)
   - Major refactoring
   - New design patterns introduced
   - Module structure changes
   - Breaking changes to internal APIs

3. **Important Decisions** (重要な決定事項)
   - Technical approach changes
   - Library/tool choices
   - Implementation strategy shifts
   - Performance optimization strategies

4. **Current Development Status** (開発ステータス)
   - Phase completion status
   - Feature implementation progress
   - Known limitations
   - Next steps/priorities

### Serena Memory Categories:

- **`project_overview`**: High-level project description, tech stack, current status
- **`current_issues`**: Active bugs and problems that need attention
- **`development_guidelines`**: Implementation patterns, best practices
- **`code_style_conventions`**: TypeScript/coding standards
- **`task_completion_checklist`**: Standard procedures for completion
- **`suggested_commands`**: Commonly used commands and workflows

### Update Command:

```typescript
serena-write_memory({
  memory_name: "current_issues",
  content: "Updated markdown content..."
})
```

### After Updating Memory:

**MUST commit the updated memory files:**

```bash
git add .serena/memories/*.md
git commit -m "docs: update Serena memory with [description]"
```

**Why**: Serena memory files (`.serena/memories/*.md`) are stored in the repository and should be version controlled. This ensures:
- Memory persists across sessions
- Other agents (Codex CLI, future sessions) can access the information
- Changes are tracked in git history
- Team members can see project status and issues

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
   - 上記の「Serena Memory Management」セクション参照

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
