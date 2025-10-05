/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 */

import * as path from 'path'

import { AudioEngine, AudioFile, AudioSlice } from '../audio/audio-engine'
import { PlayElement } from '../parser/audio-parser'
import { TimingCalculator, TimedEvent } from '../timing/timing-calculator'
import { AdvancedAudioPlayer } from '../audio/advanced-player'
import { audioSlicer } from '../audio/audio-slicer'

import { Global, Meter, Scheduler } from './global'

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
  private _isLooping: boolean = false
  private _audioFilePath?: string
  private _chopDivisions?: number
  private playbackInterval: NodeJS.Timeout | undefined
  private loopTimer: NodeJS.Timeout | undefined

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
    // If global audio path is set and filepath is relative, combine them
    const globalState = this.global.getState()
    if (globalState.audioPath && !path.isAbsolute(filepath)) {
      this._audioFilePath = path.join(globalState.audioPath, filepath)
      // ${this._name}: audio=${filepath}
    } else {
      this._audioFilePath = filepath
      // ${this._name}: audio=${filepath}
    }
    
    this._chopDivisions = 1 // Default to no chopping
    // Note: Actual loading will happen when needed or through explicit load call
    return this
  }

  async loadAudio(): Promise<void> {
    if (!this._audioFilePath) return

    try {
      this._audioFile = await this.audioEngine.loadAudioFile(this._audioFilePath)
      // Default to chop(1) if not specified
      this._slices = this._audioFile.chop(1)
      // ${this._name}: loaded
    } catch (error) {
      console.error(`Failed to load audio ${this._audioFilePath}:`, error)
    }
  }

  chop(divisions: number): this {
    this._chopDivisions = divisions

    if (!this._audioFilePath) {
      console.error(`${this._name}: no audio file set`)
      return this
    }

    // ${this._name}: chop(${divisions})
    return this
  }

  private async prepareSlices(): Promise<void> {
    if (!this._audioFilePath || !this._chopDivisions || this._chopDivisions <= 1) {
      return
    }

    try {
      await audioSlicer.sliceAudioFile(this._audioFilePath, this._chopDivisions)
      // ${this._name}: slices ready
    } catch (err: any) {
      console.error(`${this._name}: failed to prepare slices - ${err.message}`)
    }
  }

  play(...elements: PlayElement[]): this {
    this._playPattern = elements

    // Calculate timing for the play pattern
    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo
    const meter = this._beat || globalState.beat
    
    // 1小節の長さ = 4分音符の長さ × (分子 / 分母 × 4)
    // これにより、シーケンスごとに異なる拍子で1小節の長さを変えられる（ポリメーター）
    // 例: global.beat(4 by 4) = 2000ms, seq.beat(5 by 4) = 2500ms, seq.beat(9 by 8) = 2250ms
    const quarterNoteDuration = 60000 / tempo  // 4分音符の長さ（BPMの基準）
    const barDuration = quarterNoteDuration * (meter.numerator / meter.denominator * 4)

    this._timedEvents = TimingCalculator.calculateTiming(elements, barDuration)

    // ${this._name}: ${this._timedEvents.length} events

    // Update transport with the sequence data (if available)
    const transport = this.global.getTransport()
    if (transport) {
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
    }

    return this
  }

  // Schedule events to a global scheduler (one-shot or one iteration)
  async scheduleEvents(scheduler: Scheduler, loopIteration: number = 0, baseTime: number = 0): Promise<void> {
    if (!this._audioFilePath || !this._timedEvents || this._timedEvents.length === 0) {
      return
    }

    // Resolve the audio file path to an absolute path
    // Note: audio() method already combines globalState.audioPath with filepath
    // So we only need to resolve relative paths from current working directory
    const resolvedFilePath = path.isAbsolute(this._audioFilePath)
      ? this._audioFilePath
      : path.resolve(this._audioFilePath)

    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo || 120
    const beatDuration = 60000 / tempo // ms per beat
    const barDuration = beatDuration * 4 // assuming 4/4 time
    const chopDivisions = this._chopDivisions || 1

    // Schedule events for current iteration
    // When called from loop(), baseTime already includes the correct time
    // loopIteration should be 0 for loop() calls
    const loopOffset = loopIteration * barDuration * (this._length || 1)

    for (const event of this._timedEvents) {
      if (event.sliceNumber > 0) {
        // 0 is silence
        const startTimeMs = baseTime + event.startTime + loopOffset
        
        // Use sox slice playback instead of file slicing
        if (chopDivisions > 1) {
          scheduler.scheduleSliceEvent(
            resolvedFilePath,
            startTimeMs,
            event.sliceNumber,
            chopDivisions,
            this._isMuted ? 0 : 50,
            this._name,
          )
        } else {
          scheduler.scheduleEvent(
            resolvedFilePath,
            startTimeMs,
            this._isMuted ? 0 : 50,
            this._name,
          )
        }
      }
    }

    this._isPlaying = true
  }
  
  // Calculate pattern duration
  private getPatternDuration(): number {
    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo || 120
    const meter = this._beat || globalState.beat
    
    // 1小節の長さ = 4分音符の長さ × (分子 / 分母 × 4)
    const quarterNoteDuration = 60000 / tempo
    const barDuration = quarterNoteDuration * (meter.numerator / meter.denominator * 4)
    
    return barDuration * (this._length || 1)
  }

  // Transport control
  run(): this {
    const scheduler = this.global.getScheduler()
    const isRunning = (scheduler as any).isRunning
    
    // Check if scheduler is running
    if (!isRunning) {
      console.log(`⚠️ ${this._name}.run() - scheduler not running. Use global.run() first.`)
      return this
    }
    
    // One-shot playback
    if (!this._isPlaying) {
      this._isPlaying = true
      this._isLooping = false
      console.log(`▶ ${this._name} (one-shot)`)
      
      // Schedule immediately
      this.scheduleEvents(scheduler, 0)
    }
    return this
  }

  loop(): this {
    const scheduler = this.global.getScheduler()
    const isRunning = (scheduler as any).isRunning
    
    // Check if scheduler is running
    if (!isRunning) {
      console.log(`⚠️ ${this._name}.loop() - scheduler not running. Use global.run() first.`)
      return this
    }
    
    // Clear old loop timer if exists
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = undefined
    }
    
    // Clear old events for this sequence first
    ;(scheduler as any).clearSequenceEvents(this._name)
    
    this._isLooping = true
    this._isPlaying = true
    
    // Get current scheduler time
    const schedulerStartTime = (scheduler as any).startTime
    const now = Date.now()
    const currentTime = now - schedulerStartTime
    
    // Calculate pattern duration
    const patternDuration = this.getPatternDuration()
    
    // Track next scheduled time (cumulative, to avoid drift)
    let nextScheduleTime = currentTime
    let iteration = 0
    
    // Schedule first iteration
    this.scheduleEvents(scheduler, 0, nextScheduleTime) // Always use 0, baseTime contains the correct time
    
    // Set up loop timer
    this.loopTimer = setInterval(() => {
      if (this._isLooping && !this._isMuted) {
        iteration++
        nextScheduleTime += patternDuration // Cumulative time, no drift
        // Clear old scheduled events for this sequence before scheduling new ones
        ;(scheduler as any).clearSequenceEvents(this._name)
        this.scheduleEvents(scheduler, 0, nextScheduleTime) // Always use 0, baseTime contains the correct time
      }
    }, patternDuration)
    
    return this
  }

  stop(): this {
    // Clear scheduled events from scheduler
    const scheduler = this.global.getScheduler()
    ;(scheduler as any).clearSequenceEvents(this._name)
    
    // Clear loop timer
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = undefined
    }
    
    // Clear state
    this._isPlaying = false
    this._isLooping = false
    return this
  }

  mute(): this {
    this._isMuted = true
    // ${this._name}: mute
    return this
  }

  unmute(): this {
    this._isMuted = false
    // ${this._name}: unmute
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
      isLooping: this._isLooping,
    }
  }
}
