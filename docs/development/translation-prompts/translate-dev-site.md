# Translation Prompt: Dev Site (ja → en)

このプロンプトは Claude Desktop / Claude on the Web に **そのまま貼り付けて** 使う想定です。

将来の routine 化を見据えて self-contained に書かれています。

User サイトとは異なり **verbatim 規律** が CRITICAL なので、code block / line range / KaTeX / Sources の取り扱いに特に注意してください。

---

## プロンプト本文 (ここから↓を copy)

```
You are translating the OrbitScore developer learning site (implementation reading notes) from Japanese to English.

## Repository

https://github.com/signalcompose/orbitscore

You have GitHub access. Clone the repo, work on a new branch, and open a single PR when done.

## Required Reading (read these first, in order)

1. `sites/dev/.translation-glossary.md` — terminology pairs, tone rules, **CRITICAL §4 verbatim discipline**
2. `sites/dev/STYLE_GUIDE.md` — writing rules including §5-bis verbatim citation rules
3. `sites/dev/en/orientation/architecture-overview.md` — translated chapter (use as reference for tone/style/verbatim discipline)
4. `docs/development/TRANSLATION_WORKFLOW.md` — high-level workflow doc
5. `docs/development/DEV_LEARNING_SITE.md` — project brief explaining the site's purpose and SoT relationship

## Chapters to Translate (18 total)

For each chapter, translate the Japanese source and overwrite the English stub at the same relative path under `sites/dev/en/`:

| # | Source (ja) | Target (en, overwrite) | Title |
|---|---|---|---|
| - | `sites/dev/index.md` | `sites/dev/en/index.md` | OrbitScore Dev (landing) |
| 0-1 | `sites/dev/orientation/what-is-orbitscore.md` | `sites/dev/en/orientation/what-is-orbitscore.md` | What is OrbitScore |
| I-1 | `sites/dev/pipeline/text-to-ast.md` | `sites/dev/en/pipeline/text-to-ast.md` | Text to AST |
| I-2 | `sites/dev/pipeline/evaluation.md` | `sites/dev/en/pipeline/evaluation.md` | AST Evaluation Model |
| I-3 | `sites/dev/pipeline/selective-execution.md` | `sites/dev/en/pipeline/selective-execution.md` | Selective Execution |
| II-1 | `sites/dev/scheduling/time-representation.md` | `sites/dev/en/scheduling/time-representation.md` | Time Representation |
| II-2 | `sites/dev/scheduling/polymeter.md` | `sites/dev/en/scheduling/polymeter.md` | Polymeter / Polyrhythm |
| II-3 | `sites/dev/scheduling/event-queue.md` | `sites/dev/en/scheduling/event-queue.md` | Event Queue and Look-Ahead |
| II-4 | `sites/dev/scheduling/transport.md` | `sites/dev/en/scheduling/transport.md` | Transport |
| III-1 | `sites/dev/audio/supercollider.md` | `sites/dev/en/audio/supercollider.md` | Communication with SuperCollider |
| III-2 | `sites/dev/audio/audio-file-playback.md` | `sites/dev/en/audio/audio-file-playback.md` | Audio File Playback |
| III-3 | `sites/dev/audio/scsynth-bundle.md` | `sites/dev/en/audio/scsynth-bundle.md` | scsynth Bundle and Path Resolution |
| IV-1 | `sites/dev/editor/vscode-architecture.md` | `sites/dev/en/editor/vscode-architecture.md` | VS Code Extension Architecture |
| IV-2 | `sites/dev/editor/execution-feedback.md` | `sites/dev/en/editor/execution-feedback.md` | Inline Execution and Feedback |
| ADR | `sites/dev/decisions/adr-001-supercollider.md` | `sites/dev/en/decisions/adr-001-supercollider.md` | ADR-001 Choosing SC-based Implementation |
| ADR | `sites/dev/decisions/adr-002-dsl-v3-pivot.md` | `sites/dev/en/decisions/adr-002-dsl-v3-pivot.md` | ADR-002 DSL v1 to v3 Pivot |
| ADR | `sites/dev/decisions/adr-003-scsynth-bundle.md` | `sites/dev/en/decisions/adr-003-scsynth-bundle.md` | ADR-003 scsynth Bundle Strict Mode |
| - | `sites/dev/glossary.md` | `sites/dev/en/glossary.md` | Glossary |

The stub files currently contain only a "Translation in progress" warning. Overwrite them entirely with full translations.

Chapter `orientation/architecture-overview.md` is ALREADY translated as a spike example — use it as your tone/style/verbatim reference, do NOT modify it.

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

NOTE: Absolute paths to dev site internal pages need `/en/` prefix in the en version. Use the spike `architecture-overview.md` as reference for how it handles these.

For relative paths like `./other.md` or `../section/other.md`, keep them as-is.

## Glossary terminology

Follow `sites/dev/.translation-glossary.md` §1 strictly. Key examples:

- 実装レイヤー → implementation layer
- 単一信頼情報源 / SoT → Single Source of Truth (SoT)
- 構文木 / AST → AST (abstract syntax tree)
- スケジューラ → scheduler
- 注入 → injection / inject
- 解決 → resolve / resolution
- 同梱 → bundled
- 拡張機能 → extension
- 拡張機能ホスト → Extension Host (preserve VS Code official capitalization)

If a term is not in the glossary, infer from context and note it in the PR description.

## Workflow

1. Create a branch: `en-translation-dev-site`
2. Translate all 18 chapters by overwriting the stub files at `sites/dev/en/<path>.md`
3. Run locally to verify:
   ```bash
   npm install
   npm run -w @orbitscore/dev-site docs:build
   ```
   Build must pass with no dead links and no KaTeX rendering errors.
4. Update `docs/development/TRANSLATION_STATUS.md`:
   - For each of the 18 dev chapters in the table, change `Status` from `pending` to `done`
   - Set `Last translated against (ja commit)` to the current `main` HEAD commit hash
   - Update the `残り: 18 章` summary line (`残り: 0 章` if all done)
5. Commit with title: `docs(en): translate dev site chapters (18)`
6. Open a PR against `main` with title: `Translate dev site to English (18 chapters)`

## PR Description Template

```
## Summary

18 章の英訳を完了。spike 章 (architecture-overview.md) と同じトーン・glossary・verbatim 規律に従って翻訳。

## Translated chapters

(List each chapter as a checkbox, ticking those done)

## Verbatim discipline self-check

- [ ] All TS code blocks byte-identical (range comments, indentation, omission markers)
- [ ] All Sources file paths and line ranges byte-identical
- [ ] All KaTeX math expressions byte-identical
- [ ] Mermaid syntax preserved (only Japanese node labels translated)
- [ ] Frontmatter `verified-against` / `verified-at` / `status` values preserved

## Source ja commit

Translated against `main` at <commit-sha-here>.

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

- [ ] All 18 stub files overwritten with full translations
- [ ] `docs:build` passes with no dead links
- [ ] KaTeX math expressions render correctly
- [ ] Code blocks: byte-identical content, range comments preserved, omission markers preserved
- [ ] Sources sections: file paths and line ranges byte-identical, only descriptions translated
- [ ] Frontmatter: `title`/`description` translated, other fields preserved exactly
- [ ] Mermaid: graph syntax preserved, only ja node labels translated
- [ ] Cross-chapter links: absolute paths use `/en/` prefix, relative paths unchanged
- [ ] Glossary §1 terminology applied consistently
- [ ] `TRANSLATION_STATUS.md` updated

## Notes

- This is a single-PR-for-all-chapters approach (not one PR per chapter), per project preference.
- The dev site is a "personal learning notes" reference, so the en version should also feel like reading detailed implementation notes, not marketing/tutorial copy.
- The verbatim discipline is non-negotiable: the SoT is the code, and citations must remain trustworthy.
```

---

## Routine 化への展望

User サイトと同様、CronCreate routine で自動化想定:

1. ja の章が更新された commit を検出
2. `TRANSLATION_STATUS.md` の該当章を `done` → `outdated` に変更
3. このプロンプトを on-the-web に投げて再翻訳 PR 作成

特に dev サイトは verbatim 規律のため、ja 側の code block range が変わったときは en 側も同じ commit ベースで再翻訳が必要。
