/**
 * Global class for OrbitScore
 * Represents the global transport and configuration
 */

import { Transport } from '../transport/transport'
import { AudioEngine } from '../audio/audio-engine'
import { PrecisionScheduler } from '../audio/precision-scheduler'

import { Sequence } from './sequence'

export interface Meter {
  numerator: number
  denominator: number
}

export class Global {
  private _tempo: number = 120
  private _tick: number = 480
  private _beat: Meter = { numerator: 4, denominator: 4 }
  private _key: string = 'C'
  private _isRunning: boolean = false
  private _isLooping: boolean = false

  private sequences: Map<string, Sequence> = new Map()
  private transport: Transport
  private audioEngine: AudioEngine
  private globalScheduler: PrecisionScheduler

  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
    this.transport = new Transport(audioEngine)
    this.globalScheduler = new PrecisionScheduler()
  }

  // Property accessors with method chaining
  tempo(value?: number): number | this {
    if (value === undefined) {
      return this._tempo
    }
    this._tempo = value
    this.transport.setGlobalTempo(value)
    return this
  }

  tick(value?: number): number | this {
    if (value === undefined) {
      return this._tick
    }
    this._tick = value
    this.transport.setTickResolution(value)
    return this
  }

  beat(numerator: number, denominator: number): this {
    this._beat = { numerator, denominator }
    this.transport.setGlobalMeter(this._beat)
    return this
  }

  key(value?: string): string | this {
    if (value === undefined) {
      return this._key
    }
    this._key = value
    return this
  }

  // Transport control methods
  run(): this {
    if (!this._isRunning) {
      this._isRunning = true
      this.transport.start()

      // Start all registered sequences (they will add events to the global scheduler)
      for (const [name, sequence] of this.sequences) {
        sequence.scheduleEvents(this.globalScheduler)
        console.log(`Started sequence: ${name}`)
      }

      // Start the global scheduler for synchronized playback
      this.globalScheduler.start()

      console.log('Global transport started')
    }
    return this
  }

  loop(): this {
    if (!this._isLooping) {
      this._isLooping = true
      this._isRunning = true
      this.transport.start()
      console.log('Global transport looping')
    }
    return this
  }

  stop(): this {
    if (this._isRunning) {
      this._isRunning = false
      this._isLooping = false
      this.transport.stop()
      console.log('Global transport stopped')
    }
    return this
  }

  // Sequence creation - DSL: var seq = init global.seq
  get seq(): Sequence {
    const sequence = new Sequence(this, this.audioEngine)
    return sequence
  }

  // Register a sequence (called by Sequence constructor)
  registerSequence(name: string, sequence: Sequence): void {
    this.sequences.set(name, sequence)
    // Also register with transport
    this.transport.addSequence({
      id: name,
      slices: [],
      loop: false,
      muted: false,
      state: 'stopped',
    })
  }

  // Get sequence by name
  getSequence(name: string): Sequence | undefined {
    return this.sequences.get(name)
  }

  // Get internal state for compatibility
  getState() {
    return {
      tempo: this._tempo,
      tick: this._tick,
      beat: this._beat,
      key: this._key,
      isRunning: this._isRunning,
      isLooping: this._isLooping,
    }
  }

  // Get transport for internal use
  getTransport(): Transport {
    return this.transport
  }
}

// Export a singleton factory
export function createGlobal(audioEngine: AudioEngine): Global {
  return new Global(audioEngine)
}
