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
  scheduleEvent(
    filepath: string,
    time: number,
    gainDb: number,
    pan: number,
    sequenceName: string,
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
  ): void
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
  tick: number
  beat: Meter
  key: string
  audioPath: string
  masterGainDb: number
  masterEffects: MasterEffect[]
  isRunning: boolean
  isLooping: boolean
}
