import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'
import { PlayElement } from '../../packages/engine/src/parser/types'

/**
 * Phase 2 (#230) — scope capture in the timing walk (§3).
 *
 * The lexical scope (`.root()`/`.mode()`/`.oct()`) is resolved inner→outer here,
 * where the nesting is still visible, and attached to each leaf TimedEvent as a
 * symbolic descriptor (§7-0 — not yet a MIDI number). A scoped run is
 * timing-transparent: it produces the same slots as the equivalent no-chain
 * juxtaposition.
 */
function playElements(src: string): PlayElement[] {
  return parseAudioDSL(src).statements[0].args as PlayElement[]
}

const slots = (events: ReturnType<typeof calculateEventTiming>) =>
  events.map((e) => [e.sliceNumber, e.startTime, e.duration])

describe('Phase 2 — calculateEventTiming scope descriptor + timing transparency', () => {
  it('a .root(note) group attaches the scope to each leaf; timing matches no-chain', () => {
    const scoped = calculateEventTiming(playElements('seq.play((1, 3, 5).root(F#))'), 2000)
    const plain = calculateEventTiming(playElements('seq.play((1, 3, 5))'), 2000)

    expect(slots(scoped)).toEqual(slots(plain)) // timing-transparent
    for (const e of scoped) {
      expect(e.scope).toMatchObject({ root: { kind: 'note', pitchClass: 6 } })
    }
    expect(plain[0].scope).toBeUndefined() // no-chain carries no scope
  })

  it('juxtaposition (A)(B).root(3) has the same slots as (A)(B); scope on all leaves', () => {
    const scoped = calculateEventTiming(playElements('seq.play((1, 0)(0, 1).root(3))'), 2000)
    const plain = calculateEventTiming(playElements('seq.play((1, 0)(0, 1))'), 2000)

    expect(slots(scoped)).toEqual(slots(plain))
    expect(scoped).toHaveLength(4)
    for (const e of scoped) {
      expect(e.scope?.root).toMatchObject({ kind: 'degree', degree: 3 })
    }
  })

  it('inner .root() overrides outer (inner→outer resolution)', () => {
    // ((1).root(b6), 5).root(2): the 1 resolves to b6 (inner), the 5 to 2 (outer)
    const events = calculateEventTiming(playElements('seq.play(((1).root(b6), 5).root(2))'), 2000)
    expect(events).toHaveLength(2)
    expect(events[0].scope?.root).toMatchObject({ kind: 'degree', degree: 6, alteration: -1 })
    expect(events[1].scope?.root).toMatchObject({ kind: 'degree', degree: 2 })
  })

  it('.oct(N) attaches groupOct independently of root', () => {
    const events = calculateEventTiming(playElements('seq.play((1, 5).root(3).oct(1))'), 2000)
    for (const e of events) {
      expect(e.scope?.root).toMatchObject({ kind: 'degree', degree: 3 })
      expect(e.scope?.groupOct).toBe(1)
    }
  })
})
