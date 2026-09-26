import type { SymbolicPitch } from '../../midi/types'
import type { TimedEvent } from '../../timing/calculation/types'

/** One MIDI note after output Stage A and before tie/gate processing. */
export interface PlannedNote {
  onTime: number
  slotDur: number
  note: number | null
  detune: number
  tie: boolean
  legato: boolean
  voiceTie: boolean
  hold: boolean
  tieSlots: number
  offTime: number
  emit: boolean
  velocity: number
  articulation?: number
}

/** Explicit symbolic pitch, or the canonical fallback for a plain numeric degree. */
export function writtenPitchOf(event: TimedEvent): SymbolicPitch {
  return (
    event.pitch ?? {
      degree: event.sliceNumber,
      alteration: 0,
      octaveShift: 0,
      rangeSet: false,
      detune: 0,
    }
  )
}
