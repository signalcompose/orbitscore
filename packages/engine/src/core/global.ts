/**
 * Global class for OrbitScore - Refactored version
 * Represents the global transport and configuration
 */

import { AudioEngine } from '../audio/types'
import { StackElement, PlayElement } from '../parser/types'
import { BoundValue, ChordVoice } from '../midi/chord/types'
import { evaluateChordDefinition } from '../midi/chord/resolve-chords'
import { PREDEFINED_CHORDS } from '../midi/chord/predefined-chords'

import { Sequence } from './sequence'
import { Scheduler, GlobalState } from './global/types'
import { TempoManager } from './global/tempo-manager'
import { AudioManager } from './global/audio-manager'
import { EffectsManager } from './global/effects-manager'
import { TransportControl } from './global/transport-control'
import { SequenceRegistry } from './global/sequence-registry'
import { LinkAudioManager } from './global/link-audio-manager'
import { QuantizeManager, QuantizeValue } from './global/quantize-manager'
import { MidiManager } from './global/midi-manager'
import { TransportClock } from './global/transport-clock'
import { MidiTransportScheduler } from './global/midi-transport-scheduler'

export class Global {
  // Manager instances for different responsibilities
  private tempoManager: TempoManager
  private audioManager: AudioManager
  private effectsManager: EffectsManager
  private transportControl: TransportControl
  private sequenceRegistry: SequenceRegistry
  private linkAudioManager: LinkAudioManager
  private quantizeManager: QuantizeManager
  private midiManager: MidiManager

  // Shared transport clock — the single Date.now() origin for both the audio
  // scheduler and the MIDI scheduler, so they stay in sync (§1). MIDI sequences
  // schedule against `midiTransport` (TransportClock-backed) instead of the SC
  // audio engine, so a MIDI-only session never touches SuperCollider.
  private transportClock = new TransportClock()
  private midiTransport = new MidiTransportScheduler(this.transportClock)

  // Core dependencies
  private audioEngine: AudioEngine
  private globalScheduler: Scheduler

  /**
   * Creates a new Global instance with all manager components
   * @param audioEngine - The audio engine instance
   * @param midiManager - Optional MidiManager (inject a mock-backed one in tests)
   */
  constructor(audioEngine: AudioEngine, midiManager?: MidiManager) {
    this.audioEngine = audioEngine
    // Type assertion: AudioEngine implementations must also implement Scheduler
    // This is true for SuperColliderPlayer
    this.globalScheduler = audioEngine as unknown as Scheduler

    // Initialize managers
    this.tempoManager = new TempoManager()
    this.audioManager = new AudioManager(audioEngine)
    this.linkAudioManager = new LinkAudioManager()
    this.quantizeManager = new QuantizeManager()
    this.midiManager = midiManager ?? new MidiManager()
    this.sequenceRegistry = new SequenceRegistry(audioEngine, this)
    this.effectsManager = new EffectsManager(
      this.globalScheduler,
      this.sequenceRegistry.getAllSequences(),
    )
    this.transportControl = new TransportControl(
      this.globalScheduler,
      this.sequenceRegistry.getAllSequences(),
    )
  }

  // Tempo and meter management
  tempo(value?: number): number | this {
    const result = this.tempoManager.tempo(value)
    if (typeof result === 'number') {
      return result
    }

    // Notify all sequences that inherit global tempo
    const sequences = this.sequenceRegistry.getAllSequences()
    for (const [, seq] of sequences) {
      seq.notifyGlobalTempoChange()
    }

    return this
  }

  beat(numerator: number, denominator: number): this {
    this.tempoManager.beat(numerator, denominator)

    // Notify all sequences that inherit global beat
    const sequences = this.sequenceRegistry.getAllSequences()
    for (const [, seq] of sequences) {
      seq.notifyGlobalBeatChange()
    }

    return this
  }

  // Note: tick() has been removed (MIDI resolution, not needed for audio-only).

  /**
   * Set the global key from a note name (e.g. "C", "F#", "Bb").
   *
   * Establishes the tonic that numeric sequence roots resolve against (§2.3).
   * MIDI sequences with bare degrees resolve relative to this key when no
   * `seq.root()` overrides it.
   */
  key(name: string): this {
    this.midiManager.key(name)
    return this
  }

  /**
   * Set the global MIDI send latency in milliseconds (§1). Applied to every
   * MIDI send to align the MIDI path against the SuperCollider audio path.
   */
  midiLatency(ms: number): this {
    this.midiManager.midiLatency(ms)
    return this
  }

  /** Accessor for the shared MIDI manager (used by Sequence MIDI dispatch). */
  getMidiManager(): MidiManager {
    return this.midiManager
  }

  // ─── Chord namespace (§6) ──────────────────────────────────────────────────
  // A program-global table of chord values, read by Sequence.play to spread chord
  // refs (§6, 評価時値渡し). Lives here — like global.key() — so the interpreter
  // and direct sequence use share one namespace. Phase R (#227) will add its own
  // value kind to the same table via the BoundValue `kind` discriminant.
  private chordRegistry = new Map<string, BoundValue>()

  /** `import chords` (§6): load the stdlib chord qualities into the namespace. */
  importChords(): this {
    for (const [name, voices] of Object.entries(PREDEFINED_CHORDS)) {
      this.setChord(name, { kind: 'chord', voices })
    }
    return this
  }

  /**
   * `var NAME = [ ... ]` (§6): evaluate the raw stack (spread refs to chords
   * already bound, apply `-N` removals / `^N`) and bind the resulting voice list.
   */
  defineChord(name: string, voices: StackElement[]): this {
    const { voices: resolved, warnings } = evaluateChordDefinition(voices, (n) =>
      this.getChordVoices(n),
    )
    for (const w of warnings) console.warn(`⚠️  chord ${name}: ${w}`)
    this.setChord(name, { kind: 'chord', voices: resolved })
    return this
  }

  /** The voices of a bound chord, or undefined if the name is unbound / a pattern. */
  getChordVoices(name: string): ChordVoice[] | undefined {
    const bound = this.chordRegistry.get(name)
    return bound?.kind === 'chord' ? bound.voices : undefined
  }

  /**
   * `var NAME = <play-expr>` (§6.5): bind a pattern value (raw play-elements). Shares
   * the chord namespace — a bare name reference dispatches on `kind` at resolution.
   */
  definePattern(name: string, elements: PlayElement[]): this {
    this.setChord(name, { kind: 'pattern', elements })
    return this
  }

  /** The bound value (chord or pattern) for a name, or undefined if unbound. */
  getBinding(name: string): BoundValue | undefined {
    return this.chordRegistry.get(name)
  }

  /** Bind a chord value, warning on overwrite (§10-4: global binding + conflict warning). */
  private setChord(name: string, value: BoundValue): void {
    if (this.chordRegistry.has(name)) {
      console.warn(`⚠️  chord namespace: "${name}" redefined (last-write-wins, §10-4).`)
    }
    this.chordRegistry.set(name, value)
  }

  // Audio path and device management
  audioPath(...values: (string | string[])[]): string | this {
    const result = this.audioManager.audioPath(...values)
    if (typeof result === 'string') {
      return result
    }
    return this
  }

  /**
   * Resolve a sample spec (path or bare bank name) to an absolute file path.
   * Used by Sequence.audio() so it does not have to know the resolution rules.
   */
  resolveAudioSpec(spec: string): string {
    return this.audioManager.resolve(spec)
  }

  audioDevice(deviceName: string): this {
    this.audioManager.audioDevice(deviceName)
    return this
  }

  /**
   * Enable LinkAudio output mode. Once declared, all sequences route through
   * Ableton Link Audio instead of the hardware bus. Hardware output and
   * LinkAudio cannot coexist within the same .orbs file.
   *
   * @param targetSampleRate Optional explicit target SR for plugin-side
   *                         resampling. Auto-detect with 48000 fallback when
   *                         omitted.
   */
  linkAudio(targetSampleRate?: number): this {
    this.linkAudioManager.linkAudio(targetSampleRate)
    return this
  }

  isLinkAudioEnabled(): boolean {
    return this.linkAudioManager.isEnabled()
  }

  /**
   * Set the global launch-quantize value.
   *
   * Controls when LOOP() starts and when LOOP-time play() updates take
   * effect, by waiting until the next quantized boundary derived from the
   * global tempo and meter. RUN() (one-shot) is unaffected and stays
   * immediate. Sequences may override this with `seq.quantize("...")`.
   *
   * Accepted values: "off" | "beat" | "bar" | "2bar" | "4bar" | "8bar".
   * Default: "bar".
   */
  quantize(value: QuantizeValue): this {
    this.quantizeManager.setQuantize(value)
    return this
  }

  getQuantize(): QuantizeValue {
    return this.quantizeManager.getQuantize()
  }

  /**
   * Set the directory of the currently evaluated .orbs file
   * Used for relative path resolution in audioPath()
   * @internal - Called by the engine when evaluating a document
   */
  setDocumentDirectory(dirPath: string): void {
    this.audioManager.setDocumentDirectory(dirPath)
  }

  // Master effects management
  gain(valueDb?: number): number | this {
    const result = this.effectsManager.gain(valueDb)
    if (typeof result === 'number') {
      return result
    }
    return this
  }

  getMasterGainDb(): number {
    return this.effectsManager.getMasterGainDb()
  }

  compressor(
    threshold = 0.5,
    ratio = 0.5,
    attack = 0.01,
    release = 0.1,
    makeupGain = 1.0,
    enabled = true,
  ): this {
    this.effectsManager.compressor(threshold, ratio, attack, release, makeupGain, enabled)
    return this
  }

  limiter(level = 0.99, duration = 0.01, enabled = true): this {
    this.effectsManager.limiter(level, duration, enabled)
    return this
  }

  normalizer(level = 1.0, duration = 0.01, enabled = true): this {
    this.effectsManager.normalizer(level, duration, enabled)
    return this
  }

  // Transport control
  start(): this {
    // Stamp the shared clock origin FIRST so the audio scheduler (started by
    // transportControl) and the MIDI scheduler share the same Date.now() base.
    this.transportClock.start()
    this.transportControl.start()
    this.effectsManager.setRunningState(true)
    this.midiManager.start()
    return this
  }

  /**
   * @deprecated Not needed. Use LOOP(seq) for sequences instead.
   */
  loop(): this {
    this.transportControl.loop()
    this.effectsManager.setRunningState(true)
    return this
  }

  stop(): this {
    this.transportControl.stop()
    this.effectsManager.setRunningState(false)
    this.midiManager.stop()
    this.transportClock.stop()
    return this
  }

  // Sequence management
  get seq(): Sequence {
    return this.sequenceRegistry.seq
  }

  registerSequence(name: string, sequence: Sequence): void {
    this.sequenceRegistry.registerSequence(name, sequence)
  }

  getSequence(name: string): Sequence | undefined {
    return this.sequenceRegistry.getSequence(name)
  }

  // Get the global scheduler (used by audio sequences for scheduling)
  getScheduler(): Scheduler {
    return this.globalScheduler
  }

  /**
   * Get the MIDI transport scheduler — a TransportClock-backed Scheduler that
   * MIDI sequences use instead of the SC audio engine. Shares the same
   * Date.now() origin as the audio scheduler (set at `start()`), so audio and
   * MIDI stay in sync while MIDI stays free of SuperCollider.
   */
  getMidiTransport(): Scheduler {
    return this.midiTransport
  }

  /** True while the transport is running (set by `start()` / cleared by `stop()`). */
  isTransportRunning(): boolean {
    return this.transportClock.running
  }

  // Get internal state for compatibility
  getState(): GlobalState {
    return {
      ...this.tempoManager.getState(),
      ...this.audioManager.getState(),
      ...this.effectsManager.getState(),
      ...this.transportControl.getState(),
      ...this.linkAudioManager.getState(),
    }
  }
}

// Export a singleton factory
export function createGlobal(audioEngine: AudioEngine): Global {
  return new Global(audioEngine)
}
