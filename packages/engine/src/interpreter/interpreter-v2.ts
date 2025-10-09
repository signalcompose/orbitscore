/**
 * Interpreter V2 for OrbitScore Audio DSL
 * Object-oriented implementation with proper class instantiation
 *
 * @deprecated This class is now a thin wrapper around the interpreter modules.
 * For new code, consider using the modules directly from './interpreter/'.
 */

import { AudioIR } from '../parser/audio-parser'
import { SuperColliderPlayer } from '../audio/supercollider-player'

import { InterpreterState } from './types'
import { processGlobalInit, processSequenceInit } from './process-initialization'
import { processStatement } from './process-statement'

/**
 * Interpreter V2 - Object-oriented approach
 *
 * This class serves as a backward compatibility wrapper around the new
 * interpreter modules. For new code, consider using the modules directly.
 */
export class InterpreterV2 {
  private state: InterpreterState

  constructor() {
    this.state = {
      audioEngine: new SuperColliderPlayer(),
      globals: new Map(),
      sequences: new Map(),
      currentGlobal: undefined,
      isBooted: false,
      // Initialize unidirectional toggle groups
      runGroup: new Set(),
      loopGroup: new Set(),
      muteGroup: new Set(),
    }
  }

  /**
   * Boot SuperCollider server (public method for explicit boot)
   */
  async boot(audioDevice?: string): Promise<void> {
    if (!this.state.isBooted) {
      await this.state.audioEngine.boot(audioDevice)
      this.state.isBooted = true
    }
  }

  /**
   * Boot SuperCollider server (ensure it's booted)
   */
  private async ensureBooted(): Promise<void> {
    await this.boot()
  }

  /**
   * Execute parsed IR
   */
  async execute(ir: AudioIR): Promise<void> {
    // Ensure SuperCollider is booted
    await this.ensureBooted()

    // Process global initialization
    if (ir.globalInit) {
      await processGlobalInit(ir.globalInit, this.state)
    }

    // Process sequence initializations
    for (const seqInit of ir.sequenceInits) {
      await processSequenceInit(seqInit, this.state)
    }

    // Process statements
    for (const statement of ir.statements) {
      await processStatement(statement, this.state)
    }
  }

  /**
   * Get state for testing/debugging
   */
  getState() {
    const state: any = {
      globals: {},
      sequences: {},
    }

    // Convert Map to plain object for easier inspection
    for (const [name, global] of this.state.globals.entries()) {
      state.globals[name] = global.getState()
    }

    for (const [name, sequence] of this.state.sequences.entries()) {
      state.sequences[name] = sequence.getState()
    }

    return state
  }

  /**
   * Get audio engine for testing/debugging
   * @deprecated Direct access to audioEngine. Use getState() instead.
   */
  get audioEngine(): SuperColliderPlayer {
    return this.state.audioEngine
  }
}

/**
 * Factory function to create a new interpreter instance
 *
 * @returns New InterpreterV2 instance
 *
 * @example
 * ```typescript
 * const interpreter = createInterpreter()
 * await interpreter.boot()
 * await interpreter.execute(ir)
 * ```
 */
export function createInterpreter(): InterpreterV2 {
  return new InterpreterV2()
}
