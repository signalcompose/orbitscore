/**
 * Audio type definitions
 * Maintained for backward compatibility
 */

import type { AudioDevice } from './supercollider/types'

export interface PluginLoadResult {
  pluginId: string
  pluginName: string
  notePortIndex: number
}

/**
 * Audio engine interface
 * Defines the common interface for audio engines (currently SuperCollider)
 */
export interface AudioEngine {
  /**
   * Boot the audio engine
   */
  boot(): Promise<void>

  /**
   * Quit the audio engine
   */
  quit(): Promise<void>

  /**
   * Check if the engine is running
   */
  readonly isRunning: boolean

  /**
   * Get the current output audio device (optional)
   */
  getCurrentOutputDevice?(): AudioDevice | undefined

  /**
   * Get available audio devices (optional)
   */
  getAvailableDevices?(): AudioDevice[]

  /**
   * Set available audio devices (optional)
   */
  setAvailableDevices?(devices: AudioDevice[]): void

  /**
   * Eagerly register a LinkAudio channel with the plugin so its source appears
   * in the Live "Audio From" list at `.output()` declaration time (before
   * playback) — lets the operator pre-route Ableton tracks ahead of a show.
   * Best-effort and idempotent. No-op on engines without LinkAudio (optional).
   */
  registerLinkAudioChannel?(channelName: string): Promise<void>

  /**
   * Push a tempo to the Link session so OrbitScore is the Link tempo leader and
   * connected peers (Ableton Live, etc.) follow `global.tempo()` (#283).
   * Best-effort. No-op on engines without LinkAudio (optional).
   */
  setLinkTempo?(bpm: number): Promise<void>

  /**
   * Eagerly load a plugin into the engine's master effect insert, or (when
   * `bus` is given) a named per-sequence insert bus (`seq.effect()` — PH.2b /
   * #434). `bus` is only meaningful for `role: 'effect'`; passing it with
   * `role: 'instrument'` is a daemon-side error.
   */
  loadPlugin?(
    filePath: string,
    pluginId: string | undefined,
    role: 'effect' | 'instrument',
    bus?: string,
  ): Promise<PluginLoadResult>

  pluginNoteOn?(key: number, channel: number, velocity: number): Promise<void>
  pluginNoteOff?(key: number, channel: number, velocity?: number): Promise<void>

  /**
   * Whether a previously-declared plugin is currently active in the engine
   * (optional). Lets callers detect a stale idempotent cache after a daemon
   * respawn silently failed to restore the plugin, so they can re-issue the
   * load instead of returning a false "success". Engines without this method
   * are treated as always-active (no self-heal check performed).
   */
  isPluginActive?(): boolean
}

/**
 * Audio slice interface
 * Note: SuperCollider uses file paths and slice numbers directly,
 * but this interface is kept for backward compatibility with the Sequence API
 */
export interface AudioSlice {
  /** Slice number (0-based) */
  sliceNumber: number
  /** Start time in seconds */
  startTime: number
  /** Duration in seconds */
  duration: number
  /** File path (for SuperCollider) */
  filepath?: string
}

/**
 * Play slice options
 */
export interface PlaySliceOptions {
  /** Tempo adjustment factor (default: 1.0) */
  tempo?: number
  /** Pitch shift in semitones */
  pitch?: number
  /** Start time for scheduling */
  startTime?: number
}

/**
 * Play sequence options
 */
export interface PlaySequenceOptions {
  /** Tempo adjustment factor (default: 1.0) */
  tempo?: number
  /** Pitch shift in semitones */
  pitch?: number
  /** Whether to loop the sequence */
  loop?: boolean
}
