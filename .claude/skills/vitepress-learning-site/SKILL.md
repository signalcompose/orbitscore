---
name: vitepress-learning-site
description: Build a multi-page, research-grade VitePress learning site from scratch for a topic the user wants to deeply understand. Drives an interview-first workflow — grills the user one decision at a time on scope, audience, language, depth, and boundaries; gathers primary sources before any writing begins; scaffolds a VitePress project with Mermaid (and optionally KaTeX); dispatches parallel writing sub-agents under strict fact-first discipline (mandatory source citations per file, explicit uncertainty markers, zero speculation); runs an independent external audit pass (e.g., via a second LLM/agent such as Codex) for fact-check and structural critique; verifies rendering in a real browser with dev tools (build success alone is insufficient — math layout, Mermaid SVGs, console errors all get checked). Use this skill whenever the user asks to "build a learning site", "make a study reference", "produce a structured explainer for X", wants a VitePress-based "I want to deeply understand X" outcome, or says things like "ドキュメントサイト作って" / "学習リファレンス作って" / "Xの内部を解説するサイト作って". Also trigger when the user is about to take on a self-study project that would benefit from a persistent multi-page written resource. Do NOT use for single-page READMEs, blog-style writeups, or product-landing docs — this skill is for multi-page, structured, long-form learning deliverables only.
---

# VitePress Learning Site Builder

You are helping the user build a research-grade, multi-page VitePress learning site on a specific topic. The point is for the **user to deeply learn** the topic — not to produce a polished marketing site — so content correctness and source traceability beat aesthetic polish.

## Core principles (read before acting)

1. **Interview first, execute second.** The user rarely knows exactly what they want until you grill them. Never assume scope, audience, or depth. Surface decisions with `AskUserQuestion` one at a time when it matters. Record the answers and the *why*.

2. **Primary sources are non-negotiable.** Writing sub-agents must consult specs, official docs, standard references, or source code — not blogs, forums, or memory — before writing. Every page ends with a `## Sources` (or equivalent) section that cites specific URLs, spec sections, or file paths.

3. **Uncertainty is explicit.** When a claim cannot be verified against a primary source, the writer marks it inline with a conspicuous token (e.g., `> NOTE: unverified — needs confirmation`) so auditors can grep for it later. Speculation without a marker is a Critical issue.

4. **File ownership is exclusive.** When writing is parallelized across sub-agents, each agent owns a disjoint set of files. No agent writes, edits, or deletes outside its assigned scope.

5. **Build success ≠ correctness.** A VitePress build can pass while the browser shows broken math, un-rendered Mermaid, or JavaScript errors. Verification must include loading the dev server in a real browser and inspecting the DOM and console.

6. **External eyes.** After first-pass writing, dispatch an independent reviewer (a different LLM, agent, or another Claude instance) with the brief of finding factual errors, structural flaws, and missing citations. The audit report drives a second editing pass.

7. **Do not decide what you can leave to the implementer.** Package manager, task runner, deploy target, which sub-agent product to use, Node version — these are project-level choices. The skill prescribes the *workflow* and the *VitePress content contract*, not a specific toolchain.

8. **Interactivity is not a luxury.** If a concept has a "you only get it when you touch it" quality (state transitions, re-render cycles, diff algorithms, data flow, snapshot semantics), a **Vue component embedded in the page** is almost always higher-value than another paragraph of prose. VitePress supports local `<script setup>` imports of `.vue` components from `docs/.vitepress/theme/components/**` — no global registration needed. Push writers to evaluate interactive demos **per chapter**, not as a one-off afterthought. SVG illustrations (including SMIL `<animate>` for simple animation) are a second-tier option when interactivity is overkill but a static Mermaid box-and-arrow underperforms.

9. **Tone is a parameter, not a default.** Different readers want different registers — some want dry-technical, some want sempai-talking-you-through-it. Never assume. The interview pins this down (checklist §4.5) and the STYLE_GUIDE encodes the chosen register so writers stay consistent across chapters.

## The nine phases

Work through these in order. Do not skip phases. Phases 1 → 3 happen before any file is written; Phase 7 is triggered by Phase 6 outcomes; Phase 9 is optional.

| # | Phase | Output |
|---|-------|--------|
| 1 | Discovery interview | Written decisions record |
| 2 | Source research | Source-to-topic binding table |
| 3 | Plan & user sign-off | Plan file; user-approved TOC |
| 4 | Project bootstrap | Running VitePress skeleton with empty chapter files |
| 5 | Parallel writing | Populated Markdown + diagrams |
| 6 | Build + link verification | Clean build, zero dead links |
| 7 | Browser verification | Zero console errors; rendered Mermaid/math confirmed in DOM |
| 8 | External audit + fixes | Audit report applied; up to 2 rounds |
| 9 | (Optional) Deployment config | Deploy config file |

---

### Phase 1: Discovery interview

The user's first message is almost never a full spec. Grill them.

Read `references/interview-checklist.md` for the full question catalog. At minimum, secure explicit answers (not assumptions) for:

- **Topic + motivation** (why learning this? is there an ulterior project driving it?)
- **Scope boundaries** (what's explicitly out?)
- **Audience** (self? team? beginner? advanced?)
- **Content language(s)** (and whether to i18n)
- **Voice / tone** (formal-dry? neutral-technical? warm-sempai? — do NOT default to one, ask). This is NOT a cosmetic decision; getting it wrong is the difference between "this feels for me" and "this feels cold". See interview-checklist §4.5.
- **Math rendering needed?**
- **Diagram density** (Mermaid-heavy, or mostly prose?)
- **Interactive / animated content** (SVG illustrations? animations? Vue components for live demos?) — for topics with "touch-to-click" moments (state machines, diffs, rendering, data flow), **actively push for interactivity**. Static figures alone leave readers unable to build intuition. See interview-checklist §7 (expanded).
- **Bridge/application chapter?** (mapping this topic to the user's ulterior project, if any — this was the highest-value chapter in a past engagement)
- **External audit desired?** (default: yes)
- **Depth of research per topic** (skim vs. spec-grade)
- **Deploy target or local-only?**

Use `AskUserQuestion` for decisions with >2 plausible answers. Batch up to 4 questions per call **only when** the answers are independent; otherwise ask one at a time so later questions are informed by earlier answers.

**Scope drift is the #1 killer.** Pin the user on what's *out* before what's *in*. If they hedge (e.g., "maybe also Y?"), push back: either commit to Y or explicitly defer it.

---

### Phase 2: Source research

Before writing a single content line, build a source-binding table: for each planned section, what *primary* source(s) will ground it?

Read `references/research-discipline.md` for source-hierarchy rules and for the primary-vs-secondary test.

Typical primary sources by domain:

- Technical APIs → official headers, SDK docs, spec repositories, source code
- Web standards → W3C / WHATWG / ECMA-262 specifications
- Audio/signal processing → IEC / AES / ITU standards; established textbooks
- Languages / frameworks → official language specs and reference implementations
- Platforms / products → vendor's own documentation and release notes

Use `WebFetch` (or project-appropriate tooling) to verify URLs exist and contain the claimed content — do not bind a source without spot-checking it.

Output: a table (can be inline in the plan file) mapping each planned section to its source URLs / file paths.

---

### Phase 3: Plan file & user sign-off

Write a plan file covering:

- **Context** — why the user wants this, what the site enables
- **Audience profile** — explicit
- **Scope boundaries** — in and out, with the user's words
- **Tech stack decisions** — made in Phase 1
- **Site structure** — Part/Chapter hierarchy with short descriptions per section
- **Source bindings** — or a pointer to them from Phase 2
- **Execution phases** — concretely, how Phases 4–9 will be run for *this* project, including which sub-agents will be spawned and what each will own
- **Verification plan** — how Phases 6 & 7 will be executed

Present the plan to the user. Do not proceed to Phase 4 until the user explicitly signs off. This is the last cheap moment to restructure.

---

### Phase 4: Project bootstrap

Stand up a VitePress project with:

- Sidebar configured for the approved site structure
- Mermaid plugin configured (with the known-good Vite workaround — see `references/bootstrap-recipe.md`)
- KaTeX set up **if** Phase 1 decided math is needed (MathJax is incompatible with Vue's template compiler — see gotchas)
- Empty Markdown files for every planned chapter, with valid frontmatter
- A `STYLE_GUIDE.md` checked into the site itself (sub-agents read this before writing)
- A landing page that maps Part → Chapter → link

Read `references/bootstrap-recipe.md` for the complete recipe, including: the Mermaid dayjs fix, KaTeX plugin choice, YAML frontmatter rules that bite (colons in titles!), recommended `cleanUrls` behavior, and how to keep audit reports out of the build.

Verify: the skeleton builds with zero pages written, and the sidebar renders the full structure.

---

### Phase 5: Parallel writing

Dispatch one writing sub-agent per Part (or per logical chunk of work). Every agent gets the same core discipline via the prompt; only the file-ownership and per-Part content outline differ.

Read `references/writing-agent-template.md` for the full prompt skeleton and `assets/STYLE_GUIDE.template.md` for the style guide template the agents read.

Core discipline every agent gets:

- Must read `STYLE_GUIDE.md` before writing
- Must `WebFetch` primary sources before writing any factual claim
- API names, signatures, quoted text must be copied from primary sources verbatim — never reconstructed from memory
- Every Markdown file ends with a `## Sources` section listing specific URLs/files with `#section` anchors where possible
- Unverifiable claims carry an inline `> NOTE: unverified — needs confirmation` marker
- Every `##`-level section has at least one diagram if diagrams serve the reader (but diagrams must add structure, not paraphrase prose)
- **No touching files outside the agent's file list** (prevents clobber in parallel runs)
- **No running dev/build/deploy commands** (reserved for the orchestrating session)

Dispatch agents in **one parallel batch** (a single message with multiple subagent invocations) so they run concurrently. Do not wait between spawns.

---

### Phase 6: Build + link verification

After all writing agents complete:

1. Run the build. It will likely fail with dead-link errors — agents often typo cross-file paths (common: guessing filenames instead of using ones from the skeleton). Fix these by normalizing to the skeleton's filenames.
2. If your stack has a `check` / `format` / `lint` step, run it and fix formatting issues.
3. If the user's audit report file(s) live inside the docs tree, exclude them from the build (they contain path-like strings the link checker interprets as intra-site links). Use the VitePress `srcExclude` option.

A passing build is necessary but **not sufficient** — proceed to Phase 7.

---

### Phase 7: Browser verification

Start the dev server (in the background) and drive it with a browser automation MCP (Chrome DevTools MCP, Playwright MCP, etc.). Read `references/browser-verification.md` for the full checklist and exact probe patterns.

Must verify:

- **Console**: zero errors on the landing page and on at least one representative chapter page per Part
- **Mermaid**: SVGs with `id^="mermaid"` actually present in the DOM
- **Math** (if enabled): `.katex` spans render and have the KaTeX stylesheet loaded (check `document.styleSheets` for a `katex`-containing href)
- **Spot-check screenshots**: a page with complex math and a page with complex diagrams — look for obvious layout breakage

If any check fails, stop and fix the underlying config/plugin issue. **Do not declare Phase 7 done just because the build passed.** That was the #1 mistake in the reference engagement.

Stop the dev server when verification is complete; leave the environment in a state where the user can `docs:dev` themselves.

---

### Phase 8: External audit + fixes

Dispatch an independent reviewer — a different agent/LLM than the ones that wrote the content. Common choices: Codex (if available as an agent type), a fresh `general-purpose` agent with explicit instructions, or asking the user to run a second Claude instance. The key property is *independence* — the writer's blind spots are not the reviewer's.

Read `references/external-audit-template.md` for the audit prompt template.

Audit scope:

- **Structure**: is the Part/Chapter ordering sensible for the target audience? are there missing topics? redundancies?
- **Factual accuracy**: spot-check APIs/specs/versions against primary sources
- **Scope discipline**: is "common" content bleeding into "specific" sections (or vice versa, if the site has that split)?
- **Link & term integrity**
- **Unverified markers**: enumerate all `> NOTE: unverified` residuals — each is a debt
- **Diagram utility**: do diagrams help, or are they decorative?

The audit writes a report to a dedicated file classified into Critical / Major / Minor + remaining unverified markers.

After receiving the report:

- Dispatch targeted fix sub-agents for clusters of findings (e.g., one agent for all VST3-API-accuracy fixes across files, one for all Web-spec fixes, one for all unverified-marker resolutions). Each fix agent re-consults primary sources.
- After fixes, re-run Phases 6 and 7.
- Optionally run a **second audit round** with the same independent reviewer, narrowed to "verify prior findings are addressed and no new issues were introduced". Cap at 2 rounds to avoid infinite loops.

---

### Phase 9 (optional): Deployment config

Only if Phase 1 included a deploy target.

Read `references/deployment.md` for deployment-target specifics.

The single deployment gotcha worth stating upfront: if the project is managed with a **globally-installed CLI wrapper for scripts** (some toolchains do this), that CLI will not exist on deploy runners. The fix is to write the deploy config (e.g., `vercel.json`) with commands that go through the *project-local* binary directly rather than the global wrapper.

---

## Gotchas catalog

Read `references/gotchas.md` for the full catalog of issues encountered in prior engagements. Key items to know about upfront:

- **Mermaid + VitePress + dayjs**: silent dev-mode SyntaxError unless Vite optimizeDeps is configured
- **MathJax + Vue**: MathJax's SVG output contains `<style>` which Vue's template compiler refuses to render — KaTeX is the pragmatic path
- **`markdown-it-katex` version**: the old 2.x emits HTML structure incompatible with modern KaTeX CSS; use `@vscode/markdown-it-katex`
- **KaTeX CSS load timing**: theme-entry imports can be flaky with some hot-reload paths; `head` `<link>` to the CDN is the most reliable default
- **YAML frontmatter titles with colons**: `title: Part 0: Intro` breaks YAML; quote as `title: "Part 0: Intro"`
- **Writing agents typo filenames**: always catch in Phase 6 build; build-time dead-link detection is the safety net
- **Audit report files inside docs/**: absolute-path-looking strings confuse the link checker; exclude them from the build

---

## References & templates

- `references/interview-checklist.md` — Phase 1 question catalog with rationales
- `references/research-discipline.md` — primary vs. secondary source rules; per-domain source hierarchies
- `references/bootstrap-recipe.md` — the proven VitePress config with Mermaid + optional KaTeX
- `references/writing-agent-template.md` — sub-agent prompt skeleton for Phase 5
- `references/browser-verification.md` — Phase 7 DevTools probe patterns
- `references/external-audit-template.md` — Phase 8 auditor prompt
- `references/deployment.md` — deploy target specifics
- `references/gotchas.md` — full catalog of known issues with root causes
- `assets/STYLE_GUIDE.template.md` — style guide template to copy into the generated site
- `assets/vitepress-config.template.ts` — starting `config.ts` with Mermaid + optional KaTeX
- `assets/vercel.json.template` — deploy config template (if applicable)

---

## Reminders when executing

- The user has almost certainly thought about this topic longer than you have. Ask, don't tell.
- If the user says "just vibe" or "don't grill me", still pin down scope boundaries and audience before writing — those two decisions cause the most rework.
- Parallelize ruthlessly in Phase 5: one message, N sub-agents. Serial dispatch wastes wall-clock.
- When in doubt during Phase 7, screenshot and show the user. Build logs lie; rendered pixels don't.
- When the audit reports 30+ unverified markers, treat that as a signal that Phase 2 research was too shallow for that Part — consider re-research rather than one-by-one triage.
