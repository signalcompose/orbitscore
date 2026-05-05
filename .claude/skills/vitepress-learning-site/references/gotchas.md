# Gotchas Catalog

Issues encountered when building real VitePress learning sites, with root cause and fix. Triage this list before Phase 4 bootstrap; return to it during Phase 6/7 when verification fails.

---

## 1. Mermaid + VitePress: dayjs "does not provide an export named 'default'"

**Symptom**: Dev-mode browser console shows

> Uncaught SyntaxError: The requested module '/@fs/.../dayjs/dayjs.min.js?v=...' does not provide an export named 'default'

**Why**: Mermaid's dayjs dependency gets pre-bundled by Vite in a way that breaks its ESM default-import. Production build is unaffected; only dev-server is broken.

**Fix**: In `config.ts` Vite options:

```ts
vite: {
  optimizeDeps: { include: ["mermaid"] },
  ssr: { noExternal: ["mermaid"] },
},
```

Clear `docs/.vitepress/cache` and `node_modules/.vite` before next dev run.

---

## 2. MathJax + Vue: "Tags with side effect (<script> and <style>) are ignored"

**Symptom**: Dev server returns 500. Log shows:

> [vitepress] Internal server error: Tags with side effect (<script> and <style>) are ignored in client component templates.

on any page with math (even a simple `$A + B$`).

**Why**: `markdown: { math: true }` in VitePress uses `markdown-it-mathjax3`. MathJax emits `<style>` tags inside its SVG output (for intra-math styling). Vue's template compiler refuses to render templates containing side-effect tags.

**Fix**: Do not use `markdown: { math: true }`. Use `@vscode/markdown-it-katex` instead:

```ts
import markdownItKatex from "@vscode/markdown-it-katex";

markdown: {
  config: (md) => {
    md.use(markdownItKatex.default ?? markdownItKatex);
  },
},
```

Setting `vue.template.compilerOptions.isCustomElement` to allow `mjx-*` tags is **not** sufficient — the `<style>` rejection happens before custom-element consideration.

---

## 3. `markdown-it-katex` (the old 2.x package)

**Symptom**: Math appears in the DOM (as `.katex` spans), but positioning is broken — subscripts float on new lines, radicals disconnect from radicands, display math is misaligned.

**Why**: `markdown-it-katex` 2.0.3 emits HTML structured for pre-0.10 KaTeX. Modern `katex.min.css` has different class names and rules; the old HTML no longer styles correctly.

**Fix**: Use `@vscode/markdown-it-katex` (actively maintained, emits modern KaTeX HTML) instead of `markdown-it-katex`.

---

## 4. KaTeX CSS not loading from theme entry

**Symptom**: `.katex` elements present but rendering broken. `document.styleSheets` does not include a katex-related href.

**Why**: Importing `katex/dist/katex.min.css` from `docs/.vitepress/theme/index.ts` can be flaky with VitePress's hot reload — the CSS sometimes isn't included in the module graph under certain module resolution paths.

**Fix**: Load the CSS via a `<link>` in `head`:

```ts
head: [[
  "link",
  {
    rel: "stylesheet",
    href: "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css",
    crossorigin: "anonymous",
  },
]],
```

For offline sites, ship the CSS from `public/` and point the `<link>` to the local path.

---

## 5. YAML frontmatter titles with colons

**Symptom**: Build fails with

> [vitepress] incomplete explicit mapping pair; a key node is missed

**Why**: YAML parses the second `:` in `title: Part 0: Intro` as a key-value separator. The title value is invalid.

**Fix**: Always quote titles:

```yaml
---
title: "Part 0: Intro"
---
```

Enforce this at skeleton-generation time. If you're creating frontmatter via text concatenation, quote unconditionally. For bulk renames later, post-process.

---

## 6. Writing agents typo cross-file paths

**Symptom**: Phase 6 build fails with "Found dead link" for paths like `./../01-foundations/07-audio-io` when the actual file is `07-io-drivers.md`.

**Why**: Agents don't read the skeleton — they guess filenames from the topic name. "audio-io" sounds right for a chapter on I/O drivers, but the skeleton chose "io-drivers".

**Fix**:

- In writing-agent prompts, include the list of skeleton filenames or instruct the agent to ground cross-links in the plan's structure table.
- Use build-time dead-link checking (default in VitePress) as the safety net. Do not disable it.
- Normalize common typos with `sed` before re-running the build.

---

## 7. Audit reports inside `docs/` trip the link checker

**Symptom**: After writing an audit report with absolute file paths like `docs/04-vst3-sdk/14-validator.md:49`, the build fails on dead links in the audit file.

**Why**: VitePress's link checker interprets `docs/...md:49` as a relative link and resolves it from the current file's location. The resolution fails because the path doesn't exist relative to the audit file.

**Fix**: Exclude audit reports from the build:

```ts
srcExclude: ["AUDIT_REPORT.md", "AUDIT_REPORT_ROUND2.md"],
```

---

## 8. Port-collision ghost: stale dev server on same port

**Symptom**: After restarting the dev server, browser shows 500 + connection-refused errors on page loads. Dev log says `Port 5173 is in use, trying another one...` and new server is actually on a different port.

**Why**: Previous dev server process wasn't fully killed; the new server falls through to a higher port; the browser still points at the old port; old port is half-dead.

**Fix**: When restarting dev, explicitly kill the previous background task (`TaskStop` or the session's equivalent). Pick a known port and assert the server came up on *that* port before directing the browser there.

---

## 9. Codex (or similar external reviewer) returns empty output on first invocation

**Symptom**: Audit agent completes, returns a summary but didn't actually write the audit report file.

**Why**: External-reviewer agents sometimes execute the check-work steps but skip the file-write step when the instruction is implicit. Happens more with compressed prompts.

**Fix**: In the audit prompt, include explicit and redundant "MUST write to this file" instructions:

> Your output is **only** the report file at <path>. Before concluding, verify via `Read` that the file exists and contains your report. If empty, write it now.

If the first pass returns empty, re-invoke with the same prompt plus "earlier run produced no file; write now". Do not accept success without verifying the file exists.

---

## 10. BSD sed vs GNU sed; macOS bash 3.2

**Symptom**: Text-manipulation scripts that work on Linux fail on macOS. Common failures:

- `sed -i 's/a/b/g' file` fails ("extra characters at the end of command") — BSD sed requires a backup extension: `sed -i '' 's/a/b/g' file`
- `sed 's/\bfoo\b/bar/g'` matches literally `\bfoo\b` — BSD sed doesn't support `\b` word boundaries
- `declare -A` fails in `/bin/bash` on macOS — bash 3.2 (default) doesn't support associative arrays

**Fix**:

- For portable sed: use `perl -pi -e '...'` or GNU sed via `gsed` (homebrew).
- For word boundaries: use `[^A-Za-z0-9_]` or explicit surrounding-char patterns.
- For associative arrays on macOS: use `/opt/homebrew/bin/bash` (bash 5.x) or avoid them (use plain arrays with `key=val` entries).

When running one-off scripts during skeleton generation or bulk rewrites, it's almost always simpler to delegate to a real scripting language (`python -c`, `node -e`) than to fight portable shell.

---

## 11. Global CLI wrapper not present on deploy runners

**Symptom**: Deployment build fails with "command not found" on the tool used in `scripts.build`.

**Why**: Some toolchains use a globally-installed CLI (e.g., VitePlus's `vp`) as the task runner. The global CLI is not installed in Vercel/Netlify/Cloudflare build images.

**Fix**: Write deploy config (`vercel.json`, etc.) with commands that go through the project-local package manager directly:

```json
{
  "buildCommand": "pnpm exec vitepress build docs",
  "outputDirectory": "docs/.vitepress/dist"
}
```

See `deployment.md` for platform-specific guidance.

---

## 12. Phase 7 skipped because Phase 6 passed

**Symptom**: User reports broken math / missing diagrams / console errors after the site is declared complete. Phases passed on a green build.

**Why**: The orchestrator interpreted "build complete" as "done". Build success proves the static bundle was generated; it does not prove the browser renders it correctly. See Phase 7 for what build cannot catch.

**Fix**: Never skip Phase 7. It takes minutes with a browser automation MCP; it catches hours-of-debugging-later issues.

---

## 13. Plan mode not exited before writing

**Symptom**: You're "in plan mode" (either literally in Claude's plan mode, or a stateful "I said I'd plan first" self-commitment) and the user expects execution. You continue writing a plan instead of bootstrapping.

**Fix**: After Phase 3 sign-off, explicitly exit plan mode and proceed to Phase 4. In Claude Code, `ExitPlanMode` is the mechanism. In other environments, just state "proceeding to bootstrap" and act.

---

## 14. Hearing mode skipped with "I have enough context"

**Symptom**: Writing agents produce content that misses the user's actual goal. Audit finds many scope-bleed issues or wrong-depth content.

**Why**: The orchestrator inferred the user's intent from the initial message and skipped the interview. The initial message is almost always under-specified.

**Fix**: Even if you think you know what the user wants, confirm scope boundaries and audience before writing. Two minutes of grilling saves hours of rework.

---

## 15. Over-aggressive removal during audit fixes

**Symptom**: Audit says "Part 3 has many unverified markers". Fix agent reads that as "delete unverified claims" and produces a Part 3 that's skeletal and useless.

**Why**: "unverified" doesn't mean "wrong"; it means "not yet verified". The correct resolution is to *verify* (fetch primary source), not to delete.

**Fix**: Fix-agent prompts must say: "For each unverified marker, first attempt to verify by fetching the primary source. Only delete the claim if verification is impossible *and* the claim cannot be rewritten to an uncontroversial form." Give the agent budget to spend on verification.

---

## 16. "Empty output" from audit is actually success

**Symptom**: Codex audit reports "no new issues found" — orchestrator interprets this as the audit failing.

**Fix**: A clean second-round audit is success. Check that the report file exists and contains the "residual Critical / Major: 0" line before treating emptiness as a failure.

---

## 17. SVG text overflow goes undetected without real measurement

**Symptom**: Hand-authored SVG diagrams look OK in a quick screenshot but CJK (or long English) text labels actually extend past their containing `<rect>`. Readers see text bleeding past box edges.

**Why**: Writers (including LLM writers) draft SVGs with conservative-feeling widths (rect `width=160`, label `font-size=13`), then drop in a Japanese string like "Counter 関数（再呼び出し）" that takes ~14 glyphs × ~15px = 210px. The browser doesn't warn; the page still renders. The SVG bounding box logic doesn't report it either, because the text node's bbox is fine — only the text's right edge exceeds its conceptual parent rect.

**Fix**: During Phase 7 browser verification, run a DOM measurement that cross-checks each text node against its presumed container rect:

```js
// Pseudocode — adapt to your browser MCP
for (const svg of document.querySelectorAll('.vp-doc svg')) {
  const rects = [...svg.querySelectorAll('rect')];
  const texts = [...svg.querySelectorAll('text')];
  for (const r of rects) {
    const rb = r.getBoundingClientRect();
    for (const t of texts) {
      const tb = t.getBoundingClientRect();
      const tCx = (tb.left + tb.right) / 2;
      const rCx = (rb.left + rb.right) / 2;
      const vertInside = tb.top >= rb.top - 5 && tb.bottom <= rb.bottom + 20;
      const horizAligned = Math.abs(tCx - rCx) < 40;
      if (horizAligned && vertInside && (tb.right > rb.right + 1 || tb.left < rb.left - 1)) {
        // overflow — collect for fix
      }
    }
  }
}
```

Then either widen the container `<rect>` or shorten the label. Writers should be told up front: **CJK full-width ≈ 13–15px per glyph at `font-size=13`; English ≈ 6–7px per half-width char**. Budget widths before drafting, not after.

Never accept an SVG from an agent without this measurement pass. "Looks fine in screenshot" is not sufficient — the user will notice once they read the site.

---

## 18. Vue component global registration vs. local import — prefer local

**Symptom**: Writing agents working on different Parts in parallel both want to register Vue components in `docs/.vitepress/theme/index.ts`. Merge conflicts happen inside a single session even without git.

**Fix**: Use **local `<script setup>` imports** in the Markdown file itself:

```markdown
---
title: "..."
---

<script setup>
import MyDemo from '../.vitepress/theme/components/p3/MyDemo.vue'
</script>

# Chapter

<MyDemo />
```

VitePress supports this first-class. Agents never need to touch `theme/index.ts`, so parallel writing has zero global-state contention. Instruct every writer in their prompt: "Create Vue components at `docs/.vitepress/theme/components/<partSlug>/Name.vue`; import them locally via `<script setup>` in the Markdown file; do NOT edit `theme/index.ts`."

---

## 19. Agent defaults to "mostly prose with occasional diagrams"

**Symptom**: Writers given "add diagrams where helpful" produce 40 chapters of prose with 1 Mermaid box-and-arrow per chapter and no Vue components, even when the topic screams for interactive demos (state machines, diffs, reconciliation, etc.).

**Why**: LLMs default to prose-and-diagrams because that is the modal form of technical writing in their training data. "Interactive demo" requires writing real Vue code, which is higher-effort; without explicit permission + expectation, they skip it.

**Fix**: The writing-agent prompt template must **explicitly require** a 4-tier visual evaluation per chapter: Mermaid (baseline) → SVG (when Mermaid can't express) → SMIL animation → Vue component (for "touch to understand" concepts). Force the agent to report, in its completion message, which tier was chosen for each chapter and — if Tier 4 was skipped — a one-line reason. That reporting requirement alone raises Tier-4 adoption noticeably.

For the orchestrator: during interview, actively push the user toward Tier 4 for topics where it fits (state, data flow, diffs, caches). Do not default to "Tier 1 only" — it is a floor, not a baseline.

---

## 20. Assuming the tone instead of asking

**Symptom**: Writers produce either (a) dry-technical prose for a user who wanted warm-sempai, or (b) overly chatty warm-sempai prose for a user who wanted spec-grade. Both feel wrong.

**Why**: The previous skill version had "neutral prose" hard-coded in the STYLE_GUIDE template. Tone was treated as a constant, not as a user-facing decision.

**Fix**: Interview §2.5 (tone) is a required question with `AskUserQuestion`. Present at least three presets (dry-spec / neutral-technical / warm-sempai) plus "custom". Then the STYLE_GUIDE encodes the chosen register concretely with Good/Bad examples, so writers don't drift.

If the user picks warm-sempai, cap warmth markers at 2–3 per chapter in the STYLE_GUIDE — unbounded warmth drifts into cheerleading fast.
