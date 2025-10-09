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
 * Process transport commands with unidirectional toggle (DSL v3.0)
 *
 * Implements片記号方式 (unidirectional toggle):
 * - RUN(kick, snare): Include only kick and snare in RUN group
 * - LOOP(hat): Include only hat in LOOP group, stop others
 * - MUTE(kick): Set kick's MUTE flag ON, others OFF (applies only to LOOP)
 *
 * @param statement - Transport statement IR
 * @param state - Interpreter state
 */
export async function processTransportStatement(
  statement: any,
  state: InterpreterState,
): Promise<void> {
  const target = statement.target
  const command = statement.command
  const sequenceNames = statement.sequences ?? []

  // Handle reserved keywords (RUN, LOOP, MUTE) with unidirectional toggle
  if (target === 'global' && sequenceNames.length > 0) {
    switch (command) {
      case 'run':
        await handleRunCommand(sequenceNames, state)
        break

      case 'loop':
        await handleLoopCommand(sequenceNames, state)
        break

      case 'mute':
        await handleMuteCommand(sequenceNames, state)
        break

      default:
        console.warn(`Unknown reserved keyword: ${command}`)
    }
    return
  }

  // Handle global commands (e.g., global.start())
  const global = state.globals.get(target)
  if (global) {
    switch (command) {
      case 'start':
        await callMethod(global, 'start', [])
        break

      case 'stop':
        await callMethod(global, 'stop', [])
        break

      case 'loop':
        await callMethod(global, 'loop', [])
        break

      default:
        console.warn(`Unknown global transport command: ${command}`)
    }
    return
  }

  // Handle sequence commands (e.g., kick.run())
  const sequence = state.sequences.get(target)
  if (sequence) {
    await callMethod(sequence, command, [])
    return
  }

  console.error(`Transport target not found: ${target}`)
}

/**
 * Handle RUN() command - unidirectional toggle
 */
async function handleRunCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Update RUN group
  state.runGroup = new Set(sequenceNames)

  // Execute run() on included sequences
  for (const seqName of sequenceNames) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      await sequence.run()
    } else {
      console.error(`Sequence not found: ${seqName}`)
    }
  }
}

/**
 * Handle LOOP() command - unidirectional toggle
 */
async function handleLoopCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  const newLoopGroup = new Set(sequenceNames)
  const oldLoopGroup = state.loopGroup

  // Stop sequences that are no longer in LOOP group
  for (const seqName of oldLoopGroup) {
    if (!newLoopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.stop()
      }
    }
  }

  // Update LOOP group
  state.loopGroup = newLoopGroup

  // Execute loop() on included sequences
  for (const seqName of sequenceNames) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      await sequence.loop()

      // Apply MUTE state (MUTE only affects LOOP)
      if (state.muteGroup.has(seqName)) {
        sequence.mute()
      } else {
        sequence.unmute()
      }
    } else {
      console.error(`Sequence not found: ${seqName}`)
    }
  }
}

/**
 * Handle MUTE() command - unidirectional toggle
 * MUTE is a persistent flag that only affects LOOP playback
 */
async function handleMuteCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  const newMuteGroup = new Set(sequenceNames)
  const oldMuteGroup = state.muteGroup

  // Unmute sequences that are no longer in MUTE group (only if they're in LOOP)
  for (const seqName of oldMuteGroup) {
    if (!newMuteGroup.has(seqName) && state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.unmute()
      }
    }
  }

  // Update MUTE group (persistent flag)
  state.muteGroup = newMuteGroup

  // Mute sequences in MUTE group (only if they're in LOOP)
  for (const seqName of sequenceNames) {
    if (state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.mute()
      }
    }
  }
}
