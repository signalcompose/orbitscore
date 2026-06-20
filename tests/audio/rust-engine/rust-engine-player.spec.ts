/**
 * RustEnginePlayer（S2 / Issue #296）の挙動検証。
 *
 * 実 daemon バイナリを spawn せず、`MockDaemonServer` で WebSocket 経路を立て、
 * `wsUrlOverride` で接続する。検証対象は adapter のロジック:
 *   - scheduleEvent → poll → daemon `LoadSample`+`PlayAt` の dispatch
 *   - gain(dB) → linear amplitude 変換 / sample キャッシュ / single-flight
 *   - clock anchor（GetStatus uptime → StreamStats now_sec 補正）+ 定数 lookahead
 *   - feature gap（pan / slice / outputChannel）の warn-once + skip/fallback
 *   - clearSequenceEvents / stopAll の cancellation 意味論
 *   - createAudioEngine() の env 分岐
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAudioEngine } from '../../../packages/engine/src/audio/create-audio-engine'
import { resolveEngineKind } from '../../../packages/engine/src/audio/engine-backend'
import { RustEnginePlayer } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { SuperColliderPlayer } from '../../../packages/engine/src/audio/supercollider-player'

import { MockDaemonServer, MockDaemonHandlers } from './mock-daemon-server'

/** predicate が true になるまで（または timeout まで）ポーリングで待つ。 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

/** GetStatus + LoadSample + PlayAt の既定ハンドラ（uptime=10 で anchor を固定的に）。 */
function defaultHandlers(overrides: MockDaemonHandlers = {}): MockDaemonHandlers {
  let playSeq = 0
  return {
    GetStatus: () => ({
      daemon_version: 'mock-0.0.0',
      protocol_version: '0.1',
      output_sample_rate: 48000,
      output_channels: 2,
      loaded_samples: 0,
      active_plays: 0,
      uptime_sec: 10,
    }),
    LoadSample: (params) => ({
      sample_id: `s-${String(params.path)}`,
      frames: 48000,
      channels: 2,
      sample_rate: 48000,
    }),
    PlayAt: () => ({ play_id: `p-${playSeq++}` }),
    ...overrides,
  }
}

describe('RustEnginePlayer with mock daemon', () => {
  let server: MockDaemonServer
  let player: RustEnginePlayer | null = null

  beforeEach(() => {
    server = new MockDaemonServer()
  })

  afterEach(async () => {
    if (player) {
      await player.quit()
      player = null
    }
    await server.stop()
  })

  async function boot(
    handlers: MockDaemonHandlers = defaultHandlers(),
    opts: { lookaheadSec?: number } = {},
  ): Promise<RustEnginePlayer> {
    const url = await server.start(handlers)
    const p = new RustEnginePlayer({ wsUrlOverride: url, lookaheadSec: opts.lookaheadSec ?? 0.05 })
    await p.boot()
    player = p
    return p
  }

  const playAtRecords = (): Array<Record<string, unknown>> =>
    server.received.filter((r) => r.method === 'PlayAt').map((r) => r.params)

  it('boot で daemon に接続し GetStatus を送る', async () => {
    const p = await boot()
    expect(p.isRunning).toBe(false) // scheduler はまだ start していない
    expect(server.received.some((r) => r.method === 'GetStatus')).toBe(true)
  })

  it('scheduleEvent → start で LoadSample + PlayAt を dispatch する', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)

    const load = server.received.find((r) => r.method === 'LoadSample')
    expect(load?.params.path).toBe('/audio/kick.wav')

    const play = playAtRecords()[0]
    expect(play.sample_id).toBe('s-/audio/kick.wav')
    expect(play.gain).toBeCloseTo(1.0, 5) // 0 dB → amplitude 1.0
  })

  it('gainDb を linear amplitude に変換して PlayAt.gain へ渡す', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/snare.wav', 0, -6, 0, 'seqA') // -6 dB ≈ 0.501
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    expect(playAtRecords()[0].gain as number).toBeCloseTo(Math.pow(10, -6 / 20), 4)
  })

  it('PlayAt.time_sec は daemon now（anchor）+ 定数 lookahead', async () => {
    const p = await boot(defaultHandlers(), { lookaheadSec: 0.05 })
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    const timeSec = playAtRecords()[0].time_sec as number
    // anchor.daemonSec = uptime(10) + 経過。lookahead 0.05 を足すので 10.05 前後。
    expect(timeSec).toBeGreaterThanOrEqual(10.04)
    expect(timeSec).toBeLessThan(11)
  })

  it('StreamStats の now_sec で anchor を補正する', async () => {
    const p = await boot(defaultHandlers(), { lookaheadSec: 0.05 })
    // transport が 50 秒へ進んだことを通知。
    server.broadcastEvent('StreamStats', {
      cpu_load: 0,
      xruns: 0,
      buffer_underruns: 0,
      now_sec: 50,
    })
    await waitFor(() => true, { timeoutMs: 30 }) // event を受け取る猶予
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    const timeSec = playAtRecords()[0].time_sec as number
    expect(timeSec).toBeGreaterThanOrEqual(50.04)
    expect(timeSec).toBeLessThan(51)
  })

  it('同一 filepath は一度だけ LoadSample（キャッシュ + single-flight）', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    const loads = server.received.filter((r) => r.method === 'LoadSample')
    expect(loads.length).toBe(1)
  })

  it('pan≠0 は 1 回 warn し、中央定位で PlayAt は出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 50, 'seqA') // pan=50
    p.scheduleEvent('/audio/kick.wav', 0, 0, 50, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    const panWarns = warn.mock.calls.filter((c) => String(c[0]).includes('pan'))
    expect(panWarns.length).toBe(1) // warn-once
    warn.mockRestore()
  })

  it('scheduleSliceEvent は 1 回 warn して skip（PlayAt を出さない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleSliceEvent('/audio/loop.wav', 0, 1, 4, 250, 0, 0, 'seqA')
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA') // これは出る
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    // slice は skip されるので PlayAt は kick の 1 件のみ。
    expect(playAtRecords().length).toBe(1)
    expect(playAtRecords()[0].sample_id).toBe('s-/audio/kick.wav')
    const sliceWarns = warn.mock.calls.filter((c) => String(c[0]).includes('slice'))
    expect(sliceWarns.length).toBe(1)
    warn.mockRestore()
  })

  it('outputChannel は 1 回 warn して hardware で PlayAt を出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA', 'drums')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    const chWarns = warn.mock.calls.filter((c) => String(c[0]).includes('outputChannel'))
    expect(chWarns.length).toBe(1)
    warn.mockRestore()
  })

  it('gainDb=-Infinity（無音）は PlayAt を出さない', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, -Infinity, 0, 'seqA')
    p.scheduleEvent('/audio/snare.wav', 0, 0, 0, 'seqA') // こちらは出る
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    // 少し待っても無音イベントは出ない。
    await new Promise((r) => setTimeout(r, 30))
    expect(playAtRecords().length).toBe(1)
    expect(playAtRecords()[0].sample_id).toBe('s-/audio/snare.wav')
  })

  it('clearSequenceEvents したシーケンスのイベントは発火しない', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 100, 0, 0, 'seqA')
    p.clearSequenceEvents('seqA')
    p.start()
    await new Promise((r) => setTimeout(r, 60))
    expect(playAtRecords().length).toBe(0)
  })

  it('loadBuffer は pre-load し getAudioDuration がキャッシュ秒数を返す', async () => {
    const p = await boot()
    await p.loadBuffer('/audio/kick.wav')
    expect(server.received.some((r) => r.method === 'LoadSample')).toBe(true)
    // frames 48000 / sample_rate 48000 = 1.0 秒
    expect(p.getAudioDuration('/audio/kick.wav')).toBeCloseTo(1.0, 5)
    expect(p.getAudioDuration('/audio/unknown.wav')).toBe(0)
  })
})

describe('createAudioEngine() / resolveEngineKind()', () => {
  it('ORBITSCORE_ENGINE=rust で RustEnginePlayer を返す', () => {
    const engine = createAudioEngine({ ORBITSCORE_ENGINE: 'rust' } as NodeJS.ProcessEnv)
    expect(engine).toBeInstanceOf(RustEnginePlayer)
  })

  it('未設定 / 他値では SuperColliderPlayer を返す', () => {
    expect(createAudioEngine({} as NodeJS.ProcessEnv)).toBeInstanceOf(SuperColliderPlayer)
    expect(createAudioEngine({ ORBITSCORE_ENGINE: 'sc' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      SuperColliderPlayer,
    )
  })

  it('resolveEngineKind は rust / それ以外を正規化する', () => {
    expect(resolveEngineKind('rust')).toBe('rust')
    expect(resolveEngineKind('RUST')).toBe('rust')
    expect(resolveEngineKind(' rust ')).toBe('rust')
    expect(resolveEngineKind(undefined)).toBe('supercollider')
    expect(resolveEngineKind('supercollider')).toBe('supercollider')
  })
})
