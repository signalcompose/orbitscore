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
import { QuantizeManager, QuantizeValue, nextQuantizedTime } from './global/quantize-manager'
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

    // #283: in LinkAudio mode, lead the session tempo so peers follow.
    this.pushLinkTempoIfLeading()

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

  /** §2.2: bind a user pitch lattice (mode) into the namespace, referenced by `.mode(name)`. */
  defineMode(name: string, lattice: number[], period: number): this {
    this.setChord(name, { kind: 'mode', lattice, period })
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
    // #283: assert leadership for a tempo set before this call (usual order is
    // global.tempo() then global.linkAudio()).
    this.pushLinkTempoIfLeading()
    return this
  }

  isLinkAudioEnabled(): boolean {
    return this.linkAudioManager.isEnabled()
  }

  /**
   * #283 — When LinkAudio mode is on, push the current tempo to the Link
   * session so OrbitScore is the tempo leader and peers (Ableton Live, etc.)
   * follow `global.tempo()`. Fire-and-forget / best-effort: a failed push must
   * never break playback, and the OSC layer no-ops when the engine is not
   * running.
   *
   * Called from three points so leadership is asserted regardless of statement
   * order in the .orbs file:
   *   - tempo()     — live tempo changes propagate to the session.
   *   - linkAudio() — captures a tempo set BEFORE the mode was enabled (the
   *                   usual order is `global.tempo(60)` then `global.linkAudio()`).
   *   - start()     — re-asserts once the transport is running.
   *
   * Leader model: Link is last-setter-wins, so if a peer (Live) sets tempo
   * afterwards it wins until the next push. The MIDI scheduler free-runs at
   * `global.tempo()` while audio commits at the Link beat — they stay aligned
   * only while OrbitScore is the sole tempo-setter. Practical rule: set tempo in
   * OrbitScore, do not drive tempo from Live.
   */
  private pushLinkTempoIfLeading(): void {
    if (!this.isLinkAudioEnabled()) return
    const bpm = this.tempoManager.tempo()
    if (typeof bpm !== 'number') return
    void this.audioEngine
      .setLinkTempo?.(bpm)
      ?.catch((err) => console.warn('⚠️  Link tempo push failed:', err))
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

  /**
   * §L1 (#229): optional session-log hooks fired at transport start/stop. Set
   * ONLY by the interpreter when logging is enabled — unset by default, so a
   * `Global` constructed in a unit test never writes a `.orbslog`. `onStop` runs
   * BEFORE the clock is cleared so the stop record can read the transport time.
   */
  private _onTransportStart?: () => void
  private _onTransportStop?: () => void
  setTransportHooks(hooks: { onStart?: () => void; onStop?: () => void }): void {
    this._onTransportStart = hooks.onStart
    this._onTransportStop = hooks.onStop
  }

  // Transport control
  start(): this {
    // §L1: only open a NEW session on an actual stopped→running transition —
    // transportClock.start() is idempotent, so a redundant start() while running
    // must not open a second (orphaned) log file.
    const wasRunning = this.transportClock.running
    // Stamp the shared clock origin FIRST so the audio scheduler (started by
    // transportControl) and the MIDI scheduler share the same Date.now() base.
    this.transportClock.start()
    this.transportControl.start()
    this.effectsManager.setRunningState(true)
    this.midiManager.start()
    if (!wasRunning) {
      // §L1: best-effort — a log-open failure must never break playback.
      try {
        this._onTransportStart?.()
      } catch (e) {
        console.warn(`⚠️  session-log: start hook failed (playback continues): ${e}`)
      }
    }
    // #283: re-assert Link tempo leadership once the transport is running.
    this.pushLinkTempoIfLeading()
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
    // §L1: write the stop record BEFORE the clock clears, only if actually
    // running, and never let a log-write error block the note-offs below (a
    // throw here would otherwise leave MIDI notes hanging — music unstoppable).
    if (this.transportClock.running) {
      try {
        this._onTransportStop?.()
      } catch (e) {
        console.warn(`⚠️  session-log: stop hook failed (playback continues): ${e}`)
      }
    }
    this.transportControl.stop()
    this.effectsManager.setRunningState(false)
    this.midiManager.stop()
    this.transportClock.stop()
    return this
  }

  /**
   * §L1 (#229 §3 transport): the current musical position as `"bar:beat"`
   * (1-based bar, 1-based fractional beat in the meter's denominator unit), or
   * null when transport is not running (before `start()` or after `stop()`).
   * Origin = `global.start()` (transportClock origin); bar 1 beat 1.0 at elapsed 0.
   */
  getTransportPosition(): string | null {
    if (!this.transportClock.running) return null
    return this.msToBarBeat(Date.now() - this.transportClock.startTime)
  }

  /**
   * §L1 (#229 §3 effect): the resolved quantize boundary `"bar:beat"` at which a
   * quantized op evaluated *now* would take effect, or null when transport is
   * not running or quantize is off. Reuses {@link nextQuantizedTime} (Phase 0-2).
   */
  getQuantizedEffectPosition(): string | null {
    if (!this.transportClock.running) return null
    const q = this.quantizeManager.getQuantize()
    if (q === 'off') return null
    const params = this.transportParams()
    const currentMs = Date.now() - this.transportClock.startTime
    return this.msToBarBeat(nextQuantizedTime(currentMs, q, params.tempo, params.beat), params)
  }

  /** Tempo + meter in effect now (global defaults; §3 transport reference frame). */
  private transportParams(): { tempo: number; beat: { numerator: number; denominator: number } } {
    const state = this.tempoManager.getState()
    return {
      tempo: state.tempo ?? 120,
      beat: state.beat ?? { numerator: 4, denominator: 4 },
    }
  }

  /** Convert elapsed transport ms to a `"bar:beat"` string (§3). */
  private msToBarBeat(
    elapsedMs: number,
    params: {
      tempo: number
      beat: { numerator: number; denominator: number }
    } = this.transportParams(),
  ): string {
    const { tempo, beat } = params
    const beatUnitMs = ((60_000 / tempo) * 4) / beat.denominator // one meter-beat
    const totalBeatUnits = Math.max(0, elapsedMs) / beatUnitMs
    const bar = Math.floor(totalBeatUnits / beat.numerator) + 1
    const beatInBar = (totalBeatUnits % beat.numerator) + 1
    return `${bar}:${beatInBar.toFixed(3)}`
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
