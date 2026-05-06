import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { sidebar } from './sidebar'

export default withMermaid(
  defineConfig({
    title: 'OrbitScore',
    description: 'OrbitScore ユーザー向け学習サイト — ライブコーディングで音楽を作るための入門',
    lang: 'ja-JP',

    lastUpdated: true,
    cleanUrls: true,

    srcExclude: ['STYLE_GUIDE.md', 'README.md'],

    themeConfig: {
      nav: [
        { text: 'Home', link: '/' },
        { text: 'はじめての音', link: '/getting-started/first-sound' },
        { text: 'リファレンス', link: '/reference/methods' },
        {
          text: 'Repo',
          link: 'https://github.com/signalcompose/orbitscore',
        },
      ],
      sidebar,
      outline: { level: [2, 3], label: 'このページの目次' },
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
