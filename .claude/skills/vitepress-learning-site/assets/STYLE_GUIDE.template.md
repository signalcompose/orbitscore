---
title: "Style Guide (for writers)"
---

# Style Guide (for writers)

> Template: copy this file into `docs/STYLE_GUIDE.md` in the generated site, then customize sections 1, 2, 9 (and any others) to match Phase 1 decisions. Sections 3, 4, 5, 6, 7, 8, 10, 11, 12 should stay mostly intact — they encode the fact-first discipline.

Every page in this site is written according to this guide. Writing sub-agents must read it before touching any content. External auditors will evaluate pages against it.

## 1. Audience and assumptions

<!-- FILL FROM PHASE 1: audience profile. Include what readers are assumed to know and what they are explicitly not assumed to know. -->

## 2. Voice and tone

<!-- FILL FROM PHASE 1 (interview §2.5): pick ONE register and encode it here with concrete Good/Bad examples. Do NOT leave ambiguous. -->

<!-- Register: one of {dry-spec, neutral-technical, warm-sempai, custom-user-described} -->

**Chosen register:** `<FILL: e.g., warm-sempai>`

Rules that apply at every register:

- No emojis (unless explicitly requested).
- No marketing-style enthusiasm or emotive adjectives ("amazing", "powerful", "elegant", "至高", "最強").
- No time-relative phrasing ("now", "recently", "previously", "new", "old", "used to"). Describe what the code/system does, not how it evolved. Exception: chapters where history *is* the topic.
- Readers come to learn the topic, not the author's feelings about the topic.

Register-specific rules — **only the chosen register applies**:

### Register: dry-spec

- No filler. No "Let's...", no "We'll see...", no reader-addressing.
- Declarative statements of fact in the surface language. Short paragraphs.
- No warmth markers, no "this can be tricky" hedges.
- Example: "`useState` returns a tuple of the current state and a setter. The setter queues a re-render."

### Register: neutral-technical

- Polite and complete sentences. Some scaffolding ("This section explains...", "The key idea is...").
- No warmth markers, no reader-addressing beyond occasional "we".
- No hedges like "don't worry" or "this is tricky".
- Example: "`useState` returns an array of exactly two elements: the current state value and a setter. Calling the setter schedules a re-render of the component."

### Register: warm-sempai

- Welcome reader-addressing ("let's look at this together", "this is a common place to get stuck", "take your time here"). Cap at 2–3 warmth markers per chapter — lean, not gushing.
- "Don't worry if this doesn't click on the first pass — it'll come once you hit a bug that this explains" is in-scope.
- Still no marketing adjectives, still no time-relative language, still primary-source-grounded.
- Example: "`useState` は、React に『もう一度画面を描き直してください』とお願いするための特別な箱です。普通の変数との違いは 2 つだけなので、ここで一緒に整理しておきましょう。"

### Register: custom-user-described

- The user described the register in their own words at interview time. Paste those words here verbatim as the primary rule, then enumerate 2–3 Good/Bad examples that reflect it.

<!-- END Voice and tone -->

**Bad (regardless of register):**

- Overshooting into cheerleading: "めちゃくちゃ便利！ びっくりしますよ！" / "you're going to love this".
- Drift within one chapter — register switching between dry and warm mid-page reads as unserious. Pick one and hold.
- "Previously...", "In the old days...", "Recently..." unless in an explicit history section.

## 3. Fact-first discipline (the core rule)

This is non-negotiable. Auditors enforce it.

- Before making any factual claim, consult the primary source: specification, official documentation, source headers, standard textbook. Use a web-fetching tool (or equivalent) to load the source — do not write from memory.
- API names, signatures, quoted spec text, constant values, and version numbers must be **verbatim** from the primary source.
- When a claim cannot be verified against a primary source, mark it inline with a localized equivalent of:

  > NOTE: unverified — needs confirmation

  The English phrase `NOTE: unverified` must appear literally (even in non-English content) so auditors can grep for it.

- Secondary sources (blog posts, Stack Overflow, community wikis, Wikipedia) do not ground factual claims on their own. Wikipedia is acceptable as a navigation aid to find primary sources.

## 4. Source citation

Every Markdown file in `docs/` ends with a `## Sources` section (localize heading text if appropriate — e.g., `## 参照ソース` in Japanese content; keep the structure identical).

Format:

```markdown
## Sources

- [Page title — specific section](https://vendor.com/docs/section#anchor)
- `path/to/source/file.h` (at commit SHA or tag)
- Book author, *Book Title*, edition, pages X–Y
- Spec name, §X.Y (https://example.org/TR/spec/)
```

Rules:

- Deep-link. Top-page URLs (`vendor.com/`) are insufficient.
- For source repositories, include a commit SHA or tag in the URL (not floating `main`) unless the project is actively being rev'd.
- For books, include edition and page numbers where possible.

## 5. Heading hierarchy

- `#` = page title. One per file. Matches frontmatter `title` exactly.
- `##` = major section.
- `###` = subsection and figure titles.
- `####` and below: avoid. If needed, consider splitting to a new subsection.

## 6. Code blocks

- Always include a language tag: `cpp`, `ts`, `js`, `py`, `rs`, `go`, `json`, `yaml`, `bash`, `text`, `mermaid`, etc.
- For excerpts from source files or specs, put the source path in a leading comment so the origin is unambiguous:

  ```cpp
  // path/to/file.h (at SHA xxxxxxx)
  class Foo {
    void bar();
  };
  ```

- Do not paste entire source files. Excerpt only what is needed to make the point.

## 7. Diagrams (Mermaid)

- Each `##` section with meaningful structural/relational/sequential content should have at least one diagram. Short prose-only sections are fine without.
- Diagrams must add structure the prose doesn't already provide. A diagram that restates a bullet list in boxes is noise.
- Choose the type deliberately:
  - Flow and branching → `flowchart`
  - Interaction across actors over time → `sequenceDiagram`
  - Type/interface/class relationships → `classDiagram`
  - Lifecycle/state machine → `stateDiagram-v2`
  - Timeline/budget visualization → `gantt`
- Give each diagram a `### Figure X.Y.Z <title>` heading so other pages can cross-link to it.
- For `classDiagram`, note: `A <|-- B` means *B inherits from A*; `A <|.. B` (or `B ..|> A`) means *B realizes A*. Don't mix these up when drawing interface relationships.

## 8. Cross-linking

- Within the same Part: relative path, no `.md` extension (the site uses `cleanUrls`).
  - `[1.1 Sampling](./01-sampling)`
- Across Parts: relative up-and-over.
  - `[4.11 Latency](../04-vst3-sdk/11-latency-tail)`
- External sources: full URL.

## 9. Terminology

<!-- FILL: project-specific terminology table. Example below. -->

| Term (canonical) | Alternate forms (do not use) | Definition / notes |
|------------------|------------------------------|--------------------|
| <term>           | <alt>                        | <brief definition> |

If a new term emerges during writing that isn't in this table, define it at first use and flag in your completion report that the glossary may need an update.

## 10. Frontmatter

Every page starts with:

```yaml
---
title: "<same wording as the H1>"
---
```

Titles containing `:` must be quoted — unquoted `title: Part 0: Intro` is invalid YAML.

## 11. Figure-number convention

Use `### Figure <Part>.<Chapter>.<Index> <short title>` for diagram headings so they're stable cross-reference targets. Example: `### Figure 2.4.1 PDC alignment before and after`.

From other pages, link as `[Figure 2.4.1](../02-.../04-chapter#figure-2-4-1-pdc-alignment-before-and-after)`. (VitePress anchor slugs are lowercased with hyphens.)

## 12. SVG illustrations (Tier 2 / Tier 3 visuals)

When Mermaid cannot express the idea cleanly — metaphors, side-by-side comparisons, layered layouts, freeform timelines — hand-author inline SVG.

### Rules

- **No `<style>` tags inside `<svg>`.** Vue's template compiler rejects side-effect tags inside component templates. Use inline `style="..."` attributes per element, or put classes on the SVG and define them in the site's global CSS (`docs/.vitepress/theme/custom.css`).
- `fill="currentColor"` and `stroke="currentColor"` so diagrams inherit the theme's text color in both light and dark modes. For accent colors, use explicit hex / rgb and test both modes.
- No `<script>` tags inside SVG.
- Always set `viewBox` and `role="img"` with an `aria-label` describing what the figure shows.
- Give each SVG the same `### Figure X.Y.Z <title>` heading as Mermaid figures.
- **Verify bounding boxes:** CJK full-width glyphs take ~13–15px per char at `font-size=13`; English half-width chars take ~6–7px. Long labels inside narrow rects will overflow silently in dev — the orchestrator's browser verification must check.

### Animation (Tier 3)

- Use SMIL `<animate>` / `<animateTransform>` for simple loops. No CSS keyframes (would require `<style>`).
- Animations should be subtle and not steal attention from prose. If the page has 5+ continuously-animating elements, cut back.

## 13. Interactive Vue components (Tier 4 — the highest-value visual tier)

VitePress is Vue-based. You may embed live, interactive Vue Single-File Components inside any Markdown page. For concepts that require "touch to understand" (state transitions, re-renders, diffs, data flow, caches, snapshots, timing), **Tier 4 is the default expectation**, not a luxury.

### File layout

Place components at:

```
docs/.vitepress/theme/components/<partSlug>/<PascalCaseName>.vue
```

Example: `docs/.vitepress/theme/components/p3/UseStateSnapshotDemo.vue`.

### Usage pattern (local import — no global registration needed)

In the Markdown file:

```markdown
---
title: "3.4 useState"
---

<script setup>
import UseStateSnapshotDemo from '../.vitepress/theme/components/p3/UseStateSnapshotDemo.vue'
</script>

# 3.4 useState

... prose ...

<UseStateSnapshotDemo />
```

This avoids any edit to `theme/index.ts`, which is important when multiple writing agents run in parallel (the theme entry becomes a race-condition hot spot otherwise).

### Component quality bar

- **Narrow focus.** One concept per component. A 3-panel before/after counter beats a kitchen-sink playground.
- **Minimal chrome.** The component should look like a callout box in the page, not a floating island. Inherit `var(--vp-c-*)` colors.
- **Scoped styles.** Use `<style scoped>` inside the SFC.
- **No external dependencies.** Pure Vue 3 Composition API (`<script setup>`, `ref`, `reactive`). No Pinia, no Vue Router, no npm packages added just for demos.

### What to demonstrate per topic type

| Topic type | Demo idea |
|------------|-----------|
| State snapshot | Side-by-side: value-based setter (stays 1) vs functional setter (advances 3). |
| Reconciliation / keys | Reorder list with `key={i}` vs `key={id}`; show content drift. |
| Prop drilling vs context | Slider for tree depth; toggle between drilling and context. |
| Optimistic UI | Submit button; toggle "force failure" to see rollback. |
| Cache / stale-while-revalidate | Fetch-count visualization when toggling cache modes. |
| Diff algorithm | Step-through of `oldTree → diff → patches → newTree`. |
| Before/after syntax | Tab to switch source; compiled output on the right. |

### Anti-patterns

- Using a Vue demo to reproduce something already explained well in prose. The demo has to add something prose can't.
- Putting all demos on one "playground" page. Scatter them where each concept is introduced.
- Adding animation just because you can. Only when the motion *is* the pedagogy.

## 14. Prohibited

- Emojis.
- Subjective evaluations of tools, products, or people ("the best", "the most powerful", "superior to").
- Marketing language.
- Unverified claims without the `NOTE: unverified` marker.
- Editing files outside your assigned scope (in parallel-writing contexts).
- Running dev/build/deploy commands (reserved for the orchestrator).
