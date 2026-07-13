import type { AudioEngine } from '../audio/types'

import type { ActiveNote, MidiOutput } from './midi-output'

/** MidiScheduler output adapter for the daemon's single hosted instrument. */
export class PluginNoteOutput implements MidiOutput {
  private activeNotes: ActiveNote[] = []

  constructor(private readonly engine: AudioEngine) {}

  ensurePort(portName: string): string {
    return portName
  }

  noteOn(port: string, channel: number, note: number, velocity: number, owner: string): void {
    const key = Math.max(0, Math.min(127, Math.round(note)))
    const normalizedVelocity = Math.max(1, Math.min(127, Math.round(velocity))) / 127
    void this.engine
      .pluginNoteOn?.(key, channel - 1, normalizedVelocity)
      ?.catch((err) => console.error('❌ PluginNoteOn failed', { key, err }))
    this.activeNotes.push({ port, channel, note: key, owner })
  }

  noteOff(port: string, channel: number, note: number, owner: string): void {
    const key = Math.max(0, Math.min(127, Math.round(note)))
    this.sendTrackedNoteOff({ port, channel, note: key, owner })
    const index = this.activeNotes.findIndex(
      (active) =>
        active.port === port &&
        active.channel === channel &&
        active.note === key &&
        active.owner === owner,
    )
    if (index !== -1) this.activeNotes.splice(index, 1)
  }

  pitchBend(_port: string, _channel: number, _semitones: number): void {}

  releaseOwner(owner: string): void {
    for (const note of this.activeNotes.filter((active) => active.owner === owner)) {
      this.sendTrackedNoteOff(note)
    }
    this.activeNotes = this.activeNotes.filter((active) => active.owner !== owner)
  }

  panic(): void {
    for (const note of this.activeNotes) this.sendTrackedNoteOff(note)
    this.activeNotes = []
  }

  getActiveNotes(): ReadonlyArray<ActiveNote> {
    return [...this.activeNotes]
  }

  listPorts(): string[] {
    return []
  }

  closeAll(): void {
    this.panic()
  }

  private sendTrackedNoteOff(note: ActiveNote): void {
    const key = note.note
    void this.engine
      .pluginNoteOff?.(key, note.channel - 1)
      ?.catch((err) => console.error('❌ PluginNoteOff failed', { key, err }))
  }
}
