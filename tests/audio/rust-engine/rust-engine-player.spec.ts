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

import { gainDbToAmplitude } from '../../../packages/engine/src/audio/audio-gain-utils'
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
    expect(playAtRecords()[0].gain as number).toBeCloseTo(gainDbToAmplitude(-6), 4)
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
    expect(playAtRecords()[1].gain as number).toBeCloseTo(gainDbToAmplitude(-6), 4)
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

  // --- recovery floor（daemon supervision + auto-respawn / #300） ---

  it('daemon 切断時は respawn → 再接続 → 再 establish し、poll を止めず再生を継続する', async () => {
    // respawn は warn を多数出すので抑制（noise 排除）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // 連続供給（active loops の代理）: 0..1500ms に 50ms 間隔でイベントを撒く。
    for (let t = 0; t <= 1500; t += 50) p.scheduleEvent('/audio/loop.wav', t, 0, 0, 'seqA')
    p.start()
    // 初回 dispatch（PlayAt）が走るのを待ち、その時点を drop の基準点にする。
    await waitFor(() => server.received.some((r) => r.method === 'PlayAt'))
    const dropMark = server.received.length
    // 接続だけ落とす（server は listen 継続 = 実 daemon の死 → 同一 URL へ再接続可能を模す）。
    server.dropConnections()
    // respawn → 再接続 → 再 establish（GetStatus が drop 後に届く）を待つ。
    await waitFor(() => server.received.slice(dropMark).some((r) => r.method === 'GetStatus'), {
      timeoutMs: 3000,
    })
    // 復帰後も dispatch が続く（active loops の構造的復帰）。
    await waitFor(() => server.received.slice(dropMark).some((r) => r.method === 'PlayAt'), {
      timeoutMs: 3000,
    })
    expect(p.isRunning).toBe(true) // poll は止まっていない
    // 新 daemon は空 → sample が再ロードされる（sampleIds キャッシュ破棄の証左）。
    expect(server.received.slice(dropMark).some((r) => r.method === 'LoadSample')).toBe(true)
    warnSpy.mockRestore()
  })

  it('respawn が上限まで失敗したら poll を止め、fatal を一度だけ出す（プロセスは生存）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/a.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => server.received.some((r) => r.method === 'PlayAt'))
    // server ごと停止 → 再接続不可 → respawn は全試行失敗する。
    await server.stop()
    // MAX_RESPAWN_ATTEMPTS 回失敗後に poll が止まる。
    await waitFor(() => !p.isRunning, { timeoutMs: 5000 })
    const fatal = errorSpy.mock.calls.filter((c) => String(c[0]).includes('respawn failed'))
    expect(fatal.length).toBe(1) // 断念通知は一度だけ（flood しない）
    expect(p.isRunning).toBe(false)
    // TS プロセスは生存している（このテストが続行できている事自体が証左）。
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('respawn 後は stale anchor を捨て新 daemon の transport へ再 anchor する（desync 防止）', async () => {
    // recovery の唯一 load-bearing 不変式の CI-safe カバレッジ（gated 実機テストの mock 版）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot() // GetStatus uptime=10 → anchor≈10
    // 古い daemon が長時間回っていた状況を作る: StreamStats で anchor を ~50 へ進める。
    server.broadcastEvent('StreamStats', { now_sec: 50 })
    for (let t = 0; t <= 4000; t += 100) p.scheduleEvent('/audio/loop.wav', t, 0, 0, 'seqA')
    p.start()
    // anchor が 50 に進んだことを dispatch の time_sec で確認（pre-drop は ~50）。
    await waitFor(() => playAtRecords().some((r) => (r.time_sec as number) > 40))
    const dropMark = server.received.length
    // 接続だけ落として respawn。新 daemon の GetStatus は uptime=10（< 50）を返す。
    server.dropConnections()
    await waitFor(() => server.received.slice(dropMark).some((r) => r.method === 'PlayAt'), {
      timeoutMs: 3000,
    })
    // 再 anchor されていれば post-respawn の time_sec は新 daemon の uptime(≈10)+lookahead 付近で、
    // stale な 50 を引きずらない（= stale anchor で「数十秒先」を送る desync が起きない）。
    const postTimes = server.received
      .slice(dropMark)
      .filter((r) => r.method === 'PlayAt')
      .map((r) => r.params.time_sec as number)
    expect(postTimes.length).toBeGreaterThan(0)
    expect(Math.min(...postTimes)).toBeLessThan(20)
    warnSpy.mockRestore()
  })

  it('respawn 中に in-flight だった one-shot は再発火しない（drop される）', async () => {
    // #300 recovery contract「in-flight one-shot は drop（再発火しない）」の CI-safe カバレッジ。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot(
      defaultHandlers({
        // oneshot の PlayAt は in-flight のまま hang させ、その状態で接続を落とす。
        PlayAt: (params) =>
          String(params.sample_id).includes('oneshot')
            ? new Promise<Record<string, unknown>>(() => {})
            : Promise.resolve({ play_id: 'p-cont' }),
      }),
    )
    const oneShotCount = (): number =>
      server.received.filter(
        (r) => r.method === 'PlayAt' && String(r.params.sample_id).includes('oneshot'),
      ).length
    // 一度だけ撒く one-shot（time 0）と、生存確認用の継続ストリーム。
    p.scheduleEvent('/audio/oneshot.wav', 0, 0, 0, 'oneshotSeq')
    for (let t = 0; t <= 4000; t += 100) p.scheduleEvent('/audio/cont.wav', t, 0, 0, 'contSeq')
    p.start()
    await waitFor(() => oneShotCount() >= 1) // one-shot PlayAt が in-flight になった
    const oneShotBefore = oneShotCount()
    const dropMark = server.received.length
    server.dropConnections() // one-shot を in-flight のまま落とす
    // respawn → 継続ストリームが新 daemon へ復帰（系が生きている）。
    await waitFor(
      () =>
        server.received
          .slice(dropMark)
          .some((r) => r.method === 'PlayAt' && String(r.params.sample_id).includes('cont')),
      { timeoutMs: 3000 },
    )
    // one-shot は再発火していない（drop 後に oneshot の PlayAt が増えていない）。
    expect(oneShotCount()).toBe(oneShotBefore)
    expect(p.isRunning).toBe(true)
    warnSpy.mockRestore()
  })

  it('respawn の establishSession 中に新 daemon が即死しても retry して復帰する', async () => {
    // Critical 回帰: 再死を getStatus が anchor=0 で吸収して誤って成功宣言する wedge を防ぐ。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let statusCalls = 0
    const p = await boot(
      defaultHandlers({
        GetStatus: () => {
          statusCalls++
          // boot=1。最初の respawn の establishSession（=2）で再死させる。2回目以降の respawn で復帰。
          if (statusCalls === 2) {
            server.dropConnections()
            return new Promise<Record<string, unknown>>(() => {}) // 応答前に socket が閉じる
          }
          return {
            daemon_version: 'mock-0.0.0',
            protocol_version: '0.1',
            output_sample_rate: 48000,
            output_channels: 2,
            loaded_samples: 0,
            active_plays: 0,
            uptime_sec: 10,
          }
        },
      }),
    )
    for (let t = 0; t <= 6000; t += 100) p.scheduleEvent('/audio/loop.wav', t, 0, 0, 'seqA')
    p.start()
    await waitFor(() => server.received.some((r) => r.method === 'PlayAt'))
    server.dropConnections() // 1度目の死
    // 再死（GetStatus call 2）を越えて 3 回目の GetStatus で復帰すること = retry が効いている証左。
    await waitFor(() => statusCalls >= 3, { timeoutMs: 5000 })
    const recoverMark = server.received.length
    await waitFor(() => server.received.slice(recoverMark).some((r) => r.method === 'PlayAt'), {
      timeoutMs: 3000,
    })
    expect(p.isRunning).toBe(true) // wedge せず復帰し dispatch 継続
    warnSpy.mockRestore()
  })

  it('quit() は意図的 close なので respawn を起こさない', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/a.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => server.received.some((r) => r.method === 'PlayAt'))
    const statusBefore = server.received.filter((r) => r.method === 'GetStatus').length
    await p.quit()
    player = null // afterEach の二重 quit を避ける
    // quit 後しばらく待っても respawn（新規 GetStatus = 再 establish）が起きない。
    await new Promise((r) => setTimeout(r, 300))
    const statusAfter = server.received.filter((r) => r.method === 'GetStatus').length
    expect(statusAfter).toBe(statusBefore)
    expect(p.isRunning).toBe(false)
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
