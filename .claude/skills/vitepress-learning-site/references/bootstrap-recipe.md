# Phase 4: Bootstrap Recipe

This recipe is **framework-opinionated** (VitePress + Mermaid + optional KaTeX) but **toolchain-agnostic** (the skill does not prescribe a package manager, task runner, or Node version manager — pick whatever fits the project's conventions).

## Target layout

```
<project-root>/
├── package.json                    # with a script that invokes vitepress build on `docs`
├── docs/
│   ├── .vitepress/
│   │   ├── config.ts               # see assets/vitepress-config.template.ts
│   │   └── theme/
│   │       └── index.ts            # default theme re-export + optional CSS imports
│   ├── index.md                    # landing page
│   ├── STYLE_GUIDE.md              # see assets/STYLE_GUIDE.template.md
│   ├── <part-directory-per-Part>/
│   │   ├── index.md
│   │   └── <NN>-<slug>.md          # one per chapter
│   └── ...
└── .gitignore
```

Sidebar in `config.ts` is the single source of truth for navigation. The skeleton Markdown files exist precisely to keep sub-agents from having to invent paths.

## Dependencies to install

Exact package set (version-floats shown; real install should pin to latest compatible):

- **Required**: `vitepress`
- **Required for diagrams**: `mermaid`, `vitepress-plugin-mermaid`
- **Required if math was decided in Phase 1**: `@vscode/markdown-it-katex`, `katex`
- **Not required**: `markdown-it-mathjax3` (breaks Vue — see gotchas), `markdown-it-katex` (the old 2.x package — incompatible with modern KaTeX CSS — see gotchas)

## VitePress config essentials

Read `assets/vitepress-config.template.ts` for a copy-paste starting point. Key decisions encoded there:

- `cleanUrls: true` — inter-page links omit the `.md` extension. Configure the skeleton and writing agents to match.
- `lastUpdated: true` — shows last-commit date per page, useful for learners tracking how fresh content is.
- `srcExclude` for audit report files (they often contain absolute paths that look like links to the link checker).
- Sidebar: fully spelled out at Phase 4 time (not collapsible `auto`) so the whole structure is visible to the user.

## The Mermaid dayjs gotcha

Without configuration, dev-mode will throw:

> Uncaught SyntaxError: The requested module '/@fs/.../dayjs/dayjs.min.js?v=...' does not provide an export named 'default'

This happens because Vite pre-bundles Mermaid's `dayjs` dependency in a way that breaks its ESM default-import.

**Fix** — add to `config.ts` under `vite`:

```ts
vite: {
  optimizeDeps: {
    include: ["mermaid"],
  },
  ssr: {
    noExternal: ["mermaid"],
  },
},
```

Then clear `docs/.vitepress/cache` and the Vite cache under `node_modules/.vite` before the next dev run.

This is a pure dev-mode issue — production builds are unaffected — which is exactly why it must be caught during Phase 7 browser verification, not just Phase 6 build.

## Math setup (KaTeX)

Use `@vscode/markdown-it-katex` (the actively-maintained fork). The older `markdown-it-katex` 2.x emits HTML from pre-0.10 KaTeX and is incompatible with modern `katex.min.css`.

In `config.ts`:

```ts
import markdownItKatex from "@vscode/markdown-it-katex";

// ...

markdown: {
  config: (md) => {
    md.use(markdownItKatex.default ?? markdownItKatex);
  },
},
```

**Do not use** `markdown: { math: true }` — this path through VitePress invokes `markdown-it-mathjax3`, which emits `<style>` tags inside SVGs. Vue's template compiler refuses side-effect tags in component templates and the dev server returns 500.

## KaTeX CSS — load via `<link>` in `head`

Importing `katex/dist/katex.min.css` from the theme entry can be flaky with VitePress's hot reload path — the CSS sometimes appears to be excluded from the module graph and math renders positioning-broken without throwing a diagnostic. The reliable default is a CDN `<link>` in `head`:

```ts
head: [
  [
    "link",
    {
      rel: "stylesheet",
      href: "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css",
      crossorigin: "anonymous",
    },
  ],
],
```

If offline-first is required, ship the CSS from the site's `public/` and link it locally — still prefer a `<link>` over a theme-entry import.

## Frontmatter gotcha (yaml colon)

`title: Part 0: Intro` is invalid YAML (the second `:` starts a mapping). The skeleton creator must **always quote** titles:

```yaml
---
title: "Part 0: Intro"
---
```

When building the skeleton programmatically with `sed`/text generation, write the frontmatter with quotes unconditionally. If titles are added later via bulk rewrites, post-process to wrap in quotes.

## .gitignore starter

```
node_modules
docs/.vitepress/cache
docs/.vitepress/dist
*.log
.DS_Store
```

## Skeleton verification before Phase 5

Before dispatching writing agents, confirm:

1. A fresh build completes with zero dead-link errors. If the skeleton files cross-reference each other, those links must resolve.
2. The dev server starts cleanly with no Mermaid-related dayjs errors in the browser console.
3. A skeleton page containing `$a + b$` math renders as a KaTeX-positioned equation (if math was enabled).
4. The sidebar shows every Part and every chapter in the planned structure.

If any of these fail, fix them in Phase 4 — do not start Phase 5 on a broken foundation.

## Deployment-time vp × VitePress note

If (and only if) the project ends up using VitePlus (`vp`) as its task runner, note that `vp` is a *globally-installed* CLI. Hosted build runners (Vercel, Netlify, etc.) do not have `vp` on PATH. Scripts that read `"docs:build": "vp exec vitepress build docs"` will fail there.

The workaround is to write the deploy config's `buildCommand` with the *project-local* invocation path directly (e.g., going through the host's supported package-manager `exec` facility) rather than through the `vp` wrapper. Phase 9 deployment config handles this.

No other toolchain interaction between VitePlus and VitePress is known to cause issues — the dev loop, build, and check commands all work normally.
