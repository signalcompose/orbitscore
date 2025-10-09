/**
 * Statement processing for Interpreter V2
 * Handles global, sequence, and transport statements
 */

import {
  Statement,
  GlobalStatement,
  SequenceStatement,
  TransportStatement,
} from '../parser/audio-parser'

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
      await processGlobalStatement(statement, state)
      break
    case 'sequence':
      // Parser cannot distinguish between global and sequence at parse time
      // Determine the actual type here by checking state
      if (state.globals.has(statement.target)) {
        // It's actually a global statement
        await processGlobalStatement(statement as any, state)
      } else if (state.sequences.has(statement.target)) {
        // It's a sequence statement
        await processSequenceStatement(statement, state)
      } else {
        console.error(`Variable not found: ${statement.target}`)
      }
      break
    case 'transport':
      await processTransportStatement(statement, state)
      break
    default:
      // TypeScript should prevent this, but handle gracefully at runtime
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
  statement: GlobalStatement,
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
  statement: SequenceStatement,
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
  statement: TransportStatement,
  state: InterpreterState,
): Promise<void> {
  const target = statement.target
  const command = statement.command
  const sequenceNames = statement.sequences ?? []

  // Handle reserved keywords (RUN, LOOP, MUTE) with unidirectional toggle
  // Empty arguments are allowed (e.g., RUN() clears the RUN group)
  if (
    target === '__RESERVED_KEYWORD__' &&
    (command === 'run' || command === 'loop' || command === 'mute')
  ) {
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
    }
    return
  }

  // Handle global commands (e.g., g.start() where g is a global variable)
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
  // Validate all sequences exist before updating state
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ RUN(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  const newRunGroup = new Set(validSequences)
  const oldRunGroup = state.runGroup

  // Stop sequences that are no longer in RUN group (and not in LOOP group)
  for (const seqName of oldRunGroup) {
    if (!newRunGroup.has(seqName) && !state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.stop()
      }
    }
  }

  // Update RUN group with only valid sequences
  state.runGroup = newRunGroup

  // Execute run() on included sequences
  for (const seqName of validSequences) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      await sequence.run()
    }
  }
}

/**
 * Handle LOOP() command - unidirectional toggle (optimized with differential calculation)
 */
async function handleLoopCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Validate all sequences exist before updating state
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ LOOP(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  const newLoopGroup = new Set(validSequences)
  const oldLoopGroup = state.loopGroup

  // Calculate differential sets for efficient processing
  const toStop = [...oldLoopGroup].filter((name) => !newLoopGroup.has(name))
  const toStart = validSequences.filter((name) => !oldLoopGroup.has(name))
  const toContinue = validSequences.filter((name) => oldLoopGroup.has(name))

  // Stop sequences removed from LOOP group
  for (const seqName of toStop) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      sequence.stop()
    }
  }

  // Update LOOP group with only valid sequences
  state.loopGroup = newLoopGroup

  // Start new sequences
  for (const seqName of toStart) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      await sequence.loop()

      // Apply MUTE state (MUTE only affects LOOP)
      if (state.muteGroup.has(seqName)) {
        sequence.mute()
      } else {
        sequence.unmute()
      }
    }
  }

  // Update MUTE state for continuing sequences (no need to call loop() again)
  for (const seqName of toContinue) {
    const sequence = state.sequences.get(seqName)
    if (sequence) {
      // Only update MUTE state, don't restart loop
      if (state.muteGroup.has(seqName)) {
        sequence.mute()
      } else {
        sequence.unmute()
      }
    }
  }
}

/**
 * Handle MUTE() command - unidirectional toggle
 * MUTE is a persistent flag that only affects LOOP playback
 */
async function handleMuteCommand(sequenceNames: string[], state: InterpreterState): Promise<void> {
  // Validate all sequences exist before updating state
  const notFound: string[] = []
  const validSequences: string[] = []

  for (const seqName of sequenceNames) {
    if (state.sequences.has(seqName)) {
      validSequences.push(seqName)
    } else {
      notFound.push(seqName)
    }
  }

  // Warn about missing sequences
  if (notFound.length > 0) {
    console.warn(
      `⚠️ MUTE(): The following sequences do not exist and will be ignored: ${notFound.join(', ')}`,
    )
  }

  const newMuteGroup = new Set(validSequences)
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

  // Update MUTE group (persistent flag) with only valid sequences
  state.muteGroup = newMuteGroup

  // Mute sequences in MUTE group (only if they're in LOOP)
  for (const seqName of validSequences) {
    if (state.loopGroup.has(seqName)) {
      const sequence = state.sequences.get(seqName)
      if (sequence) {
        sequence.mute()
      }
    }
  }
}
