/**
 * Sequence class for OrbitScore
 * Represents an individual musical sequence with its own properties
 * Refactored to use modular architecture with parameter, scheduling, and state managers
 */

import * as path from 'path'

import { AudioEngine } from '../audio/types'
import { PlayElement, RandomValue } from '../parser/audio-parser'
import { resolveDegree } from '../midi/degree-resolution'
import { resolveChords } from '../midi/chord/resolve-chords'
import { RootContext } from '../midi/types'
import { TimedEventScope } from '../timing/calculation/types'

import { Global } from './global'
import { Scheduler } from './global/types'
import { preparePlayback } from './sequence/playback/prepare-playback'
import { runSequence } from './sequence/playback/run-sequence'
import { loopSequence } from './sequence/playback/loop-sequence'
import { prepareSlices as prepareSlicesUtil } from './sequence/audio/prepare-slices'
import { GainManager } from './sequence/parameters/gain-manager'
import { PanManager } from './sequence/parameters/pan-manager'
import { TempoManager } from './sequence/parameters/tempo-manager'
import { SequenceQuantizeManager } from './sequence/parameters/quantize-manager'
import { QuantizeValue, nextQuantizedTime } from './global/quantize-manager'
import { StateManager } from './sequence/state/state-manager'
import { scheduleEvents, scheduleEventsFromTime } from './sequence/scheduling/event-scheduler'

/**
 * `{ }` legato overlap (§4): how long the interior note rings past the next
 * note-on. §10-2 leaves the exact value to a listening test; 20ms is the middle
 * of the recommended 10-30ms. TODO(§10-2): finalize by ear.
 */
const LEGATO_OVERLAP_MS = 20

/**
 * One MIDI note planned from a TimedEvent during scheduling (§5/§4 output stage).
 * Stage A fills the resolved pitch + flags; Stage B computes `offTime` and `emit`
 * (tie absorption / voice-tie suppression / legato overlap); Stage C emits.
 */
interface PlannedNote {
  onTime: number
  slotDur: number
  note: number | null // null = rest, or a `_` event-tie marker (no pitch)
  detune: number
  tie: boolean // `_` event tie — absorbed into the previous emitting note
  legato: boolean
  voiceTie: boolean
  hold: boolean
  tieSlots: number // extra slot duration absorbed from following `_` ties
  offTime: number
  emit: boolean
}

export class Sequence {
  private global: Global
  private audioEngine: AudioEngine

  // Managers
  private gainManager: GainManager
  private panManager: PanManager
  private tempoManager: TempoManager
  private quantizeManager: SequenceQuantizeManager
  private stateManager: StateManager

  // Audio properties
  private _audioFilePath?: string
  private _chopDivisions?: number

  // LinkAudio output channel (only meaningful when Global.linkAudio() is enabled)
  private _outputChannel?: string

  // MIDI properties (only meaningful when seq.midi() was declared).
  // A MIDI sequence interprets play() values as degrees, not slice numbers.
  private _midiPort?: string // resolved actual port name
  private _midiChannel?: number // 1..16
  private _gate = 0.8 // default gate length (fraction of slot). spec §1
  private _vel = 96 // default velocity 1..127. spec §1
  private _hold = false // §5.3: auto common-tone tie between consecutive stacks
  private _octave = 4 // base octave; degree 1 MIDI note. default 4 (C4=60)
  private _rootDegree?: number // seq.root(n): numeric root = degree of global.key()

  constructor(global: Global, audioEngine: AudioEngine) {
    this.global = global
    this.audioEngine = audioEngine

    // Initialize managers
    this.gainManager = new GainManager()
    this.panManager = new PanManager()
    this.tempoManager = new TempoManager()
    this.quantizeManager = new SequenceQuantizeManager()
    this.stateManager = new StateManager()
  }

  /**
   * Resolve the effective quantize value for this sequence: explicit override
   * if set via `seq.quantize(...)`, otherwise the global value.
   */
  private resolveQuantize(): QuantizeValue {
    return this.quantizeManager.getQuantize() ?? this.global.getQuantize()
  }

  /**
   * Compute the next quantized boundary (ms since scheduler start) at or after
   * `currentTime`. Uses the master grid (global tempo + beat) so that
   * polymeter sequences still align on global bars by default. Returns
   * `currentTime` unchanged when the resolved quantize is "off".
   */
  private nextQuantizedTime(currentTime: number): number {
    const globalState = this.global.getState()
    return nextQuantizedTime(
      currentTime,
      this.resolveQuantize(),
      globalState.tempo || 120,
      globalState.beat,
    )
  }

  /**
   * Set per-sequence launch quantize, overriding the global value. Accepted
   * values: "off" | "beat" | "bar" | "2bar" | "4bar" | "8bar".
   */
  quantize(value: QuantizeValue): this {
    this.quantizeManager.setQuantize(value)
    return this
  }

  // Set the name (called when assigned to a variable)
  setName(name: string): this {
    this.stateManager.setName(name)
    this.global.registerSequence(name, this)
    return this
  }

  // Recalculate timed events from current tempo/beat/length settings
  private recalculateTiming(): void {
    const playPattern = this.stateManager.getPlayPattern()
    if (playPattern && playPattern.length > 0) {
      const globalState = this.global.getState()
      const timedEvents = this.tempoManager.calculateEventTiming(
        playPattern,
        globalState.tempo || 120,
        globalState.beat,
      )
      this.stateManager.setTimedEvents(timedEvents)
    }
  }

  // Method chaining setters
  tempo(value: number): this {
    this.tempoManager.setTempo(value)
    this.recalculateTiming()
    this.seamlessParameterUpdate('tempo', `${value} BPM`)
    return this
  }

  beat(numerator: number, denominator: number): this {
    this.tempoManager.setBeat(numerator, denominator)
    this.recalculateTiming()
    this.seamlessParameterUpdate('beat', `${numerator}/${denominator}`)
    return this
  }

  length(bars: number): this {
    this.tempoManager.setLength(bars)
    this.recalculateTiming()
    this.seamlessParameterUpdate('length', `${bars} bars`)
    return this
  }

  /**
   * Seamlessly update parameter during playback.
   *
   * Behavior by parameter:
   * - tempo / beat / length: defer to next cycle. recalculateTiming() has
   *   already refreshed the timed events; the loop timer's
   *   getPatternDurationFn() will pick up the new duration on the next tick.
   * - play: defer to next cycle. The new pattern is already on stateManager,
   *   so the next loopSequence iteration will schedule from it. Rhythm
   *   changes mid-bar would smear the groove; waiting for the bar boundary
   *   keeps swaps musical.
   * - gain / pan / audio / chop: reschedule immediately. Volume / panning
   *   are real-time mixer-style adjustments, and audio / chop swaps are rare
   *   enough that the live-coding "instant feedback" wins over alignment.
   */
  private seamlessParameterUpdate(parameterName: string, description: string): void {
    if (this.stateManager.isLooping() || this.stateManager.isPlaying()) {
      const scheduler = this.activeScheduler()

      if (scheduler.isRunning && this.stateManager.getLoopStartTime() !== undefined) {
        const deferToNextCycle = ['tempo', 'beat', 'length', 'play'].includes(parameterName)

        if (deferToNextCycle && this.stateManager.isLooping()) {
          console.log(
            `🎚️ ${this.stateManager.getName()}: ${parameterName}=${description} (next cycle)`,
          )
          return
        }

        // Immediate reschedule for the remaining parameters
        const now = Date.now()
        const currentTime = now - scheduler.startTime
        this.clearEvents(this.stateManager.getName())
        this.scheduleEventsFromTime(scheduler, currentTime)
        console.log(`🎚️ ${this.stateManager.getName()}: ${parameterName}=${description} (seamless)`)
      }
    }
  }

  /**
   * Restart the loop from the current time with updated timing parameters.
   * Cancels the old loop timer and starts a fresh loop cycle.
   */
  private restartLoopFromCurrentTime(scheduler: Scheduler, currentTime: number): void {
    // Cancel old loop timer
    const oldTimer = this.stateManager.getLoopTimer()
    if (oldTimer) {
      clearTimeout(oldTimer)
    }

    // Reset loop start time to now (fresh loop cycle boundary)
    this.stateManager.setLoopStartTime(currentTime)

    // Start new loop from current time
    const result = loopSequence({
      sequenceName: this.stateManager.getName(),
      scheduler,
      currentTime,
      scheduleEventsFn: (sched, offset, baseTime) => this.scheduleEvents(sched, offset, baseTime),
      scheduleEventsFromTimeFn: (sched, fromTime) => this.scheduleEventsFromTime(sched, fromTime),
      getPatternDurationFn: () => this.getPatternDuration(),
      clearSequenceEventsFn: (name) => this.clearEvents(name),
      getIsLoopingFn: () => this.stateManager.isLooping(),
      getIsMutedFn: () => this.stateManager.isMuted(),
      setLoopTimerFn: (timer) => this.stateManager.setLoopTimer(timer),
    })

    this.stateManager.setLoopStartTime(result.loopStartTime)
  }

  gain(valueDb: number | RandomValue): this {
    this.gainManager.setGain({ valueDb })
    this.seamlessParameterUpdate('gain', this.gainManager.getGainDescription())
    return this
  }

  /**
   * Set default gain (initial fader position) without immediate playback.
   * This sets the gain value but does not trigger seamless parameter update.
   * Use this to configure initial gain before starting playback.
   * @param valueDb - Gain in decibels (-60 to +12 dB)
   * @returns this for method chaining
   */
  defaultGain(valueDb: number | RandomValue): this {
    this.gainManager.setGain({ valueDb })
    return this
  }

  pan(value: number | RandomValue): this {
    this.panManager.setPan({ value })
    this.seamlessParameterUpdate('pan', this.panManager.getPanDescription())
    return this
  }

  /**
   * Set the LinkAudio output channel name for this sequence.
   *
   * Effective only when `Global.linkAudio()` was declared earlier in the same
   * .orbs file. Without that declaration the assignment is recorded but the
   * sequence still routes through the hardware bus, and a runtime warning is
   * emitted on each call when LinkAudio mode is not enabled. Multiple sequences
   * sharing the same channel name are summed by the SC plugin.
   *
   * Channel changes take effect at the next scheduling cycle; in-flight loop
   * iterations are not rewritten (no `seamlessParameterUpdate` — channel
   * switching mid-loop is a separate feature, planned for Step 3.4).
   */
  output(channelName: string): this {
    if (!channelName || !channelName.trim()) {
      throw new Error(
        `Sequence '${this.stateManager.getName() || 'sequence'}': output(channelName) requires a non-empty channel name.`,
      )
    }
    this._outputChannel = channelName
    if (!this.global.isLinkAudioEnabled()) {
      console.warn(
        `⚠️  ${this.stateManager.getName() || 'sequence'}.output("${channelName}") ` +
          `was called without 'global.linkAudio()'. The channel name is recorded ` +
          `but will not take effect until LinkAudio mode is declared.`,
      )
    }
    return this
  }

  getOutputChannel(): string | undefined {
    return this._outputChannel
  }

  /**
   * Set default pan (initial pan position) without immediate playback.
   * This sets the pan value but does not trigger seamless parameter update.
   * Use this to configure initial pan before starting playback.
   * @param value - Pan value (-100 to +100, where 0 is center, -100 is left, +100 is right)
   * @returns this for method chaining
   */
  defaultPan(value: number | RandomValue): this {
    this.panManager.setPan({ value })
    return this
  }

  /**
   * Declare this sequence as a MIDI output (§1). `play()` values are then
   * interpreted as degrees, not slice numbers. Cannot be combined with
   * `audio()` / `chop()`. Coexists with the SuperCollider audio path (no
   * LinkAudio-style exclusion).
   *
   * @param portName CoreMIDI output port (case-insensitive substring, e.g.
   *                 "iac" matches "IACドライバ バス1"). Resolved eagerly so an
   *                 unknown port errors at declaration time.
   * @param channel  MIDI channel 1..16.
   */
  midi(portName: string, channel: number): this {
    const name = this.stateManager.getName() || 'sequence'
    if (this._audioFilePath !== undefined) {
      throw new Error(`Sequence '${name}': midi() cannot be combined with audio()/chop().`)
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
      throw new Error(
        `Sequence '${name}': midi() channel must be an integer 1..16, got ${channel}.`,
      )
    }
    // Resolve the port eagerly (throws listing available ports on no match).
    this._midiPort = this.global.getMidiManager().getOutput().ensurePort(portName)
    this._midiChannel = channel
    return this
  }

  /** True when this sequence outputs MIDI (declared via `seq.midi()`). */
  isMidi(): boolean {
    return this._midiPort !== undefined
  }

  /** Default gate length as a fraction of the slot (0..1). spec §1. */
  /**
   * Enable auto common-tone ties between consecutive stacks (§5.3). A pitch shared
   * by two adjacent stacks is held (note-off/on suppressed) rather than retriggered
   * — automatic application of the §5.2 voice tie. Stack-to-stack only (a repeated
   * single note never auto-ties, so rhythm is preserved — decision #8).
   */
  hold(): this {
    this._hold = true
    return this
  }

  gate(value: number): this {
    this._gate = Math.max(0, Math.min(1, value))
    return this
  }

  /** Default MIDI velocity (1..127). spec §1. */
  vel(value: number): this {
    this._vel = Math.max(1, Math.min(127, Math.round(value)))
    return this
  }

  /** Base octave determining the MIDI note of degree 1 (default 4, C4=60). */
  octave(value: number): this {
    this._octave = Math.round(value)
    return this
  }

  /**
   * Sequence-default root as a numeric degree of `global.key()` (§2.3).
   * Note-name roots (`F#`) are Phase 2. Resolved against the key at dispatch;
   * a numeric root with no `global.key()` declared is an error then.
   */
  root(degree: number): this {
    // A root must be a positive degree. degree 0 is a rest, not a pitch center;
    // without this guard root(0) resolves to null and silently falls back to
    // the key tonic (§2.3), playing the wrong center with no error.
    if (!Number.isInteger(degree) || degree < 1) {
      throw new Error(
        `Sequence '${this.stateManager.getName() || 'sequence'}': ` +
          `root() degree must be a positive integer (1+), got ${degree}. ` +
          `Degree 0 is a rest, not a valid root.`,
      )
    }
    this._rootDegree = degree
    return this
  }

  audio(filepath: string): this {
    const name = this.stateManager.getName() || 'sequence'
    if (this.isMidi()) {
      throw new Error(`Sequence '${name}': audio() cannot be combined with midi().`)
    }
    // Resolve to absolute path. Supports path-direct forms (./, ../, ~/, /,
    // contains '/') and bare bank names like "bd" or "bd:2" via the global
    // audioPath search list. See audio-resolver.ts for the rules.
    const fullPath = this.global.resolveAudioSpec(filepath)

    this._audioFilePath = fullPath
    this._chopDivisions = 1 // Reset chop when audio changes
    this.seamlessParameterUpdate('audio', path.basename(fullPath))
    return this
  }

  // Note: Audio loading is now handled by SuperCollider's buffer manager
  // This method is kept for backward compatibility but does nothing
  async loadAudio(): Promise<void> {
    // SuperCollider handles audio loading internally via loadBuffer()
    // No action needed here
  }

  chop(divisions: number): this {
    if (this.isMidi()) {
      throw new Error(
        `Sequence '${this.stateManager.getName() || 'sequence'}': chop() cannot be combined with midi().`,
      )
    }
    this._chopDivisions = divisions

    if (!this._audioFilePath) {
      console.error(`${this.stateManager.getName()}: no audio file set`)
      return this
    }

    this.seamlessParameterUpdate('chop', `${divisions} divisions`)
    return this
  }

  private async prepareSlices(): Promise<void> {
    await prepareSlicesUtil({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
    })
  }

  play(...elements: PlayElement[]): this {
    // §6 evaluation (L2): resolve chord-name refs / `-N` removals / `^N` against the
    // global chord namespace BEFORE timing, so the stored pattern is pure symbolic
    // (no chord_ref reaches the timing walk). 評価時値渡し — a later chord
    // redefinition does not retro-affect this already-resolved pattern (§6.5.2).
    const { elements: resolved, warnings } = resolveChords(elements, (name) =>
      this.global.getBinding(name),
    )
    for (const w of warnings) {
      console.warn(`⚠️  Sequence '${this.stateManager.getName() || 'sequence'}': ${w}`)
    }

    this.stateManager.setPlayPattern(resolved)

    // Calculate timing for the play pattern
    const globalState = this.global.getState()
    const timedEvents = this.tempoManager.calculateEventTiming(
      resolved,
      globalState.tempo || 120,
      globalState.beat,
    )

    this.stateManager.setTimedEvents(timedEvents)

    const patternStr = resolved
      .map((e) => (typeof e === 'object' ? JSON.stringify(e) : e))
      .join(' ')
    this.seamlessParameterUpdate('play', patternStr)
    return this
  }

  /**
   * The scheduler this sequence schedules against: the MIDI transport (a shared
   * TransportClock, no SuperCollider) for MIDI sequences, the SC audio engine
   * for audio sequences. Both share the same Date.now() origin, so audio and
   * MIDI stay in sync (§1).
   */
  private activeScheduler(): Scheduler {
    return this.isMidi() ? this.global.getMidiTransport() : this.global.getScheduler()
  }

  /**
   * Clear this sequence's scheduled events, routing to the right scheduler.
   * For MIDI, `clearOwner` also releases any sounding notes (§7-2), so loop /
   * mute / play swaps never leave hanging notes.
   */
  private clearEvents(name: string): void {
    if (this.isMidi()) {
      this.global.getMidiManager().getScheduler().clearOwner(name)
    } else {
      this.global.getScheduler().clearSequenceEvents(name)
    }
  }

  /**
   * Resolve this sequence's root context for degree resolution (§2.1, §2.3).
   *
   * Phase 1 supports the sequence default only: a numeric `seq.root(n)` is the
   * n-th degree of `global.key()`; with no `seq.root()`, the key tonic is the
   * root. A degree with neither a key nor a root is a hard error.
   */
  private resolveRootContext(): RootContext {
    const name = this.stateManager.getName() || 'sequence'
    const keyPC = this.global.getMidiManager().getKeyPitchClass()

    if (keyPC === undefined) {
      throw new Error(
        `Sequence '${name}': MIDI degrees need a root. Declare global.key("C") (or set seq.root()).`,
      )
    }

    // The numeric root resolves against the key exactly like any degree (§2.3).
    const rootPitchClass =
      this._rootDegree !== undefined
        ? this.degreeRootToPitchClass(this._rootDegree, 0, keyPC)
        : keyPC

    return { rootPitchClass, octave: this._octave }
  }

  /**
   * Resolve a degree against the key to a pitch class — shared by the sequence
   * root (§2.3) and a group `.root(degree)` scope. The degree numbers from the
   * key tonic at octave 0; only the resulting pitch class is kept.
   */
  private degreeRootToPitchClass(degree: number, alteration: number, keyPC: number): number {
    const resolved = resolveDegree(
      { degree, alteration, octaveShift: 0, detune: 0 },
      { rootPitchClass: keyPC, octave: 0 },
    )
    if (!resolved) {
      // resolveDegree returns null only for degree 0 (a rest). A rest is not a
      // valid pitch center — never silently fall back to the key tonic. (Both
      // callers also guard upstream: seq.root() setter + parseRootArg.)
      throw new Error('root degree 0 is a rest, not a valid root.')
    }
    return ((resolved.midiNote % 12) + 12) % 12
  }

  /**
   * Resolve a per-event lexical group scope (§3) to a RootContext. A group
   * `.root()` (already collapsed inner→outer in the timing walk) overrides the
   * sequence default; `.mode()` is reserved (throws — Phase 2.2); no scope (or
   * an oct-only scope) falls back to the sequence default. A degree root
   * resolves against `global.key()` exactly like a sequence root (§2.3) — a
   * numeric/degree root with no key declared is an error here.
   */
  private resolveScopeToContext(
    scope: TimedEventScope | undefined,
    getSeqDefault: () => RootContext,
  ): RootContext {
    // The seq default is taken lazily: a note-name-rooted event needs no key
    // (§2.3), so a sequence that only uses note roots must not be forced to
    // declare global.key() just to compute a default it never uses.
    if (!scope || (scope.root === undefined && scope.mode === undefined)) {
      return getSeqDefault()
    }
    const name = this.stateManager.getName() || 'sequence'
    if (scope.mode !== undefined) {
      throw new Error(
        `Sequence '${name}': .mode(${scope.mode.raw}) is not implemented in v1.1 ` +
          `(the mode lattice is Phase 2.2).`,
      )
    }
    const root = scope.root!
    if (root.kind === 'note') {
      return { rootPitchClass: root.pitchClass, octave: this._octave }
    }
    // Degree root: resolve against the key (key-undeclared = error).
    const keyPC = this.global.getMidiManager().getKeyPitchClass()
    if (keyPC === undefined) {
      throw new Error(
        `Sequence '${name}': a degree root (.root(${root.degree})) needs global.key("C").`,
      )
    }
    return {
      rootPitchClass: this.degreeRootToPitchClass(root.degree, root.alteration, keyPC),
      octave: this._octave,
    }
  }

  /**
   * Eagerly validate a MIDI sequence's dispatch before scheduling: resolve the
   * root context (key/root errors) AND resolve every degree once (so a rejected
   * degree — 10/12/14/15+, §2.1 — throws here). This runs synchronously in the
   * awaited run()/loop() chain, NOT in the fire-and-forget scheduleEventsFn
   * callback, so the error reaches the caller (REPL/test) instead of becoming an
   * unhandled rejection. The resolved notes are discarded; scheduleMidiEvents
   * recomputes them with the running pitch range (§2.4).
   */
  private validateMidiDispatch(): void {
    if (!this.isMidi()) return
    const timedEvents = this.stateManager.getTimedEvents()
    if (!timedEvents) return
    let seqDefault: RootContext | undefined
    const getSeqDefault = (): RootContext => (seqDefault ??= this.resolveRootContext())
    for (const ev of timedEvents) {
      // Resolve the per-event group scope (§3) so a bad scope (.mode, a degree
      // root with no key) or a rejected degree throws here, in the awaited
      // chain, rather than later in the fire-and-forget scheduling callback.
      const context = this.resolveScopeToContext(ev.scope, getSeqDefault)
      const symbolic = ev.pitch ?? {
        degree: ev.sliceNumber,
        alteration: 0,
        octaveShift: 0,
        detune: 0,
      }
      resolveDegree(symbolic, context) // throws on a rejected/invalid degree
    }
  }

  /**
   * Eager guard: a `[ ]` stack (§4) is reserved as a diagnostic error in AUDIO
   * sequences (§10-5) — simultaneous note-on is a MIDI feature in v1.1; audio
   * slice layering is a future addition. By dispatch the timing walk has dissolved
   * the stack into overlapping events, so this scans the RAW play pattern instead,
   * in the awaited run()/loop() chain (same rationale as validateMidiDispatch) so
   * the throw reaches the caller rather than becoming an unhandled rejection.
   */
  private validateNonMidiDispatch(): void {
    if (this.isMidi()) return
    const pattern = this.stateManager.getPlayPattern()
    if (pattern && this.containsStack(pattern)) {
      throw new Error(
        'Stack "[ ]" is not yet supported in audio sequences (reserved, §10-5). ' +
          'Simultaneous note-on is a MIDI feature in v1.1; audio slice layering is ' +
          'a future addition. See PITCH_DSL_SPEC §4 / §10-5.',
      )
    }
  }

  /**
   * Recursively detect a `[ ]` stack anywhere in a raw play pattern — including
   * inside `( )` groups, `.root()`/`.oct()` scope groups, and `.chop()` modifiers
   * (a stack nested in `([...]).root(2)` must still be found).
   */
  private containsStack(elements: PlayElement[]): boolean {
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue
      if (el.type === 'stack') return true
      if (el.type === 'nested' && this.containsStack(el.elements)) return true
      if (el.type === 'scoped' && this.containsStack(el.groups)) return true
      if (
        el.type === 'modified' &&
        typeof el.value === 'object' &&
        el.value.type === 'nested' &&
        this.containsStack(el.value.elements)
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Schedule this sequence's timed events as MIDI notes (§7-0 output stage:
   * symbolic pitch is resolved to a MIDI note number here, at the last moment).
   *
   * @param schedulerStartTime epoch ms of the audio scheduler start (shared clock)
   * @param baseTime           ms since scheduler start for this iteration's bar
   */
  private scheduleMidiEvents(schedulerStartTime: number, baseTime: number): void {
    const timedEvents = this.stateManager.getTimedEvents()
    if (!timedEvents || timedEvents.length === 0 || this.stateManager.isMuted()) {
      return
    }

    const midi = this.global.getMidiManager()
    const scheduler = midi.getScheduler()
    scheduler.start() // idempotent — ensure the lookahead loop is running

    const owner = this.stateManager.getName()
    const port = this._midiPort!
    const channel = this._midiChannel!
    // Sequence-default context, computed lazily (only if some event falls back
    // to it — a note-name-rooted-only sequence needs no key, §2.3).
    let seqDefault: RootContext | undefined
    const getSeqDefault = (): RootContext => (seqDefault ??= this.resolveRootContext())
    const sendDelay = midi.sendDelayFor(port)

    // ── Stage A: resolve each event to a PlannedNote (§7-0 output stage) ──
    // §2.4 sticky pitch range: a note/rest with an explicit `^N` (rangeSet) sets
    // the running range; following degrees inherit it until the next `^M`/`^0`.
    // It resets to 0 at the top of each play() so re-evaluations stay deterministic.
    let runningRange = 0
    const plans: PlannedNote[] = timedEvents.map((ev) => {
      const written = ev.pitch ?? {
        degree: ev.sliceNumber,
        alteration: 0,
        octaveShift: 0,
        detune: 0,
      }
      const onTime = schedulerStartTime + baseTime + ev.startTime + sendDelay
      if (ev.tie) {
        // §5.1: a `_` event tie carries no pitch and never touches the running
        // range; Stage B1 absorbs its slot into the previous emitting note.
        return this.makeTiePlan(onTime, ev.duration)
      }
      // An explicit `^N` (including `^0` / a `0^N` rest) moves the running range.
      if (written.rangeSet) runningRange = written.octaveShift
      const context = this.resolveScopeToContext(ev.scope, getSeqDefault)
      // Effective octave = running range (`^N`) + group register (`.oct()`) + the
      // voice's structural shift (a stack voice's own `^N`, rangeSet=false, §4/§6).
      // A melodic `^N` (rangeSet=true) folded into runningRange already, so its
      // structural part is 0 — additive is a no-op for every pre-stack note (§9.3/§9.4).
      const structural = written.rangeSet ? 0 : written.octaveShift
      const effectiveOctave = runningRange + (ev.scope?.groupOct ?? 0) + structural
      const resolved = resolveDegree({ ...written, octaveShift: effectiveOctave }, context)
      return {
        onTime,
        slotDur: ev.duration,
        note: resolved ? resolved.midiNote : null, // null = rest (degree 0)
        detune: resolved ? resolved.detune : 0,
        tie: false,
        legato: !!ev.legato,
        voiceTie: !!ev.voiceTie,
        hold: this._hold || !!ev.scope?.hold,
        tieSlots: 0,
        offTime: 0,
        emit: resolved !== null,
      }
    })

    // ── Stage B: compute final offTime + suppress (preserves the on==off invariant) ──
    this.absorbEventTies(plans) // §5.1 `_`
    this.applyGateAndLegato(plans) // gate + §4/§5.4 `{ }` overlap
    this.applyVoiceTiesAndHold(plans) // §5.2 `_n` + §5.3 `.hold()`

    // ── Stage C: emit one scheduleNote per surviving note (exactly one off each) ──
    for (const p of plans) {
      if (!p.emit || p.note === null) continue
      scheduler.scheduleNote({
        owner,
        port,
        channel,
        note: p.note,
        velocity: this._vel,
        detune: p.detune,
        onTime: p.onTime,
        offTime: p.offTime,
      })
    }

    this.stateManager.setPlaying(true)
  }

  /** A `_` event-tie PlannedNote: no pitch, never emits — absorbed in Stage B1. */
  private makeTiePlan(onTime: number, slotDur: number): PlannedNote {
    return {
      onTime,
      slotDur,
      note: null,
      detune: 0,
      tie: true,
      legato: false,
      voiceTie: false,
      hold: false,
      tieSlots: 0,
      offTime: 0,
      emit: false,
    }
  }

  /**
   * §5.1: absorb each `_` event tie into the previous EMITTING note (extend its
   * span by the tie's slot, no retrigger). A leading `_` (no preceding note) or a
   * `_` after a rest extends nothing → silence. A rest breaks the tie chain.
   */
  private absorbEventTies(plans: PlannedNote[]): void {
    let lastEmitted: PlannedNote | undefined
    for (const p of plans) {
      if (p.tie) {
        if (lastEmitted) lastEmitted.tieSlots += p.slotDur
        continue
      }
      lastEmitted = p.note === null ? undefined : p
    }
  }

  /**
   * Base note-off per emitting note: gate over the (tie-extended) span, then the
   * §4 legato override — an interior `{ }` note's off is delayed to the next
   * note-on + overlap. A pattern-tail legato note (no next note-on) keeps gate.
   */
  private applyGateAndLegato(plans: PlannedNote[]): void {
    const onsetTimes = [...new Set(plans.filter((p) => p.note !== null).map((p) => p.onTime))].sort(
      (a, b) => a - b,
    )
    for (const p of plans) {
      if (p.note === null) continue
      p.offTime = p.onTime + (p.slotDur + p.tieSlots) * this._gate
      if (p.legato) {
        const next = onsetTimes.find((t) => t > p.onTime)
        if (next !== undefined) p.offTime = next + LEGATO_OVERLAP_MS
      }
    }
  }

  /**
   * §5.2 `_n` voice tie + §5.3 `.hold()`: a note whose RESOLVED pitch is sounding
   * from the immediately-preceding slot is held (its predecessor's off is extended,
   * its own on/off suppressed) instead of retriggered. `_n` applies per-voice;
   * `.hold()` applies to every common tone but only between two STACKS (slot size
   * > 1) — so repeated single notes never auto-tie (decision #8). Matching is by
   * resolved-pitch equality (decision #7); no match → play normally (fallback).
   */
  private applyVoiceTiesAndHold(plans: PlannedNote[]): void {
    const slots = new Map<number, PlannedNote[]>()
    for (const p of plans) {
      if (p.note === null) continue
      const slot = slots.get(p.onTime)
      if (slot) slot.push(p)
      else slots.set(p.onTime, [p])
    }
    const onsetTimes = [...slots.keys()].sort((a, b) => a - b)

    let prevSounding = new Map<number, PlannedNote>() // pitch → held note from previous slot
    let prevWasStack = false
    for (const t of onsetTimes) {
      const slot = slots.get(t)!
      const curIsStack = slot.length > 1
      const curSounding = new Map<number, PlannedNote>()
      for (const n of slot) {
        const wantTie = n.voiceTie || (n.hold && prevWasStack && curIsStack)
        const held = prevSounding.get(n.note!)
        if (wantTie && held) {
          // suppress this retrigger; extend the held note to cover this slot
          held.offTime = Math.max(held.offTime, n.onTime + n.slotDur * this._gate)
          n.emit = false
          curSounding.set(n.note!, held) // chain: the same note may hold across 3+ stacks
        } else {
          curSounding.set(n.note!, n)
        }
      }
      prevSounding = curSounding
      prevWasStack = curIsStack
    }
  }

  // Schedule events from a specific time onwards (for seamless parameter changes)
  private scheduleEventsFromTime(scheduler: Scheduler, fromTime: number): void {
    if (this.isMidi()) {
      this.scheduleMidiEvents(scheduler.startTime, fromTime)
      return
    }

    const timedEvents = this.stateManager.getTimedEvents()
    if (!timedEvents || !this._audioFilePath) {
      return
    }

    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    scheduleEventsFromTime({
      scheduler,
      fromTime,
      audioFilePath: this._audioFilePath,
      timedEvents,
      chopDivisions: this._chopDivisions,
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
      isMuted: this.stateManager.isMuted(),
      sequenceName: this.stateManager.getName(),
      loopStartTime: this.stateManager.getLoopStartTime(),
      masterGainDb: this.global.getMasterGainDb(),
      patternDuration: this.getPatternDuration(),
      outputChannel: this.resolveDispatchChannel(),
    })
  }

  /**
   * Resolve the channel to forward to the scheduler.
   *
   * Strict-mode contract (per DSL spec §8.1.2):
   *   - Global LinkAudio off, regardless of `.output()` → returns undefined
   *     (sequence routes through the hardware bus, existing behavior).
   *   - Global LinkAudio on AND `.output()` set → returns the channel name.
   *   - Global LinkAudio on AND `.output()` unset → throws. Hardware/LinkAudio
   *     mixing within the same file is forbidden, so a sequence with no
   *     declared destination is a hard error rather than a silent fallback.
   *     The VS Code diagnostic `analyzeLinkAudioMissingOutput` surfaces this
   *     at edit time; this throw is the runtime safety net for engines /
   *     CLIs / tests that bypass the editor.
   *
   * Public so the boot pipeline (Step 4) and the test suite can exercise the
   * dispatch contract without going through the full scheduling loop.
   */
  resolveDispatchChannel(): string | undefined {
    if (!this.global.isLinkAudioEnabled()) {
      return undefined
    }
    if (!this._outputChannel) {
      throw new Error(
        `Sequence '${this.stateManager.getName() || 'sequence'}' has no .output() ` +
          `channel set, but global.linkAudio() is enabled. LinkAudio mode requires ` +
          `every sequence to declare an output channel name. Add .output("name") ` +
          `to the sequence chain, or remove global.linkAudio() to fall back to ` +
          `hardware output.`,
      )
    }
    return this._outputChannel
  }

  async scheduleEvents(
    scheduler: Scheduler,
    loopIteration: number = 0,
    baseTime: number = 0,
  ): Promise<void> {
    if (this.isMidi()) {
      this.scheduleMidiEvents(scheduler.startTime, baseTime)
      return
    }

    const timedEvents = this.stateManager.getTimedEvents()
    if (!this._audioFilePath || !timedEvents || timedEvents.length === 0) {
      return
    }

    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    await scheduleEvents({
      scheduler,
      loopIteration,
      baseTime,
      audioFilePath: this._audioFilePath,
      timedEvents,
      chopDivisions: this._chopDivisions,
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
      isMuted: this.stateManager.isMuted(),
      sequenceName: this.stateManager.getName(),
      masterGainDb: this.global.getMasterGainDb(),
      patternDuration: this.getPatternDuration(),
      outputChannel: this.resolveDispatchChannel(),
    })

    this.stateManager.setPlaying(true)
  }

  // Calculate pattern duration
  private getPatternDuration(): number {
    const globalState = this.global.getState()
    return this.tempoManager.calculatePatternDuration(globalState.tempo || 120, globalState.beat)
  }

  // Transport control
  /**
   * @internal - Reserved keywords use only. Use RUN(seq) instead.
   */
  async run(): Promise<this> {
    // Validate the strict-mode contract eagerly so the throw propagates through
    // the awaited call chain to the REPL catch block, instead of becoming an
    // unhandled rejection inside the fire-and-forget scheduleEventsFn callback.
    this.resolveDispatchChannel()
    this.validateMidiDispatch() // eager root + degree validation (same rationale)
    this.validateNonMidiDispatch() // eager `[ ]`-in-audio rejection (§10-5)

    const prepared = await preparePlayback({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
      loopTimer: this.stateManager.getLoopTimer(),
      prepareSlicesFn: () => this.prepareSlices(),
      getScheduler: () => this.activeScheduler(),
    })

    if (!prepared) return this

    const { scheduler, currentTime } = prepared
    // Note: preparePlayback() has already cleared any existing loop timer
    // run() is one-shot playback, so we ensure loopTimer remains undefined
    this.stateManager.setLoopTimer(undefined)

    const result = await runSequence({
      sequenceName: this.stateManager.getName(),
      scheduler,
      currentTime,
      isPlaying: this.stateManager.isPlaying(),
      scheduleEventsFn: (sched, offset, baseTime) => this.scheduleEvents(sched, offset, baseTime),
      getPatternDurationFn: () => this.getPatternDuration(),
      clearSequenceEventsFn: (name) => this.clearEvents(name),
    })

    this.stateManager.setPlaying(result.isPlaying)
    this.stateManager.setLooping(result.isLooping)

    return this
  }

  /**
   * @internal - Reserved keywords use only. Use LOOP(seq) instead.
   */
  async loop(): Promise<this> {
    // Validate the strict-mode contract eagerly so the throw propagates through
    // the awaited call chain to the REPL catch block, instead of becoming an
    // unhandled rejection inside the fire-and-forget scheduleEventsFn callback.
    this.resolveDispatchChannel()
    this.validateMidiDispatch() // eager root + degree validation (same rationale)
    this.validateNonMidiDispatch() // eager `[ ]`-in-audio rejection (§10-5)

    const prepared = await preparePlayback({
      sequenceName: this.stateManager.getName(),
      audioFilePath: this._audioFilePath,
      chopDivisions: this._chopDivisions,
      loopTimer: this.stateManager.getLoopTimer(),
      prepareSlicesFn: () => this.prepareSlices(),
      getScheduler: () => this.activeScheduler(),
    })

    if (!prepared) return this

    const { scheduler, currentTime } = prepared

    // Set loop state BEFORE calling loopSequence to avoid race condition
    // The setInterval callback will check this state via getIsLoopingFn()
    this.stateManager.setLooping(true)
    this.stateManager.setPlaying(true)

    // Quantize the loop start to the next bar boundary on the master grid so
    // newly-started LOOPs slot in cleanly with whatever is already running.
    const startTime = this.nextQuantizedTime(currentTime)

    const result = loopSequence({
      sequenceName: this.stateManager.getName(),
      scheduler,
      currentTime,
      startTime,
      scheduleEventsFn: (sched, offset, baseTime) => this.scheduleEvents(sched, offset, baseTime),
      scheduleEventsFromTimeFn: (sched, fromTime) => this.scheduleEventsFromTime(sched, fromTime),
      getPatternDurationFn: () => this.getPatternDuration(),
      clearSequenceEventsFn: (name) => this.clearEvents(name),
      getIsLoopingFn: () => this.stateManager.isLooping(),
      getIsMutedFn: () => this.stateManager.isMuted(),
      setLoopTimerFn: (timer) => this.stateManager.setLoopTimer(timer),
    })

    // Update remaining state from result
    this.stateManager.setLoopStartTime(result.loopStartTime)

    return this
  }

  /**
   * @internal - Reserved keywords use only. Use LOOP() or RUN() to exclude sequence.
   */
  stop(): this {
    const sequenceName = this.stateManager.getName()
    const wasLooping = this.stateManager.isLooping()

    // Clear scheduled events (MIDI: also releases sounding notes, §7-2)
    this.clearEvents(sequenceName)

    // Clear loop timer (only exists if loop() was called, not run())
    // Note: run() sets loopTimer to undefined, so this check prevents redundant clearInterval
    const loopTimer = this.stateManager.getLoopTimer()
    if (loopTimer) {
      clearTimeout(loopTimer)
      this.stateManager.setLoopTimer(undefined)
    }

    // Clear state
    this.stateManager.setPlaying(false)
    this.stateManager.setLooping(false)

    // Log stop message for loop sequences
    if (wasLooping) {
      console.log(`⏹ ${sequenceName} (loop stopped)`)
    }

    return this
  }

  /**
   * @internal - Reserved keywords use only. Use MUTE(seq) instead.
   */
  mute(): this {
    const sequenceName = this.stateManager.getName()
    this.stateManager.setMuted(true)

    // Clear any scheduled events when muting (MIDI: also releases sounding
    // notes, §7-2). Prevents accumulated events from playing when unmuting.
    this.clearEvents(sequenceName)

    return this
  }

  /**
   * @internal - Reserved keywords use only. Use MUTE() to exclude sequence.
   */
  unmute(): this {
    const wasLooping = this.stateManager.isLooping()
    const sequenceName = this.stateManager.getName()
    this.stateManager.setMuted(false)

    // If this sequence is currently looping, clear old events and reschedule from current time
    // This prevents accumulated events from playing when unmuting
    if (wasLooping) {
      const scheduler = this.activeScheduler()
      const currentTime = Date.now() - scheduler.startTime

      console.log(`🔓 ${sequenceName}: unmuting and rescheduling from ${currentTime}ms`)

      // Clear old scheduled events (MIDI: also releases sounding notes, §7-2)
      this.clearEvents(sequenceName)

      // Reinitialize tracking so new events won't be skipped (audio scheduler;
      // a no-op for the MIDI path, which tracks per-owner in MidiOutput)
      scheduler.reinitializeSequenceTracking(sequenceName)

      // Reschedule from current time (seamless resume)
      this.scheduleEventsFromTime(scheduler, currentTime)
    }

    return this
  }

  /**
   * Notify that global tempo has changed
   * Only triggers seamless update if this sequence hasn't overridden tempo
   */
  notifyGlobalTempoChange(): void {
    if (this.tempoManager.getTempo() === undefined) {
      // Not overridden - recalculate timing with new global tempo and reschedule
      this.recalculateTiming()
      this.seamlessParameterUpdate('tempo', 'global tempo changed')
    }
  }

  /**
   * Notify that global beat has changed
   * Only triggers seamless update if this sequence hasn't overridden beat
   */
  notifyGlobalBeatChange(): void {
    if (this.tempoManager.getBeat() === undefined) {
      // Not overridden - recalculate timing with new global beat and reschedule
      this.recalculateTiming()
      this.seamlessParameterUpdate('beat', 'global beat changed')
    }
  }

  // Get state for debugging/inspection
  getState() {
    const state = this.stateManager.getState()
    const gainState = this.gainManager.getGain()
    const panState = this.panManager.getPan()

    return {
      ...state,
      tempo: this.tempoManager.getTempo(),
      beat: this.tempoManager.getBeat(),
      length: this.tempoManager.getLength(),
      gainDb: gainState.gainDb,
      gainRandom: gainState.gainRandom,
      pan: panState.pan,
      panRandom: panState.panRandom,
      outputChannel: this._outputChannel,
      midiPort: this._midiPort,
      midiChannel: this._midiChannel,
      gate: this._gate,
      vel: this._vel,
      octave: this._octave,
      rootDegree: this._rootDegree,
    }
  }
}
