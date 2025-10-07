/**
 * Play mode - Execute OrbitScore files
 */

import * as fs from 'fs'

import { InterpreterV2 } from '../interpreter/interpreter-v2'
import { parseAudioDSL } from '../parser/audio-parser'

import { PlayOptions, PlayResult } from './types'

/**
 * Play an OrbitScore file
 *
 * This function reads a .osc file, parses it, and executes it using
 * the interpreter. It supports both one-shot playback and timed execution
 * with auto-exit.
 *
 * @param options - Play options (filepath, duration, existing interpreter)
 * @returns Play result with interpreter and REPL flag
 *
 * @example
 * ```typescript
 * // One-shot playback
 * const result = await playFile({ filepath: 'examples/01_getting_started.osc' })
 *
 * // Timed execution (5 seconds)
 * await playFile({ filepath: 'examples/01_getting_started.osc', durationSeconds: 5 })
 * ```
 */
export async function playFile(options: PlayOptions): Promise<PlayResult> {
  const { filepath, durationSeconds, globalInterpreter } = options

  // Check if file exists
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`)
  }

  // Read the DSL file
  const source = fs.readFileSync(filepath, 'utf8')

  // Parse the DSL
  const ir = parseAudioDSL(source)

  // Create interpreter only if not already exists (for REPL persistence)
  let interpreter = globalInterpreter
  if (!interpreter) {
    console.log('🆕 Creating new interpreter')
    interpreter = new InterpreterV2()
  } else {
    console.log('♻️ Reusing existing interpreter')
  }

  await interpreter.execute(ir)

  // Get final state
  const state = interpreter.getState()

  // Check if global.run() was called
  const hasRunningGlobal = Object.values(state.globals).some((g: any) => g.isRunning)

  if (durationSeconds !== undefined && interpreter) {
    // Timed execution mode with auto-exit when all sequences finish
    startTimedExecution(interpreter, durationSeconds)
    return { interpreter, shouldStartREPL: false }
  } else if (hasRunningGlobal) {
    // Interactive REPL mode (only if no duration specified)
    console.log('🎵 Live coding mode')
    return { interpreter, shouldStartREPL: true }
  } else {
    // One-shot mode
    const isPlaying = Object.values(state.sequences).some((s: any) => s.isPlaying)
    if (isPlaying) {
      // Keep process alive
      setInterval(() => {}, 1000)
    }
    return { interpreter, shouldStartREPL: false }
  }
}

/**
 * Start timed execution with auto-exit
 *
 * This function monitors the playback state and exits the process
 * when all sequences finish or the maximum wait time is reached.
 *
 * @param interpreter - Interpreter instance
 * @param durationSeconds - Maximum duration in seconds
 */
function startTimedExecution(interpreter: InterpreterV2, durationSeconds: number): void {
  const maxWaitTime = durationSeconds * 1000
  const startTime = Date.now()

  const checkInterval = setInterval(() => {
    const currentState = interpreter.getState()
    const isAnyPlaying = Object.values(currentState.sequences).some((s: any) => s.isPlaying)
    const elapsed = Date.now() - startTime

    if (!isAnyPlaying || elapsed >= maxWaitTime) {
      clearInterval(checkInterval)
      console.log('✅ Playback finished')
      process.exit(0)
    }
  }, 100) // Check every 100ms
}
