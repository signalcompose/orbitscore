import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { PlayElement } from '../../packages/engine/src/parser/types'

/**
 * Phase 4 (#236) — tie/legato timing tags (§5/§4). A `_` emits a slot-occupying
 * tie marker (no pitch); a `{ }` group divides like `( )` and tags its INTERIOR
 * notes legato (the tail keeps normal gate).
 */
function playElements(src: string): PlayElement[] {
  return parseAudioDSL(src).statements[0].args as PlayElement[]
}

describe('Phase 4 — tie / legato timing (§5/§4)', () => {
  it('`(1, _, 3)` → the middle slot is a tie marker (no pitch)', () => {
    const ev = calculateEventTiming(playElements('seq.play(1, _, 3)'), 3000)
    expect(ev).toHaveLength(3)
    expect(ev[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 1000 })
    expect(ev[1]).toMatchObject({ startTime: 1000, duration: 1000, tie: true })
    expect(ev[1].pitch).toBeUndefined()
    expect(ev[2]).toMatchObject({ sliceNumber: 3, startTime: 2000 })
  })

  it('`{1, 2, 3}` divides like `( )` and tags interior notes legato (tail untagged)', () => {
    const ev = calculateEventTiming(playElements('seq.play({1, 2, 3})'), 3000)
    expect(ev).toHaveLength(3)
    expect(ev.map((e) => [e.sliceNumber, e.startTime, e.duration])).toEqual([
      [1, 0, 1000],
      [2, 1000, 1000],
      [3, 2000, 1000],
    ])
    expect(ev[0].legato).toBe(true)
    expect(ev[1].legato).toBe(true)
    expect(ev[2].legato).toBeUndefined() // tail follows normal gate
  })

  it('a `_5` voice in a stack carries voiceTie onto its timed event', () => {
    const ev = calculateEventTiming(playElements('seq.play([1, _5])'), 2000)
    const five = ev.find((e) => e.pitch?.degree === 5)
    expect(five?.voiceTie).toBe(true)
    const one = ev.find((e) => e.sliceNumber === 1)
    expect(one?.voiceTie).toBeUndefined()
  })
})
