# Phase 8: External Audit Prompt

An independent agent — **not** one of the writers — reviews the site for structural problems, factual errors, and scope discipline. The point is *independence*: the writer's blind spots become the reviewer's findings.

## Choosing the reviewer

In priority order:

1. A different model/agent family than the writers (different training, different priors)
2. A different instance of the same family with a genuinely clean context (no knowledge of the writing decisions)
3. (Fallback) A second pass by the orchestrator with explicit "pretend you haven't seen this" framing

"Codex" is one specific option in Anthropic's Claude Code plugin ecosystem; other valid choices include a generic `general-purpose` agent, a different provider's agent, or the user themselves. The key is whatever reviewer has the greatest claim to *independence*.

## Audit prompt template

```
You are an external independent auditor for a VitePress learning site on [TOPIC]. You have **not** participated in writing this site. Your job is to find problems.

## What to review

All Markdown under [ABSOLUTE PATH]/docs/ (excluding audit report files, temp files, and non-content Markdown like STYLE_GUIDE.md).

## Required reading first

- [ABSOLUTE PATH]/docs/STYLE_GUIDE.md — the discipline the writers agreed to
- [ABSOLUTE PATH]/[PLAN FILE] — the agreed scope, audience, and structure

## Audit scope

1. **Structure**
   - Is the Part/Chapter ordering sensible for the stated audience?
   - Are there missing topics implied by the plan but absent?
   - Are there redundant sections that cover the same material twice?
   - Is the granularity uneven? (e.g., one Chapter covers too much, another too little)
   - Is the "common vs. specific" split (if the site has one) respected at the chapter level?

2. **Factual accuracy**
   - Spot-check quoted API names, signatures, constants, version numbers against the primary source URLs cited in `## Sources` sections.
   - For each Part, sample 3-5 factual claims and verify with `WebFetch` to the cited primary source.
   - Flag any discrepancy between what the page asserts and what the primary source actually says.
   - Flag claims with no primary source citation that *should* have one.

3. **Source citation quality**
   - Every page should end with a `## Sources` (or equivalent) section.
   - URLs should deep-link to the specific content, not to docs home pages.
   - For source repositories, links should include a commit SHA or tag (not a floating `main`), unless floating was explicitly acceptable.
   - Top-page URLs (`vendor.com/docs/`) count as a Major citation weakness.

4. **Unverified markers**
   - Enumerate every `> NOTE: unverified` (and localized variants) residual in the entire site. These are debts.
   - For each: is it a legitimate "the primary source is behind a paywall" case, or could it have been resolved with more research?

5. **Internal consistency**
   - Terminology — does the same concept have the same name across Parts? If not, which is canonical and which is drift?
   - Cross-links — do internal links resolve to the right target? (The build catches broken links, but not *semantically wrong* links.)

6. **Diagram utility**
   - Do Mermaid diagrams add structural insight, or do they paraphrase the surrounding prose?
   - Is the diagram type appropriate for the concept? (e.g., flow not sequence when there's no temporal ordering)
   - Are figure titles clear enough to reference from text?

## Output

Write your report to [ABSOLUTE PATH]/docs/AUDIT_REPORT.md (or AUDIT_REPORT_ROUND<N>.md if this is a second-pass audit).

Structure:

```markdown
---
title: "External Audit Report"
---

# External Audit Report

Date: <date>
Scope: docs/ (except STYLE_GUIDE.md, earlier audit reports)
Reviewer: [identifier — tool name or anonymized]

## Overall assessment

<3-5 paragraphs: is the site publishable? what are the standout strengths and the structural weaknesses?>

## Severity definitions

- **Critical**: Reader will be misinformed on a factual claim, or a major structural flaw impairs learning.
- **Major**: Fact unsubstantiated, scope discipline broken, or structure suboptimal.
- **Minor**: Typo, terminology drift, figure quality, formatting.

## Critical findings

### C1. <title>
- Location: <file:line>
- Observation: ...
- Evidence: <primary source URL demonstrating the correct claim>
- Recommended fix: ...

(C2, C3, ...)

## Major findings

### M1. <title>
- Location: ...
- Observation: ...
- Evidence: ...
- Recommended fix: ...

## Minor findings

<can be batched by category>

## Unverified-marker residuals

<enumerate every `> NOTE: unverified` with file:line and a note on whether it should be resolvable>

## Structural observations

<freeform: ordering, granularity, scope-bleed, missing chapters, etc.>

## Fix priority

1. First three to address
2. Next five
3. Nice-to-haves

## Summary

- Critical: N
- Major: N
- Minor: N
- Unverified markers remaining: N
```

## Anti-patterns in audits

- Marking items "resolved" without inspection — only assert resolution after reading the file.
- Citing secondary sources to support your own findings — if you flag an error, cite the primary source that proves it.
- Writing about the writers' process — stay focused on the output. "The writers should have done X" is less useful than "the output says Y; the primary source says Z".
- Recommending changes you can't justify with a primary source — if you don't know, write "verify Y" instead of "change to X".

## Do NOT

- Edit any file other than the audit report.
- Run build/dev/deploy commands.
- Commit changes.
```

## Applying audit findings (Phase 8 continued)

After the audit report is produced, the orchestrator applies findings. Pattern:

1. **Read** the full audit report. Categorize findings by *which files they touch*.
2. **Dispatch targeted fix agents** — not one giant "fix everything" agent. Clusters by area:
   - All findings touching Part X (one agent owns Part X's fixes)
   - All findings about a specific topic-area, even if cross-Part (one agent, with file-list specified)
3. **Each fix agent** is given:
   - The relevant audit findings (verbatim)
   - The primary sources cited by the audit
   - Instruction to `WebFetch` the cited sources and reconcile the page against them
4. **Re-run Phase 6 + Phase 7** after fixes. Fixes can regress build health.
5. **Optional second audit round** if Critical or Major count was high initially. Narrow the second audit's scope to "verify prior findings are addressed; report any new issues introduced".
6. **Stop at 2 rounds max.** More rounds don't convergence — they churn. Remaining issues become known-issues in the project's README or the plan file.

## Common audit findings that indicate deeper problems

- "Many unverified markers in Part X" → Phase 2 research was too shallow for that Part. Consider re-research rather than triaging each marker.
- "Scope-bleed across Parts" → plan's Part boundaries were ambiguous. May indicate a revisit-plan round with the user.
- "Structural suggestions" at Critical severity → consider whether rebuild beats piecemeal fixes.
- "Factual accuracy fails on multiple API names" → the writers didn't `WebFetch` primary sources. Escalate STYLE_GUIDE discipline in the fix agents' prompts.
