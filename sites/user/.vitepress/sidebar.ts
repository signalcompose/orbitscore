import type { DefaultTheme } from 'vitepress'

export const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'はじめに',
    collapsed: false,
    items: [{ text: '1. OrbitScore とは', link: '/' }],
  },
  {
    text: 'はじめてみる',
    collapsed: false,
    items: [
      { text: '2. インストール', link: '/getting-started/installation' },
      { text: '3. はじめての音', link: '/getting-started/first-sound' },
    ],
  },
  {
    text: '基本を身につける',
    collapsed: false,
    items: [
      { text: '4. パターンを作る', link: '/basics/patterns' },
      { text: '5. 複数のシーケンス', link: '/basics/multiple-sequences' },
      { text: '6. ポリメーター・ポリリズム', link: '/basics/polyrhythm' },
      { text: '7. オーディオ操作', link: '/basics/audio-manipulation' },
      { text: '8. ライブコーディング', link: '/basics/live-coding' },
    ],
  },
  {
    text: '困ったときは',
    collapsed: false,
    items: [
      { text: '9. リファレンス', link: '/reference/methods' },
      { text: '10. トラブルシューティング', link: '/troubleshooting' },
    ],
  },
]
