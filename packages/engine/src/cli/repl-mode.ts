/**
 * REPL (Read-Eval-Print Loop) mode for live coding
 */

import * as readline from 'readline'

import { InterpreterV2 } from '../interpreter/interpreter-v2'
import { parseAudioDSL } from '../parser/audio-parser'

import { REPLOptions } from './types'

/**
 * Start REPL mode for live coding
 *
 * This function creates a new interpreter, boots SuperCollider,
 * and starts an interactive REPL where users can enter OrbitScore
 * commands line by line.
 *
 * @param options - REPL options (audio device, etc.)
 * @returns Never resolves (keeps process alive)
 *
 * @example
 * ```typescript
 * await startREPLMode({ audioDevice: 'Built-in Output' })
 * ```
 */
export async function startREPLMode(options: REPLOptions = {}): Promise<void> {
  console.log('🎵 OrbitScore Audio Engine')
  console.log('✅ Initialized')

  // Create a global interpreter
  const globalInterpreter = new InterpreterV2()

  // Boot SuperCollider once at startup with optional audio device
  await globalInterpreter.boot(options.audioDevice)

  console.log('🎵 Live coding mode')
  await startREPL(globalInterpreter)
}

/**
 * Start REPL with an existing interpreter
 *
 * This function creates a readline interface and listens for user input.
 * Each line is parsed as OrbitScore DSL and executed by the interpreter.
 *
 * @param interpreter - Existing interpreter instance
 * @returns Never resolves (keeps process alive)
 */
export async function startREPL(interpreter: InterpreterV2): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', async (line) => {
    const code = line.trim()
    if (!code) return

    try {
      // Parse and execute the single line command
      const ir = parseAudioDSL(code)
      await interpreter.execute(ir)
      console.log('✓') // Success indicator
    } catch (error: any) {
      console.error(`[ERROR] ${error.message}`)
    }
  })

  // Keep process alive indefinitely for interactive REPL
  // This is intentional: REPL mode is designed to run continuously,
  // listening for user input on stdin until the user terminates with Ctrl+C.
  // The readline interface will continue to emit 'line' events as long as
  // the process is alive. The shutdown handlers in shutdown.ts will handle
  // graceful termination of SuperCollider when the user exits.
  // Note: This promise never resolves, which is the expected behavior.
  await new Promise(() => {})
}
