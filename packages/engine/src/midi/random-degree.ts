import type { PlayElement } from '../parser/types'
import type { TimedEvent } from '../timing/calculation/types'

import { IONIAN, resolveDegree } from './degree-resolution'
import type { ResolvedPitch, RootContext, SymbolicPitch } from './types'

function latticeFor(event: TimedEvent, context: RootContext): readonly number[] {
  return event.randomDegree?.lattice ?? context.modeLattice ?? IONIAN
}

/** Eager validation without consuming randomness: scope resolution + lattice integrity only. */
export function validateRandomDegree(event: TimedEvent, context: RootContext): readonly number[] {
  const lattice = latticeFor(event, context)
  if (lattice.length === 0 || lattice.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `random degree (${event.randomDegree?.from ?? 'scope'}): pitch lattice is empty or invalid`,
    )
  }
  return lattice
}

/** #967 output Stage A: choose one lattice index per TimedEvent / loop iteration, then resolve. */
export function resolveRandomDegree(
  event: TimedEvent,
  written: SymbolicPitch,
  context: RootContext,
  effectiveOctave: number,
): ResolvedPitch | null {
  if (!event.randomDegree) {
    return resolveDegree({ ...written, octaveShift: effectiveOctave }, context)
  }
  const lattice = validateRandomDegree(event, context)
  const degree = Math.floor(Math.random() * lattice.length) + 1
  const randomContext: RootContext = {
    ...context,
    modeLattice: lattice,
    modePeriod: event.randomDegree.period ?? context.modePeriod ?? 12,
  }
  return resolveDegree({ ...written, degree, octaveShift: effectiveOctave }, randomContext)
}

/** Find random pitch leaves after name resolution; used only for the audio-domain W4 guard. */
export function containsRandomDegree(elements: readonly PlayElement[]): boolean {
  const visit = (element: PlayElement): boolean => {
    if (!element || typeof element !== 'object') return false
    if (element.type === 'random_degree') return true
    if (element.type === 'nested' || element.type === 'legato') {
      return element.elements.some(visit)
    }
    if (element.type === 'scoped') return element.groups.some(visit)
    if (element.type === 'stack') return element.voices.some((voice) => visit(voice as PlayElement))
    if (element.type === 'repeat') return visit(element.element)
    if (element.type === 'voicing') return visit(element.target)
    if (element.type === 'modified' && typeof element.value === 'object')
      return visit(element.value)
    return false
  }
  return elements.some(visit)
}

/** Emit W4 at audio dispatch and clear the per-pattern pending flag. */
export function warnAudioRandomDegree(pending: boolean): false {
  if (pending)
    console.warn('r は note シーケンスの音高の乱数です。audio シーケンスでは休符として扱います')
  return false
}
