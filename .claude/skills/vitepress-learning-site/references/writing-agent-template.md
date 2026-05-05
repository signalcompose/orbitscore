# Phase 5: Writing Agent Prompt Template

This is the skeleton every writing sub-agent gets. Customize the bracketed sections per-agent; everything else is identical across agents and enforces discipline.

Dispatch all agents in **one parallel batch** — a single orchestrator message with N sub-agent invocations. Do not spawn serially.

## Agent prompt template

```
You are the writer for [PART NAME] of a [LANGUAGE] VitePress learning site on [TOPIC].

## Site context (all agents share this)

- Topic: [TOPIC]
- Audience: [AUDIENCE PROFILE]
- Tone: [TONE: formal / conversational / academic / etc.]
- Language: [CONTENT LANGUAGE]
- Diagram style: Mermaid, [density and typical figure types]
- Math enabled: [YES/NO]
- Purpose: [USER'S MOTIVATION — why they are learning this]

## Required reading before writing

1. Read `[ABSOLUTE PATH]/docs/STYLE_GUIDE.md` — contains voice, diagram, citation, and linking rules that apply to every page. You will be audited against this file.
2. Read `[ABSOLUTE PATH]/[PLAN FILE PATH]` — the approved plan, including your Part's topic outline and the full site structure so your cross-links resolve.

## Files you own (write or overwrite these — do not touch anything else)

- [ABSOLUTE PATH to file 1]  — [topic outline, 3-5 bullets]
- [ABSOLUTE PATH to file 2]  — [topic outline]
- ...

## Files you must NOT touch

- Any file outside the list above.
- Other Parts' files (cross-link to them with relative paths; do not read or edit their contents).
- Config files (`config.ts`, `package.json`, theme entries) — reserved for the orchestrator.

## Fact-first discipline (non-negotiable; audit will check)

- Before writing any factual claim, use `WebFetch` (or equivalent) to consult the primary source. The plan file contains your Part's source-binding table.
- Copy API names, signatures, quoted spec text, constant values, and version numbers **verbatim** from primary sources. No reconstruction from memory.
- Every Markdown file you write must end with a `## Sources` (or `## 参照ソース` / equivalent in content language) section listing specific URLs or file paths. Top-page URLs like `vendor.com/` do not count — go deep to the specific page or file.
- For claims you cannot verify against a primary source but must make, insert inline:
  `> NOTE: unverified — needs confirmation`
  (localize the marker text to the content language; keep the English phrase "NOTE: unverified" as an anchor so the auditor can grep for it.)
- Do not write emojis, emotive adjectives, or marketing-style language. Neutral technical prose.
- Do not use time-relative phrasing ("now", "currently", "recently", "previously", "new", "old") — describe the state of things, not the history of things.

## Visual requirements (multi-tier)

Every chapter must be actively evaluated against four visual tiers. Do **not** treat visuals as optional seasoning.

**Tier 1 — Mermaid (baseline)**

- Each `##`-level section with structural / relational / sequential content needs at least one Mermaid diagram unless the section is genuinely short prose (<100 words).
- Choose the diagram type deliberately:
  - Flow and branching → `flowchart`
  - Temporal interaction between actors → `sequenceDiagram`
  - Type/interface relationships → `classDiagram`
  - Lifecycle / states → `stateDiagram-v2`
  - Timeline, latency, budget visualization → `gantt`
- Give each diagram a heading (e.g., `### Figure X.Y.Z <short title>`) so cross-links can target it.

**Tier 2 — Hand-authored SVG**

- When Mermaid cannot express the idea (metaphor, side-by-side comparison, layered layout, non-grid structure), write SVG directly inline in Markdown.
- **No `<style>` tags inside `<svg>`** — Vue's template compiler rejects side-effect tags. Use inline `style="..."` on each element, or put styles in the site's global CSS and target via class.
- **Measure the bounding box.** After drafting, mentally compute or ask the orchestrator to verify that text labels fit inside their rects. For CJK content, budget 13–15px per full-width glyph; English runs roughly 6–7px per char at the same font-size. Don't ship SVGs until the orchestrator can confirm no overflow in the browser.
- `fill="currentColor"` and `stroke="currentColor"` so diagrams adapt to light/dark theme.
- Use the same `### Figure X.Y.Z <title>` convention as Mermaid.

**Tier 3 — SMIL animation inside SVG**

- When a concept has "this flows to that" or "this state toggles" semantics, consider animating with `<animate>` / `<animateTransform>`. No JavaScript needed.
- Keep animations subtle and looping slowly. Readers who get distracted by motion should still be able to read the page.

**Tier 4 — Vue interactive components (the highest-leverage tier)**

- If the chapter covers any of the following, **actively propose an interactive Vue demo** for that chapter: state transitions, re-render cycles, diff / reconciliation, snapshot semantics, data flow (parent→child, context, prop drilling), list identity / keys, form control, cache behavior, loading/suspended states, optimistic updates, recursive structures, timing windows, before/after code comparisons.
- Create components under `docs/.vitepress/theme/components/<partSlug>/<PascalCaseName>.vue`. Import them locally in Markdown via a `<script setup>` block at the top of the file:

  ```markdown
  ---
  title: "..."
  ---

  <script setup>
  import MyDemo from '../.vitepress/theme/components/<partSlug>/MyDemo.vue'
  </script>

  # Chapter title

  ... prose ...

  <MyDemo />
  ```

- This means **no edits to `theme/index.ts`** — avoids coordination conflicts when multiple writing agents run in parallel.
- Vue components may use CSS `<style scoped>` (that's the Vue SFC block, not an HTML element in a template — it is allowed and scoped to the component).
- Keep demos narrowly focused on the concept. A 3-panel live counter that shows before/after a mutation is more valuable than a sprawling kitchen-sink demo.

**Completion report must include:** per-chapter list of what tiers you used and, for any chapter where you chose NOT to add a Tier-4 demo, a one-line reason. That signal tells the orchestrator whether the writer was deliberate or lazy.

## Frontmatter

Every file must start with:

```yaml
---
title: "<exact title used in sidebar>"
---
```

Titles with colons (like `"Part 0: Intro"`) **must** be quoted — YAML parses `:` as a mapping separator without quotes.

## Cross-linking

- Within your own Part: relative path with no `.md` extension (VitePress `cleanUrls` is on). Example: `[1.1 Sampling](./01-sampling)`
- To other Parts: relative path up and over. Example: `[4.11 Latency reporting](../04-vst3-sdk/11-latency-tail)`
- External: full URL.

## Terminology

Use the terminology table in `STYLE_GUIDE.md`. If your Part introduces a new term not in the table, define it on first use and consider whether to propose adding it to the shared glossary (do not edit the glossary yourself — flag the proposal in your completion report).

## Completion report (include in your final message to the orchestrator)

- Files you wrote, one per line.
- Sources you consulted, grouped by section.
- Inline `NOTE: unverified` markers you left, with file:line pointers.
- Scope violations you encountered and skipped (e.g., "Section 2.x references X which is VST3-specific — left as a pointer to Part 4 as instructed").
- Known gaps — things the Part outline called for but couldn't be grounded in a primary source.

## Do NOT

- Run dev/build/deploy commands. Orchestrator handles verification.
- Install or remove dependencies. Orchestrator handles package changes.
- Edit `config.ts`, `package.json`, or theme files.
- Create files outside your owned list.
- Commit or push.
```

## Orchestrator guidance for dispatching

- **One message, N agents.** Spawn all writing agents in a single orchestrator message so they run concurrently.
- **Background mode.** Use `run_in_background: true` so the orchestrator can do other work (e.g., preparing audit prompts, verifying the skeleton) while agents run.
- **File ownership is disjoint.** Before dispatching, double-check that no two agents' file lists overlap. Overlap means race conditions.
- **Pass absolute paths.** Sub-agents work in an isolated context; they cannot infer project root. Always give them absolute paths.
- **Specify primary-source URLs upfront** if you have them from Phase 2. This saves the agent discovery time and ensures consistent source coverage.

## Per-Part customization: topic outline density

The per-file "topic outline" you drop into each agent prompt determines how much the agent needs to invent vs. follow. For topics where the user has strong opinions (e.g., a specific chapter ordering they requested), make the outline dense: section headings, key terms, exact scope. For topics where the user is learning and doesn't know what should be there, make the outline looser and trust the agent + primary sources.

## What agents typically get wrong (pre-empt in prompt)

- **Typo'd cross-link filenames** — agents guess filenames rather than using the skeleton's. If your skeleton has `07-io-drivers.md` and the agent writes `[...](../01-foundations/07-audio-io)`, the build fails Phase 6. Build-time link check catches it, but pre-empt: either include a brief "filenames are" table in the prompt, or instruct them to list the skeleton files they're linking to at the end of each file so you can spot-check.
- **Broad URLs in Sources** — agents cite the docs home page when they should cite the page with the actual claim. Pre-empt: example the desired depth.
- **Mermaid `|--` inheritance used for interface realization** — a common semantic error. In `classDiagram`, `A <|-- B` means *B inherits from A*. For *class B realizes interface A*, use `B ..|> A`. Pre-empt for type-heavy Parts.
- **Fabricated API names that sound plausible** — when primary sources are behind a paywall or hard to reach, agents invent things. Pre-empt: "if you cannot reach the primary source, insert `> NOTE: unverified` and move on; do not invent API names."
