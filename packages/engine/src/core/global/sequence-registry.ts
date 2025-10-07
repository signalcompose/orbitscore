/**
 * Sequence registry management for Global class
 */

import { Sequence } from '../sequence'

export class SequenceRegistry {
  private sequences: Map<string, Sequence> = new Map()
  private audioEngine: any // Can be AudioEngine or SuperColliderPlayer
  private globalInstance: any // Reference to Global instance for sequence creation

  constructor(audioEngine: any, globalInstance: any) {
    this.audioEngine = audioEngine
    this.globalInstance = globalInstance
  }

  // Sequence creation - DSL: var seq = init global.seq
  get seq(): Sequence {
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
