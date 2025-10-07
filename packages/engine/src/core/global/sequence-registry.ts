/**
 * Sequence registry management for Global class
 */

import type { AudioEngine } from '../../audio/types'
import { Sequence } from '../sequence'

// Forward declaration to avoid circular dependency
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GlobalInstance = any

export class SequenceRegistry {
  private sequences: Map<string, Sequence> = new Map()
  private audioEngine: AudioEngine
  private globalInstance: GlobalInstance // Reference to Global instance for sequence creation

  constructor(audioEngine: AudioEngine, globalInstance: GlobalInstance) {
    this.audioEngine = audioEngine
    this.globalInstance = globalInstance
  }

  // Sequence creation - DSL: var seq = init global.seq
  get seq(): Sequence {
    // Type assertion needed because Sequence expects AudioEngine
    // but we use AudioEngine interface to avoid circular dependency
    const sequence = new Sequence(this.globalInstance, this.audioEngine)
    return sequence
  }

  // Register a sequence (called by Sequence constructor)
  registerSequence(name: string, sequence: Sequence): void {
    this.sequences.set(name, sequence)
  }

  // Get sequence by name
  getSequence(name: string): Sequence | undefined {
    return this.sequences.get(name)
  }

  // Get all sequences (for transport control)
  getAllSequences(): Map<string, Sequence> {
    return this.sequences
  }
}
