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
let evaluationTimeout: NodeJS.Timeout | null = null
let isDebugMode: boolean = false // Debug mode flag

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
  statusBarItem.tooltip = 'Click to show commands'
  statusBarItem.command = 'orbitscore.showCommands'
  statusBarItem.show()

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.toggleEngine', toggleEngine),
    vscode.commands.registerCommand('orbitscore.showCommands', showCommands),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.stopEngine', stopEngine),
    vscode.commands.registerCommand('orbitscore.startEngineDebug', startEngineDebug),
    vscode.commands.registerCommand('orbitscore.killSuperCollider', killSuperCollider),
    vscode.commands.registerCommand('orbitscore.selectAudioDevice', selectAudioDevice),
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
      label: '🚀 Start Engine',
      description: 'Boot audio engine',
      detail: 'Start OrbitScore audio engine with SuperCollider',
    },
    {
      label: '🐛 Start Engine (Debug)',
      description: 'Boot with full logging',
      detail: 'Start engine with verbose debug output',
    },
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
      label: '🔊 Select Audio Device',
      description: 'Choose output device',
      detail: 'Select audio output device for SuperCollider',
    },
    {
      label: '🔪 Kill SuperCollider',
      description: 'killall scsynth',
      detail: 'Force kill all SuperCollider server processes',
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
      case '🚀 Start Engine':
        vscode.commands.executeCommand('orbitscore.toggleEngine')
        break
      case '🐛 Start Engine (Debug)':
        vscode.commands.executeCommand('orbitscore.startEngineDebug')
        break
      case '▶️ Run Selection':
        vscode.commands.executeCommand('orbitscore.runSelection')
        break
      case '🛑 Stop Engine':
        vscode.commands.executeCommand('orbitscore.stopEngine')
        break
      case '🔊 Select Audio Device':
        vscode.commands.executeCommand('orbitscore.selectAudioDevice')
        break
      case '🔪 Kill SuperCollider':
        vscode.commands.executeCommand('orbitscore.killSuperCollider')
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

function startEngine(debugMode: boolean = false) {
  if (engineProcess && !engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is already running')
    return
  }

  isDebugMode = debugMode
  const modeLabel = debugMode ? '(Debug Mode)' : ''
  outputChannel?.appendLine(`🚀 Starting engine... ${modeLabel}`)

  // Try extension-local engine first, then workspace engine
  let enginePath = path.join(__dirname, '../engine/dist/cli-audio.js')
  if (!fs.existsSync(enginePath)) {
    enginePath = path.join(__dirname, '../../engine/dist/cli-audio.js')
  }
  if (!fs.existsSync(enginePath)) {
    vscode.window.showErrorMessage(`Engine not found: ${enginePath}`)
    return
  }

  // Get workspace root for proper relative path resolution
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

  // Load .orbitscore.json config if it exists
  const configPath = path.join(workspaceRoot, '.orbitscore.json')
  let audioDevice: string | undefined

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      audioDevice = config.audioDevice
      if (audioDevice) {
        outputChannel?.appendLine(`🔊 Using audio device from config: ${audioDevice}`)
      }
    } catch (error) {
      outputChannel?.appendLine(`⚠️ Failed to read .orbitscore.json: ${error}`)
    }
  }

  const args = ['repl']
  if (audioDevice) {
    args.push('--audio-device', audioDevice)
  }
  if (debugMode) {
    args.push('--debug')
  }

  engineProcess = child_process.spawn('node', [enginePath, ...args], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  isLiveCodingMode = true
  hasEvaluatedFile = false // Reset on engine start
  statusBarItem!.text = debugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
  statusBarItem!.tooltip = 'Click to stop engine'
  vscode.window.showInformationMessage(
    debugMode ? '✅ Engine started (Debug)' : '✅ Engine started',
  )
  outputChannel?.appendLine('✅ Engine started - Ready for evaluation')

  // Handle stdout
  engineProcess.stdout?.on('data', (data) => {
    const output = data.toString()

    // In non-debug mode, filter out verbose logs
    if (!debugMode) {
      const lines = output.split('\n')
      const filtered = lines.filter((line: string) => {
        const trimmed = line.trim()

        // Keep important messages only
        if (line.includes('ERROR') || line.includes('⚠️') || line.includes('🎛️')) {
          return true
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
          return true
        }

        // Keep transport state changes
        if (line.includes('✅ Global running') || line.includes('✅ Global stopped')) {
          return true
        }

        // Filter out ALL verbose logs
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
          line.includes('"/') || // OSC addresses like "/done", "/n_go"
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
          trimmed.match(/^\d+\s*:/) || // Device numbers
          trimmed.match(/^-?\d+(\.\d+)?,?$/) || // Numbers only
          trimmed === ''
        ) {
          return false
        }

        return true
      })
      const filteredOutput = filtered.join('\n')
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

  // Handle stderr
  engineProcess.stderr?.on('data', (data) => {
    outputChannel?.append(`ERROR: ${data.toString()}`)
  })

  // Handle process exit
  engineProcess.on('exit', (code) => {
    outputChannel?.appendLine(`\n🛑 Engine process exited with code ${code}`)
    engineProcess = null
    isLiveCodingMode = false
    hasEvaluatedFile = false // Reset on engine exit
    isDebugMode = false // Reset debug mode
    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
  })
}

function startEngineDebug() {
  startEngine(true)
}

function stopEngine() {
  if (engineProcess && !engineProcess.killed) {
    // Send graceful shutdown signal (SIGTERM)
    // This allows the engine to clean up SuperCollider properly
    engineProcess.kill('SIGTERM')

    // Force kill after 2 seconds if still running
    setTimeout(() => {
      if (engineProcess && !engineProcess.killed) {
        engineProcess.kill('SIGKILL')
      }
    }, 2000)

    engineProcess = null
    isLiveCodingMode = false
    hasEvaluatedFile = false // Reset on engine stop
    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
  }
}

function killSuperCollider() {
  outputChannel?.appendLine('🔪 Killing SuperCollider processes...')

  // Execute killall scsynth, suppress errors if no process found
  child_process.exec('killall scsynth 2>/dev/null', (error, stdout, stderr) => {
    if (error) {
      // Exit code 1 means no process found, which is ok
      if (error.code === 1) {
        outputChannel?.appendLine('✅ No SuperCollider processes found')
        vscode.window.showInformationMessage('✅ No SuperCollider processes running')
      } else {
        outputChannel?.appendLine(`⚠️ Error: ${error.message}`)
        vscode.window.showWarningMessage(`⚠️ Failed to kill SuperCollider: ${error.message}`)
      }
    } else {
      outputChannel?.appendLine('✅ SuperCollider processes killed')
      vscode.window.showInformationMessage('✅ SuperCollider killed')
    }
  })
}

async function selectAudioDevice() {
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

  // Temporarily boot SuperCollider to get device list from its output
  const scPath = '/Applications/SuperCollider.app/Contents/Resources/scsynth'

  // Use scsynth directly with -u 0 to get device list without actually starting
  child_process.exec(`${scPath} -u 57199`, { timeout: 3000 }, async (error, stdout, stderr) => {
    // Parse device list from SuperCollider's boot log
    const deviceRegex = /(\d+)\s*:\s*"([^"]+)"/g
    const devices: Array<{ label: string; id: number; description: string }> = []
    let match

    while ((match = deviceRegex.exec(stdout)) !== null) {
      const deviceId = parseInt(match[1])
      const deviceName = match[2]
      devices.push({
        label: deviceName,
        id: deviceId,
        description: `Device ID: ${deviceId}`,
      })
    }

    if (devices.length === 0) {
      vscode.window.showErrorMessage('⚠️ No audio devices detected')
      outputChannel?.appendLine('⚠️ Failed to parse device list from SuperCollider')
      outputChannel?.appendLine(`Regex matches: ${devices.length}`)
      return
    }

    // Show quick pick
    const selected = await vscode.window.showQuickPick(devices, {
      placeHolder: 'Select audio output device',
      title: '🔊 Audio Device Selection',
    })

    if (!selected) return

    // Save device name (as SuperCollider recognizes it) to .orbitscore.json
    let config: any = {}
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }

    config.audioDevice = selected.label
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    outputChannel?.appendLine(`✅ Audio device set to: ${selected.label} (ID: ${selected.id})`)
    outputChannel?.appendLine(`✅ Config saved to: ${configPath}`)
    vscode.window.showInformationMessage(
      `✅ Audio device set to: ${selected.label}. Restart engine to apply.`,
    )

    // Kill the temporary SuperCollider instance
    child_process.exec('killall scsynth sclang 2>/dev/null')
  })
}

function filterDefinitionsOnly(code: string, isInitializing: boolean = false): string {
  // Filter out transport commands (.loop(), .run(), .stop(), etc.)
  // Filter out standalone gain/pan (live changes, not default settings)
  // Keep variable declarations and property settings
  // Note: var declarations are always kept because InterpreterV2 reuses existing instances
  const lines = code.split('\n')
  const filtered = lines.filter((line) => {
    const trimmed = line.trim()
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('//')) return true

    // Skip all transport commands (always, even during initialization)
    if (trimmed.match(/\.(loop|run|stop|mute|unmute)\s*\(\s*\)/)) {
      return false
    }

    // Skip standalone parameter change commands (live parameter changes)
    // Pattern: sequenceName.gain(...) or global.compressor(...) with nothing before
    // But keep chained ones like: kick.audio(...).play(...).gain(...)
    if (
      trimmed.match(
        /^[a-zA-Z_][a-zA-Z0-9_]*\.(gain|pan|length|tempo|beat|compressor|limiter|normalizer)\s*\(/,
      )
    ) {
      // Check if this is standalone (no var declaration, no other methods before)
      // If line starts with identifier.method, it's standalone
      if (
        !trimmed.startsWith('var ') &&
        !trimmed.includes('.audio(') &&
        !trimmed.includes('.play(')
      ) {
        return false
      }
    }

    // Keep everything else including var declarations and chained methods
    // InterpreterV2 will reuse existing instances if they exist
    return true
  })
  return filtered.join('\n')
}

async function evaluateFileInBackground(document: vscode.TextDocument) {
  // Only evaluate if engine is running
  if (!isLiveCodingMode || !engineProcess || engineProcess.killed) {
    return
  }

  // Debounce: cancel previous evaluation
  if (evaluationTimeout) {
    clearTimeout(evaluationTimeout)
  }

  // Schedule evaluation after 100ms of no activity
  evaluationTimeout = setTimeout(() => {
    const code = document.getText()

    const isFirstEvaluation = !hasEvaluatedFile

    // Filter out all transport commands (always)
    // isInitializing = true for first evaluation (include var declarations)
    const definitionsOnly = filterDefinitionsOnly(code, isFirstEvaluation)

    // Send definitions to engine
    engineProcess?.stdin?.write(definitionsOnly + '\n')

    // Mark as evaluated
    hasEvaluatedFile = true
    evaluationTimeout = null
  }, 100)
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
    await evaluateFileInBackground(editor.document)
    // Wait for evaluation to complete
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Execute the selected command
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
