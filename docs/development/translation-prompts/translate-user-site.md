# Translation Task: User Site (ja → en)

You are translating the OrbitScore user-facing learning site from Japanese to English.

This file IS the instruction. Read all of it, then execute the workflow.

---

## Repository

https://github.com/signalcompose/orbitscore

You have GitHub access. Clone the repo, work on a new branch, and open a single PR when done.

## Required Reading (read these first, in order)

1. `docs/development/TRANSLATION_STATUS.md` — single source of truth for which chapters need translation
2. `sites/user/.translation-glossary.md` — terminology pairs, tone rules, do-not-translate list
3. `sites/user/STYLE_GUIDE.md` — writing rules (tone, structure, link conventions)
4. `docs/development/TRANSLATION_WORKFLOW.md` — high-level workflow doc
5. Any chapter under `sites/user/en/` whose Status is `done` — use as reference for tone/style. At minimum read `sites/user/en/index.md` and `sites/user/en/getting-started/first-sound.md` (the original spike chapters).

## Determining Scope (do NOT hardcode)

Read `docs/development/TRANSLATION_STATUS.md` and find every row in the **`sites/user/` (10 章)** section whose `Status` column is `pending` OR `outdated`. Those are your translation targets.

For each target:
- Source (ja): `sites/user/<path>` (the path in the table)
- Target (en, overwrite stub): `sites/user/en/<path>`

If `Status` is `done`, skip that chapter (do NOT modify it).

The number of chapters per run varies by current status (e.g., 8 in initial bulk, 1 after a single ja update, etc.). Treat all targets uniformly. Single PR contains all chapters translated in this run.

## Critical Rules

### Do NOT translate (keep byte-identical)

- DSL/code block contents (e.g., `var global = init GLOBAL`)
- File paths (`kick.wav`, `./audio`, `examples/01_getting_started.orbs`)
- Method/function names (`audio()`, `play()`, `chop()`, etc.)
- Keyboard shortcuts (`Cmd+Enter`, `Cmd+Shift+P`)
- VS Code UI quotations (`🎵 OrbitScore: Ready`, `Extensions: Install from VSIX...`)
- Numbers and version strings

### DO translate

- Body prose
- Headings (`#`, `##`, `###`)
- Frontmatter `title` and `description` (preserve other fields if any)
- Inline link text (e.g., `[インストール](./installation.md)` → `[Installation](./installation.md)`)
- Comments inside code blocks if they are in Japanese (translate the comment, keep the code)

### Tone

Polite, friendly, kind — but **NOT condescending or childish**.

| NG | OK |
|---|---|
| "Let's give it a try!" | "Try the following." or "You can try it." |
| "You did it! Awesome!" | "This is the result." or "You have completed this step." |
| "Watch out!" | "Please note that..." |
| Excessive `🎉🚀✨` emojis | Use UI/code emojis (`🎵`, `✅`) only when they are in the source as UI quotations |

Use polite English equivalent of the ja ですます tone. Match the register of any chapter under `sites/user/en/` whose Status is `done`.

### Cross-chapter links

Keep relative paths. Both ja and en versions live at the same depth so paths translate 1:1:

- ja: `[インストール](./installation.md)` → en: `[Installation](./installation.md)`
- ja: `[パターンを作る](../basics/patterns.md)` → en: `[Building Patterns](../basics/patterns.md)`

### Glossary terminology

Follow `sites/user/.translation-glossary.md` §1 strictly. If a term is not in the glossary, infer from context and note it in the PR description.

## Workflow

1. Determine scope from `TRANSLATION_STATUS.md` (rows with `pending` or `outdated` for `sites/user/`).
2. Create a branch named `en-translation-user-site-<YYYY-MM-DD>` (today's date) to allow concurrent runs.
3. Translate every target chapter by overwriting the stub at `sites/user/en/<path>`.
4. Run locally to verify:
   ```bash
   npm install
   npm run -w @orbitscore/user-site docs:build
   ```
   Build must pass with no dead links.
5. Update `docs/development/TRANSLATION_STATUS.md`:
   - For each translated chapter, change `Status` to `done`
   - Set `Last translated against (ja commit)` to the current `main` HEAD commit hash (the one your translation is based on)
   - Recompute the `残り: N 章` summary line at the bottom of the user section
   - Recompute the global summary at the bottom of the file
6. Commit with title: `docs(en): translate user site chapters (N)` where N is the count
7. Open a PR against `main` with title: `Translate user site to English (N chapters)`

## PR Description Template

```
## Summary

N 章の英訳を完了。Status=done の既存章と同じトーン・glossary に従って翻訳。

## Translated chapters (this run)

(List each chapter you translated as a bullet. Format: `- <path> (<English title>)`)

## Status changes

- pending → done: <count>
- outdated → done: <count>

## Source ja commit

Translated against `main` at <commit-sha>.

## Verification

- [ ] `npm run -w @orbitscore/user-site docs:build` passes locally
- [ ] No dead links
- [ ] Glossary §1 terms used consistently
- [ ] Tone matches existing `done` chapters

## Glossary terms not found in glossary

(List any terms you had to infer, or write "None")
```

## Verification Checklist (before opening PR)

- [ ] All target stub files (per current `TRANSLATION_STATUS.md`) overwritten with full translations
- [ ] No `done` chapters were modified
- [ ] `docs:build` passes with no dead links
- [ ] Frontmatter `title` and `description` translated
- [ ] Cross-chapter links use relative paths
- [ ] Code blocks unchanged (DSL, file paths, method names preserved)
- [ ] Glossary §1 terminology applied consistently
- [ ] No "Let's...", "You did it!", or other condescending phrasing
- [ ] `TRANSLATION_STATUS.md` updated for every translated chapter
- [ ] Summary counts (`残り: N 章` and global summary) recomputed

## Notes

- The number of chapters per run varies. Do not assume any specific count.
- This is a single-PR-for-all-pending approach. If `outdated` and `pending` are mixed, include both.
- New ja chapters added since the last run will appear as `pending` rows automatically; pick them up.
- The output should read like a polite English tutorial written for absolute beginners — clear, kind, respectful, but not childish.
- If you encounter a term not in the glossary, suggest a glossary update in the PR description (do not modify the glossary file in this PR — that is a separate concern).
