import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 3 (#231) — `[ ]` stack parsing (§4, §6).
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §4 (Brackets), §6 (Chord Values)
 *
 * Parser-level: the PlayStack AST shape, numeric / altered / subtree voices, the
 * structural `^N` rule (rangeSet cleared, §2.4), the whole-stack `^N`, chord-name
 * refs and `-N` removal markers, and that `[ ]` nests inside `( )` / scope groups.
 * The audio-vs-MIDI rejection is a dispatch-time test (sequence-stack-dispatch).
 */
function firstArg(src: string): any {
  return parseAudioDSL(src).statements[0].args[0]
}

describe('Phase 3 — [ ] stack parsing', () => {
  it('[1, 3, 5] → PlayStack with three numeric voices', () => {
    expect(firstArg('seq.play([1, 3, 5])')).toEqual({ type: 'stack', voices: [1, 3, 5] })
  })

  it('[b3, 5, b7] → altered voices stay PlayPitch, bare degree stays a number', () => {
    const stack = firstArg('seq.play([b3, 5, b7])')
    expect(stack.type).toBe('stack')
    expect(stack.voices[0]).toMatchObject({ type: 'pitch', degree: 3, alteration: -1 })
    expect(stack.voices[1]).toBe(5)
    expect(stack.voices[2]).toMatchObject({ type: 'pitch', degree: 7, alteration: -1 })
  })

  it('[1, (5, 3, 2, 1)] → a held voice + an independent subtree voice (§4)', () => {
    const stack = firstArg('seq.play([1, (5, 3, 2, 1)])')
    expect(stack.voices[0]).toBe(1)
    expect(stack.voices[1]).toMatchObject({ type: 'nested', elements: [5, 3, 2, 1] })
  })

  it('a stack voice `^N` is STRUCTURAL — rangeSet cleared (§2.4)', () => {
    const stack = firstArg('seq.play([1, b7^+1])')
    expect(stack.voices[1]).toMatchObject({
      type: 'pitch',
      degree: 7,
      alteration: -1,
      octaveShift: 1,
      rangeSet: false,
    })
  })

  it('trailing `]^+1` → a whole-stack octaveShift on the node', () => {
    expect(firstArg('seq.play([1, b3, 5]^+1)')).toMatchObject({
      type: 'stack',
      octaveShift: 1,
    })
  })

  it('a bare chord-name voice → PlayChordRef (resolved at evaluation)', () => {
    expect(firstArg('seq.play([m7])').voices[0]).toEqual({
      type: 'chord_ref',
      name: 'm7',
      octaveShift: 0,
    })
  })

  it('chord-name with `^+1` → chord_ref octaveShift', () => {
    expect(firstArg('seq.play([m7^+1])').voices[0]).toEqual({
      type: 'chord_ref',
      name: 'm7',
      octaveShift: 1,
    })
  })

  it('removal `-5` → PlayChordRemoval (literal key)', () => {
    expect(firstArg('seq.play([m7, -5])').voices[1]).toEqual({
      type: 'chord_removal',
      degree: 5,
      alteration: 0,
    })
  })

  it('altered removal `-b3` → degree 3, alteration -1', () => {
    expect(firstArg('seq.play([m7, -b3])').voices[1]).toEqual({
      type: 'chord_removal',
      degree: 3,
      alteration: -1,
    })
  })

  it('[ ] nests inside a `( )` scope group: ([1,3,5]).root(2)', () => {
    const scoped = firstArg('seq.play(([1, 3, 5]).root(2))')
    expect(scoped.type).toBe('scoped')
    expect(scoped.groups[0]).toMatchObject({ type: 'nested' })
    expect(scoped.groups[0].elements[0]).toEqual({ type: 'stack', voices: [1, 3, 5] })
  })
})
