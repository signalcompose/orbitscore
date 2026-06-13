import { MidiOutput } from './midi-output'

/**
 * MidiScheduler — TS-side lookahead scheduler for MIDI note events
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §7-3, §7-4
 *
 * RtMidi sends immediately (no hardware-side scheduling), so note timing is
 * driven from TypeScript: a fine-grained timer polls a queue of timed actions
 * and fires note-on / note-off / pitch-bend via {@link MidiOutput} when due.
 * Drift is corrected by comparing against the wall clock every tick rather than
 * accumulating tick intervals.
 *
 * Pitch resolution (symbolic degree → MIDI note number) happens BEFORE the
 * scheduler, at the sequence dispatch layer (§7-0 output final stage), so the
 * scheduler deals only in resolved MIDI note numbers.
 *
 * This file defines the contract; the concrete implementation is supplied
 * separately and reviewed for integration.
 */

/**
 * A fully-resolved MIDI note to be played, with absolute wall-clock send times.
 * `onTime` / `offTime` are `Date.now()`-style epoch milliseconds so MIDI shares
 * the same clock base as the audio scheduler (they may run concurrently, §1).
 */
export interface ScheduledMidiNote {
  /** Owner key (sequence name) so the note can be cancelled / released as a group. */
  owner: string
  /** Resolved port name (already opened via MidiOutput.ensurePort). */
  port: string
  /** MIDI channel, 1..16. */
  channel: number
  /** Resolved MIDI note number, 0..127. */
  note: number
  /** Velocity, 1..127. */
  velocity: number
  /** Detune in semitones (±2) for pitch bend; 0 = no bend. */
  detune: number
  /** Absolute epoch ms (Date.now()-style) to send note-on. */
  onTime: number
  /** Absolute epoch ms to send note-off. Must be >= onTime. */
  offTime: number
}

/** Tuning knobs for the scheduler loop. */
export interface MidiSchedulerOptions {
  /** Poll interval in ms (default 5). Smaller = tighter timing, more CPU. */
  tickMs?: number
}

// ---------------------------------------------------------------------------
// Internal action queue types
// ---------------------------------------------------------------------------

/** A single timed action that will be fired when its time comes. */
interface ScheduledAction {
  /** Absolute epoch ms when this action should fire. */
  time: number
  /** Monotonically increasing insertion sequence number for stable ordering. */
  seq: number
  /** Owner key, so clearOwner can remove a whole group at once. */
  owner: string
  /** The work to perform when the action fires. */
  run: () => void
}

// ---------------------------------------------------------------------------
// MidiScheduler
// ---------------------------------------------------------------------------

/**
 * Drives MIDI note timing from a TypeScript timer, calling a {@link MidiOutput}
 * when each action becomes due.
 *
 * Timing model:
 *   - `setInterval` polls at `tickMs` (default 5 ms).
 *   - Each tick snapshots `Date.now()` once, fires every queued action with
 *     `time <= now` in `(time, seq)` order, then removes them.
 *   - No actions are fired synchronously inside `scheduleNote`; every action
 *     waits for the next tick even if already past due.
 *   - Drift is corrected by comparing against the wall clock each tick —
 *     tick counts never accumulate.
 *
 * §7-3, §7-4 invariants:
 *   - Bend fires immediately before note-on for the same note.
 *   - `stop()` panics the output (hard silence + clear tracking).
 *   - `clearOwner(o)` removes all pending actions for `o` AND calls
 *     `releaseOwner(o)` so already-sounding notes are not left hanging.
 */
export class MidiScheduler {
  private readonly output: MidiOutput
  private readonly tickMs: number

  private queue: ScheduledAction[] = []
  private handle: ReturnType<typeof setInterval> | null = null
  private nextSeq = 0

  constructor(output: MidiOutput, options?: MidiSchedulerOptions) {
    this.output = output
    this.tickMs = options?.tickMs ?? 5
  }

  // -------------------------------------------------------------------------
  // Public flag
  // -------------------------------------------------------------------------

  /** `true` while the interval is running. Derived from the interval handle. */
  get isRunning(): boolean {
    return this.handle !== null
  }

  // -------------------------------------------------------------------------
  // Queue observation
  // -------------------------------------------------------------------------

  /** Number of actions still pending in the queue (for tests / diagnostics). */
  pendingCount(): number {
    return this.queue.length
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Enqueue note-on (and optional pitch-bend) at `n.onTime`, note-off at
   * `n.offTime`. Actions are fired on the first tick at or after their time.
   *
   * Safe to call while running or stopped. If the action is already past-due
   * when enqueued, it fires on the next tick rather than being dropped.
   */
  scheduleNote(n: ScheduledMidiNote): void {
    if (n.detune !== 0) {
      this.enqueue(n.onTime, n.owner, () => {
        this.output.pitchBend(n.port, n.channel, n.detune)
      })
    }
    this.enqueue(n.onTime, n.owner, () => {
      this.output.noteOn(n.port, n.channel, n.note, n.velocity, n.owner)
    })
    this.enqueue(n.offTime, n.owner, () => {
      this.output.noteOff(n.port, n.channel, n.note, n.owner)
    })
    if (n.detune !== 0) {
      // Reset the channel pitch bend to center after the detuned note ends, so
      // a following non-detuned note on the same channel is not left bent
      // (pitch bend is per-channel; without this the residual offset detunes
      // the next note, which sends no bend of its own when its detune is 0).
      this.enqueue(n.offTime, n.owner, () => {
        this.output.pitchBend(n.port, n.channel, 0)
      })
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the timer loop. Idempotent — calling twice has no effect (no double
   * interval, no double-fire).
   */
  start(): void {
    if (this.handle !== null) return
    this.handle = setInterval(() => this.tick(), this.tickMs)
  }

  /**
   * Stop the timer loop, call `output.panic()` (hard silence), and clear the
   * queue. Idempotent when already stopped.
   */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle)
      this.handle = null
    }
    this.output.panic()
    this.queue = []
  }

  /**
   * Remove all pending actions for `owner` from the queue AND call
   * `output.releaseOwner(owner)` to send note-offs for any already-sounding
   * notes owned by that sequence. Guarantees no hanging notes (§7-2).
   *
   * Safe to call whether running or stopped.
   */
  clearOwner(owner: string): void {
    this.queue = this.queue.filter((a) => a.owner !== owner)
    this.output.releaseOwner(owner)
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Push one action onto the queue with the next sequence number. */
  private enqueue(time: number, owner: string, run: () => void): void {
    this.queue.push({ time, seq: this.nextSeq++, owner, run })
  }

  /**
   * One timer tick: snapshot `Date.now()`, collect due actions, sort by
   * `(time, seq)` for stable ordering, fire them, then remove from queue.
   */
  private tick(): void {
    const now = Date.now()
    const due = this.queue.filter((a) => a.time <= now)
    if (due.length === 0) return

    due.sort((a, b) => a.time - b.time || a.seq - b.seq)

    for (const action of due) {
      try {
        action.run()
      } catch (e) {
        // A failed send (e.g. IAC port disconnected mid-loop) must not abort
        // the tick: aborting would skip the queue cleanup below (fired actions
        // re-fire next tick = double-send) and drop the remaining due actions
        // (a paired note-off → hanging note). Log and continue.
        console.error(`MidiScheduler: action failed (owner=${action.owner}):`, e)
      }
    }

    // Remove fired actions. Use a Set for O(n) removal.
    const firedSet = new Set(due)
    this.queue = this.queue.filter((a) => !firedSet.has(a))
  }
}
