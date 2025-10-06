/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 */

import * as path from 'path'

import { AudioEngine, AudioFile, AudioSlice } from '../audio/audio-engine'
import { PlayElement, RandomValue } from '../parser/audio-parser'
import { TimingCalculator, TimedEvent } from '../timing/timing-calculator'
import { audioSlicer } from '../audio/audio-slicer'

import { Global, Meter, Scheduler } from './global'

/**
 * Generate a random value based on the random spec
 */
function generateRandomValue(spec: RandomValue, min: number, max: number): number {
  if (spec.type === 'full-random') {
    // Full random within min-max range
    return Math.random() * (max - min) + min
  } else {
    // Random walk: center ± range
    const value = spec.center + (Math.random() * 2 - 1) * spec.range
    // Clamp to valid range
    return Math.max(min, Math.min(max, value))
  }
}

export class Sequence {
  private global: Global
  private audioEngine: AudioEngine

  // Sequence properties
  private _name: string = ''
  private _tempo?: number
  private _beat?: Meter
  private _length?: number // Loop length in bars
  private _gainDb: number = 0 // Gain in dB, default 0 dB (100%)
  private _gainRandom?: RandomValue // Random spec for gain
  private _pan: number = 0 // -100 (left) to 100 (right), default 0 (center)
  private _panRandom?: RandomValue // Random spec for pan
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
  private _loopStartTime?: number // Time when loop() was called (in scheduler time)

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
    const wasLooping = this._isLooping
    this._length = bars
    
    // Recalculate timing if play pattern exists
    if (this._playPattern && this._playPattern.length > 0) {
      this.play(...this._playPattern)
    }
    
    // If currently looping, restart the loop with new length
    if (wasLooping) {
      // Don't await, just trigger async restart
      this.stop()
      setTimeout(() => {
        this.loop()
      }, 10)
    }
    
    return this
  }

  gain(valueDb: number | RandomValue): this {
    // Check if it's a random value spec
    if (typeof valueDb === 'object' && 'type' in valueDb) {
      this._gainRandom = valueDb
      // Set a default value for display (center if random-walk, 0 if full-random)
      if (valueDb.type === 'random-walk') {
        this._gainDb = Math.max(-60, Math.min(12, valueDb.center))
      } else {
        this._gainDb = 0 // Default to 0 dB for full-random
      }
    } else {
      // Fixed value
      this._gainRandom = undefined
      // Clamp to -60 dB (effectively silent) to +12 dB (prevent clipping)
      // -Infinity is allowed for complete silence
      if (valueDb === -Infinity) {
        this._gainDb = -Infinity
      } else {
        this._gainDb = Math.max(-60, Math.min(12, valueDb))
      }
    }
    
    // If already playing, reschedule future events only (seamless change)
    if (this._isLooping || this._isPlaying) {
      const scheduler = this.global.getScheduler()
      const isRunning = (scheduler as any).isRunning
      
      if (isRunning && this._loopStartTime !== undefined) {
        // Get current scheduler time
        const schedulerStartTime = (scheduler as any).startTime
        const now = Date.now()
        const currentTime = now - schedulerStartTime
        
        // Clear ALL old events first
        ;(scheduler as any).clearSequenceEvents(this._name)
        
        // Reschedule events, but only future ones
        // scheduleEvents will now skip events that are already in the past
        this.scheduleEventsFromTime(scheduler, currentTime)
        
        const gainDesc = this._gainRandom 
          ? (this._gainRandom.type === 'full-random' ? 'random' : `random(${this._gainRandom.center}±${this._gainRandom.range})`)
          : `${typeof valueDb === 'number' ? valueDb : this._gainDb} dB`
        console.log(`🎚️ ${this._name}: gain=${gainDesc} (seamless)`)
      }
    }
    
    return this
  }

  pan(value: number | RandomValue): this {
    // Check if it's a random value spec
    if (typeof value === 'object' && 'type' in value) {
      this._panRandom = value
      // Set a default value for display (center if random-walk, 0 if full-random)
      if (value.type === 'random-walk') {
        this._pan = Math.max(-100, Math.min(100, value.center))
      } else {
        this._pan = 0 // Default to center for full-random
      }
    } else {
      // Fixed value
      this._panRandom = undefined
      this._pan = Math.max(-100, Math.min(100, value))
    }
    
    // If already playing, reschedule with new pan
    if (this._isLooping || this._isPlaying) {
      const scheduler = this.global.getScheduler()
      const isRunning = (scheduler as any).isRunning
      
      if (isRunning && this._loopStartTime !== undefined) {
        // Clear ALL old events first
        ;(scheduler as any).clearSequenceEvents(this._name)
        
        // Get current scheduler time
        const schedulerStartTime = (scheduler as any).startTime
        const now = Date.now()
        const currentTime = now - schedulerStartTime
        
        // Reschedule events, but only future ones
        this.scheduleEventsFromTime(scheduler, currentTime)
        
        const panDesc = this._panRandom 
          ? (this._panRandom.type === 'full-random' ? 'random' : `random(${this._panRandom.center}±${this._panRandom.range})`)
          : value
        console.log(`🎚️ ${this._name}: pan=${panDesc} (seamless)`)
      }
    }
    
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

    // Apply length multiplier to bar duration (stretches each event)
    const effectiveBarDuration = barDuration * (this._length || 1)

    this._timedEvents = TimingCalculator.calculateTiming(elements, effectiveBarDuration)

    // ${this._name}: ${this._timedEvents.length} events

    return this
  }

  // Schedule events to a global scheduler (one-shot or one iteration)
  // Schedule events from a specific time onwards (for seamless parameter changes)
  private scheduleEventsFromTime(scheduler: Scheduler, fromTime: number): void {
    if (!this._timedEvents || !this._audioFilePath) {
      return
    }

    const resolvedFilePath = path.isAbsolute(this._audioFilePath)
      ? this._audioFilePath
      : path.resolve(this._audioFilePath)

    const globalState = this.global.getState()
    const tempo = this._tempo || globalState.tempo || 120
    const beatDuration = 60000 / tempo // ms per beat
    const barDuration = beatDuration * 4 // assuming 4/4 time
    const chopDivisions = this._chopDivisions || 1
    const patternDuration = this.getPatternDuration()

    // Calculate which loop iteration we're in
    const elapsedTime = fromTime - (this._loopStartTime || 0)
    const currentIteration = Math.floor(elapsedTime / patternDuration)

    // Schedule remaining events in current iteration + next iteration
    for (let iter = currentIteration; iter < currentIteration + 2; iter++) {
      const loopOffset = iter * patternDuration
      const baseTime = (this._loopStartTime || 0) + loopOffset

      for (const event of this._timedEvents) {
        if (event.sliceNumber > 0) {
          const startTimeMs = baseTime + event.startTime

          // Skip events that are in the past
          if (startTimeMs <= fromTime) {
            continue
          }

          // Calculate final gain
          const masterGainDb = this.global.getMasterGainDb()
          let sequenceGainDb = this._gainDb
          
          // Generate random gain if specified
          if (this._gainRandom) {
            sequenceGainDb = generateRandomValue(this._gainRandom, -60, 12)
          }
          
          let finalGainDb: number
          if (this._isMuted) {
            finalGainDb = -Infinity
          } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
            finalGainDb = -Infinity
          } else {
            finalGainDb = sequenceGainDb + masterGainDb
          }
          
          // Generate random pan if specified
          const eventPan = this._panRandom 
            ? generateRandomValue(this._panRandom, -100, 100)
            : this._pan

          // Schedule event
          if (chopDivisions > 1) {
            scheduler.scheduleSliceEvent(
              resolvedFilePath,
              startTimeMs,
              event.sliceNumber,
              chopDivisions,
              finalGainDb,
              eventPan,
              this._name,
            )
          } else {
            scheduler.scheduleEvent(
              resolvedFilePath,
              startTimeMs,
              finalGainDb,
              eventPan,
              this._name,
            )
          }
        }
      }
    }
  }

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
        
        // Calculate final gain: sequence gain + master gain (in dB, so we add them)
        const masterGainDb = this.global.getMasterGainDb()
        let sequenceGainDb = this._gainDb
        
        // Generate random gain if specified
        if (this._gainRandom) {
          sequenceGainDb = generateRandomValue(this._gainRandom, -60, 12)
        }
        
        let finalGainDb: number
        if (this._isMuted) {
          finalGainDb = -Infinity
        } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
          finalGainDb = -Infinity
        } else {
          finalGainDb = sequenceGainDb + masterGainDb
        }
        
        // Generate random pan if specified
        const eventPan = this._panRandom 
          ? generateRandomValue(this._panRandom, -100, 100)
          : this._pan
        
        // Use sox slice playback instead of file slicing
        if (chopDivisions > 1) {
          scheduler.scheduleSliceEvent(
            resolvedFilePath,
            startTimeMs,
            event.sliceNumber,
            chopDivisions,
            finalGainDb,
            eventPan,
            this._name,
          )
        } else {
          scheduler.scheduleEvent(
            resolvedFilePath,
            startTimeMs,
            finalGainDb,
            eventPan,
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
    
    // length() multiplies the duration of each event, not the number of bars
    // So the pattern duration is: 1 bar × length multiplier
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

  async loop(): Promise<this> {
    const scheduler = this.global.getScheduler()
    const isRunning = (scheduler as any).isRunning
    
    // Check if scheduler is running
    if (!isRunning) {
      console.log(`⚠️ ${this._name}.loop() - scheduler not running. Use global.run() first.`)
      return this
    }
    
    // Preload buffer to get correct duration
    if (this._audioFilePath && scheduler.loadBuffer) {
      const resolvedPath = path.isAbsolute(this._audioFilePath)
        ? this._audioFilePath
        : path.resolve(this._audioFilePath)
      await scheduler.loadBuffer(resolvedPath)
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
    
    // Record loop start time for seamless parameter changes
    this._loopStartTime = currentTime
    
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
      gainDb: this._gainDb,
      gainRandom: this._gainRandom,
      pan: this._pan,
      panRandom: this._panRandom,
      slices: this._slices,
      playPattern: this._playPattern,
      timedEvents: this._timedEvents,
      isMuted: this._isMuted,
      isPlaying: this._isPlaying,
      isLooping: this._isLooping,
    }
  }
}
