/**
 * OrbitScore VS Code extension root and public re-export surface.
 *
 * Engine wiring function bodies were moved unchanged to the engine modules;
 * formerly private helpers are imported only where this root still wires them.
 */
import * as path from 'path'
import * as fs from 'fs'
// import * as os from 'os'

import * as vscode from 'vscode'

import { isOrbitscoreDocument } from './diagnostics-analysis'
import { startOrbitScoreMcpServer } from './mcp-server'
import {
  EngineViewProvider,
  engineViewSelectDevice,
  engineViewToggleDebug,
  engineViewToggleEngine,
} from './engine-view-provider'
import {
  autoStartConfiguredRustEngine,
  resolveAudioDeviceSetting,
  startEngine,
  startEngineDebug,
  stopEngine,
  toggleEngine,
  updateBundleStatus,
} from './engine-process'
import { openDevDocs, openDevDocsPanel, openUserDocs, openWalkthrough } from './docs-panels'
import { configureFlash, configureFlashForAgent } from './flash-config'
import { terminateActivePluginScans } from './plugin-catalog-reader'
import {
  analyzeAudioForAgent,
  editReplaceForAgent,
  evaluateForAgent,
  getDiagnosticsForAgent,
  getDocumentTextForAgent,
  getEditorStateForAgent,
  getEngineStateForAgent,
  getLogForAgent,
  listAudioDevicesForAgent,
  openFileForAgent,
  pluginUiForAgent,
  saveFileForAgent,
  savePluginStateForAgent,
  selectAudioDeviceForAgent,
  setSelectionForAgent,
  startEngineForAgent,
  stopEngineForAgent,
} from './agent-handlers'
import { registerMcpServer, registerMcpServerForAgent } from './mcp-register-command'
import {
  browsePlugins,
  listPluginsForAgent,
  rescanPlugins,
  rescanPluginsForAgent,
} from './plugin-commands'
import { runSelection, runSelectionForAgent } from './run-selection'
import {
  registerCompletionProviders,
  registerHoverProvider,
  registerOutputCodeActionProvider,
} from './dsl-providers'
import { updateDiagnostics } from './diagnostics-provider'
import {
  bundleStatusItem,
  devDocsPanel,
  engineProcess,
  mcpServerHandle,
  outputChannel,
  pushLogRing,
  setBundleStatusItem,
  setDevDocsPanel,
  setEngineProcess,
  setEngineViewProvider,
  setGlobalInitialized,
  setLiveCodingMode,
  setMcpServerHandle,
  setOutputChannel,
  setStatusBarItem,
  setTransportPlaying,
  statusBarItem,
} from './extension-state'
import {
  clearAllPlayheadDecorations,
  playheadDecorationTypes,
  resetPlayheadDecorationTypes,
} from './playhead-decorations'

export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  setEngineProcess(null)
  setLiveCodingMode(false)
  setGlobalInitialized(false)
  setTransportPlaying(false)

  // Create output channel
  const channel = vscode.window.createOutputChannel('OrbitScore')
  setOutputChannel(channel)

  // Tap appendLine/append into the ring buffer so the MCP get_log tool can read
  // recent output without a separate logging sink (#388). Installed before the
  // version banner below so get_log's history starts from activation.
  const rawAppendLine = channel.appendLine.bind(channel)
  channel.appendLine = (value: string) => {
    pushLogRing(value)
    rawAppendLine(value)
  }
  const rawAppend = channel.append.bind(channel)
  channel.append = (value: string) => {
    for (const line of value.split('\n')) {
      if (line) pushLogRing(line)
    }
    rawAppend(value)
  }

  // Show version info
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  const buildTime = fs.statSync(__filename).mtime.toISOString()
  channel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  channel.appendLine(`🎵 OrbitScore Extension v${packageJson.version}`)
  channel.appendLine(`📦 Build: ${buildTime}`)
  channel.appendLine(`📂 Path: ${__dirname}`)
  channel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  channel.appendLine('')

  // Create status bar item
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  setStatusBarItem(statusItem)
  statusItem.text = '🎵 OrbitScore: Stopped'
  statusItem.tooltip = 'Open Audio Engine Settings'
  statusItem.command = 'orbitscore.showCommands'
  statusItem.show()

  // Bundle status indicator (priority 99 → 既存 100 の左隣に並ぶ)。daemon
  // が解決できない時だけ表示するエラー・インジケータ（健全時は非表示）。
  const bundleItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  setBundleStatusItem(bundleItem)
  bundleItem.command = {
    command: 'workbench.action.openSettings',
    title: 'Open OrbitScore settings',
    arguments: ['orbitscore'],
  }
  updateBundleStatus()

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
    vscode.commands.registerCommand('orbitscore.configureFlash', configureFlash),
    vscode.commands.registerCommand('orbitscore.registerMcpServer', registerMcpServer),
    vscode.commands.registerCommand('orbitscore.rescanPlugins', rescanPlugins),
    vscode.commands.registerCommand('orbitscore.browsePlugins', browsePlugins),
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
      const provider = new EngineViewProvider()
      setEngineViewProvider(provider)
      return vscode.window.registerTreeDataProvider('orbitscore.engineView', provider)
    })(),
    vscode.commands.registerCommand('orbitscore.engineViewSelectDevice', engineViewSelectDevice),
    vscode.commands.registerCommand('orbitscore.engineViewToggleEngine', engineViewToggleEngine),
    vscode.commands.registerCommand('orbitscore.engineViewToggleDebug', engineViewToggleDebug),
    vscode.commands.registerCommand('orbitscore.openDocs', openUserDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocs', openDevDocs),
    vscode.commands.registerCommand('orbitscore.openDevDocsPanel', () => openDevDocsPanel(context)),
    vscode.commands.registerCommand('orbitscore.openWalkthrough', openWalkthrough),
    statusItem,
    bundleItem,
  )

  // Register IntelliSense providers
  registerCompletionProviders(context)
  registerHoverProvider(context)
  registerOutputCodeActionProvider(context)

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
      const handle = await startOrbitScoreMcpServer({
        port: mcpPort,
        version: packageJson.version,
        handlers: {
          evaluate: (code) => evaluateForAgent(code),
          startEngine: (options) => startEngineForAgent(options),
          stopEngine: () => stopEngineForAgent(),
          getEngineState: () => getEngineStateForAgent(),
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
          analyzeAudio: (wavPath, windowMs, perChannel) =>
            analyzeAudioForAgent(wavPath, windowMs, perChannel),
          listPlugins: () => listPluginsForAgent(),
          rescanPlugins: () => rescanPluginsForAgent(),
          savePluginState: (sequence, index) => savePluginStateForAgent(sequence, index),
          openPluginUi: (receiver, index, expectedName) =>
            pluginUiForAgent('open', receiver, index, expectedName),
          closePluginUi: (receiver, index) => pluginUiForAgent('close', receiver, index),
          registerMcpServer: (args) => registerMcpServerForAgent(args),
        },
        log: (message) => outputChannel?.appendLine(`🔌 ${message}`),
      })
      setMcpServerHandle(handle)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      outputChannel?.appendLine(`❌ MCP server failed to start on port ${mcpPort}: ${reason}`)
      vscode.window.showWarningMessage(`OrbitScore MCP server failed to start: ${reason}`)
    }
  }

  void autoStartConfiguredRustEngine()
}

export function deactivate() {
  // Scanner processes are detached so timeout cleanup can kill their whole process group. That
  // also means an orderly extension shutdown must stop them explicitly. If the extension host is
  // killed immediately by a process-group signal this hook cannot run, so a scanner can still be
  // orphaned and consume CPU; catalog writes are atomic, so this is not a data-corruption risk.
  terminateActivePluginScans()
  if (engineProcess && !engineProcess.killed) {
    engineProcess.kill()
  }
  clearAllPlayheadDecorations() // #390
  for (const decorationType of playheadDecorationTypes.values()) {
    decorationType.dispose()
  }
  playheadDecorationTypes.clear()
  void mcpServerHandle?.dispose()
  setMcpServerHandle(null)
  outputChannel?.dispose()
  statusBarItem?.dispose()
  bundleStatusItem?.dispose()
  devDocsPanel?.dispose()
  setDevDocsPanel(null)
}

function showCommands() {
  vscode.commands.executeCommand('orbitscore.engineView.focus')
}

async function restartEngine(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  if (!resolveAudioDeviceSetting(workspaceRoot)) {
    vscode.window.showInformationMessage('Select an output device in Audio Engine Settings first')
    return
  }
  stopEngine()
  await new Promise<void>((resolve) => setTimeout(resolve, 2200))
  await startEngine()
}

function reloadWindow(): void {
  void vscode.commands.executeCommand('workbench.action.reloadWindow')
}

// ---- Test-only seams (#527 review Critical #3) -------------------------
//
// setupStdoutHandler / setupExitHandler / setupStdinErrorHandler close over
// this module's private process/UI state (`engineProcess`, `statusBarItem`,
// `outputChannel`, `engineViewProvider`, `selectAudioDeviceBridge`) instead of
// taking it as parameters — normal for code that owns state for the
// extension's whole lifetime, but it meant no spec could drive these handlers
// without running the full activate() flow (MCP server bring-up, auto-start
// device probing, command/tree registration — none of which the wiring
// itself needs). The four effects-object literals built by these handlers
// have same-shaped `() => void` sibling callbacks (e.g. showStoppedStatus /
// refreshEngineView); swapping which real implementation lands in which slot
// type-checks fine and both the unit suite and the gated E2E stayed green.
//
// These exports/setters exist ONLY so
// tests/vscode-extension/extension-wiring.spec.ts can inject fakes for that
// state and call the real setup*Handler functions directly, asserting the
// wiring itself (not just "some fake got called in the right shape", which
// engine-lifecycle.spec.ts already covers for the pure decision logic). Not
// part of the extension's public API — do not call from production code.
//
// ⚠️ #527 review round 3 Minor #3: none of these exports are gated behind a
// test-environment check (e.g. `process.env.VITEST`) — they are plain named
// exports, reachable by ANY code that imports this module. Today the only
// importer is the spec above, so the risk is inert. If a future change gives
// production code a reason to import `extension.ts` (unlikely but not
// impossible — e.g. a second entry point re-exporting activation helpers),
// that code would silently gain the power to reassign `engineProcess` /
// `statusBarItem` / `outputChannel` / `engineViewProvider` out from under the
// running extension with no compiler warning. Keep new test-only exports
// confined to this block, and re-check this note before adding an importer
// of `extension.ts` outside `tests/`.
export {
  __getDeviceSwitchBridgeForTest,
  __getEngineProcessForTest,
  __getPluginUiBridgeForTest,
  __setEngineProcessForTest,
  __setEngineViewProviderForTest,
  __setLiveCodingModeForTest,
  __setOutputChannelForTest,
  __setStatusBarItemForTest,
} from './extension-state'
export { __pluginUiForAgentForTest, startEngineForAgent } from './agent-handlers'
export {
  dslCompletionItemProvider,
  registerCompletionProviders,
  registerOutputCodeActionProvider,
} from './dsl-providers'

export {
  __getPlayheadActiveRangeCountForTest,
  __getPlayheadTimeoutCountForTest,
  __resetPlayheadStateForTest,
  __setPlayheadActiveRangeForTest,
} from './playhead-decorations'
export {
  createLinePrefixer,
  setupErrorHandler,
  setupExitHandler,
  setupStderrHandler,
  setupStdinErrorHandler,
  setupStdoutHandler,
} from './engine-handlers'
export { stopEngine, toggleEngine } from './engine-process'

export type { EngineViewProvider }

// Removed unused executeCode function

/*
function isTransportCommand(text: string): boolean {
  const trimmed = text.trim()
  return /^(global|seq\w*)\.(run|loop|stop|mute|unmute)/.test(trimmed)
}
*/
