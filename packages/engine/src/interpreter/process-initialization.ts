/**
 * Initialization processing for Interpreter V2
 * Handles global and sequence initialization
 */

import { GlobalInit, SequenceInit } from '../parser/audio-parser'
import { Global } from '../core/global'

import { InterpreterState } from './types'

/**
 * Process global initialization
 *
 * Creates or reuses a Global instance for REPL persistence.
 *
 * @param init - Global initialization IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processGlobalInit(
 *   { type: 'global_init', variableName: 'global' },
 *   state
 * )
 * ```
 */
export async function processGlobalInit(init: GlobalInit, state: InterpreterState): Promise<void> {
  // Reuse existing global if it exists (for REPL persistence)
  let globalInstance = state.globals.get(init.variableName)

  if (!globalInstance) {
    globalInstance = new Global(state.audioEngine)
    state.globals.set(init.variableName, globalInstance)
  }

  state.currentGlobal = globalInstance
}

/**
 * Process sequence initialization
 *
 * Creates or reuses a Sequence instance for REPL persistence.
 * Supports both new syntax (init global.seq) and legacy syntax (init GLOBAL.seq).
 *
 * @param init - Sequence initialization IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processSequenceInit(
 *   { type: 'sequence_init', variableName: 'kick', globalVariable: 'global' },
 *   state
 * )
 * ```
 */
export async function processSequenceInit(
  init: SequenceInit,
  state: InterpreterState,
): Promise<void> {
  let global: Global | undefined

  // If globalVariable is specified (new syntax: init global.seq)
  if (init.globalVariable) {
    global = state.globals.get(init.globalVariable)
    if (!global) {
      console.error(`Global instance not found: ${init.globalVariable}`)
      return
    }
  } else {
    // Legacy syntax: init GLOBAL.seq
    global = state.currentGlobal
    if (!global) {
      console.error('No global instance available for sequence initialization')
      return
    }
  }

  // Reuse existing sequence if it exists (for REPL persistence)
  let sequence = state.sequences.get(init.variableName)

  if (!sequence) {
    // Create sequence through the Global's factory method
    sequence = global.seq
    sequence!.setName(init.variableName)
    state.sequences.set(init.variableName, sequence!)
  } else {
    // Reset parameters to defaults when re-initializing
    // This prevents previous live changes (gain/pan) from persisting
    ;(sequence as any)._gainDb = 0 // Reset to 0 dB
    ;(sequence as any)._pan = 0 // Reset to center
  }
}
