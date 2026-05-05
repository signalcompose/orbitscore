# Phase 7: Browser Verification

Build success is not correctness. This phase catches:

- Dev-mode JS errors that don't fire during the production build (Mermaid/dayjs, AudioWorklet, etc.)
- Silent rendering failures (math positioning broken, SVG missing, fonts not loaded)
- Runtime errors from third-party scripts (analytics, CDN assets, etc.)
- Broken theme overrides

Run it on every site. Not optional.

## Tools

Any browser-automation MCP works. Common options:

- `mcp__chrome-devtools__*` — Chrome DevTools MCP, gives console + network + evaluate
- `mcp__Claude_in_Chrome__*` — similar surface, different control API
- Playwright MCP, `agent-browser` skill — viable alternatives

Pick whichever the session provides. The probes below are tool-agnostic pseudocode; translate to the actual MCP.

## Probe sequence

### 1. Start dev server in background

Start the project's dev command with `run_in_background: true`. Wait for the server to be responsive (poll `curl http://localhost:<PORT>/` until HTTP 200) before opening a browser.

Do not poll with fixed sleeps — use a `Monitor`-style "until ready" loop if available.

### 2. Navigate to landing page, check console

```
navigate(url: "http://localhost:<PORT>/")
list_console_messages(types: ["error", "warn"])
```

**Must see**: zero errors. Zero. Warnings are case-by-case (`<Suspense> is experimental` is VitePress default and ok).

**If errors**: do not proceed. Fix the root cause. Common error classes:

- `does not provide an export named 'default'` on dayjs → Mermaid optimizeDeps missing (see gotchas)
- `500 Internal Server Error` + `Tags with side effect` → you used `markdown-it-mathjax3`; switch to `@vscode/markdown-it-katex` (see gotchas)
- `Failed to load module script: MIME type` + connection refused → previous dev process on the same port; kill and restart

### 3. Navigate to a representative chapter, check console + DOM

Pick a chapter with Mermaid and (if enabled) math. Navigate there. Re-check console.

```
navigate(url: "http://localhost:<PORT>/<Part>/<Chapter>")
list_console_messages(types: ["error"])
evaluate_script(fn: () => ({
  mermaidSvgs: document.querySelectorAll('svg[id^="mermaid"]').length,
  katex: document.querySelectorAll('.katex').length,
  katexDisplay: document.querySelectorAll('.katex-display').length,
  hasKatexCss: [...document.styleSheets].some(s => {
    try { return s.href && s.href.includes('katex'); } catch { return false; }
  }),
}))
```

**Assertions**:
- `mermaidSvgs >= 1` if the chapter has diagrams
- `katex >= 1` and `hasKatexCss === true` if math is enabled and the chapter contains math
- Zero console errors

### 4. Screenshot a math-heavy or diagram-heavy page

Visually confirm math layout. A common subtle failure: KaTeX renders without its stylesheet, producing weird positioning (subscripts on new lines, surds disconnected from radicands). The DOM says "math is there", the screenshot says "the math is unreadable".

```
evaluate_script(fn: () => {
  const h = [...document.querySelectorAll('h2')].find(e => /* a specific heading near math */);
  if (h) h.scrollIntoView({block: 'start'});
})
take_screenshot()
```

Look at the screenshot. If subscripts, superscripts, radicals, or fractions look disjointed, KaTeX CSS is missing or mismatched. Go back to the bootstrap recipe.

### 5. Sample-check network requests for fonts and CSS

```
list_network_requests(resourceTypes: ["font", "stylesheet"])
```

Look for 404s or request failures. A 404 on `KaTeX_Main-Regular.woff2` means the KaTeX CSS is loading but fonts aren't, which the rendered output reveals as fallback-font layout.

### 6. Stop the dev server

After verification, stop the background task. Leave the environment in a state where the user can start the dev server themselves without collisions.

## Failure modes and fixes

| Symptom in browser | Root cause | Fix |
|--------------------|------------|-----|
| `does not provide an export named 'default'` for dayjs | Mermaid pre-bundling | `optimizeDeps.include: ['mermaid']` + `ssr.noExternal: ['mermaid']` |
| `Tags with side effect (<script> and <style>) are ignored` 500 | MathJax via `math: true` | Replace with `@vscode/markdown-it-katex` |
| Math renders but subscript/superscript misplaced | `markdown-it-katex` v2.x (old) or missing KaTeX CSS | Use `@vscode/markdown-it-katex` + CDN `<link>` in `head` |
| `.katex` count is 0 on a page with `$...$` | Math plugin not wired up | Check `md.use(markdownItKatex...)` in `markdown.config` |
| Mermaid SVG count is 0 on a page with ```mermaid | withMermaid not wrapped around `defineConfig` | Re-check `config.ts` |
| 500 error + connection refused to earlier port | Previous dev process alive or port moved | Kill background tasks, restart on known port |
| Custom theme CSS not loading | `docs/.vitepress/theme/index.ts` not exporting default | Must `export default DefaultTheme` (or an extension) |

## When to re-run browser verification

- After every Phase 6 fix that touches config or plugins
- After Phase 8 audit findings applied (even if they're purely content — builds can regress)
- After any dependency change

Skipping this phase is the single most reliable way to ship broken output. Build passes; browser doesn't; you find out from the user.
