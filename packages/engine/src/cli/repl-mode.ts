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

  let buffer = ''
  let emptyLineCount = 0

  rl.on('line', async (line) => {
    if (process.env.ORBITSCORE_DEBUG) {
      console.log(`[DEBUG] Received line (length=${line.length}): ${JSON.stringify(line)}`)
      console.log(`[DEBUG] Buffer length before: ${buffer.length}`)
    }

    // If we receive an empty line, increment counter
    if (line.trim() === '') {
      emptyLineCount++
      buffer += '\n'

      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`[DEBUG] Empty line detected, count=${emptyLineCount}`)
      }

      // If we get 2+ consecutive empty lines, treat buffer as complete and execute
      if (emptyLineCount >= 2 && buffer.trim()) {
        if (process.env.ORBITSCORE_DEBUG) {
          console.log(`[DEBUG] Forcing execution due to 2+ empty lines`)
        }
        await executeBuffer()
      }
      return
    }

    // Reset empty line counter and add line to buffer
    emptyLineCount = 0
    buffer += line + '\n'

    if (process.env.ORBITSCORE_DEBUG) {
      console.log(`[DEBUG] Buffer length after: ${buffer.length}`)
      console.log(`[DEBUG] Attempting to parse buffer...`)
    }

    // Try to parse and execute the buffer
    // If parsing fails due to incomplete input, keep buffering
    try {
      const ir = parseAudioDSL(buffer.trim())
      await interpreter.execute(ir)
      console.log('✓') // Success indicator
      buffer = '' // Reset buffer on success
      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`[DEBUG] Parse success, buffer cleared`)
      }
    } catch (error: any) {
      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`[DEBUG] Parse error: ${error.message}`)
      }
      // If error is about EOF or incomplete input, keep buffering
      if (
        error.message.includes('EOF') ||
        error.message.includes('Expected RPAREN') ||
        error.message.includes('Expected comma or closing parenthesis')
      ) {
        if (process.env.ORBITSCORE_DEBUG) {
          console.log(`[DEBUG] Incomplete input, continuing to buffer`)
        }
        // Continue buffering
        return
      }
      // For other errors, report and reset buffer
      console.error(`[ERROR] ${error.message}`)
      buffer = ''
      if (process.env.ORBITSCORE_DEBUG) {
        console.log(`[DEBUG] Fatal parse error, buffer cleared`)
      }
    }
  })

  async function executeBuffer() {
    const code = buffer.trim()
    if (!code) {
      buffer = ''
      emptyLineCount = 0
      return
    }

    try {
      const ir = parseAudioDSL(code)
      await interpreter.execute(ir)
      console.log('✓') // Success indicator
    } catch (error: any) {
      console.error(`[ERROR] ${error.message}`)
    }

    buffer = ''
    emptyLineCount = 0
  }

  // Keep process alive indefinitely for interactive REPL
  // This is intentional: REPL mode is designed to run continuously,
  // listening for user input on stdin until the user terminates with Ctrl+C.
  // The readline interface will continue to emit 'line' events as long as
  // the process is alive. The shutdown handlers in shutdown.ts will handle
  // graceful termination of SuperCollider when the user exits.
  // Note: This promise never resolves, which is the expected behavior.
  await new Promise(() => {})
}
