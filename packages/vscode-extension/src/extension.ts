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
let hasEvaluatedFile: boolean = false

export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  engineProcess = null
  isLiveCodingMode = false
  hasEvaluatedFile = false

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')
  
  // Show version info
  const packageJson = require(path.join(__dirname, '../package.json'))
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
  statusBarItem.tooltip = 'Click to start engine'
  statusBarItem.command = 'orbitscore.toggleEngine'
  statusBarItem.show()

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.toggleEngine', toggleEngine),
    vscode.commands.registerCommand('orbitscore.showCommands', showCommands),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.stopEngine', stopEngine),
    statusBarItem,
  )

  // Auto-evaluate file only on save (not on open)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId === 'orbitscore') {
        await evaluateFileInBackground(document)
      }
    }),
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

function toggleEngine() {
  if (engineProcess && !engineProcess.killed) {
    // Stop engine
    stopEngine()
  } else {
    // Start engine
    startEngine()
  }
}

function startEngine() {
  if (engineProcess && !engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is already running')
    return
  }

  outputChannel?.appendLine('🚀 Starting engine...')
  
  const enginePath = path.join(__dirname, '../../engine/dist/cli-audio.js')
  if (!fs.existsSync(enginePath)) {
    vscode.window.showErrorMessage(`Engine not found: ${enginePath}`)
    return
  }

  engineProcess = child_process.spawn('node', [enginePath, 'repl'], {
    cwd: path.dirname(enginePath),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  isLiveCodingMode = true
  statusBarItem!.text = '🎵 OrbitScore: Ready'
  statusBarItem!.tooltip = 'Click to stop engine'
  vscode.window.showInformationMessage('✅ Engine started')
  outputChannel?.appendLine('✅ Engine started - Ready for evaluation')

  // Handle stdout
  engineProcess.stdout?.on('data', (data) => {
    const output = data.toString()
    outputChannel?.append(output)

    // Update status based on scheduler state
    if (output.includes('✅ Global running') || output.includes('▶ Global')) {
      statusBarItem!.text = '🎵 OrbitScore: ▶️ Playing'
    } else if (output.includes('✅ Global stopped') || output.includes('⏹ Global')) {
      statusBarItem!.text = '🎵 OrbitScore: Ready'
    }
  })

  // Handle stderr
  engineProcess.stderr?.on('data', (data) => {
    outputChannel?.append(`ERROR: ${data.toString()}`)
  })

  // Handle process exit
  engineProcess.on('exit', (code) => {
    outputChannel?.appendLine(`\n🛑 Engine process exited with code ${code}`)
    engineProcess = null
    isLiveCodingMode = false
    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
  })
}

function stopEngine() {
  if (engineProcess && !engineProcess.killed) {
    engineProcess.kill()
    engineProcess = null
    isLiveCodingMode = false
    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
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
    
    // Skip all transport commands (always, even during initialization)
    if (trimmed.match(/\.(loop|run|stop|mute|unmute)\s*\(\s*\)/)) {
      outputChannel?.appendLine(`   🚫 Filtered out: ${trimmed}`)
      return false
    }
    
    // During re-evaluation (NOT initialization), skip var declarations
    // This prevents creating new sequence instances
    if (!isInitializing && trimmed.match(/^var\s+\w+\s*=/)) {
      outputChannel?.appendLine(`   🚫 Filtered out: ${trimmed}`)
      return false
    }
    
    // Keep everything else (property settings during re-evaluation)
    return true
  })
  return filtered.join('\n')
}

async function evaluateFileInBackground(document: vscode.TextDocument) {
  // Only evaluate if engine is running
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    outputChannel?.appendLine('⚠️ Cannot evaluate: Engine is not running')
    return
  }

  const code = document.getText()
  
  const isFirstEvaluation = !hasEvaluatedFile
  outputChannel?.appendLine(`📝 Evaluating file... (first: ${isFirstEvaluation})`)
  
  // Filter out all transport commands (always)
  // isInitializing = true for first evaluation (include var declarations)
  const definitionsOnly = filterDefinitionsOnly(code, isFirstEvaluation)
  
  // Send definitions to engine
  outputChannel?.appendLine('   → Loading definitions...')
  engineProcess.stdin?.write(definitionsOnly + '\n')
  
  // Mark as evaluated
  hasEvaluatedFile = true
  outputChannel?.appendLine('✅ File evaluated')
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
  
  // If file hasn't been evaluated yet, evaluate it first
  if (!hasEvaluatedFile) {
    outputChannel?.appendLine('📝 Auto-evaluating file before first command...')
    await evaluateFileInBackground(editor.document)
    // Wait for evaluation to complete
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  // Execute the selected command
  outputChannel?.appendLine(`> ${trimmedText}`)
  engineProcess.stdin?.write(trimmedText + '\n')
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
      if (output.includes('▶ Global') || output.includes('✅ Global running')) {
        statusBarItem!.text = '▶️ Playing'
      }
      
      // Check for global.stop()
      if (output.includes('⏹ Global') || output.includes('✅ Global stopped')) {
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
