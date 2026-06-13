/**
 * TransportClock — the single wall-clock origin for the engine transport.
 *
 * Both the SuperCollider audio scheduler and the MIDI scheduler are driven by
 * `Date.now()` polling loops; what makes audio and MIDI play in sync is that
 * they share the SAME time origin. This clock owns that origin: it is started
 * once at `global.start()` and read by every scheduling path.
 *
 * Spec: PITCH_DSL_SPEC §1 ("SC オーディオ経路との併走は可"); the audio scheduler
 * and MidiScheduler both reference this origin so events scheduled for the same
 * musical time fire at the same `Date.now()` moment. The remaining audible
 * offset is purely downstream latency (SC audio buffer vs MIDI send), corrected
 * by `global.midiLatency()` + per-port lead (§9), not here.
 *
 * Decoupling rationale: the MIDI path uses this clock rather than reading
 * `startTime`/`isRunning` off the audio engine object, so a MIDI-only session
 * never touches SuperCollider while staying clock-aligned with audio when both
 * run together.
 */
export class TransportClock {
  /** Epoch ms (`Date.now()`) when the transport last started; 0 before start. */
  private _startTime = 0
  private _running = false

  /** Begin the transport, stamping the shared origin. Idempotent while running. */
  start(): void {
    if (this._running) return
    this._startTime = Date.now()
    this._running = true
  }

  /** Stop the transport. The origin is retained for inspection until restart. */
  stop(): void {
    this._running = false
  }

  get startTime(): number {
    return this._startTime
  }

  get running(): boolean {
    return this._running
  }
}
