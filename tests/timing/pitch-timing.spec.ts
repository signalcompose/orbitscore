import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { PlayElement } from '../../packages/engine/src/parser/types'

/**
 * Phase 1 increment 2b (#228) — timing carries symbolic pitch (§7-0)
 *
 * The rhythm tree gives startTime/duration; pitch events additionally carry the
 * unresolved SymbolicPitch so the MIDI output adapter can number them later.
 */

function playElements(src: string): PlayElement[] {
  return parseAudioDSL(src).statements[0].args as PlayElement[]
}

describe('calculateEventTiming — symbolic pitch (§7-0)', () => {
  it('carries pitch on altered degrees, leaves bare numbers without pitch', () => {
    const events = calculateEventTiming(playElements('seq.play(1, b3, 5, #4)'), 2000)

    expect(events).toHaveLength(4)
    // bare numbers: no pitch field
    expect(events[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 500 })
    expect(events[0].pitch).toBeUndefined()
    // b3 carries symbolic pitch
    expect(events[1]).toMatchObject({
      startTime: 500,
      duration: 500,
      pitch: { degree: 3, alteration: -1, octaveShift: 0, detune: 0 },
    })
    expect(events[2].pitch).toBeUndefined()
    // #4
    expect(events[3].pitch).toMatchObject({ degree: 4, alteration: 1 })
  })

  it('preserves octave shift and detune through timing', () => {
    const events = calculateEventTiming(playElements('seq.play(3^+1, b7~-0.25)'), 1000)
    expect(events[0].pitch).toMatchObject({ degree: 3, octaveShift: 1 })
    expect(events[1].pitch).toMatchObject({ degree: 7, alteration: -1, detune: -0.25 })
  })

  it('carries pitch inside nested groups with correct timing', () => {
    // (1, b3) splits the bar in two; b3 starts at the half
    const events = calculateEventTiming(playElements('seq.play((1, b3))'), 2000)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 1000 })
    expect(events[1]).toMatchObject({
      startTime: 1000,
      duration: 1000,
      pitch: { degree: 3, alteration: -1 },
    })
  })

  it('regression: pure audio slice patterns are unchanged (no pitch field)', () => {
    const events = calculateEventTiming(playElements('seq.play(1, 0, 2, 0)'), 1000)
    expect(events).toHaveLength(4)
    expect(events.every((e) => e.pitch === undefined)).toBe(true)
    expect(events.map((e) => e.sliceNumber)).toEqual([1, 0, 2, 0])
  })
})
