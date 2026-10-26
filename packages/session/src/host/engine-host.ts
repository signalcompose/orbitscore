/**
 * 層 2 が engine（`InterpreterV2`）を in-process で持ち、起動と停止を受け持つ（設計 848 §4.5・§5.3.2）。
 *
 * 凍結版では拡張が `cli-audio.js repl` を子プロセスとして起こし、その中で `InterpreterV2` が daemon を
 * 起こしていた。層 2 では同じ `InterpreterV2` を直接持つので、凍結版が子プロセスの環境変数と
 * 起動引数で渡していたもの（`ORBIT_CAPTURE_WAV` / `ORBITSCORE_DEBUG` / `ORBIT_HOST_BUNDLE_ID` /
 * `--audio-device`）を、daemon を起こす前に層 2 の環境と `boot(audioDevice)` に写す（daemon は層 2 の
 * 環境を継承する・`daemon-client.ts` の `daemonEnv(process.env)`）。層 1 が読む環境変数は変えない。
 */
import type { InterpreterV2 } from '@orbitscore/engine/dist/interpreter/interpreter-v2'
import type { AudioEngineBackend } from '@orbitscore/engine/dist/audio/engine-backend'

export type CommandResult = { ok: true; message?: string } | { ok: false; error: string }

export interface EngineState {
  running: boolean
  liveCoding: boolean
  output?: Record<string, unknown>
  callback?: Record<string, unknown>
  statusError?: string
}

export interface StartEngineParams {
  captureWav?: string
  audioDevice?: string
  debug?: boolean
  hostBundleId?: string
}

/** 層 2 が engine に求める面（テストでは偽物を渡す）。 */
export type EngineInterpreter = Pick<
  InterpreterV2,
  'executeStatements' | 'boot' | 'getGlobals' | 'savePluginState' | 'openPluginUi' | 'closePluginUi'
> & {
  readonly audioEngine: Pick<AudioEngineBackend, 'quit' | 'getDaemonStatus' | 'selectAudioDevice'>
  enableSessionLog?(options: { cwd: string }): void
}

export interface EngineHostDeps {
  createInterpreter(): EngineInterpreter
  /** daemon と plugin child が継承する環境（既定は `process.env`）。 */
  env?: NodeJS.ProcessEnv
  /** `--host-bundle-id`（アプリ自身の bundle id）。`engine.start` の `hostBundleId` の既定値。 */
  defaultHostBundleId?: string
  /** session log（`.orbslog`）を書く場所。凍結版は engine の cwd（= ワークスペース）だった。 */
  sessionLogCwd: string
  /** `ORBITSCORE_SESSION_LOG=1` の時だけ true（凍結版 `shouldEnableSessionLog`）。 */
  sessionLogEnabled: boolean
  /** 層 2 の行（plugin state の保存の失敗など）。console には書かない（P-07 の横取りに混ざる）。 */
  log(level: 'error' | 'warn' | 'info', text: string): void
}

/** 凍結版 `get_engine_state` が daemon の状態を待つ予算（`agent-handlers.ts`）。 */
export const ENGINE_STATE_QUERY_BUDGET_MS = 2_500
/** 凍結版 `cli/shutdown.ts` の plugin state の保存の予算。 */
export const SHUTDOWN_SNAPSHOT_BUDGET_MS = 1_200

export class EngineHost {
  private interpreter: EngineInterpreter | null = null
  private starting: Promise<CommandResult> | null = null
  private debugMode = false
  private readonly env: NodeJS.ProcessEnv
  /**
   * 選択中のデバイス（`''` = システムの既定）。起動した・切り替えたデバイスで、停止しても残す
   * （凍結版の設定 `orbitscore.audioDevice` が停止で消えないのと同じ・`audio.selectDevice`）。
   */
  audioDevice = ''

  constructor(private readonly deps: EngineHostDeps) {
    this.env = deps.env ?? process.env
  }

  get running(): boolean {
    return this.interpreter !== null
  }

  get debug(): boolean {
    return this.debugMode
  }

  /** 評価に使う interpreter（起動していなければ null）。 */
  current(): EngineInterpreter | null {
    return this.interpreter
  }

  async start(params: StartEngineParams = {}): Promise<CommandResult> {
    if (this.starting) return this.starting
    if (this.running) {
      // 凍結版 `decideStartEngineForAgent`（`engine-lifecycle.ts`）と同じ: 起動の時にしか効かない
      // 指定を、走っている engine に黙って捨てない（#528）。
      const spawnOnly = [params.captureWav ? 'capture_wav' : null, params.debug ? 'debug' : null]
        .filter((option): option is string => option !== null)
        .join(', ')
      if (spawnOnly) {
        return {
          ok: false,
          error:
            `engine is already running; requested spawn-only option(s): ${spawnOnly}. ` +
            'The existing engine may already have different spawn settings. Call stop_engine first, ' +
            'then start_engine again with the requested option(s).',
        }
      }
      return { ok: true, message: 'engine already running' }
    }
    this.starting = this.boot(params).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async boot(params: StartEngineParams): Promise<CommandResult> {
    this.setEnv('ORBIT_CAPTURE_WAV', params.captureWav)
    this.setEnv('ORBITSCORE_DEBUG', params.debug ? '1' : undefined)
    this.setEnv('ORBIT_HOST_BUNDLE_ID', params.hostBundleId ?? this.deps.defaultHostBundleId)
    // 凍結版は `repl --debug` を `parse-arguments.ts` が `globalThis.ORBITSCORE_DEBUG` に写していた。
    ;(globalThis as { ORBITSCORE_DEBUG?: boolean }).ORBITSCORE_DEBUG = params.debug === true
    const interpreter = this.deps.createInterpreter()
    if (this.deps.sessionLogEnabled) {
      interpreter.enableSessionLog?.({ cwd: this.deps.sessionLogCwd })
    }
    try {
      await interpreter.boot(params.audioDevice)
    } catch (error) {
      await interpreter.audioEngine.quit?.().catch(() => {})
      return {
        ok: false,
        error: `engine failed to start: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.interpreter = interpreter
    this.debugMode = params.debug === true
    this.audioDevice = params.audioDevice ?? ''
    return {
      ok: true,
      message: params.captureWav
        ? `engine started (capturing to ${params.captureWav})`
        : 'engine started',
    }
  }

  /**
   * 凍結版 `cli/shutdown.ts` の順（transport を止める → plugin state を予算内で保存 → daemon を畳む）。
   * 応答は daemon を畳む `quit()` が返ってから（設計 §5.3.2: `restartEngine` = stop + start の合成）。
   */
  async stop(): Promise<CommandResult> {
    if (this.starting) await this.starting
    const interpreter = this.interpreter
    if (!interpreter) return { ok: true, message: 'engine already stopped' }
    this.interpreter = null
    const globals = interpreter.getGlobals()
    for (const global of globals) global.stop({ autoSnapshot: false })
    let timeout: NodeJS.Timeout | undefined
    try {
      const snapshot = Promise.all(globals.map((global) => global.saveAllPluginStates())).then(
        () => 'complete' as const,
      )
      const budget = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), SHUTDOWN_SNAPSHOT_BUDGET_MS)
        timeout.unref?.()
      })
      if ((await Promise.race([snapshot, budget])) === 'timeout') {
        this.deps.log(
          'error',
          `[plugin-state] shutdown snapshot timed out after ${SHUTDOWN_SNAPSHOT_BUDGET_MS}ms`,
        )
      }
    } catch (error) {
      this.deps.log(
        'error',
        `[plugin-state] shutdown snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    try {
      await interpreter.audioEngine.quit?.()
    } catch (error) {
      return {
        ok: false,
        error: `engine failed to stop: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { ok: true, message: 'engine stopped' }
  }

  /** 凍結版 `resolveEngineState` + `//#getEngineState`（`engine-state-bridge.ts` / `repl-mode.ts`）。 */
  async getState(budgetMs = ENGINE_STATE_QUERY_BUDGET_MS): Promise<EngineState> {
    const interpreter = this.interpreter
    if (!interpreter) return { running: false, liveCoding: false }
    const base = { running: true, liveCoding: true }
    let timer: NodeJS.Timeout | undefined
    try {
      const getStatus = interpreter.audioEngine.getDaemonStatus
      if (!getStatus)
        throw new Error('GetStatus is not supported by the current audio engine backend')
      const status = await Promise.race([
        getStatus.call(interpreter.audioEngine),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${budgetMs}ms waiting for the daemon status`)),
            budgetMs,
          )
          timer.unref?.()
        }),
      ])
      const { output, callback } = status as { output?: unknown; callback?: unknown }
      if (!isPlainObject(output) || !isPlainObject(callback)) {
        throw new Error('daemon GetStatus omitted output or callback')
      }
      return { ...base, output, callback }
    } catch (error) {
      return { ...base, statusError: error instanceof Error ? error.message : String(error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private setEnv(name: string, value: string | undefined): void {
    if (value === undefined || value === '') delete this.env[name]
    else this.env[name] = value
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
