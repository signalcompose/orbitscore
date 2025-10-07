/**
 * Command execution logic
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'

import { ParsedArguments } from './types'
import { playFile } from './play-mode'
import { startREPLMode, startREPL } from './repl-mode'
import { playTestSound } from './test-sound'

/**
 * Print usage information
 */
export function printUsage(): void {
  console.log(`
OrbitScore Audio Engine CLI

Usage:
  orbitscore-audio play <file.osc> [duration]  - Play an OrbitScore file (optional duration in seconds)
  orbitscore-audio repl                         - Start REPL mode for live coding
  orbitscore-audio eval <file.osc>              - Evaluate a file in persistent mode
  orbitscore-audio test                         - Run test sound
  orbitscore-audio help                         - Show this help

Examples:
  orbitscore-audio play examples/01_getting_started.osc     - Play until completion
  orbitscore-audio play examples/01_getting_started.osc 5   - Play for 5 seconds then stop
  orbitscore-audio repl                                      - Start live coding REPL
  orbitscore-audio test
`)
}

/**
 * Execute CLI command
 *
 * This function routes the command to the appropriate handler based on
 * the parsed arguments.
 *
 * @param args - Parsed command line arguments
 * @param globalInterpreter - Shared interpreter instance (for REPL persistence)
 * @returns Updated interpreter instance (may be null)
 *
 * @example
 * ```typescript
 * const args = parseArguments(process.argv.slice(2))
 * await executeCommand(args, null)
 * ```
 */
export async function executeCommand(
  args: ParsedArguments,
  globalInterpreter: InterpreterV2 | null,
): Promise<InterpreterV2 | null> {
  const { command, file, durationArg, audioDevice } = args

  switch (command) {
    case 'play': {
      if (!file) {
        console.error('Please specify a file to play')
        printUsage()
        process.exit(1)
      }
      try {
        const playDuration = durationArg ? parseFloat(durationArg) : undefined
        const result = await playFile({
          filepath: file,
          durationSeconds: playDuration,
          globalInterpreter,
        })
        if (result.shouldStartREPL) {
          await startREPL(result.interpreter)
        }
        return result.interpreter
      } catch (error: any) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      break
    }

    case 'run': {
      if (!file) {
        console.error('Please specify a file to run')
        printUsage()
        process.exit(1)
      }
      try {
        const runDuration = durationArg ? parseFloat(durationArg) : undefined
        const result = await playFile({
          filepath: file,
          durationSeconds: runDuration,
          globalInterpreter,
        })
        if (result.shouldStartREPL) {
          await startREPL(result.interpreter)
        }
        return result.interpreter
      } catch (error: any) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      break
    }

    case 'repl': {
      // Start REPL mode without requiring a file
      // Note: startREPLMode() returns Promise<never>, so this never returns
      await startREPLMode({ audioDevice })
      break
    }

    case 'eval': {
      if (!file) {
        console.error('Please specify a file to evaluate')
        printUsage()
        process.exit(1)
      }
      try {
        const evalDuration = durationArg ? parseFloat(durationArg) : undefined
        const result = await playFile({
          filepath: file,
          durationSeconds: evalDuration,
          globalInterpreter,
        })
        if (result.shouldStartREPL) {
          await startREPL(result.interpreter)
        }
        return result.interpreter
      } catch (error: any) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
      }
      break
    }

    case 'test':
      await playTestSound()
      // Never reached - playTestSound() returns Promise<never>
      break

    case 'help':
    case undefined:
      printUsage()
      return null

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }

  // This line is technically unreachable but satisfies TypeScript's type checker
  return null
}
