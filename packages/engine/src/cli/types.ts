/**
 * CLI type definitions
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'

/**
 * Parsed command line arguments
 */
export interface ParsedArguments {
  command: string | undefined
  file: string | undefined
  durationArg: string | undefined
  audioDevice: string | undefined
  debugMode: boolean
}

/**
 * Options for play mode
 */
export interface PlayOptions {
  filepath: string
  durationSeconds?: number
  globalInterpreter?: InterpreterV2 | null
}

/**
 * Options for REPL mode
 */
export interface REPLOptions {
  audioDevice?: string
}

/**
 * Result of play mode execution
 */
export interface PlayResult {
  interpreter: InterpreterV2
  shouldStartREPL: boolean
}
