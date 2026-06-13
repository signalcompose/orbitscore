/**
 * MidiTransportScheduler — a Scheduler-shaped clock for MIDI sequences.
 *
 * MIDI sequences reuse the audio scheduling machinery (preparePlayback /
 * loopSequence / runSequence), which is parameterised over a {@link Scheduler}.
 * Rather than handing them the SuperCollider audio engine (which entangles MIDI
 * with SC), they get this thin adapter: it exposes the shared transport origin
 * (`startTime`) and running flag via {@link TransportClock}, and no-ops every
 * audio-specific method. The actual MIDI scheduling goes through MidiScheduler /
 * MidiOutput; per-sequence event clearing goes through MidiScheduler.clearOwner
 * (so `clearSequenceEvents` here is intentionally a no-op).
 *
 * Sync: because the audio scheduler and this adapter both read the same
 * `Date.now()` origin established at `global.start()`, audio and MIDI events for
 * the same musical time fire together (PITCH_DSL_SPEC §1).
 */

import { Scheduler } from './types'
import { TransportClock } from './transport-clock'

export class MidiTransportScheduler implements Scheduler {
  constructor(private clock: TransportClock) {}

  get isRunning(): boolean {
    return this.clock.running
  }

  get startTime(): number {
    return this.clock.startTime
  }

  // The transport lifecycle is owned by Global (via TransportClock); these are
  // no-ops so the shared run/loop machinery can call them harmlessly.
  start(): void {}
  stop(): void {}
  stopAll(): void {}

  // MIDI per-sequence clearing / tracking is handled by MidiScheduler.clearOwner
  // and MidiOutput's active-note tracking, not here.
  clearSequenceEvents(): void {}
  reinitializeSequenceTracking(): void {}

  // Audio-only surface — never reached on the MIDI path (no audioFilePath).
  scheduleEvent(): void {}
  scheduleSliceEvent(): void {}
  getAudioDuration(): number {
    return 0
  }
}
