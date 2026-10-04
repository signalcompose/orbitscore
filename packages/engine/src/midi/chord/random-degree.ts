import type { PlayChordRef, PlayRandomDegree } from '../../parser/types'

import type { BoundValue, ChordVoice } from './types'

type RandomBinding = Extract<BoundValue, { kind: 'random' }>
type RandomDegreeProperties = {
  lattice?: readonly number[]
  period?: number
  from?: string
  random?: number
  randomOctave?: boolean
  velocity?: number
  velocityDelta?: number
  articulation?: number
}

type CopiedRandomDegreeProperties = {
  source: {
    lattice?: number[]
    period?: number
    from?: string
  }
  modifiers: Pick<
    RandomDegreeProperties,
    'random' | 'randomOctave' | 'velocity' | 'velocityDelta' | 'articulation'
  >
}

/** Copy the optional source lattice and note modifiers carried by a random degree. */
export function copyRandomDegreeProperties(
  source: RandomDegreeProperties,
): CopiedRandomDegreeProperties {
  return {
    source: {
      ...(source.lattice !== undefined && { lattice: [...source.lattice] }),
      ...(source.period !== undefined && { period: source.period }),
      ...(source.from !== undefined && { from: source.from }),
    },
    modifiers: {
      ...(source.random !== undefined && { random: source.random }),
      ...(source.randomOctave && { randomOctave: true }),
      ...(source.velocity !== undefined && { velocity: source.velocity }),
      ...(source.velocityDelta !== undefined && { velocityDelta: source.velocityDelta }),
      ...(source.articulation !== undefined && { articulation: source.articulation }),
    },
  }
}

/** Modifiers whose meaning is deliberately unavailable on chord/pattern references (#967 E8). */
export function assertRandomOnlyModifiers(ref: PlayChordRef, kind: 'chord' | 'pattern'): void {
  if (
    ref.random !== undefined ||
    ref.randomOctave ||
    ref.detune !== undefined ||
    ref.velocity !== undefined ||
    ref.velocityDelta !== undefined ||
    ref.articulation !== undefined
  ) {
    throw new Error(
      `"${ref.name}" は ${kind} です。r / ^r / ~ / @v / @g はランダム音源と度数にだけ付けられます`,
    )
  }
}

/** Resolve a random-source name by transferring the copied lattice and every note modifier. */
export function randomBindingToElement(
  ref: PlayChordRef,
  bound: RandomBinding,
  structural = false,
): PlayRandomDegree {
  const source = copyRandomDegreeProperties(bound)
  const modifiers = copyRandomDegreeProperties(ref)
  return {
    type: 'random_degree',
    octaveShift: ref.octaveShift,
    rangeSet: structural ? false : !!ref.rangeSet,
    detune: ref.detune ?? 0,
    ...source.source,
    ...modifiers.modifiers,
  }
}

/** Preserve a random voice inside a stored chord value. */
export function randomElementToChordVoice(element: PlayRandomDegree): ChordVoice {
  const copied = copyRandomDegreeProperties(element)
  return {
    kind: 'random',
    degree: 1,
    alteration: 0,
    octaveShift: element.octaveShift,
    rangeSet: false,
    detune: element.detune,
    ...copied.source,
    ...copied.modifiers,
  }
}

/** Rehydrate a stored chord random voice without choosing its pitch. */
export function randomChordVoiceToElement(voice: ChordVoice, octaveShift = 0): PlayRandomDegree {
  const copied = copyRandomDegreeProperties(voice)
  return {
    type: 'random_degree',
    octaveShift: voice.octaveShift + octaveShift,
    rangeSet: false,
    detune: voice.detune,
    ...copied.source,
    ...copied.modifiers,
  }
}
