/**
 * Event timing calculation for hierarchical play structures
 */

import { PlayElement } from '../../parser/audio-parser'
import { ScopeRoot, ScopeMode } from '../../parser/types'

import { TimedEvent, TimedEventScope } from './types'

/** One enclosing `.root()`/`.mode()`/`.oct()` group on the path to a leaf. */
interface ScopeFrame {
  root?: ScopeRoot
  mode?: ScopeMode
  oct?: number
}

/**
 * Resolve a scope stack to a leaf descriptor (§3 inner→outer). The nearest
 * frame that sets a root/mode wins for the pitch context; the nearest frame
 * that sets an oct wins independently. Returns undefined when no enclosing
 * group declared a scope (= sequence default).
 */
function resolveScope(stack: ScopeFrame[]): TimedEventScope | undefined {
  if (stack.length === 0) return undefined // common case: no enclosing scope group
  let root: ScopeRoot | undefined
  let mode: ScopeMode | undefined
  let groupOct: number | undefined
  let haveContext = false
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i]
    if (!haveContext && (f.root !== undefined || f.mode !== undefined)) {
      root = f.root
      mode = f.mode
      haveContext = true
    }
    if (groupOct === undefined && f.oct !== undefined) {
      groupOct = f.oct
    }
  }
  if (!haveContext && groupOct === undefined) {
    return undefined
  }
  return { root, mode, groupOct }
}

/**
 * Calculate timing for play() arguments
 *
 * This function recursively processes nested play() patterns and calculates
 * the exact start time and duration for each slice playback event.
 *
 * @param elements - Array of play elements (numbers or nested structures)
 * @param barDuration - Total bar duration in milliseconds
 * @param startTime - Start time offset (default 0)
 * @param depth - Current nesting depth (for debugging)
 * @param scopeStack - Enclosing `.root()`/`.mode()`/`.oct()` frames (§3), innermost last
 * @returns Array of timed events
 */
export function calculateEventTiming(
  elements: PlayElement[],
  barDuration: number,
  startTime: number = 0,
  depth: number = 0,
  scopeStack: ScopeFrame[] = [],
): TimedEvent[] {
  const events: TimedEvent[] = []

  // If no elements, return empty
  if (elements.length === 0) {
    return events
  }

  // Calculate duration for each element at this level
  const elementDuration = barDuration / elements.length
  // The lexical scope for leaf events at this level (undefined = seq default).
  const scope = resolveScope(scopeStack)

  // Process each element
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]
    const elementStartTime = startTime + i * elementDuration

    if (typeof element === 'number') {
      // Simple slice number (audio) or bare degree (MIDI) — carries the scope.
      events.push({
        sliceNumber: element,
        startTime: elementStartTime,
        duration: elementDuration,
        depth,
        ...(scope && { scope }),
      })
    } else if (Array.isArray(element)) {
      // Array of elements (nested structure)
      const nestedEvents = calculateEventTiming(
        element,
        elementDuration, // Nested elements split their parent's duration
        elementStartTime, // Start at parent's position
        depth + 1,
        scopeStack,
      )
      events.push(...nestedEvents)
    } else if (element && typeof element === 'object') {
      if (element.type === 'nested') {
        // Recursively calculate timing for nested elements
        const nestedEvents = calculateEventTiming(
          element.elements,
          elementDuration, // Nested elements split their parent's duration
          elementStartTime, // Start at parent's position
          depth + 1,
          scopeStack,
        )
        events.push(...nestedEvents)
      } else if (element.type === 'scoped') {
        // §3: a scope-bearing group run. Timing-transparent — it splits its slot
        // among its groups exactly as a nested of equal length would (so
        // `(A)(B).root(X)` has the same slots as `(A)(B)`). Push the group's
        // scope frame so descendant leaves resolve inner→outer.
        const frame: ScopeFrame = { root: element.root, mode: element.mode, oct: element.oct }
        const nestedEvents = calculateEventTiming(
          element.groups,
          elementDuration,
          elementStartTime,
          depth + 1,
          [...scopeStack, frame],
        )
        events.push(...nestedEvents)
      } else if (element.type === 'pitch') {
        // MIDI degree with alteration / octave-shift / detune (§2.1, §2.4).
        // The rhythm tree gives timing; the symbolic pitch is carried unresolved
        // (§7-0). sliceNumber mirrors the degree as a fallback only.
        events.push({
          sliceNumber: element.degree,
          startTime: elementStartTime,
          duration: elementDuration,
          depth,
          pitch: {
            degree: element.degree,
            alteration: element.alteration,
            octaveShift: element.octaveShift,
            rangeSet: element.rangeSet, // §2.4: carry the `^N` set-point flag for the sticky-range walk
            detune: element.detune,
          },
          ...(scope && { scope }),
        })
      } else if (element.type === 'modified') {
        // Modified element (e.g., with .chop())
        // For now, treat the value as a simple number
        // TODO: Apply chop modifications
        if (typeof element.value === 'number') {
          events.push({
            sliceNumber: element.value,
            startTime: elementStartTime,
            duration: elementDuration,
            depth,
          })
        } else if (element.value && element.value.type === 'nested') {
          // Modified nested structure
          const nestedEvents = calculateEventTiming(
            element.value.elements,
            elementDuration,
            elementStartTime,
            depth + 1,
            scopeStack,
          )
          events.push(...nestedEvents)
        }
      }
    }
  }

  return events
}
