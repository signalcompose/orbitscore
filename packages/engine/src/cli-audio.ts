#!/usr/bin/env node

/**
 * Audio-based CLI for OrbitScore
 * Executes .osc files and plays audio
 *
 * This is a thin wrapper around the CLI modules in ./cli/
 * For backward compatibility, this file is kept as the main entry point.
 */

import { InterpreterV2 } from './interpreter/interpreter-v2'
import { parseArguments, setGlobalDebugFlag, executeCommand, registerShutdownHandlers } from './cli'

// Shared interpreter instance for REPL mode
let globalInterpreter: InterpreterV2 | null = null

// Register shutdown handlers
registerShutdownHandlers(() => globalInterpreter)

// Main
async function main() {
  // Parse command line arguments
  const args = parseArguments(process.argv.slice(2))

  // Set global debug flag
  setGlobalDebugFlag(args.debugMode)

  // Execute command
  const interpreter = await executeCommand(args, globalInterpreter)
  if (interpreter) {
    globalInterpreter = interpreter
  }
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
