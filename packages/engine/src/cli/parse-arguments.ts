/**
 * Command line argument parser
 */

import { ParsedArguments } from './types'

/**
 * Parse command line arguments
 *
 * Extracts command, file path, duration, audio device, and debug mode
 * from process.argv.
 *
 * @param args - Command line arguments (typically process.argv.slice(2))
 * @returns Parsed arguments object
 *
 * @example
 * ```typescript
 * const args = parseArguments(process.argv.slice(2))
 * console.log(args.command) // 'play'
 * console.log(args.file) // 'examples/01_getting_started.osc'
 * console.log(args.durationArg) // '5'
 * ```
 */
export function parseArguments(args: string[]): ParsedArguments {
  const command = args[0]

  let audioDevice: string | undefined
  let file: string | undefined
  let durationArg: string | undefined
  let debugMode: boolean = false

  // Parse options and positional arguments
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--audio-device' && args[i + 1]) {
      audioDevice = args[i + 1]
      i++ // Skip next arg
    } else if (args[i] === '--debug') {
      debugMode = true
    } else if (!file) {
      file = args[i]
    } else if (!durationArg) {
      durationArg = args[i]
    }
  }

  return {
    command,
    file,
    durationArg,
    audioDevice,
    debugMode,
  }
}

/**
 * Set global debug flag
 *
 * This function sets a global flag that can be accessed by other modules
 * to enable debug logging.
 *
 * @param debugMode - Whether debug mode is enabled
 */
export function setGlobalDebugFlag(debugMode: boolean): void {
  ;(globalThis as any).ORBITSCORE_DEBUG = debugMode
}
