/**
 * Event scheduler utilities for Sequence
 * Handles event scheduling logic
 */

import * as path from 'path'

import { RandomValue } from '../../../parser/audio-parser'
import { ScheduleEventsOptions, ScheduleEventsFromTimeOptions } from '../types'
import { generateRandomValue } from '../parameters/random-utils'

/**
 * Verify that an audio file path is absolute, logging and returning `undefined` if not
 * instead of throwing (#645 PR-D0).
 *
 * `audioFilePath` should always be absolute since `sequence.audio()` absolutizes it at
 * set time — reaching here with a relative path is an internal invariant violation, not
 * something a DSL author can trigger. It used to throw, but this function runs on the
 * live playback path (`scheduleEvents` / `scheduleEventsFromTime`, called from every bar
 * of a running loop): a throw here killed the awaited call chain for every OTHER
 * sequence scheduled in the same pass too, not just this one (live coding — a stopped
 * performance is worse than one silently-skipped sequence with a logged reason). The
 * caller is responsible for treating `undefined` as "skip this sequence, keep going".
 */
function resolveAudioFilePath(audioFilePath: string, sequenceName: string): string | undefined {
  if (!path.isAbsolute(audioFilePath)) {
    console.error(
      `[ERROR] Sequence '${sequenceName}': audio file path is not absolute: "${audioFilePath}". ` +
        `This is an internal error — sequence.audio() should have absolutized the path. ` +
        `このシーケンスは無音でスキップします。`,
    )
    return undefined
  }
  return audioFilePath
}

/**
 * Calculate final gain for event
 * Handles random gain generation, mute state, and master gain
 */
function calculateEventGain(
  gainDb: number,
  gainRandom: RandomValue | undefined,
  masterGainDb: number,
  isMuted: boolean,
): number {
  // Generate random gain if specified
  let sequenceGainDb = gainDb
  if (gainRandom) {
    sequenceGainDb = generateRandomValue(gainRandom, -60, 12)
  }

  // 🔴 master gain は **ここで畳み込まない**（#643 PR-2）。
  //
  // ⚠️ **insert との順序は変わっていない**。gain ramp は `render_multi_feeds`（gain 適用）→
  // post-loop の `processor.process`（insert）の順なので、**master は今も insert の前**。
  // これは spec の既知制約（`INSTRUCTION_ORBITSCORE_DSL.md`: 「master gain ramp は
  // per-sequence insert の**前**に適用される（DAW の『fader は insert 後』と逆）」）で、
  // 本 PR のスコープ外。#648 レビューで当初「解消した」と誤記したので明記しておく。
  //
  // マスターフェーダーは**event 混合後に1回だけ**掛かるもので、各ソースへ配るものではない。daemon 側の `render_multi` が
  // gain ramp として適用する（`Global.gain()` → `setGlobalGain`）。
  //
  // 旧実装は `sequenceGainDb + masterGainDb` を返しており、(a) instrument の note 経路には
  // この畳み込みが無いため **マスターが一切効かず**、(b) daemon の gain ramp が使われていなかった。
  //
  // `masterGainDb === -Infinity`（完全無音）だけは残す — daemon 側の gain が 0.0 になるまでの
  // ramp 中に音が漏れるのを避けるため、発音側でも落とす。
  if (isMuted) {
    return -Infinity
  } else if (sequenceGainDb === -Infinity || masterGainDb === -Infinity) {
    return -Infinity
  } else {
    return sequenceGainDb
  }
}

/**
 * Schedule events for sequence
 */
export async function scheduleEvents(options: ScheduleEventsOptions): Promise<void> {
  const {
    scheduler,
    loopIteration = 0,
    baseTime = 0,
    audioFilePath,
    timedEvents,
    chopDivisions,
    gainDb,
    gainRandom,
    pan,
    panRandom,
    isMuted,
    sequenceName,
    masterGainDb,
    patternDuration,
    outputChannel,
    insertBus,
  } = options

  if (!audioFilePath || !timedEvents || timedEvents.length === 0) {
    return
  }

  // Resolve the audio file path to an absolute path. #645 PR-D0: `undefined` means the
  // invariant was violated — skip this sequence's events rather than throw (which would
  // also kill every other sequence scheduled in the same awaited call chain).
  const resolvedFilePath = resolveAudioFilePath(audioFilePath, sequenceName)
  if (!resolvedFilePath) {
    return
  }

  // Schedule events for current iteration
  const loopOffset = loopIteration * patternDuration

  for (const event of timedEvents) {
    if (event.sliceNumber > 0) {
      // 0 is silence
      const startTimeMs = baseTime + event.startTime + loopOffset

      // Calculate final gain using helper function
      const finalGainDb = calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted)

      // Generate random pan if specified
      const eventPan = panRandom ? generateRandomValue(panRandom, -100, 100) : pan

      // Schedule event (argPath = #390 live playhead marker, observational only)
      if (chopDivisions && chopDivisions > 1) {
        const eventDuration = event.duration && event.duration > 0 ? event.duration : undefined
        scheduler.scheduleSliceEvent(
          resolvedFilePath,
          startTimeMs,
          event.sliceNumber,
          chopDivisions,
          eventDuration,
          finalGainDb,
          eventPan,
          sequenceName,
          outputChannel,
          event.argPath,
          insertBus,
        )
      } else {
        scheduler.scheduleEvent(
          resolvedFilePath,
          startTimeMs,
          finalGainDb,
          eventPan,
          sequenceName,
          outputChannel,
          event.argPath,
          insertBus,
        )
      }
    } else if (event.sliceNumber === 0 && event.argPath !== undefined) {
      // 0 is silence — no audio dispatch, but the live playhead still steps
      // through the rest slot (#390 owner request 2026-07-07): the sequence is
      // processing the silence, so the highlight should land on it. gainDb
      // carries the slot's mute/master gain so muted sequences skip markers
      // exactly like they skip notes.
      scheduler.scheduleStepMarker?.(
        baseTime + event.startTime + loopOffset,
        sequenceName,
        event.argPath,
        calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted),
      )
    }
  }
}

/**
 * Schedule events from a specific time onwards
 */
export function scheduleEventsFromTime(options: ScheduleEventsFromTimeOptions): void {
  const {
    scheduler,
    fromTime,
    audioFilePath,
    timedEvents,
    chopDivisions,
    gainDb,
    gainRandom,
    pan,
    panRandom,
    isMuted,
    sequenceName,
    loopStartTime,
    masterGainDb,
    patternDuration,
    outputChannel,
    insertBus,
  } = options

  if (!timedEvents || !audioFilePath) {
    return
  }

  // #645 PR-D0: same skip-not-throw contract as scheduleEvents() above.
  const resolvedFilePath = resolveAudioFilePath(audioFilePath, sequenceName)
  if (!resolvedFilePath) {
    return
  }

  // Calculate which loop iteration we're in
  const elapsedTime = fromTime - (loopStartTime || 0)
  const currentIteration = Math.floor(elapsedTime / patternDuration)

  // Debug logging to understand scheduling behavior
  console.log(
    `🔧 [scheduleFromTime] ${sequenceName}: fromTime=${fromTime}ms, loopStartTime=${loopStartTime}ms, elapsed=${elapsedTime}ms, iteration=${currentIteration}, patternDur=${patternDuration}ms`,
  )

  // Schedule remaining events in current iteration + next iteration
  for (let iter = currentIteration; iter < currentIteration + 2; iter++) {
    const loopOffset = iter * patternDuration
    const baseTime = (loopStartTime || 0) + loopOffset

    for (const event of timedEvents) {
      if (event.sliceNumber > 0) {
        const startTimeMs = baseTime + event.startTime

        // Skip events that are in the past
        if (startTimeMs <= fromTime) {
          console.log(
            `🔧 [scheduleFromTime] ${sequenceName}: SKIP past event at ${startTimeMs}ms (fromTime=${fromTime}ms)`,
          )
          continue
        }

        console.log(
          `🔧 [scheduleFromTime] ${sequenceName}: SCHEDULE event at ${startTimeMs}ms (fromTime=${fromTime}ms)`,
        )

        // Calculate final gain using helper function
        const finalGainDb = calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted)

        // Generate random pan if specified
        const eventPan = panRandom ? generateRandomValue(panRandom, -100, 100) : pan

        // Schedule event (argPath = #390 live playhead marker, observational only)
        if (chopDivisions && chopDivisions > 1) {
          const eventDuration = event.duration && event.duration > 0 ? event.duration : undefined
          scheduler.scheduleSliceEvent(
            resolvedFilePath,
            startTimeMs,
            event.sliceNumber,
            chopDivisions,
            eventDuration,
            finalGainDb,
            eventPan,
            sequenceName,
            outputChannel,
            event.argPath,
            insertBus,
          )
        } else {
          scheduler.scheduleEvent(
            resolvedFilePath,
            startTimeMs,
            finalGainDb,
            eventPan,
            sequenceName,
            outputChannel,
            event.argPath,
            insertBus,
          )
        }
      } else if (event.sliceNumber === 0 && event.argPath !== undefined) {
        // Rest slot (#390): marker-only, same past-event guard as notes.
        const startTimeMs = baseTime + event.startTime
        if (startTimeMs <= fromTime) continue
        scheduler.scheduleStepMarker?.(
          startTimeMs,
          sequenceName,
          event.argPath,
          calculateEventGain(gainDb, gainRandom, masterGainDb, isMuted),
        )
      }
    }
  }
}
