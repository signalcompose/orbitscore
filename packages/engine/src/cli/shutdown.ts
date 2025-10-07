/**
 * Graceful shutdown handling
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'

/**
 * Gracefully shutdown the audio engine
 *
 * This function attempts to quit the SuperCollider server cleanly
 * before exiting the process. It's called on SIGINT (Ctrl+C) and SIGTERM.
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
    try {
      // Quit SuperCollider server
      const audioEngine = (interpreter as any).audioEngine
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
  process.on('SIGINT', () => shutdown(getInterpreter()))
  process.on('SIGTERM', () => shutdown(getInterpreter()))
}
