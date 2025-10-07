/**
 * State manager for Sequence
 * Handles sequence state management and inspection
 */

import { AudioSlice } from '../../../audio/types'
import { PlayElement } from '../../../parser/audio-parser'
import { TimedEvent } from '../../../timing/calculation'
import { StateManagerState } from '../types'

/**
 * State manager for Sequence
 */
export class StateManager {
  private _name: string = ''
  private _isMuted: boolean = false
  private _isPlaying: boolean = false
  private _isLooping: boolean = false
  private _slices: AudioSlice[] = []
  private _playPattern?: PlayElement[]
  private _timedEvents?: TimedEvent[]
  private _loopStartTime?: number
  private playbackInterval?: NodeJS.Timeout
  private loopTimer?: NodeJS.Timeout

  /**
   * Set sequence name
   */
  setName(name: string): string {
    this._name = name
    return this._name
  }

  /**
   * Get sequence name
   */
  getName(): string {
    return this._name
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): boolean {
    this._isMuted = muted
    return this._isMuted
  }

  /**
   * Get muted state
   */
  isMuted(): boolean {
    return this._isMuted
  }

  /**
   * Set playing state
   */
  setPlaying(playing: boolean): boolean {
    this._isPlaying = playing
    return this._isPlaying
  }

  /**
   * Get playing state
   */
  isPlaying(): boolean {
    return this._isPlaying
  }

  /**
   * Set looping state
   */
  setLooping(looping: boolean): boolean {
    this._isLooping = looping
    return this._isLooping
  }

  /**
   * Get looping state
   */
  isLooping(): boolean {
    return this._isLooping
  }

  /**
   * Set audio slices
   */
  setSlices(slices: AudioSlice[]): void {
    this._slices = slices
  }

  /**
   * Get audio slices
   */
  getSlices(): AudioSlice[] {
    return this._slices
  }

  /**
   * Set play pattern
   */
  setPlayPattern(pattern: PlayElement[]): void {
    this._playPattern = pattern
  }

  /**
   * Get play pattern
   */
  getPlayPattern(): PlayElement[] | undefined {
    return this._playPattern
  }

  /**
   * Set timed events
   */
  setTimedEvents(events: TimedEvent[]): void {
    this._timedEvents = events
  }

  /**
   * Get timed events
   */
  getTimedEvents(): TimedEvent[] | undefined {
    return this._timedEvents
  }

  /**
   * Set loop start time
   */
  setLoopStartTime(time: number): void {
    this._loopStartTime = time
  }

  /**
   * Get loop start time
   */
  getLoopStartTime(): number | undefined {
    return this._loopStartTime
  }

  /**
   * Set playback interval
   */
  setPlaybackInterval(interval: NodeJS.Timeout | undefined): void {
    this.playbackInterval = interval
  }

  /**
   * Get playback interval
   */
  getPlaybackInterval(): NodeJS.Timeout | undefined {
    return this.playbackInterval
  }

  /**
   * Set loop timer
   */
  setLoopTimer(timer: NodeJS.Timeout | undefined): void {
    this.loopTimer = timer
  }

  /**
   * Get loop timer
   */
  getLoopTimer(): NodeJS.Timeout | undefined {
    return this.loopTimer
  }

  /**
   * Get complete sequence state
   */
  getState(): StateManagerState {
    return {
      name: this._name,
      slices: this._slices,
      playPattern: this._playPattern,
      timedEvents: this._timedEvents,
      isMuted: this._isMuted,
      isPlaying: this._isPlaying,
      isLooping: this._isLooping,
    }
  }

  /**
   * Clear all timers
   */
  clearTimers(): void {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval)
      this.playbackInterval = undefined
    }
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = undefined
    }
  }
}
