import * as vscode from 'vscode'
import * as child_process from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null

// Transport state
interface TransportState {
  playing: boolean
  bar: number
  beat: number
  bpm: number
  loopEnabled: boolean
  loopStart?: number
  loopEnd?: number
}

let transportState: TransportState = {
  playing: false,
  bar: 0,
  beat: 0,
  bpm: 120,
  loopEnabled: false
}

export function activate(context: vscode.ExtensionContext) {
  console.log('OrbitScore extension is now active!')

  // Create output channel
  outputChannel = vscode.window.createOutputChannel('OrbitScore')

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  updateStatusBar()
  statusBarItem.show()

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('orbitscore.start', startEngine),
    vscode.commands.registerCommand('orbitscore.runSelection', runSelection),
    vscode.commands.registerCommand('orbitscore.stop', stopEngine),
    vscode.commands.registerCommand('orbitscore.transport', showTransportPanel),
    statusBarItem
  )

  // Register diagnostics
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('orbitscore')
  context.subscriptions.push(diagnosticCollection)

  // Update diagnostics on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'orbitscore') {
        updateDiagnostics(event.document, diagnosticCollection)
      }
    })
  )

  // Initial diagnostics for open documents
  vscode.workspace.textDocuments.forEach(doc => {
    if (doc.languageId === 'orbitscore') {
      updateDiagnostics(doc, diagnosticCollection)
    }
  })
}

export function deactivate() {
  stopEngine()
  if (outputChannel) {
    outputChannel.dispose()
  }
  if (statusBarItem) {
    statusBarItem.dispose()
  }
}

function startEngine() {
  if (engineProcess) {
    vscode.window.showInformationMessage('OrbitScore engine is already running')
    return
  }

  const enginePath = path.join(__dirname, '../../engine/dist/cli.js')
  
  if (!fs.existsSync(enginePath)) {
    vscode.window.showErrorMessage('Engine not found. Please build the engine first.')
    return
  }

  engineProcess = child_process.spawn('node', [enginePath, 'start'], {
    cwd: path.dirname(enginePath)
  })

  engineProcess.stdout?.on('data', (data) => {
    outputChannel?.append(data.toString())
    // Parse transport state if available
    tryParseTransportUpdate(data.toString())
  })

  engineProcess.stderr?.on('data', (data) => {
    outputChannel?.append(`[ERROR] ${data.toString()}`)
  })

  engineProcess.on('close', (code) => {
    outputChannel?.appendLine(`Engine process exited with code ${code}`)
    engineProcess = null
    transportState.playing = false
    updateStatusBar()
  })

  vscode.window.showInformationMessage('OrbitScore engine started')
  transportState.playing = true
  updateStatusBar()
}

function stopEngine() {
  if (!engineProcess) {
    return
  }

  engineProcess.kill()
  engineProcess = null
  transportState.playing = false
  updateStatusBar()
  vscode.window.showInformationMessage('OrbitScore engine stopped')
}

async function runSelection() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showErrorMessage('No active editor')
    return
  }

  if (editor.document.languageId !== 'orbitscore') {
    vscode.window.showErrorMessage('Not an OrbitScore file')
    return
  }

  // Get selected text or entire document
  const selection = editor.selection
  let text: string
  
  if (selection.isEmpty) {
    text = editor.document.getText()
  } else {
    text = editor.document.getText(selection)
  }

  // Create temporary file
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, `orbitscore_${Date.now()}.osc`)
  
  try {
    fs.writeFileSync(tmpFile, text)
    
    // If engine is not running, start it
    if (!engineProcess) {
      startEngine()
      // Wait a bit for engine to start
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // Send the file to the engine
    const enginePath = path.join(__dirname, '../../engine/dist/cli.js')
    const runProcess = child_process.spawn('node', [enginePath, 'run', tmpFile])
    
    runProcess.stdout?.on('data', (data) => {
      outputChannel?.append(data.toString())
    })
    
    runProcess.stderr?.on('data', (data) => {
      outputChannel?.append(`[ERROR] ${data.toString()}`)
    })
    
    runProcess.on('close', (code) => {
      if (code === 0) {
        vscode.window.showInformationMessage('OrbitScore: Selection executed')
      } else {
        vscode.window.showErrorMessage(`OrbitScore: Execution failed with code ${code}`)
      }
      
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile)
      } catch (e) {
        // Ignore cleanup errors
      }
    })
  } catch (error) {
    vscode.window.showErrorMessage(`OrbitScore: ${error}`)
    outputChannel?.appendLine(`Error: ${error}`)
  }
}

function showTransportPanel() {
  // Create webview panel for transport controls
  const panel = vscode.window.createWebviewPanel(
    'orbitscoreTransport',
    'OrbitScore Transport',
    vscode.ViewColumn.Two,
    {
      enableScripts: true
    }
  )

  panel.webview.html = getTransportHTML()

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(
    message => {
      switch (message.command) {
        case 'play':
          sendTransportCommand('play')
          break
        case 'pause':
          sendTransportCommand('pause')
          break
        case 'stop':
          sendTransportCommand('stop')
          break
        case 'jump':
          sendTransportCommand(`jump:${message.bar}`)
          break
        case 'loop':
          sendTransportCommand(`loop:${message.enabled}:${message.start}:${message.end}`)
          break
      }
    }
  )
}

function sendTransportCommand(command: string) {
  if (!engineProcess) {
    vscode.window.showErrorMessage('Engine is not running')
    return
  }

  // Send command to engine via stdin
  engineProcess.stdin?.write(`${command}\n`)
}

function updateStatusBar() {
  if (!statusBarItem) return

  const status = transportState.playing ? '▶️' : '⏸'
  const bar = transportState.bar.toString().padStart(3, '0')
  const beat = transportState.beat.toString().padStart(2, '0')
  const loop = transportState.loopEnabled ? '🔁' : ''
  
  statusBarItem.text = `${status} ${bar}:${beat} | ${transportState.bpm} BPM ${loop}`
  statusBarItem.tooltip = 'Click to open transport panel'
  statusBarItem.command = 'orbitscore.transport'
}

function tryParseTransportUpdate(data: string) {
  // Try to parse transport state from engine output
  // Format: TRANSPORT:playing:bar:beat:bpm:loop
  const match = data.match(/TRANSPORT:(\w+):(\d+):(\d+):(\d+):(\w+)/)
  if (match) {
    transportState.playing = match[1] === 'true'
    transportState.bar = parseInt(match[2] || '0')
    transportState.beat = parseInt(match[3] || '0')
    transportState.bpm = parseInt(match[4] || '120')
    transportState.loopEnabled = match[5] === 'true'
    updateStatusBar()
  }
}

async function updateDiagnostics(document: vscode.TextDocument, collection: vscode.DiagnosticCollection) {
  const diagnostics: vscode.Diagnostic[] = []
  
  // Simple validation - we'll run the parser and catch errors
  const text = document.getText()
  
  try {
    // Import parser dynamically
    const { parseSourceToIR } = await import('../../engine/dist/parser/parser')
    parseSourceToIR(text)
    // If parsing succeeds, clear diagnostics
    collection.set(document.uri, [])
  } catch (error: any) {
    // Parse error message for line/column info
    const errorStr = error.toString()
    const match = errorStr.match(/line (\d+), column (\d+): (.+)/)
    
    if (match) {
      const line = parseInt(match[1]) - 1
      const column = parseInt(match[2]) - 1
      const message = match[3]
      
      const range = new vscode.Range(line, column, line, column + 1)
      const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error)
      diagnostics.push(diagnostic)
    } else {
      // Generic error at document start
      const range = new vscode.Range(0, 0, 0, 1)
      const diagnostic = new vscode.Diagnostic(range, errorStr, vscode.DiagnosticSeverity.Error)
      diagnostics.push(diagnostic)
    }
    
    collection.set(document.uri, diagnostics)
  }
}

function getTransportHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OrbitScore Transport</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .transport-controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        button {
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            font-size: 16px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .section {
            margin: 20px 0;
        }
        .section h3 {
            margin-bottom: 10px;
        }
        input[type="number"] {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 5px;
            width: 60px;
        }
        label {
            display: inline-block;
            margin-right: 10px;
        }
    </style>
</head>
<body>
    <h2>🎵 OrbitScore Transport</h2>
    
    <div class="transport-controls">
        <button id="playBtn">▶️ Play</button>
        <button id="pauseBtn">⏸ Pause</button>
        <button id="stopBtn">⏹ Stop</button>
    </div>

    <div class="section">
        <h3>Jump to Bar</h3>
        <input type="number" id="jumpBar" min="0" value="0">
        <button id="jumpBtn">Jump</button>
    </div>

    <div class="section">
        <h3>Loop</h3>
        <label>
            <input type="checkbox" id="loopEnabled"> Enable Loop
        </label>
        <br><br>
        <label>Start Bar: <input type="number" id="loopStart" min="0" value="0"></label>
        <label>End Bar: <input type="number" id="loopEnd" min="1" value="4"></label>
        <button id="setLoopBtn">Set Loop</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('playBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'play' });
        });

        document.getElementById('pauseBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'pause' });
        });

        document.getElementById('stopBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'stop' });
        });

        document.getElementById('jumpBtn').addEventListener('click', () => {
            const bar = document.getElementById('jumpBar').value;
            vscode.postMessage({ command: 'jump', bar: parseInt(bar) });
        });

        document.getElementById('setLoopBtn').addEventListener('click', () => {
            const enabled = document.getElementById('loopEnabled').checked;
            const start = document.getElementById('loopStart').value;
            const end = document.getElementById('loopEnd').value;
            vscode.postMessage({ 
                command: 'loop', 
                enabled: enabled,
                start: parseInt(start),
                end: parseInt(end)
            });
        });
    </script>
</body>
</html>`
}