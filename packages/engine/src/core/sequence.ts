/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 * Refactored to use modular architecture with parameter, scheduling, and state managers
 */

import * as path from 'path'

import { SuperColliderPlayer } from '../audio/supercollider-player'
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
  private audioEngine: SuperColliderPlayer

  // Managers
  private gainManager: GainManager
  private panManager: PanManager
  private tempoManager: TempoManager
  private stateManager: StateManager

  // Audio properties
  private _audioFilePath?: string
  private _chopDivisions?: number

  constructor(global: Global, audioEngine: SuperColliderPlayer) {
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

  // Method chaining setters
  tempo(value: number): this {
    this.tempoManager.setTempo(value)
    return this
  }

  beat(numerator: number, denominator: number): this {
    this.tempoManager.setBeat(numerator, denominator)
    return this
  }

  length(bars: number): this {
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
    // If global audio path is set and filepath is relative, combine them
    const globalState = this.global.getState()
    if (globalState.audioPath && !path.isAbsolute(filepath)) {
      this._audioFilePath = path.join(globalState.audioPath, filepath)
    } else {
      this._audioFilePath = filepath
    }

    this._chopDivisions = 1 // Default to no chopping
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
    this._chopDivisions = divisions

    if (!this._audioFilePath) {
      console.error(`${this.stateManager.getName()}: no audio file set`)
      return this
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
    this.stateManager.setPlayPattern(elements)

    // Calculate timing for the play pattern
    const globalState = this.global.getState()
    const timedEvents = this.tempoManager.calculateEventTiming(
      elements,
      globalState.tempo || 120,
      globalState.beat,
    )

    this.stateManager.setTimedEvents(timedEvents)

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
      clearSequenceEventsFn: (name) => (scheduler as any).clearSequenceEvents(name),
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
      clearSequenceEventsFn: (name) => (scheduler as any).clearSequenceEvents(name),
      getIsLoopingFn: () => this.stateManager.isLooping(),
      getIsMutedFn: () => this.stateManager.isMuted(),
    })

    // Update remaining state from result
    this.stateManager.setLoopStartTime(result.loopStartTime)
    this.stateManager.setLoopTimer(result.loopTimer)

    return this
  }

  stop(): this {
    // Clear scheduled events from scheduler
    const scheduler = this.global.getScheduler()
    ;(scheduler as any).clearSequenceEvents(this.stateManager.getName())

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
