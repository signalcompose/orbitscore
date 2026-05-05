import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import markdownItKatex from '@vscode/markdown-it-katex'
import { sidebar } from './sidebar'

export default withMermaid(
  defineConfig({
    title: 'OrbitScore Dev',
    description: 'OrbitScore 実装解説・学習サイト (個人学習ノート)',
    lang: 'ja-JP',

    lastUpdated: true,
    cleanUrls: true,

    srcExclude: ['STYLE_GUIDE.md', '**/.audit/**', '**/AUDIT_REPORT*.md'],

    head: [
      [
        'link',
        {
          rel: 'stylesheet',
          href: 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css',
          crossorigin: 'anonymous',
        },
      ],
    ],

    markdown: {
      config: (md) => {
        // @vscode/markdown-it-katex は CommonJS / ESM 両対応のため default 経由で参照
        md.use((markdownItKatex as { default?: unknown }).default ?? markdownItKatex)
      },
    },

    themeConfig: {
      nav: [
        { text: 'Home', link: '/' },
        { text: 'Glossary', link: '/glossary' },
        {
          text: 'Repo',
          link: 'https://github.com/signalcompose/orbitscore',
        },
      ],
      sidebar,
      outline: { level: [2, 3], label: 'On this page' },
      search: { provider: 'local' },
      lastUpdatedText: '最終更新',
      docFooter: {
        prev: '前のページ',
        next: '次のページ',
      },
    },

    mermaid: {
      theme: 'default',
    },
    mermaidPlugin: {
      class: 'mermaid-wrapper',
    },

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
