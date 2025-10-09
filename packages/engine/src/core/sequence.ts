/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 * Refactored to use modular architecture with parameter, scheduling, and state managers
 */

import * as path from 'path'

import { AudioEngine } from '../audio/types'
import { PlayElement, RandomValue } from '../parser/audio-parser'

import { Global } from './global'
import { Scheduler } from './global/types'
import { preparePlayback } from './sequence/playback/prepare-playback'
import { runSequence } from './sequence/playback/run-sequence'
import { loopSequence } from './sequence/playback/loop-sequence'
import { prepareSlices as prepareSlicesUtil } from './sequence/audio/prepare-slices'
import { GainManager } from './sequence/parameters/gain-manager'
import { PanManager } from './sequence/parameters/pan-manager'
import { TempoManager } from './sequence/parameters/tempo-manager'
import { StateManager } from './sequence/state/state-manager'
import { scheduleEvents, scheduleEventsFromTime } from './sequence/scheduling/event-scheduler'

export class Sequence {
  private global: Global
  private audioEngine: AudioEngine

  // Managers
  private gainManager: GainManager
  private panManager: PanManager
  private tempoManager: TempoManager
  private stateManager: StateManager

  // Audio properties
  private _audioFilePath?: string
  private _chopDivisions?: number

  // Pending settings buffers (applied on next RUN/LOOP)
  private _pendingTempo?: number
  private _pendingBeat?: [number, number]
  private _pendingLength?: number
  private _pendingPlayPattern?: PlayElement[]
  private _pendingAudioFilePath?: string
  private _pendingChopDivisions?: number

  constructor(global: Global, audioEngine: AudioEngine) {
    this.global = global
    this.audioEngine = audioEngine

    // Initialize managers
    this.gainManager = new GainManager()
    this.panManager = new PanManager()
    this.tempoManager = new TempoManager()
    this.stateManager = new StateManager()
  }

  // Set the name (called when assigned to a variable)
  setName(name: string): this {
    this.stateManager.setName(name)
    this.global.registerSequence(name, this)
    return this
  }

  /**
   * Apply pending settings from buffer to actual settings
   * Called by RUN() immediately, and by LOOP() at next cycle
   */
  private applyPendingSettings(): void {
    if (this._pendingTempo !== undefined) {
      this.tempoManager.setTempo(this._pendingTempo)
      this._pendingTempo = undefined
    }

    if (this._pendingBeat !== undefined) {
      this.tempoManager.setBeat(this._pendingBeat[0], this._pendingBeat[1])
      this._pendingBeat = undefined
    }

    if (this._pendingLength !== undefined) {
      this.tempoManager.setLength(this._pendingLength)
      this._pendingLength = undefined
    }

    if (this._pendingPlayPattern !== undefined) {
      // Recalculate timing with new play pattern
      const globalState = this.global.getState()
      this.stateManager.setPlayPattern(this._pendingPlayPattern)
      const timedEvents = this.tempoManager.calculateEventTiming(
        this._pendingPlayPattern,
        globalState.tempo || 120,
        globalState.beat,
      )
      this.stateManager.setTimedEvents(timedEvents)
      this._pendingPlayPattern = undefined
    }

    if (this._pendingAudioFilePath !== undefined) {
      this._audioFilePath = this._pendingAudioFilePath
      this._pendingAudioFilePath = undefined
    }

    if (this._pendingChopDivisions !== undefined) {
      this._chopDivisions = this._pendingChopDivisions
      this._pendingChopDivisions = undefined
    }
  }

  // Method chaining setters
  tempo(value: number): this {
    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingTempo = value
    } else {
      this.tempoManager.setTempo(value)
    }
    return this
  }

  beat(numerator: number, denominator: number): this {
    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingBeat = [numerator, denominator]
    } else {
      this.tempoManager.setBeat(numerator, denominator)
    }
    return this
  }

  length(bars: number): this {
    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingLength = bars
    } else {
      const wasLooping = this.stateManager.isLooping()
      this.tempoManager.setLength(bars)

      // Recalculate timing if play pattern exists
      const playPattern = this.stateManager.getPlayPattern()
      if (playPattern && playPattern.length > 0) {
        this.play(...playPattern)
      }

      // If currently looping, restart the loop with new length
      if (wasLooping) {
        // Trigger async restart (no await needed as this is a sync method)
        this.stop()
        setTimeout(async () => {
          await this.loop()
        }, 10)
      }
    }

    return this
  }

  /**
   * Seamlessly update parameter during playback
   * Reschedules future events with new parameter value
   */
  private seamlessParameterUpdate(parameterName: string, description: string): void {
    if (this.stateManager.isLooping() || this.stateManager.isPlaying()) {
      const scheduler = this.global.getScheduler()

      if (scheduler.isRunning && this.stateManager.getLoopStartTime() !== undefined) {
        // Get current scheduler time
        const now = Date.now()
        const currentTime = now - scheduler.startTime

        // Clear ALL old events first
        scheduler.clearSequenceEvents(this.stateManager.getName())

        // Reschedule events, but only future ones
        this.scheduleEventsFromTime(scheduler, currentTime)

        console.log(`🎚️ ${this.stateManager.getName()}: ${parameterName}=${description} (seamless)`)
      }
    }
  }

  gain(valueDb: number | RandomValue): this {
    this.gainManager.setGain({ valueDb })
    this.seamlessParameterUpdate('gain', this.gainManager.getGainDescription())
    return this
  }

  pan(value: number | RandomValue): this {
    this.panManager.setPan({ value })
    this.seamlessParameterUpdate('pan', this.panManager.getPanDescription())
    return this
  }

  audio(filepath: string): this {
    // Calculate full path
    const globalState = this.global.getState()
    const fullPath =
      globalState.audioPath && !path.isAbsolute(filepath)
        ? path.join(globalState.audioPath, filepath)
        : filepath

    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingAudioFilePath = fullPath
      this._pendingChopDivisions = 1 // Reset chop when audio changes
    } else {
      this._audioFilePath = fullPath
      this._chopDivisions = 1 // Default to no chopping
    }

    // Note: Actual loading will happen when needed or through explicit load call
    return this
  }

  // Note: Audio loading is now handled by SuperCollider's buffer manager
  // This method is kept for backward compatibility but does nothing
  async loadAudio(): Promise<void> {
    // SuperCollider handles audio loading internally via loadBuffer()
    // No action needed here
  }

  chop(divisions: number): this {
    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingChopDivisions = divisions
    } else {
      this._chopDivisions = divisions

      if (!this._audioFilePath) {
        console.error(`${this.stateManager.getName()}: no audio file set`)
        return this
      }
    }

    return this
  }

  private async prepareSlices(): Promise<void> {
    await prepareSlicesUtil({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
    })
  }

  play(...elements: PlayElement[]): this {
    // Buffer if playing/looping, otherwise apply immediately
    if (this.stateManager.isPlaying() || this.stateManager.isLooping()) {
      this._pendingPlayPattern = elements
    } else {
      this.stateManager.setPlayPattern(elements)

      // Calculate timing for the play pattern
      const globalState = this.global.getState()
      const timedEvents = this.tempoManager.calculateEventTiming(
        elements,
        globalState.tempo || 120,
        globalState.beat,
      )

      this.stateManager.setTimedEvents(timedEvents)
    }

    return this
  }

  // Schedule events from a specific time onwards (for seamless parameter changes)
  private scheduleEventsFromTime(scheduler: Scheduler, fromTime: number): void {
    const timedEvents = this.stateManager.getTimedEvents()
    if (!timedEvents || !this._audioFilePath) {
      return
    }

    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    scheduleEventsFromTime({
      scheduler,
      fromTime,
      audioFilePath: this._audioFilePath,
      timedEvents,
      chopDivisions: this._chopDivisions,
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
      isMuted: this.stateManager.isMuted(),
      sequenceName: this.stateManager.getName(),
      loopStartTime: this.stateManager.getLoopStartTime(),
      masterGainDb: this.global.getMasterGainDb(),
      patternDuration: this.getPatternDuration(),
    })
  }

  async scheduleEvents(
    scheduler: Scheduler,
    loopIteration: number = 0,
    baseTime: number = 0,
  ): Promise<void> {
    const timedEvents = this.stateManager.getTimedEvents()
    if (!this._audioFilePath || !timedEvents || timedEvents.length === 0) {
      return
    }

    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    await scheduleEvents({
      scheduler,
      loopIteration,
      baseTime,
      audioFilePath: this._audioFilePath,
      timedEvents,
      chopDivisions: this._chopDivisions,
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
      isMuted: this.stateManager.isMuted(),
      sequenceName: this.stateManager.getName(),
      masterGainDb: this.global.getMasterGainDb(),
      patternDuration: this.getPatternDuration(),
    })

    this.stateManager.setPlaying(true)
  }

  // Calculate pattern duration
  private getPatternDuration(): number {
    const globalState = this.global.getState()
    return this.tempoManager.calculatePatternDuration(globalState.tempo || 120, globalState.beat)
  }

  // Transport control
  async run(): Promise<this> {
    // Apply pending settings immediately (RUN behavior)
    this.applyPendingSettings()

    const prepared = await preparePlayback({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
      loopTimer: this.stateManager.getLoopTimer(),
      prepareSlicesFn: () => this.prepareSlices(),
      getScheduler: () => this.global.getScheduler(),
    })

    if (!prepared) return this

    const { scheduler, currentTime } = prepared
    // Note: preparePlayback() has already cleared any existing loop timer
    // run() is one-shot playback, so we ensure loopTimer remains undefined
    this.stateManager.setLoopTimer(undefined)

    const result = await runSequence({
      sequenceName: this.stateManager.getName(),
      scheduler,
      currentTime,
      isPlaying: this.stateManager.isPlaying(),
      scheduleEventsFn: (sched, offset, baseTime) => this.scheduleEvents(sched, offset, baseTime),
      getPatternDurationFn: () => this.getPatternDuration(),
      clearSequenceEventsFn: (name) => scheduler.clearSequenceEvents(name),
    })

    this.stateManager.setPlaying(result.isPlaying)
    this.stateManager.setLooping(result.isLooping)

    return this
  }

  async loop(): Promise<this> {
    const prepared = await preparePlayback({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
      loopTimer: this.stateManager.getLoopTimer(),
      prepareSlicesFn: () => this.prepareSlices(),
      getScheduler: () => this.global.getScheduler(),
    })

    if (!prepared) return this

    const { scheduler, currentTime } = prepared

    // Set loop state BEFORE calling loopSequence to avoid race condition
    // The setInterval callback will check this state via getIsLoopingFn()
    this.stateManager.setLooping(true)
    this.stateManager.setPlaying(true)

    const result = loopSequence({
      sequenceName: this.stateManager.getName(),
      scheduler,
      currentTime,
      scheduleEventsFn: (sched, offset, baseTime) => this.scheduleEvents(sched, offset, baseTime),
      getPatternDurationFn: () => this.getPatternDuration(),
      clearSequenceEventsFn: (name) => scheduler.clearSequenceEvents(name),
      getIsLoopingFn: () => this.stateManager.isLooping(),
      getIsMutedFn: () => this.stateManager.isMuted(),
      applyPendingSettingsFn: () => this.applyPendingSettings(),
    })

    // Update remaining state from result
    this.stateManager.setLoopStartTime(result.loopStartTime)
    this.stateManager.setLoopTimer(result.loopTimer)

    return this
  }

  stop(): this {
    const sequenceName = this.stateManager.getName()
    const wasLooping = this.stateManager.isLooping()

    // Clear scheduled events from scheduler
    const scheduler = this.global.getScheduler()
    scheduler.clearSequenceEvents(sequenceName)

    // Clear loop timer (only exists if loop() was called, not run())
    // Note: run() sets loopTimer to undefined, so this check prevents redundant clearInterval
    const loopTimer = this.stateManager.getLoopTimer()
    if (loopTimer) {
      clearInterval(loopTimer)
      this.stateManager.setLoopTimer(undefined)
    }

    // Clear state
    this.stateManager.setPlaying(false)
    this.stateManager.setLooping(false)

    // Log stop message for loop sequences
    if (wasLooping) {
      console.log(`⏹ ${sequenceName} (loop stopped)`)
    }

    return this
  }

  mute(): this {
    this.stateManager.setMuted(true)
    return this
  }

  unmute(): this {
    this.stateManager.setMuted(false)
    return this
  }

  // Get state for debugging/inspection
  getState() {
    const state = this.stateManager.getState()
    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    return {
      ...state,
      tempo: this.tempoManager.getTempo(),
      beat: this.tempoManager.getBeat(),
      length: this.tempoManager.getLength(),
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
    }
  }
}
