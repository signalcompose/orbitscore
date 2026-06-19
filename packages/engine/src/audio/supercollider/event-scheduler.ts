/**
 * SuperColliderイベントスケジューラー
 */

import { ScheduledPlay, PlaybackOptions } from './types'
import { BufferManager } from './buffer-manager'
import { OSCClient } from './osc-client'
import { LinkAudioChannelRegistry } from './link-audio-channels'

// SynthDef names registered on the scsynth side. Keeping these as named
// constants ensures the two dispatch paths in `sendPlaybackMessage` can't
// drift apart from each other or from the plugin registration via a typo —
// a typo here would silently send the wrong SynthDef name to scsynth and
// produce no audio (or wrong routing) with no TS-level error.
const SYNTHDEF_HARDWARE = 'orbitPlayBuf'
const SYNTHDEF_LINK = 'orbitPlayBufLink'

export class EventScheduler {
  // Reserved node-id base for per-channel LinkAudio keepalive synths (#209).
  // Channel id N → keepalive node KEEPALIVE_NODE_BASE + N. Kept well clear of
  // the auto-assigned (-1) playback synths and the 2000+ mastering-effect ids.
  private static readonly KEEPALIVE_NODE_BASE = 800000

  public isRunning = false
  public startTime = 0
  private scheduledPlays: ScheduledPlay[] = []
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map()
  private intervalId: NodeJS.Timeout | null = null

  // LinkAudio dispatch state.
  private linkAudioChannels = new LinkAudioChannelRegistry()
  // Plugin-availability tri-state:
  //   null  = not yet probed. Boot leaves it null when the LinkAudio SynthDef
  //           loaded (SynthDef presence ≠ plugin presence), and it is resolved
  //           lazily on the first outputChannel dispatch by the plugin's
  //           `/done` reply (true) or our registration timeout (false).
  //   false = plugin confirmed absent — boot sets this when the LinkAudio
  //           SynthDef failed to load, and the lazy probe sets it on timeout.
  //           Dispatch falls back to the hardware bus and warns once per session.
  //   true  = plugin confirmed present (lazy `/done` probe, or a test override).
  // A transport error during probing leaves it null so a later dispatch
  // re-probes rather than permanently latching absence.
  private linkAudioPluginAvailable: boolean | null = null
  // channel ids already registered with the plugin this session (so we send the
  // `/cmd /orbit/registerLinkAudioChannel` once per channel, not per note).
  private registeredChannels = new Set<number>()
  private warnedAboutMissingPlugin = false
  // In-flight resolutions keyed by channel name. The first dispatch for a name
  // probes/registers async; concurrent dispatches for the SAME name (e.g. a
  // burst of notes, or eager output() + first note racing) must reuse that
  // in-flight promise instead of double-probing / double-registering. Cleared in
  // a `finally` so a later dispatch can re-attempt (e.g. after a transient error).
  private resolvingChannel = new Map<string, Promise<number | null>>()

  constructor(
    private bufferManager: BufferManager,
    private oscClient: OSCClient,
  ) {}

  /**
   * Explicitly set plugin availability. Called by the boot pipeline with `false`
   * only when the LinkAudio SynthDef failed to load (so dispatch short-circuits
   * to the hardware bus without the lazy probe's timeout); also a test override
   * hook. Boot does NOT call this with `true` — when the SynthDef loads, boot
   * leaves availability `null` so the lazy `/done` probe confirms actual plugin
   * presence on the first dispatch. When `false`, dispatch falls back to the
   * hardware bus and warns once per session.
   */
  setLinkAudioPluginAvailable(available: boolean): void {
    this.linkAudioPluginAvailable = available
    if (available) {
      this.warnedAboutMissingPlugin = false
    }
  }

  isLinkAudioPluginAvailable(): boolean {
    return this.linkAudioPluginAvailable === true
  }

  /**
   * Acquire the channel id for `name` and ensure it is registered with the
   * OrbitLinkAudio plugin (exactly once). On the very first link channel, the
   * plugin's `/done` reply doubles as presence detection. Returns the channel id
   * when LinkAudio should be used, or `null` to fall back to the hardware bus.
   *
   * Shared by the dispatch path (sendPlaybackMessage) and the eager path
   * (ensureLinkAudioChannelRegistered ← Sequence.output()).
   *
   * Concurrency guard: memoizes the in-flight resolution per channel name so
   * concurrent first-dispatches for the same channel reuse one probe/register
   * round-trip rather than racing. The memo entry is cleared in `finally`, so a
   * later dispatch re-attempts (idempotency keeps a successful re-attempt cheap).
   */
  private async resolveLinkAudioChannel(name: string): Promise<number | null> {
    const inFlight = this.resolvingChannel.get(name)
    if (inFlight) {
      return inFlight
    }
    const resolution = this.doResolveLinkAudioChannel(name)
    this.resolvingChannel.set(name, resolution)
    try {
      return await resolution
    } finally {
      this.resolvingChannel.delete(name)
    }
  }

  /**
   * Inner resolution logic for {@link resolveLinkAudioChannel} (kept separate so
   * the public method is a thin concurrency-memo wrapper). Single try/catch wraps
   * both `registerLinkAudioChannel` call sites so a transport-error rethrow never
   * escapes to the caller (sendPlaybackMessage has no catch). A transport error
   * leaves `linkAudioPluginAvailable` untouched (stays `null`/`true`) so a later
   * dispatch re-probes; only a genuine timeout (return `false`) latches absence.
   */
  private async doResolveLinkAudioChannel(name: string): Promise<number | null> {
    const channelId = this.linkAudioChannels.acquire(name)
    try {
      if (this.linkAudioPluginAvailable === null) {
        const detected = await this.oscClient.registerLinkAudioChannel(channelId, name)
        this.linkAudioPluginAvailable = detected
        if (detected) {
          await this.onChannelRegistered(channelId)
        }
      }
      if (!this.linkAudioPluginAvailable) {
        return null
      }
      if (!this.registeredChannels.has(channelId)) {
        const registered = await this.oscClient.registerLinkAudioChannel(channelId, name)
        if (!registered) {
          // The plugin was confirmed present earlier but this channel's
          // registration timed out — fall back to the hardware bus for this
          // dispatch WITHOUT latching absence or marking the channel registered,
          // so a later dispatch retries.
          console.warn(
            `⚠️  LinkAudio channel "${name}" registration timed out — falling back to the hardware bus for this dispatch.`,
          )
          return null
        }
        await this.onChannelRegistered(channelId)
      }
      return channelId
    } catch (err) {
      // Transport error (socket closed / server crash), not a plugin-absent
      // timeout. Leave `linkAudioPluginAvailable` as-is (null/true) so a later
      // dispatch re-probes rather than permanently latching the plugin absent.
      console.warn(
        `⚠️  LinkAudio channel "${name}" resolution failed (transport error) — falling back to the hardware bus for this dispatch:`,
        err,
      )
      return null
    }
  }

  /**
   * Mark a channel as registered with the plugin AND start its persistent
   * keepalive committer (#209) so the channel's Link stream stays continuous
   * between transient sample hits. Idempotent — one keepalive per channel.
   */
  private async onChannelRegistered(channelId: number): Promise<void> {
    if (this.registeredChannels.has(channelId)) {
      return
    }
    this.registeredChannels.add(channelId)
    await this.oscClient.startLinkAudioKeepalive(
      channelId,
      EventScheduler.KEEPALIVE_NODE_BASE + channelId,
    )
  }

  /**
   * Eagerly register a LinkAudio channel so its source appears in Live's
   * "Audio From" list at `.output()` declaration time — before any playback —
   * letting the operator pre-route Ableton tracks ahead of a performance.
   * Best-effort: a no-op if the server is not booted yet (the dispatch path
   * will register it later) and never throws.
   */
  async ensureLinkAudioChannelRegistered(name: string): Promise<void> {
    if (!this.oscClient.isRunning()) {
      return
    }
    try {
      await this.resolveLinkAudioChannel(name)
    } catch {
      // best-effort — dispatch-time registration remains as a fallback
    }
  }

  /**
   * Push a tempo to the Link session so OrbitScore leads (#283). Delegates to
   * the OSC client; no-op when the server is not running. Best-effort — tempo
   * leadership is advisory, so a failure must never break playback. Not gated
   * on plugin-availability detection: the OrbitLinkAudio plugin registers the
   * `/cmd` at PluginLoad (boot), independent of channel registration, so the
   * push is valid as soon as the server is up.
   */
  async setLinkTempo(bpm: number): Promise<void> {
    if (!this.oscClient.isRunning()) {
      return
    }
    try {
      await this.oscClient.setLinkTempo(bpm)
    } catch {
      // best-effort — a failed tempo push must never break playback
    }
  }

  /**
   * Internal accessor — exposes the channel registry. Used by the boot
   * pipeline to query allocated ids for telemetry / debug snapshots, and by
   * the test suite to assert idempotent acquire() behavior. Not part of the
   * public DSL surface — production code outside the boot pipeline should not
   * depend on this method.
   *
   * @internal
   */
  getLinkAudioChannelRegistry(): LinkAudioChannelRegistry {
    return this.linkAudioChannels
  }

  /**
   * 再生イベントをスケジュール
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
    outputChannel?: string,
  ): void {
    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: { gainDb, pan, outputChannel },
      sequenceName,
    }

    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push(play)
    }
  }

  /**
   * Calculate slice position and duration.
   */
  private calculateSlicePosition(
    filepath: string,
    sliceIndex: number,
    totalSlices: number,
  ): { sliceDuration: number; startPos: number; totalDuration: number } {
    const totalDuration = this.bufferManager.getAudioDuration(filepath)
    const sliceDuration = totalDuration / totalSlices
    // sliceIndex is 1-based from DSL, convert to 0-based
    const startPos = (sliceIndex - 1) * sliceDuration

    // Debug log for slice positioning (only in debug mode)
    if (process.env.ORBITSCORE_DEBUG) {
      console.log(
        `🔍 Slice debug: filepath=${filepath}, duration=${totalDuration}, sliceIndex=${sliceIndex}, totalSlices=${totalSlices}, sliceDuration=${sliceDuration}, startPos=${startPos}`,
      )
    }

    return { sliceDuration, startPos, totalDuration }
  }

  /**
   * Calculate playback rate to fit slice into event duration.
   * rate = actual slice duration / desired event duration
   * If eventDurationMs is undefined or 0, use natural rate (1.0)
   */
  private calculatePlaybackRate(
    sliceDurationSec: number,
    eventDurationMs: number | undefined,
  ): number {
    if (!eventDurationMs || eventDurationMs <= 0) {
      return 1.0
    }
    return (sliceDurationSec * 1000) / eventDurationMs
  }

  /**
   * Add scheduled play to the queue and track sequence events.
   */
  private addToScheduledPlays(play: ScheduledPlay): void {
    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (play.sequenceName) {
      if (!this.sequenceEvents.has(play.sequenceName)) {
        this.sequenceEvents.set(play.sequenceName, [])
      }
      this.sequenceEvents.get(play.sequenceName)!.push(play)
    }
  }

  /**
   * スライスイベントをスケジュール（chop用）
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number | undefined,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
    outputChannel?: string,
  ): void {
    const { sliceDuration, startPos } = this.calculateSlicePosition(
      filepath,
      sliceIndex,
      totalSlices,
    )
    const rate = this.calculatePlaybackRate(sliceDuration, eventDurationMs)

    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: {
        gainDb,
        pan,
        startPos,
        duration: sliceDuration,
        rate,
        outputChannel,
      },
      sequenceName,
    }

    this.addToScheduledPlays(play)
  }

  /**
   * スケジューラーを開始
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = Date.now()

    console.log('✅ Global starting')

    this.scheduledPlays.sort((a, b) => a.time - b.time)

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime

      while (this.scheduledPlays.length > 0 && this.scheduledPlays[0].time <= now) {
        const play = this.scheduledPlays.shift()!

        // Skip if this sequence's events have been cleared
        // (sequenceEvents.has() returns false if clearSequenceEvents() was called)
        if (play.sequenceName && !this.sequenceEvents.has(play.sequenceName)) {
          console.log(
            `🔧 [skip cleared] ${play.sequenceName}: skipping event at ${play.time}ms (cleared)`,
          )
          continue
        }

        // Execute playback asynchronously but handle errors
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time).catch(
          (error) => {
            console.error(`❌ Playback error for ${play.sequenceName}:`, error)
          },
        )
      }
    }, 1)
  }

  /**
   * スケジューラーを停止
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('✅ Global stopped')
  }

  /**
   * すべてを停止してイベントをクリア
   */
  stopAll(): void {
    this.stop()
    this.scheduledPlays = []
    this.sequenceEvents.clear()
    // Free the per-channel keepalive synths (#209) so they don't keep committing
    // silence after the session ends. Fire-and-forget, but handle the rejection
    // so a transient OSC error can't surface as an unhandled promise rejection.
    for (const channelId of this.registeredChannels) {
      this.oscClient
        .freeNode(EventScheduler.KEEPALIVE_NODE_BASE + channelId)
        .catch((err) =>
          console.warn(`⚠️  Failed to free keepalive synth for channel ${channelId}:`, err),
        )
    }
    // Reset LinkAudio channel id allocation on engine restart so a new
    // session does not inherit stale ids from the previous one.
    this.linkAudioChannels.clear()
    // Re-register channels with the plugin on the next session's first dispatch.
    this.registeredChannels.clear()
    // Re-probe plugin availability next session — the plugin may have been
    // installed (or removed) between sessions, so a cached result is stale.
    this.linkAudioPluginAvailable = null
  }

  /**
   * 特定のシーケンスのイベントをクリア
   */
  clearSequenceEvents(sequenceName: string): void {
    const beforeCount = this.scheduledPlays.length

    // Log events that will be cleared
    const eventsToRemove = this.scheduledPlays.filter((play) => play.sequenceName === sequenceName)
    if (eventsToRemove.length > 0) {
      console.log(
        `🔧 [clearEvents] ${sequenceName}: removing events at times: ${eventsToRemove.map((e) => e.time).join(', ')}ms`,
      )
    }

    this.scheduledPlays = this.scheduledPlays.filter((play) => play.sequenceName !== sequenceName)
    const afterCount = this.scheduledPlays.length
    const cleared = beforeCount - afterCount
    console.log(
      `🔧 [clearEvents] ${sequenceName}: cleared ${cleared} events (${beforeCount} → ${afterCount})`,
    )
    if (cleared > 0) {
      console.log(`⏹ ${sequenceName} (stopped)`)
    }
    // Delete from Map so that any events still in scheduledPlays will be skipped
    this.sequenceEvents.delete(sequenceName)
  }

  /**
   * シーケンスのイベントトラッキングを再初期化
   * unmute()後に新しいイベントをスケジュールする前に呼び出す
   */
  reinitializeSequenceTracking(sequenceName: string): void {
    this.sequenceEvents.set(sequenceName, [])
    console.log(`🔧 [reinit] ${sequenceName}: tracking reinitialized`)
  }

  /**
   * 再生を実行
   */
  private async executePlayback(
    filepath: string,
    options: PlaybackOptions,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    // Only perform checks if sequenceName is provided (non-empty)
    if (sequenceName) {
      const now = Date.now() - this.startTime
      const drift = now - scheduledTime

      // Double-check: Skip if sequence was cleared while waiting in async queue
      if (!this.sequenceEvents.has(sequenceName)) {
        console.log(
          `🔧 [skip in exec] ${sequenceName}: skipping event at ${scheduledTime}ms (cleared during async wait)`,
        )
        return
      }

      // Skip events with excessive drift (> 1000ms)
      // These are likely old events that should have been cleared
      if (drift > 1000) {
        console.log(
          `🔧 [skip drift] ${sequenceName}: skipping event at ${scheduledTime}ms (drift: ${drift}ms > 1000ms)`,
        )
        return
      }
    }

    this.logPlaybackDebugInfo(sequenceName, scheduledTime)
    const { bufnum } = await this.bufferManager.loadBuffer(filepath)
    const amplitude = this.convertGainToAmplitude(options.gainDb)
    await this.sendPlaybackMessage(bufnum, amplitude, options)
  }

  /**
   * Log playback debug information
   */
  private logPlaybackDebugInfo(sequenceName: string, scheduledTime: number): void {
    if ((globalThis as any).ORBITSCORE_DEBUG) {
      const launchTime = Date.now()
      const actualStartTime = launchTime - this.startTime
      const drift = actualStartTime - scheduledTime
      console.log(
        `🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`,
      )
    }
  }

  /**
   * Convert dB gain to amplitude
   * amplitude = 10^(dB/20)
   * Default: 0 dB = 1.0 (100%)
   */
  private convertGainToAmplitude(gainDb: number | undefined): number {
    if (gainDb === undefined) {
      return 1.0 // 0 dB default
    }
    if (gainDb === -Infinity) {
      return 0.0 // Complete silence
    }
    return Math.pow(10, gainDb / 20)
  }

  /**
   * Send OSC playback message to SuperCollider.
   *
   * Dispatch logic:
   *   - `outputChannel` set AND plugin available → SYNTHDEF_LINK with the
   *     resolved channel id.
   *   - `outputChannel` set AND plugin missing → SYNTHDEF_HARDWARE fallback +
   *     one-shot warning. The warning resets on plugin reload via
   *     `setLinkAudioPluginAvailable(true)` so a re-install during the same
   *     session re-arms the warning.
   *   - `outputChannel` unset → SYNTHDEF_HARDWARE.
   */
  private async sendPlaybackMessage(
    bufnum: number,
    amplitude: number,
    options: PlaybackOptions,
  ): Promise<void> {
    const pan = options.pan !== undefined ? options.pan / 100 : 0.0 // -100..100 -> -1.0..1.0
    const startPos = options.startPos ?? 0
    const duration = options.duration ?? 0
    const rate = options.rate ?? 1.0

    if (options.outputChannel) {
      // Resolve + register the channel with the plugin (idempotent). This is the
      // dispatch-time path; Sequence.output() also calls the registration eagerly
      // so the source appears in Live before playback (pre-show routing).
      const channelId = await this.resolveLinkAudioChannel(options.outputChannel)
      if (channelId !== null) {
        await this.oscClient.sendMessage([
          '/s_new',
          SYNTHDEF_LINK,
          -1,
          0,
          0,
          'bufnum',
          bufnum,
          'amp',
          amplitude,
          'pan',
          pan,
          'rate',
          rate,
          'startPos',
          startPos,
          'duration',
          duration,
          'channel',
          channelId,
        ])
        return
      }
      if (!this.warnedAboutMissingPlugin) {
        console.warn(
          `⚠️  LinkAudio plugin not loaded — sequence with outputChannel="${options.outputChannel}" ` +
            `falls back to the hardware bus. Install the OrbitLinkAudio.scx SuperCollider plugin to enable LinkAudio routing.`,
        )
        this.warnedAboutMissingPlugin = true
      }
      // fall through to hardware path
    }

    await this.oscClient.sendMessage([
      '/s_new',
      SYNTHDEF_HARDWARE,
      -1,
      0,
      0,
      'bufnum',
      bufnum,
      'amp',
      amplitude,
      'pan',
      pan,
      'rate',
      rate,
      'startPos',
      startPos,
      'duration',
      duration,
    ])
  }

  /**
   * スケジュールされたイベント数を取得
   */
  getScheduledEventCount(): number {
    return this.scheduledPlays.length
  }

  /**
   * Test-only accessor — exposes the private `executePlayback()` so unit tests
   * can drive the dispatch path directly without standing up the scheduling
   * loop. Not part of the public API.
   *
   * @internal
   */
  async testExecutePlayback(
    filepath: string,
    options: PlaybackOptions,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    return this.executePlayback(filepath, options, sequenceName, scheduledTime)
  }
}
