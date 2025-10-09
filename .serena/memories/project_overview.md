# OrbitScore Project Overview

**Last Updated**: 2025-10-09

## Project Description
OrbitScore is a live coding environment for audio synthesis using a custom DSL. The system parses DSL code and controls SuperCollider for real-time audio generation.

## Current Architecture

### Core Components
1. **Parser** (`packages/engine/src/parser/`)
   - Tokenizer: Lexical analysis
   - Parser: Syntax analysis and IR generation
   - Latest: Reserved keywords (RUN/LOOP/STOP/MUTE) support

2. **Interpreter** (`packages/engine/src/interpreter/`)
   - Statement processing
   - SuperCollider OSC communication
   - Latest: Multiple sequence control via reserved keywords

3. **CLI** (`packages/cli/`)
   - File watching and execution
   - REPL interface

4. **VSCode Extension** (`packages/vscode-orbitscore/`)
   - Syntax highlighting
   - Code execution integration

## Latest Features (as of PR #41)

### Reserved Keywords for Multiple Sequence Control
```javascript
RUN(kick, snare, hihat)   // Start multiple sequences
LOOP(bass)                // Loop sequence
STOP(kick, snare)         // Stop multiple sequences
MUTE(hihat)               // Mute sequence
```

**Benefits**:
- Clearer intent in live coding
- Bulk operations on multiple sequences
- More readable than chained method calls

## Test Status
- **Total Tests**: 137 passed, 19 skipped
- **Coverage**: Parser, Interpreter, CLI
- **Framework**: Vitest

## Documentation Structure
- `docs/INSTRUCTION_ORBITSCORE_DSL.md` - DSL specification (v2.0)
- `docs/IMPLEMENTATION_PLAN.md` - Implementation roadmap
- `docs/PROJECT_RULES.md` - Git workflow and coding standards
- `docs/WORK_LOG.md` - Development history
- `CLAUDE.md` - AI agent instructions (CRITICAL RULES)

## Git Workflow (CRITICAL)
**MUST FOLLOW**: Issue → Branch → PR → Merge

1. Create Issue (get number)
2. Create branch: `<issue-number>-<descriptive-name>`
3. Implement and commit
4. Create PR with `Closes #<issue-number>`
5. Merge (auto-closes issue)

## Branch Policy
- **Protected**: `main`, `develop` (require PR)
- **Remote**: Keep for historical reference
- **Local**: Can delete after merge

## Session Handoff Notes

### Stashed Changes
- Branch deletion rule clarification (stash@{0})
- To be included in next documentation PR

### Untracked Files
- `CLAUDE.md` - Project instructions for AI agents
- `tmp/github-issue-body.md` - Temporary file

### Next Session Checklist
1. Read CLAUDE.md (CRITICAL RULES section)
2. Read PROJECT_RULES.md
3. Check Serena memories
4. Follow Issue → Branch → PR workflow
5. Never commit directly to develop/main

## Known Future Enhancements
- Granular synthesis support
- Additional DSL syntax improvements
- Performance optimizations
