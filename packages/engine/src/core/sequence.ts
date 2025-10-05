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
    const barDuration = (60000 / tempo) * meter.numerator // Duration of one bar in ms

    this._timedEvents = TimingCalculator.calculateTiming(elements, barDuration)

    // ${this._name}: ${this._timedEvents.length} events

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

  // Schedule events to a global scheduler (one-shot or one iteration)
  async scheduleEvents(scheduler: AdvancedAudioPlayer, loopIteration: number = 0, baseTime: number = 0): Promise<void> {
    if (!this._audioFilePath || !this._timedEvents || this._timedEvents.length === 0) {
      return
    }

    // Resolve the audio file path to an absolute path
    const resolvedFilePath = path.resolve(this._audioFilePath)

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
        console.log(`    🎵 Scheduling ${this._name} event at ${startTimeMs}ms (base=${baseTime}, event=${event.startTime}, offset=${loopOffset})`)

        // Use sox slice playback instead of file slicing
        if (chopDivisions > 1) {
          scheduler.scheduleSliceEvent(
            resolvedFilePath,
            startTimeMs,
            event.sliceNumber,
            chopDivisions,
            { volume: this._isMuted ? 0 : 50 },
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
    const beatDuration = 60000 / tempo // ms per beat
    const barDuration = beatDuration * 4 // assuming 4/4 time
    return barDuration * (this._length || 1)
  }

  // Transport control
  run(): this {
    // One-shot playback
    if (!this._isPlaying) {
      this._isPlaying = true
      this._isLooping = false
      console.log(`▶ ${this._name} (one-shot)`)
      
      // Schedule immediately
      const scheduler = this.global.getScheduler()
      this.scheduleEvents(scheduler, 0)
    }
    return this
  }

  loop(): this {
    console.log(`🔁 ${this._name}.loop() called - isLooping=${this._isLooping}, loopTimer=${this.loopTimer ? 'EXISTS' : 'null'}`)
    
    // Clear old loop timer if exists
    if (this.loopTimer) {
      console.log(`  🧹 Clearing old loop timer`)
      clearInterval(this.loopTimer)
      this.loopTimer = undefined
    }
    
    const scheduler = this.global.getScheduler()
    
    // Clear old events for this sequence first
    console.log(`  🗑️ Clearing old events for ${this._name}`)
    ;(scheduler as any).clearSequenceEvents(this._name)
    
    this._isLooping = true
    this._isPlaying = true
    
    // Get current scheduler time
    const isRunning = (scheduler as any).isRunning
    const schedulerStartTime = (scheduler as any).startTime
    const now = Date.now()
    const currentTime = isRunning 
      ? now - schedulerStartTime 
      : 0
    
    console.log(`  ⏰ Scheduler state: isRunning=${isRunning}, startTime=${schedulerStartTime}, now=${now}`)
    console.log(`  ⏰ Starting at: ${currentTime}ms`)
    
    // Calculate pattern duration
    const patternDuration = this.getPatternDuration()
    console.log(`  ⏱️ Pattern duration: ${patternDuration}ms`)
    
    // Track next scheduled time (cumulative, to avoid drift)
    let nextScheduleTime = currentTime
    let iteration = 0
    
    // Schedule first iteration
    console.log(`  📅 Scheduling iteration ${iteration} at ${nextScheduleTime}ms`)
    this.scheduleEvents(scheduler, 0, nextScheduleTime) // Always use 0, baseTime contains the correct time
    
    // Set up loop timer
    this.loopTimer = setInterval(() => {
      if (this._isLooping && !this._isMuted) {
        iteration++
        nextScheduleTime += patternDuration // Cumulative time, no drift
        console.log(`  🔄 Loop iteration ${iteration} at ${nextScheduleTime}ms`)
        this.scheduleEvents(scheduler, 0, nextScheduleTime) // Always use 0, baseTime contains the correct time
      }
    }, patternDuration)
    
    return this
  }

  stop(): this {
    console.log(`⏹ ${this._name}.stop() called - isPlaying=${this._isPlaying}, isLooping=${this._isLooping}, loopTimer=${this.loopTimer ? 'EXISTS' : 'null'}`)
    
    // Clear scheduled events from scheduler
    const scheduler = this.global.getScheduler()
    console.log(`  🗑️ Clearing scheduled events`)
    ;(scheduler as any).clearSequenceEvents(this._name)
    
    // Clear loop timer
    if (this.loopTimer) {
      console.log(`  🧹 Clearing loop timer`)
      clearInterval(this.loopTimer)
      this.loopTimer = undefined
    } else {
      console.log(`  ⚠️ No loop timer to clear`)
    }
    
    // Clear state
    this._isPlaying = false
    this._isLooping = false
    
    console.log(`✅ ${this._name} stopped`)
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
