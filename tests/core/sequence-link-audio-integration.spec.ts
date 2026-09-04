import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'

/**
 * Step 3.2 (Issue #192) + strict-mode follow-up: integration check that the
 * LinkAudio outputChannel is forwarded from Sequence → scheduling pipeline →
 * SuperColliderPlayer scheduleEvent based on Global mode + sequence .output()
 * state.
 *
 * The wiring rule (resolveDispatchChannel), post-#645 PR-D0:
 *   - Global.linkAudio() OFF + seq.output("X") → { kind: 'hardware' }
 *     (sequence routes through hardware, existing behavior)
 *   - Global.linkAudio() ON + seq.output("X")  → { kind: 'link', channel: 'X' }
 *     (LinkAudio path)
 *   - Global.linkAudio() ON + no .output()      → { kind: 'skip', reason }
 *     (hardware/LinkAudio mixing forbidden per DSL spec §8.1.2, but this is a
 *     silent-skip-and-log now, NOT a throw — a throw here used to kill the
 *     whole evaluation block, stopping every OTHER sequence too. Design 610 §0
 *     裁定 6.)
 */
describe('Sequence → scheduler dispatch wiring (LinkAudio)', () => {
  let global: Global
  let seq: Sequence
  let mockPlayer: SuperColliderPlayer

  beforeEach(() => {
    mockPlayer = {
      boot: vi.fn().mockResolvedValue(undefined),
      getCurrentTime: vi.fn().mockReturnValue(0),
      scheduleEvent: vi.fn(),
      scheduleSliceEvent: vi.fn(),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      // Scheduler interface bits used by Sequence
      isRunning: false,
      startTime: 0,
      start: vi.fn(),
      stop: vi.fn(),
      stopAll: vi.fn(),
      clearSequenceEvents: vi.fn(),
      reinitializeSequenceTracking: vi.fn(),
      getAudioDuration: vi.fn().mockReturnValue(1.0),
    } as any

    global = new Global(mockPlayer)
    seq = new Sequence(global, mockPlayer)
    seq.setName('kick')
  })

  // C1 (#645 PR-D0 rewrite): run() and loop() eagerly call resolveDispatchChannel() so
  // the skip reason is logged as early as possible, but NEITHER throws nor rejects
  // anymore — a missing .output() is a silently-skipped, logged sequence, not a
  // stopped evaluation block.
  describe('strict-mode eager validation in run() / loop()', () => {
    it('seq.run() resolves (not rejects) and logs the skip when LinkAudio enabled but .output() missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      await expect(seq.run()).resolves.toBe(seq)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no \.output\(\) channel set/))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('無音でスキップ'))
    })

    it('seq.loop() resolves (not rejects) and logs the skip when LinkAudio enabled but .output() missing', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      await expect(seq.loop()).resolves.toBe(seq)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no \.output\(\) channel set/))
    })

    it('seq.run() succeeds (does not throw, does not log a skip) when .output() is set', async () => {
      // preparePlayback will return null (no audio file) → run() returns early.
      // What matters is that resolveDispatchChannel does not resolve to `skip`.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      seq.output('kick')
      await expect(seq.run()).resolves.toBe(seq)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('seq.loop() succeeds (does not throw, does not log a skip) when .output() is set', async () => {
      // preparePlayback will return null (no audio file) → loop() returns early.
      // Mirrors the run() success test — validates symmetry between run() and loop().
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      seq.output('kick')
      await expect(seq.loop()).resolves.toBe(seq)
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  // The behavior we verify lives in `resolveDispatchChannel`. Drive it via the
  // public API surface (Global.linkAudio + seq.output) and read state back —
  // running an actual scheduling cycle would require audio assets/wave decode.
  describe('resolveDispatchChannel via public state', () => {
    it('with linkAudio OFF + .output set → hardware (pre-#645 undefined)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      seq.output('kick')
      // Sanity: warn was issued from .output() because Global is off
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(global.isLinkAudioEnabled()).toBe(false)
      expect(seq.getOutputChannel()).toBe('kick')
      // Effective dispatch channel is hardware — the pre-#645 `undefined` path retained
      expect(seq.resolveDispatchChannel()).toEqual({ kind: 'hardware' })
    })

    it('with linkAudio ON + .output set → effective dispatch channel = link/name', () => {
      global.linkAudio()
      seq.output('kick')
      expect(global.isLinkAudioEnabled()).toBe(true)
      expect(seq.getOutputChannel()).toBe('kick')
      expect(seq.resolveDispatchChannel()).toEqual({ kind: 'link', channel: 'kick' })
    })

    it('with linkAudio ON + no .output → skip (no silent fallback to hardware)', () => {
      global.linkAudio()
      expect(global.isLinkAudioEnabled()).toBe(true)
      expect(seq.getOutputChannel()).toBeUndefined()
      // resolveDispatchChannel is the runtime gate that enforces the spec rule. It must
      // NEVER throw and must NEVER return `{ kind: 'hardware' }` here — either would
      // reintroduce a silent fallback (#645's "別種の驚き").
      const target = seq.resolveDispatchChannel()
      expect(target.kind).toBe('skip')
      expect(target.kind === 'skip' && target.reason).toMatch(/no \.output\(\) channel set/)
      expect(target.kind === 'skip' && target.reason).toMatch(/global\.linkAudio\(\) is enabled/)
    })

    it('skip reason references the sequence name for diagnosability via logSkipOnce', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      // resolveDispatchChannel() itself does not log — logSkipOnce (called from
      // run()/loop() and the scheduling paths) does. Drive it through run().
      await seq.run()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'kick'"))
    })

    it('skip reason suggests a remediation path (.output or remove linkAudio)', () => {
      global.linkAudio()
      const target = seq.resolveDispatchChannel()
      expect(target.kind).toBe('skip')
      expect(target.kind === 'skip' && target.reason).toMatch(/Add \.output\("name"\)|hardware/)
    })

    it('explicit target SR is propagated through GlobalState', () => {
      global.linkAudio(44100)
      expect(global.getState().linkAudioTargetSampleRate).toBe(44100)
      expect(global.getState().linkAudioEnabled).toBe(true)
    })
  })

  // #645 PR-D0 §4/§11: the dedup contract for logSkipOnce(). A looping sequence
  // re-resolves its dispatch target every bar (via the private scheduleEventsFromTime
  // wrapper), so without this the get_log ring floods — 1 line per bar, forever —
  // crowding out every other diagnostic. Driven here through run()'s eager check, which
  // shares the same logSkipOnce() call as the scheduling paths.
  describe('logSkipOnce dedup (#645 PR-D0)', () => {
    it('logs the same skip reason only once across repeated run() calls (dedup)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      // Each call re-resolves the SAME skip reason — models what a loop timer does once
      // per bar. If dedup were broken, this would log 3 times, not 1.
      await seq.run()
      await seq.run()
      await seq.run()
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('dedups per-sequence-instance, not globally', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      const seq2 = new Sequence(global, mockPlayer)
      seq2.setName('snare')
      await seq.run()
      await seq2.run()
      // A DIFFERENT sequence hitting the SAME skip reason must still log — dedup is
      // per-instance state (`_dispatchSkipLoggedFor`), not a shared/global suppression.
      expect(errorSpy).toHaveBeenCalledTimes(2)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'kick'"))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'snare'"))
    })

    it('resets the dedup key when .output() resolves the missing-channel skip reason', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      global.linkAudio()
      await seq.run()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      seq.output('kick')
      // White-box: there is no public API to force a SECOND skip on a sequence that has
      // already declared .output() (no way to un-set it), so the reset itself can only
      // be observed by reading the private dedup field directly. The black-box half of
      // this contract (independent dedup state) is covered by the instance test above.
      expect(
        (seq as unknown as { _dispatchSkipLoggedFor?: string })._dispatchSkipLoggedFor,
      ).toBeUndefined()
    })
  })
})
