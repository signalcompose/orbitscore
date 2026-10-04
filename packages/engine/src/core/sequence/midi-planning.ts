import type { SymbolicPitch } from '../../midi/types'
import type { TimedEvent } from '../../timing/calculation/types'

/**
 * One MIDI note planned from a TimedEvent during scheduling (§5/§4 output stage).
 * Stage A fills the resolved pitch + flags; Stage B computes `offTime` and `emit`
 * (tie absorption / voice-tie suppression / legato overlap); Stage C emits.
 */
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

/**
 * The symbolic pitch for a timed event: its explicit `pitch` (§7-0), or a bare-degree
 * fallback built from `sliceNumber` (a plain MIDI degree carries no PlayPitch). Shared by
 * every output-stage walk (validate / voice-leading / scheduling) so the fallback shape
 * stays in one place.
 */
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
