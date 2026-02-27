import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
// import * as os from 'os'

import * as vscode from 'vscode'

import { analyzeMethodChain, getContextualCompletions } from './completion-context'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let isLiveCodingMode: boolean = false

// let isDebugMode: boolean = false // Debug mode flag

export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  engineProcess = null
  isLiveCodingMode = false

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')

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
    vscode.commands.registerCommand('orbitscore.configureFlash', configureFlash),
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
      label: '⚡ Configure Flash',
      description: 'Customize flash settings',
      detail: 'Configure flash count, duration, color, and opacity',
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
      case '⚡ Configure Flash':
        vscode.commands.executeCommand('orbitscore.configureFlash')
        break
      case '🔄 Reload':
        vscode.commands.executeCommand('workbench.action.reloadWindow')
        break
    }
  })
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
 * Filter stdout output for non-debug mode.
 */
function filterStdout(output: string): string {
  const lines = output.split('\n')
  const filtered = lines.filter((line: string) => !shouldFilterLine(line))
  return filtered.join('\n')
}

/**
 * Setup stdout handler for engine process.
 */
function setupStdoutHandler(process: child_process.ChildProcess, debugMode: boolean): void {
  process.stdout?.on('data', (data) => {
    const output = data.toString()

    // Filter output in non-debug mode
    if (!debugMode) {
      const filteredOutput = filterStdout(output)
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

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
  })
}

function startEngine(debugMode: boolean = false) {
  if (engineProcess && !engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is already running')
    return
  }

  const modeLabel = debugMode ? '(Debug Mode)' : '(Normal Mode)'
  outputChannel?.appendLine(`🚀 Starting engine... ${modeLabel}`)

  // Get engine path
  const engineInfo = getEnginePath(debugMode)
  if (!engineInfo) {
    return
  }
  const { enginePath } = engineInfo

  // Show build time
  showEngineBuildTime(enginePath)

  // Get workspace root
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

  // Load audio device config
  const audioDevice = loadAudioDeviceConfig(workspaceRoot)

  // Build args
  const args = ['repl']
  if (audioDevice) {
    args.push('--audio-device', audioDevice)
  }
  if (debugMode) {
    args.push('--debug')
  }

  // Set environment
  const env = { ...process.env }
  if (debugMode) {
    env.ORBITSCORE_DEBUG = '1'
  }

  // Spawn engine process
  engineProcess = child_process.spawn('node', [enginePath, ...args], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })

  // Update state
  isLiveCodingMode = true

  statusBarItem!.text = debugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
  statusBarItem!.tooltip = 'Click to stop engine'
  vscode.window.showInformationMessage(
    debugMode ? '✅ Engine started (Debug)' : '✅ Engine started',
  )
  outputChannel?.appendLine('✅ Engine started - Ready for evaluation')

  // Setup handlers
  setupStdoutHandler(engineProcess, debugMode)
  setupStderrHandler(engineProcess)
  setupExitHandler(engineProcess)
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

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
  }
}

function killSuperCollider() {
  outputChannel?.appendLine('🔪 Killing SuperCollider processes...')

  // Execute killall scsynth, suppress errors if no process found
  child_process.exec('killall scsynth 2>/dev/null', (error) => {
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
  child_process.exec(`${scPath} -u 57199`, { timeout: 3000 }, async (error, stdout) => {
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

    const isWholeLine = selection.isEmpty
    const range = executionRange

    // Create flash function
    const createFlash = (flashIndex: number) => {
      const decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: backgroundColor,
        isWholeLine: isWholeLine,
      })
      editor.setDecorations(decoration, [range])

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

  // Inject setDocumentDirectory when evaluating global block
  let codeToSend = trimmedText
  if (
    !selection.isEmpty ||
    getLineSubject(editor.document.lineAt(selection.active.line).text) === 'global'
  ) {
    // Check if the code contains global init — inject setDocumentDirectory after it
    const documentDir = path.dirname(editor.document.uri.fsPath)
    const setDirCommand = `global.setDocumentDirectory("${documentDir.replace(/\\/g, '\\\\')}")`
    const globalInitMatch = codeToSend.match(/(var\s+global\s*=\s*init\s+GLOBAL[^\n]*)/)
    if (globalInitMatch) {
      const insertPos = globalInitMatch.index! + globalInitMatch[0].length
      codeToSend =
        codeToSend.slice(0, insertPos) + '\n' + setDirCommand + codeToSend.slice(insertPos)
    }
  }

  // Execute the selected command (both single line and multiline)
  // Debug: log what we're sending if in debug mode (check status bar text for 🐛)
  if (statusBarItem?.text.includes('🐛')) {
    outputChannel?.appendLine(`📤 Sending: ${JSON.stringify(codeToSend)}`)
  }
  engineProcess.stdin?.write(codeToSend + '\n')
  flashLines()
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

  collection.set(document.uri, diagnostics)
}
