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
let hasEvaluatedFile: boolean = false
let evaluationTimeout: NodeJS.Timeout | null = null
// let isDebugMode: boolean = false // Debug mode flag

export async function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore Audio DSL extension activated!')

  // Reset state on activation (important for reload)
  engineProcess = null
  isLiveCodingMode = false
  hasEvaluatedFile = false

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
  let enginePath: string
  let engineSource: string

  if (debugMode) {
    // Debug mode: use workspace engine (development)
    enginePath = path.join(__dirname, '../../engine/dist/cli-audio.js')
    engineSource = 'workspace engine (development)'
  } else {
    // Normal mode: use extension-local engine (stable)
    enginePath = path.join(__dirname, '../engine/dist/cli-audio.js')
    engineSource = 'extension engine (stable)'
  }

  outputChannel?.appendLine(`📦 Using: ${engineSource}`)
  outputChannel?.appendLine(`📍 Path: ${enginePath}`)

  if (!fs.existsSync(enginePath)) {
    if (debugMode) {
      vscode.window.showErrorMessage(`Debug engine not found: ${enginePath}`)
    } else {
      vscode.window.showErrorMessage(
        `Extension engine not found: ${enginePath}\n\n` +
          `This indicates a build issue. Please rebuild the extension:\n` +
          `1. Run "npm run build" in the vscode-extension directory\n` +
          `2. Ensure the engine is properly built and copied\n` +
          `3. Check that packages/engine/dist/cli-audio.js exists`,
      )
    }
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
    hasEvaluatedFile = false
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
  hasEvaluatedFile = false
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

function filterDefinitionsOnly(code: string): string {
  // Filter out transport commands (.loop(), .run(), .stop(), etc.)
  // But preserve multiline statements by removing complete statements, not individual lines

  // Split into lines but preserve line breaks for reconstruction
  const lines = code.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Keep comments and empty lines
    if (!trimmed || trimmed.startsWith('//')) {
      result.push(line)
      i++
      continue
    }

    // Check if this is a transport command (complete statement on one line)
    // Match both with and without arguments: seq.start(), seq.start(args), global.start(), etc.
    if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*\.(loop|start|stop|mute|unmute)\s*\(/)) {
      // Skip this line (it's a transport command)
      i++
      continue
    }

    // Check if this is a standalone parameter change command (not chained)
    // But keep global settings like global.tempo(), global.beat()
    const isGlobalSetting = trimmed.startsWith('global.')
    if (
      !isGlobalSetting &&
      trimmed.match(
        /^[a-zA-Z_][a-zA-Z0-9_]*\.(gain|pan|length|tempo|beat|compressor|limiter|normalizer)\s*\(/,
      ) &&
      !trimmed.startsWith('var ') &&
      !trimmed.includes('.audio(') &&
      !trimmed.includes('.play(')
    ) {
      // For standalone parameter changes, we need to check if it spans multiple lines
      let parenDepth = 0
      let lineEnd = i

      // Count opening and closing parens to find the end of the statement
      for (let j = i; j < lines.length; j++) {
        const currentLine = lines[j]
        for (const char of currentLine) {
          if (char === '(') parenDepth++
          if (char === ')') parenDepth--
        }
        lineEnd = j
        if (parenDepth === 0) break
      }

      // Skip all lines of this standalone parameter change
      i = lineEnd + 1
      continue
    }

    // Keep everything else (variable declarations, chained methods, multiline statements)
    result.push(line)
    i++
  }

  return result.join('\n')
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

    // const isFirstEvaluation = !hasEvaluatedFile

    // Filter out all transport commands (always)
    // isInitializing = true for first evaluation (include var declarations)
    let definitionsOnly = filterDefinitionsOnly(code)

    // Inject setDocumentDirectory() call after global variable initialization
    const documentDir = path.dirname(document.uri.fsPath)
    const setDirCommand = `global.setDocumentDirectory("${documentDir.replace(/\\/g, '\\\\')}")`

    // Find where 'var global = init GLOBAL' appears and inject after it
    const globalInitMatch = definitionsOnly.match(/(var\s+global\s*=\s*init\s+GLOBAL[^\n]*\n)/)
    if (globalInitMatch) {
      const insertPos = globalInitMatch.index! + globalInitMatch[0].length
      definitionsOnly =
        definitionsOnly.slice(0, insertPos) +
        setDirCommand +
        '\n' +
        definitionsOnly.slice(insertPos)
    }

    // Debug: log what we're sending in debug mode
    if (statusBarItem?.text.includes('🐛')) {
      outputChannel?.appendLine('📤 File evaluation:')
      outputChannel?.appendLine(`📂 Document directory: ${documentDir}`)
      outputChannel?.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      outputChannel?.appendLine(definitionsOnly)
      outputChannel?.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      outputChannel?.appendLine(`📏 Length: ${definitionsOnly.length} chars`)
      outputChannel?.appendLine(`📊 Lines: ${definitionsOnly.split('\n').length}`)
      // Show what will actually be sent (with newline added)
      outputChannel?.appendLine('📮 Sending to engine (with final newline):')
      outputChannel?.appendLine(JSON.stringify(definitionsOnly + '\n'))
    }

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
    const range = !selection.isEmpty
      ? new vscode.Range(selection.start, selection.end)
      : new vscode.Range(
          editor.document.lineAt(selection.active.line).range.start,
          editor.document.lineAt(selection.active.line).range.end,
        )

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

  // If file hasn't been evaluated yet, evaluate it first
  if (!hasEvaluatedFile) {
    await evaluateFileInBackground(editor.document)
    // Wait for evaluation to complete
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Execute the selected command (both single line and multiline)
  // Debug: log what we're sending if in debug mode (check status bar text for 🐛)
  if (statusBarItem?.text.includes('🐛')) {
    outputChannel?.appendLine(`📤 Sending: ${JSON.stringify(trimmedText)}`)
  }
  engineProcess.stdin?.write(trimmedText + '\n')
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
