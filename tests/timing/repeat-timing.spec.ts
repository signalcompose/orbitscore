import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { resolveChords } from '../../packages/engine/src/midi/chord/resolve-chords'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { PlayElement } from '../../packages/engine/src/parser/types'

/**
 * Phase R (#227) — `*n` resolution + timing (§6.5): `x*n` expands to n JUXTAPOSED
 * copies (slot-occupying, Tidal `!` — not in-slot division). Domain-common: works on
 * bare slice-number / degree values with no pitch resolution.
 */
const noBindings = () => undefined

function resolvedTiming(src: string, bar = 3000) {
  const args = parseAudioDSL(`seq.play(${src})`).statements[0].args as PlayElement[]
  const { elements } = resolveChords(args, noBindings)
  return calculateEventTiming(elements, bar)
}

describe('Phase R — *n resolution + timing (§6.5)', () => {
  it('1*3 expands to three equal juxtaposed slots', () => {
    const ev = resolvedTiming('1*3', 3000)
    expect(ev.map((e) => [e.sliceNumber, e.startTime, e.duration])).toEqual([
      [1, 0, 1000],
      [1, 1000, 1000],
      [1, 2000, 1000],
    ])
  })

  it('*1 is identity (one slot)', () => {
    const ev = resolvedTiming('5*1', 1000)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ sliceNumber: 5, startTime: 0, duration: 1000 })
  })

  it('(1, 0)*4 → 4 sibling groups, each subdividing its slot', () => {
    const ev = resolvedTiming('(1, 0)*4', 4000)
    expect(ev).toHaveLength(8) // 4 groups × 2 elements
    // the `1` of each group lands at the group boundaries
    expect(ev.filter((e) => e.sliceNumber === 1).map((e) => e.startTime)).toEqual([
      0, 1000, 2000, 3000,
    ])
  })

  it('a repeat inside a group occupies slots (juxtaposition): (1*2, 5) = (1, 1, 5)', () => {
    // §6.5: `*n` is slot-OCCUPYING (Tidal `!`), NOT in-slot division. So `1*2`
    // juxtaposes two 1s, making the group three equal slots: (1, 1, 5).
    const ev = resolvedTiming('(1*2, 5)', 3000)
    expect(ev.map((e) => [e.sliceNumber, e.startTime, e.duration])).toEqual([
      [1, 0, 1000],
      [1, 1000, 1000],
      [5, 2000, 1000],
    ])
  })

  it('audio-style: (1, 0, 1, 0)*4 = 4 bars in one group (slice-number values)', () => {
    const ev = resolvedTiming('(1, 0, 1, 0)*4', 4000)
    expect(ev).toHaveLength(16) // 4 groups × 4 slices
    expect(ev.every((e) => e.pitch === undefined)).toBe(true) // pure structural, no pitch (§6.5)
  })
})
