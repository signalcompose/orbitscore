/**
 * Graceful shutdown handling
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'

import { getActiveInterpreter } from './active-interpreter'

const AUTO_SNAPSHOT_SHUTDOWN_BUDGET_MS = 1_200

/**
 * Gracefully shutdown the audio engine
 *
 * This function attempts to quit the audio engine backend cleanly
 * (Rust daemon by default since cutover #108, or SuperCollider when opted out)
 * before exiting the process. It's called on SIGINT (Ctrl+C) and SIGTERM.
 * `stop()` normally queues a fire-and-forget snapshot on the store's pending
 * chain; shutdown opts out so its explicitly awaited snapshot does not consume
 * the shared time budget by traversing every target twice.
 *
 * @param interpreter - Interpreter instance (may be null)
 *
 * @example
 * ```typescript
 * process.on('SIGINT', () => shutdown(globalInterpreter))
 * process.on('SIGTERM', () => shutdown(globalInterpreter))
 * ```
 */
export async function shutdown(interpreter: InterpreterV2 | null): Promise<void> {
  if (interpreter) {
    const globals = interpreter.getGlobals()
    for (const global of globals) {
      global.stop({ autoSnapshot: false })
    }

    let timeout: NodeJS.Timeout | undefined
    try {
      const totalTargets = globals.reduce(
        (total, global) => total + global.listPluginStateTargets().length,
        0,
      )
      let confirmedTargets = 0
      const snapshot = Promise.all(
        globals.map(async (global) => {
          const result = await global.saveAllPluginStates()
          confirmedTargets += result.saved + result.failures
        }),
      ).then(() => 'complete' as const)
      const budget = new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), AUTO_SNAPSHOT_SHUTDOWN_BUDGET_MS)
      })
      if ((await Promise.race([snapshot, budget])) === 'timeout') {
        console.error(
          `[plugin-state] shutdown snapshot timed out after ${AUTO_SNAPSHOT_SHUTDOWN_BUDGET_MS}ms ` +
            `(${confirmedTargets}/${totalTargets} targets confirmed)`,
        )
      }
    } catch (e) {
      console.error(
        `[plugin-state] shutdown snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }

    try {
      // Quit the audio engine backend (default Rust daemon; SC when opted out)
      const audioEngine = interpreter.audioEngine
      if (audioEngine && typeof audioEngine.quit === 'function') {
        await audioEngine.quit()
      }
    } catch (e) {
      // Ignore errors during shutdown
    }
  }
  process.exit(0)
}

/**
 * Register shutdown handlers
 *
 * This function registers SIGINT and SIGTERM handlers that will
 * gracefully shutdown the audio engine before exiting.
 *
 * @param getInterpreter - Function that returns the current interpreter instance
 *
 * @example
 * ```typescript
 * let globalInterpreter: InterpreterV2 | null = null
 * registerShutdownHandlers(() => globalInterpreter)
 * ```
 */
export function registerShutdownHandlers(getInterpreter: () => InterpreterV2 | null): void {
  process.on('SIGINT', async () => await shutdown(resolveShutdownInterpreter(getInterpreter)))
  process.on('SIGTERM', async () => await shutdown(resolveShutdownInterpreter(getInterpreter)))
}

/**
 * shutdown に渡す interpreter を解決する。
 *
 * 🔴 #607: 呼び出し元（`cli-audio.ts`）は `executeCommand()` の**戻り値**で
 * interpreter を保持するが、REPL / test など長時間モードでは `executeCommand()` が
 * **返らない**ため、その変数は永遠に `null` のままになる。その状態で SIGTERM を受けると
 * `shutdown(null)` となり `audioEngine.quit()` が一度も呼ばれず、**Rust daemon が孤児化**する
 * （実機で実測。孤児は coreaudiod の音声コンテキストを保持し続ける）。
 *
 * そのため、戻り値が無ければ**生成時に publish された registry**へフォールバックする。
 * 🔴 この `??` を外すと #607 が再発する。
 */
export function resolveShutdownInterpreter(
  getInterpreter: () => InterpreterV2 | null,
): InterpreterV2 | null {
  return getInterpreter() ?? getActiveInterpreter()
}
