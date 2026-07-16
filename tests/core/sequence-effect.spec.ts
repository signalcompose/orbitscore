/**
 * seq.effect() — per-sequence plugin insert (PH.2b / #434 S3).
 */

import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import type { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { SEQUENCE_EFFECT_BUS_POOL_SIZE } from '../../packages/engine/src/core/global/sequence-effect-manager'

const T0 = 1_000_000

function scheduler() {
  return {
    isRunning: true,
    startTime: T0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    getMasterGainDb: () => 0,
  } as any
}

function harness(loadPlugin = vi.fn().mockResolvedValue({})) {
  const audio = scheduler()
  audio.loadPlugin = loadPlugin
  const midiOutput: MidiOutput = {
    ensurePort: vi.fn(() => 'IAC'),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IAC']),
    closeAll: vi.fn(),
  }
  const global = new Global(audio, new MidiManager(() => midiOutput))
  global.setDocumentDirectory('/songs')
  const seq = new Sequence(global, audio)
  seq.setName('drum')
  return { audio, global, seq, loadPlugin }
}

describe('Sequence.effect() — per-sequence insert (PH.2b / #434 S3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('allocates the first pool bus and loads via LoadPlugin(role=effect, bus)', async () => {
    const { seq, loadPlugin } = harness()
    await expect(seq.effect('./reverb.clap')).resolves.toBe(seq)
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs', 'reverb.clap'),
      undefined,
      'effect',
      'seq-bus-0',
    )
  })

  it('allocates distinct buses per sequence, in declaration order', async () => {
    const { global, audio } = harness()
    const seqA = new Sequence(global, audio)
    seqA.setName('a')
    const seqB = new Sequence(global, audio)
    seqB.setName('b')
    await seqA.effect('./reverb.clap')
    await seqB.effect('./delay.clap')
    expect(seqA.getInsertBus()).toBe('seq-bus-0')
    expect(seqB.getInsertBus()).toBe('seq-bus-1')
  })

  it('is idempotent on the same path + pluginId (no second LoadPlugin call)', async () => {
    const { seq, loadPlugin } = harness()
    await seq.effect('./reverb.clap', 'rev-id')
    await seq.effect('reverb.clap', 'rev-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
    expect(seq.getInsertBus()).toBe('seq-bus-0')
  })

  it('rejects re-declaration with a different path or pluginId', async () => {
    const { seq, loadPlugin } = harness()
    await seq.effect('./reverb.clap')
    await expect(seq.effect('./delay.clap')).rejects.toThrow('one insert per sequence')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('rejects .vst3 (effect accepts .clap only, unlike seq.instrument())', async () => {
    const { seq } = harness()
    await expect(seq.effect('synth.vst3')).rejects.toThrow('not yet supported')
  })

  it('rejects on note sequences (midi)', async () => {
    const { seq } = harness()
    seq.midi('iac', 1)
    await expect(seq.effect('./reverb.clap')).rejects.toThrow(
      'seq.effect() is only supported on audio sequences',
    )
  })

  it('rejects on note sequences (instrument)', async () => {
    const { seq } = harness()
    await seq.instrument('synth.clap')
    await expect(seq.effect('./reverb.clap')).rejects.toThrow(
      'seq.effect() is only supported on audio sequences',
    )
  })

  it('rejects while LinkAudio is enabled', async () => {
    const { seq, global } = harness()
    global.linkAudio()
    await expect(seq.effect('./reverb.clap')).rejects.toThrow('LinkAudio')
  })

  it('blocks a later global.linkAudio() once any sequence has declared an insert', async () => {
    const { seq, global } = harness()
    await seq.effect('./reverb.clap')
    expect(() => global.linkAudio()).toThrow('plugin hosting')
  })

  it('exhausts the pool after the v1 cap and errors with an explicit message', async () => {
    const { global, loadPlugin } = harness()
    const seqs: Sequence[] = []
    for (let i = 0; i < SEQUENCE_EFFECT_BUS_POOL_SIZE; i++) {
      const s = new Sequence(global, global as any)
      s.setName(`s${i}`)
      await s.effect('./reverb.clap')
      seqs.push(s)
    }
    expect(loadPlugin).toHaveBeenCalledTimes(SEQUENCE_EFFECT_BUS_POOL_SIZE)
    const overflow = new Sequence(global, global as any)
    overflow.setName('overflow')
    await expect(overflow.effect('./reverb.clap')).rejects.toThrow('pool exhausted')
  })

  it('returns a failed declaration bus to the free-list so retries do not exhaust the pool', async () => {
    // #461 review Important: ライブコーディングの typo → リトライで pool が恒久消費されない。
    const loadPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error('plugin load failed'))
      .mockResolvedValue({})
    const { global } = harness(loadPlugin)
    const seq = new Sequence(global, global as any)
    seq.setName('drum')
    await expect(seq.effect('./typo.clap')).rejects.toThrow('plugin load failed')
    // 再宣言は失敗で返却された同じ bus 名を再利用する。
    await seq.effect('./reverb.clap')
    expect(loadPlugin).toHaveBeenLastCalledWith(
      expect.stringContaining('reverb.clap'),
      undefined,
      'effect',
      'seq-bus-0',
    )
    // 失敗を繰り返しても pool は枯渇しない（cap 回失敗 → なお成功できる）。
    const failing = vi.fn().mockRejectedValue(new Error('nope'))
    const { global: g2 } = harness(failing)
    const s2 = new Sequence(g2, g2 as any)
    s2.setName('retry')
    for (let i = 0; i < SEQUENCE_EFFECT_BUS_POOL_SIZE + 2; i++) {
      await expect(s2.effect('./nope.clap')).rejects.toThrow('nope')
    }
  })

  it('rejects a backend without plugin hosting support', async () => {
    const audio = scheduler()
    const global = new Global(audio)
    global.setDocumentDirectory('/songs')
    const seq = new Sequence(global, audio)
    seq.setName('drum')
    await expect(seq.effect('./reverb.clap')).rejects.toThrow(
      'Plugin hosting requires the Rust engine backend',
    )
  })

  it('dispatches with the allocated bus tagged on PlayAt (via scheduler.scheduleEvent)', async () => {
    const { audio, global, seq } = harness()
    vi.spyOn(global, 'resolveAudioSpec').mockReturnValue('/songs/kick.wav')
    await seq.effect('./reverb.clap')
    seq.audio('kick.wav')
    global.start()
    seq.play(1)
    await seq.run()
    await vi.advanceTimersByTimeAsync(600)
    expect(audio.scheduleEvent).toHaveBeenCalled()
    const call = audio.scheduleEvent.mock.calls[0]
    // trailing arg is insertBus
    expect(call[call.length - 1]).toBe('seq-bus-0')
  })
})
