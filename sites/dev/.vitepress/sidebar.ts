import type { DefaultTheme } from 'vitepress'

export const sidebarJa: DefaultTheme.SidebarItem[] = [
  {
    text: 'Part 0: Orientation',
    collapsed: false,
    items: [
      { text: '0-1. OrbitScore とは何か', link: '/orientation/what-is-orbitscore' },
      { text: '0-2. アーキテクチャ全景', link: '/orientation/architecture-overview' },
    ],
  },
  {
    text: 'Part I: DSL Pipeline',
    collapsed: false,
    items: [
      { text: 'I-1. テキスト → AST', link: '/pipeline/text-to-ast' },
      { text: 'I-2. AST 評価モデル', link: '/pipeline/evaluation' },
      { text: 'I-3. selective execution', link: '/pipeline/selective-execution' },
    ],
  },
  {
    text: 'Part II: Scheduling',
    collapsed: false,
    items: [
      { text: 'II-1. 時間表現', link: '/scheduling/time-representation' },
      { text: 'II-2. polymeter / polyrhythm', link: '/scheduling/polymeter' },
      { text: 'II-3. event queue と look-ahead', link: '/scheduling/event-queue' },
      { text: 'II-4. transport', link: '/scheduling/transport' },
    ],
  },
  {
    text: 'Part III: Audio Rendering',
    collapsed: false,
    items: [
      { text: 'III-1. SuperCollider との通信', link: '/audio/supercollider' },
      { text: 'III-2. オーディオファイル再生', link: '/audio/audio-file-playback' },
      { text: 'III-3. scsynth bundle と path resolution', link: '/audio/scsynth-bundle' },
    ],
  },
  {
    text: 'Part IV: Editor Integration',
    collapsed: false,
    items: [
      { text: 'IV-1. VS Code 拡張アーキテクチャ', link: '/editor/vscode-architecture' },
      { text: 'IV-2. インライン実行とフィードバック', link: '/editor/execution-feedback' },
    ],
  },
  {
    text: 'Part V: ADR / Glossary',
    collapsed: false,
    items: [
      { text: 'ADR-001 SC ベース実装の選択', link: '/decisions/adr-001-supercollider' },
      { text: 'ADR-002 DSL v1 → v3 pivot', link: '/decisions/adr-002-dsl-v3-pivot' },
      { text: 'ADR-003 scsynth bundle strict mode', link: '/decisions/adr-003-scsynth-bundle' },
      { text: 'Glossary', link: '/glossary' },
    ],
  },
]

export const sidebarEn: DefaultTheme.SidebarItem[] = [
  {
    text: 'Part 0: Orientation',
    collapsed: false,
    items: [
      { text: '0-1. What is OrbitScore', link: '/en/orientation/what-is-orbitscore' },
      { text: '0-2. Architecture Overview', link: '/en/orientation/architecture-overview' },
    ],
  },
  {
    text: 'Part I: DSL Pipeline',
    collapsed: false,
    items: [
      { text: 'I-1. Text to AST', link: '/en/pipeline/text-to-ast' },
      { text: 'I-2. AST Evaluation Model', link: '/en/pipeline/evaluation' },
      { text: 'I-3. Selective Execution', link: '/en/pipeline/selective-execution' },
    ],
  },
  {
    text: 'Part II: Scheduling',
    collapsed: false,
    items: [
      { text: 'II-1. Time Representation', link: '/en/scheduling/time-representation' },
      { text: 'II-2. Polymeter / Polyrhythm', link: '/en/scheduling/polymeter' },
      { text: 'II-3. Event Queue and Look-Ahead', link: '/en/scheduling/event-queue' },
      { text: 'II-4. Transport', link: '/en/scheduling/transport' },
    ],
  },
  {
    text: 'Part III: Audio Rendering',
    collapsed: false,
    items: [
      { text: 'III-1. Communication with SuperCollider', link: '/en/audio/supercollider' },
      { text: 'III-2. Audio File Playback', link: '/en/audio/audio-file-playback' },
      { text: 'III-3. scsynth Bundle and Path Resolution', link: '/en/audio/scsynth-bundle' },
    ],
  },
  {
    text: 'Part IV: Editor Integration',
    collapsed: false,
    items: [
      { text: 'IV-1. VS Code Extension Architecture', link: '/en/editor/vscode-architecture' },
      { text: 'IV-2. Inline Execution and Feedback', link: '/en/editor/execution-feedback' },
    ],
  },
  {
    text: 'Part V: ADR / Glossary',
    collapsed: false,
    items: [
      {
        text: 'ADR-001 Choosing SC-based Implementation',
        link: '/en/decisions/adr-001-supercollider',
      },
      { text: 'ADR-002 DSL v1 to v3 Pivot', link: '/en/decisions/adr-002-dsl-v3-pivot' },
      { text: 'ADR-003 scsynth Bundle Strict Mode', link: '/en/decisions/adr-003-scsynth-bundle' },
      { text: 'Glossary', link: '/en/glossary' },
    ],
  },
]

// 後方互換のため既存 import 名 (sidebar) も維持
export const sidebar = sidebarJa
