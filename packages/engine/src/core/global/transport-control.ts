/**
 * Transport control for Global class
 */

import { Scheduler } from './types'

export class TransportControl {
  private _isRunning: boolean = false
  private _isLooping: boolean = false
  private globalScheduler: Scheduler
  private sequences: Map<string, any>

  constructor(globalScheduler: Scheduler, sequences: Map<string, any>) {
    this.globalScheduler = globalScheduler
    this.sequences = sequences
  }

  // Transport control methods
  run(): this {
    // If already running, do nothing (idempotent)
    if (this._isRunning) {
      return this
    }

    this._isRunning = true

    // Start the global scheduler (will restart if needed)
    this.globalScheduler.start()
    console.log('✅ Global running')

    return this
  }

  loop(): this {
    if (!this._isLooping) {
      this._isLooping = true
      this._isRunning = true
      // Global: loop
    }
    return this
  }

  stop(): this {
    // Stop all sequences first
    for (const [, sequence] of this.sequences.entries()) {
      sequence.stop()
    }

    // Stop the scheduler
    this.globalScheduler.stopAll()

    // Stop transport
    if (this._isRunning) {
      this._isRunning = false
      this._isLooping = false
      console.log('✅ Global stopped')
    }
    return this
  }

  // Get current state
  getState() {
    return {
      isRunning: this._isRunning,
      isLooping: this._isLooping,
    }
  }
}
