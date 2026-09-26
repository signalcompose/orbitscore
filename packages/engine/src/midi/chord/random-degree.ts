import type { PlayChordRef, PlayRandomDegree } from '../../parser/types'

import type { BoundValue, ChordVoice } from './types'

type RandomBinding = Extract<BoundValue, { kind: 'random' }>

/** Modifiers whose meaning is deliberately unavailable on chord/pattern references (#967 E8). */
export function assertRandomOnlyModifiers(ref: PlayChordRef, kind: 'chord' | 'pattern'): void {
  if (
    ref.randomOctave ||
    ref.detune !== undefined ||
    ref.velocity !== undefined ||
    ref.velocityDelta !== undefined ||
    ref.articulation !== undefined
  ) {
    throw new Error(
      `"${ref.name}" は ${kind} です。^r / ~ / @v / @g はランダム音源と度数にだけ付けられます`,
    )
  }
}

/** Resolve a random-source name by transferring the copied lattice and every note modifier. */
export function randomBindingToElement(
  ref: PlayChordRef,
  bound: RandomBinding,
  structural = false,
): PlayRandomDegree {
  return {
    type: 'random_degree',
    octaveShift: ref.octaveShift,
    rangeSet: structural ? false : !!ref.rangeSet,
    detune: ref.detune ?? 0,
    lattice: [...bound.lattice],
    period: bound.period,
    from: bound.from,
    ...(ref.random !== undefined && { random: ref.random }),
    ...(ref.randomOctave && { randomOctave: true }),
    ...(ref.velocity !== undefined && { velocity: ref.velocity }),
    ...(ref.velocityDelta !== undefined && { velocityDelta: ref.velocityDelta }),
    ...(ref.articulation !== undefined && { articulation: ref.articulation }),
  }
}

/** Preserve a random voice inside a stored chord value. */
export function randomElementToChordVoice(element: PlayRandomDegree): ChordVoice {
  return {
    kind: 'random',
    degree: 1,
    alteration: 0,
    octaveShift: element.octaveShift,
    rangeSet: false,
    detune: element.detune,
    ...(element.lattice && { lattice: [...element.lattice] }),
    ...(element.period !== undefined && { period: element.period }),
    ...(element.from !== undefined && { from: element.from }),
    ...(element.random !== undefined && { random: element.random }),
    ...(element.randomOctave && { randomOctave: true }),
    ...(element.velocity !== undefined && { velocity: element.velocity }),
    ...(element.velocityDelta !== undefined && { velocityDelta: element.velocityDelta }),
    ...(element.articulation !== undefined && { articulation: element.articulation }),
  }
}

/** Rehydrate a stored chord random voice without choosing its pitch. */
export function randomChordVoiceToElement(voice: ChordVoice, octaveShift = 0): PlayRandomDegree {
  return {
    type: 'random_degree',
    octaveShift: voice.octaveShift + octaveShift,
    rangeSet: false,
    detune: voice.detune,
    ...(voice.lattice && { lattice: [...voice.lattice] }),
    ...(voice.period !== undefined && { period: voice.period }),
    ...(voice.from !== undefined && { from: voice.from }),
    ...(voice.random !== undefined && { random: voice.random }),
    ...(voice.randomOctave && { randomOctave: true }),
    ...(voice.velocity !== undefined && { velocity: voice.velocity }),
    ...(voice.velocityDelta !== undefined && { velocityDelta: voice.velocityDelta }),
    ...(voice.articulation !== undefined && { articulation: voice.articulation }),
  }
}
