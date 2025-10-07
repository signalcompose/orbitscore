/**
 * Statement processing for Interpreter V2
 * Handles global, sequence, and transport statements
 */

import { Statement } from '../parser/audio-parser'

import { InterpreterState } from './types'
import { callMethod } from './evaluate-method'

/**
 * Process a statement
 *
 * Routes the statement to the appropriate handler based on its type.
 *
 * @param statement - Statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processStatement(
 *   { type: 'global', target: 'global', method: 'tempo', args: [120] },
 *   state
 * )
 * ```
 */
export async function processStatement(
  statement: Statement,
  state: InterpreterState,
): Promise<void> {
  switch (statement.type) {
    case 'global':
      await processGlobalStatement(statement as any, state)
      break
    case 'sequence':
      await processSequenceStatement(statement as any, state)
      break
    case 'transport':
      await processTransportStatement(statement as any, state)
      break
    default:
      console.warn(`Unknown statement type: ${(statement as any).type}`)
  }
}

/**
 * Process global method calls
 *
 * Executes method calls on a Global instance, including chained methods.
 *
 * @param statement - Global statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processGlobalStatement(
 *   { type: 'global', target: 'global', method: 'tempo', args: [120], chain: [] },
 *   state
 * )
 * ```
 */
export async function processGlobalStatement(
  statement: any,
  state: InterpreterState,
): Promise<void> {
  const global = state.globals.get(statement.target)
  if (!global) {
    console.error(`Global instance not found: ${statement.target}`)
    return
  }

  // Start with the global object
  let result: any = global

  // Process the main method
  result = await callMethod(result, statement.method, statement.args)

  // Process any chained methods
  if (statement.chain) {
    for (const chainedCall of statement.chain) {
      result = await callMethod(result, chainedCall.method, chainedCall.args)
    }
  }
}

/**
 * Process sequence method calls
 *
 * Executes method calls on a Sequence instance, including chained methods.
 *
 * @param statement - Sequence statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processSequenceStatement(
 *   { type: 'sequence', target: 'kick', method: 'audio', args: ['kick.wav'], chain: [] },
 *   state
 * )
 * ```
 */
export async function processSequenceStatement(
  statement: any,
  state: InterpreterState,
): Promise<void> {
  const sequence = state.sequences.get(statement.target)
  if (!sequence) {
    console.error(`Sequence instance not found: ${statement.target}`)
    return
  }

  // Start with the sequence object
  let result: any = sequence

  // Process the main method
  result = await callMethod(result, statement.method, statement.args)

  // Process any chained methods
  if (statement.chain) {
    for (const chainedCall of statement.chain) {
      result = await callMethod(result, chainedCall.method, chainedCall.args)
    }
  }
}

/**
 * Process transport commands
 *
 * Executes transport commands (run, stop, loop, etc.) on Global or Sequence instances.
 *
 * @param statement - Transport statement IR
 * @param state - Interpreter state
 *
 * @example
 * ```typescript
 * await processTransportStatement(
 *   { type: 'transport', target: 'global', command: 'run' },
 *   state
 * )
 * ```
 */
export async function processTransportStatement(
  statement: any,
  state: InterpreterState,
): Promise<void> {
  // Transport commands can be on global or sequence
  const target = statement.target

  // Check if it's a global
  const global = state.globals.get(target)
  if (global) {
    await callMethod(global, statement.command, [])
    return
  }

  // Check if it's a sequence
  const sequence = state.sequences.get(target)
  if (sequence) {
    await callMethod(sequence, statement.command, [])
    return
  }

  console.error(`Transport target not found: ${target}`)
}
