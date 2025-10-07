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
