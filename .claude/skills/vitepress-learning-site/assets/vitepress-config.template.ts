// VitePress config template with Mermaid + optional KaTeX.
// Copy into docs/.vitepress/config.ts and customize sections marked FILL.
//
// Keep the Vite and head blocks intact — they work around known issues
// (Mermaid dayjs pre-bundling, KaTeX CSS loading).
//
// If math is not enabled for this project, delete:
//   - the `markdownItKatex` import
//   - the `markdown.config` block
//   - the katex stylesheet `<link>` in `head`

import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
// Only if math is enabled:
import markdownItKatex from '@vscode/markdown-it-katex'

export default withMermaid(
  defineConfig({
    // FILL: site metadata
    title: '<Site title>',
    description: '<Short description of what this site is>',
    lang: '<BCP-47 tag, e.g., en-US or ja-JP>',

    lastUpdated: true,
    cleanUrls: true,

    // Exclude audit reports and other non-content Markdown from the build.
    // VitePress's link checker otherwise trips on absolute paths that appear
    // inside audit reports.
    srcExclude: ['AUDIT_REPORT.md', 'AUDIT_REPORT_ROUND2.md'],

    // Load KaTeX CSS via a `<link>` for reliability. Remove this block if
    // math is not enabled.
    head: [
      [
        'link',
        {
          rel: 'stylesheet',
          href: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
          crossorigin: 'anonymous',
        },
      ],
    ],

    // Wire KaTeX into markdown-it. Remove this block if math is not enabled.
    markdown: {
      config: (md) => {
        md.use(markdownItKatex.default ?? markdownItKatex)
      },
    },

    themeConfig: {
      // FILL: nav + sidebar from the approved Phase 3 plan.
      nav: [
        { text: 'Home', link: '/' },
        // ...
      ],
      sidebar: {
        '/': [
          // FILL with full Part/Chapter structure.
          // Example shape:
          // {
          //   text: "Part 0: Intro",
          //   collapsed: false,
          //   items: [
          //     { text: "Overview", link: "/00-intro/" },
          //     { text: "0.1 Purpose", link: "/00-intro/01-purpose" },
          //   ],
          // },
        ],
      },
      outline: { level: [2, 3], label: 'On this page' },
      search: { provider: 'local' },
      lastUpdatedText: 'Last updated',
    },

    // Mermaid plugin options
    mermaid: {
      theme: 'default',
    },
    mermaidPlugin: {
      class: 'mermaid-wrapper',
    },

    // Vite workaround for Mermaid + dayjs pre-bundling incompatibility.
    // Without this, dev mode throws:
    //   Uncaught SyntaxError: ... dayjs.min.js ... does not provide an export named 'default'
    vite: {
      optimizeDeps: {
        include: ['mermaid'],
      },
      ssr: {
        noExternal: ['mermaid'],
      },
    },
  }),
)
