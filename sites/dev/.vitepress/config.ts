import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import markdownItKatex from '@vscode/markdown-it-katex'
import { sidebarJa, sidebarEn } from './sidebar'

const SITE_BASE = '/orbitscore/dev/'

export default withMermaid(
  defineConfig({
    title: 'OrbitScore Dev',
    description: 'OrbitScore 実装解説・学習サイト (個人学習ノート)',
    lang: 'ja-JP',

    base: SITE_BASE,

    lastUpdated: true,
    cleanUrls: true,

    srcExclude: [
      'STYLE_GUIDE.md',
      'README.md',
      '.translation-glossary.md',
      'en/STYLE_GUIDE.md',
      '**/.audit/**',
      '**/AUDIT_REPORT*.md',
    ],

    // KaTeX CSS は public/katex/ に同梱して local link で読み込む。
    // CDN 依存 (cdn.jsdelivr.net) を排除し、飛行機内やオフライン環境
    // でも数式が崩れず表示できるようにする。
    head: [
      [
        'link',
        {
          rel: 'stylesheet',
          href: `${SITE_BASE}katex/katex.min.css`,
        },
      ],
    ],

    markdown: {
      config: (md) => {
        // @vscode/markdown-it-katex は CommonJS / ESM 両対応のため default 経由で参照
        md.use((markdownItKatex as { default?: unknown }).default ?? markdownItKatex)
      },
    },

    locales: {
      root: {
        label: '日本語',
        lang: 'ja-JP',
        title: 'OrbitScore Dev',
        description: 'OrbitScore 実装解説・学習サイト (個人学習ノート)',
        themeConfig: {
          nav: [
            { text: 'Home', link: '/' },
            { text: 'Glossary', link: '/glossary' },
            {
              text: 'Repo',
              link: 'https://github.com/signalcompose/orbitscore',
            },
          ],
          sidebar: sidebarJa,
          outline: { level: [2, 3], label: 'このページの目次' },
          lastUpdatedText: '最終更新',
          docFooter: {
            prev: '前のページ',
            next: '次のページ',
          },
        },
      },
      en: {
        label: 'English',
        lang: 'en-US',
        link: '/en/',
        title: 'OrbitScore Dev',
        description: 'OrbitScore implementation notes (personal learning notes)',
        themeConfig: {
          nav: [
            { text: 'Home', link: '/en/' },
            { text: 'Glossary', link: '/en/glossary' },
            {
              text: 'Repo',
              link: 'https://github.com/signalcompose/orbitscore',
            },
          ],
          sidebar: sidebarEn,
          outline: { level: [2, 3], label: 'On this page' },
          lastUpdatedText: 'Last updated',
          docFooter: {
            prev: 'Previous',
            next: 'Next',
          },
        },
      },
    },

    themeConfig: {
      search: { provider: 'local' },
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
