/**
 * RtMidiOutput — concrete MidiOutput backed by @julusian/midi (RtMidi)
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §1, §7
 *
 * Provides the injectable backend seam (`MidiBackend`) so production code uses
 * real CoreMIDI/RtMidi hardware while tests inject a mock that records bytes.
 *
 * Port resolution (§1): case-insensitive substring match, localized-name safe
 * (e.g. "iac" matches "IACドライバ バス1"). Opened ports are cached by resolved
 * name (idempotent). Multiple matches → first + console.warn. No match → Error
 * listing available ports.
 *
 * Pitch bend uses a fixed ±2 semitone range (§2.4). Semitones are clamped to
 * that range, then mapped to a 14-bit value (0..16383, center 8192) and split
 * into LSB/MSB bytes.
 *
 * Note clamping: note numbers are clamped to 0..127; velocity is clamped to
 * 1..127 (velocity 0 would be interpreted as note-off by some receivers — we
 * always use the 0x80 note-off status instead).
 */

import { Output } from '@julusian/midi'

import { ActiveNote, MidiBackend, MidiBackendPort, MidiOutput } from './midi-output'

// ---------------------------------------------------------------------------
// Real backend — wraps @julusian/midi
// ---------------------------------------------------------------------------

/**
 * Create the default production backend that wraps `@julusian/midi`'s `Output`.
 * An enumerator output is reused to list ports; one output per port is opened
 * when `openPort` is called.
 */
export function createJulusianBackend(): MidiBackend {
  // A single enumerator output kept open for the lifetime of the backend.
  // It is never opened to a port — it is only used for port enumeration.
  const enumerator = new Output()

  return {
    listPortNames(): string[] {
      const count = enumerator.getPortCount()
      const names: string[] = []
      for (let i = 0; i < count; i++) {
        names.push(enumerator.getPortName(i))
      }
      return names
    },

    openPort(index: number): MidiBackendPort {
      const out = new Output()
      out.openPort(index)
      return {
        sendMessage(message: number[]): void {
          out.sendMessage(message)
        },
        closePort(): void {
          out.closePort()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// RtMidiOutput
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `MidiOutput` using `@julusian/midi`.
 *
 * Inject a `MidiBackend` mock in tests to avoid touching real hardware.
 */
export class RtMidiOutput implements MidiOutput {
  private readonly backend: MidiBackend

  /** Map from resolved port name → open backend port handle. */
  private readonly openPorts = new Map<string, MidiBackendPort>()

  /** Currently sounding notes, tracked per owner for §7-2 safety. */
  private activeNotes: ActiveNote[] = []

  constructor(backend: MidiBackend = createJulusianBackend()) {
    this.backend = backend
  }

  // -------------------------------------------------------------------------
  // Port management (§1)
  // -------------------------------------------------------------------------

  /**
   * Resolve `portName` (case-insensitive substring) and ensure the port is open.
   * Idempotent: calling twice for the same port opens it only once.
   *
   * @returns the resolved actual port name (may differ from the query, e.g. localized).
   * @throws Error listing available ports when no port name contains the query.
   */
  ensurePort(portName: string): string {
    const query = portName.toLowerCase()
    const names = this.backend.listPortNames()
    const matches = names
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => name.toLowerCase().includes(query))

    if (matches.length === 0) {
      throw new Error(
        `RtMidiOutput: no MIDI port matches "${portName}". Available ports: ${
          names.length > 0 ? names.map((n, i) => `[${i}] ${n}`).join(', ') : '(none)'
        }`,
      )
    }

    const { name: resolvedName, index } = matches[0]!

    if (matches.length > 1) {
      console.warn(
        `RtMidiOutput: multiple ports match "${portName}" (${matches
          .map((m) => m.name)
          .join(', ')}); using first match "${resolvedName}"`,
      )
    }

    if (!this.openPorts.has(resolvedName)) {
      this.openPorts.set(resolvedName, this.backend.openPort(index))
    }

    return resolvedName
  }

  /**
   * Resolve a port to an open handle, taking a fast path when the caller passes
   * an already-resolved name (the common case from the scheduler). This avoids
   * re-enumerating CoreMIDI on every note — important for live timing, since
   * `ensurePort` calls `listPortNames()` which queries the OS.
   */
  private resolveOpenPort(port: string): { name: string; handle: MidiBackendPort } {
    const cached = this.openPorts.get(port)
    if (cached) {
      return { name: port, handle: cached }
    }
    const name = this.ensurePort(port)
    return { name, handle: this.openPorts.get(name)! }
  }

  // -------------------------------------------------------------------------
  // Note on / off (§7-2)
  // -------------------------------------------------------------------------

  /**
   * Send a note-on and record the note in active tracking.
   *
   * Note is clamped to 0..127. Velocity is clamped to 1..127 (0 is reserved
   * for the note-off semantic and is avoided via the 0x80 status byte path).
   *
   * @param port     - port name query (resolved via ensurePort)
   * @param channel  - MIDI channel 1..16
   * @param note     - MIDI note 0..127 (clamped)
   * @param velocity - velocity 1..127 (clamped)
   * @param owner    - sequence name for §7-2 releaseOwner tracking
   */
  noteOn(port: string, channel: number, note: number, velocity: number, owner: string): void {
    const { name: resolvedPort, handle } = this.resolveOpenPort(port)
    const clampedNote = Math.max(0, Math.min(127, Math.round(note)))
    const clampedVelocity = Math.max(1, Math.min(127, Math.round(velocity)))
    const wire = channel - 1

    handle.sendMessage([0x90 | wire, clampedNote, clampedVelocity])

    this.activeNotes.push({ port: resolvedPort, channel, note: clampedNote, owner })
  }

  /**
   * Send a note-off and remove the first matching tracked note.
   *
   * Safe to call for untracked notes (idempotent; still sends the note-off byte).
   */
  noteOff(port: string, channel: number, note: number, owner: string): void {
    const { name: resolvedPort, handle } = this.resolveOpenPort(port)
    const clampedNote = Math.max(0, Math.min(127, Math.round(note)))
    const wire = channel - 1

    handle.sendMessage([0x80 | wire, clampedNote, 0])

    // Remove the FIRST matching tracked entry.
    const idx = this.activeNotes.findIndex(
      (n) =>
        n.port === resolvedPort &&
        n.channel === channel &&
        n.note === clampedNote &&
        n.owner === owner,
    )
    if (idx !== -1) {
      this.activeNotes.splice(idx, 1)
    }
  }

  // -------------------------------------------------------------------------
  // Pitch bend (§2.4)
  // -------------------------------------------------------------------------

  /**
   * Send a pitch-bend message for detune, in semitones.
   *
   * Fixed bend range: ±2 semitones (§2.4). Values outside that range are
   * clamped. Center (0 st) maps to 14-bit 8192 → [lsb=0x00, msb=0x40].
   * Full-up (+2 st) → 16383 → [0x7F, 0x7F]. Full-down (−2 st) → 0 → [0, 0].
   */
  pitchBend(port: string, channel: number, semitones: number): void {
    const { handle } = this.resolveOpenPort(port)
    const wire = channel - 1

    const BEND_RANGE = 2 // semitones (fixed, §2.4)
    const clamped = Math.max(-BEND_RANGE, Math.min(BEND_RANGE, semitones))
    const value14 = Math.max(0, Math.min(16383, Math.round((clamped / BEND_RANGE) * 8192 + 8192)))
    const lsb = value14 & 0x7f
    const msb = (value14 >> 7) & 0x7f

    handle.sendMessage([0xe0 | wire, lsb, msb])
  }

  // -------------------------------------------------------------------------
  // Owner-level release (§7-2)
  // -------------------------------------------------------------------------

  /**
   * Release every sounding note belonging to `owner` by sending note-offs.
   *
   * Used on LOOP-exclude, MUTE, and play() swap so sequence swaps never leave
   * hanging notes (§7-2 invariant: note-on count == note-off count per sequence).
   */
  releaseOwner(owner: string): void {
    const toRelease = this.activeNotes.filter((n) => n.owner === owner)
    for (const note of toRelease) {
      const handle = this.openPorts.get(note.port)
      if (handle) {
        handle.sendMessage([0x80 | (note.channel - 1), note.note, 0])
      }
    }
    this.activeNotes = this.activeNotes.filter((n) => n.owner !== owner)
  }

  // -------------------------------------------------------------------------
  // Panic (§7-2, WCTM §8)
  // -------------------------------------------------------------------------

  /**
   * Hard stage-safety reset. Sends CC123 (All Notes Off) then CC120 (All Sound
   * Off) on every channel (1..16) of every currently open port, then clears all
   * active-note tracking. Per spec §7-2 / WCTM §8.
   */
  panic(): void {
    for (const handle of this.openPorts.values()) {
      for (let ch = 1; ch <= 16; ch++) {
        const wire = ch - 1
        handle.sendMessage([0xb0 | wire, 123, 0]) // CC123 — All Notes Off
        handle.sendMessage([0xb0 | wire, 120, 0]) // CC120 — All Sound Off
      }
    }
    this.activeNotes = []
  }

  // -------------------------------------------------------------------------
  // Diagnostics / lifecycle
  // -------------------------------------------------------------------------

  /** Snapshot of currently sounding notes (for tests / invariants). */
  getActiveNotes(): ReadonlyArray<ActiveNote> {
    return [...this.activeNotes]
  }

  /** List available output port names (for diagnostics / error messages). */
  listPorts(): string[] {
    return this.backend.listPortNames()
  }

  /** Close every open port. Sends panic first to avoid stuck notes. */
  closeAll(): void {
    this.panic()
    for (const handle of this.openPorts.values()) {
      handle.closePort()
    }
    this.openPorts.clear()
  }
}
