import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { sidebarJa, sidebarEn } from './sidebar'

export default withMermaid(
  defineConfig({
    title: 'OrbitScore',
    description: 'OrbitScore ユーザー向け学習サイト — ライブコーディングで音楽を作るための入門',
    lang: 'ja-JP',

    lastUpdated: true,
    cleanUrls: true,

    srcExclude: ['STYLE_GUIDE.md', 'README.md', '.translation-glossary.md', 'en/STYLE_GUIDE.md'],

    locales: {
      root: {
        label: '日本語',
        lang: 'ja-JP',
        title: 'OrbitScore',
        description: 'OrbitScore ユーザー向け学習サイト — ライブコーディングで音楽を作るための入門',
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
        title: 'OrbitScore',
        description:
          'OrbitScore user learning site — an introduction to making music with live coding',
        themeConfig: {
          nav: [
            { text: 'Home', link: '/en/' },
            { text: 'First Sound', link: '/en/getting-started/first-sound' },
            { text: 'Reference', link: '/en/reference/methods' },
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
