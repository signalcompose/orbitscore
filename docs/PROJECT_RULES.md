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

## 📋 Development Workflow

### For Each Phase:

1. Review IMPLEMENTATION_PLAN.md
2. Create todo list
3. Implement features
4. Write/update tests
5. **Update WORK_LOG.md**
6. **Update README.md** (sync with WORK_LOG.md status)
7. Update other documentation
8. **Update Serena memory** (important changes, issues, decisions)
9. **Commit all changes including Serena memory files** (`.serena/memories/*.md`)
10. **Add commit hash to WORK_LOG.md**
11. **Commit the commit hash update**

### Git Branch and PR Workflow:

**CRITICAL: Always create a feature branch before starting work**

**Creating a new feature branch:**
```bash
# Create and switch to new feature branch
git checkout -b feature/descriptive-name

# Example branch names:
# - feature/vst-plugin-support
# - fix/audio-timing-issue
# - refactor/parser-cleanup
```

**Branch naming convention:**
- `feature/` - new features
- `fix/` - bug fixes
- `refactor/` - code refactoring
- `docs/` - documentation only changes
- `test/` - test additions/fixes

**Creating PRs:**
```bash
# Push branch to GitHub
git push -u origin feature/branch-name

# Create PR with gh command
gh pr create --title "feat: description" --body "detailed description"
```

**Merging PRs:**
```bash
# Merge with squash (DO NOT delete branch)
gh pr merge <number> --squash

# ❌ NEVER use --delete-branch flag
# ✅ Keep branches for historical reference
```

**Important:**
- **ALWAYS create a branch before starting work** - never commit directly to main
- **Branches are kept for history** - do not delete after merge
- User typically handles merging, but agent may assist with complex implementations
- Always use `--squash` for clean commit history on main branch

### Commit Message Format:

```
<type>: <description>

<detailed explanation>

<what changed>
<why it changed>
<impact>
```

Types: feat, fix, docs, test, refactor, chore

### Progress Reporting

- ハンドオフメッセージやサマリーでは、開発進捗をフェーズ別にパーセンテージで明示する（例: “Phase 4: 70%”）。
- パーセンテージの分母は `docs/IMPLEMENTATION_PLAN.md` のマイルストーンに基づいて定義する。

## 🎯 Core Principles

### 1. Degree System Philosophy

- **0 = rest/silence** - Musical value, not just "no sound"
- 1-12 = chromatic scale (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)
- This is a defining feature of OrbitScore

### 2. Precision

- 小数第3位まで (3 decimal places)
- Random with seed for reproducibility

### 3. Contract-Based Design

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
