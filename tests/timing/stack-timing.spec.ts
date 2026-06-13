import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { PlayElement } from '../../packages/engine/src/parser/types'

/**
 * Phase 3 (#231) — `[ ]` stack timing (§4): parallel recursion.
 *
 * A stack occupies ONE sibling slot; every voice shares the SAME startTime and the
 * FULL slot duration (not divided like `( )`). A subtree voice subdivides the same
 * span the held voices occupy. The whole-stack `^N` adds a structural octaveShift
 * (rangeSet stays false — §2.4, it never moves the running range).
 */
function playElements(src: string): PlayElement[] {
  return parseAudioDSL(src).statements[0].args as PlayElement[]
}

describe('Phase 3 — stack timing (parallel recursion)', () => {
  it('[1, 3, 5] — all three voices share startTime and the full bar', () => {
    const events = calculateEventTiming(playElements('seq.play([1, 3, 5])'), 2000)
    expect(events).toHaveLength(3)
    for (const e of events) {
      expect(e.startTime).toBe(0)
      expect(e.duration).toBe(2000)
    }
    expect(events.map((e) => e.sliceNumber).sort()).toEqual([1, 3, 5])
  })

  it('a stack as one of two slots occupies only its slot; voices simultaneous', () => {
    // play(1, [1,3,5]) — two slots of 1000ms; the stack is the second slot.
    const events = calculateEventTiming(playElements('seq.play(1, [1, 3, 5])'), 2000)
    expect(events[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 1000 })
    const stackEvents = events.slice(1)
    expect(stackEvents).toHaveLength(3)
    for (const e of stackEvents) {
      expect(e.startTime).toBe(1000)
      expect(e.duration).toBe(1000)
    }
  })

  it('[1, (5,3,2,1)] — held voice spans the slot while the subtree subdivides it', () => {
    const events = calculateEventTiming(playElements('seq.play([1, (5, 3, 2, 1)])'), 2000)
    // Voice 1: degree 1 spans the full bar.
    const held = events.find((e) => e.sliceNumber === 1 && e.duration === 2000)
    expect(held).toBeDefined()
    expect(held!.startTime).toBe(0)
    // Subtree: 5,3,2,1 each 500ms, sequential within the same span.
    const sub = events.filter((e) => e.duration === 500)
    expect(sub.map((e) => [e.sliceNumber, e.startTime])).toEqual([
      [5, 0],
      [3, 500],
      [2, 1000],
      [1, 1500],
    ])
  })

  it('whole-stack `^+1` adds a structural octaveShift to every voice (rangeSet false)', () => {
    const events = calculateEventTiming(playElements('seq.play([1, 3, 5]^+1)'), 2000)
    expect(events).toHaveLength(3)
    for (const e of events) {
      expect(e.pitch).toMatchObject({ octaveShift: 1, rangeSet: false })
    }
  })

  it('a voice `^+1` is structural on that voice only', () => {
    const events = calculateEventTiming(playElements('seq.play([1, b7^+1])'), 2000)
    const shifted = events.find((e) => e.pitch?.degree === 7)
    expect(shifted!.pitch).toMatchObject({ octaveShift: 1, rangeSet: false })
    // The plain voice 1 carries no structural shift.
    const plain = events.find((e) => e.sliceNumber === 1)
    expect(plain!.pitch).toBeUndefined()
  })
})
