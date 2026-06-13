/**
 * MidiOutput — raw MIDI send + active-note tracking + panic
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §1, §7
 *
 * This file defines the CONTRACT (interface + injectable backend seam). The
 * concrete implementation wraps `@julusian/midi` and is supplied separately.
 *
 * Responsibilities:
 *  - Port resolution by case-insensitive substring (§1). On a Japanese macOS
 *    the IAC port is "IACドライバ バス1", so matching must be language-agnostic
 *    (e.g. "iac" matches). Multiple matches → first + warning. No match →
 *    error listing the available ports.
 *  - Immediate note-on / note-off / pitch-bend send (RtMidi is send-only; the
 *    lookahead scheduling lives in MidiScheduler).
 *  - Active-note tracking per `owner` (a sequence name) so notes can be
 *    released precisely on LOOP-exclude / MUTE / play() swap (§7-2).
 *  - Panic: CC123 (All Notes Off) + CC120 (All Sound Off) on every channel of
 *    every open port (§7-2, WCTM stage-safety).
 */

/** A MIDI note currently sounding, tracked so it can be released cleanly. */
export interface ActiveNote {
  /** Resolved port name the note was sent to. */
  port: string
  /** MIDI channel, 1..16. */
  channel: number
  /** MIDI note number, 0..127. */
  note: number
  /** Owner key (sequence name) — lets `releaseOwner` target one sequence. */
  owner: string
}

/**
 * Injectable backend seam. The production backend is `@julusian/midi`; tests
 * supply a mock that records messages instead of touching CoreMIDI. One
 * `MidiBackendPort` corresponds to one opened physical output port.
 */
export interface MidiBackendPort {
  /** Send a raw MIDI message (status byte + data bytes). */
  sendMessage(message: number[]): void
  /** Close the underlying port. */
  closePort(): void
}

export interface MidiBackend {
  /** Enumerate available output port names, in index order. */
  listPortNames(): string[]
  /** Open the port at the given index and return a handle. */
  openPort(index: number): MidiBackendPort
}

/**
 * The MIDI output surface used by the scheduler and the sequence dispatch.
 * All note coordinates use channel 1..16 (the wire 0..15 mapping is internal).
 */
export interface MidiOutput {
  /**
   * Resolve `portName` (case-insensitive substring) to an actual port and
   * ensure it is open. Idempotent per resolved port. Returns the resolved
   * actual port name (which may differ from the query, e.g. localized).
   * @throws Error listing available ports when nothing matches.
   */
  ensurePort(portName: string): string

  /** Send note-on (channel 1..16) and track it under `owner`. */
  noteOn(port: string, channel: number, note: number, velocity: number, owner: string): void

  /** Send note-off (channel 1..16) and stop tracking it. */
  noteOff(port: string, channel: number, note: number, owner: string): void

  /**
   * Pitch-bend for detune, in semitones. Realized against a fixed bend range
   * of ±2 semitones (§2.4); values outside that range are clamped.
   */
  pitchBend(port: string, channel: number, semitones: number): void

  /**
   * Release every note currently sounding for `owner` by sending note-offs.
   * Used on LOOP-exclude / MUTE / play() swap so swaps never leave hanging
   * notes (§7-2 invariant: note-on count == note-off count).
   */
  releaseOwner(owner: string): void

  /**
   * Panic — send CC123 (All Notes Off) + CC120 (All Sound Off) on every
   * channel (1..16) of every open port, and clear all tracking. The hard
   * stage-safety net for stuck Disklavier notes (§7-2, WCTM §8).
   */
  panic(): void

  /** Snapshot of currently sounding notes (for tests / invariants). */
  getActiveNotes(): ReadonlyArray<ActiveNote>

  /** List available output port names (for diagnostics / error messages). */
  listPorts(): string[]

  /** Close every open port (engine shutdown). Sends panic first. */
  closeAll(): void
}
