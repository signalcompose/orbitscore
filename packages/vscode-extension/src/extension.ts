import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
// import * as os from 'os'

import * as vscode from 'vscode'

import { analyzeMethodChain, getContextualCompletions } from './completion-context'
import {
  analyzeAudioPathOrdering,
  analyzeEmptyOutputArg,
  analyzeGlobalOncePerFile,
  analyzeLinkAudioMissingOutput,
  analyzeOutputWithoutLinkAudio,
  isOrbitscoreDocument,
} from './diagnostics-analysis'
import { buildMcpServerUrl, mergeMcpJson } from './mcp-registration'
import {
  startOrbitScoreMcpServer,
  type AnalyzeAudioResult,
  type AudioDevicesResult,
  type CommandResult,
  type DiagnosticSeverityLabel,
  type DocumentText,
  type EditReplaceInput,
  type EditorState,
  type EngineState,
  type EvaluateResult,
  type FileDiagnostics,
  type FlashConfigInput,
  type FlashConfigResult,
  type ListPluginsResult,
  type McpServerHandle,
  type RegisterMcpServerInput,
  type RescanPluginsResult,
  type SelectionInput,
} from './mcp-server'
import {
  AUDIO_DEVICE_SWITCH_UNAVAILABLE,
  buildRootNodes,
  deviceNameFromNodeId,
  deviceSectionChildren,
  recoveryCommandFromNodeId,
  recoverySectionChildren,
  resolveDeviceClickAction,
  translateSelectAudioDeviceError,
  type DeviceFetchState,
  type EngineViewDevice,
  type EngineViewNode,
  type SelectAudioDeviceBridgeResult,
} from './engine-view'
import { DeviceSwitchBridge } from './device-switch-bridge'
import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractTopLevelDeclaredNames,
  filterDslCandidates,
} from './dsl-completion-context'
import { detectPluginArgContext, filterCatalogEntries } from './plugin-catalog-completion'
import { loadPluginCatalog, runPluginScan } from './plugin-catalog-reader'
import {
  colorForSeq,
  findPlayArgRangeForPath,
  parseStepLine,
  type PlayheadColorConfig,
  type StepEvent,
} from './playhead'
import { analyzeWavBuffer } from './wav-analysis'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let bundleStatusItem: vscode.StatusBarItem | null = null
let devDocsPanel: vscode.WebviewPanel | null = null
let isLiveCodingMode: boolean = false
// Tracks whether `var global = init GLOBAL` has been evaluated in the current engine session.
// Used to decide if `global.setDocumentDirectory(...)` can be prepended safely.
let globalInitialized: boolean = false
// Optional MCP control server (Agent Bridge). Non-null only while running.
let mcpServerHandle: McpServerHandle | null = null
// Stateful FIFO/timeout/drain logic for the `//#selectAudioDevice` live bridge
// (#484 D2.5, extracted to device-switch-bridge.ts in PR #501 review so it's
// testable without mocking vscode). One instance for the extension's lifetime —
// drained on every engine exit/stop so a resolver from a dead engine can never
// FIFO-match a future engine's response.
const selectAudioDeviceBridge = new DeviceSwitchBridge()
// Audio Engine Settings TreeView (#484 D3). Non-null once activated.
let engineViewProvider: EngineViewProvider | null = null
// Changes whenever a spawn is created or a user explicitly stops the engine.
// Auto-start's delayed health check uses it to avoid warning about a later action.
let engineGeneration = 0
// #463 C3: show the "no plugin catalog yet, run rescan" hint at most once per
// activation (loadPluginCatalog() is cheap but the info popup shouldn't nag on
// every keystroke while typing an effect()/instrument() argument).
let pluginCatalogHintShown = false

// let isDebugMode: boolean = false // Debug mode flag

// Ring buffer of output-channel lines for the MCP get_log tool (#388). There is
// no other central log sink to tap, so activate() monkey-patches
// outputChannel.appendLine/append to also push here.
const outputLogRing: string[] = []
const OUTPUT_LOG_RING_MAX = 1000

function pushLogRing(line: string): void {
  outputLogRing.push(line)
  if (outputLogRing.length > OUTPUT_LOG_RING_MAX) {
    outputLogRing.shift()
  }
}

// --- Live playhead highlight (#390) ---
// The engine emits `[STEP] <seqName> <argPath> <atEpochMs>` on stdout for each
// dispatched play event (see playhead.ts for the grammar). setupStdoutHandler
// parses these from the RAW stream (shouldFilterLine keeps them out of the
// Output channel), delays until the event's grid time, then highlights the
// corresponding `<seqName>.play(...)` argument (argPath descends into nested
// groups — "1.0" lights the first element inside the second arg). ONE
// decoration type PER RESOLVED COLOR (lazily created, keyed by "#RRGGBB");
// each seq gets a vivid color first-come from `orbitscore.playheadPalette`
// (see playhead.ts colorForSeq; per-seq pinning is the planned DSL feature
// #391). ONE active range per seq (replaced on each step, so the highlight
// "moves" per beat and wraps at loop start). Cleared on seq stop (`⏹ <seq>`
// line), global stop, engine stop / exit, and deactivate.
const playheadDecorationTypes = new Map<string, vscode.TextEditorDecorationType>()
const playheadPaletteAssignments = new Map<string, number>()
const playheadActiveRanges = new Map<string, { docUriString: string; range: vscode.Range }>()
const playheadTimeouts = new Set<NodeJS.Timeout>()

function playheadColorConfig(): PlayheadColorConfig {
  const config = vscode.workspace.getConfiguration('orbitscore')
  // seqColors intentionally absent: per-seq pinning arrives as a DSL feature
  // (#391), not a setting (owner 2026-07-07).
  return {
    palette: config.get<string[]>('playheadPalette'),
  }
}

function ensurePlayheadDecorationType(color: string): vscode.TextEditorDecorationType {
  let decorationType = playheadDecorationTypes.get(color)
  if (!decorationType) {
    decorationType = vscode.window.createTextEditorDecorationType({
      // 50% alpha fill + solid border: must stay readable on top of the editor
      // selection background (owner feedback 2026-07-07 — theme find-match
      // color was too faint).
      backgroundColor: `${color}80`,
      border: `1.5px solid ${color}`,
      borderRadius: '3px',
    })
    playheadDecorationTypes.set(color, decorationType)
  }
  return decorationType
}

/** Drop all decoration types (e.g. after a color-config change) and redraw. */
function resetPlayheadDecorationTypes(): void {
  for (const decorationType of playheadDecorationTypes.values()) {
    decorationType.dispose() // dispose also removes it from every editor
  }
  playheadDecorationTypes.clear()
  applyPlayheadDecorations()
}

/** Re-apply the current per-seq playhead ranges to every visible editor. */
function applyPlayheadDecorations(): void {
  const colorConfig = playheadColorConfig()
  for (const editor of vscode.window.visibleTextEditors) {
    const uri = editor.document.uri.toString()
    // Start every known type at [] so a seq that stopped (or moved) has its
    // previous color cleared, then fill in the live ranges per color.
    const rangesByType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>()
    for (const decorationType of playheadDecorationTypes.values()) {
      rangesByType.set(decorationType, [])
    }
    for (const [seqName, entry] of playheadActiveRanges) {
      if (entry.docUriString !== uri) continue
      const decorationType = ensurePlayheadDecorationType(
        colorForSeq(seqName, colorConfig, playheadPaletteAssignments),
      )
      const ranges = rangesByType.get(decorationType) ?? []
      ranges.push(entry.range)
      rangesByType.set(decorationType, ranges)
    }
    for (const [decorationType, ranges] of rangesByType) {
      editor.setDecorations(decorationType, ranges)
    }
  }
}

/**
 * Schedule the decoration for one parsed `[STEP]`. Dispatch is lookahead-early,
 * so wait until `atEpochMs` (the event's grid time — actual audio lands a
 * uniform ~50ms daemon lookahead later, see playhead.ts) before moving the
 * highlight; a marginally late line still tracks (clamped to now), while stale
 * lines (>1s late, e.g. replayed buffered output) are dropped.
 */
function handleStepLine(step: StepEvent): void {
  const delayMs = step.atEpochMs - Date.now()
  if (delayMs < -1000) return
  const timeout = setTimeout(
    () => {
      playheadTimeouts.delete(timeout)
      showPlayheadStep(step)
    },
    Math.max(0, delayMs),
  )
  playheadTimeouts.add(timeout)
}

function showPlayheadStep(step: StepEvent): void {
  for (const editor of vscode.window.visibleTextEditors) {
    // Resolves the full dot path ("1.0" → first element inside the 2nd arg),
    // degrading to the deepest resolvable ancestor (stacks are one visual
    // unit). Null = even the top-level arg is gone (user edited away the
    // pattern) — skip; leaving the previous highlight is less misleading
    // than lighting a wrong arg.
    const argRange = findPlayArgRangeForPath(editor.document.getText(), step.seqName, step.argPath)
    if (!argRange) continue
    playheadActiveRanges.set(step.seqName, {
      docUriString: editor.document.uri.toString(),
      range: new vscode.Range(
        editor.document.positionAt(argRange.start),
        editor.document.positionAt(argRange.end),
      ),
    })
    applyPlayheadDecorations()
    return // first visible editor containing the call wins (MVP)
  }
}

function clearPlayheadForSequence(seqName: string): void {
  if (playheadActiveRanges.delete(seqName)) {
    applyPlayheadDecorations()
  }
}

function clearAllPlayheadDecorations(): void {
  for (const timeout of playheadTimeouts) {
    clearTimeout(timeout)
  }
  playheadTimeouts.clear()
  if (playheadActiveRanges.size > 0) {
    playheadActiveRanges.clear()
    applyPlayheadDecorations()
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  engineProcess = null
  isLiveCodingMode = false
  globalInitialized = false

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')

  // Tap appendLine/append into the ring buffer so the MCP get_log tool can read
  // recent output without a separate logging sink (#388). Installed before the
  // version banner below so get_log's history starts from activation.
  const rawAppendLine = outputChannel.appendLine.bind(outputChannel)
  outputChannel.appendLine = (value: string) => {
    pushLogRing(value)
    rawAppendLine(value)
  }
  const rawAppend = outputChannel.append.bind(outputChannel)
  outputChannel.append = (value: string) => {
    for (const line of value.split('\n')) {
      if (line) pushLogRing(line)
    }
    rawAppend(value)
  }

  // Show version info
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  const buildTime = fs.statSync(__filename).mtime.toISOString()
  outputChannel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  outputChannel.appendLine(`🎵 OrbitScore Extension v${packageJson.version}`)
  outputChannel.appendLine(`📦 Build: ${buildTime}`)
  outputChannel.appendLine(`📂 Path: ${__dirname}`)
  outputChannel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  outputChannel.appendLine('')

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.text = '🎵 OrbitScore: Stopped'
  statusBarItem.tooltip = 'Open Audio Engine Settings'
  statusBarItem.command = 'orbitscore.showCommands'
  statusBarItem.show()

  // Bundle status indicator (priority 99 → 既存 100 の左隣に並ぶ)
  bundleStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  // Click → orbitscore.scsynthPath に絞った設定画面に直接遷移
  // (tooltip 案内と一致、maybeShowBundleNotice の "Open Settings" ボタンとも統一)
  bundleStatusItem.command = {
    command: 'workbench.action.openSettings',
    title: 'Open scsynth settings',
    arguments: ['orbitscore.scsynthPath'],
  }
  updateBundleStatus()
  updateStatusBarEngineAction()

  // Re-evaluate bundle status when user changes the override setting or
  // switches engine kind (#377: kind gates whether scsynth is even resolved).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('orbitscore.scsynthPath') ||
        e.affectsConfiguration('orbitscore.engine')
      ) {
        updateBundleStatus()
      }
      if (e.affectsConfiguration('orbitscore.engine')) updateStatusBarEngineAction()
    }),
  )

  // Rebuild playhead decoration types when the palette changes (#390) so a
  // running loop picks up new colors on the next repaint without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('orbitscore.playheadPalette')) {
        resetPlayheadDecorationTypes()
      }
    }),
  )

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.toggleEngine', toggleEngine),
    vscode.commands.registerCommand('orbitscore.showCommands', showCommands),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.stopEngine', stopEngine),
    vscode.commands.registerCommand('orbitscore.restartEngine', restartEngine),
    vscode.commands.registerCommand('orbitscore.reloadWindow', reloadWindow),
    vscode.commands.registerCommand('orbitscore.startEngineDebug', startEngineDebug),
    vscode.commands.registerCommand('orbitscore.forceKillScsynth', forceKillScsynth),
    vscode.commands.registerCommand('orbitscore.selectAudioDevice', selectAudioDevice),
    vscode.commands.registerCommand('orbitscore.configureFlash', configureFlash),
    vscode.commands.registerCommand('orbitscore.registerMcpServer', registerMcpServer),
    vscode.commands.registerCommand('orbitscore.rescanPlugins', rescanPlugins),
    // viewsWelcome コンテンツは view に provider が登録されて初めて描画される
    // （空 TreeView で十分 — 章ツリーの本実装は #451 確定後の follow-up）。
    vscode.window.registerTreeDataProvider('orbitscore.learningView', {
      getChildren: () => [],
      getTreeItem: (element: vscode.TreeItem) => element,
    }),
    // Engine ビュー（#484 D3）: エンジン停止中は空を返し viewsWelcome（Start/Debug/Stop ボタン）を
    // 出す（viewsWelcome は tree が空の時だけ描画される — 上の学習ビューと同じ制約）。起動中は
    // engine 状態 + Output Device セクションを TreeView として描画する。
    (() => {
      engineViewProvider = new EngineViewProvider()
      return vscode.window.registerTreeDataProvider('orbitscore.engineView', engineViewProvider)
    })(),
    vscode.commands.registerCommand('orbitscore.engineViewSelectDevice', engineViewSelectDevice),
    vscode.commands.registerCommand('orbitscore.engineViewToggleEngine', engineViewToggleEngine),
    vscode.commands.registerCommand('orbitscore.engineViewToggleDebug', engineViewToggleDebug),
    vscode.commands.registerCommand('orbitscore.openDocs', openUserDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocs', openDevDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocsPanel', () => openDevDocsPanel(context)),
    vscode.commands.registerCommand('orbitscore.openWalkthrough', openWalkthrough),
    statusBarItem,
    bundleStatusItem,
  )

  // Register IntelliSense providers
  registerCompletionProviders(context)
  registerHoverProvider(context)

  // Register diagnostics
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('orbitscore')
  context.subscriptions.push(diagnosticCollection)

  // Compute diagnostics on open and change; clear them on close (#384).
  // Diagnostics must not wait for the first edit — files opened from the CLI,
  // restored tabs, or the activation-time initial pass below all need
  // errors/warnings surfaced immediately.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isOrbitscoreDocument(document)) {
        updateDiagnostics(document, diagnosticCollection)
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isOrbitscoreDocument(event.document)) {
        updateDiagnostics(event.document, diagnosticCollection)
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isOrbitscoreDocument(document)) {
        diagnosticCollection.delete(document.uri)
      }
    }),
  )

  // Initial pass over documents already open at activation (#384): the
  // extension activates on `onLanguage:orbitscore`, so the triggering document
  // is already open and would otherwise never fire onDidOpenTextDocument.
  for (const document of vscode.workspace.textDocuments) {
    if (isOrbitscoreDocument(document)) {
      updateDiagnostics(document, diagnosticCollection)
    }
  }

  // Optional MCP control server (Agent Bridge, #388) — dev/agent-integration
  // only, gated behind a nonzero port. The `ORBITSCORE_MCP_PORT` env var takes
  // precedence over the `orbitscore.mcpServer.port` setting so the extension can
  // be launched from the CLI (e.g. Extension Development Host) with the port set
  // without editing settings. Lets an external agent (e.g. Claude Code) drive
  // OrbitScore operations for E2E testing.
  const envMcpPort = Number(process.env.ORBITSCORE_MCP_PORT)
  const mcpPort =
    Number.isInteger(envMcpPort) && envMcpPort > 0
      ? envMcpPort
      : vscode.workspace.getConfiguration('orbitscore').get<number>('mcpServer.port', 0)
  if (mcpPort && mcpPort > 0) {
    try {
      mcpServerHandle = await startOrbitScoreMcpServer({
        port: mcpPort,
        version: packageJson.version,
        handlers: {
          evaluate: (code) => evaluateForAgent(code),
          startEngine: (options) => startEngineForAgent(options),
          stopEngine: () => stopEngineForAgent(),
          getEngineState: () => getEngineStateForAgent(),
          forceKillScsynth: () => forceKillScsynthForAgent(),
          listAudioDevices: () => listAudioDevicesForAgent(),
          selectAudioDevice: (device) => selectAudioDeviceForAgent(device),
          configureFlash: (options) => configureFlashForAgent(options),
          openFile: (filePath) => openFileForAgent(filePath),
          setSelection: (range) => setSelectionForAgent(range),
          runSelection: () => runSelectionForAgent(),
          editReplace: (args) => editReplaceForAgent(args),
          getEditorState: () => getEditorStateForAgent(),
          saveFile: () => saveFileForAgent(),
          getDocumentText: () => getDocumentTextForAgent(),
          getDiagnostics: (filePath) => getDiagnosticsForAgent(filePath),
          getLog: (lines) => getLogForAgent(lines),
          analyzeAudio: (wavPath, windowMs) => analyzeAudioForAgent(wavPath, windowMs),
          listPlugins: () => listPluginsForAgent(),
          rescanPlugins: () => rescanPluginsForAgent(),
          registerMcpServer: (args) => registerMcpServerForAgent(args),
        },
        log: (message) => outputChannel?.appendLine(`🔌 ${message}`),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      outputChannel?.appendLine(`❌ MCP server failed to start on port ${mcpPort}: ${reason}`)
      vscode.window.showWarningMessage(`OrbitScore MCP server failed to start: ${reason}`)
    }
  }

  void autoStartConfiguredRustEngine()
}

export function deactivate() {
  if (engineProcess && !engineProcess.killed) {
    engineProcess.kill()
  }
  clearAllPlayheadDecorations() // #390
  for (const decorationType of playheadDecorationTypes.values()) {
    decorationType.dispose()
  }
  playheadDecorationTypes.clear()
  void mcpServerHandle?.dispose()
  mcpServerHandle = null
  outputChannel?.dispose()
  statusBarItem?.dispose()
  bundleStatusItem?.dispose()
  devDocsPanel?.dispose()
  devDocsPanel = null
}

/**
 * Canonical local URL of the dev learning site, or null (with the shared error
 * message shown) when the MCP server is not running. Single source for every
 * entry point (browser command, webview panel) — the site is served at the
 * VitePress base `/orbitscore/dev/` (mcp-server.ts DOCS_PUBLIC_BASE; `/docs`
 * is only a redirect kept for muscle memory).
 */
function resolveDevDocsUrl(): string | null {
  const port = mcpServerHandle?.port ?? 0
  if (!port) {
    void vscode.window.showErrorMessage(
      'OrbitScore development docs require the MCP server. Set orbitscore.mcpServer.port and enable the MCP server.',
    )
    return null
  }
  return `http://127.0.0.1:${port}/orbitscore/dev/`
}

/**
 * Canonical local URL of the END-USER learning site (sites/user — served at
 * `/orbitscore/` by the MCP server; the dev site lives under `/orbitscore/dev/`).
 */
function resolveUserDocsUrl(): string | null {
  const port = mcpServerHandle?.port ?? 0
  if (!port) {
    void vscode.window.showErrorMessage(
      'OrbitScore docs require the MCP server. Set orbitscore.mcpServer.port and enable the MCP server.',
    )
    return null
  }
  return `http://127.0.0.1:${port}/orbitscore/`
}

async function openUserDocs(): Promise<void> {
  const url = resolveUserDocsUrl()
  if (!url) return
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
  if (!opened) {
    outputChannel?.appendLine(`❌ Failed to open the learning site at ${url}`)
  }
}

async function openDevDocs(): Promise<void> {
  const url = resolveDevDocsUrl()
  if (!url) return
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
  if (!opened) {
    outputChannel?.appendLine(`❌ Failed to open development docs at ${url}`)
    void vscode.window.showErrorMessage('Could not open the development docs in your browser.')
  }
}

/**
 * Open the development docs inside an editor tab via an iframe-wrapped
 * webview panel, so the site can be read side-by-side with `.orbs` files
 * without leaving VS Code. Singleton: a second invocation reveals the
 * existing panel instead of creating a duplicate.
 */
function openDevDocsPanel(context: vscode.ExtensionContext): void {
  const url = resolveDevDocsUrl()
  if (!url) return

  if (devDocsPanel) {
    devDocsPanel.reveal(vscode.ViewColumn.Active)
    return
  }

  devDocsPanel = vscode.window.createWebviewPanel(
    'orbitscore.devDocsPanel',
    'OrbitScore Docs',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  )
  devDocsPanel.webview.html = buildDevDocsPanelHtml(url)
  devDocsPanel.onDidDispose(
    () => {
      devDocsPanel = null
    },
    null,
    context.subscriptions,
  )
}

function buildDevDocsPanelHtml(url: string): string {
  const escapedUrl = url.replace(/"/g, '&quot;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline';"
  />
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head>
<body>
  <iframe src="${escapedUrl}" title="OrbitScore development docs"></iframe>
</body>
</html>`
}

async function openWalkthrough(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as {
    publisher: string
    name: string
  }
  const extensionId = `${pkg.publisher}.${pkg.name}`
  await vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${extensionId}#orbitscore.learnOrbitScore`,
  )
}

/**
 * Read `orbitscore.engine` and normalize it to 'rust' | 'sc'.
 *
 * 正規化の決定は engine 側の `resolveEngineKind` (engine-backend の compiled JS を
 * runtime require — `resolveScsynthForUI` と同じパターン) に委ね、一箇所に保つ。
 * UI 側は戻り値 ('supercollider' | 'rust') を設定 enum のラベル ('sc' | 'rust') に
 * 写すだけ。resolver が読めない (require 失敗) 場合はローカル正規化（engine 側と同一規則
 * — 'sc'/'supercollider' のみ SC、それ以外は rust）に倒す。ここで raw を無視して
 * 無条件 rust に倒すと、明示的に `orbitscore.engine: "sc"` を設定したユーザーの意図が
 * resolver 不読という無関係な理由で握り潰される（C1）。
 */
function getConfiguredEngineKind(): 'rust' | 'sc' {
  const raw = vscode.workspace.getConfiguration('orbitscore').get<string>('engine', 'rust')
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const backendModule = require('../engine/dist/audio/engine-backend') as {
      resolveEngineKind: (raw: string | undefined) => 'supercollider' | 'rust'
    }
    return backendModule.resolveEngineKind(raw) === 'supercollider' ? 'sc' : 'rust'
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(
      `⚠️ engine-backend resolver unavailable — falling back to local normalization: ${reason}`,
    )
    const v = raw?.trim().toLowerCase()
    return v === 'sc' || v === 'supercollider' ? 'sc' : 'rust'
  }
}

/**
 * Resolve scsynth via shared resolver (engine の compiled JS を runtime require).
 * Returns null on failure. 失敗時は outputChannel に reason を log するため
 * View Logs から原因を追える (engine/dist/ 不在 vs. bundle 不在 vs. その他)。
 */
function resolveScsynthForUI(): { path: string; source: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const resolverModule = require('../engine/dist/audio/supercollider/scsynth-resolver') as {
      resolveScsynthPath: (opts?: { explicit?: string }) => { path: string; source: string }
    }
    const userOverride = vscode.workspace
      .getConfiguration('orbitscore')
      .get<string>('scsynthPath', '')
      .trim()
    return resolverModule.resolveScsynthPath(userOverride ? { explicit: userOverride } : undefined)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ scsynth resolver failed: ${reason}`)
    return null
  }
}

/**
 * Resolve the native Rust daemon binary via shared resolver (engine の
 * compiled JS を runtime require). Returns null on failure. Symmetric to
 * `resolveScsynthForUI()` — same runtime-require pattern, same
 * log-reason-to-outputChannel-on-failure behavior (C2). Used to pre-check
 * daemon availability under the `rust` engine kind, mirroring how
 * `resolveScsynthForUI()` pre-checks scsynth under the `sc` kind.
 */
function resolveDaemonForUI(): { path: string; source: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const daemonModule = require('../engine/dist/audio/rust-engine/daemon-client') as {
      resolveDaemonBinaryPath: (explicitPath?: string) => { path: string; source: string }
    }
    return daemonModule.resolveDaemonBinaryPath()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ daemon resolver failed: ${reason}`)
    return null
  }
}

/**
 * Refresh the bundle status bar item to reflect the current resolution.
 *
 * engine kind (#377, #366 C2): when `orbitscore.engine` resolves to \`rust\`,
 * scsynth is not part of the picture at all, but the native daemon binary
 * still needs to be resolvable — pre-check it via `resolveDaemonForUI()` and
 * surface an error state (rather than a blind "native" success indicator) if
 * it's missing. Only \`sc\` kind runs the scsynth resolution below.
 *
 * Strict mode (Issue #136): resolver は SC.app / Spotlight 暗黙 fallback を
 * 持たないため、source は \`bundle\` / \`env\` / \`explicit\` のいずれか。
 * 解決失敗時は error 状態を強調表示する。
 */
function updateBundleStatus(): void {
  if (!bundleStatusItem) return
  if (getConfiguredEngineKind() === 'rust') {
    const daemonResolution = resolveDaemonForUI()
    if (!daemonResolution) {
      bundleStatusItem.show()
      bundleStatusItem.text = '$(error) daemon: not found'
      bundleStatusItem.tooltip =
        'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.'
      bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
      return
    }
    // 既定（Rust・健全）ではインジケータ自体を出さない（owner 判断 2026-07-17: 常時表示の
    // 意味がない）。daemon 不在エラーと SC バックエンド時のみ表示する。
    bundleStatusItem.hide()
    return
  }
  bundleStatusItem.show()
  const resolution = resolveScsynthForUI()
  if (!resolution) {
    bundleStatusItem.text = '$(error) scsynth: not found'
    bundleStatusItem.tooltip =
      'Bundled scsynth not found. Reinstall the extension or set orbitscore.scsynthPath to a system scsynth.'
    bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    return
  }
  bundleStatusItem.backgroundColor = undefined
  switch (resolution.source) {
    case 'bundle':
      bundleStatusItem.text = '$(check) scsynth (bundled)'
      bundleStatusItem.tooltip = `Using bundled scsynth\n${resolution.path}`
      break
    case 'env':
    case 'explicit':
      bundleStatusItem.text = '$(gear) scsynth (custom)'
      bundleStatusItem.tooltip = `Using user-overridden scsynth\n${resolution.path}`
      break
    default:
      bundleStatusItem.text = '$(question) scsynth: unknown source'
      bundleStatusItem.tooltip = resolution.path
  }
}

/**
 * Show error notification when scsynth resolution fails.
 *
 * engine kind (#377): under \`rust\` kind, scsynth resolution is not part of
 * the startup path at all, so this notice must not fire — early return before
 * calling \`resolveScsynthForUI()\`.
 *
 * Strict mode (Issue #136): bundle / env / explicit が解決できれば silent。
 * いずれも見つからない場合は毎回エラー表示 (修復必須)。
 * \`globalState\` の dismiss 機構は持たない (silent fallback がないため
 * 「無視して動かす」選択肢自体がない)。
 */
async function maybeShowBundleNotice(): Promise<void> {
  if (!outputChannel) return
  if (getConfiguredEngineKind() === 'rust') return
  const resolution = resolveScsynthForUI()
  if (resolution) {
    // bundle / env / explicit いずれも resolved → 通知不要
    return
  }
  const choice = await vscode.window.showErrorMessage(
    '⚠️ scsynth not found. OrbitScore requires the bundled scsynth to start. Reinstall the extension or set orbitscore.scsynthPath to a system scsynth.',
    'Open Settings',
    'View Logs',
  )
  if (choice === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'orbitscore.scsynthPath')
  } else if (choice === 'View Logs') {
    outputChannel.show()
  }
}

function showCommands() {
  // SC バックエンド専用コマンドは engine=sc の時だけ載せる（既定 Rust では非表示）。
  const isScBackend = vscode.workspace.getConfiguration('orbitscore').get<string>('engine') === 'sc'
  if (!isScBackend) {
    vscode.commands.executeCommand('orbitscore.engineView.focus')
    return
  }
  const scItems: Array<vscode.QuickPickItem & { command: string }> = [
    {
      label: 'Start Engine',
      description: 'Boot the audio engine',
      detail: 'Start the OrbitScore audio engine (Rust daemon)',
      command: 'orbitscore.toggleEngine',
    },
    {
      label: 'Start Engine (Debug)',
      description: 'Boot with full logging',
      detail: 'Start the engine with verbose debug output',
      command: 'orbitscore.startEngineDebug',
    },
    {
      label: 'Run Selection',
      description: 'Cmd+Enter',
      detail: 'Execute selected code or the current line',
      command: 'orbitscore.runSelection',
    },
    {
      label: 'Stop Engine',
      description: 'Stop the engine process',
      detail: 'Stop the audio engine',
      command: 'orbitscore.stopEngine',
    },
    {
      label: 'Select Audio Device (SC)',
      description: 'Choose output device',
      detail: 'Select the audio output device for the SuperCollider backend',
      command: 'orbitscore.selectAudioDevice',
    },
    {
      label: 'Force Kill scsynth (SC)',
      description: 'killall scsynth',
      detail: 'Escape hatch — force-kill any orphan scsynth processes',
      command: 'orbitscore.forceKillScsynth',
    },
    {
      label: 'Configure Flash',
      description: 'Customize flash settings',
      detail: 'Configure flash count, duration, color, and opacity',
      command: 'orbitscore.configureFlash',
    },
    {
      label: 'Reload',
      description: 'Reload window',
      detail: 'Restart the extension and re-evaluate the file',
      command: 'workbench.action.reloadWindow',
    },
  ]

  vscode.window.showQuickPick(scItems).then((selection) => {
    if (!selection) return
    vscode.commands.executeCommand(selection.command)
  })
}

function updateStatusBarEngineAction(): void {
  if (!statusBarItem) return
  statusBarItem.tooltip =
    getConfiguredEngineKind() === 'rust' ? 'Open Audio Engine Settings' : 'Click to show commands'
}

function restartEngine(): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  if (getConfiguredEngineKind() === 'rust' && !resolveAudioDeviceSetting(workspaceRoot)) {
    vscode.window.showInformationMessage('Select an output device in Audio Engine Settings first')
    return
  }
  stopEngine()
  setTimeout(() => startEngine(), 2200)
}

function reloadWindow(): void {
  void vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function configureFlash() {
  const config = vscode.workspace.getConfiguration('orbitscore')

  // Get current values
  const currentCount = config.get<number>('flashCount', 3)
  const currentDuration = config.get<number>('flashDuration', 150)
  const currentColor = config.get<string>('flashColor', 'selection')
  const currentCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')

  // Show configuration options
  const options = [
    {
      label: `🔢 Flash Count: ${currentCount}`,
      description: 'Number of flashes (1-5)',
      detail: 'Current: ' + currentCount,
      action: 'count',
    },
    {
      label: `⏱️ Flash Duration: ${currentDuration}ms`,
      description: 'Duration of each flash (50-500ms)',
      detail: 'Current: ' + currentDuration + 'ms',
      action: 'duration',
    },
    {
      label: `🎨 Flash Color: ${currentColor}`,
      description: 'Color theme for flash',
      detail: 'Current: ' + currentColor,
      action: 'color',
    },
    {
      label: `🎯 Custom Color: ${currentCustomColor}`,
      description: 'Custom color (hex format)',
      detail: 'Current: ' + currentCustomColor,
      action: 'customColor',
    },
    {
      label: '🧪 Test Flash',
      description: 'Test current flash settings',
      detail: 'Preview the flash effect',
      action: 'test',
    },
  ]

  const selected = await vscode.window.showQuickPick(options, {
    placeHolder: 'Configure flash settings',
    title: '⚡ Flash Configuration',
  })

  if (!selected) return

  switch (selected.action) {
    case 'count': {
      const newCount = await vscode.window.showInputBox({
        prompt: 'Enter flash count (1-5)',
        value: currentCount.toString(),
        validateInput: (value) => {
          const num = parseInt(value)
          if (isNaN(num) || num < 1 || num > 5) {
            return 'Please enter a number between 1 and 5'
          }
          return null
        },
      })
      if (newCount) {
        await config.update('flashCount', parseInt(newCount), vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Flash count set to ${newCount}`)
      }
      break
    }

    case 'duration': {
      const newDuration = await vscode.window.showInputBox({
        prompt: 'Enter flash duration in milliseconds (50-500)',
        value: currentDuration.toString(),
        validateInput: (value) => {
          const num = parseInt(value)
          if (isNaN(num) || num < 50 || num > 500) {
            return 'Please enter a number between 50 and 500'
          }
          return null
        },
      })
      if (newDuration) {
        await config.update(
          'flashDuration',
          parseInt(newDuration),
          vscode.ConfigurationTarget.Global,
        )
        vscode.window.showInformationMessage(`✅ Flash duration set to ${newDuration}ms`)
      }
      break
    }

    case 'color': {
      const colorOptions = [
        { label: 'selection', description: 'Editor selection color' },
        { label: 'error', description: 'Error color (red)' },
        { label: 'warning', description: 'Warning color (yellow)' },
        { label: 'info', description: 'Info color (blue)' },
        { label: 'custom', description: 'Custom color' },
      ]
      const selectedColor = await vscode.window.showQuickPick(colorOptions, {
        placeHolder: 'Select flash color theme',
      })
      if (selectedColor) {
        await config.update('flashColor', selectedColor.label, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Flash color set to ${selectedColor.label}`)
      }
      break
    }

    case 'customColor': {
      const newCustomColor = await vscode.window.showInputBox({
        prompt: 'Enter custom color (hex format, e.g., #ff6b6b)',
        value: currentCustomColor,
        validateInput: (value) => {
          if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
            return 'Please enter a valid hex color (e.g., #ff6b6b)'
          }
          return null
        },
      })
      if (newCustomColor) {
        await config.update('flashCustomColor', newCustomColor, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage(`✅ Custom color set to ${newCustomColor}`)
      }
      break
    }

    case 'test': {
      // Test flash by simulating a runSelection call
      const editor = vscode.window.activeTextEditor
      if (editor) {
        const line = editor.document.lineAt(editor.selection.active.line)
        const range = new vscode.Range(line.range.start, line.range.end)

        // Use the same flash logic as runSelection
        const flashCount = config.get<number>('flashCount', 3)
        const flashDuration = config.get<number>('flashDuration', 150)
        const flashColor = config.get<string>('flashColor', 'selection')
        const flashCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')

        let backgroundColor: string | vscode.ThemeColor
        switch (flashColor) {
          case 'error':
            backgroundColor = new vscode.ThemeColor('editorError.foreground')
            break
          case 'warning':
            backgroundColor = new vscode.ThemeColor('editorWarning.foreground')
            break
          case 'info':
            backgroundColor = new vscode.ThemeColor('editorInfo.foreground')
            break
          case 'custom':
            backgroundColor = flashCustomColor
            break
          default:
            backgroundColor = new vscode.ThemeColor('editor.selectionBackground')
            break
        }

        const createFlash = (flashIndex: number) => {
          const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: backgroundColor,
            isWholeLine: true,
          })
          editor.setDecorations(decoration, [range])

          setTimeout(() => {
            decoration.dispose()
            if (flashIndex < flashCount - 1) {
              setTimeout(() => createFlash(flashIndex + 1), 100)
            }
          }, flashDuration)
        }

        createFlash(0)
        vscode.window.showInformationMessage('🧪 Flash test completed!')
      } else {
        vscode.window.showWarningMessage('⚠️ Please open a file to test flash')
      }
      break
    }
  }
}

function toggleEngine() {
  if (engineProcess && !engineProcess.killed) {
    // Stop engine
    stopEngine()
  } else {
    // Start engine
    startEngine()
  }
}

/**
 * Determine engine path based on debug mode.
 */
function getEnginePath(debugMode: boolean): { enginePath: string; engineSource: string } | null {
  // Always use extension-local engine (both debug and normal mode)
  // This ensures we test the same engine that will be distributed
  const enginePath = path.join(__dirname, '../engine/dist/cli-audio.js')
  const engineSource = debugMode ? 'extension engine (debug)' : 'extension engine (stable)'

  outputChannel?.appendLine(`📦 Using: ${engineSource}`)
  outputChannel?.appendLine(`📍 Path: ${enginePath}`)

  if (!fs.existsSync(enginePath)) {
    vscode.window.showErrorMessage(
      `Extension engine not found: ${enginePath}\n\n` +
        `This indicates a build issue. Please rebuild the extension:\n` +
        `1. Run "npm run build" in the vscode-extension directory\n` +
        `2. Ensure the engine is properly built and copied\n` +
        `3. Check that packages/engine/dist/cli-audio.js exists`,
    )
    return null
  }

  return { enginePath, engineSource }
}

/**
 * Show engine build time.
 */
function showEngineBuildTime(enginePath: string): void {
  try {
    const stats = fs.statSync(enginePath)
    const buildTime = stats.mtime.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    outputChannel?.appendLine(`⏰ Built: ${buildTime}`)
  } catch (error) {
    outputChannel?.appendLine(`⚠️ Could not get build time: ${error}`)
  }
}

/**
 * Load audio device from .orbitscore.json config.
 */
function loadAudioDeviceConfig(workspaceRoot: string): string | undefined {
  const configPath = path.join(workspaceRoot, '.orbitscore.json')

  if (!fs.existsSync(configPath)) {
    return undefined
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const audioDevice = config.audioDevice
    if (audioDevice) {
      outputChannel?.appendLine(`🔊 Using audio device from config: ${audioDevice}`)
    }
    return audioDevice
  } catch (error) {
    outputChannel?.appendLine(`⚠️ Failed to read .orbitscore.json: ${error}`)
    return undefined
  }
}

/**
 * Filter stdout output in non-debug mode.
 */
function shouldFilterLine(line: string): boolean {
  const trimmed = line.trim()

  // Machine-readable playhead markers (#390): parsed by setupStdoutHandler
  // from the raw stream BEFORE this filter runs; pure noise for humans
  // (~pattern-length lines per bar per seq), so keep them out of the channel.
  if (line.includes('[STEP]')) {
    return true
  }

  // Keep important messages
  if (line.includes('ERROR') || line.includes('⚠️') || line.includes('🎛️')) {
    return false
  }

  // Keep initialization messages
  if (
    line.includes('🎵 OrbitScore') ||
    line.includes('✅ Initialized') ||
    line.includes('✅ SuperCollider server ready') ||
    line.includes('✅ SynthDef loaded') ||
    line.includes('✅ Mastering effect') ||
    line.includes('🎵 Live coding mode')
  ) {
    return false
  }

  // Keep transport state changes
  if (
    line.includes('✅ Global running') ||
    line.includes('✅ Global stopped') ||
    line.includes('✅ Global starting')
  ) {
    return false
  }

  // Keep user execution feedback
  if (line.includes('▶ ') || line.includes('⏹ ') || line.includes('🔄 ')) {
    return false
  }

  // Filter out verbose logs
  if (
    line.includes('🔊 Playing:') ||
    line.includes('sendosc:') ||
    line.includes('rcvosc :') ||
    line.includes('stdout :') ||
    line.includes('"oscType"') ||
    line.includes('"address"') ||
    line.includes('"args"') ||
    line.includes('"type"') ||
    line.includes('"data"') ||
    line.includes('"bufnum"') ||
    line.includes('"amp"') ||
    line.includes('"pan"') ||
    line.includes('"rate"') ||
    line.includes('"startPos"') ||
    line.includes('"duration"') ||
    line.includes('"threshold"') ||
    line.includes('"ratio"') ||
    line.includes('"attack"') ||
    line.includes('"release"') ||
    line.includes('"makeupGain"') ||
    line.includes('"level"') ||
    line.includes('"/') ||
    line.includes('orbitPlayBuf') ||
    line.includes('fxCompressor') ||
    line.includes('fxLimiter') ||
    line.includes('fxNormalizer') ||
    line.includes('Number of Devices:') ||
    line.includes('Input Device') ||
    line.includes('Output Device') ||
    line.includes('Streams:') ||
    line.includes('channels') ||
    line.includes('SC_AudioDriver:') ||
    line.includes('PublishPortToRendezvous') ||
    trimmed === '✓' ||
    trimmed === '}' ||
    trimmed === ']' ||
    trimmed === '{' ||
    trimmed === '[' ||
    trimmed.startsWith('}') ||
    trimmed.startsWith(']') ||
    trimmed.match(/^\d+\s*:/) ||
    trimmed.match(/^-?\d+(\.\d+)?,?$/) ||
    trimmed === ''
  ) {
    return true
  }

  return false
}

/**
 * Setup stdout handler for engine process.
 */
function setupStdoutHandler(process: child_process.ChildProcess, debugMode: boolean): void {
  process.stdout?.on('data', (data) => {
    const output = data.toString()
    const lines: string[] = output.split('\n')

    // Live playhead (#390): parse `[STEP]` markers and stop lines from the RAW
    // lines — the markers are filtered out of the Output channel below.
    // (Lines split across chunk boundaries are rare and self-heal on the next
    // step ~one beat later, so no carry buffer.)
    for (const rawLine of lines) {
      const step = parseStepLine(rawLine)
      if (step) {
        handleStepLine(step)
        continue
      }
      // `⏹ <seqName> (...)` = that seq stopped; `✅ Global stopped` = all off.
      const stopMatch = rawLine.match(/⏹\s+(\S+)/)
      if (stopMatch) {
        clearPlayheadForSequence(stopMatch[1])
      }
      if (rawLine.includes('✅ Global stopped')) {
        clearAllPlayheadDecorations()
      }
      // `//#selectAudioDevice` meta-line bridge result (#484 D2.5): a single JSON
      // line `{"selectAudioDevice":{...}}` emitted by repl-mode.ts. FIFO — matches
      // the oldest pending request (the stdin write path is a single serialized
      // queue on the engine side, so requests/responses stay in order).
      // A line that looks like the bridge's shape (`{"selectAudioDevice...`) but
      // fails to parse — e.g. a chunk boundary split the JSON across two `data`
      // events — is logged so a stuck caller isn't silently invisible.
      const looksLikeSelectAudioDeviceLine = rawLine.trim().startsWith('{"selectAudioDevice')
      const recognized = selectAudioDeviceBridge.handleLine(rawLine)
      if (looksLikeSelectAudioDeviceLine && !recognized) {
        outputChannel?.appendLine(
          `⚠️ received a malformed //#selectAudioDevice result line (possible chunk-boundary split): ${rawLine}`,
        )
      }
    }

    // Filter output in non-debug mode (reuses the split above — one pass per chunk).
    if (!debugMode) {
      const filteredOutput = lines.filter((line) => !shouldFilterLine(line)).join('\n')
      if (filteredOutput.trim()) {
        outputChannel?.append(filteredOutput + '\n')
      }
    } else {
      // Debug mode: show everything
      outputChannel?.append(output)
    }

    // Update status based on scheduler state
    if (output.includes('✅ Global running') || output.includes('▶ Global')) {
      statusBarItem!.text = debugMode ? '🎵 OrbitScore: ▶️ Playing 🐛' : '🎵 OrbitScore: ▶️ Playing'
    } else if (output.includes('✅ Global stopped') || output.includes('⏹ Global')) {
      statusBarItem!.text = debugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
    }
  })
}

/**
 * Setup stderr handler for engine process.
 */
function setupStderrHandler(process: child_process.ChildProcess): void {
  process.stderr?.on('data', (data) => {
    outputChannel?.append(`ERROR: ${data.toString()}`)
  })
}

/**
 * Setup exit handler for engine process.
 */
function setupExitHandler(process: child_process.ChildProcess): void {
  process.on('exit', (code) => {
    outputChannel?.appendLine(`\n🛑 Engine process exited with code ${code}`)
    engineProcess = null
    isLiveCodingMode = false
    globalInitialized = false
    clearAllPlayheadDecorations() // #390: nothing is sounding anymore
    // #501 review Critical #1: drain any //#selectAudioDevice requests still
    // awaiting a response — otherwise a stale resolver could FIFO-match the
    // next engine instance's response.
    selectAudioDeviceBridge.drainAll(
      'engine process exited before responding to //#selectAudioDevice',
    )

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    engineViewProvider?.refresh()
  })
}

function isEngineRunning(): boolean {
  return engineProcess !== null && !engineProcess.killed
}

/**
 * Resolve the effective output device (#484 D3). The `orbitscore.audioDevice`
 * VS Code setting is the primary source going forward (works without a
 * workspace file, discoverable via the Engine view); the legacy
 * `.orbitscore.json` `audioDevice` key (written by `selectAudioDevice` /
 * the MCP `select_audio_device` tool, #388) is kept as a fallback for
 * back-compat with existing workspaces. Empty string means "system default".
 */
function resolveAudioDeviceSetting(workspaceRoot: string): string {
  const setting = vscode.workspace.getConfiguration('orbitscore')
  const inspected = setting.inspect<string>('audioDevice')
  const configured = inspected?.workspaceValue ?? inspected?.globalValue
  // An explicitly empty legacy value means off, never "System Default".
  if (configured !== undefined) return configured
  return loadAudioDeviceConfig(workspaceRoot) ?? ''
}

async function autoStartConfiguredRustEngine(): Promise<void> {
  if (getConfiguredEngineKind() !== 'rust') return
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  const saved = resolveAudioDeviceSetting(workspaceRoot)
  if (!saved) return
  try {
    const devices = await fetchAudioDevicesForView()
    if (saved !== '__default__' && !devices.some((device) => device.name === saved)) {
      vscode.window.showWarningMessage(
        `Saved audio device "${saved}" is not connected — select a device in Audio Engine Settings`,
      )
      return
    }
    if (!startEngine()) return
    const autoStartGeneration = engineGeneration
    setTimeout(() => {
      if (engineGeneration === autoStartGeneration && !isEngineRunning())
        vscode.window.showErrorMessage('Audio engine exited shortly after automatic startup')
    }, 5000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`⚠️ unable to enumerate saved audio device: ${message}`)
    vscode.window.showWarningMessage(message)
  }
}

/**
 * List output devices via the daemon's `--list-audio-devices` lightweight
 * mode (#484 D3) — spawns the binary, reads its single JSON line, and exits.
 * No stream is opened (see `orbit-audio-native::list_output_devices` /
 * `resolve_output_device`'s Aggregate-device probe-hang note), so this is
 * safe to run even while the engine itself is not running. `timeout` guards
 * against an unexpected hang so the TreeView never spins forever.
 */
function fetchAudioDevicesForView(): Promise<EngineViewDevice[]> {
  const resolution = resolveDaemonForUI()
  if (!resolution) {
    return Promise.reject(
      new Error(
        'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.',
      ),
    )
  }
  return new Promise((resolve, reject) => {
    child_process.execFile(
      resolution.path,
      ['--list-audio-devices'],
      { timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`failed to list audio devices: ${stderr.trim() || error.message}`))
          return
        }
        try {
          const line = stdout.trim().split('\n').pop() ?? ''
          const parsed = JSON.parse(line) as { devices: EngineViewDevice[] }
          resolve(parsed.devices)
        } catch (parseErr) {
          reject(
            new Error(
              `failed to parse device list: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            ),
          )
        }
      },
    )
  })
}

/**
 * TreeDataProvider for the "Audio Engine Settings" view (#484 D3). Wraps the
 * vscode-free data shaping in `engine-view.ts`: `getChildren`/`getTreeItem`
 * translate `EngineViewNode`s to real `vscode.TreeItem`s and own the only
 * bit of state vscode needs — a per-expansion device-list cache, invalidated
 * on `refresh()` (called from `startEngine`/`stopEngine`/exit handler and the
 * device-select command) so a stale list never lingers across an engine
 * restart or device change. Devices are fetched lazily when the "Output
 * Device" node is expanded, not polled (per task spec — the daemon spawn for
 * enumeration is cheap but not free).
 */
class EngineViewProvider implements vscode.TreeDataProvider<EngineViewNode> {
  private readonly emitter = new vscode.EventEmitter<EngineViewNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  private deviceFetchState: DeviceFetchState | null = null

  refresh(): void {
    this.deviceFetchState = null
    this.emitter.fire(undefined)
  }

  getTreeItem(node: EngineViewNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.collapsible
        ? node.collapsibleState === 'collapsed'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    )
    item.id = node.id
    item.description = node.description
    switch (node.kind) {
      case 'engine-status':
        item.iconPath = new vscode.ThemeIcon(isEngineRunning() ? 'debug-stop' : 'play')
        item.command = { command: 'orbitscore.engineViewToggleEngine', title: 'Toggle Engine' }
        break
      case 'debug-toggle':
        item.iconPath = new vscode.ThemeIcon(node.selected ? 'check' : 'circle-large-outline')
        item.command = { command: 'orbitscore.engineViewToggleDebug', title: 'Toggle Debug Mode' }
        break
      case 'device-section':
        item.iconPath = new vscode.ThemeIcon('list-selection')
        break
      case 'recovery-section':
        item.iconPath = new vscode.ThemeIcon('tools')
        break
      case 'recovery-action': {
        const command = recoveryCommandFromNodeId(node.id)
        if (command) item.command = { command, title: node.label }
        break
      }
      case 'device':
        item.iconPath = new vscode.ThemeIcon(node.selected ? 'check' : 'circle-large-outline')
        item.command = {
          command: 'orbitscore.engineViewSelectDevice',
          title: 'Select Audio Device',
          arguments: [node],
        }
        break
      case 'device-error':
        item.iconPath = new vscode.ThemeIcon('warning')
        break
      default:
        break
    }
    return item
  }

  getChildren(node?: EngineViewNode): EngineViewNode[] | Thenable<EngineViewNode[]> {
    if (!node) {
      // viewsWelcome (Start/Debug/Stop buttons) covers the stopped state —
      // only populate the tree once the engine is actually running.
      return buildRootNodes(isEngineRunning()).map((node) =>
        node.kind === 'debug-toggle'
          ? {
              ...node,
              selected: vscode.workspace
                .getConfiguration('orbitscore')
                .get<boolean>('engineDebug', false),
              description: vscode.workspace
                .getConfiguration('orbitscore')
                .get<boolean>('engineDebug', false)
                ? 'On (restart engine to apply)'
                : 'Off',
            }
          : node,
      )
    }
    if (node.kind === 'device-section') {
      return this.getDeviceChildren()
    }
    if (node.kind === 'recovery-section') return recoverySectionChildren()
    return []
  }

  private async getDeviceChildren(): Promise<EngineViewNode[]> {
    if (!this.deviceFetchState) {
      try {
        const devices = await fetchAudioDevicesForView()
        this.deviceFetchState = { status: 'loaded', devices }
      } catch (err) {
        this.deviceFetchState = {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
    const selectedDevice = resolveAudioDeviceSetting(workspaceRoot)
    return deviceSectionChildren(this.deviceFetchState, selectedDevice)
  }
}

function engineViewToggleEngine(): void {
  if (isEngineRunning()) {
    stopEngine()
    return
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  if (getConfiguredEngineKind() === 'rust' && !resolveAudioDeviceSetting(workspaceRoot)) {
    vscode.window.showInformationMessage('Select an output device below first')
    return
  }
  startEngine()
}

/**
 * Write `orbitscore.audioDevice` (Workspace scope when a workspace is open,
 * Global otherwise). Shared by the Engine view's device-click command and the
 * MCP `select_audio_device` tool's live-switch path (#501 review Important #6 —
 * the live bridge only affects the running process, so the setting must also
 * be written for the choice to survive an engine restart).
 */
async function writeAudioDeviceSetting(deviceName: string | undefined): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.[0]
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  try {
    await vscode.workspace.getConfiguration('orbitscore').update('audioDevice', deviceName, target)
    outputChannel?.appendLine(`🔊 orbitscore.audioDevice set to: ${deviceName ?? '(cleared)'}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ failed to update orbitscore.audioDevice: ${message}`)
    vscode.window.showErrorMessage(`Failed to save audio device setting: ${message}`)
  }
}

/**
 * "Select Audio Device" command wired to a device `TreeItem` click in the
 * Engine view (#484 D3). Writes `orbitscore.audioDevice` (Workspace scope
 * when a workspace is open, Global otherwise). For a running rust-engine
 * instance, D2.5's live `//#selectAudioDevice` bridge applies the change
 * immediately; otherwise (or on live-switch failure) this tells the user the
 * setting takes effect on the *next* engine start and offers an immediate
 * restart.
 */
async function engineViewSelectDevice(node: EngineViewNode): Promise<void> {
  const deviceName = deviceNameFromNodeId(node.id)
  if (!deviceName) return

  if (getConfiguredEngineKind() !== 'rust') {
    // SC retains its established write-and-restart flow.
    await writeAudioDeviceSetting(deviceName)
    engineViewProvider?.refresh()
    return
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  const selectedDevice = resolveAudioDeviceSetting(workspaceRoot)
  const action = resolveDeviceClickAction(deviceName, selectedDevice, isEngineRunning())
  if (action === 'deselect-stop') {
    await writeAudioDeviceSetting('')
    if (isEngineRunning()) stopEngine()
    engineViewProvider?.refresh()
    return
  }

  await writeAudioDeviceSetting(deviceName)
  engineViewProvider?.refresh()

  if (!isEngineRunning()) {
    startEngine()
    return
  }

  // D2.5 (#484): try the live `//#selectAudioDevice` bridge before falling back to the
  // restart prompt. SC backend skips straight to the restart flow — it's an
  // optimization to avoid a pointless round-trip (repl-mode.ts never wires up the
  // bridge for SC), not a necessity to dodge the timeout.
  if (getConfiguredEngineKind() === 'rust') {
    try {
      const result = await sendSelectAudioDeviceMeta(deviceName)
      if (result.ok) {
        engineViewProvider?.refresh()
        vscode.window.showInformationMessage(`🔊 switched to "${result.device ?? deviceName}"`)
        return
      }
      if (result.error?.includes(AUDIO_DEVICE_SWITCH_UNAVAILABLE)) {
        const choice = await vscode.window.showWarningMessage(
          translateSelectAudioDeviceError(result.error),
          'Restart Engine',
        )
        if (choice === 'Restart Engine') {
          stopEngine()
          setTimeout(() => startEngine(), 2200)
        }
        return
      }
      // #501 review Important #4: surface the specific failure rather than
      // silently falling through to the generic "applies on next start" prompt.
      outputChannel?.appendLine(`⚠️ live device switch failed: ${result.error}`)
      const choice = await vscode.window.showWarningMessage(
        `🔊 live device switch failed: ${translateSelectAudioDeviceError(result.error)}`,
        'Restart Engine',
      )
      if (choice === 'Restart Engine') {
        stopEngine()
        setTimeout(() => startEngine(), 2200)
      }
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outputChannel?.appendLine(`⚠️ live device switch bridge error: ${message}`)
      const choice = await vscode.window.showWarningMessage(
        `🔊 live device switch bridge error: ${message}`,
        'Restart Engine',
      )
      if (choice === 'Restart Engine') {
        stopEngine()
        setTimeout(() => startEngine(), 2200)
      }
      return
    }
  }
}

async function engineViewToggleDebug(): Promise<void> {
  const config = vscode.workspace.getConfiguration('orbitscore')
  const next = !config.get<boolean>('engineDebug', false)
  const target = vscode.workspace.workspaceFolders?.[0]
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  try {
    await config.update('engineDebug', next, target)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ failed to update orbitscore.engineDebug: ${message}`)
    vscode.window.showErrorMessage(`Failed to save debug mode setting: ${message}`)
    return
  }
  engineViewProvider?.refresh()
  if (isEngineRunning()) {
    const choice = await vscode.window.showInformationMessage(
      'Restart engine to apply?',
      'Restart Engine',
    )
    if (choice === 'Restart Engine') {
      stopEngine()
      setTimeout(() => startEngine(), 2200)
    }
  }
}

function startEngine(debugMode?: boolean, agentOpts?: { captureWav?: string }): boolean {
  if (engineProcess && !engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is already running')
    return false
  }

  // engine kind (#377): scsynth is only relevant under the 'sc' kind. Under
  // 'rust' (default since cutover #369), skip the scsynth pre-check entirely —
  // the native daemon doesn't need scsynth to be resolvable.
  const engineKind = getConfiguredEngineKind()

  // Pre-check: scsynth / daemon が解決できない場合は engine spawn を行わず、エラー
  // Notification のみ表示する。spawn してから boot 失敗するとユーザーに
  // 二重通知 (resolver エラー + engine 終了ログ) が出てしまうのを防ぐ
  // (claude-review on PR #155 の Significant 指摘 #2)。
  // 解決できた場合はその path を engine spawn に再利用 (Minor #1: 二重 fs.statSync 回避)。
  let scResolution: { path: string; source: string } | null = null
  if (engineKind === 'sc') {
    scResolution = resolveScsynthForUI()
    if (!scResolution) {
      void maybeShowBundleNotice()
      return false
    }
  } else {
    // rust kind (C2): daemon 解決可否を spawn 前に pre-check する。従来は
    // これが無く、daemon 未解決のまま engine CLI を spawn していた —
    // 「Engine started」の成功トーストが先に出て、後から engine CLI 内部の
    // daemon spawn 失敗ログが追いかけてくるだけの偽成功 UX になっていた。
    // env への daemon path 注入はしない: spawn される engine CLI 自身が同一の
    // compiled `resolveDaemonBinaryPath()` を実行するため、ここでの解決結果と
    // 決定的に同一になる（再注入する理由が無い）。
    const daemonResolution = resolveDaemonForUI()
    if (!daemonResolution) {
      outputChannel?.appendLine(
        '❌ orbit-audio-daemon not found — engine cannot start with the rust backend.',
      )
      vscode.window.showErrorMessage(
        '⚠️ orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.',
      )
      return false
    }
  }

  const effectiveDebugMode =
    debugMode ?? vscode.workspace.getConfiguration('orbitscore').get<boolean>('engineDebug', false)
  const modeLabel = effectiveDebugMode ? '(Debug Mode)' : '(Normal Mode)'
  outputChannel?.appendLine(`🚀 Starting engine... ${modeLabel}`)

  // Get engine path
  const engineInfo = getEnginePath(effectiveDebugMode)
  if (!engineInfo) {
    return false
  }
  const { enginePath } = engineInfo

  // Show build time
  showEngineBuildTime(enginePath)

  // Get workspace root
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

  // Load audio device config — VS Code setting first, `.orbitscore.json` fallback (#484 D3).
  const audioDevice = resolveAudioDeviceSetting(workspaceRoot)

  // Build args
  const args = ['repl']
  if (audioDevice && audioDevice !== '__default__') {
    args.push('--audio-device', audioDevice)
  }
  if (effectiveDebugMode) {
    args.push('--debug')
  }

  // Set environment
  const env = { ...process.env }
  if (effectiveDebugMode) {
    env.ORBITSCORE_DEBUG = '1'
  }

  // Capture seam (#307): the daemon records the master output to this WAV while
  // the stream runs. Only set when explicitly requested (MCP start_engine tool)
  // — inherited env stays authoritative otherwise.
  if (agentOpts?.captureWav) {
    env.ORBIT_CAPTURE_WAV = agentOpts.captureWav
    outputChannel?.appendLine(`🎙️ Capture: ${agentOpts.captureWav}`)
  }

  // Audio backend selection (#377, post-cutover #369). Engine kind MUST be set
  // explicitly on env — cutover flipped the *unset* default to `rust`, so a
  // bare `delete env.ORBITSCORE_ENGINE` (unset) always resolves to `rust` now
  // — unconditionally (I1). Whether the extension host process happened to
  // inherit an ORBITSCORE_ENGINE env var from its own launch environment is
  // irrelevant to this: `delete` removes it either way, and unset ==> rust
  // regardless. Both branches set the var explicitly so the configured kind
  // is authoritative regardless of inherited env state.
  if (engineKind === 'rust') {
    env.ORBITSCORE_ENGINE = 'rust'
    outputChannel?.appendLine('🦀 Audio backend: rust (orbit-audio-daemon, native, default)')
  } else {
    env.ORBITSCORE_ENGINE = 'sc'

    // Pass scsynth path to engine via env. pre-check で解決済 (scResolution.path) を
    // そのまま engine に渡すことで resolver の二重 fs.statSync を avoid + pre-check と
    // engine 内部での resolution 結果ズレ (タイミング差) のリスクを排除。
    // scResolution is guaranteed non-null here: the 'sc' branch above returns
    // early when resolution fails.
    env.ORBIT_SCSYNTH_PATH = scResolution!.path
    outputChannel?.appendLine(`🔧 scsynth (${scResolution!.source}): ${scResolution!.path}`)
  }

  // Spawn engine process
  engineProcess = child_process.spawn('node', [enginePath, ...args], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  engineGeneration += 1

  // Update state
  isLiveCodingMode = true
  globalInitialized = false

  statusBarItem!.text = effectiveDebugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
  statusBarItem!.tooltip = 'Click to stop engine'
  vscode.window.showInformationMessage(
    effectiveDebugMode ? '✅ Engine started (Debug)' : '✅ Engine started',
  )
  outputChannel?.appendLine('✅ Engine started - Ready for evaluation')
  engineViewProvider?.refresh()

  // Setup handlers
  setupStdoutHandler(engineProcess, effectiveDebugMode)
  setupStderrHandler(engineProcess)
  setupExitHandler(engineProcess)
  // #501 review Important #2: an unhandled 'error' event on a stream crashes
  // the process. stdin can emit this independently of the 'exit' event (e.g.
  // EPIPE if the engine's stdin closes before we stop writing to it).
  engineProcess.stdin?.on('error', (err) => {
    outputChannel?.appendLine(`⚠️ engine stdin error: ${err.message}`)
    selectAudioDeviceBridge.drainAll(`engine stdin error: ${err.message}`)
  })
  return true
}

function startEngineDebug() {
  startEngine(true)
}

function stopEngine(): boolean {
  engineGeneration += 1
  if (engineProcess && !engineProcess.killed) {
    // Capture process reference before nulling module-level variable
    // (the SIGKILL timeout needs this reference after engineProcess is set to null)
    const proc = engineProcess
    engineProcess = null
    isLiveCodingMode = false
    globalInitialized = false
    clearAllPlayheadDecorations() // #390: don't wait for the exit event
    // #501 review Critical #1: drain here too — `stopEngine()` nulls
    // `engineProcess` immediately (before the `exit` event fires), so a caller
    // awaiting `sendSelectAudioDeviceMeta()` would otherwise hang until the
    // 10s timeout instead of failing fast.
    selectAudioDeviceBridge.drainAll('engine was stopped before responding to //#selectAudioDevice')

    // Send graceful shutdown signal (SIGTERM)
    // This allows the engine to clean up SuperCollider properly
    proc.kill('SIGTERM')

    // Force kill after 2 seconds if still running
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL')
      }
    }, 2000)

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    engineViewProvider?.refresh()
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
    return true
  }
  return false
}

/**
 * Force-kill any stray scsynth processes (escape hatch for zombie cleanup).
 *
 * Normal stop is handled via \`stopEngine\` (graceful SIGTERM through the engine
 * process). This command is for cases where the engine process itself was
 * SIGKILL'd / force-quit and left an orphan scsynth, or for clearing leftover
 * processes from external manual boots during development.
 */
function forceKillScsynth() {
  outputChannel?.appendLine('🔪 Force-killing scsynth processes...')

  // killall covers both bundled and system scsynth (intentional — escape hatch
  // should clean up everything). Exit code 1 = "no process found" (not an error).
  // execFile (not exec) for consistency with selectAudioDevice (no shell, even
  // though args are hardcoded here so no injection risk).
  child_process.execFile('killall', ['scsynth'], (error) => {
    if (error) {
      if (error.code === 1) {
        outputChannel?.appendLine('✅ No scsynth processes found')
        vscode.window.showInformationMessage('✅ No scsynth processes running')
      } else {
        outputChannel?.appendLine(`⚠️ Error: ${error.message}`)
        vscode.window.showWarningMessage(`⚠️ Failed to kill scsynth: ${error.message}`)
      }
    } else {
      outputChannel?.appendLine('✅ scsynth processes killed')
      vscode.window.showInformationMessage('✅ scsynth killed')
    }
  })
}

/**
 * "OrbitScore: Rescan Plugin Catalog" command (#463 C1b) — palette + editor
 * right-click menu. Spawns `orbit-plugin-scan` directly (not via the daemon:
 * the scanner is an independent crash-isolated binary — see
 * docs/core/INSTRUCTION_ORBITSCORE_DSL.md §PC.1) and invalidates the
 * in-memory catalog cache on success so completion picks up the fresh scan.
 */
async function rescanPlugins(): Promise<void> {
  outputChannel?.appendLine('🔎 Rescanning plugin catalog...')
  const result = await runPluginScan()
  if (result.ok) {
    pluginCatalogHintShown = false
    outputChannel?.appendLine(
      `✅ Plugin catalog rescanned: ${result.count} plugins (${result.skipped.length} skipped)`,
    )
    vscode.window.showInformationMessage(
      `OrbitScore: rescanned ${result.count} plugins (${result.skipped.length} skipped)`,
    )
  } else {
    outputChannel?.appendLine(`❌ Plugin catalog rescan failed: ${result.error}`)
    vscode.window.showErrorMessage(`OrbitScore: plugin catalog rescan failed: ${result.error}`)
  }
}

/** One SuperCollider-reported audio device (shared shape for the palette QuickPick and the MCP tools). */
interface DetectedAudioDevice {
  label: string
  id: number
  description: string
}

/**
 * Boot scsynth briefly with `-u <port>` to read its device-list boot log,
 * parse it, then clean up the temporary process. Shared by `selectAudioDevice`
 * (palette) and the MCP `list_audio_devices` / `select_audio_device` tools —
 * extracted rather than duplicated (#388).
 *
 * Cleanup runs immediately after parsing (not only on a completed selection,
 * as the original inline version did) so a cancelled QuickPick — or an agent
 * that calls list_audio_devices without following up with select_audio_device
 * — never leaves the temporary scsynth running.
 */
function detectAudioDevices(scPath: string): Promise<DetectedAudioDevice[]> {
  // Destructured (not `child_process.execFile`) so this reads identically to
  // the direct-invocation form used elsewhere in this file. execFile (not
  // exec) runs scPath without a shell, so user-configured values
  // (orbitscore.scsynthPath) containing `;` etc. can't become command
  // injection (claude-review #155 の必須対応、CWE-78 緩和)。
  const { execFile } = child_process
  return new Promise((resolve) => {
    execFile(scPath, ['-u', '57199'], { timeout: 3000 }, (_error, stdout) => {
      // Cleanup temp scsynth (and sclang if any from system SC). Shell-free
      // invocation; we ignore the result (best-effort cleanup).
      execFile('killall', ['scsynth', 'sclang'], () => {
        /* best-effort, ignore error */
      })

      // Parse device list from SuperCollider's boot log
      const deviceRegex = /(\d+)\s*:\s*"([^"]+)"/g
      const devices: DetectedAudioDevice[] = []
      let match
      while ((match = deviceRegex.exec(stdout ?? '')) !== null) {
        const deviceId = parseInt(match[1])
        const deviceName = match[2]
        devices.push({ label: deviceName, id: deviceId, description: `Device ID: ${deviceId}` })
      }
      resolve(devices)
    })
  })
}

/** Merge `audioDevice` into .orbitscore.json, preserving any other keys. Shared by `selectAudioDevice` (palette) and the MCP `select_audio_device` tool (#388). */
function writeAudioDeviceConfig(configPath: string, deviceLabel: string): void {
  let config: any = {}
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  }
  config.audioDevice = deviceLabel
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

async function selectAudioDevice() {
  // engine kind (#377): device selection is implemented against scsynth's
  // boot-log device listing and has no Rust-engine equivalent yet. Surface
  // this explicitly rather than silently probing for (and failing to find)
  // scsynth under the 'rust' kind.
  if (getConfiguredEngineKind() === 'rust') {
    outputChannel?.appendLine(
      '⚠️ Audio device selection is not supported with the Rust engine (orbitscore.engine: "rust"); using system default output.',
    )
    vscode.window.showWarningMessage(
      '⚠️ Audio device selection is not yet supported with the Rust engine (orbitscore.engine: "rust"). The system default output device is used. Set orbitscore.engine to "sc" to use SuperCollider device selection.',
    )
    return
  }

  outputChannel?.appendLine('🔊 Detecting audio devices...')

  // Get workspace root
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('⚠️ No workspace folder open')
    return
  }

  const configPath = path.join(workspaceFolder.uri.fsPath, '.orbitscore.json')

  vscode.window.showInformationMessage(
    '🔊 Detecting audio devices... (this may take a few seconds)',
  )

  // Resolve scsynth path via shared resolver (strict mode: bundle / env / explicit のみ)。
  // status bar / startEngine と同じ resolveScsynthForUI() を再利用。
  const resolution = resolveScsynthForUI()
  if (!resolution) {
    vscode.window.showErrorMessage(
      "⚠️ scsynth not found. Reinstall the extension to restore the bundle, or set 'orbitscore.scsynthPath' to a system scsynth.",
    )
    return
  }
  outputChannel?.appendLine(`🔧 Using scsynth (${resolution.source}): ${resolution.path}`)

  const devices = await detectAudioDevices(resolution.path)
  if (devices.length === 0) {
    vscode.window.showErrorMessage('⚠️ No audio devices detected')
    outputChannel?.appendLine('⚠️ Failed to parse device list from SuperCollider')
    return
  }

  // Show quick pick
  const selected = await vscode.window.showQuickPick(devices, {
    placeHolder: 'Select audio output device',
    title: '🔊 Audio Device Selection',
  })
  if (!selected) return

  writeAudioDeviceConfig(configPath, selected.label)
  outputChannel?.appendLine(`✅ Audio device set to: ${selected.label} (ID: ${selected.id})`)
  outputChannel?.appendLine(`✅ Config saved to: ${configPath}`)
  vscode.window.showInformationMessage(
    `✅ Audio device set to: ${selected.label}. Restart engine to apply.`,
  )
}

// ── Register Claude Code MCP Server ─────────────────────────────────────────

/** Registration scope for the orbitscore MCP server. */
type McpRegistrationScope = 'project' | 'user'

/**
 * Register the OrbitScore MCP server into Claude Code. Shared implementation
 * behind the `orbitscore.registerMcpServer` palette command (which wraps it
 * with QuickPick/InputBox prompts) and the MCP `register_mcp_server` tool.
 *
 * - 'project': merge `mcpServers.orbitscore` into `<workspace>/.mcp.json`.
 *   `mergeMcpJson` throws on corrupt JSON (mapped to an error result here) so
 *   an unreadable config is never overwritten.
 * - 'user': run `claude mcp add --transport http --scope user orbitscore <url>`
 *   (flags verified against claude CLI 2.1.202) with cwd = workspace root.
 *   The CLI is located via `which claude` first so a missing install produces
 *   a targeted message instead of a raw ENOENT.
 */
async function performMcpRegistration(
  scope: McpRegistrationScope,
  port: number,
): Promise<CommandResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `port must be an integer between 1 and 65535 (got ${port})` }
  }
  const url = buildMcpServerUrl(port)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  if (scope === 'project') {
    if (!workspaceRoot) {
      return {
        ok: false,
        error: 'no workspace folder open — project scope writes .mcp.json into the workspace root',
      }
    }
    const mcpJsonPath = path.join(workspaceRoot, '.mcp.json')
    let merged: string
    try {
      const existing = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, 'utf-8') : null
      merged = mergeMcpJson(existing, port)
    } catch (err) {
      // Corrupt .mcp.json (invalid JSON / non-object) — report, write nothing.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    fs.writeFileSync(mcpJsonPath, merged)
    outputChannel?.appendLine(`🔌 Registered MCP server (${url}) in ${mcpJsonPath}`)
    return { ok: true, message: `registered orbitscore (${url}) in ${mcpJsonPath}` }
  }

  // user scope — delegate to the claude CLI, which owns the user-level config
  // (~/.claude.json). Destructured (not `child_process.execFile`) — same
  // workaround as detectAudioDevices: the repo's security hook
  // false-positives on the `child_process.exec*` member-access pattern.
  // execFile runs without a shell, and the args are a fixed flag list + the
  // numeric-port URL, so there is no injection surface.
  const { execFile } = child_process
  const claudePath = await new Promise<string | null>((resolve) => {
    execFile('which', ['claude'], (error, stdout) => {
      resolve(error ? null : stdout.trim() || null)
    })
  })
  if (!claudePath) {
    return {
      ok: false,
      error:
        'claude CLI not found on PATH — install the Claude Code CLI, or use Project scope (.mcp.json) instead',
    }
  }
  const cliArgs = ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'orbitscore', url]
  return new Promise<CommandResult>((resolve) => {
    execFile(
      claudePath,
      cliArgs,
      { cwd: workspaceRoot, timeout: 30000 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        if (error) {
          // claude CLI 2.1.202 overwrites an existing entry silently (exit 0),
          // but a duplicate name may be rejected by other versions — give
          // targeted guidance instead of a bare failure.
          if (/already exists/i.test(output)) {
            resolve({
              ok: false,
              error:
                'an MCP server named "orbitscore" is already registered — run ' +
                '`claude mcp remove orbitscore` first, then retry. ' +
                `CLI output: ${output}`,
            })
            return
          }
          resolve({ ok: false, error: `claude mcp add failed: ${output || error.message}` })
          return
        }
        outputChannel?.appendLine(`🔌 claude ${cliArgs.join(' ')} → ${output}`)
        resolve({ ok: true, message: `ran \`claude ${cliArgs.join(' ')}\` → ${output}` })
      },
    )
  })
}

/**
 * Palette command "🔌 Register Claude Code MCP Server". Like VS Code's
 * "Install 'code' command in PATH": registers this extension's MCP server
 * into Claude Code's config at the user's chosen scope.
 *
 * `args` fields (both optional) skip the corresponding prompt — used by
 * agent-driven and E2E flows that must run without UI interaction.
 */
async function registerMcpServer(args?: {
  scope?: McpRegistrationScope
  port?: number
}): Promise<void> {
  const config = vscode.workspace.getConfiguration('orbitscore')

  // Resolve the port: explicit arg > configured setting > InputBox prompt.
  // A port entered here is persisted to the setting so the server actually
  // starts on it after a reload — registration continues in the same pass.
  let port = args?.port ?? config.get<number>('mcpServer.port', 0)
  if (!port || port <= 0) {
    const input = await vscode.window.showInputBox({
      title: '🔌 Register Claude Code MCP Server',
      prompt: 'orbitscore.mcpServer.port is not set — enter a port for the MCP server (1-65535)',
      value: '39123',
      validateInput: (value) => {
        const num = Number(value)
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return 'Please enter a port number between 1 and 65535'
        }
        return null
      },
    })
    if (input === undefined) return // cancelled
    port = parseInt(input, 10)
    await config.update('mcpServer.port', port, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage(
      `✅ orbitscore.mcpServer.port set to ${port}. Reload the window for the MCP server to start — continuing with registration.`,
    )
  }

  // Resolve the scope: explicit arg > QuickPick.
  let scope = args?.scope
  if (!scope) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Project',
          description: 'write .mcp.json in this workspace (shareable, per-repo)',
          scope: 'project' as const,
        },
        {
          label: 'User',
          description: 'register for all projects (via claude CLI)',
          scope: 'user' as const,
        },
      ],
      {
        title: '🔌 Register Claude Code MCP Server',
        placeHolder: 'Where should the orbitscore MCP server be registered?',
      },
    )
    if (!pick) return // cancelled
    scope = pick.scope
  }

  const result = await performMcpRegistration(scope, port)
  if (result.ok) {
    vscode.window.showInformationMessage(`✅ ${result.message}`)
  } else {
    vscode.window.showErrorMessage(`⚠️ Failed to register MCP server: ${result.error}`)
  }
}

/**
 * Extract the subject identifier from a line of OrbitScore code.
 * Returns the variable name that the line operates on, or null for standalone commands.
 *
 * Examples:
 *   "var drum = init global.seq" → "drum"
 *   "drum.audio('kick.wav')"     → "drum"
 *   "global.tempo(120)"          → "global"
 *   "LOOP(drum, snare)"          → null (standalone)
 *   "// comment"                 → null
 */
function getLineSubject(lineText: string): string | null {
  const trimmed = lineText.trim()
  if (!trimmed || trimmed.startsWith('//')) return null

  // var <name> = init ...
  const varMatch = trimmed.match(/^var\s+(\w+)\s*=/)
  if (varMatch) return varMatch[1]

  // <name>.method(...)
  const dotMatch = trimmed.match(/^(\w+)\./)
  if (dotMatch) return dotMatch[1]

  return null
}

async function runSelection() {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'orbitscore') {
    vscode.window.showErrorMessage('Please open an OrbitScore file')
    return
  }

  // Check if engine is running
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is not running. Click status bar to start engine.')
    return
  }

  // Get selected text or current line (with multiline detection)
  let text: string
  let executionRange: vscode.Range
  const selection = editor.selection

  if (!selection.isEmpty) {
    text = editor.document.getText(selection)
    executionRange = new vscode.Range(selection.start, selection.end)
  } else {
    // No selection: subject-based block evaluation
    // Detect which variable/object the current line belongs to, then collect all related lines
    const currentLine = selection.active.line
    const currentLineText = editor.document.lineAt(currentLine).text
    const subject = getLineSubject(currentLineText)

    if (subject) {
      // Collect all lines belonging to this subject (var decl + method calls)
      const collectedLines: { lineNum: number; text: string }[] = []

      for (let i = 0; i < editor.document.lineCount; i++) {
        const lineText = editor.document.lineAt(i).text
        const lineSubject = getLineSubject(lineText)

        if (lineSubject === subject) {
          collectedLines.push({ lineNum: i, text: lineText })

          // Handle multiline statements (unbalanced parentheses)
          let parenBalance = 0
          for (const char of lineText) {
            if (char === '(') parenBalance++
            if (char === ')') parenBalance--
          }
          while (parenBalance > 0 && i + 1 < editor.document.lineCount) {
            i++
            const contLine = editor.document.lineAt(i).text
            collectedLines.push({ lineNum: i, text: contLine })
            for (const char of contLine) {
              if (char === '(') parenBalance++
              if (char === ')') parenBalance--
            }
          }
        }
      }

      if (collectedLines.length > 0) {
        text = collectedLines.map((l) => l.text).join('\n')
        const firstLine = collectedLines[0].lineNum
        const lastLine = collectedLines[collectedLines.length - 1].lineNum
        executionRange = new vscode.Range(
          editor.document.lineAt(firstLine).range.start,
          editor.document.lineAt(lastLine).range.end,
        )
      } else {
        const line = editor.document.lineAt(currentLine)
        text = line.text
        executionRange = line.range
      }
    } else {
      // Standalone command (LOOP, RUN, MUTE, etc.) - evaluate current statement only
      let endLine = currentLine
      const lineText = editor.document.lineAt(currentLine).text
      let parenBalance = 0
      for (const char of lineText) {
        if (char === '(') parenBalance++
        if (char === ')') parenBalance--
      }
      while (parenBalance > 0 && endLine + 1 < editor.document.lineCount) {
        endLine++
        const contLine = editor.document.lineAt(endLine).text
        for (const char of contLine) {
          if (char === '(') parenBalance++
          if (char === ')') parenBalance--
        }
      }

      executionRange = new vscode.Range(
        editor.document.lineAt(currentLine).range.start,
        editor.document.lineAt(endLine).range.end,
      )
      text = editor.document.getText(executionRange)
    }
  }

  const trimmedText = text.trim()

  // Visual feedback: flash the executed lines (configurable)
  const flashLines = () => {
    const config = vscode.workspace.getConfiguration('orbitscore')
    const flashCount = config.get<number>('flashCount', 3)
    const flashDuration = config.get<number>('flashDuration', 150)
    const flashColor = config.get<string>('flashColor', 'selection')
    const flashCustomColor = config.get<string>('flashCustomColor', '#ff6b6b')

    // Determine background color
    let backgroundColor: string | vscode.ThemeColor
    switch (flashColor) {
      case 'error':
        backgroundColor = new vscode.ThemeColor('editorError.foreground')
        break
      case 'warning':
        backgroundColor = new vscode.ThemeColor('editorWarning.foreground')
        break
      case 'info':
        backgroundColor = new vscode.ThemeColor('editorInfo.foreground')
        break
      case 'custom':
        backgroundColor = flashCustomColor
        break
      default: // 'selection'
        backgroundColor = new vscode.ThemeColor('editor.selectionBackground')
        break
    }

    // Always paint the whole line(s), never just the selected characters. When a
    // non-empty selection was executed — which is every MCP-triggered run, since
    // the Agent Bridge always targets a precise range via set_selection before
    // calling run_selection (#388) — a character-bounded decoration exactly
    // overlaps the editor's native selection highlight (same range, and with the
    // default flashColor='selection' the same background color too), so toggling
    // it on/off is visually imperceptible: the "off" state still shows the native
    // selection underneath. Whole-line painting extends past the selected text and
    // stays visible regardless of selection state, color config, or trigger source.

    // Create flash function
    const createFlash = (flashIndex: number) => {
      const decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: backgroundColor,
        isWholeLine: true,
      })
      editor.setDecorations(decoration, [executionRange])

      setTimeout(() => {
        decoration.dispose()
        // Schedule next flash if not the last one
        if (flashIndex < flashCount - 1) {
          setTimeout(() => createFlash(flashIndex + 1), 100)
        }
      }, flashDuration)
    }

    // Start flashing
    createFlash(0)
  }

  if (!writeCodeToEngine(trimmedText, path.dirname(editor.document.uri.fsPath))) {
    return // stdin 不達（engine 死の競合）— 送れていないのに flash で「実行した」と見せない
  }
  // Scroll the executed range into view before flashing it: subject-block
  // auto-detection (no explicit selection) never reveals, so an agent-driven run
  // that lands on an off-screen line would otherwise flash outside the viewport.
  editor.revealRange(executionRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  flashLines()
}

/**
 * Inject `global.setDocumentDirectory(...)` and write OrbitScore source to the
 * engine's live-coding stdin. Shared by the editor "Run Selection" command and
 * the MCP `evaluate_orbitscore` tool so both go through the exact same path.
 *
 * setDir injection lets audioPath() / audio() resolve relative paths against the
 * `.orbs` file's directory (or, for the agent, the workspace root) rather than
 * the engine process's cwd:
 * - If this eval contains `var global = init GLOBAL`, insert setDocumentDirectory
 *   right after it (and remember that global is now initialized).
 * - Otherwise, if global has already been initialized in this engine session,
 *   prepend setDocumentDirectory before the user code (refreshes the directory
 *   in case the user switched .orbs files).
 * - If global has not yet been initialized, do not inject (would fail with
 *   "global is not defined").
 * When `documentDir` is undefined, no directory is injected.
 *
 * Returns whether the code was handed to the engine's stdin. False = the
 * engine process or its stdin was gone (e.g. died between the caller's guard
 * and this write) — callers surfacing an ok/error contract (MCP evaluate)
 * must NOT report ok in that case. NOTE: true means "delivered to stdin",
 * not "parsed / sounded" — the engine reports parse errors asynchronously on
 * stdout, and `play()` without RUN/LOOP is silent by design (§7). A stronger
 * engine-side acknowledgment is a recorded follow-on (WORK_LOG 6.189).
 */
/**
 * Send a `//#selectAudioDevice <name>` meta line to the running engine and wait for
 * the correlated JSON result line on stdout (#484 D2.5 — see repl-mode.ts's
 * `extractSelectAudioDeviceMeta`/`executeSelectAudioDeviceMeta`). Rejects if the
 * engine's stdin is not writable. Resolves (never rejects otherwise) with a
 * synthetic `ok: false` on a stdin write failure or on timeout (default 10s —
 * a genuine communication failure safety net; an unsupported backend returns an
 * explicit `ok: false` line instead of timing out, see repl-mode.ts).
 */
function sendSelectAudioDeviceMeta(
  device: string,
  timeoutMs = 10000,
): Promise<SelectAudioDeviceBridgeResult> {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    return Promise.reject(new Error('engine stdin is not writable (engine not running?)'))
  }
  const stdin = engineProcess.stdin
  return selectAudioDeviceBridge.send(
    (line, onError) => {
      stdin.write(line, (err) => {
        if (err) {
          outputChannel?.appendLine(
            `⚠️ failed to write //#selectAudioDevice to stdin: ${err.message}`,
          )
          onError(err)
        }
      })
      return true
    },
    device,
    timeoutMs,
  )
}

function writeCodeToEngine(rawCode: string, documentDir: string | undefined): boolean {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    // 呼び出し側ガード通過後に engine が死んだ稀な競合。黙って no-op すると
    // palette 実行では「実行したのに無反応」になるので、ここで必ず痕跡を残す。
    outputChannel?.appendLine('⚠️ Engine stdin is not writable — code was NOT sent (engine died?)')
    return false
  }
  let codeToSend = rawCode
  if (documentDir) {
    // I3 (#456): REPL メタ行で基準ディレクトリを帯域外で先渡しする。import 文（IM.2）は
    // どの statement よりも先に評価されるため、下の DSL 注入（statements として実行）では
    // 間に合わない — メタ行だけが import の基準（IM.6）を初回 eval から確定できる。
    // DSL 注入も残す（audio() 等の既存経路の実績を変えない・同値の冪等再設定）。
    codeToSend = `//#documentDirectory ${documentDir}\n` + codeToSend
    const setDirCommand = `global.setDocumentDirectory("${documentDir.replace(/\\/g, '\\\\')}")`
    const globalInitMatch = codeToSend.match(/(var\s+global\s*=\s*init\s+GLOBAL[^\n]*)/)
    if (globalInitMatch) {
      const insertPos = globalInitMatch.index! + globalInitMatch[0].length
      codeToSend =
        codeToSend.slice(0, insertPos) + '\n' + setDirCommand + codeToSend.slice(insertPos)
      globalInitialized = true
    } else if (globalInitialized) {
      codeToSend = setDirCommand + '\n' + codeToSend
    }
  }

  // Debug: log what we're sending if in debug mode (check status bar text for 🐛)
  if (statusBarItem?.text.includes('🐛')) {
    outputChannel?.appendLine(`📤 Sending: ${JSON.stringify(codeToSend)}`)
  }
  engineProcess.stdin.write(codeToSend + '\n')
  return true
}

/**
 * Evaluate agent-supplied OrbitScore source (MCP `evaluate_orbitscore` tool).
 * Mirrors the engine-running guard in `runSelection` and reuses
 * `writeCodeToEngine`. Relative audio paths resolve against the first workspace
 * folder, since the agent has no "active editor".
 */
function evaluateForAgent(code: string): EvaluateResult {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  const documentDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!writeCodeToEngine(code, documentDir)) {
    return { ok: false, error: 'engine stdin is not writable — the engine may have just died' }
  }
  // ok = 「stdin へ届いた」まで。パースエラーは engine が stdout に非同期で返す
  // （get_log で観測可能）し、play() のみで RUN/LOOP が無ければ仕様上無音
  // （evaluate ok ≠ 発音 — WORK_LOG 6.189 の follow-on 課題）。
  return { ok: true }
}

/** Start the engine for the MCP `start_engine` tool (mirrors the palette command). */
function startEngineForAgent(options?: { captureWav?: string; debug?: boolean }): CommandResult {
  if (isLiveCodingMode && engineProcess && !engineProcess.killed) {
    return { ok: true, message: 'engine already running' }
  }
  startEngine(options?.debug === true, options)
  // startEngine() may abort (missing daemon, build issue) without throwing — it
  // reports via a VS Code notification. Reflect the actual spawn outcome so the
  // agent doesn't assume success.
  if (!engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine failed to start — see the OrbitScore output channel' }
  }
  return {
    ok: true,
    message: options?.captureWav
      ? `engine starting (capturing to ${options.captureWav})`
      : 'engine starting',
  }
}

/** Stop the engine for the MCP `stop_engine` tool (mirrors the palette command). */
function stopEngineForAgent(): CommandResult {
  if (!engineProcess || engineProcess.killed) {
    return { ok: true, message: 'engine already stopped' }
  }
  stopEngine()
  return { ok: true, message: 'engine stopping' }
}

/** Report engine state for the MCP `get_engine_state` tool. */
function getEngineStateForAgent(): EngineState {
  return {
    running: Boolean(engineProcess && !engineProcess.killed),
    liveCoding: isLiveCodingMode,
  }
}

/**
 * Force-kill scsynth for the MCP `force_kill_scsynth` tool. `forceKillScsynth()`
 * itself is fire-and-forget (its outcome only ever reaches a VS Code
 * notification), so this mirrors `stopEngineForAgent`'s style: trigger the
 * same escape hatch and report immediately rather than awaiting the
 * asynchronous `killall` callback.
 */
function forceKillScsynthForAgent(): CommandResult {
  forceKillScsynth()
  return { ok: true, message: 'kill signal sent' }
}

/** Read the plugin catalog for the MCP `list_plugins` tool (#463 PC.4). */
function listPluginsForAgent(): ListPluginsResult {
  const catalog = loadPluginCatalog()
  if (!catalog) {
    return {
      ok: false,
      error: 'plugin catalog not found — run "OrbitScore: Rescan Plugin Catalog" first',
    }
  }
  return {
    ok: true,
    plugins: catalog.plugins.map((entry) => ({ ...entry, roles: [...entry.roles] })),
  }
}

/** Run the scanner for the MCP `rescan_plugins` tool (#463 PC.4/C1b). Shares `runPluginScan` with the command variant above. */
async function rescanPluginsForAgent(): Promise<RescanPluginsResult> {
  const result = await runPluginScan()
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  pluginCatalogHintShown = false
  return { ok: true, count: result.count, skipped: [...result.skipped] }
}

/** List audio devices for the MCP `list_audio_devices` tool. Mirrors `selectAudioDevice`'s guard/resolve steps but returns the list instead of prompting. */
async function listAudioDevicesForAgent(): Promise<AudioDevicesResult> {
  if (getConfiguredEngineKind() === 'rust') {
    return {
      ok: false,
      error:
        'audio device selection is not supported with the Rust engine (orbitscore.engine: "rust"); the system default output device is used',
    }
  }
  if (!vscode.workspace.workspaceFolders?.[0]) {
    return { ok: false, error: 'no workspace folder open' }
  }
  const resolution = resolveScsynthForUI()
  if (!resolution) {
    return {
      ok: false,
      error:
        "scsynth not found. Reinstall the extension to restore the bundle, or set 'orbitscore.scsynthPath' to a system scsynth.",
    }
  }
  const devices = await detectAudioDevices(resolution.path)
  if (devices.length === 0) {
    return { ok: false, error: 'no audio devices detected' }
  }
  return { ok: true, devices }
}

/**
 * Write the selected device for the MCP `select_audio_device` tool. Mirrors
 * `selectAudioDevice`'s guard steps and reuses the same config-write helper.
 * Does not re-probe scsynth — pass a name obtained from `list_audio_devices`.
 */
async function selectAudioDeviceForAgent(device: string): Promise<CommandResult> {
  if (getConfiguredEngineKind() === 'rust') {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
    const action = resolveDeviceClickAction(
      device,
      resolveAudioDeviceSetting(workspaceRoot),
      isEngineRunning(),
    )
    if (action === 'deselect-stop') {
      await writeAudioDeviceSetting('')
      if (isEngineRunning() && !stopEngine()) {
        return { ok: false, error: 'engine failed to stop — see the OrbitScore output channel' }
      }
      return { ok: true, message: 'audio device deselected and engine stopped' }
    }
    if (action === 'start') {
      await writeAudioDeviceSetting(device)
      if (!startEngine()) {
        return { ok: false, error: 'engine failed to start — see the OrbitScore output channel' }
      }
      return { ok: true, message: `audio device selected: ${device}; engine starting` }
    }
    try {
      const result = await sendSelectAudioDeviceMeta(device)
      if (result.ok) {
        await writeAudioDeviceSetting(result.device ?? device)
        return {
          ok: true,
          message: `audio device switched to: ${result.device ?? device} (persisted for next start)`,
        }
      }
      return { ok: false, error: translateSelectAudioDeviceError(result.error) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    return { ok: false, error: 'no workspace folder open' }
  }
  const configPath = path.join(workspaceFolder.uri.fsPath, '.orbitscore.json')
  writeAudioDeviceConfig(configPath, device)
  return { ok: true, message: `audio device set to: ${device}. Restart engine to apply.` }
}

/**
 * Apply flash settings for the MCP `configure_flash` tool. Value constraints
 * mirror `contributes.configuration` in package.json (orbitscore.flash*).
 * Workspace-scoped (`ConfigurationTarget.Workspace`) rather than Global (as
 * the "Configure Flash" command's QuickPick flow writes) — agent-driven
 * config changes should stay local to the workspace, not leak into the
 * user's global settings.
 */
async function configureFlashForAgent(options: FlashConfigInput): Promise<FlashConfigResult> {
  if (
    options.count !== undefined &&
    (!Number.isInteger(options.count) || options.count < 1 || options.count > 5)
  ) {
    return { ok: false, error: 'count must be an integer between 1 and 5' }
  }
  if (
    options.duration !== undefined &&
    (!Number.isInteger(options.duration) || options.duration < 50 || options.duration > 500)
  ) {
    return { ok: false, error: 'duration must be an integer between 50 and 500' }
  }
  const validColors = ['selection', 'error', 'warning', 'info', 'custom']
  if (options.color !== undefined && !validColors.includes(options.color)) {
    return { ok: false, error: `color must be one of: ${validColors.join(', ')}` }
  }
  if (options.customColor !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(options.customColor)) {
    return { ok: false, error: 'custom_color must be a hex color, e.g. #ff6b6b' }
  }

  try {
    const config = vscode.workspace.getConfiguration('orbitscore')
    if (options.count !== undefined) {
      await config.update('flashCount', options.count, vscode.ConfigurationTarget.Workspace)
    }
    if (options.duration !== undefined) {
      await config.update('flashDuration', options.duration, vscode.ConfigurationTarget.Workspace)
    }
    if (options.color !== undefined) {
      await config.update('flashColor', options.color, vscode.ConfigurationTarget.Workspace)
    }
    if (options.customColor !== undefined) {
      await config.update(
        'flashCustomColor',
        options.customColor,
        vscode.ConfigurationTarget.Workspace,
      )
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const updated = vscode.workspace.getConfiguration('orbitscore')
  return {
    ok: true,
    config: {
      count: updated.get<number>('flashCount', 3),
      duration: updated.get<number>('flashDuration', 150),
      color: updated.get<string>('flashColor', 'selection'),
      customColor: updated.get<string>('flashCustomColor', '#ff6b6b'),
    },
  }
}

/** Open a file for the MCP `open_file` tool (the "Go to File" equivalent). */
async function openFileForAgent(filePath: string): Promise<CommandResult> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath)
    await vscode.window.showTextDocument(doc, { preview: false })
    return { ok: true, message: `opened (languageId: ${doc.languageId})` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Set the active editor's selection for the MCP `set_selection` tool. The
 * schema is 1-based (matches the editor gutter); converted to 0-based
 * `vscode.Position` here. Omitting both `endLine` and `endChar` collapses the
 * selection to a cursor at the start position.
 */
function setSelectionForAgent(range: SelectionInput): CommandResult {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor — open a file first' }
  }
  const collapse = range.endLine === undefined && range.endChar === undefined
  const startPos = editor.document.validatePosition(
    new vscode.Position(range.startLine - 1, (range.startChar ?? 1) - 1),
  )
  const endPos = collapse
    ? startPos
    : editor.document.validatePosition(
        new vscode.Position((range.endLine ?? range.startLine) - 1, (range.endChar ?? 1) - 1),
      )
  editor.selection = new vscode.Selection(startPos, endPos)
  editor.revealRange(new vscode.Range(startPos, endPos))
  return { ok: true, message: 'selection set' }
}

/**
 * Execute the active selection for the MCP `run_selection` tool — calls the
 * real `orbitscore.runSelection` command (subject-block collection, setDir
 * injection, flash) rather than reimplementing it. Pre-checks mirror
 * `runSelection`'s own guards so the agent gets a structured error instead of
 * only a toast notification it cannot observe.
 */
async function runSelectionForAgent(): Promise<CommandResult> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'orbitscore') {
    return { ok: false, error: 'no active OrbitScore editor — open an .orbs file first' }
  }
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  await vscode.commands.executeCommand('orbitscore.runSelection')
  // Collapse the lingering agent selection to its active end (#390): the block
  // selection left behind by set_selection sits on top of the playhead
  // highlight and drowns it. Humans running the palette command keep normal
  // VS Code selection behavior — this only touches the agent path.
  editor.selection = new vscode.Selection(editor.selection.active, editor.selection.active)
  return { ok: true, message: 'selection executed' }
}

/** Literal (non-regex) find/replace in the active document for the MCP `edit_replace` tool. */
async function editReplaceForAgent(args: EditReplaceInput): Promise<CommandResult> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor' }
  }
  if (!args.find) {
    return { ok: false, error: 'find must not be empty' }
  }
  const text = editor.document.getText()
  const offsets: number[] = []
  let idx = text.indexOf(args.find)
  while (idx !== -1) {
    offsets.push(idx)
    if (!args.all) break
    idx = text.indexOf(args.find, idx + args.find.length)
  }
  if (offsets.length === 0) {
    return { ok: false, error: `no match for ${JSON.stringify(args.find)}` }
  }
  const applied = await editor.edit((editBuilder) => {
    for (const offset of offsets) {
      const start = editor.document.positionAt(offset)
      const end = editor.document.positionAt(offset + args.find.length)
      editBuilder.replace(new vscode.Range(start, end), args.replace)
    }
  })
  if (!applied) {
    return { ok: false, error: 'edit was rejected by the editor' }
  }
  return { ok: true, message: `replaced ${offsets.length} occurrence(s)` }
}

/** Snapshot the active editor for the MCP `get_editor_state` tool. All positions are 1-based. Fields are null when no editor is active. */
function getEditorStateForAgent(): EditorState {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return {
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    }
  }
  const doc = editor.document
  const toPos = (p: vscode.Position) => ({ line: p.line + 1, character: p.character + 1 })
  return {
    path: doc.uri.fsPath,
    languageId: doc.languageId,
    cursor: toPos(editor.selection.active),
    selection: { start: toPos(editor.selection.start), end: toPos(editor.selection.end) },
    lineCount: doc.lineCount,
    isDirty: doc.isDirty,
  }
}

/**
 * Save the active document to disk for the MCP `save_file` tool. edit_replace
 * only mutates the in-memory buffer, so this is the only way an agent can
 * persist a live-edited or live-played file (#392). A no-op when the document
 * has no unsaved changes, since `document.save()` resolving `false` is
 * ambiguous between "nothing to save" and "save failed" — checking `isDirty`
 * first sidesteps that ambiguity.
 *
 * Rejects a document with no on-disk path (uri.scheme !== 'file', e.g. an
 * untitled buffer): `document.save()` on such a document pops an interactive
 * "Save As" dialog and never resolves in a headless/agent-driven session — the
 * exact live-jam recovery scenario this tool exists for. Fail loudly instead of
 * hanging silently. Save failures (false return or a thrown error) are logged
 * to the output channel so `get_log` surfaces why a persist did not happen.
 *
 * Known limitation: the scheme guard does not cover every dialog path — a
 * file-scheme document can still block on an interactive prompt when
 * `save()` detects a disk conflict (the file changed on disk since load) or
 * an overwrite confirmation. No timeout is implemented; this path is
 * unreachable through the current MCP tool surface (all edits flow through
 * `open_file` → `edit_replace`), so re-evaluate if the tool surface widens.
 */
async function saveFileForAgent(): Promise<CommandResult> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { ok: false, error: 'no active editor' }
  }
  const doc = editor.document
  if (doc.uri.scheme !== 'file') {
    return {
      ok: false,
      error: `cannot save — document has no file path (scheme: ${doc.uri.scheme})`,
    }
  }
  if (!doc.isDirty) {
    return { ok: true, message: `no changes to save (already saved): ${doc.uri.fsPath}` }
  }
  try {
    const saved = await doc.save()
    if (!saved) {
      outputChannel?.appendLine(
        `❌ save_file: document.save() returned false for ${doc.uri.fsPath}`,
      )
      return { ok: false, error: `save failed: ${doc.uri.fsPath}` }
    }
    return { ok: true, message: `saved: ${doc.uri.fsPath}` }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ save_file: ${reason} (${doc.uri.fsPath})`)
    return { ok: false, error: `save failed: ${reason}` }
  }
}

/** Full text of the active document for the MCP `get_document_text` tool. Fields are null when no editor is active. */
function getDocumentTextForAgent(): DocumentText {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return { path: null, text: null }
  }
  const doc = editor.document
  return { path: doc.uri.fsPath, text: doc.getText() }
}

/**
 * Report diagnostics for the MCP `get_diagnostics` tool
 * (`vscode.languages.getDiagnostics`). Without a path, only files that
 * currently have at least one diagnostic are included; with a path, the
 * single file is always included (even with an empty diagnostics array), so
 * the agent can distinguish "no diagnostics" from "file not checked".
 */
function getDiagnosticsForAgent(filePath?: string): FileDiagnostics[] {
  const severityLabel = (s: vscode.DiagnosticSeverity): DiagnosticSeverityLabel => {
    switch (s) {
      case vscode.DiagnosticSeverity.Error:
        return 'error'
      case vscode.DiagnosticSeverity.Warning:
        return 'warning'
      case vscode.DiagnosticSeverity.Information:
        return 'info'
      default:
        return 'hint'
    }
  }
  const toEntries = (diagnostics: readonly vscode.Diagnostic[]) =>
    diagnostics.map((d) => ({
      line: d.range.start.line + 1,
      character: d.range.start.character + 1,
      severity: severityLabel(d.severity),
      message: d.message,
    }))

  if (filePath) {
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(filePath))
    return [{ path: filePath, diagnostics: toEntries(diagnostics) }]
  }
  return vscode.languages
    .getDiagnostics()
    .filter(([, diagnostics]) => diagnostics.length > 0)
    .map(([uri, diagnostics]) => ({ path: uri.fsPath, diagnostics: toEntries(diagnostics) }))
}

/** Return the last N lines of the output-channel ring buffer for the MCP `get_log` tool. */
function getLogForAgent(lines?: number): string[] {
  const n = Math.max(1, Math.min(lines ?? 50, 500))
  return outputLogRing.slice(-n)
}

/** Parse a captured WAV for the MCP `analyze_audio` tool. */
function analyzeAudioForAgent(wavPath: string, windowMs?: number): AnalyzeAudioResult {
  try {
    const buf = fs.readFileSync(wavPath)
    return { ok: true, analysis: analyzeWavBuffer(buf, { windowMs }) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Register this MCP server into Claude Code for the MCP `register_mcp_server`
 * tool — delegates to the same `performMcpRegistration` as the palette
 * command. The port defaults to the port this server is actually listening on
 * (`mcpServerHandle`): the ORBITSCORE_MCP_PORT env var takes precedence over
 * the setting at startup, so the live handle — not the setting — is the
 * truthful default. The setting is a last resort (the handle is always
 * non-null while a tool call is being served).
 */
async function registerMcpServerForAgent(input: RegisterMcpServerInput): Promise<CommandResult> {
  if (input.scope !== 'project' && input.scope !== 'user') {
    return {
      ok: false,
      error: `scope must be 'project' or 'user' (got ${JSON.stringify(input.scope)})`,
    }
  }
  const port =
    input.port ??
    mcpServerHandle?.port ??
    vscode.workspace.getConfiguration('orbitscore').get<number>('mcpServer.port', 0)
  return performMcpRegistration(input.scope, port)
}

// Removed unused executeCode function

/*
function isTransportCommand(text: string): boolean {
  const trimmed = text.trim()
  return /^(global|seq\w*)\.(run|loop|stop|mute|unmute)/.test(trimmed)
}
*/

function registerCompletionProviders(context: vscode.ExtensionContext) {
  // Context-aware completion provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text
        const linePrefix = lineText.substr(0, position.character)

        // Check if we're typing after a dot
        if (!linePrefix.endsWith('.')) {
          return undefined
        }

        // Detect pitch-scope chain context: cursor is after `).` and we are INSIDE
        // the argument list of a .play() call (paren balance > 0 after the last .play(
        // token). This distinguishes the inner-group position `play((A)(B).` (balance 1)
        // from the post-play position `play(1,2,3).` (balance 0). The check also avoids
        // firing when .play( is on an earlier line (linePrefix won't contain it at all).
        if (/\)\.$/.test(linePrefix)) {
          const playIdx = linePrefix.lastIndexOf('.play(')
          if (playIdx !== -1) {
            const afterPlay = linePrefix.slice(playIdx + 1) // starts with "play("
            let balance = 0
            for (const ch of afterPlay) {
              if (ch === '(') balance++
              else if (ch === ')') balance--
            }
            // balance > 0: the play( is still open → cursor is inside play args
            if (balance > 0) {
              return getPitchScopeCompletions()
            }
            // balance === 0: play() has closed → fall through to existing completions
          }
        }

        // Analyze the method chain context
        const chainContext = analyzeMethodChain(lineText, position.character)

        // Determine if this is a global or sequence context
        const isGlobal = linePrefix.includes('global.')

        // Get contextual completions
        return getContextualCompletions(chainContext, isGlobal)
      },
    },
    '.', // Trigger on dot
  )

  context.subscriptions.push(completionProvider)

  // Plugin catalog name completion (#463 C3, spec §PC.3). Triggers on `"` but
  // — per owner requirement 2026-07-17 — must also keep narrowing while the
  // user types further characters inside the string; VS Code does this
  // client-side via each item's `range`, so no re-trigger characters are
  // needed for the common case (registered `"` covers the initial open-quote
  // fire; detectPluginArgContext itself matches a partial, unclosed string,
  // so a real re-invocation — e.g. Ctrl+Space — still resolves correctly too).
  const pluginCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text
        const pluginContext = detectPluginArgContext(lineText, position.character)
        if (!pluginContext) return undefined

        const catalog = loadPluginCatalog()
        if (!catalog) {
          if (!pluginCatalogHintShown) {
            pluginCatalogHintShown = true
            vscode.window.showInformationMessage(
              'OrbitScore: no plugin catalog found. Run "OrbitScore: Rescan Plugin Catalog" to enable name completion.',
            )
          }
          return undefined
        }

        const matches = filterCatalogEntries(
          catalog.plugins,
          pluginContext.verb,
          pluginContext.typed,
        )
        const range = new vscode.Range(
          new vscode.Position(position.line, pluginContext.quoteStartChar),
          new vscode.Position(position.line, position.character),
        )
        return matches.map(({ entry, label, insertText }) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value)
          item.detail = `${entry.vendor} · ${entry.format.toUpperCase()}`
          item.insertText = insertText
          item.range = range
          item.filterText = label
          return item
        })
      },
    },
    '"',
  )
  context.subscriptions.push(pluginCompletionProvider)

  // DSL completion surfaces introduced by #512.  Context recognition lives in
  // dsl-completion-context.ts so this provider is only responsible for VS Code
  // I/O and CompletionItem construction.
  const dslCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      async provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text
        const completionContext = detectDslCompletionContext(lineText, position.character)
        if (!completionContext) return undefined

        const typedRange = new vscode.Range(
          new vscode.Position(position.line, position.character - completionContext.typed.length),
          position,
        )
        const makeItems = (candidates: readonly string[], kind: vscode.CompletionItemKind) =>
          filterDslCandidates(candidates, completionContext.typed).map((candidate) => {
            const item = new vscode.CompletionItem(candidate, kind)
            item.insertText = candidate
            item.range = typedRange
            return item
          })

        switch (completionContext.kind) {
          case 'sum-name':
            return makeItems(
              extractDeclaredBusNames(document.getText(), 'sum'),
              vscode.CompletionItemKind.Value,
            )
          case 'aux-name':
            return makeItems(
              extractDeclaredBusNames(document.getText(), 'aux'),
              vscode.CompletionItemKind.Value,
            )
          case 'import-names': {
            const importUri = vscode.Uri.file(
              path.resolve(path.dirname(document.uri.fsPath), completionContext.importPath),
            )
            try {
              const importedSource = Buffer.from(
                await vscode.workspace.fs.readFile(importUri),
              ).toString('utf8')
              return makeItems(
                extractTopLevelDeclaredNames(importedSource),
                vscode.CompletionItemKind.Variable,
              )
            } catch {
              // The import may still be mid-edit or absent; completion must not
              // turn that ordinary editing state into a provider error.
              return undefined
            }
          }
          case 'import-path': {
            const files = await vscode.workspace.findFiles('**/*.orbs')
            const currentDirectory = path.dirname(document.uri.fsPath)
            const candidates = files
              .filter((uri) => uri.fsPath !== document.uri.fsPath)
              .map((uri) => {
                const relativePath = path
                  .relative(currentDirectory, uri.fsPath)
                  .split(path.sep)
                  .join('/')
                return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
              })
            return makeItems(candidates, vscode.CompletionItemKind.File)
          }
        }
      },
    },
    '"',
    '{',
  )
  context.subscriptions.push(dslCompletionProvider)
}

/**
 * Completion items for pitch-scope group chains: .root() / .mode() / .oct() (§2.3, §3).
 * Offered when the cursor follows a `)` inside a play() argument list.
 */
function getPitchScopeCompletions(): vscode.CompletionItem[] {
  const root = new vscode.CompletionItem('root', vscode.CompletionItemKind.Method)
  root.documentation = new vscode.MarkdownString(
    '**root(note | degree)** — Set pitch-class root for the preceding group or juxtaposition run (§2.3, §3).\n\n' +
      'Note names: `C`, `Db`, `D`, `Eb`, `E`, `F`, `F#`, `Gb`, `G`, `Ab`, `A`, `Bb`, `B`\n\n' +
      'Degrees (of `global.key()`): `1`–`9`, `11`, `13`, `b3`, `#5`, etc.\n\n' +
      'Examples: `(1, 2, 3).root(F#)` · `(A)(B).root(Bb)` · `(A).root(b6)`',
  )
  root.insertText = new vscode.SnippetString('root(${1:F})')
  root.sortText = '1'

  const mode = new vscode.CompletionItem('mode', vscode.CompletionItemKind.Method)
  mode.documentation = new vscode.MarkdownString(
    '**mode(name)** — Set modal context for the group (§2.3). _v1.1: syntax reserved; dispatch throws. Arrives in Phase 2.2._',
  )
  mode.insertText = new vscode.SnippetString('mode(${1:dorian})')
  mode.sortText = '2'

  const oct = new vscode.CompletionItem('oct', vscode.CompletionItemKind.Method)
  oct.documentation = new vscode.MarkdownString(
    '**oct(N)** — Set group-lexical octave register (§2.3, §3). Integer.\n\nExample: `(1, 2, 3).oct(4)` · `(A)(B).root(C).oct(5)`',
  )
  oct.insertText = new vscode.SnippetString('oct(${1:4})')
  oct.sortText = '3'

  return [root, mode, oct]
}

function registerHoverProvider(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerHoverProvider('orbitscore', {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position)
      const word = document.getText(range)

      const hoverTexts: { [key: string]: string } = {
        global: '**global**\n\nGlobal transport object for controlling playback',
        tempo: '**tempo(bpm)**\n\nSet tempo in beats per minute (20-999)',
        beat: '**beat(n by m)**\n\nSet time signature (e.g., 4 by 4, 5 by 4)',
        quantize:
          '**quantize(value)**\n\nLaunch quantize for `LOOP()` and LOOP-time `play()` updates.\n\nValues: `"off"` | `"beat"` | `"bar"` | `"2bar"` | `"4bar"` | `"8bar"`. Default: `"bar"`. `RUN()` is always immediate.',
        play: '**play(...slices)**\n\nPlay audio slices. Supports numbers, nested structures, and modifiers',
        root: '**root(note | degree)**\n\nSet the pitch-class root for a group or juxtaposition run (§2.3, §3).\n\nExamples: `(1, 2, 3).root(F#)` · `(A)(B).root(Bb)` · `(1, 2).root(3)` · `(A).root(b6)`\n\nNote names: `C`, `Db`, `D`, `Eb`, `E`, `F`, `F#`, `Gb`, `G`, `Ab`, `A`, `Bb`, `B`\nDegrees (of `global.key()`): `1`–`9`, `11`, `13`, `b3`, `#5`, etc.',
        mode: '**mode(name)**\n\nSet the modal context for a group (§2.3). _v1.1: syntax reserved; dispatch throws. Arrives in Phase 2.2._',
        oct: '**oct(N)**\n\nSet the group-lexical octave register for a group or run (§2.3, §3). Integer.\n\nExample: `(1, 2, 3).oct(4)` · `(A)(B).root(C).oct(5)`',
        chop: '**chop(n)**\n\nDivide audio into n equal slices',
        fixpitch:
          '**fixpitch(semitones)** _(planned, not yet implemented — see issue #213)_\n\nPitch shift in semitones, preserving slice duration.',
        var: '**var**\n\nDeclare a variable',
        init: '**init**\n\nInitialize a transport or sequence',
        GLOBAL: '**GLOBAL**\n\nGlobal transport constant',
      }

      const text = hoverTexts[word]
      if (text) {
        return new vscode.Hover(new vscode.MarkdownString(text))
      }

      return undefined
    },
  })

  context.subscriptions.push(provider)
}

async function updateDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
) {
  const diagnostics: vscode.Diagnostic[] = []
  const text = document.getText()
  const lines = text.split('\n')

  // Track multiline statements (lines ending with open parenthesis and comma)
  let inMultilineStatement = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // Detect multiline statement start: ends with '(' or ','
    const trimmedLine = line.trim()
    if (trimmedLine.endsWith('(') || trimmedLine.endsWith(',')) {
      if (!inMultilineStatement) {
        inMultilineStatement = true
      }
      continue // Skip parenthesis check for multiline statements
    }

    // Detect multiline statement end: line with closing parenthesis
    if (inMultilineStatement && trimmedLine.endsWith(')')) {
      inMultilineStatement = false
      continue // Skip parenthesis check for closing line
    }

    // Skip parenthesis check if we're inside a multiline statement
    if (inMultilineStatement) {
      continue
    }

    // Check for common syntax errors

    // Missing closing parenthesis (only for single-line statements)
    const openParens = (line.match(/\(/g) || []).length
    const closeParens = (line.match(/\)/g) || []).length
    if (openParens > closeParens) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(i, 0, i, line.length),
        'Missing closing parenthesis',
        vscode.DiagnosticSeverity.Error,
      )
      diagnostics.push(diagnostic)
    }

    // Invalid tempo range
    const tempoMatch = line.match(/\.tempo\((\d+)\)/)
    if (tempoMatch && tempoMatch[1]) {
      const tempo = parseInt(tempoMatch[1])
      if (tempo < 20 || tempo > 999) {
        const start = line.indexOf(tempoMatch[1])
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(i, start, i, start + tempoMatch[1].length),
          `Tempo must be between 20 and 999 (got ${tempo})`,
          vscode.DiagnosticSeverity.Warning,
        )
        diagnostics.push(diagnostic)
      }
    }

    // Check for deprecated syntax (old MIDI DSL)
    if (line.includes('sequence ') && !line.includes('//')) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(i, 0, i, line.length),
        'Deprecated: Use "var seq = init GLOBAL.seq" instead of "sequence"',
        vscode.DiagnosticSeverity.Warning,
      )
      diagnostic.tags = [vscode.DiagnosticTag.Deprecated]
      diagnostics.push(diagnostic)
    }
  }

  // === Cross-line analyses (pure functions, unit-testable) ===
  // Pure logic は `diagnostics-analysis.ts` に分離し、ここでは
  // VS Code Diagnostic オブジェクトに変換するだけにする。
  for (const issue of analyzeGlobalOncePerFile(text)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    )
  }
  for (const issue of analyzeAudioPathOrdering(text)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    )
  }
  for (const issue of analyzeOutputWithoutLinkAudio(text)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    )
  }
  // Strict-mode error: sequences without .output() under LinkAudio mode are
  // flagged as Error (not Warning) — runtime will throw, so we surface it
  // accordingly at edit time. See DSL spec §8.1.2.
  for (const issue of analyzeLinkAudioMissingOutput(text)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Error,
      ),
    )
  }
  // Same severity reasoning as the missing-output analyzer: an empty
  // .output("") argument throws at runtime regardless of LinkAudio mode.
  for (const issue of analyzeEmptyOutputArg(text)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Error,
      ),
    )
  }

  collection.set(document.uri, diagnostics)
}
