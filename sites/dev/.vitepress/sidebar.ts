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
    text: 'Part III: Rust Engine（既定バックエンド）',
    collapsed: false,
    items: [
      { text: 'RE-1. daemon アーキテクチャ概観', link: '/rust-engine/' },
      { text: 'RE-2. OOP children と shm transport', link: '/rust-engine/oop-children' },
      { text: 'RE-3. per-sequence insert bus', link: '/rust-engine/insert-bus' },
      { text: 'RE-4. capture seam と客観検証', link: '/rust-engine/capture-verification' },
    ],
  },
  {
    text: 'Part IV: Signal Chain / Mixer',
    collapsed: false,
    items: [
      { text: 'SC-1. ラック — チェーンを値として書く', link: '/signal-chain/' },
      { text: 'SC-2. ミキサーとオーディオライン', link: '/signal-chain/mixer-audio-line' },
    ],
  },
  {
    text: 'Part V: Plugin Hosting',
    collapsed: false,
    items: [
      { text: 'PH-1. Plugin Hosting 概観', link: '/plugin-hosting/' },
      { text: 'PH-2. プラグイン UI ホスティング', link: '/plugin-hosting/plugin-ui' },
      { text: 'PH-3. プラグインカタログと差し替え', link: '/plugin-hosting/catalog' },
    ],
  },
  {
    text: 'Part VI: Editor Integration',
    collapsed: false,
    items: [
      { text: 'IV-1. VS Code 拡張アーキテクチャ', link: '/editor/vscode-architecture' },
      { text: 'IV-2. インライン実行とフィードバック', link: '/editor/execution-feedback' },
      { text: 'IV-3. MCP サーバと実機 gated E2E', link: '/editor/mcp-and-gated-e2e' },
    ],
  },
  {
    text: 'Part VII: SuperCollider 経路（opt-out・歴史的読解）',
    collapsed: true,
    items: [
      { text: 'III-1. SuperCollider との通信', link: '/audio/supercollider' },
      { text: 'III-2. オーディオファイル再生', link: '/audio/audio-file-playback' },
      { text: 'III-3. scsynth bundle と path resolution', link: '/audio/scsynth-bundle' },
    ],
  },
  {
    text: 'Part VIII: ADR / Glossary',
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
    text: 'Part III: Rust Engine (default backend)',
    collapsed: false,
    items: [
      { text: 'RE-1. Daemon Architecture Overview', link: '/en/rust-engine/' },
      { text: 'RE-2. OOP Children and shm Transport', link: '/en/rust-engine/oop-children' },
      { text: 'RE-3. Per-Sequence Insert Bus', link: '/en/rust-engine/insert-bus' },
      {
        text: 'RE-4. Capture Seam and Objective Verification',
        link: '/en/rust-engine/capture-verification',
      },
    ],
  },
  {
    text: 'Part IV: Signal Chain / Mixer',
    collapsed: false,
    items: [
      { text: 'SC-1. Racks — Writing a Chain as a Value', link: '/en/signal-chain/' },
      { text: 'SC-2. The Mixer and the Audio Line', link: '/en/signal-chain/mixer-audio-line' },
    ],
  },
  {
    text: 'Part V: Plugin Hosting',
    collapsed: false,
    items: [
      { text: 'PH-1. Plugin Hosting Overview', link: '/en/plugin-hosting/' },
      { text: 'PH-2. Plugin UI Hosting', link: '/en/plugin-hosting/plugin-ui' },
      { text: 'PH-3. The Plugin Catalog and Replacement', link: '/en/plugin-hosting/catalog' },
    ],
  },
  {
    text: 'Part VI: Editor Integration',
    collapsed: false,
    items: [
      { text: 'IV-1. VS Code Extension Architecture', link: '/en/editor/vscode-architecture' },
      { text: 'IV-2. Inline Execution and Feedback', link: '/en/editor/execution-feedback' },
      { text: 'IV-3. MCP Server and Gated Real-Device E2E', link: '/en/editor/mcp-and-gated-e2e' },
    ],
  },
  {
    text: 'Part VII: SuperCollider Path (opt-out, historical)',
    collapsed: true,
    items: [
      { text: 'III-1. Communication with SuperCollider', link: '/en/audio/supercollider' },
      { text: 'III-2. Audio File Playback', link: '/en/audio/audio-file-playback' },
      { text: 'III-3. scsynth Bundle and Path Resolution', link: '/en/audio/scsynth-bundle' },
    ],
  },
  {
    text: 'Part VIII: ADR / Glossary',
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
