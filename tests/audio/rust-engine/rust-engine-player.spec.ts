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
    await new Promise((r) => setTimeout(r, 30)) // StreamStats event を受け取る猶予
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

  it('pan を daemon の [-1,1] に変換して PlayAt.pan へ渡す（warn しない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 50, 'seqA') // DSL pan=50 → daemon 0.5
    p.scheduleEvent('/audio/snare.wav', 0, 0, -100, 'seqA') // DSL pan=-100 → daemon -1.0
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    expect(playAtRecords()[0].pan as number).toBeCloseTo(0.5, 5)
    expect(playAtRecords()[1].pan as number).toBeCloseTo(-1.0, 5)
    // pan は #304 で実装済み → 中央 drop の warn は出さない。
    const panWarns = warn.mock.calls.filter((c) => String(c[0]).includes('pan'))
    expect(panWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('scheduleSliceEvent は slice 領域（offset/duration）を PlayAt で出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // loop.wav は 1.0 秒（mock: 48000 frames / 48000 Hz）。chop(4) の slice3 →
    // sliceDuration=0.25, offset=(3-1)*0.25=0.5。eventDurationMs=250=sliceDuration → rate=1.0。
    p.scheduleSliceEvent('/audio/loop.wav', 0, 3, 4, 250, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    const rec = playAtRecords()[0]
    expect(rec.sample_id).toBe('s-/audio/loop.wav')
    expect(rec.offset_sec as number).toBeCloseTo(0.5, 5)
    expect(rec.duration_sec as number).toBeCloseTo(0.25, 5)
    // rate=1.0 なので time-stretch warn は出ない。
    const rateWarns = warn.mock.calls.filter((c) => String(c[0]).includes('rate='))
    expect(rateWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('per-slice gain: 各 slice の gainDb が PlayAt.gain に独立反映される', async () => {
    const p = await boot()
    p.scheduleSliceEvent('/audio/loop.wav', 0, 1, 4, 250, 0, 0, 'seqA') // 0 dB → 1.0
    p.scheduleSliceEvent('/audio/loop.wav', 10, 2, 4, 250, -6, 0, 'seqA') // -6 dB ≈ 0.501
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    expect(playAtRecords()[0].gain as number).toBeCloseTo(1.0, 4)
    expect(playAtRecords()[1].gain as number).toBeCloseTo(Math.pow(10, -6 / 20), 4)
  })

  it('slice の rate≠1.0（time-stretch）は 1 回 warn し、自然尺で鳴らす', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // chop(8) → sliceDuration=0.125。eventDurationMs=500 → rate=0.25 ≠ 1.0。
    p.scheduleSliceEvent('/audio/loop.wav', 0, 1, 8, 500, 0, 0, 'seqA')
    p.scheduleSliceEvent('/audio/loop.wav', 10, 2, 8, 500, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    // rate≠1.0 でも slice は自然尺（duration=sliceDuration=0.125）で鳴る。
    expect(playAtRecords()[0].duration_sec as number).toBeCloseTo(0.125, 5)
    const rateWarns = warn.mock.calls.filter((c) => String(c[0]).includes('rate='))
    expect(rateWarns.length).toBe(1) // warn-once
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

  it('loadSample 失敗は当該 note のみ落とし、再スケジュールで再ロードを試みる', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let badLoadCount = 0
    const p = await boot(
      defaultHandlers({
        LoadSample: (params) => {
          if (params.path === '/audio/bad.wav') {
            badLoadCount++
            const err = new Error('decode failed') as Error & { code?: string }
            err.code = 'FILE_DECODE_ERROR'
            throw err
          }
          return {
            sample_id: `s-${String(params.path)}`,
            frames: 48000,
            channels: 2,
            sample_rate: 48000,
          }
        },
      }),
    )
    p.scheduleEvent('/audio/bad.wav', 0, 0, 0, 'seqA')
    p.scheduleEvent('/audio/good.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    await new Promise((r) => setTimeout(r, 20))
    // good.wav のみ発音、bad.wav は落ちる（poll loop は生存）。
    expect(playAtRecords().length).toBe(1)
    expect(playAtRecords()[0].sample_id).toBe('s-/audio/good.wav')
    // inflight は finally でクリアされるので、再スケジュールで再ロードを試みる。
    p.scheduleEvent('/audio/bad.wav', 0, 0, 0, 'seqA')
    await waitFor(() => badLoadCount >= 2)
    expect(badLoadCount).toBe(2)
    errorSpy.mockRestore()
  })

  it('boot は GetStatus 失敗でも resolve し、anchor=0 にフォールバックする', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const url = await server.start(
      defaultHandlers({
        GetStatus: () => {
          throw new Error('status unavailable')
        },
      }),
    )
    const p = new RustEnginePlayer({ wsUrlOverride: url, lookaheadSec: 0.05 })
    await p.boot() // reject しない
    player = p
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    // anchor=0 なので time_sec は lookahead 付近（uptime 10 由来ではない）。
    expect(playAtRecords()[0].time_sec as number).toBeLessThan(1)
    warn.mockRestore()
  })

  it('stopAll は warn-once を再 arm する（次セッションで再び warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // outputChannel(LinkAudio) は未対応 gap（A4）として 1 回 warn する。pan は実装済みで
    // gap ではないため、再 arm の検証には残存 gap である outputChannel を使う。
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA', 'drums')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    p.stopAll()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqB', 'drums') // 次セッション
    p.start()
    await waitFor(() => playAtRecords().length >= 2)
    const ocWarns = warn.mock.calls.filter((c) => String(c[0]).includes('outputChannel'))
    expect(ocWarns.length).toBe(2) // stopAll で再 arm
    warn.mockRestore()
  })

  it('過大 drift（> MAX_DRIFT_MS）のイベントは executePlayback で skip される', async () => {
    const p = await boot()
    // time=-2000ms → poll で即 due だが drift 2000ms > 1000ms。
    p.scheduleEvent('/audio/kick.wav', -2000, 0, 0, 'seqA')
    p.scheduleEvent('/audio/snare.wav', 0, 0, 0, 'seqA') // これは出る
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(playAtRecords().length).toBe(1)
    expect(playAtRecords()[0].sample_id).toBe('s-/audio/snare.wav')
  })

  it('ロード中（async）に clear されたイベントは発音しない（executePlayback 二重チェック）', async () => {
    let releaseLoad: (() => void) | null = null
    const p = await boot(
      defaultHandlers({
        LoadSample: (params) =>
          new Promise((resolve) => {
            releaseLoad = () =>
              resolve({
                sample_id: `s-${String(params.path)}`,
                frames: 48000,
                channels: 2,
                sample_rate: 48000,
              })
          }),
      }),
    )
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    // LoadSample 応答待ちで止まっている間に clear。
    await waitFor(() => releaseLoad !== null)
    p.clearSequenceEvents('seqA')
    releaseLoad!() // ロード解決 → executePlayback の liveSequences 再チェックで skip
    await new Promise((r) => setTimeout(r, 30))
    expect(playAtRecords().length).toBe(0)
  })

  it('master effect は 1 回 warn して no-op（addEffect/removeEffect）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    await p.addEffect('master', 'compressor', { threshold: -12 })
    await p.addEffect('master', 'limiter', {})
    await p.removeEffect('master', 'compressor')
    const fxWarns = warn.mock.calls.filter((c) => String(c[0]).includes('master effect'))
    expect(fxWarns.length).toBe(1) // warn-once
    warn.mockRestore()
  })

  it('daemon 切断時は poll を停止し error を一度だけ出す（flood しない）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // LoadSample を hang させ、複数イベントを in-flight のまま切断する。
    const p = await boot(defaultHandlers({ LoadSample: () => new Promise(() => {}) }))
    p.scheduleEvent('/audio/a.wav', 0, 0, 0, 'seqA')
    p.scheduleEvent('/audio/b.wav', 0, 0, 0, 'seqA')
    p.scheduleEvent('/audio/c.wav', 0, 0, 0, 'seqA')
    p.start()
    // 3 件の LoadSample が daemon に届き pending になるのを待つ。
    await waitFor(() => server.received.filter((r) => r.method === 'LoadSample').length >= 3)
    // WebSocket を閉じる → pending が全て DaemonConnectionError で reject。
    await server.stop()
    await waitFor(() => !p.isRunning) // 切断検出で scheduler 停止
    await new Promise((r) => setTimeout(r, 20))
    const connLostLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes('connection lost'))
    expect(connLostLogs.length).toBe(1) // 3 件失敗しても通知は 1 度だけ
    expect(p.isRunning).toBe(false)
    errorSpy.mockRestore()
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
