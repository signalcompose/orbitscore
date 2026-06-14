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
 *    to its voices; same rule at definition site (`[m7, 9]`) and use site.
 *  - Removal `-N`: removes the LITERAL-matching voice (degree + alteration) from the
 *    spread stack; no match = no-op + warning (literal match only — §6 rejects
 *    resolved-pitch matching as context-dependent).
 *  - `^N` on a ref = a whole-chord structural octave shift on that ref's voices.
 */
import { PlayElement, PlayChordRemoval, StackElement } from '../../parser/types'

import { ChordVoice, BoundValue } from './types'

/** Chord-only lookup: a name → its chord voices, or undefined (used by chord definitions + stacks). */
export type ChordLookup = (name: string) => ChordVoice[] | undefined

/** Namespace lookup: a name → its bound value (chord or pattern), or undefined if unbound. */
export type BindingLookup = (name: string) => BoundValue | undefined

export interface ResolveResult {
  elements: PlayElement[]
  /** Diagnostics (no-match removals, unknown names) — surfaced by the caller. */
  warnings: string[]
}

/** Deep-clone a play element so repeated (`*n`) copies are independent objects. */
function cloneElement(el: PlayElement): PlayElement {
  return el && typeof el === 'object' ? (structuredClone(el) as PlayElement) : el
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

/** Spread a chord's voices, folding a ref's `^N` into each voice (stack/chord context). */
function spreadChordVoices(voices: ChordVoice[], octaveShift: number): PlayElement[] {
  return voices.map((vc) => voiceToElement({ ...vc, octaveShift: vc.octaveShift + octaveShift }))
}

/**
 * Resolve a bare NAME reference (§6 / §6.5) by the bound value's `kind`:
 * - chord → a one-slot simultaneous stack (vertical), `^N` shifts the whole chord
 * - pattern → splice the bound elements (horizontal, 1→N), resolving them recursively
 * - unbound → warning + nothing
 *
 * `visiting` holds the pattern names on the current expansion branch (added before
 * recursing, removed after) so a circular reference (`var a = (a)`, or mutual
 * `a → b → a`) is reported and stopped instead of overflowing the stack. It is a
 * branch set, not a global seen-set, so legitimate sibling reuse (`play(riff, riff)`)
 * is unaffected.
 */
function resolveName(
  name: string,
  octaveShift: number,
  getBinding: BindingLookup,
  warnings: string[],
  visiting: Set<string>,
): PlayElement[] {
  const bound = getBinding(name)
  if (!bound) {
    warnings.push(
      `unknown name "${name}" — neither a chord nor a pattern (§6/§6.5). Did you \`import chords\` / \`var ${name} = …\`?`,
    )
    return []
  }
  if (bound.kind === 'chord') {
    return [{ type: 'stack', voices: spreadChordVoices(bound.voices, octaveShift) }]
  }
  // pattern: a horizontal/tree value — splice its (recursively resolved) elements.
  if (visiting.has(name)) {
    warnings.push(
      `circular pattern reference "${name}" — expansion stopped (§6.5). A pattern must not refer to itself.`,
    )
    return []
  }
  if (octaveShift !== 0) {
    warnings.push(`"${name}": \`^N\` is undefined on a pattern reference — ignored (§6.5).`)
  }
  visiting.add(name)
  try {
    return resolveElements(bound.elements, getBinding, warnings, visiting)
  } finally {
    // Always unmark, even if resolution throws, so a later sibling reuse of this
    // name is not falsely flagged as circular (the set stays a clean branch set).
    visiting.delete(name)
  }
}

/**
 * Evaluate a stack's raw voices: spread chord refs (vertical), apply `-N` removals
 * to the accumulated voices (left to right, §6), and recurse subtree voices. A name
 * ref in a stack must be a chord (vertical) — a pattern there is a misuse (warned).
 */
function evaluateStackVoices(
  voices: StackElement[],
  getBinding: BindingLookup,
  warnings: string[],
  visiting: Set<string>,
): PlayElement[] {
  const result: PlayElement[] = []
  for (const voice of voices) {
    if (voice && typeof voice === 'object' && voice.type === 'chord_ref') {
      const bound = getBinding(voice.name)
      if (bound?.kind === 'chord') {
        result.push(...spreadChordVoices(bound.voices, voice.octaveShift))
      } else if (!bound) {
        warnings.push(
          `unknown name "${voice.name}" in a [ ] stack — left empty (§6). Did you \`import chords\` / \`var ${voice.name} = chord(…)\`?`,
        )
      } else {
        warnings.push(`"${voice.name}" in a [ ] stack is a pattern, not a chord (§6) — left empty.`)
      }
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
      // recurse so any name ref / repeat nested inside a subtree is also resolved.
      result.push(resolveElement(voice as PlayElement, getBinding, warnings, visiting))
    }
  }
  return result
}

/** Resolve a single play element (1→1), recursing through groups / stacks / modifiers. */
function resolveElement(
  el: PlayElement,
  getBinding: BindingLookup,
  warnings: string[],
  visiting: Set<string>,
): PlayElement {
  if (!el || typeof el !== 'object') return el // bare degree / slice number
  switch (el.type) {
    case 'stack': {
      const resolved = evaluateStackVoices(el.voices, getBinding, warnings, visiting)
      return el.octaveShift !== undefined
        ? { type: 'stack', voices: resolved, octaveShift: el.octaveShift }
        : { type: 'stack', voices: resolved }
    }
    case 'nested':
      return {
        type: 'nested',
        elements: resolveElements(el.elements, getBinding, warnings, visiting),
      }
    case 'legato':
      // §5.4: a legato group's interior may hold chord refs / `*n` — resolve them.
      return {
        type: 'legato',
        elements: resolveElements(el.elements, getBinding, warnings, visiting),
      }
    case 'scoped':
      return { ...el, groups: resolveElements(el.groups, getBinding, warnings, visiting) }
    case 'modified':
      return el.value && typeof el.value === 'object' && el.value.type === 'nested'
        ? {
            ...el,
            value: {
              type: 'nested',
              elements: resolveElements(el.value.elements, getBinding, warnings, visiting),
            },
          }
        : el
    default:
      return el // pitch — already symbolic (chord_ref / repeat are handled in resolveElements)
  }
}

/**
 * Resolve a list of play elements (1→N): expands `*n` repeats (§6.5, juxtaposition),
 * splices pattern refs, spreads standalone chord refs, and recurses the rest. The
 * 1→N shape is required because a pattern ref or `*n` produces multiple siblings.
 */
function resolveElements(
  els: readonly (PlayElement | string)[],
  getBinding: BindingLookup,
  warnings: string[],
  visiting: Set<string>,
): PlayElement[] {
  const out: PlayElement[] = []
  for (const el of els) {
    if (typeof el === 'string') {
      // A bare name (top-level play arg, e.g. `play(riff, fill)`).
      out.push(...resolveName(el, 0, getBinding, warnings, visiting))
    } else if (el && typeof el === 'object' && el.type === 'repeat') {
      // §6.5: `x*n` — n juxtaposed copies of the resolved element (1→N inner ok).
      const inner = resolveElements([el.element], getBinding, warnings, visiting)
      for (let i = 0; i < el.count; i++) for (const e of inner) out.push(cloneElement(e))
    } else if (el && typeof el === 'object' && el.type === 'chord_ref') {
      out.push(...resolveName(el.name, el.octaveShift, getBinding, warnings, visiting))
    } else {
      out.push(resolveElement(el, getBinding, warnings, visiting))
    }
  }
  return out
}

/**
 * Resolve names / `*n` / chord refs across a whole play pattern, producing a pure
 * symbolic pattern. The single entry point used by Sequence.play (§6 / §6.5 L2).
 */
export function resolveChords(
  elements: readonly (PlayElement | string)[],
  getBinding: BindingLookup,
): ResolveResult {
  const warnings: string[] = []
  const resolved = resolveElements(elements, getBinding, warnings, new Set())
  return { elements: resolved, warnings }
}

export interface ChordDefinitionResult {
  voices: ChordVoice[]
  warnings: string[]
}

/**
 * Evaluate a `var X = [ ... ]` chord definition (§6) to a flat voice list for storage
 * in the namespace. Like the stack evaluator but in {@link ChordVoice} space: it
 * spreads refs to other chords (`[m7, 9]`), removes literal matches
 * (`[m7, -5]`), and folds a ref's `^N` into the spread voices. Chord
 * definitions are flat degree stacks (§6) — a non-flat voice (subtree/stack) is a
 * diagnostic warning and skipped, not silently dropped.
 */
export function evaluateChordDefinition(
  voices: StackElement[],
  getChord: ChordLookup,
): ChordDefinitionResult {
  const result: ChordVoice[] = []
  const warnings: string[] = []
  for (const voice of voices) {
    if (typeof voice === 'number') {
      result.push({ degree: voice, alteration: 0, octaveShift: 0, detune: 0 })
    } else if (voice && typeof voice === 'object' && voice.type === 'chord_ref') {
      const spread = getChord(voice.name)
      if (!spread) {
        warnings.push(`unknown chord "${voice.name}" in chord definition — skipped (§6).`)
        continue
      }
      for (const vc of spread) {
        result.push({ ...vc, octaveShift: vc.octaveShift + voice.octaveShift })
      }
    } else if (voice && typeof voice === 'object' && voice.type === 'chord_removal') {
      const before = result.length
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]!.degree === voice.degree && result[i]!.alteration === voice.alteration) {
          result.splice(i, 1)
        }
      }
      if (result.length === before) {
        const acc =
          voice.alteration < 0 ? 'b'.repeat(-voice.alteration) : '#'.repeat(voice.alteration)
        warnings.push(`removal "-${acc}${voice.degree}" matched no voice in chord — no-op (§6).`)
      }
    } else if (voice && typeof voice === 'object' && voice.type === 'pitch') {
      result.push({
        degree: voice.degree,
        alteration: voice.alteration,
        octaveShift: voice.octaveShift,
        detune: voice.detune,
      })
    } else {
      warnings.push('a chord definition must be a flat degree stack (§6) — voice skipped.')
    }
  }
  return { voices: result, warnings }
}
