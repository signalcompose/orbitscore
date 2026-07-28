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

export type PluginStateSaveTarget =
  | { role: 'effect'; bus?: string }
  | { role: 'instrument'; instance: string }

export interface PluginStateSaveResult {
  path: string
  bytesWritten: number
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
    instance?: string,
    statePath?: string,
  ): Promise<PluginLoadResult>

  /** 現在のOOP plugin stateを停止中に取得し、指定した絶対パスへatomicに確定する。 */
  savePluginState?(
    target: PluginStateSaveTarget,
    absolutePath: string,
  ): Promise<PluginStateSaveResult>

  pluginNoteOn?(key: number, channel: number, velocity: number, instance?: string): Promise<void>
  pluginNoteOff?(key: number, channel: number, velocity?: number, instance?: string): Promise<void>

  /**
   * Whether a previously-declared plugin is currently active in the engine
   * (optional). Lets callers detect a stale idempotent cache after a daemon
   * respawn silently failed to restore the plugin, so they can re-issue the
   * load instead of returning a false "success". Engines without this method
   * are treated as always-active (no self-heal check performed).
   */
  isPluginActive?(role?: 'effect' | 'instrument', bus?: string, instance?: string): boolean

  /**
   * Runtime mixer routing (MX.4, #459/#453 M3): (re)sets `seqBus`'s output target (a sum
   * bus) and/or send gains (to aux buses). `output` is three-state: `undefined` leaves the
   * existing output target untouched, a sum-bus name redirects there, and the reserved word
   * `"master"` clears it back to the hardware bus (#517 S3 — see `EngineWrap::set_bus_routing`
   * in `engine_wrap.rs` for the wire encoding, where `1` means Master). `sends` is the FULL
   * current send list for `seqBus` — callers
   * must re-send previously-set sends alongside a new one (the daemon only touches the
   * enumerated entries, so a shorter list does not clear the others, but callers should still
   * pass the complete set to keep engine state and TS-side state visibly in sync).
   */
  setBusRouting?(
    seqBus: string,
    output: string | undefined,
    sends: { bus: string; gain: number }[],
  ): Promise<void>
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
