import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import * as vscode from 'vscode'

import { analyzeMethodChain, getContextualCompletions } from './completion-context'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let isLiveCodingMode: boolean = false

export async function activate(context: vscode.ExtensionContext) {
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
    vscode.commands.registerCommand('orbitscore.stopEngine', stopEngine),
    statusBarItem,
  )

  // Track last evaluated file to avoid duplicates
  let lastEvaluatedFile: string | undefined

  // Auto-evaluate file on editor change and save
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && editor.document.languageId === 'orbitscore') {
        const filePath = editor.document.uri.fsPath
        if (filePath !== lastEvaluatedFile) {
          outputChannel?.appendLine('📂 Switched to OrbitScore file')
          lastEvaluatedFile = filePath
          await evaluateFileInBackground(editor.document)
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId === 'orbitscore') {
        await evaluateFileInBackground(document)
      }
    }),
  )

  // Evaluate currently active document if it's an OrbitScore file
  const activeEditor = vscode.window.activeTextEditor
  if (activeEditor && activeEditor.document.languageId === 'orbitscore') {
    outputChannel?.appendLine('📂 Extension activated with OrbitScore file open')
    lastEvaluatedFile = activeEditor.document.uri.fsPath
    await evaluateFileInBackground(activeEditor.document)
  }

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
  if (engineProcess && !engineProcess.killed) {
    engineProcess.kill()
  }
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
      label: '🛑 Stop Engine',
      description: 'Kill engine process',
      detail: 'Force stop the audio engine',
    },
    {
      label: '🔄 Reload',
      description: 'Reload window',
      detail: 'Restart extension and re-evaluate file',
    },
  ]

  vscode.window.showQuickPick(items).then((selection) => {
    if (!selection) return

    switch (selection.label) {
      case '▶️ Run Selection':
        vscode.commands.executeCommand('orbitscore.runSelection')
        break
      case '🛑 Stop Engine':
        vscode.commands.executeCommand('orbitscore.stopEngine')
        break
      case '🔄 Reload':
        vscode.commands.executeCommand('workbench.action.reloadWindow')
        break
    }
  })
}

function stopEngine() {
  if (engineProcess && !engineProcess.killed) {
    engineProcess.kill()
    engineProcess = null
    isLiveCodingMode = false
    statusBarItem!.text = '🎵 OrbitScore'
    vscode.window.showInformationMessage('🛑 Engine stopped')
  }
}


function filterDefinitionsOnly(code: string, isInitializing: boolean = false): string {
  // Filter out transport commands (.loop(), .run(), .stop(), etc.)
  // Keep only variable declarations and property settings
  const lines = code.split('\n')
  const filtered = lines.filter(line => {
    const trimmed = line.trim()
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('//')) return true
    // Skip all transport commands
    if (trimmed.match(/\.(loop|run|stop|mute|unmute)\s*\(\s*\)/)) {
      // Only keep global.run() during initialization
      if (isInitializing && trimmed.includes('global.run()')) return true
      return false
    }
    // Keep everything else (var declarations, property settings)
    return true
  })
  return filtered.join('\n')
}

async function evaluateFileInBackground(document: vscode.TextDocument) {
  const code = document.getText()
  
  outputChannel?.appendLine(`📝 File evaluation`)
  outputChannel?.appendLine(`   Live coding mode: ${isLiveCodingMode}`)
  
  // If not in live coding mode, check if file contains global.run()
  if (!isLiveCodingMode && code.includes('global.run()')) {
    // Initialize: keep global.run(), filter other transport commands
    const definitionsOnly = filterDefinitionsOnly(code, true)
    outputChannel?.appendLine('   → Initializing...')
    await executeCode(definitionsOnly)
    outputChannel?.appendLine('✅ Initialized')
  } else if (isLiveCodingMode && engineProcess && !engineProcess.killed) {
    // Re-evaluate: filter ALL transport commands including global.run()
    const definitionsOnly = filterDefinitionsOnly(code, false)
    outputChannel?.appendLine('   → Re-evaluating definitions...')
    engineProcess.stdin?.write(definitionsOnly + '\n')
  } else {
    outputChannel?.appendLine('   → No action taken')
  }
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
  }

  const trimmedText = text.trim()
  
  // If not in live coding mode yet, initialize first (but don't execute the command yet)
  if (!isLiveCodingMode) {
    outputChannel?.appendLine('⚠️ Not in live coding mode, initializing...')
    // Only evaluate the file, don't send the command
    await evaluateFileInBackground(editor.document)
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  // Now execute just the selected command (not the whole file)
  if (isLiveCodingMode && engineProcess && !engineProcess.killed) {
    outputChannel?.appendLine(`> ${trimmedText}`)
    engineProcess.stdin?.write(trimmedText + '\n')
  } else {
    vscode.window.showWarningMessage('Live coding mode not active')
  }
}


async function executeCode(code: string) {
  try {
    const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!projectRoot) {
      vscode.window.showErrorMessage('Please open a workspace folder')
      return
    }

    const enginePath = path.join(projectRoot, 'packages/engine/dist/cli-audio.js')
    if (!fs.existsSync(enginePath)) {
      vscode.window.showErrorMessage('Audio engine not found. Please build the project first.')
      return
    }

    // Check if we're in live coding mode (persistent process)
    if (isLiveCodingMode && engineProcess && !engineProcess.killed) {
      // Send command to existing process via stdin
      outputChannel?.appendLine(`> ${code.substring(0, 100)}${code.length > 100 ? '...' : ''}`)
      engineProcess.stdin?.write(code + '\n')
      return
    }

    // Start new process
    const tmpDir = os.tmpdir()
    const tmpFile = path.join(tmpDir, `orbitscore_${Date.now()}.osc`)
    fs.writeFileSync(tmpFile, code)

    outputChannel?.show()
    outputChannel?.appendLine(`🎵 OrbitScore Audio Engine`)

    const proc = child_process.spawn('node', [enginePath, 'eval', tmpFile], {
      cwd: projectRoot,
    })

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      outputChannel?.append(output)
      
      // Check if we entered live coding mode
      if (output.includes('Live coding mode')) {
        isLiveCodingMode = true
        statusBarItem!.text = '⏸️ Ready'
        vscode.window.showInformationMessage('🎵 Live coding mode activated')
      }
      
      // Check for global.run()
      if (output.includes('▶ Global')) {
        statusBarItem!.text = '▶️ Playing'
      }
      
      // Check for global.stop()
      if (output.includes('⏹ Global')) {
        statusBarItem!.text = '⏸️ Ready'
      }
    })

    proc.stderr?.on('data', (data) => {
      outputChannel?.append(data.toString())
    })

    proc.on('close', (code) => {
      isLiveCodingMode = false
      statusBarItem!.text = '🎵 OrbitScore'
      engineProcess = null
      
      if (code !== 0) {
        vscode.window.showErrorMessage('Engine stopped')
      }

      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
    })

    // Store for later use
    engineProcess = proc
  } catch (error: any) {
    vscode.window.showErrorMessage(`Error: ${error.message}`)
    outputChannel?.appendLine(`Error: ${error}`)
  }
}


function isTransportCommand(text: string): boolean {
  const trimmed = text.trim()
  return /^(global|seq\w*)\.(run|loop|stop|mute|unmute)/.test(trimmed)
}

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
