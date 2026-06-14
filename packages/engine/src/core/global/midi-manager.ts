/**
 * MidiManager — global MIDI state and lazy output/scheduler ownership
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §1, §2.3, §7; WCTM §9
 *
 * Owns the single MidiOutput + MidiScheduler shared by all MIDI sequences,
 * created lazily so audio-only sessions never touch CoreMIDI. Holds the global
 * key (for numeric-degree roots), the global MIDI latency offset, and per-port
 * lead offsets (negative send offset, e.g. Disklavier mechanical latency, §9).
 *
 * The output is injectable so tests can supply a mock instead of real hardware.
 */

import { MidiOutput } from '../../midi/midi-output'
import { MidiScheduler } from '../../midi/midi-scheduler'
import { noteNameToPitchClass } from '../../midi/note-name'
import { RtMidiOutput } from '../../midi/rtmidi-output'

export class MidiManager {
  private readonly outputFactory: () => MidiOutput
  private output?: MidiOutput
  private scheduler?: MidiScheduler

  /** Global key pitch class (0..11), undefined until `global.key()` is called. */
  private keyPitchClass?: number
  /** Global key-center octave (#253), set by `global.key("D4")`; undefined = none. */
  private keyOctave?: number
  /** Global send latency in ms applied to every MIDI send (§1). */
  private midiLatencyMs = 0
  /** Per-port lead (negative offset) in ms — sends this much earlier (§9). */
  private readonly portLeadMs = new Map<string, number>()

  constructor(outputFactory: () => MidiOutput = () => new RtMidiOutput()) {
    this.outputFactory = outputFactory
  }

  /** Lazily create the output — only touches CoreMIDI when MIDI is actually used. */
  getOutput(): MidiOutput {
    if (!this.output) {
      this.output = this.outputFactory()
    }
    return this.output
  }

  /** Lazily create the scheduler over the output. */
  getScheduler(): MidiScheduler {
    if (!this.scheduler) {
      this.scheduler = new MidiScheduler(this.getOutput())
    }
    return this.scheduler
  }

  /** True once any MIDI scheduler has been created (a MIDI sequence ran). */
  isActive(): boolean {
    return this.scheduler !== undefined
  }

  /**
   * Set the global key from a note name, with an optional **key-center octave**
   * (#253): `"C"` / `"F#"` / `"Bb"` set only the pitch class; `"D4"` / `"Bb3"` /
   * `"F#5"` also set the base octave for degree 1 — the whole piece's register in
   * one place (a per-sequence `seq.octave()` still overrides it). A name without an
   * octave clears any previous key octave.
   */
  key(name: string): void {
    const m = name.match(/^([A-Ga-g][#b]*)(-?\d+)$/)
    if (m) {
      this.keyPitchClass = noteNameToPitchClass(m[1]!)
      this.keyOctave = parseInt(m[2]!, 10)
    } else {
      this.keyPitchClass = noteNameToPitchClass(name)
      this.keyOctave = undefined
    }
  }

  /** The global key pitch class, or undefined if `global.key()` was never called. */
  getKeyPitchClass(): number | undefined {
    return this.keyPitchClass
  }

  /** The global key-center octave (#253), or undefined if `global.key()` had no octave. */
  getKeyOctave(): number | undefined {
    return this.keyOctave
  }

  /** Set the global MIDI send latency (ms). */
  midiLatency(ms: number): void {
    this.midiLatencyMs = ms
  }

  getMidiLatency(): number {
    return this.midiLatencyMs
  }

  /**
   * Set a per-port lead in ms (positive = send earlier). Used to pre-compensate
   * for a player piano's mechanical latency at the venue (WCTM §9).
   */
  setPortLead(port: string, leadMs: number): void {
    this.portLeadMs.set(port, leadMs)
  }

  /**
   * Net send delay for a port: global latency minus the port's lead. A positive
   * result delays the send; a negative result sends ahead of the nominal time.
   */
  sendDelayFor(port: string): number {
    return this.midiLatencyMs - (this.portLeadMs.get(port) ?? 0)
  }

  /** Start the scheduler loop if MIDI is active. */
  start(): void {
    this.scheduler?.start()
  }

  /** Stop the scheduler (panics the output) if MIDI is active. */
  stop(): void {
    this.scheduler?.stop()
  }

  /** Panic the output directly (CC123/CC120 all channels) if it exists. */
  panic(): void {
    this.output?.panic()
  }
}
