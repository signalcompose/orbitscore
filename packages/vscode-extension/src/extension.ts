import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import * as vscode from 'vscode'
// Context-aware completion will be integrated in next iteration
// import { analyzeMethodChain, getContextualCompletions } from './completion-context'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null

export function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.text = '🎵 OrbitScore'
  statusBarItem.tooltip = 'Click to run OrbitScore commands'
  statusBarItem.command = 'orbitscore.showCommands'
  statusBarItem.show()

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.showCommands', showCommands),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.runFile', runFile),
    vscode.commands.registerCommand('orbitscore.stop', stopEngine),
    statusBarItem,
  )

  // Register IntelliSense providers
  registerCompletionProviders(context)
  registerHoverProvider(context)

  // Register diagnostics
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('orbitscore')
  context.subscriptions.push(diagnosticCollection)

  // Update diagnostics on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'orbitscore') {
        updateDiagnostics(event.document, diagnosticCollection)
      }
    }),
  )
}

export function deactivate() {
  stopEngine()
  outputChannel?.dispose()
  statusBarItem?.dispose()
}

function showCommands() {
  const items: vscode.QuickPickItem[] = [
    {
      label: '▶️ Run Selection',
      description: 'Cmd+Enter',
      detail: 'Execute selected code or current line',
    },
    {
      label: '📄 Run File',
      description: 'Run entire file',
      detail: 'Execute the current .osc file',
    },
    { label: '⏹ Stop', description: 'Stop engine', detail: 'Stop all playback' },
  ]

  vscode.window.showQuickPick(items).then((selection) => {
    if (!selection) return

    switch (selection.label) {
      case '▶️ Run Selection':
        vscode.commands.executeCommand('orbitscore.runSelection')
        break
      case '📄 Run File':
        vscode.commands.executeCommand('orbitscore.runFile')
        break
      case '⏹ Stop':
        vscode.commands.executeCommand('orbitscore.stop')
        break
    }
  })
}

async function runSelection() {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'orbitscore') {
    vscode.window.showErrorMessage('Please open an OrbitScore file')
    return
  }

  // Get selected text or current line
  let text: string
  const selection = editor.selection

  if (!selection.isEmpty) {
    text = editor.document.getText(selection)
  } else {
    // Get the current line
    const line = editor.document.lineAt(selection.active.line)
    text = line.text

    // If line is a transport command, execute it
    if (isTransportCommand(text)) {
      await executeCode(text)
      return
    }

    // Otherwise, run the whole file
    text = editor.document.getText()
  }

  await executeCode(text)
}

async function runFile() {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'orbitscore') {
    vscode.window.showErrorMessage('Please open an OrbitScore file')
    return
  }

  const text = editor.document.getText()
  await executeCode(text)
}

async function executeCode(code: string) {
  try {
    // Create temporary file
    const tmpDir = os.tmpdir()
    const tmpFile = path.join(tmpDir, `orbitscore_${Date.now()}.osc`)
    fs.writeFileSync(tmpFile, code)

    // Find the engine executable
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!projectRoot) {
      vscode.window.showErrorMessage('Please open a workspace folder')
      return
    }

    const enginePath = path.join(projectRoot, 'packages/engine/dist/cli.js')
    if (!fs.existsSync(enginePath)) {
      vscode.window.showErrorMessage('Engine not found. Please build the project first.')
      return
    }

    // Execute the code
    outputChannel?.show()
    outputChannel?.appendLine(`Executing: ${code.substring(0, 100)}...`)

    const proc = child_process.spawn('node', [enginePath, 'eval', tmpFile], {
      cwd: projectRoot,
    })

    proc.stdout?.on('data', (data) => {
      outputChannel?.append(data.toString())
    })

    proc.stderr?.on('data', (data) => {
      outputChannel?.append(`[ERROR] ${data.toString()}`)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        vscode.window.showInformationMessage('🎵 Code executed successfully')
      } else {
        vscode.window.showErrorMessage('Execution failed. Check output for details.')
      }

      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
    })

    // Store for later stopping if needed
    engineProcess = proc
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error: ${error.message}`)
    outputChannel?.appendLine(`Error: ${error}`)
  }
}

function stopEngine() {
  if (engineProcess) {
    engineProcess.kill()
    engineProcess = null
    vscode.window.showInformationMessage('🛑 Stopped')
  }
}

function isTransportCommand(text: string): boolean {
  const trimmed = text.trim()
  return /^(global|seq\w*)\.(run|loop|stop|mute|unmute)/.test(trimmed)
}

function registerCompletionProviders(context: vscode.ExtensionContext) {
  // Global methods
  const globalProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substr(0, position.character)
        if (!linePrefix.endsWith('global.')) {
          return undefined
        }

        const completions = [
          createCompletion('tempo', 'Set global tempo', 'tempo(${1:140})'),
          createCompletion('tick', 'Set tick resolution', 'tick(${1:480})'),
          createCompletion('beat', 'Set time signature', 'beat(${1:4} by ${2:4})'),
          createCompletion('key', 'Set global key', 'key(${1:C})'),
          createCompletion('run', 'Start transport', 'run()'),
          createCompletion('loop', 'Loop transport', 'loop()'),
          createCompletion('stop', 'Stop transport', 'stop()'),
        ]

        return completions
      },
    },
    '.',
  )

  // Sequence methods
  const seqProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substr(0, position.character)
        if (!linePrefix.match(/seq\w*\./)) {
          return undefined
        }

        const completions = [
          createCompletion('tempo', 'Set sequence tempo', 'tempo(${1:120})'),
          createCompletion('beat', 'Set sequence meter', 'beat(${1:4} by ${2:4})'),
          createCompletion('audio', 'Load audio file', 'audio("${1:../audio/file.wav}")'),
          createCompletion('play', 'Play slices', 'play(${1:1, 2, 3, 4})'),
          createCompletion('mute', 'Mute sequence', 'mute()'),
          createCompletion('unmute', 'Unmute sequence', 'unmute()'),
        ]

        return completions
      },
    },
    '.',
  )

  // Chained methods
  const chainProvider = vscode.languages.registerCompletionItemProvider(
    'orbitscore',
    {
      provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substr(0, position.character)

        // Check if we're after audio()
        if (linePrefix.match(/\.audio\([^)]+\)\./)) {
          return [createCompletion('chop', 'Slice audio into parts', 'chop(${1:16})')]
        }

        // Check if we're after a number in play()
        if (linePrefix.match(/\d+\./)) {
          return [
            createCompletion('chop', 'Subdivide slice', 'chop(${1:4})'),
            createCompletion('time', 'Stretch time', 'time(${1:2})'),
            createCompletion('fixpitch', 'Fix pitch', 'fixpitch(${1:0})'),
          ]
        }

        return undefined
      },
    },
    '.',
  )

  context.subscriptions.push(globalProvider, seqProvider, chainProvider)
}

function createCompletion(
  label: string,
  detail: string,
  insertText: string,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Method)
  item.detail = detail
  item.insertText = new vscode.SnippetString(insertText)
  item.documentation = new vscode.MarkdownString(`**${label}**\n\n${detail}`)
  return item
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
        play: '**play(...slices)**\n\nPlay audio slices. Supports numbers, nested structures, and modifiers',
        chop: '**chop(n)**\n\nDivide audio into n equal slices',
        fixpitch: '**fixpitch(semitones)**\n\nPreserve pitch while time-stretching',
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    // Check for common syntax errors

    // Missing closing parenthesis
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

  collection.set(document.uri, diagnostics)
}
