/**
 * #643 PR-2 — マスターフェーダーは **合流後に1回だけ**掛かる。
 *
 * 旧実装は `masterGainDb` を **イベントごとの gain に畳み込んで**いたため:
 *   (a) instrument の note 経路には畳み込みが無く、**マスターが一切効かなかった**
 *   (b) audio でも **バスに入る前**に掛かっていた（マスターを絞るとリバーブの掛かり方まで変わる）
 *
 * 現在は `Global.gain()` が daemon の mixer master へ線形 amplitude を送り、
 * `render_multi` の gain ramp が合流後に適用する。
 */

import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import type { Scheduler } from '../../packages/engine/src/core/global/types'
import { scheduleEvents } from '../../packages/engine/src/core/sequence/scheduling/event-scheduler'
import type { TimedEvent } from '../../packages/engine/src/timing/calculation/types'

function stubScheduler(): Scheduler & { scheduleEvent: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
  } as never
}

const ONE_NOTE: TimedEvent[] = [{ sliceNumber: 1, startTime: 0, duration: 250, depth: 0 }]

const BASE = {
  audioFilePath: '/audio/kick.wav',
  gainDb: -6,
  pan: 0,
  isMuted: false,
  sequenceName: 'drum',
  patternDuration: 500,
}

function makeGlobal() {
  const setGlobalGain = vi.fn().mockResolvedValue(undefined)
  const engine = { boot: vi.fn(), quit: vi.fn(), isRunning: true, setGlobalGain } as never
  return { global: new Global(engine), setGlobalGain }
}

describe('master gain is applied at the mixer, not folded into each event', () => {
  it('sends the master level to the mixer as a linear amplitude', async () => {
    const { global, setGlobalGain } = makeGlobal()

    global.gain(-6)
    await Promise.resolve()

    expect(setGlobalGain).toHaveBeenCalledTimes(1)
    // -6 dB -> 10^(-6/20) ≈ 0.5012。dB のまま送っていれば -6 になる。
    expect(setGlobalGain.mock.calls[0][0]).toBeCloseTo(0.5012, 4)
  })

  it('maps 0 dB to unity and -Infinity to silence', async () => {
    const { global, setGlobalGain } = makeGlobal()

    global.gain(0)
    global.gain(-Infinity)
    await Promise.resolve()

    expect(setGlobalGain).toHaveBeenCalledTimes(2)
    expect(setGlobalGain.mock.calls[0][0]).toBe(1.0)
    expect(setGlobalGain.mock.calls[1][0]).toBe(0.0)
  })

  it('sends nothing when only reading the current value', async () => {
    const { global, setGlobalGain } = makeGlobal()

    global.gain(-3)
    await Promise.resolve()
    setGlobalGain.mockClear()

    expect(global.gain()).toBe(-3)
    await Promise.resolve()
    expect(setGlobalGain).not.toHaveBeenCalled()
  })

  it('no longer folds the master level into the scheduled event gain', async () => {
    const scheduler = stubScheduler()
    // sequence -6 dB, master -12 dB。畳み込みが残っていれば -18 が渡る。
    await scheduleEvents({
      ...BASE,
      scheduler,
      timedEvents: ONE_NOTE,
      masterGainDb: -12,
    } as never)

    const gainArg = scheduler.scheduleEvent.mock.calls[0][2]
    expect(gainArg).toBe(-6)
  })

  it('still silences the event when the master is -Infinity', async () => {
    const scheduler = stubScheduler()
    // ramp の途中で音が漏れないよう、完全無音だけは発音側でも落とす。
    await scheduleEvents({
      ...BASE,
      scheduler,
      timedEvents: ONE_NOTE,
      masterGainDb: -Infinity,
    } as never)

    expect(scheduler.scheduleEvent.mock.calls[0][2]).toBe(-Infinity)
  })
})
