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

import { analyzeMethodChain, getContextualCompletions } from './completion-context'
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
} from './plugin-catalog-completion'
import { loadPluginCatalog, terminateActivePluginScans } from './plugin-catalog-reader'
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
  bundleStatusItem,
  devDocsPanel,
  engineProcess,
  mcpServerHandle,
  outputChannel,
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
