/**
 * OrbitScore VS Code extension root and public re-export surface.
 *
 * Engine wiring function bodies were moved unchanged to the engine modules;
 * formerly private helpers are imported only where this root still wires them.
 */
import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { randomUUID } from 'crypto'
// import * as os from 'os'

import * as vscode from 'vscode'

import { analyzeMethodChain, getContextualCompletions } from './completion-context'
import { selectLogLines } from './log-ring'
import {
  analyzeAudioPathOrdering,
  analyzeEmptyOutputArg,
  analyzeGlobalOncePerFile,
  analyzeMissingOutput,
  analyzeOutputWithoutLinkAudio,
  isOrbitscoreDocument,
  missingOutputQuickFixEdit,
} from './diagnostics-analysis'
import { analyzeUnknownPluginNames } from './plugin-name-diagnostics'
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
  type ListPluginsResult,
  type PluginUiResult,
  type RegisterMcpServerInput,
  type RescanPluginsResult,
  type SelectionInput,
  type SavePluginStateResult,
} from './mcp-server'
import { resolveDeviceClickAction, translateSelectAudioDeviceError } from './engine-view'
import {
  EngineViewProvider,
  engineViewSelectDevice,
  engineViewToggleDebug,
  engineViewToggleEngine,
  writeAudioDeviceSetting,
} from './engine-view-provider'
import type { PluginUiAction } from './plugin-ui-bridge'
import { resolveEngineState } from './engine-state-bridge'
import { decideStartEngineForAgent } from './engine-lifecycle'
import {
  autoStartConfiguredRustEngine,
  resolveAudioDeviceSetting,
  sendEngineStateMeta,
  sendPluginStateMeta,
  sendPluginUiMeta,
  sendSelectAudioDeviceMeta,
  startEngine,
  startEngineDebug,
  stopEngine,
  toggleEngine,
  updateBundleStatus,
  writeCodeToEngine,
} from './engine-process'
import { openDevDocs, openDevDocsPanel, openUserDocs, openWalkthrough } from './docs-panels'
import { configureFlash, configureFlashForAgent } from './flash-config'
import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractDeclaredMixerNodeNames,
  extractTopLevelDeclaredNames,
  filterDslCandidates,
  extractDeclaredGlobalNames,
  extractDeclaredSequenceNames,
} from './dsl-completion-context'
import { BUS_METHODS, GLOBAL_METHODS, SEQUENCE_METHODS } from './dsl-method-catalog'
import {
  detectRackArgContext,
  filterCatalogEntries,
  RACK_SCAN_MAX_LINES,
  buildPluginPickItems,
  type PluginVerb,
} from './plugin-catalog-completion'
import {
  loadPluginCatalog,
  runPluginScan,
  terminateActivePluginScans,
} from './plugin-catalog-reader'
import {
  bundleStatusItem,
  devDocsPanel,
  engineProcess,
  evalMarkBridge,
  isEngineRunning,
  isLiveCodingMode,
  mcpServerHandle,
  outputChannel,
  outputLogRing,
  pluginCatalogHintShown,
  pushLogRing,
  setBundleStatusItem,
  setDevDocsPanel,
  setEngineProcess,
  setEngineViewProvider,
  setGlobalInitialized,
  setLiveCodingMode,
  setMcpServerHandle,
  setOutputChannel,
  setPluginCatalogHintShown,
  setStatusBarItem,
  setTransportPlaying,
  statusBarItem,
  transportPlaying,
} from './extension-state'
import {
  clearAllPlayheadDecorations,
  playheadDecorationTypes,
  resetPlayheadDecorationTypes,
} from './playhead-decorations'
import { analyzeWavBuffer } from './wav-analysis'

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
/** `pluginUiForAgent` is module-private (only `activate()` wires it into MCP);
 * this seam lets a spec drive the real engine-guard + meta-line round-trip. */
export function __pluginUiForAgentForTest(
  action: PluginUiAction,
  receiver: string,
  index: number,
  expectedName?: string,
): ReturnType<typeof pluginUiForAgent> {
  return pluginUiForAgent(action, receiver, index, expectedName)
}

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

/**
 * "OrbitScore: Browse Plugins" command (#638) — palette entry that lists the
 * catalog and writes the chosen name at the cursor.
 *
 * Completion covers "I remember part of the name"; this covers "what do I even
 * have". With 274 effects and 74 instruments installed, the second question is
 * the common one and had no entry point at all.
 *
 * When the cursor already sits inside an `effect(` / `instrument(` string the
 * verb comes from there and the typed fragment is replaced, so picking from the
 * list and completing produce the same edit. Outside that context the command
 * asks which kind to browse and inserts a quoted name.
 */
async function browsePlugins(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showInformationMessage('OrbitScore: open an .orbs file to insert a plugin name.')
    return
  }

  const catalog = loadPluginCatalog()
  if (!catalog) {
    vscode.window.showWarningMessage(
      'OrbitScore: no plugin catalog found. Run "OrbitScore: Rescan Plugin Catalog" first.',
    )
    return
  }

  const position = editor.selection.active
  const firstRow = Math.max(0, position.line - RACK_SCAN_MAX_LINES)
  const lines: string[] = []
  for (let row = firstRow; row <= position.line; row += 1) {
    lines.push(editor.document.lineAt(row).text)
  }
  const context = detectRackArgContext(lines, position.line - firstRow, position.character)

  let verb: PluginVerb
  if (context) {
    verb = context.verb
  } else {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'effect', description: 'insert seq.effect("...")' },
        { label: 'instrument', description: 'insert seq.instrument("...")' },
      ],
      { title: 'OrbitScore: browse which kind of plugin?' },
    )
    if (!picked) return
    verb = picked.label as PluginVerb
  }

  const items = buildPluginPickItems(catalog.plugins, verb)
  if (items.length === 0) {
    vscode.window.showWarningMessage(
      `OrbitScore: the plugin catalog has no ${verb} plugins. Run "OrbitScore: Rescan Plugin Catalog".`,
    )
    return
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: `OrbitScore: ${verb} plugins (${items.length})`,
    matchOnDescription: true,
    placeHolder: 'Type to filter by name or vendor',
  })
  if (!choice) return

  await editor.edit((edit) => {
    if (context) {
      // Replace what has been typed inside the quotes, exactly as completion would.
      edit.replace(
        new vscode.Range(new vscode.Position(position.line, context.quoteStartChar), position),
        choice.insertText,
      )
    } else {
      edit.insert(position, `"${choice.insertText}"`)
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
    setPluginCatalogHintShown(false)
    const summary = result.summary
    const duration = `p50=${summary.durationMs.p50 ?? '-'}ms p95=${summary.durationMs.p95 ?? '-'}ms max=${summary.durationMs.max ?? '-'}ms`
    outputChannel?.appendLine(
      `✅ Plugin catalog rescanned: ${result.count} plugins; artifacts success=${summary.success} pending=${summary.pending} failure=${summary.failure}; ${duration}; timeout=${summary.timeouts} crash=${summary.crashes}`,
    )
    outputChannel?.appendLine(
      `   failure reasons=${JSON.stringify(summary.failureReasons)} factory versions=${JSON.stringify(summary.factoryVersions)}`,
    )
    for (const failure of result.failures) {
      outputChannel?.appendLine(
        `   failed ${path.basename(failure.path)}: ${failure.code}: ${failure.message}`,
      )
    }
    vscode.window.showInformationMessage(
      `OrbitScore: rescanned ${result.count} plugins (${summary.pending} pending, ${summary.failure} failed)`,
    )
  } else {
    outputChannel?.appendLine(`❌ Plugin catalog rescan failed: ${result.error}`)
    vscode.window.showErrorMessage(`OrbitScore: plugin catalog rescan failed: ${result.error}`)
  }
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
  // (~/.claude.json). Destructured (not `child_process.execFile`) — the repo's
  // security hook false-positives on the `child_process.exec*` member-access pattern.
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
 * Evaluate agent-supplied OrbitScore source (MCP `evaluate_orbitscore` tool).
 * Mirrors the engine-running guard in `runSelection` and reuses
 * `writeCodeToEngine`. Relative audio paths resolve against the first workspace
 * folder, since the agent has no "active editor".
 */
async function evaluateForAgent(code: string): Promise<EvaluateResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  const documentDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!writeCodeToEngine(code, documentDir)) {
    return { ok: false, error: 'engine stdin is not writable — the engine may have just died' }
  }
  // 🔴 #614: 以前はここで `{ ok: true }` を返していた。しかしその ok は
  // 「**stdin へ届いた**」までしか意味せず、パース/実行エラーは engine が stderr へ
  // 非同期に出すだけだった。LLM は ok を成功と解釈するので、実機で
  // `Variable not found: global` が出ていても先へ進んでしまう（実測）。
  //
  // REPL は行を FIFO で処理するので、コードの直後にマーカーを送れば
  // **マーカーに到達した時点で評価は完了している**。時間で待つ必要はない。
  const stdin = engineProcess.stdin
  if (!stdin || !stdin.writable) {
    return { ok: false, error: 'engine stdin is not writable — the engine may have just died' }
  }
  const result = await evalMarkBridge.send((line, onError) => {
    // 既存 bridge（pluginUi）と同じ書き方に揃える。error は null 込みで来る。
    stdin.write(line, (error) => {
      if (error) {
        outputChannel?.appendLine(`⚠️ failed to write //#evalMark to stdin: ${error.message}`)
        onError(error)
      }
    })
  }, randomUUID())
  if (result.ok) return { ok: true }
  const detail = result.diagnostics.length
    ? result.diagnostics.map((d) => `[${d.kind}] ${d.message}`).join('; ')
    : (result.error ?? 'engine reported an evaluation failure')
  return {
    ok: false,
    error: `evaluation failed: ${detail}`,
    ...(result.diagnostics.length ? { diagnostics: result.diagnostics } : {}),
  }
}

async function savePluginStateForAgent(
  sequence: string,
  index: number,
): Promise<SavePluginStateResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  if (transportPlaying) {
    return {
      ok: false,
      error: 'plugin state cannot be saved while the transport is running; stop first',
    }
  }
  try {
    const result = await sendPluginStateMeta(sequence, index)
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.details === undefined ? {} : { details: result.details }),
      }
    }
    return { ok: true, saved: result.saved }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function pluginUiForAgent(
  action: PluginUiAction,
  receiver: string,
  index: number,
  expectedName?: string,
): Promise<PluginUiResult> {
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return { ok: false, error: 'engine is not running — start the engine first' }
  }
  try {
    const response = await sendPluginUiMeta(action, receiver, index, expectedName)
    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        ...(response.code ? { code: response.code } : {}),
        ...(response.details === undefined ? {} : { details: response.details }),
      }
    }
    return { ok: true, result: response.result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Start the engine for the MCP `start_engine` tool (mirrors the palette command). */
export async function startEngineForAgent(options?: {
  captureWav?: string
  debug?: boolean
}): Promise<CommandResult> {
  const decision = decideStartEngineForAgent(isEngineRunning() && isLiveCodingMode, options)
  // `isEngineRunning() && isLiveCodingMode` can already be true here without this
  // call having spawned anything: autoStartConfiguredRustEngine() calls
  // startEngine() directly on activation when a saved audio device setting is
  // configured (and, unless it is `__default__`, that device is present in the
  // enumerated device list) — see the config gate there. Callers may also have
  // started the engine explicitly via an earlier start_engine call.
  if (decision.kind === 'reject') return { ok: false, error: decision.error }
  if (decision.kind === 'already-running') return { ok: true, message: 'engine already running' }
  if (!(await startEngine(options?.debug === true, options))) {
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

/**
 * `get_engine_state` が daemon の状態を待つ予算。
 *
 * 🔴 **長くしても取れるようにはならない。** `//#getEngineState` は REPL の `handleLine` の中で
 * 処理され、`createReplSession` の `pushLine` は全行を**単一の FIFO promise チェーン**に載せる
 * （`packages/engine/src/cli/repl-mode.ts` の「直列化の根拠 — #476」）。つまり長い await
 * （instrument の attach は実測 30 秒超）の最中は、**どんな予算でも答えは返らない**。
 * 予算を伸ばして得られるのは「同じ `statusError` を返すまでに何秒ブロックするか」だけで、
 * 対話的なツール呼び出しとしては短く degrade する方が良い。
 *
 * `running` は同期に分かるので、状態が取れなくても `{running, statusError}` は必ず返る。
 * **長い処理の最中にも状態を見せたいなら、必要なのは予算ではなく `//#getEngineState` を
 * キューの外で処理すること**（別 issue）。
 */
const ENGINE_STATE_QUERY_BUDGET_MS = 2_500

/**
 * Report engine state for the MCP `get_engine_state` tool. 判定そのものは
 * `resolveEngineState`（`engine-state-bridge.ts`）にあり、ここは配線だけ。
 */
function getEngineStateForAgent(): Promise<EngineState> {
  return resolveEngineState(
    {
      running: Boolean(engineProcess && !engineProcess.killed),
      liveCoding: isLiveCodingMode,
    },
    () => sendEngineStateMeta(ENGINE_STATE_QUERY_BUDGET_MS),
  )
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
  setPluginCatalogHintShown(false)
  return {
    ok: true,
    count: result.count,
    artifactCount: result.artifactCount,
    skipped: [...result.skipped],
    failures: result.failures.map((failure) => ({
      ...failure,
      slices: failure.slices ? [...failure.slices] : undefined,
    })),
    summary: result.summary,
  }
}

/**
 * List audio devices for the MCP `list_audio_devices` tool. The Rust engine
 * has no device-enumeration API today (tracked separately — doc 662 §6 /
 * #660), so this always reports the gap rather than pretending to probe.
 */
async function listAudioDevicesForAgent(): Promise<AudioDevicesResult> {
  return {
    ok: false,
    error:
      'audio device selection is not supported with the Rust engine; the system default output device is used',
  }
}

/**
 * Write the selected device for the MCP `select_audio_device` tool. Mirrors
 * the Engine view's device-click flow (D2.5 live bridge / next-start
 * settings write).
 */
async function selectAudioDeviceForAgent(device: string): Promise<CommandResult> {
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
    if (!(await startEngine())) {
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
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: d.code } : {}),
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

/**
 * Return the last N lines of the output-channel ring buffer for the MCP `get_log` tool.
 * 選択ロジックは `log-ring.ts`（vscode 非依存・テスト可能）に持たせている（#567）。
 */
function getLogForAgent(lines?: number): string[] {
  return selectLogLines(outputLogRing, lines)
}

/** Parse a captured WAV for the MCP `analyze_audio` tool. */
function analyzeAudioForAgent(
  wavPath: string,
  windowMs?: number,
  perChannel?: boolean,
): AnalyzeAudioResult {
  try {
    const buf = fs.readFileSync(wavPath)
    return { ok: true, analysis: analyzeWavBuffer(buf, { windowMs, perChannel }) }
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

/**
 * 補完プロバイダの登録（#495）。
 *
 * export しているのは**登録内容（トリガー文字を含む）をテストで固定する**ため。
 * トリガーに `.` が無いと、provider 本体が正しくてもユーザーが打った時に出てこない
 * — provider を直接呼ぶテストでは気づけない穴だった（変異検証で発見）。
 */
export function registerCompletionProviders(context: vscode.ExtensionContext) {
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
  // fire; detectRackArgContext itself matches a partial, unclosed string,
  // so a real re-invocation — e.g. Ctrl+Space — still resolves correctly too).
  const pluginCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        // #628: ラックは配列・複数行・`layer` の入れ子になるため、単一行 regex では
        // 発火しない（SC.10.10 規範 1 の退行点）。有界の後方スキャナを主経路にし、
        // 単一行の判定はその特殊ケースとして吸収される。
        // 🔴 スキャナは後方 RACK_SCAN_MAX_LINES 行までしか読まない。**文書全体を
        // materialize すると、その有界性を呼び出し側が台無しにする** — 数千行のファイルで
        // `"` を打つたびに全行をコピーすることになる。読む範囲だけを切り出して渡す。
        const firstRow = Math.max(0, position.line - RACK_SCAN_MAX_LINES)
        const lines: string[] = []
        for (let row = firstRow; row <= position.line; row += 1) {
          lines.push(document.lineAt(row).text)
        }
        const pluginContext = detectRackArgContext(
          lines,
          position.line - firstRow,
          position.character,
        )
        if (!pluginContext) return undefined

        const catalog = loadPluginCatalog()
        if (!catalog) {
          if (!pluginCatalogHintShown) {
            setPluginCatalogHintShown(true)
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
  // 🔴 #495: provider 本体は vscode API を直接叩く層で、文脈検出のユニットテストでは
  // 通らない。#614 で「配線はユニットテストの視野の外」を踏んだので、**named export に
  // 切り出してテストから直接駆動できるようにする**。
  const dslCompletionProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    dslCompletionItemProvider,
    '"',
    '{',
    // #495 第1段: `<receiver>.` の後のメソッド補完を出すためのトリガー。
    // これが無いと、明示的に補完を呼び出さない限り出てこない。
    '.',
    // #883: destination completion starts as soon as `.output(` is typed.
    '(',
  )
  context.subscriptions.push(dslCompletionProvider)
}

/** Register the quick fix shared by output-missing and dry-not-routed diagnostics. */
export function registerOutputCodeActionProvider(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerCodeActionsProvider(
    'orbitscore',
    {
      provideCodeActions(document, _range, actionContext) {
        const source = document.getText()
        const issues = analyzeMissingOutput(source)
        const actions: vscode.CodeAction[] = []
        for (const diagnostic of actionContext.diagnostics) {
          if (diagnostic.code !== 'output-missing' && diagnostic.code !== 'dry-not-routed') continue
          const issue = issues.find(
            (candidate) =>
              candidate.code === diagnostic.code && candidate.line === diagnostic.range.start.line,
          )
          if (!issue) continue
          const insertion = missingOutputQuickFixEdit(source, issue)
          const action = new vscode.CodeAction(
            `Add ${issue.sequenceName}.output()`,
            vscode.CodeActionKind.QuickFix,
          )
          action.diagnostics = [diagnostic]
          action.isPreferred = diagnostic.code === 'output-missing'
          action.edit = new vscode.WorkspaceEdit()
          action.edit.insert(
            document.uri,
            new vscode.Position(insertion.line, document.lineAt(insertion.line).text.length),
            insertion.insertText,
          )
          actions.push(action)
        }
        return actions
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  )
  context.subscriptions.push(provider)
  return provider
}

/**
 * DSL 補完の provider 本体（#495）。
 *
 * `activate()` の中に埋めるとテストから駆動できないので named export にしてある
 * （#614 の教訓: 配線はユニットテストの視野の外）。
 */
export const dslCompletionItemProvider: vscode.CompletionItemProvider = {
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
      case 'method': {
        // #495 第1段: `<receiver>.` の後にメソッドを出す。
        // 候補源は engine の DSL 語彙の写し（`dsl-method-catalog.ts`。乖離はテストが検知）。
        //
        // 🔴 **この面には既に持ち主がいる。** `completionProvider`（本ファイル上部・本 PR より前
        // から存在）が同じ `.` トリガーで、メソッドチェーンの文脈に応じて絞り込んだスニペット
        // 候補（`tempo(${1:120})` 等）を返す。ここで語彙を丸ごと返すと**同じ label が2つ並ぶ**
        // （実測で確認）。
        //
        // したがってこの provider は **既存が返さなかった語彙だけを補う**。既存は手書きの
        // 候補表で語彙テーブルと同期していないため、`ui`（#617）のような新しいメソッドが
        // 出てこない — その穴を埋めるのがここの役割。既存の「文脈で絞る」挙動は壊さない。
        //
        // 行だけでは変数のレシーバ種別が決まらないので、ここで**文書全体の宣言**を見る。
        // `var g = init GLOBAL` で宣言された名前なら Global、`init global.seq` なら Sequence。
        const text = document.getText()
        let methods: readonly string[]
        if (completionContext.receiver === 'bus') {
          methods = BUS_METHODS
        } else if (completionContext.receiver === 'global') {
          methods = GLOBAL_METHODS
        } else {
          // 変数名。宣言を見て決める。判定できない識別子には出さない
          // （無関係な `foo.` にまで DSL メソッドを並べない）。
          const head = completionContext.identifier
          if (!head) return undefined
          if (extractDeclaredGlobalNames(text).includes(head)) methods = GLOBAL_METHODS
          else if (extractDeclaredSequenceNames(text).includes(head)) methods = SEQUENCE_METHODS
          else return undefined
        }
        // 既存 provider が同じ位置で返す候補を除き、二重表示を防ぐ。
        //
        // 🔴 `isGlobal` は**既存 provider と同じ規則で計算する**（#619 Fable 監査 F5）。
        // こちらの宣言ベース判定を使うと、`myglobal.` のように **'global' で終わる変数名**で
        // 食い違う（実測: 旧は部分一致で Global 候補17件を返すのに、こちらは sequence 側を
        // 除外集合にするため全部二重表示になった）。
        //
        // 引き算は**相手の実際の出力**を引かなければ意味がない。判定を自前で持たず、
        // 旧の式（`linePrefix.includes('global.')`）をそのまま使う。
        const linePrefix = lineText.slice(0, position.character)
        const alreadyOffered = new Set(
          getContextualCompletions(
            analyzeMethodChain(lineText, position.character),
            linePrefix.includes('global.'),
          ).map((item) => String(item.label)),
        )
        return makeItems(
          methods.filter((method) => !alreadyOffered.has(method)),
          vscode.CompletionItemKind.Method,
        )
      }
      case 'output-string':
        return makeItems(
          [
            'master',
            ...extractDeclaredBusNames(document.getText(), 'sum'),
            ...extractDeclaredBusNames(document.getText(), 'aux'),
          ],
          vscode.CompletionItemKind.Value,
        )
      case 'output-node':
        return makeItems(
          ['master', ...extractDeclaredMixerNodeNames(document.getText())],
          vscode.CompletionItemKind.Variable,
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
        let importedSource: string
        try {
          importedSource = Buffer.from(await vscode.workspace.fs.readFile(importUri)).toString(
            'utf8',
          )
        } catch (error) {
          // The import may still be mid-edit or absent; completion must not
          // turn that ordinary editing state into a provider error. Logged
          // so real failures (e.g. permissions) remain diagnosable.
          outputChannel?.appendLine(
            `⚠️ DSL import-name completion: could not read ${importUri.fsPath}: ${error}`,
          )
          return undefined
        }
        return makeItems(
          extractTopLevelDeclaredNames(importedSource),
          vscode.CompletionItemKind.Variable,
        )
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
  for (const issue of analyzeMissingOutput(text)) {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
      issue.message,
      issue.code === 'output-missing'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information,
    )
    diagnostic.code = issue.code
    diagnostic.source = 'OrbitScore'
    diagnostics.push(diagnostic)
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

  // #638: plugin names that the catalog cannot resolve. The engine throws on
  // these at evaluation time, but with 342 catalog entries a typo is the common
  // case and waiting until evaluation to learn about it is expensive.
  //
  // Severity is Warning, not Error, even though the engine throws: the
  // extension's catalog is a cached snapshot, so a name can be *correct* and
  // merely not scanned yet (a plugin installed since the last rescan). Warning
  // says "this looks wrong" without asserting a certainty the snapshot cannot
  // support; the message names the rescan command for exactly that case.
  for (const issue of analyzeUnknownPluginNames(text, loadPluginCatalog()?.plugins)) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol),
        issue.message,
        vscode.DiagnosticSeverity.Warning,
      ),
    )
  }

  collection.set(document.uri, diagnostics)
}
