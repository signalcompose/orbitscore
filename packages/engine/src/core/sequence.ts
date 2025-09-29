/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 */

import { AudioEngine, AudioFile, AudioSlice } from '../audio/audio-engine'
import { PlayElement } from '../parser/audio-parser'
import { TimingCalculator, TimedEvent } from '../timing/timing-calculator'

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

  private _audioFilePath?: string

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

  private _chopDivisions?: number

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

  // Transport control
  run(): this {
    // Mark as playing even if audio isn't loaded yet (for testing)
    if (!this._isPlaying) {
      this._isPlaying = true

      // Schedule audio playback if we have timed events and slices
      if (this._timedEvents && this._slices.length > 0) {
        const audioContext = this.audioEngine.getAudioContext()
        const currentTime = audioContext.currentTime

        for (const event of this._timedEvents) {
          if (event.sliceNumber > 0 && event.sliceNumber <= this._slices.length) {
            const slice = this._slices[event.sliceNumber - 1]
            if (slice) {
              const startTime = currentTime + event.startTime / 1000
              this.audioEngine.playSlice(slice, { startTime })
            }
          }
        }
      }

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
