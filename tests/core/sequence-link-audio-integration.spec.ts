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
 * The wiring rule (resolveDispatchChannel):
 *   - Global.linkAudio() OFF + seq.output("X") → undefined
 *     (sequence routes through hardware, existing behavior)
 *   - Global.linkAudio() ON + seq.output("X")  → "X"
 *     (LinkAudio path)
 *   - Global.linkAudio() ON + no .output()      → throws (strict mode,
 *     per DSL spec §8.1.2 — hardware/LinkAudio mixing forbidden)
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

  // C1: Verify that run() and loop() eagerly call resolveDispatchChannel() so
  // the strict-mode throw propagates via the awaited call chain (not as an
  // unhandled rejection inside the fire-and-forget scheduleEventsFn callback).
  describe('strict-mode eager validation in run() / loop()', () => {
    it('seq.run() rejects when LinkAudio enabled but .output() missing', async () => {
      global.linkAudio()
      await expect(seq.run()).rejects.toThrow(/no \.output\(\) channel set/)
    })

    it('seq.loop() rejects when LinkAudio enabled but .output() missing', async () => {
      global.linkAudio()
      await expect(seq.loop()).rejects.toThrow(/no \.output\(\) channel set/)
    })

    it('seq.run() succeeds (does not throw) when .output() is set', async () => {
      // preparePlayback will return null (no audio file) → run() returns early.
      // What matters is that resolveDispatchChannel does NOT throw.
      global.linkAudio()
      seq.output('kick')
      await expect(seq.run()).resolves.toBe(seq)
    })
  })

  // The behavior we verify lives in `resolveDispatchChannel`. Drive it via the
  // public API surface (Global.linkAudio + seq.output) and read state back —
  // running an actual scheduling cycle would require audio assets/wave decode.
  describe('resolveDispatchChannel via public state', () => {
    it('with linkAudio OFF + .output set → no dispatch channel (hardware)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      seq.output('kick')
      // Sanity: warn was issued from .output() because Global is off
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(global.isLinkAudioEnabled()).toBe(false)
      expect(seq.getOutputChannel()).toBe('kick')
      // Effective dispatch channel is undefined — hardware path retained
      expect(seq.resolveDispatchChannel()).toBeUndefined()
    })

    it('with linkAudio ON + .output set → effective dispatch channel = name', () => {
      global.linkAudio()
      seq.output('kick')
      expect(global.isLinkAudioEnabled()).toBe(true)
      expect(seq.getOutputChannel()).toBe('kick')
      expect(seq.resolveDispatchChannel()).toBe('kick')
    })

    it('with linkAudio ON + no .output → throws (strict mode, no silent fallback)', () => {
      global.linkAudio()
      expect(global.isLinkAudioEnabled()).toBe(true)
      expect(seq.getOutputChannel()).toBeUndefined()
      // resolveDispatchChannel is the runtime gate that enforces the spec rule.
      expect(() => seq.resolveDispatchChannel()).toThrow(/no \.output\(\) channel set/)
      expect(() => seq.resolveDispatchChannel()).toThrow(/global\.linkAudio\(\) is enabled/)
    })

    it('strict-mode error references the sequence name for diagnosability', () => {
      global.linkAudio()
      expect(() => seq.resolveDispatchChannel()).toThrow(/'kick'/)
    })

    it('strict-mode error suggests a remediation path (.output or remove linkAudio)', () => {
      global.linkAudio()
      expect(() => seq.resolveDispatchChannel()).toThrow(/Add \.output\("name"\)|hardware/)
    })

    it('explicit target SR is propagated through GlobalState', () => {
      global.linkAudio(44100)
      expect(global.getState().linkAudioTargetSampleRate).toBe(44100)
      expect(global.getState().linkAudioEnabled).toBe(true)
    })
  })
})
