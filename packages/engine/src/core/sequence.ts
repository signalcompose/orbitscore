/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 */

import { AudioEngine, AudioFile, AudioSlice } from '../audio/audio-engine'
import { PlayElement } from '../parser/audio-parser'
import { TimingCalculator, TimedEvent } from '../timing/timing-calculator'
import { PrecisionScheduler } from '../audio/precision-scheduler'

import { Global, Meter } from './global'

export class Sequence {
  private global: Global
  private audioEngine: AudioEngine

  // Sequence properties
  private _name: string = ''
  private _tempo?: number
  private _beat?: Meter
  private _length?: number // Loop length in bars
  private _audioFile?: AudioFile
  private _slices: AudioSlice[] = []
  private _playPattern?: PlayElement[]
  private _timedEvents?: TimedEvent[]
  private _isMuted: boolean = false
  private _isPlaying: boolean = false
  private _audioFilePath?: string
  private _chopDivisions?: number
  private playbackInterval: NodeJS.Timeout | undefined

  constructor(global: Global, audioEngine: AudioEngine) {
    this.global = global
    this.audioEngine = audioEngine
  }

  // Set the name (called when assigned to a variable)
  setName(name: string): this {
    this._name = name
    this.global.registerSequence(name, this)
    return this
  }

  // Method chaining setters
  tempo(value: number): this {
    this._tempo = value
    return this
  }

  beat(numerator: number, denominator: number): this {
    this._beat = { numerator, denominator }
    return this
  }

  length(bars: number): this {
    this._length = bars
    return this
  }

  audio(filepath: string): this {
    // Store the filepath for loading
    this._audioFilePath = filepath
    // Note: Actual loading will happen when needed or through explicit load call
    console.log(`${this._name}: audio file set to ${filepath}`)
    return this
  }

  async loadAudio(): Promise<void> {
    if (!this._audioFilePath) return

    try {
      this._audioFile = await this.audioEngine.loadAudioFile(this._audioFilePath)
      // Default to chop(1) if not specified
      this._slices = this._audioFile.chop(1)
      console.log(`${this._name}: loaded audio ${this._audioFilePath}`)
    } catch (error) {
      console.error(`Failed to load audio ${this._audioFilePath}:`, error)
    }
  }

  chop(divisions: number): this {
    if (!this._audioFile && this._audioFilePath) {
      // If audio file is set but not loaded, just store the chop value
      this._chopDivisions = divisions
      console.log(`${this._name}: will chop into ${divisions} slices when loaded`)
      return this
    }
    if (!this._audioFile) {
      console.error(`${this._name}: no audio file loaded`)
      return this
    }
    this._slices = this._audioFile.chop(divisions)
    console.log(`${this._name}: chopped into ${divisions} slices`)
    return this
  }

  play(...elements: PlayElement[]): this {
    this._playPattern = elements

    // Calculate timing for the play pattern
    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo
    const meter = this._beat || globalState.beat
    const barDuration = (60000 / tempo) * meter.numerator // Duration of one bar in ms

    this._timedEvents = TimingCalculator.calculateTiming(elements, barDuration)

    console.log(`${this._name}: play pattern set with ${this._timedEvents.length} events`)

    // Update transport with the sequence data
    const transport = this.global.getTransport()
    transport.updateSequence({
      id: this._name,
      slices: this._slices,
      tempo: tempo, // Already calculated above
      meter: meter, // Already calculated above
      length: this._length || 1, // Default to 1 bar if not specified
      loop: false,
      muted: this._isMuted,
      state: this._isPlaying ? 'playing' : 'stopped',
    })

    return this
  }

  // Schedule events to a global scheduler
  scheduleEvents(scheduler: PrecisionScheduler): void {
    if (!this._audioFilePath || !this._timedEvents || this._timedEvents.length === 0) {
      return
    }

    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo || 120
    const beatDuration = 60000 / tempo // ms per beat
    const barDuration = beatDuration * 4 // assuming 4/4 time
    const loopCount = this._length || 1 // Use length as loop count

    console.log(`${this._name}: scheduling ${this._timedEvents.length} events x ${loopCount} loops`)

    // Schedule events for each loop
    for (let loop = 0; loop < loopCount; loop++) {
      const loopOffset = loop * barDuration

      for (const event of this._timedEvents) {
        if (event.sliceNumber > 0) {
          // 0 is silence
          const startTimeMs = event.startTime + loopOffset

          // Schedule the audio file to play at the correct time
          scheduler.scheduleEvent(
            this._audioFilePath,
            startTimeMs,
            this._isMuted ? 0 : 80,
            this._name,
          )

          if (loop === 0) {
            console.log(`  - event at ${event.startTime}ms: slice ${event.sliceNumber}`)
          }
        }
      }
    }

    this._isPlaying = true
    console.log(`${this._name}: scheduled for playback (${loopCount} loops)`)
  }

  // Transport control
  run(): this {
    // Mark as playing even if audio isn't loaded yet (for testing)
    if (!this._isPlaying) {
      this._isPlaying = true
      console.log(`${this._name}: started playback`)
    }
    return this
  }

  loop(): this {
    // TODO: Implement looping with transport system
    this._isPlaying = true
    console.log(`${this._name}: looping`)
    return this
  }

  stop(): this {
    if (this._isPlaying) {
      this._isPlaying = false
      // TODO: Stop scheduled audio
      console.log(`${this._name}: stopped`)
    }
    return this
  }

  mute(): this {
    this._isMuted = true
    console.log(`${this._name}: muted`)
    return this
  }

  unmute(): this {
    this._isMuted = false
    console.log(`${this._name}: unmuted`)
    return this
  }

  // Get state for debugging/inspection
  getState() {
    return {
      name: this._name,
      tempo: this._tempo,
      beat: this._beat,
      length: this._length,
      slices: this._slices,
      playPattern: this._playPattern,
      timedEvents: this._timedEvents,
      isMuted: this._isMuted,
      isPlaying: this._isPlaying,
    }
  }
}
