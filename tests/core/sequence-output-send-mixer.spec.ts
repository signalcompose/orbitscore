/**
 * seq.output(sumName) / seq.send(auxName, amount) — mixer routing (MX.2/MX.3/MX.4, #459/#453 M3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DaemonProtocolError } from '../../packages/engine/src/audio/rust-engine/errors'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import type { MidiOutput } from '../../packages/engine/src/midi/midi-output'
import { installEffectChainMock } from '../helpers/effect-chain-mock'

const T0 = 1_000_000

// Mirrors tests/core/sequence-effect.spec.ts's harness: seq.midi() must not hit the real
// RtMidi binding (crashes the sandbox / CI worker with no OS MIDI client available).
function mockMidiOutput(): MidiOutput {
  return {
    ensurePort: vi.fn(() => 'IAC'),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IAC']),
    closeAll: vi.fn(),
  } as unknown as MidiOutput
}

function harness(setBusLine = vi.fn().mockResolvedValue(undefined)) {
  const setSourceRouting = vi.fn().mockResolvedValue(undefined)
  const audio = {
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
    loadPlugin: vi.fn().mockResolvedValue({}),
    setBusLine,
    setSourceRouting,
  } as any
  installEffectChainMock(audio)
  const midiOutput = mockMidiOutput()
  const global = new Global(audio, new MidiManager(() => midiOutput))
  global.setDocumentDirectory('/songs')
  const seq = new Sequence(global, audio)
  seq.setName('kick')
  return { audio, global, seq, setBusLine, setSourceRouting }
}

const rack = { op: 'rack' }
const masterOutput = (thru: boolean) => ({
  op: 'output',
  dest: { kind: 'master' },
  thru,
  gain: 1,
})
const busOutput = (name: string, thru: boolean, gain = 1) => ({
  op: 'output',
  dest: { kind: 'bus', name },
  thru,
  gain,
})

describe('Sequence.output() → sum bus routing (MX.2/MX.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto-allocates a per-seq insert bus and issues SetBusLine(output=<sum bus>) when no seq.effect() was declared', async () => {
    const { global, seq, setBusLine } = harness()
    global.sum('drum')
    seq.output('drum')
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalled())
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    expect(setBusLine).toHaveBeenCalledWith('seq-bus-0', [rack, busOutput('sum-bus-0', false)])
  })

  it('reuses the existing insert bus when seq.effect() was already declared', async () => {
    const { global, seq, setBusLine } = harness()
    global.sum('drum')
    await seq.effect('./reverb.clap')
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    seq.output('drum')
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalled())
    expect(setBusLine).toHaveBeenCalledWith('seq-bus-0', [rack, busOutput('sum-bus-0', false)])
  })

  it('falls back to the LinkAudio/warn behavior for a name that is not a declared sum bus', () => {
    const { seq, setBusLine } = harness()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seq.output('not-a-sum')
    expect(seq.getOutputChannel()).toBe('not-a-sum')
    expect(setBusLine).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('is method-chainable (returns this)', () => {
    const { global, seq } = harness()
    global.sum('drum')
    expect(seq.output('drum')).toBe(seq)
  })

  it('rejects sum routing on a note (midi) sequence', () => {
    const { global, seq } = harness()
    global.sum('drum')
    seq.midi('iac', 1)
    expect(() => seq.output('drum')).toThrow(
      'MIDI is sent to an external device and therefore has no mixer output destination',
    )
  })

  it('routes an instrument main output to the allocated sum insert bus', async () => {
    const { global, seq, setBusLine, setSourceRouting } = harness()
    global.sum('drum')
    await seq.instrument('synth.clap')
    expect(seq.output('drum')).toBe(seq)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))
    expect(setSourceRouting).toHaveBeenCalledTimes(1)
    expect(setSourceRouting).toHaveBeenCalledWith('plugin:kick', 0, 'seq-bus-0')
  })

  it('logs a transient warning (not error) and does not throw when SetBusLine fails at transport', async () => {
    const setBusLine = vi.fn().mockRejectedValue(new Error('socket closed'))
    const { global, seq } = harness(setBusLine)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    global.sum('drum')
    expect(() => seq.output('drum')).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('remains pending'))
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs an actionable console.error when the daemon definitively rejects SetBusLine', async () => {
    const setBusLine = vi
      .fn()
      .mockRejectedValue(new DaemonProtocolError('MALFORMED_REQUEST', 'kind mismatch'))
    const { global, seq } = harness(setBusLine)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    global.sum('drum')
    expect(() => seq.output('drum')).not.toThrow()
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('routing was NOT applied'))
  })

  it('self-heals a failed routing push on the next routing call (full-state re-send)', async () => {
    const setBusLine = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValue(undefined)
    const { global, seq } = harness(setBusLine)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    global.sum('drum')
    global.aux('rev')
    seq.output('drum') // fails (transient)
    seq.send('rev', 0.3) // full-state re-send carries the sum output too
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))
    // #611 §2.3/§5.1: send() is always thru: true by definition and inserts BEFORE the
    // existing thru: false terminal (default-strip rank), not after it — 0.3 is now read as
    // dB, not linear (10 ** (0.3 / 20) ≈ 1.0351).
    expect(setBusLine).toHaveBeenLastCalledWith('seq-bus-0', [
      rack,
      busOutput('aux-bus-0', true, 10 ** (0.3 / 20)),
      busOutput('sum-bus-0', false),
    ])
  })

  it('self-heals a rejected SetBusLine at the next playback start', async () => {
    const setBusLine = vi
      .fn()
      .mockRejectedValueOnce(new DaemonProtocolError('MALFORMED_REQUEST', 'kind mismatch'))
      .mockResolvedValue(undefined)
    const { global, seq } = harness(setBusLine)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    global.sum('drum')
    seq.output('drum')
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))

    await seq.run()
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))

    expect(setBusLine).toHaveBeenLastCalledWith('seq-bus-0', [rack, busOutput('sum-bus-0', false)])
  })
})

describe('Sequence.send() → aux bus routing (MX.3/MX.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto-allocates a per-seq insert bus and issues SetBusLine with the legacy send shape', async () => {
    const { global, seq, setBusLine } = harness()
    global.aux('rev')
    seq.send('rev', 0.3)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalled())
    expect(seq.getInsertBus()).toBe('seq-bus-0')
    // #611 §2.3: send() ≡ output(aux, thru: true, db) — 0.3 is dB now, not linear
    // (10 ** (0.3 / 20) ≈ 1.0351), and the implicit master terminal follows it (§2.1).
    expect(setBusLine).toHaveBeenCalledWith('seq-bus-0', [
      rack,
      busOutput('aux-bus-0', true, 10 ** (0.3 / 20)),
      masterOutput(false),
    ])
  })

  it('accumulates multiple sends (fan-out) and re-sends the full set each time', async () => {
    const { global, seq, setBusLine } = harness()
    global.aux('rev')
    global.aux('delay')
    seq.send('rev', 0.3)
    seq.send('delay', 0.5)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))
    // #611 §2.3/§5.1: both sends are thru: true by definition (declaration order, not a
    // sends.length-dependent formula) and the implicit master terminal follows both.
    expect(setBusLine).toHaveBeenLastCalledWith('seq-bus-0', [
      rack,
      busOutput('aux-bus-0', true, 10 ** (0.3 / 20)),
      busOutput('aux-bus-1', true, 10 ** (0.5 / 20)),
      masterOutput(false),
    ])
  })

  it('combines an existing sum output with sends in the re-issued SetBusLine', async () => {
    const { global, seq, setBusLine } = harness()
    global.sum('drum')
    global.aux('rev')
    seq.output('drum')
    seq.send('rev', 0.3)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))
    // #611 §5.1: send() inserts BEFORE the existing thru: false terminal (default-strip
    // rank), not after it; 0.3 is dB now, not linear.
    expect(setBusLine).toHaveBeenLastCalledWith('seq-bus-0', [
      rack,
      busOutput('aux-bus-0', true, 10 ** (0.3 / 20)),
      busOutput('sum-bus-0', false),
    ])
  })

  it('rejects send() to an undeclared aux bus', () => {
    const { seq } = harness()
    expect(() => seq.send('nope', 0.5)).toThrow('undeclared aux/sum bus')
  })

  it('rejects non-finite gain', () => {
    const { global, seq } = harness()
    global.aux('rev')
    expect(() => seq.send('rev', NaN)).toThrow('must be finite')
  })

  it('rejects send() on a note (midi) sequence', () => {
    const { global, seq } = harness()
    global.aux('rev')
    seq.midi('iac', 1)
    expect(() => seq.send('rev', 0.5)).toThrow(
      'MIDI is sent to an external device and therefore has no mixer output destination',
    )
  })

  it('routes an instrument main output to the allocated aux-send insert bus', async () => {
    const { global, seq, setBusLine, setSourceRouting } = harness()
    global.aux('rev')
    await seq.instrument('synth.clap')
    expect(seq.send('rev', 0.5)).toBe(seq)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))
    expect(setSourceRouting).toHaveBeenCalledTimes(1)
    expect(setSourceRouting).toHaveBeenCalledWith('plugin:kick', 0, 'seq-bus-0')
  })

  it('is method-chainable (returns this)', () => {
    const { global, seq } = harness()
    global.aux('rev')
    expect(seq.send('rev', 0.5)).toBe(seq)
  })

  it('accepts db as a named-style option and rejects positional plus named db', async () => {
    const { global, seq, setBusLine } = harness()
    global.aux('rev')

    expect(seq.send('rev', { db: -12 })).toBe(seq)
    await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))
    expect(setBusLine).toHaveBeenLastCalledWith('seq-bus-0', [
      rack,
      busOutput('aux-bus-0', true, 10 ** (-12 / 20)),
      masterOutput(false),
    ])

    expect(() => seq.send('rev', -12, { db: -6 })).toThrow(
      /Remove either the second positional argument or the named db:/,
    )
    expect(setBusLine).toHaveBeenCalledTimes(1)
  })
})

describe('Sequence gain/pan line ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    ['gain', -12, { op: 'gain', gain: 10 ** (-12 / 20) }],
    ['pan', 30, { op: 'pan', pan: 0.3 }],
  ] as const)(
    'routes an instrument source when %s() alone allocates its bus',
    async (method, value, op) => {
      const { seq, setBusLine, setSourceRouting } = harness()
      await seq.instrument('synth.clap')

      seq[method](value)

      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))
      expect(setBusLine).toHaveBeenCalledWith('seq-bus-0', [rack, op, masterOutput(false)])
      expect(setSourceRouting).toHaveBeenCalledTimes(1)
      expect(setSourceRouting).toHaveBeenCalledWith('plugin:kick', 0, 'seq-bus-0')
    },
  )

  it.each([
    ['gain', -6, { type: 'random-walk', center: -12, range: 3 }, { op: 'gain', gain: 1 }],
    ['pan', 30, { type: 'random-walk', center: 0, range: 20 }, { op: 'pan', pan: 0 }],
  ] as const)(
    'clears an old fixed %s line element when switching to event-side random',
    async (method, fixed, random, neutralOp) => {
      const { global, seq, setBusLine } = harness()
      global.sum('drum')
      seq.output('drum')
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))

      seq[method](fixed)
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))
      seq[method](random)
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(3))

      expect(setBusLine.mock.calls[2]?.[1]).toContainEqual(neutralOp)
      const state = seq.getState()
      expect(method === 'gain' ? state.gainRandom : state.panRandom).toEqual(random)
    },
  )

  it.each([
    ['gain', -6, 'gainDb'],
    ['pan', 30, 'pan'],
  ] as const)(
    'keeps a fixed %s event-side after a failed push, then adopts it after a successful retry',
    async (method, value, stateKey) => {
      const setBusLine = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValueOnce(undefined)
      const { global, seq } = harness(setBusLine)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      global.sum('drum')
      seq.output('drum')
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(1))

      seq[method](value)
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(2))
      expect(seq.getState()[stateKey]).toBe(value)

      seq.output('drum')
      await vi.waitFor(() => expect(setBusLine).toHaveBeenCalledTimes(3))
      await vi.waitFor(() => expect(seq.getState()[stateKey]).toBe(0))
    },
  )

  it('rejects a numeric output second argument before allocating or pushing a bus', () => {
    const { global, seq, setBusLine } = harness()
    global.sum('drum')

    expect(() => seq.output('drum', -12 as any)).toThrow(
      /output\(dest, \{ db: -12 \}\).*send\(dest, -12\)/,
    )
    expect(seq.getInsertBus()).toBeUndefined()
    expect(setBusLine).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Signal Chain の mixer ハンドル構文は `routeOutputFromDsl` / `routeSendFromDsl` を通る
 * **`output()` / `send()` と同じ意味の別入口**（`process-statement.ts` から呼ばれる）。
 * ガードが片方だけ更新されると「メソッドでは書けるが構文では弾かれる」になる
 * — #648 レビューで実際に取り残されていた（#643 PR-2）。
 */
describe('signal-chain routing sugar mirrors the direct methods (#643)', () => {
  it('opens the output sugar to instruments', async () => {
    const { global, seq, setSourceRouting } = harness()
    global.sum('strings')
    await seq.instrument('synth.clap')
    setSourceRouting.mockClear()

    await seq.routeOutputFromDsl({ kind: 'bus', bus: 'sum-bus-0' })

    expect(setSourceRouting).toHaveBeenCalledTimes(1)
    expect(setSourceRouting.mock.calls[0][1]).toBe(0)
  })

  it('opens the send sugar to instruments', async () => {
    const { global, seq, setSourceRouting } = harness()
    global.aux('rev')
    await seq.instrument('synth.clap')
    setSourceRouting.mockClear()

    await seq.routeSendFromDsl({ kind: 'bus', bus: 'aux-bus-0' }, 0.3)

    expect(setSourceRouting).toHaveBeenCalledTimes(1)
    expect(setSourceRouting.mock.calls[0][1]).toBe(0)
  })

  it('still rejects both sugar entries on a midi sequence', async () => {
    const { global, seq } = harness()
    global.sum('strings')
    global.aux('rev')
    seq.midi('IAC Bus 1', 1)

    await expect(seq.routeOutputFromDsl({ kind: 'bus', bus: 'sum-bus-0' })).rejects.toThrow(
      'cannot target a MIDI sequence',
    )
    await expect(seq.routeSendFromDsl({ kind: 'bus', bus: 'aux-bus-0' }, 0.3)).rejects.toThrow(
      'cannot target a MIDI sequence',
    )
  })
})

/**
 * 🔴 `output()` の3分岐のうち **sum だけ**が instrument に解禁される（設計 §12・#643 PR-2）。
 * 残り2分岐は「宛先だけ記録して音が従わない」silent failure になるので loud に拒否する。
 * **midi 側は据え置き**（受理していた入力を弾く破壊的変更なので owner 確認事項・#644）。
 */
describe('output() rejects the two unsupported branches on instruments (#643)', () => {
  it('rejects the offline render bus branch', async () => {
    const { seq } = harness()
    await seq.instrument('synth.clap')

    expect(() => seq.output(3)).toThrow('offline render bus')
  })

  it('rejects the LinkAudio channel branch', async () => {
    const { seq } = harness()
    await seq.instrument('synth.clap')

    expect(() => seq.output('Kick Ch')).toThrow('LinkAudio channel')
  })

  it('leaves the midi behaviour unchanged on those two branches', () => {
    const { seq } = harness()
    seq.midi('IAC Bus 1', 1)

    // 据え置き: 例外を投げず、黙って記録する（#644 で診断を出す予定）。
    expect(() => seq.output(3)).not.toThrow()
    expect(() => seq.output('Kick Ch')).not.toThrow()
  })
})
