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

### 4. Documentation First

- Update relevant docs (README, IMPLEMENTATION_PLAN, etc.) with each change
- Documentation is as important as code
- Keep specifications in sync with implementation

### 5. Test-Driven Development

- Write tests for new features
- Ensure all tests pass before committing
- Golden files for regression testing

## 📋 Development Workflow

### For Each Phase:

1. Review IMPLEMENTATION_PLAN.md
2. Create todo list
3. Implement features
4. Write/update tests
5. **Update WORK_LOG.md**
6. **Update README.md** (sync with WORK_LOG.md status)
7. Update other documentation
8. Commit with descriptive message
9. **Add commit hash to WORK_LOG.md**

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

1. **NEVER** commit without updating WORK_LOG.md
2. **NEVER** change IR types without version consideration
3. **NEVER** skip tests for new features
4. **NEVER** use magic numbers - use constants
5. **NEVER** leave TODO comments without tracking

## ✅ Checklist Before Committing

- [ ] Tests pass (`npm test`)
- [ ] WORK_LOG.md updated
- [ ] README.md updated (MUST reflect current status from WORK_LOG.md)
- [ ] Documentation updated if needed
- [ ] Commit message is descriptive
- [ ] No console.log left in production code
- [ ] Types are properly defined

## 🔄 Continuous Practices

1. **Regular Testing**: Run tests frequently during development
2. **Incremental Commits**: Small, focused commits
3. **Documentation Sync**: Keep docs in sync with code
4. **Code Review**: Review your own code before committing

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
