import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import * as vscode from 'vscode'

// Engine process management
let engineProcess: child_process.ChildProcess | null = null
let outputChannel: vscode.OutputChannel | null = null
let statusBarItem: vscode.StatusBarItem | null = null
let transportPanel: vscode.WebviewPanel | null = null
let lastBroadcast: {
  playing: boolean
  bar: number
  beat: number
  bpm: number
  loopEnabled: boolean
} | null = null
type LoopInfo = { enabled: boolean; startBar: number; endBar: number }
let engineStatus: {
  mute: string[]
  solo: string[] | null
  port: string | null
  loop: LoopInfo | null
  bpm?: number
  beatsPerBar?: number
} = {
  mute: [],
  solo: null,
  port: null,
  loop: null,
}

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

const transportState: TransportState = {
  playing: false,
  bar: 0,
  beat: 0,
  bpm: 120,
  loopEnabled: false,
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
    statusBarItem,
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
    }),
  )

  // Initial diagnostics for open documents
  vscode.workspace.textDocuments.forEach((doc) => {
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
    cwd: path.dirname(enginePath),
  })

  engineProcess.stdout?.on('data', (data) => {
    const str = data.toString()
    outputChannel?.append(str)
    // Parse transport/state lines
    tryParseTransportUpdate(str)
    tryParseStatusUpdate(str)
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

  try {
    // If engine is not running, start it
    if (!engineProcess) {
      startEngine()
      // Wait a bit for engine to start
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // Send the code directly to the running engine via stdin (live eval)
    if (!engineProcess) {
      vscode.window.showErrorMessage('Engine is not running')
      return
    }

    // Escape the code for command line
    const escapedCode = text.replace(/"/g, '\\"')
    engineProcess.stdin?.write(`live:${escapedCode}\n`)

    vscode.window.showInformationMessage('🎵 OrbitScore: Live coding! Music continues...')
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
      enableScripts: true,
    },
  )
  transportPanel = panel
  panel.onDidDispose(() => {
    if (transportPanel === panel) transportPanel = null
  })

  panel.webview.html = getTransportHTML()

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage((message) => {
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
      case 'mute':
        sendTransportCommand(`mute:${message.seq}:${message.on}`)
        break
      case 'solo':
        sendTransportCommand(`solo:${message.list}`)
        break
      case 'status':
        sendTransportCommand('status')
        break
      case 'port':
        sendTransportCommand(`port:${message.name}`)
        break
    }
  })

  // Push current status immediately
  broadcastTransportState()
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
    // スロットリング: 拍が変わった/再生状態が変わった/テンポやループ状態が変わった場合のみ送信
    const current = {
      playing: transportState.playing,
      bar: transportState.bar,
      beat: transportState.beat,
      bpm: transportState.bpm,
      loopEnabled: transportState.loopEnabled,
    }
    const shouldSend =
      !lastBroadcast ||
      lastBroadcast.playing !== current.playing ||
      lastBroadcast.bar !== current.bar ||
      lastBroadcast.beat !== current.beat ||
      lastBroadcast.bpm !== current.bpm ||
      lastBroadcast.loopEnabled !== current.loopEnabled
    if (shouldSend) {
      broadcastTransportState(current)
      lastBroadcast = current
    }
  }
}

function tryParseStatusUpdate(data: string) {
  const idx = data.indexOf('STATUS:')
  if (idx < 0) return
  const jsonPart = data.slice(idx + 'STATUS:'.length).trim()
  try {
    const obj = JSON.parse(jsonPart)
    engineStatus = {
      mute: Array.isArray(obj.mute) ? obj.mute : [],
      solo: Array.isArray(obj.solo) ? obj.solo : null,
      port: typeof obj.port === 'string' ? obj.port : null,
      loop:
        obj.loop && typeof obj.loop === 'object'
          ? {
              enabled: !!obj.loop.enabled,
              startBar: Number.isFinite(obj.loop.startBar) ? obj.loop.startBar : 0,
              endBar: Number.isFinite(obj.loop.endBar) ? obj.loop.endBar : 0,
            }
          : null,
      bpm: Number.isFinite(obj.bpm) ? obj.bpm : undefined,
      beatsPerBar: Number.isFinite(obj.beatsPerBar) ? obj.beatsPerBar : undefined,
    }
    broadcastEngineStatus()
  } catch {
    // ignore
  }
}

function broadcastTransportState(stateOverride?: {
  playing: boolean
  bar: number
  beat: number
  bpm: number
  loopEnabled: boolean
}) {
  if (!transportPanel) return
  const state = stateOverride ?? {
    playing: transportState.playing,
    bar: transportState.bar,
    beat: transportState.beat,
    bpm: transportState.bpm,
    loopEnabled: transportState.loopEnabled,
  }
  transportPanel.webview.postMessage({ type: 'transport', state })
}

function broadcastEngineStatus() {
  if (!transportPanel) return
  transportPanel.webview.postMessage({ type: 'engineStatus', status: engineStatus })
}

async function updateDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
) {
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
    // Support optional "length N" segment in error message
    const match = errorStr.match(/line (\d+), column (\d+)(?:, length (\d+))?: (.+)/)

    if (match) {
      const line = parseInt(match[1]) - 1
      const column = parseInt(match[2]) - 1
      const length = match[3] ? parseInt(match[3]) : 1
      const message = match[4] ?? errorStr

      const range = new vscode.Range(line, column, line, column + Math.max(1, length))
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
    <div id="status" style="margin: 8px 0; opacity: 0.9;">
      <strong>Status:</strong>
      <span id="statusPlaying">⏸</span>
      <span id="statusBarBeat">000:00</span>
      <span id="statusBpm">120 BPM</span>
      <span id="statusLoop"></span>
    </div>

    <div class="section">
      <h3>Progress</h3>
      <label>Beats per bar: <input type="number" id="beatsPerBar" min="1" value="4" /></label>
      <div id="progressOuter" style="height:8px;background:var(--vscode-editorIndentGuide-background);width:100%;margin-top:6px;position:relative;">
        <div id="progressInner" style="height:100%;width:0%;background:var(--vscode-editorInfo-foreground);"></div>
      </div>
    </div>

    <div class="section">
      <h3>Current</h3>
      <div>Port: <span id="curPort">(unknown)</span></div>
      <div>Mute: <span id="curMute">—</span></div>
      <div>Solo: <span id="curSolo">—</span></div>
      <div>Loop: <span id="curLoop">—</span></div>
    </div>
    
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

    <div class="section">
        <h3>Mute</h3>
        <label>Sequence: <input type="text" id="muteSeq" placeholder="piano"></label>
        <label>
            <input type="checkbox" id="muteOn"> Muted
        </label>
        <button id="applyMuteBtn">Apply</button>
    </div>

    <div class="section">
        <h3>Solo</h3>
        <label>Sequences (comma-separated): <input type="text" id="soloList" placeholder="drums,bass"></label>
        <button id="applySoloBtn">Apply Solo</button>
        <button id="clearSoloBtn">Clear Solo</button>
    </div>

    <div class="section">
        <h3>MIDI Port</h3>
        <label>Port Name: <input type="text" id="midiPort" placeholder="IAC Driver Bus 1"></label>
        <button id="applyPortBtn">Switch Port</button>
        <button id="statusBtn">Status</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        let lastBeat = 0;
        let lastBeatTs = 0;
        let lastBpm = 120;
        let rafId = 0;

        function updateStatusView(state) {
            const playing = state.playing ? '▶️' : '⏸';
            const barStr = String(state.bar ?? 0).padStart(3, '0');
            const beatStr = String(Math.floor(state.beat ?? 0)).padStart(2, '0');
            document.getElementById('statusPlaying').textContent = playing;
            document.getElementById('statusBarBeat').textContent = barStr + ':' + beatStr;
            document.getElementById('statusBpm').textContent = (state.bpm ?? 120) + ' BPM';
            document.getElementById('statusLoop').textContent = state.loopEnabled ? '🔁' : '';
            const loopChk = document.getElementById('loopEnabled');
            if (loopChk) loopChk.checked = !!state.loopEnabled;

            const beatsPerBar = parseInt(document.getElementById('beatsPerBar').value || '4');
            const currentBeat = Math.max(1, Math.floor(state.beat ?? 1));
            // 拍が変わったら基準を更新
            if (currentBeat !== lastBeat || state.bpm !== lastBpm) {
              lastBeat = currentBeat;
              lastBeatTs = Date.now();
              lastBpm = state.bpm ?? 120;
            }
            // アニメーション更新
            if (rafId) cancelAnimationFrame(rafId);
            const animate = () => {
              const msPerBeat = 60000 / Math.max(1, lastBpm);
              const elapsed = Date.now() - lastBeatTs;
              const phase = Math.max(0, Math.min(1, elapsed / msPerBeat));
              const beatIndexWithinBar = ((currentBeat - 1) % beatsPerBar) + phase;
              const progress = Math.max(0, Math.min(1, beatIndexWithinBar / beatsPerBar));
              const inner = document.getElementById('progressInner');
              if (inner) inner.style.width = (progress * 100).toFixed(1) + '%';
              if (document.getElementById('statusPlaying').textContent === '▶️') {
                rafId = requestAnimationFrame(animate);
              }
            };
            animate();
        }

        function updateEngineStatusView(st) {
            document.getElementById('curPort').textContent = st.port || '(none)';
            const mute = Array.isArray(st.mute) && st.mute.length ? st.mute.join(', ') : '—';
            const solo = Array.isArray(st.solo) && st.solo.length ? st.solo.join(', ') : '—';
            document.getElementById('curMute').textContent = mute;
            document.getElementById('curSolo').textContent = solo;
            const loopEl = document.getElementById('curLoop');
            if (st.loop && st.loop.enabled) {
              loopEl.textContent = '' + st.loop.startBar + ' - ' + st.loop.endBar;
              // reflect into Loop form and persist
              const chk = document.getElementById('loopEnabled');
              const s = document.getElementById('loopStart');
              const e = document.getElementById('loopEnd');
              if (chk) chk.checked = true;
              if (s) s.value = String(st.loop.startBar);
              if (e) e.value = String(st.loop.endBar);
              const saved = vscode.getState() || {};
              vscode.setState({ ...(saved||{}), loopEnabled: true, loopStart: st.loop.startBar, loopEnd: st.loop.endBar });
            } else {
              loopEl.textContent = '—';
              const chk = document.getElementById('loopEnabled');
              if (chk) chk.checked = false;
              const saved = vscode.getState() || {};
              vscode.setState({ ...(saved||{}), loopEnabled: false });
            }
            // beatsPerBar from engine
            if (Number.isFinite(st.beatsPerBar)) {
              const input = document.getElementById('beatsPerBar');
              if (input) input.value = String(st.beatsPerBar);
              const saved = vscode.getState() || {};
              vscode.setState({ ...(saved||{}), beatsPerBar: st.beatsPerBar });
            }
            // bpm could be shown next to status (already displayed via transport state)
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg?.type === 'transport' && msg.state) {
                updateStatusView(msg.state);
            }
            if (msg?.type === 'engineStatus' && msg.status) {
                updateEngineStatusView(msg.status);
            }
        });

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
            // persist
            const st = vscode.getState() || {};
            vscode.setState({ ...(st||{}), loopEnabled: !!enabled, loopStart: parseInt(start), loopEnd: parseInt(end) });
        });

        document.getElementById('applyMuteBtn').addEventListener('click', () => {
            const seq = document.getElementById('muteSeq').value?.trim();
            const on = document.getElementById('muteOn').checked;
            if (seq) {
                vscode.postMessage({ command: 'mute', seq, on });
            }
        });

        document.getElementById('applySoloBtn').addEventListener('click', () => {
            const list = document.getElementById('soloList').value?.trim();
            if (list) {
                vscode.postMessage({ command: 'solo', list });
            }
        });

        document.getElementById('clearSoloBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'solo', list: 'none' });
        });

        document.getElementById('applyPortBtn').addEventListener('click', () => {
            const name = document.getElementById('midiPort').value?.trim();
            if (name) {
                vscode.postMessage({ command: 'port', name });
            }
        });

        document.getElementById('statusBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'status' });
        });

        // Request an initial status when loaded
        vscode.postMessage({ command: 'status' });

        // Persist beatsPerBar via VS Code state
        (function persistBeatsPerBar() {
            const state = vscode.getState() || {};
            const input = document.getElementById('beatsPerBar');
            if (state.beatsPerBar) input.value = String(state.beatsPerBar);
            input.addEventListener('change', () => {
                const v = Math.max(1, parseInt(input.value || '4'));
                vscode.setState({ ...(state||{}), beatsPerBar: v });
            });
        })();

        // Restore loop settings from state
        (function restoreLoopFromState() {
            const st = vscode.getState() || {};
            if (typeof st.loopEnabled === 'boolean') {
                const chk = document.getElementById('loopEnabled');
                if (chk) chk.checked = !!st.loopEnabled;
            }
            if (Number.isFinite(st.loopStart)) {
                const inp = document.getElementById('loopStart');
                if (inp) inp.value = String(st.loopStart);
            }
            if (Number.isFinite(st.loopEnd)) {
                const inp = document.getElementById('loopEnd');
                if (inp) inp.value = String(st.loopEnd);
            }
        })();
    </script>
  </body>
</html>`
}
