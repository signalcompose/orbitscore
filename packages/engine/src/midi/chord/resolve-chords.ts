/**
 * Chord resolution (§6): the evaluation step (L2) that turns a RAW play pattern
 * — one that may carry chord-name refs (`m7`), removal markers (`-5`), and stack
 * octave shifts (`m7^+1`) — into a pure symbolic pattern (numbers / PlayPitch /
 * PlayStack / PlayNested) that the timing walk and MIDI dispatch can consume.
 *
 * Pure: the chord namespace is injected as a `getChord` lookup, so this module
 * has no I/O and is fully unit-testable. Resolution is "評価時値渡し" (§6.5.2) —
 * it runs once at play()/define time against the namespace as it exists then, so a
 * later redefinition does not retro-affect an already-resolved pattern.
 *
 * Rules (§6):
 *  - Spread: a chord ref inside a `[ ]` stack (or as a bare group element) expands
 *    to its voices; same rule at definition site (`chord([m7, 9])`) and use site.
 *  - Removal `-N`: removes the LITERAL-matching voice (degree + alteration) from the
 *    spread stack; no match = no-op + warning (literal match only — §6 rejects
 *    resolved-pitch matching as context-dependent).
 *  - `^N` on a ref = a whole-chord structural octave shift on that ref's voices.
 */
import { PlayElement, PlayChordRef, PlayChordRemoval, StackElement } from '../../parser/types'

import { ChordVoice } from './types'

/** Namespace lookup: a chord name → its voices, or undefined if unbound. */
export type ChordLookup = (name: string) => ChordVoice[] | undefined

export interface ResolveResult {
  elements: PlayElement[]
  /** Diagnostics (no-match removals, unknown chord names) — surfaced by the caller. */
  warnings: string[]
}

/** A close-position chord voice → a play element (a bare degree when plain). */
function voiceToElement(voice: ChordVoice): PlayElement {
  if (voice.alteration === 0 && voice.octaveShift === 0 && voice.detune === 0) {
    return voice.degree
  }
  return {
    type: 'pitch',
    degree: voice.degree,
    alteration: voice.alteration,
    octaveShift: voice.octaveShift,
    rangeSet: false, // §2.4: a chord voice's octave is structural, never a range set point
    detune: voice.detune,
  }
}

/** True if a resolved voice element literally matches a removal's (degree, alteration). */
function matchesRemoval(el: PlayElement, removal: PlayChordRemoval): boolean {
  if (typeof el === 'number') {
    return el === removal.degree && removal.alteration === 0
  }
  return (
    typeof el === 'object' &&
    el.type === 'pitch' &&
    el.degree === removal.degree &&
    el.alteration === removal.alteration
  )
}

/** Spread a chord ref into its voices, folding the ref's `^N` into each voice. */
function spreadRef(ref: PlayChordRef, getChord: ChordLookup, warnings: string[]): PlayElement[] {
  const voices = getChord(ref.name)
  if (!voices) {
    warnings.push(
      `unknown chord "${ref.name}" — reference left empty (§6). Did you \`import chords\`?`,
    )
    return []
  }
  return voices.map((vc) =>
    voiceToElement({ ...vc, octaveShift: vc.octaveShift + ref.octaveShift }),
  )
}

/**
 * Evaluate a stack's raw voices: spread chord refs, apply `-N` removals to the
 * accumulated voices (left to right, §6), and recurse into subtree voices.
 */
function evaluateStackVoices(
  voices: StackElement[],
  getChord: ChordLookup,
  warnings: string[],
): PlayElement[] {
  const result: PlayElement[] = []
  for (const voice of voices) {
    if (voice && typeof voice === 'object' && voice.type === 'chord_ref') {
      result.push(...spreadRef(voice, getChord, warnings))
    } else if (voice && typeof voice === 'object' && voice.type === 'chord_removal') {
      const before = result.length
      for (let i = result.length - 1; i >= 0; i--) {
        if (matchesRemoval(result[i]!, voice)) result.splice(i, 1)
      }
      if (result.length === before) {
        const acc =
          voice.alteration < 0 ? 'b'.repeat(-voice.alteration) : '#'.repeat(voice.alteration)
        warnings.push(`removal "-${acc}${voice.degree}" matched no voice — no-op (§6).`)
      }
    } else {
      // A literal voice (number / PlayPitch) or a subtree voice ((5,3,2,1) etc.):
      // recurse so any chord ref nested inside a subtree is also resolved.
      result.push(resolveElement(voice as PlayElement, getChord, warnings))
    }
  }
  return result
}

/** Resolve a single play element, recursing through groups / stacks / modifiers. */
function resolveElement(el: PlayElement, getChord: ChordLookup, warnings: string[]): PlayElement {
  if (!el || typeof el !== 'object') return el // bare degree / slice number
  switch (el.type) {
    case 'stack': {
      const resolved = evaluateStackVoices(el.voices, getChord, warnings)
      return el.octaveShift !== undefined
        ? { type: 'stack', voices: resolved, octaveShift: el.octaveShift }
        : { type: 'stack', voices: resolved }
    }
    case 'chord_ref':
      // A bare chord ref as a standalone element → a one-slot simultaneous stack.
      return { type: 'stack', voices: spreadRef(el, getChord, warnings) }
    case 'nested':
      return {
        type: 'nested',
        elements: el.elements.map((e) => resolveElement(e, getChord, warnings)),
      }
    case 'scoped':
      return { ...el, groups: el.groups.map((e) => resolveElement(e, getChord, warnings)) }
    case 'modified':
      return el.value && typeof el.value === 'object' && el.value.type === 'nested'
        ? {
            ...el,
            value: {
              type: 'nested',
              elements: el.value.elements.map((e) => resolveElement(e, getChord, warnings)),
            },
          }
        : el
    default:
      return el // pitch — already symbolic
  }
}

/**
 * Resolve chord refs / removals / shifts across a whole play pattern, producing a
 * pure symbolic pattern. The single entry point used by Sequence.play (§6 L2).
 */
export function resolveChords(elements: PlayElement[], getChord: ChordLookup): ResolveResult {
  const warnings: string[] = []
  const resolved = elements.map((e) => resolveElement(e, getChord, warnings))
  return { elements: resolved, warnings }
}
