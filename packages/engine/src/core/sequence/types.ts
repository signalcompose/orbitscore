/**
 * Type definitions for Sequence module
 */

import { AudioSlice } from '../../audio/audio-engine'
import { PlayElement, RandomValue } from '../../parser/audio-parser'
import { TimedEvent } from '../../timing/calculation'
import { Meter, Scheduler } from '../global/types'

/**
 * Sequence state interface
 */
export interface SequenceState {
  name: string
  tempo?: number
  beat?: Meter
  length?: number
  gainDb: number
  gainRandom?: RandomValue
  pan: number
  panRandom?: RandomValue
  slices: AudioSlice[]
  playPattern?: PlayElement[]
  timedEvents?: TimedEvent[]
  isMuted: boolean
  isPlaying: boolean
  isLooping: boolean
  audioFilePath?: string
  chopDivisions?: number
}

/**
 * Sequence parameters interface
 */
export interface SequenceParameters {
  name: string
  tempo?: number
  beat?: Meter
  length?: number
  gainDb: number
  gainRandom?: RandomValue
  pan: number
  panRandom?: RandomValue
  audioFilePath?: string
  chopDivisions?: number
}

/**
 * Sequence scheduling interface
 */
export interface SequenceScheduling {
  isPlaying: boolean
  isLooping: boolean
  loopStartTime?: number
  playbackInterval?: NodeJS.Timeout
  loopTimer?: NodeJS.Timeout
}

/**
 * Gain parameter options
 */
export interface GainOptions {
  valueDb: number | RandomValue
  isSeamless?: boolean
}

/**
 * Pan parameter options
 */
export interface PanOptions {
  value: number | RandomValue
  isSeamless?: boolean
}

/**
 * Audio loading options
 */
export interface AudioOptions {
  filepath: string
  chopDivisions?: number
}

/**
 * Play pattern options
 */
export interface PlayOptions {
  elements: PlayElement[]
  tempo?: number
  beat?: Meter
  length?: number
}

/**
 * Schedule events options
 */
export interface ScheduleEventsOptions {
  scheduler: Scheduler
  loopIteration?: number
  baseTime?: number
  audioFilePath?: string
  timedEvents?: TimedEvent[]
  chopDivisions?: number
  gainDb: number
  gainRandom?: RandomValue
  pan: number
  panRandom?: RandomValue
  isMuted: boolean
  sequenceName: string
}

/**
 * Schedule events from time options
 */
export interface ScheduleEventsFromTimeOptions {
  scheduler: Scheduler
  fromTime: number
  audioFilePath?: string
  timedEvents?: TimedEvent[]
  chopDivisions?: number
  gainDb: number
  gainRandom?: RandomValue
  pan: number
  panRandom?: RandomValue
  isMuted: boolean
  sequenceName: string
  loopStartTime?: number
}
