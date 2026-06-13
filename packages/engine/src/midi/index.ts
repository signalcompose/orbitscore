/**
 * MIDI module — Phase 1 (Issue #228)
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html
 *
 * Public surface of the MIDI subsystem. Per the architecture decision
 * (IMPLEMENTATION_INSTRUCTIONS §3), this module sits alongside the audio
 * engine; MIDI dispatch is selected by a Sequence-side flag rather than a
 * full EventRouter abstraction.
 */

export type { Alteration, SymbolicPitch, RootContext, ResolvedPitch } from './types'
export { resolveDegree } from './degree-resolution'
export type { MidiOutput, MidiBackend, MidiBackendPort, ActiveNote } from './midi-output'
export { RtMidiOutput, createJulusianBackend } from './rtmidi-output'
