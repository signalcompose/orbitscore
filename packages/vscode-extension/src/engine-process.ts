/**
 * VS Code and child-process wiring for engine startup, shutdown, and stdin.
 *
 * Function bodies are moved unchanged from extension.ts. Helpers that were
 * module-private are exported only so the extension root can preserve its
 * existing wiring across the new module boundary.
 */
import * as child_process from 'child_process'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import * as vscode from 'vscode'

import type { EngineViewDevice, SelectAudioDeviceBridgeResult } from './engine-view'
import {
  extensionEngineFileExists,
  resolveDaemonBinaryForExtension,
} from './engine-startup-runtime'
import {
  logHandlerFailure,
  setupErrorHandler,
  setupExitHandler,
  setupStderrHandler,
  setupStdinErrorHandler,
  setupStdoutHandler,
} from './engine-handlers'
import {
  bumpEngineGeneration,
  bundleStatusItem,
  engineGeneration,
  engineProcess,
  engineStateBridge,
  engineViewProvider,
  evalMarkBridge,
  globalInitialized,
  isEngineRunning,
  outputChannel,
  pluginStateBridge,
  pluginUiBridge,
  selectAudioDeviceBridge,
  setEngineProcess,
  setGlobalInitialized,
  setLiveCodingMode,
  setTransportPlaying,
  statusBarItem,
} from './extension-state'
import type { PluginUiAction } from './plugin-ui-bridge'
import { clearAllPlayheadDecorations } from './playhead-decorations'

/**
 * Resolve the native Rust daemon binary via shared resolver (engine の
 * compiled JS を runtime require). Returns null on failure — reason is logged
 * to outputChannel so it's traceable from View Logs. Used to pre-check daemon
 * availability before spawning the engine process.
 */
export function resolveDaemonForUI(): { path: string; source: string } | null {
  try {
    return resolveDaemonBinaryForExtension()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`❌ daemon resolver failed: ${reason}`)
    return null
  }
}

/**
 * Refresh the bundle status bar item to reflect daemon resolution.
 *
 * Strict mode (Issue #136): resolver has no implicit fallback (Spotlight etc.),
 * so failure means the daemon binary genuinely could not be found — surface an
 * error state (rather than a blind "native" success indicator).
 */
export function updateBundleStatus(): void {
  if (!bundleStatusItem) return
  const daemonResolution = resolveDaemonForUI()
  if (!daemonResolution) {
    bundleStatusItem.show()
    bundleStatusItem.text = '$(error) daemon: not found'
    bundleStatusItem.tooltip =
      'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.'
    bundleStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    return
  }
  // 既定（健全）ではインジケータ自体を出さない（owner 判断 2026-07-17: 常時表示の意味がない）。
  bundleStatusItem.hide()
}

export async function toggleEngine(): Promise<void> {
  if (engineProcess && !engineProcess.killed) {
    // Stop engine
    stopEngine()
  } else {
    // Start engine
    await startEngine()
  }
}

/**
 * Determine engine path based on debug mode.
 */
export function getEnginePath(
  debugMode: boolean,
): { enginePath: string; engineSource: string } | null {
  // Always use extension-local engine (both debug and normal mode)
  // This ensures we test the same engine that will be distributed
  const enginePath = path.join(__dirname, '../engine/dist/cli-audio.js')
  const engineSource = debugMode ? 'extension engine (debug)' : 'extension engine (stable)'

  outputChannel?.appendLine(`📦 Using: ${engineSource}`)
  outputChannel?.appendLine(`📍 Path: ${enginePath}`)

  if (!extensionEngineFileExists(enginePath)) {
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
export function showEngineBuildTime(enginePath: string): void {
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
export function loadAudioDeviceConfig(workspaceRoot: string): string | undefined {
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
 * Resolve the effective output device (#484 D3). The `orbitscore.audioDevice`
 * VS Code setting is the primary source going forward (works without a
 * workspace file, discoverable via the Engine view); the legacy
 * `.orbitscore.json` `audioDevice` key (written by the Engine view's
 * device-click flow / the MCP `select_audio_device` tool, #388) is kept as a fallback for
 * back-compat with existing workspaces. Empty string means "system default".
 */
export function resolveAudioDeviceSetting(workspaceRoot: string): string {
  const setting = vscode.workspace.getConfiguration('orbitscore')
  const inspected = setting.inspect<string>('audioDevice')
  const configured = inspected?.workspaceValue ?? inspected?.globalValue
  // An explicitly empty legacy value means off, never "System Default".
  if (configured !== undefined) return configured
  return loadAudioDeviceConfig(workspaceRoot) ?? ''
}

export async function autoStartConfiguredRustEngine(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
  const saved = resolveAudioDeviceSetting(workspaceRoot)
  if (!saved) return
  try {
    const devices = await fetchAudioDevicesForView()
    if (saved !== '__default__' && !devices.some((device) => device.name === saved)) {
      vscode.window.showWarningMessage(
        `Saved audio device "${saved}" is not connected — select a device in Audio Engine Settings`,
      )
      return
    }
    if (!(await startEngine())) return
    const autoStartGeneration = engineGeneration
    setTimeout(() => {
      if (engineGeneration === autoStartGeneration && !isEngineRunning())
        vscode.window.showErrorMessage('Audio engine exited shortly after automatic startup')
    }, 5000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outputChannel?.appendLine(`⚠️ unable to enumerate saved audio device: ${message}`)
    vscode.window.showWarningMessage(message)
  }
}

/**
 * List output devices via the daemon's `--list-audio-devices` lightweight
 * mode (#484 D3) — spawns the binary, reads its single JSON line, and exits.
 * No stream is opened (see `orbit-audio-native::list_output_devices` /
 * `resolve_output_device`'s Aggregate-device probe-hang note), so this is
 * safe to run even while the engine itself is not running. `timeout` guards
 * against an unexpected hang so the TreeView never spins forever.
 */
export function fetchAudioDevicesForView(): Promise<EngineViewDevice[]> {
  const resolution = resolveDaemonForUI()
  if (!resolution) {
    return Promise.reject(
      new Error(
        'orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.',
      ),
    )
  }
  return new Promise((resolve, reject) => {
    child_process.execFile(
      resolution.path,
      ['--list-audio-devices'],
      { timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`failed to list audio devices: ${stderr.trim() || error.message}`))
          return
        }
        try {
          const line = stdout.trim().split('\n').pop() ?? ''
          const parsed = JSON.parse(line) as { devices: EngineViewDevice[] }
          resolve(parsed.devices)
        } catch (parseErr) {
          reject(
            new Error(
              `failed to parse device list: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            ),
          )
        }
      },
    )
  })
}

export async function startEngine(
  debugMode?: boolean,
  agentOpts?: { captureWav?: string },
): Promise<boolean> {
  if (engineProcess && !engineProcess.killed) {
    vscode.window.showWarningMessage('⚠️ Engine is already running')
    return false
  }

  // Pre-check: daemon が解決できない場合は engine spawn を行わず、エラー Notification
  // のみ表示する。spawn してから boot 失敗するとユーザーに二重通知 (resolver エラー +
  // engine 終了ログ) が出てしまうのを防ぐ (claude-review on PR #155 の Significant 指摘 #2)。
  // 従来はこの pre-check が無く、daemon 未解決のまま engine CLI を spawn していた —
  // 「Engine started」の成功トーストが先に出て、後から engine CLI 内部の daemon spawn
  // 失敗ログが追いかけてくるだけの偽成功 UX になっていた。env への daemon path 注入は
  // しない: spawn される engine CLI 自身が同一の compiled `resolveDaemonBinaryPath()` を
  // 実行するため、ここでの解決結果と決定的に同一になる（再注入する理由が無い）。
  const daemonResolution = resolveDaemonForUI()
  if (!daemonResolution) {
    outputChannel?.appendLine(
      '❌ orbit-audio-daemon not found — engine cannot start with the rust backend.',
    )
    vscode.window.showErrorMessage(
      '⚠️ orbit-audio-daemon not found. Reinstall the extension, build it via `cd rust && cargo build --release`, or set ORBIT_AUDIO_DAEMON_PATH to a custom binary.',
    )
    return false
  }

  const effectiveDebugMode =
    debugMode ?? vscode.workspace.getConfiguration('orbitscore').get<boolean>('engineDebug', false)
  const modeLabel = effectiveDebugMode ? '(Debug Mode)' : '(Normal Mode)'
  outputChannel?.appendLine(`🚀 Starting engine... ${modeLabel}`)

  // Get engine path
  const engineInfo = getEnginePath(effectiveDebugMode)
  if (!engineInfo) {
    return false
  }
  const { enginePath } = engineInfo

  // Show build time
  showEngineBuildTime(enginePath)

  // Get workspace root
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()

  // Load audio device config — VS Code setting first, `.orbitscore.json` fallback (#484 D3).
  const audioDevice = resolveAudioDeviceSetting(workspaceRoot)

  // Build args
  const args = ['repl']
  if (audioDevice && audioDevice !== '__default__') {
    args.push('--audio-device', audioDevice)
  }
  if (effectiveDebugMode) {
    args.push('--debug')
  }

  // Set environment
  const env = { ...process.env }
  if (effectiveDebugMode) {
    env.ORBITSCORE_DEBUG = '1'
  }

  // Capture seam (#307): the daemon records the master output to this WAV while
  // the stream runs. Only set when explicitly requested (MCP start_engine tool)
  // — inherited env stays authoritative otherwise.
  if (agentOpts?.captureWav) {
    env.ORBIT_CAPTURE_WAV = agentOpts.captureWav
    outputChannel?.appendLine(`🎙️ Capture: ${agentOpts.captureWav}`)
  }

  outputChannel?.appendLine('🦀 Audio backend: rust (orbit-audio-daemon, native)')

  // Spawn engine process
  // 🔴 `node` を PATH から引かない（#878）。Finder / launchd から起動された VS Code の PATH は
  // `/etc/paths` の最小構成で、`nodenv` / Homebrew で node を入れている環境ではそこに node が
  // 無い。engine は `spawn node ENOENT` で起動せず、症状は「エンジンが起動しない」だけなので
  // 原因が PATH だと利用者には分からない。VS Code がログインシェルの環境を解決してくれる時は
  // 通るが、それは実装詳細への暗黙の依存で、2026-09-12 に通らない条件を実測で特定した
  // （cold install した `.vsix` を CLI ラッパ経由 + 最小 PATH で起動すると確定で ENOENT）。
  //
  // 代わりに **VS Code 同梱の Node** を使う。拡張ホストは Electron なので `process.execPath` は
  // そのままでは Node として動かず（実測: `Unable to find helper app` で落ちる）、
  // `ELECTRON_RUN_AS_NODE=1` が要る。**実測の出典: #878 / PR #889・2026-09-12・この開発機**
  // （VS Code **1.134.0** / Electron 42.8.1）: 同梱 Node は 24.18.1 でルートの
  // `engines.node >=22.0.0` を満たし、`@julusian/midi` の prebuild も素の node と同じく読めた
  // （port count が一致）。後者は偶然ではない — `pkg-prebuilds` のローダは **N-API の時
  // Electron 判定へ入らず** `node-napi-v7.node` に決定論的に落ちる（`pkg-prebuilds/bindings.js`）。
  // 🔴 版は VS Code に従属するので、ここの数値は**その時点の観測**であって要件ではない。
  //
  // 🔴 「Electron の `runAsNode` fuse を将来 VS Code が無効化したら、`spawn` は成功するのに
  // Node として動かず、ENOENT も出ないまま偽の『起動した』になるのでは」— レビューで出た問い。
  // **VS Code はこの fuse を無効化できない**: 自身の CLI が
  // `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI"` で動いており（`Contents/Resources/app/bin/code`）、
  // 拡張ホストの fork（`out/bootstrap-fork.js`）も同じ変数に依存している。無効化すれば
  // `code` コマンド自体が壊れる。つまりこの経路は **VS Code 自身と同じ土台**に乗っている。
  const spawnedProcess = (() => {
    try {
      return child_process.spawn(process.execPath, [enginePath, ...args], {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        // `ELECTRON_NO_ASAR` は**素の node との意味論差を消すため**に併記する。
        // `ELECTRON_RUN_AS_NODE` の子では Electron の asar フックが生きており、`fs` が
        // 「`.asar` で終わるディレクトリ」をアーカイブとして扱う（Electron docs）。engine は
        // 利用者の与えたパス（`global.audioPath(...)`）を読むので、そこに `.asar` が現れた時だけ
        // 素の node と挙動が変わる。踏む確率は低いが、消すコストがゼロなら消しておく。
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
      })
    } catch (err) {
      // spawn threw before engineProcess was assigned, so no engine state was dirtied.
      logHandlerFailure('startEngine', err)
      return null
    }
  })()
  if (!spawnedProcess) return false
  setEngineProcess(spawnedProcess)
  bumpEngineGeneration()

  // Update state
  setLiveCodingMode(true)
  setGlobalInitialized(false)
  setTransportPlaying(false)

  statusBarItem!.text = effectiveDebugMode ? '🎵 OrbitScore: Ready 🐛' : '🎵 OrbitScore: Ready'
  statusBarItem!.tooltip = 'Click to stop engine'

  // Setup handlers
  setupStdoutHandler(spawnedProcess, effectiveDebugMode)
  setupStderrHandler(spawnedProcess)
  setupExitHandler(spawnedProcess)
  setupStdinErrorHandler(spawnedProcess)
  setupErrorHandler(spawnedProcess)

  await new Promise<void>((resolve) => process.nextTick(resolve))
  if (!engineProcess || engineProcess !== spawnedProcess || engineProcess.killed) {
    return false
  }

  vscode.window.showInformationMessage(
    effectiveDebugMode ? '✅ Engine started (Debug)' : '✅ Engine started',
  )
  outputChannel?.appendLine('✅ Engine started - Ready for evaluation')
  engineViewProvider?.refresh()
  return true
}

export async function startEngineDebug(): Promise<void> {
  await startEngine(true)
}

export function stopEngine(): boolean {
  bumpEngineGeneration()
  if (engineProcess && !engineProcess.killed) {
    // Capture process reference before nulling module-level variable
    // (the SIGKILL timeout needs this reference after engineProcess is set to null)
    const proc = engineProcess
    setEngineProcess(null)
    setLiveCodingMode(false)
    setGlobalInitialized(false)
    setTransportPlaying(false)
    clearAllPlayheadDecorations() // #390: don't wait for the exit event
    // #501 review Critical #1: drain here too — `stopEngine()` nulls
    // `engineProcess` immediately (before the `exit` event fires), so a caller
    // awaiting `sendSelectAudioDeviceMeta()` would otherwise hang until the
    // 10s timeout instead of failing fast.
    selectAudioDeviceBridge.drainAll('engine was stopped before responding to //#selectAudioDevice')
    pluginStateBridge.drainAll('engine was stopped before responding to //#savePluginState')
    pluginUiBridge.drainAll('engine was stopped before responding to //#pluginUi')
    evalMarkBridge.drainAll('engine was stopped before responding to //#evalMark')
    engineStateBridge.drainAll('engine was stopped before responding to //#getEngineState')

    // Send graceful shutdown signal (SIGTERM)
    // This allows the engine to clean up the audio backend properly
    proc.kill('SIGTERM')

    // Force kill after 2 seconds if still running.
    //
    // #532: `proc.killed` means "a signal was successfully SENT", not "the
    // process has exited" (`node_modules/@types/node/child_process.d.ts`
    // documents this explicitly). `proc.kill('SIGTERM')` above already makes
    // `killed === true` the instant the signal is delivered, so `!proc.killed`
    // here was always false and this SIGKILL never fired — a process that
    // ignores or hangs on SIGTERM was never escalated to, orphaning it.
    // `exitCode` / `signalCode` are the correct signal: both stay `null`
    // until the process has actually terminated.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }, 2000)

    statusBarItem!.text = '🎵 OrbitScore: Stopped'
    statusBarItem!.tooltip = 'Click to start engine'
    engineViewProvider?.refresh()
    vscode.window.showInformationMessage('🛑 Engine stopped')
    outputChannel?.appendLine('🛑 Engine stopped')
    return true
  }
  return false
}

/**
 * Inject `global.setDocumentDirectory(...)` and write OrbitScore source to the
 * engine's live-coding stdin. Shared by the editor "Run Selection" command and
 * the MCP `evaluate_orbitscore` tool so both go through the exact same path.
 *
 * setDir injection lets audioPath() / audio() resolve relative paths against the
 * `.orbs` file's directory (or, for the agent, the workspace root) rather than
 * the engine process's cwd:
 * - If this eval contains `var global = init GLOBAL`, insert setDocumentDirectory
 *   right after it (and remember that global is now initialized).
 * - Otherwise, if global has already been initialized in this engine session,
 *   prepend setDocumentDirectory before the user code (refreshes the directory
 *   in case the user switched .orbs files).
 * - If global has not yet been initialized, do not inject (would fail with
 *   "global is not defined").
 * When `documentDir` is undefined, no directory is injected.
 *
 * Returns whether the code was handed to the engine's stdin. False = the
 * engine process or its stdin was gone (e.g. died between the caller's guard
 * and this write) — callers surfacing an ok/error contract (MCP evaluate)
 * must NOT report ok in that case. NOTE: true means "delivered to stdin",
 * not "parsed / sounded" — the engine reports parse errors asynchronously on
 * stdout, and `play()` without RUN/LOOP is silent by design (§7). A stronger
 * engine-side acknowledgment is a recorded follow-on (WORK_LOG 6.189).
 */
/**
 * Send a `//#selectAudioDevice <name>` meta line to the running engine and wait for
 * the correlated JSON result line on stdout (#484 D2.5 — see repl-mode.ts's
 * `extractSelectAudioDeviceMeta`/`executeSelectAudioDeviceMeta`). Rejects if the
 * engine's stdin is not writable. Resolves (never rejects otherwise) with a
 * synthetic `ok: false` on a stdin write failure or on timeout (default 10s —
 * a genuine communication failure safety net; an unsupported backend returns an
 * explicit `ok: false` line instead of timing out, see repl-mode.ts).
 */
export function sendSelectAudioDeviceMeta(
  device: string,
  timeoutMs = 10000,
): Promise<SelectAudioDeviceBridgeResult> {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    return Promise.reject(new Error('engine stdin is not writable (engine not running?)'))
  }
  const stdin = engineProcess.stdin
  return selectAudioDeviceBridge.send(
    (line, onError) => {
      stdin.write(line, (err) => {
        if (err) {
          outputChannel?.appendLine(
            `⚠️ failed to write //#selectAudioDevice to stdin: ${err.message}`,
          )
          onError(err)
        }
      })
      return true
    },
    device,
    timeoutMs,
  )
}

export function sendEngineStateMeta(
  timeoutMs = 10_000,
): Promise<import('./engine-state-bridge').EngineStatusBridgeResult> {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    return Promise.reject(new Error('engine stdin is not writable (engine not running?)'))
  }
  const stdin = engineProcess.stdin
  return engineStateBridge.send((line, onError) => {
    stdin.write(line, (error) => {
      if (error) {
        outputChannel?.appendLine(`⚠️ failed to write //#getEngineState to stdin: ${error.message}`)
        onError(error)
      }
    })
    return true
  }, timeoutMs)
}

export function sendPluginStateMeta(
  sequence: string,
  index: number,
  timeoutMs = 10_000,
): Promise<import('./plugin-state-bridge').PluginStateBridgeResult> {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    return Promise.reject(new Error('engine stdin is not writable (engine not running?)'))
  }
  const stdin = engineProcess.stdin
  return pluginStateBridge.send(
    (line, onError) => {
      stdin.write(line, (error) => {
        if (error) {
          outputChannel?.appendLine(
            `⚠️ failed to write //#savePluginState to stdin: ${error.message}`,
          )
          onError(error)
        }
      })
      return true
    },
    { requestId: randomUUID(), sequence, index },
    timeoutMs,
  )
}

export function sendPluginUiMeta(
  action: PluginUiAction,
  receiver: string,
  index: number,
  expectedName?: string,
  timeoutMs = 35_000,
): Promise<import('./plugin-ui-bridge').PluginUiBridgeResult> {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    return Promise.reject(new Error('engine stdin is not writable (engine not running?)'))
  }
  const stdin = engineProcess.stdin
  return pluginUiBridge.send(
    (line, onError) => {
      stdin.write(line, (error) => {
        if (error) {
          outputChannel?.appendLine(`⚠️ failed to write //#pluginUi to stdin: ${error.message}`)
          onError(error)
        }
      })
      return true
    },
    {
      requestId: randomUUID(),
      action,
      receiver,
      index,
      ...(expectedName === undefined ? {} : { expectedName }),
    },
    timeoutMs,
  )
}

export function writeCodeToEngine(rawCode: string, documentDir: string | undefined): boolean {
  if (!engineProcess || !engineProcess.stdin || !engineProcess.stdin.writable) {
    // 呼び出し側ガード通過後に engine が死んだ稀な競合。黙って no-op すると
    // palette 実行では「実行したのに無反応」になるので、ここで必ず痕跡を残す。
    outputChannel?.appendLine('⚠️ Engine stdin is not writable — code was NOT sent (engine died?)')
    return false
  }
  let codeToSend = rawCode
  if (documentDir) {
    // I3 (#456): REPL メタ行で基準ディレクトリを帯域外で先渡しする。import 文（IM.2）は
    // どの statement よりも先に評価されるため、下の DSL 注入（statements として実行）では
    // 間に合わない — メタ行だけが import の基準（IM.6）を初回 eval から確定できる。
    // DSL 注入も残す（audio() 等の既存経路の実績を変えない・同値の冪等再設定）。
    codeToSend = `//#documentDirectory ${documentDir}\n` + codeToSend
    const setDirCommand = `global.setDocumentDirectory("${documentDir.replace(/\\/g, '\\\\')}")`
    const globalInitMatch = codeToSend.match(/(var\s+global\s*=\s*init\s+GLOBAL[^\n]*)/)
    if (globalInitMatch) {
      const insertPos = globalInitMatch.index! + globalInitMatch[0].length
      codeToSend =
        codeToSend.slice(0, insertPos) + '\n' + setDirCommand + codeToSend.slice(insertPos)
      setGlobalInitialized(true)
    } else if (globalInitialized) {
      codeToSend = setDirCommand + '\n' + codeToSend
    }
  }

  // #611 §5.7: every evaluated chunk is one audio-line batch (#649 §10.2's cursor rules
  // key off "one evaluation", not one statement) — wrap it so `repl-mode.ts` can open/close
  // that batch on every declared line. Placed after the `//#documentDirectory` prefix (and
  // the `setDocumentDirectory(...)` injection above) so both land inside the frame.
  codeToSend = `//#evalBegin\n${codeToSend}\n//#evalEnd`

  // Debug: log what we're sending if in debug mode (check status bar text for 🐛)
  if (statusBarItem?.text.includes('🐛')) {
    outputChannel?.appendLine(`📤 Sending: ${JSON.stringify(codeToSend)}`)
  }
  engineProcess.stdin.write(codeToSend + '\n')
  return true
}
