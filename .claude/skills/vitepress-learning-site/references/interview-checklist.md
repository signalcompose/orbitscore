# Phase 1 Interview Checklist

Use this as a question bank. You do not need to ask every question of every user — pick the ones that are actually ambiguous in their initial message. Prefer `AskUserQuestion` for decisions with multiple plausible answers; prefer plain text back-and-forth for open-ended exploration.

Pin down these dimensions before writing the plan. Open-ended topics drift; the interview's job is to commit.

## 1. Topic definition and motivation

**Why pin this down:** The motivation shapes what's "enough." Someone who wants the site as a career reference needs different depth from someone using it to unblock a specific PoC. A motivation question often unlocks a scope question.

- What is the topic, in one sentence the user would actually say?
- What triggered the decision to learn it *now*? Is there an ongoing project this supports?
- Is there an adjacent topic the user *explicitly* doesn't want to learn here (signals scope boundaries)?

## 2. Scope boundaries

**Why pin this down:** Scope drift is the #1 cause of site sprawl. If "just touch on Y" survives the interview unexamined, it will consume disproportionate effort.

- What's *in*? List the sub-topics at Part-level granularity.
- What's *out*? Explicitly — make the user say it. If they hedge ("maybe also Y?"), force a decision: commit Y or defer Y.
- Is this a single-shot build or a living reference? (Affects how aggressively to document "requires further research" gaps.)

## 3. Audience

**Why pin this down:** Determines the prerequisite floor and every initial explanation's depth. "For an engineer with Go experience but no audio background" is a very different brief from "for a musician learning to code."

- Who reads this site? (self only? team? public?)
- What do readers already know? (prior languages, domains, frameworks)
- What do readers explicitly *not* know? (this is often more useful than the positive set)
- Reading order: linear (chapters in order) or browsing (self-contained chapters)?

## 4. Content language(s)

**Why pin this down:** Affects writing style, subagent prompts, and whether to set up i18n infrastructure in VitePress.

- What language is the site written in?
- If multiple: bilingual pages? or one language per section? (VitePress i18n adds non-trivial overhead; default to single-language unless explicitly needed.)

## 4.5. Voice and tone

**Why pin this down:** This is **not cosmetic**. A warm "sempai" register on a site meant for a terse senior engineer feels condescending; a dry spec register on a site meant for an anxious beginner reads as cold. Different readers want different tones and you cannot infer which from the topic alone — **ask**.

**Always ask this with `AskUserQuestion`.** Do not default. Present a small spectrum:

- **Dry / spec-grade** — No filler, no "let's...", no reader-addressing. Statements of fact. Appropriate for experienced audiences or reference material.
- **Neutral-technical** — Polite, no emojis, no warmth markers, but complete sentences and some scaffolding ("This section covers..."). The current "professional documentation" default.
- **Warm / sempai** — "Let's go through this together", "this is a common stumbling block", "don't worry if this doesn't click yet". Good for self-taught beginners and internal team onboarding docs.
- **Custom / user-described** — Let the user describe the register in their own words.

Record the choice. The STYLE_GUIDE §2 must encode the chosen register concretely with "Good" and "Bad" examples so every writing sub-agent stays consistent. Do NOT let agents interpret "friendly" or "warm" ad-hoc — they will overshoot.

Tone also interacts with time-relative language and emotional hedges. The "dry" end forbids both; the "warm" end allows hedges like "this might feel counterintuitive" but still forbids marketing adjectives ("powerful", "elegant"). Spell this out in the STYLE_GUIDE.

## 5. Depth and density

**Why pin this down:** "Write me a 3-paragraph intro to X" and "write me a 20-chapter reference" are different products.

- Roughly how many Parts / chapters does the user envision? (Push back if numbers seem wildly off for scope.)
- Per chapter: skim-depth (~500 words) or spec-grade (~2000+ words)?
- For any section, what level of primary-source rigor? (Cite URLs? Quote spec language? Copy API signatures?)

## 6. Math rendering

**Why pin this down:** Math tooling in VitePress has real gotchas (see `gotchas.md`). Decide *once* upfront and configure cleanly; adding math later means reconfiguring the Vue compiler interaction.

- Will the content include mathematical notation beyond basic unicode (Σ, √, etc.)?
- If yes → KaTeX with the known-good plugin. MathJax conflicts with Vue's template compiler.
- If no → skip math setup entirely.

## 7. Visuals: diagrams, illustrations, animations, interactivity

**Why pin this down:** Visual budget is a **first-class decision**, not an afterthought. "35 chapters of pure text" and "35 chapters with embedded interactive demos" are radically different products and need very different agent prompts. Get this right upfront.

Visual tiers (present these to the user as a progression, not a binary):

1. **Mermaid diagrams** — cheapest. Good for flowcharts, sequences, class relationships, state machines. Default baseline for "structural / relational / temporal" content.
2. **Hand-authored SVG illustrations** — for metaphors, side-by-side comparisons, layered diagrams, timelines — anything Mermaid's box-and-arrow grammar forces into an awkward shape. Write `<svg>` inline in Markdown. Note VitePress/Vue gotcha: no `<style>` tags inside the SVG (Vue compiler rejects side-effect tags); use inline `style=""` attributes or classes targeted from a global CSS file.
3. **SMIL animations** — `<animate>` / `<animateTransform>` inside SVG. Lightweight; no JS. Good for "a value flows through these boxes in sequence" or "this state switches back and forth".
4. **Vue components for live demos** — the highest-value tier. Whenever a concept is "you only get it when you touch it" — state transitions, re-render cycles, diff/reconciliation, snapshot semantics, data flow, list key drift, prop drilling, CSS-in-JS behavior, cache behavior, suspense/loading states — a Vue component embedded in the chapter is usually more educational than any amount of prose. Local `<script setup>` imports from `docs/.vitepress/theme/components/<partSlug>/Name.vue` work without touching `theme/index.ts`. No global registration needed.

**Ask the user with `AskUserQuestion`:**

- How heavily do they want visuals? (Occasional Mermaid / frequent Mermaid / Mermaid + SVG / all tiers including Vue components)
- Are they OK with a longer build where writers are instructed to **actively propose and implement interactive Vue demos per chapter**, or is that over-budget?
- Are there specific topics where they already know "this would be great as a demo"?

**Do NOT default to "prose + occasional Mermaid".** That is the floor, not a reasonable default. For topics with many "aha-when-you-touch-it" concepts (React, state machines, Git internals, audio DSP with live signal processing, SQL query plans, type systems), pushing the user toward tier 4 is often the right call. Writers given clear "each chapter should evaluate if an interactive demo fits" instructions produce much better output than writers told "add diagrams if helpful".

**Complexity budget caveat:** Vue components multiply engineering work. If time or token budget is tight, state that up front and scale tiers down together with the user.

## 8. Bridge / application chapter

**Why pin this down:** In past engagements this was the single most useful chapter — mapping the topic being learned to the user's actual project. It forces the writing to answer "so what?" rather than stopping at explanation.

- Is there an adjacent technology, project, or context where the user will *apply* this knowledge?
- Should the site include a dedicated chapter mapping this topic's concepts to that context?
- If yes, rough axes of the mapping: concept → concept? API → API? decision table?

## 9. External audit

**Why pin this down:** The audit is Phase 8 and the best insurance against factual drift. Default to yes. Defaulting to no is reasonable only if the user is testing the skill or has time pressure.

- Run an independent audit pass at the end?
- If yes, any preference for reviewer tooling? (e.g., "use Codex if available")
- Tolerance for a second audit round if Critical/Major count is high?

## 10. Primary-source preferences

**Why pin this down:** For some topics the user already knows *the* canonical sources. Saving the writing agents time discovering them themselves is a pure win.

- Any specific specs, books, repositories, or documentation sites that should be treated as authoritative?
- Any source that should *not* be used? (e.g., "don't cite the community wiki — it's full of misinformation")

## 11. Deployment

**Why pin this down:** Deployment is optional but if it's on the user's mind, setting up config early lets them verify continuously. If it's not, don't invent it.

- Will the site be deployed, or is it local-only for the user's reference?
- If deployed: which platform?
- Expected visibility: public, private, organization-scoped?

## 12. Constraints

**Why pin this down:** Different constraints trigger different shortcuts.

- Wall-clock budget? (Affects how many parallel writing agents to dispatch vs. how deep to make each.)
- Single session or expected to span sessions? (Affects whether plan file needs to be self-contained for a future resumer.)
- Any "I already know X — skim it" instructions that can compress Part sizes?

---

## Interview anti-patterns

- **Asking everything upfront as a giant form.** Ask progressively; earlier answers re-frame later questions.
- **Accepting "I don't know" on scope.** That *is* an answer — but then the plan must reflect that the boundary is tentative, and the writing agents must be primed to flag scope drift back to the user.
- **Skipping the motivation question.** It is the most context-dense single question.
- **Confirming the plan before the user has seen it.** Write the plan file, show it, *then* ask.
- **Proposing specific libraries/tools before the user has framed scope.** The reverse is correct: scope first, then the implementation agent picks tools to match.
