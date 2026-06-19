import type { DefaultTheme } from 'vitepress'

export const sidebarJa: DefaultTheme.SidebarItem[] = [
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
    text: 'MIDI とピッチ表現（v2.0.0）',
    collapsed: false,
    items: [
      { text: '9. MIDI 出力', link: '/midi/' },
      { text: '10. ピッチ DSL（度数・コード）', link: '/midi/pitch-dsl' },
      { text: '11. モードとスケール', link: '/midi/mode-scale' },
      { text: '12. ボイシングと voice leading', link: '/midi/voicing' },
      { text: '13. LinkAudio', link: '/midi/link-audio' },
      { text: '14. Launch Quantize', link: '/midi/quantize' },
    ],
  },
  {
    text: '困ったときは',
    collapsed: false,
    items: [
      { text: '15. リファレンス', link: '/reference/methods' },
      { text: '16. トラブルシューティング', link: '/troubleshooting' },
    ],
  },
]

export const sidebarEn: DefaultTheme.SidebarItem[] = [
  {
    text: 'Introduction',
    collapsed: false,
    items: [{ text: '1. What is OrbitScore', link: '/en/' }],
  },
  {
    text: 'Getting Started',
    collapsed: false,
    items: [
      { text: '2. Installation', link: '/en/getting-started/installation' },
      { text: '3. Your First Sound', link: '/en/getting-started/first-sound' },
    ],
  },
  {
    text: 'Basics',
    collapsed: false,
    items: [
      { text: '4. Building Patterns', link: '/en/basics/patterns' },
      { text: '5. Multiple Sequences', link: '/en/basics/multiple-sequences' },
      { text: '6. Polymeter & Polyrhythm', link: '/en/basics/polyrhythm' },
      { text: '7. Audio Manipulation', link: '/en/basics/audio-manipulation' },
      { text: '8. Live Coding', link: '/en/basics/live-coding' },
    ],
  },
  {
    text: 'MIDI and Pitch DSL (v2.0.0)',
    collapsed: false,
    items: [
      { text: '9. MIDI Output', link: '/en/midi/' },
      { text: '10. Pitch DSL (Degrees & Chords)', link: '/en/midi/pitch-dsl' },
      { text: '11. Modes & Scales', link: '/en/midi/mode-scale' },
      { text: '12. Voicing & Voice Leading', link: '/en/midi/voicing' },
      { text: '13. LinkAudio', link: '/en/midi/link-audio' },
      { text: '14. Launch Quantize', link: '/en/midi/quantize' },
    ],
  },
  {
    text: 'Help',
    collapsed: false,
    items: [
      { text: '15. Reference', link: '/en/reference/methods' },
      { text: '16. Troubleshooting', link: '/en/troubleshooting' },
    ],
  },
]

// 後方互換のため既存 import 名 (sidebar) も維持
export const sidebar = sidebarJa
