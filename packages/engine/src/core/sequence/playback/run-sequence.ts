import type { Scheduler } from '../../global/types'

/**
 * Options for one-shot sequence playback
 */
export interface RunSequenceOptions {
  sequenceName: string
  scheduler: Scheduler
  currentTime: number
  isPlaying: boolean
  scheduleEventsFn: (scheduler: Scheduler, offset: number, baseTime: number) => void
  getPatternDurationFn: () => number
  clearSequenceEventsFn: (sequenceName: string) => void
  setRunTimerFn: (timer: NodeJS.Timeout | undefined) => void
}

/**
 * Result of run sequence operation
 */
export interface RunSequenceResult {
  isPlaying: boolean
  isLooping: boolean
}

/**
 * Execute one-shot playback of a sequence
 *
 * This function:
 * - Schedules events once from current time
 * - Auto-stops after pattern duration
 * - Clears scheduled events on completion
 *
 * @param options - Run sequence options
 * @returns Updated playback state
 */
export function runSequence(options: RunSequenceOptions): RunSequenceResult {
  const {
    sequenceName,
    scheduler,
    currentTime,
    isPlaying,
    scheduleEventsFn,
    getPatternDurationFn,
    clearSequenceEventsFn,
    setRunTimerFn,
  } = options

  // RUN() is imperative: always execute immediately, even if already playing
  // Clear existing events first to prevent overlap
  if (isPlaying) {
    clearSequenceEventsFn(sequenceName)
  }

  console.log(`▶ ${sequenceName} (one-shot)`)

  // Schedule events from current time with a small buffer (100ms) to ensure they're in the future
  const scheduleTime = currentTime + 100
  scheduleEventsFn(scheduler, 0, scheduleTime)

  // Auto-stop after pattern duration
  const patternDuration = getPatternDurationFn()
  // 🔴 `+ 100` と直に書かない。尻尾は**イベントを実際に置いた原点**から測る必要があり、
  // 差で書いておくと `scheduleTime` の決め方が変わっても自動で追随する。この整合こそが
  // 「RUN 終端で音が止まる」の前提なので、定数へ畳んで結合を切らないこと。
  const tailDelay = patternDuration + (scheduleTime - currentTime)
  const runTimer = setTimeout(() => {
    setRunTimerFn(undefined)
    clearSequenceEventsFn(sequenceName)
    console.log(`⏹ ${sequenceName} (finished)`)
  }, tailDelay)
  setRunTimerFn(runTimer)

  return { isPlaying: true, isLooping: false }
}
