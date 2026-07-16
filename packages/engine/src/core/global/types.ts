/**
 * Common types for Global class
 */

export interface Meter {
  numerator: number
  denominator: number
}

// Common scheduler interface
export interface Scheduler {
  isRunning: boolean
  startTime: number // Timestamp when scheduler started
  sequenceTimeouts?: Record<string, NodeJS.Timeout> // For tracking sequence timeouts
  start(): void
  stop(): void
  stopAll(): void
  clearSequenceEvents(name: string): void
  reinitializeSequenceTracking(name: string): void
  // argPath (#390 live playhead): dot-joined play() arg indices of the event
  // ("2"; "1.0" reserved for nesting). Observational only — backends may emit a
  // [STEP] stdout marker on dispatch; never affects timing / semantics.
  scheduleEvent(
    filepath: string,
    time: number,
    gainDb: number,
    pan: number,
    sequenceName: string,
    outputChannel?: string,
    argPath?: string,
    // per-sequence insert bus (seq.effect() — PH.2b / #434 S3). Mutually
    // exclusive with outputChannel (LinkAudio and plugin hosting are v1-exclusive).
    insertBus?: string,
  ): void
  scheduleSliceEvent(
    filepath: string,
    time: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number | undefined,
    gainDb: number,
    pan: number,
    sequenceName: string,
    outputChannel?: string,
    argPath?: string,
    insertBus?: string,
  ): void
  /**
   * #390 live playhead: marker-only event for a REST (0) slot — no audio
   * dispatch, only the `[STEP]` stdout marker at the slot's audible time, so
   * the playhead steps through silence the sequence is still processing.
   * `gainDb` carries the same mute/master gain the slot's notes would get,
   * letting the backend skip markers for muted sequences exactly like it
   * skips their notes. Optional: backends without STEP emission
   * (SuperCollider) simply omit it.
   */
  scheduleStepMarker?(time: number, sequenceName: string, argPath: string, gainDb: number): void
  getAudioDuration(filepath: string): number
  loadBuffer?(filepath: string): Promise<any>
  // Master effects (optional, for SuperCollider)
  addEffect?(target: string, effectType: string, params: any): void
  removeEffect?(target: string, effectType: string): void
}

export interface MasterEffect {
  type: string
  params: any
}

export interface GlobalState {
  tempo: number
  beat: Meter
  audioPath: string
  audioPaths: string[]
  documentDirectory: string
  masterGainDb: number
  masterEffects: MasterEffect[]
  isRunning: boolean
  isLooping: boolean
  linkAudioEnabled: boolean
  linkAudioTargetSampleRate?: number
}
