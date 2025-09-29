/**
 * Transport System for OrbitScore
 * Handles real-time scheduling, bar quantization, and polymeter support
 */

import { AudioEngine, AudioSlice } from '../audio/audio-engine'

/**
 * Time signature (meter)
 */
export interface Meter {
  numerator: number
  denominator: number
}

/**
 * Transport position
 */
export interface TransportPosition {
  bar: number // Current bar (1-indexed)
  beat: number // Current beat within bar (1-indexed)
  tick: number // Current tick within beat
  absoluteTicks: number // Total ticks from start
}

/**
 * Transport state
 */
export type TransportState = 'stopped' | 'playing' | 'scheduled' | 'looping'

/**
 * Sequence definition for transport
 */
export interface TransportSequence {
  id: string
  slices: AudioSlice[]
  tempo?: number // Override global tempo
  meter?: Meter // Override global meter
  startBar?: number // When to start (bar number)
  length?: number // Length in bars
  loop: boolean // Whether to loop
  muted: boolean // Whether muted
  state: TransportState
}

/**
 * Transport event
 */
export interface TransportEvent {
  type: 'start' | 'stop' | 'loop' | 'jump'
  sequenceId?: string
  targetBar?: number
  immediate: boolean
}

/**
 * Main transport class
 */
export class Transport {
  private audioEngine: AudioEngine
  private isRunning: boolean = false
  private startTime: number = 0
  private pausedTime: number = 0

  // Global settings
  private globalTempo: number = 120
  private globalMeter: Meter = { numerator: 4, denominator: 4 }
  private ticksPerQuarter: number = 480

  // Current position
  private currentPosition: TransportPosition = {
    bar: 1,
    beat: 1,
    tick: 0,
    absoluteTicks: 0,
  }

  // Sequences
  private sequences: Map<string, TransportSequence> = new Map()

  // Scheduling
  private schedulerInterval: NodeJS.Timeout | null = null
  private lookAheadTime: number = 100 // ms
  private scheduleInterval: number = 25 // ms
  private nextNoteTime: number = 0

  // Event queue
  private eventQueue: TransportEvent[] = []

  constructor(audioEngine: AudioEngine) {
    this.audioEngine = audioEngine
  }

  /**
   * Set global tempo
   */
  setTempo(bpm: number): void {
    this.globalTempo = Math.max(20, Math.min(999, bpm))
  }

  setGlobalTempo(bpm: number): void {
    this.setTempo(bpm)
  }

  /**
   * Set global meter
   */
  setMeter(meter: Meter): void {
    this.globalMeter = meter
  }

  setGlobalMeter(meter: Meter): void {
    this.setMeter(meter)
  }

  /**
   * Set tick resolution
   */
  setTickResolution(ticks: number): void {
    this.ticksPerQuarter = ticks
  }

  /**
   * Add a sequence to the transport
   */
  addSequence(sequence: TransportSequence): void {
    this.sequences.set(sequence.id, sequence)
  }

  /**
   * Update a sequence in the transport
   */
  updateSequence(sequence: TransportSequence): void {
    const existing = this.sequences.get(sequence.id)
    if (existing) {
      // Merge with existing state
      this.sequences.set(sequence.id, {
        ...existing,
        ...sequence,
      })
    } else {
      this.addSequence(sequence)
    }
  }

  /**
   * Remove a sequence
   */
  removeSequence(id: string): void {
    const seq = this.sequences.get(id)
    if (seq && seq.state === 'playing') {
      this.stopSequence(id, true)
    }
    this.sequences.delete(id)
  }

  /**
   * Start the transport
   */
  start(immediate: boolean = false): void {
    if (this.isRunning) return

    this.isRunning = true
    this.startTime = this.audioEngine.getCurrentTime()

    if (immediate) {
      this.startScheduler()
    } else {
      // Schedule start at next bar
      this.scheduleEvent({
        type: 'start',
        immediate: false,
      })
    }
  }

  /**
   * Stop the transport
   */
  stop(immediate: boolean = true): void {
    if (!this.isRunning) return

    if (immediate) {
      this.isRunning = false
      this.stopScheduler()
      this.audioEngine.stop()

      // Reset all sequences
      for (const seq of this.sequences.values()) {
        seq.state = 'stopped'
      }

      // Reset position
      this.currentPosition = {
        bar: 1,
        beat: 1,
        tick: 0,
        absoluteTicks: 0,
      }
    } else {
      // Schedule stop at next bar
      this.scheduleEvent({
        type: 'stop',
        immediate: false,
      })
    }
  }

  /**
   * Loop the transport
   */
  loop(sequences?: string[], immediate: boolean = false): void {
    if (sequences && sequences.length > 0) {
      // Loop specific sequences
      for (const id of sequences) {
        const seq = this.sequences.get(id)
        if (seq) {
          seq.loop = true
          if (!immediate) {
            this.scheduleEvent({
              type: 'loop',
              sequenceId: id,
              immediate: false,
            })
          }
        }
      }
    } else {
      // Loop all sequences
      for (const seq of this.sequences.values()) {
        seq.loop = true
      }
    }

    if (!this.isRunning) {
      this.start(immediate)
    }
  }

  /**
   * Jump to a specific bar
   */
  jumpToBar(bar: number, immediate: boolean = false): void {
    if (immediate) {
      this.setPosition(bar, 1, 0)
    } else {
      this.scheduleEvent({
        type: 'jump',
        targetBar: bar,
        immediate: false,
      })
    }
  }

  /**
   * Start a specific sequence
   */
  startSequence(id: string, immediate: boolean = false): void {
    const seq = this.sequences.get(id)
    if (!seq || seq.muted) return

    if (immediate) {
      seq.state = 'playing'
      this.playSequenceSlices(seq)
    } else {
      seq.state = 'scheduled'
      this.scheduleEvent({
        type: 'start',
        sequenceId: id,
        immediate: false,
      })
    }
  }

  /**
   * Stop a specific sequence
   */
  stopSequence(id: string, immediate: boolean = true): void {
    const seq = this.sequences.get(id)
    if (!seq) return

    if (immediate) {
      seq.state = 'stopped'
    } else {
      this.scheduleEvent({
        type: 'stop',
        sequenceId: id,
        immediate: false,
      })
    }
  }

  /**
   * Mute/unmute a sequence
   */
  muteSequence(id: string, mute: boolean): void {
    const seq = this.sequences.get(id)
    if (seq) {
      seq.muted = mute
      if (mute && seq.state === 'playing') {
        this.stopSequence(id, true)
      }
    }
  }

  /**
   * Start the scheduler
   */
  private startScheduler(): void {
    if (this.schedulerInterval) return

    this.nextNoteTime = this.audioEngine.getCurrentTime()

    this.schedulerInterval = setInterval(() => {
      this.scheduleNotes()
    }, this.scheduleInterval)
  }

  /**
   * Stop the scheduler
   */
  private stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval)
      this.schedulerInterval = null
    }
  }

  /**
   * Schedule notes
   */
  private scheduleNotes(): void {
    const currentTime = this.audioEngine.getCurrentTime()

    // Process events in queue
    this.processEventQueue()

    // Schedule notes within look-ahead window
    while (this.nextNoteTime < currentTime + this.lookAheadTime / 1000) {
      // Update position
      this.advancePosition()

      // Check if we're at a bar boundary
      if (this.currentPosition.beat === 1 && this.currentPosition.tick === 0) {
        this.onBarBoundary()
      }

      // Schedule sequences
      for (const seq of this.sequences.values()) {
        if (seq.state === 'playing' && !seq.muted) {
          this.scheduleSequenceNotes(seq, this.nextNoteTime)
        }
      }

      // Advance time
      const secondsPerTick = 60 / (this.globalTempo * this.ticksPerQuarter)
      this.nextNoteTime += secondsPerTick
    }
  }

  /**
   * Process event queue
   */
  private processEventQueue(): void {
    const toProcess = [...this.eventQueue]
    this.eventQueue = []

    for (const event of toProcess) {
      switch (event.type) {
        case 'start':
          if (event.sequenceId) {
            const seq = this.sequences.get(event.sequenceId)
            if (seq && seq.state === 'scheduled') {
              seq.state = 'playing'
            }
          } else {
            this.startScheduler()
          }
          break

        case 'stop':
          if (event.sequenceId) {
            const seq = this.sequences.get(event.sequenceId)
            if (seq) {
              seq.state = 'stopped'
            }
          } else {
            this.stop(true)
          }
          break

        case 'loop':
          if (event.sequenceId) {
            const seq = this.sequences.get(event.sequenceId)
            if (seq) {
              seq.loop = true
              if (seq.state === 'stopped') {
                seq.state = 'playing'
              }
            }
          }
          break

        case 'jump':
          if (event.targetBar) {
            this.setPosition(event.targetBar, 1, 0)
          }
          break
      }
    }
  }

  /**
   * Called at bar boundaries
   */
  private onBarBoundary(): void {
    // Process scheduled events that should happen at bar boundaries
    const barEvents = this.eventQueue.filter((e) => !e.immediate)
    for (const event of barEvents) {
      this.eventQueue = this.eventQueue.filter((e) => e !== event)
      this.eventQueue.push({ ...event, immediate: true })
    }

    // Handle looping sequences
    for (const seq of this.sequences.values()) {
      if (seq.loop && seq.state === 'playing') {
        // Check if sequence should loop
        const seqLength = seq.length || 1
        const seqStartBar = seq.startBar || 1

        if (this.currentPosition.bar >= seqStartBar + seqLength) {
          // Reset sequence to start
          console.log(`Looping sequence: ${seq.id}`)
        }
      }
    }
  }

  /**
   * Schedule notes for a sequence
   */
  private scheduleSequenceNotes(seq: TransportSequence, when: number): void {
    // Calculate position within sequence
    const seqTempo = seq.tempo || this.globalTempo
    const seqMeter = seq.meter || this.globalMeter

    // Determine which slice to play based on position
    const barProgress = (this.currentPosition.beat - 1) / seqMeter.numerator
    const sliceIndex = Math.floor(barProgress * seq.slices.length)

    if (sliceIndex < seq.slices.length) {
      const slice = seq.slices[sliceIndex]

      // Only play at the start of the slice's time window
      if (slice && this.shouldPlaySlice(seq, sliceIndex)) {
        this.audioEngine.playSlice(slice, {
          tempo: seqTempo / this.globalTempo,
          startTime: when,
        })
      }
    }
  }

  /**
   * Check if a slice should be played at current position
   */
  private shouldPlaySlice(seq: TransportSequence, sliceIndex: number): boolean {
    // Simple implementation: play each slice once per bar
    // More complex logic would consider the sequence's pattern
    const meter = seq.meter || this.globalMeter
    const ticksPerBeat = this.ticksPerQuarter * (4 / meter.denominator)
    const ticksPerBar = ticksPerBeat * meter.numerator
    const ticksPerSlice = ticksPerBar / seq.slices.length

    const positionInBar = (this.currentPosition.beat - 1) * ticksPerBeat + this.currentPosition.tick
    const expectedPosition = sliceIndex * ticksPerSlice

    // Play if we're at the start of this slice's time window
    return Math.abs(positionInBar - expectedPosition) < ticksPerBeat / 4
  }

  /**
   * Play sequence slices immediately (for testing)
   */
  private playSequenceSlices(seq: TransportSequence): void {
    const tempo = seq.tempo || this.globalTempo
    this.audioEngine.playSequence(seq.slices, {
      tempo: tempo / 120, // Normalize to base tempo
      loop: seq.loop,
    })
  }

  /**
   * Advance transport position by one tick
   */
  private advancePosition(): void {
    this.currentPosition.tick++
    this.currentPosition.absoluteTicks++

    const ticksPerBeat = this.ticksPerQuarter * (4 / this.globalMeter.denominator)

    if (this.currentPosition.tick >= ticksPerBeat) {
      this.currentPosition.tick = 0
      this.currentPosition.beat++

      if (this.currentPosition.beat > this.globalMeter.numerator) {
        this.currentPosition.beat = 1
        this.currentPosition.bar++
      }
    }
  }

  /**
   * Set transport position
   */
  private setPosition(bar: number, beat: number, tick: number): void {
    this.currentPosition.bar = bar
    this.currentPosition.beat = beat
    this.currentPosition.tick = tick

    // Recalculate absolute ticks
    const ticksPerBeat = this.ticksPerQuarter * (4 / this.globalMeter.denominator)
    const ticksPerBar = ticksPerBeat * this.globalMeter.numerator

    this.currentPosition.absoluteTicks = (bar - 1) * ticksPerBar + (beat - 1) * ticksPerBeat + tick
  }

  /**
   * Schedule an event
   */
  private scheduleEvent(event: TransportEvent): void {
    this.eventQueue.push(event)
  }

  /**
   * Get current position
   */
  getPosition(): TransportPosition {
    return { ...this.currentPosition }
  }

  /**
   * Get current state
   */
  getState(): {
    isRunning: boolean
    tempo: number
    meter: Meter
    position: TransportPosition
    sequences: TransportSequence[]
  } {
    return {
      isRunning: this.isRunning,
      tempo: this.globalTempo,
      meter: this.globalMeter,
      position: this.getPosition(),
      sequences: Array.from(this.sequences.values()),
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.stop(true)
    this.sequences.clear()
    this.eventQueue = []
  }
}
