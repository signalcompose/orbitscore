# Translation Task: Dev Site (ja → en)

You are translating the OrbitScore developer learning site (implementation reading notes) from Japanese to English.

This file IS the instruction. Read all of it, then execute the workflow.

User サイトとは異なり **verbatim 規律** が CRITICAL なので、code block / line range / KaTeX / Sources の取り扱いに特に注意してください。

---

## Repository

https://github.com/signalcompose/orbitscore

You have GitHub access. Clone the repo, work on a new branch, and open a single PR when done.

## Required Reading (read these first, in order)

1. `docs/development/TRANSLATION_STATUS.md` — single source of truth for which chapters need translation
2. `sites/dev/.translation-glossary.md` — terminology pairs, tone rules, **CRITICAL §4 verbatim discipline**
3. `sites/dev/STYLE_GUIDE.md` — writing rules including §5-bis verbatim citation rules
4. `docs/development/TRANSLATION_WORKFLOW.md` — high-level workflow doc
5. `docs/development/DEV_LEARNING_SITE.md` — project brief explaining the site's purpose and SoT relationship
6. Any chapter under `sites/dev/en/` whose Status is `done` — use as reference for tone/style/verbatim handling. At minimum read `sites/dev/en/orientation/architecture-overview.md` (the original spike chapter).

## Determining Scope (do NOT hardcode)

Read `docs/development/TRANSLATION_STATUS.md` and find every row in the **`sites/dev/` (19 章)** section whose `Status` column is `pending` OR `outdated`. Those are your translation targets.

For each target:
- Source (ja): `sites/dev/<path>` (the path in the table)
- Target (en, overwrite stub): `sites/dev/en/<path>`

If `Status` is `done`, skip that chapter (do NOT modify it).

The number of chapters per run varies by current status. Treat all targets uniformly. Single PR contains all chapters translated in this run.

## CRITICAL: Verbatim Rules

The dev site has a strict citation discipline. The following must remain **byte-identical** between ja and en versions:

### Code blocks

The contents of TS/JS/Shell code blocks MUST NOT be translated or reformatted:

```typescript
// packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99
export function resolveScsynthPath(opts: ResolveOptions = {}): ScsynthResolution {
  // ...
}
```

- The `// <file>:<start>-<end>` line range comment is byte-identical
- Indentation, whitespace, and line breaks are byte-identical
- `// ...` omission markers are byte-identical
- English inline comments stay in English; Japanese inline comments are translated to English while preserving formatting

### Sources sections

File paths and line ranges must be byte-identical. Only the trailing description (after `—`) is translated:

ja: `- packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99 — resolveScsynthPath() の優先順位ロジック`

en: `- packages/engine/src/audio/supercollider/scsynth-resolver.ts:76-99 — Priority logic of resolveScsynthPath()`

### KaTeX

Math expressions inside `$...$` and `$$...$$` are byte-identical.

### Mermaid diagrams

The graph syntax (`flowchart TD`, `sequenceDiagram`, edge arrows) is byte-identical. Only Japanese node labels are translated to English.

### Frontmatter

```yaml
---
title: <translate>
description: <translate if present>
verified-against: <commit-sha-IDENTICAL>
verified-at: <YYYY-MM-DD-IDENTICAL>
status: <draft|reviewed|stable - keyword IDENTICAL>
---
```

Only `title` and `description` are translated. Other fields preserve their values exactly.

### Disclaimer line

If a chapter has a disclaimer line at the top, translate it as follows:

ja: `> **Note**: 本ページは {YYYY-MM-DD} 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。`

en: `> **Note**: This page is a trace of the author's reading as of {YYYY-MM-DD}. The code is the truth; this page is merely a snapshot of understanding at that point in time.`

(Preserve the original date.)

## Tone

Technical, objective, explanatory — like a colleague walking through the code with you, not academic paper formality. The ja "sempai-like warmth" should not be transliterated; English equivalent is just clear, helpful explanation.

| ja | en |
|---|---|
| この理由は〜です | The reason is that ... |
| 〜になります | This results in ... / This becomes ... |
| 詳細は〜を参照 | For details, see ... / Refer to ... |
| ここで気をつけたいのは | A point worth noting is ... / What is worth noting is ... |

Avoid: "Let's...", "You should always...", excessive emojis.

## Cross-chapter links

Keep relative paths the same in both ja and en (both versions live at the same depth):

- ja: `[アーキテクチャ全景](/orientation/architecture-overview)` → en: `[Architecture Overview](/en/orientation/architecture-overview)`

NOTE: Absolute paths to dev site internal pages need `/en/` prefix in the en version. Use any `done` chapter (e.g., `architecture-overview.md`) as reference for how it handles these.

For relative paths like `./other.md` or `../section/other.md`, keep them as-is.

## Glossary terminology

Follow `sites/dev/.translation-glossary.md` §1 strictly. If a term is not in the glossary, infer from context and note it in the PR description.

## Workflow

1. Determine scope from `TRANSLATION_STATUS.md` (rows with `pending` or `outdated` for `sites/dev/`).
2. Create a branch named `en-translation-dev-site-<YYYY-MM-DD>` (today's date) to allow concurrent runs.
3. Translate every target chapter by overwriting the stub at `sites/dev/en/<path>`.
4. Run locally to verify:
   ```bash
   npm install
   npm run -w @orbitscore/dev-site docs:build
   ```
   Build must pass with no dead links and no KaTeX rendering errors.
5. Update `docs/development/TRANSLATION_STATUS.md`:
   - For each translated chapter, change `Status` to `done`
   - Set `Last translated against (ja commit)` to the current `main` HEAD commit hash
   - Recompute the `残り: N 章` summary line at the bottom of the dev section
   - Recompute the global summary at the bottom of the file
6. Commit with title: `docs(en): translate dev site chapters (N)` where N is the count
7. Open a PR against `main` with title: `Translate dev site to English (N chapters)`

## PR Description Template

```
## Summary

N 章の英訳を完了。Status=done の既存章と同じトーン・glossary・verbatim 規律に従って翻訳。

## Translated chapters (this run)

(List each chapter you translated as a bullet. Format: `- <path> (<English title>)`)

## Status changes

- pending → done: <count>
- outdated → done: <count>

## Verbatim discipline self-check

- [ ] All TS code blocks byte-identical (range comments, indentation, omission markers)
- [ ] All Sources file paths and line ranges byte-identical
- [ ] All KaTeX math expressions byte-identical
- [ ] Mermaid syntax preserved (only Japanese node labels translated)
- [ ] Frontmatter `verified-against` / `verified-at` / `status` values preserved

## Source ja commit

Translated against `main` at <commit-sha>.

## Verification

- [ ] `npm run -w @orbitscore/dev-site docs:build` passes locally
- [ ] No dead links
- [ ] No KaTeX rendering errors
- [ ] Glossary §1 terms used consistently

## Glossary terms not found in glossary

(List any terms you had to infer, or write "None")

## Notes

(Anything reviewer should know — e.g., places where ja source seemed unclear and en interpretation was a judgment call)
```

## Verification Checklist (before opening PR)

- [ ] All target stub files (per current `TRANSLATION_STATUS.md`) overwritten with full translations
- [ ] No `done` chapters were modified
- [ ] `docs:build` passes with no dead links
- [ ] KaTeX math expressions render correctly
- [ ] Code blocks: byte-identical content, range comments preserved, omission markers preserved
- [ ] Sources sections: file paths and line ranges byte-identical, only descriptions translated
- [ ] Frontmatter: `title`/`description` translated, other fields preserved exactly
- [ ] Mermaid: graph syntax preserved, only ja node labels translated
- [ ] Cross-chapter links: absolute paths use `/en/` prefix, relative paths unchanged
- [ ] Glossary §1 terminology applied consistently
- [ ] `TRANSLATION_STATUS.md` updated for every translated chapter
- [ ] Summary counts recomputed

## Notes

- The number of chapters per run varies. Do not assume any specific count.
- New ja chapters added since the last run will appear as `pending` rows automatically; pick them up.
- This is a single-PR-for-all-pending approach.
- The dev site is "personal learning notes" reference, so en should also feel like detailed implementation notes, not marketing copy.
- The verbatim discipline is non-negotiable: SoT is the code, citations must remain trustworthy.
- If you encounter a term not in the glossary, suggest a glossary update in the PR description (do not modify the glossary file in this PR — that is a separate concern).
