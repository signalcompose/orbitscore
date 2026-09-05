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
import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import {
  fitAnchorSamples,
  RustEnginePlayer,
} from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { SuperColliderPlayer } from '../../../packages/engine/src/audio/supercollider-player'
// クロスパッケージ契約 (#390): [STEP] marker は engine（emitter）と拡張（parser）が
// 文字列書式だけで結合している。実 emit 行を parser に往復させ、書式ドリフトを
// このテストで検出する（tests/ ルートは両パッケージを import できる）。
import { parseStepLine } from '../../../packages/vscode-extension/src/playhead'

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

/** GetStatus + LoadSample + PlayAt + stop flush の既定ハンドラ（uptime=10 で anchor を固定的に）。 */
function defaultHandlers(overrides: MockDaemonHandlers = {}): MockDaemonHandlers {
  let playSeq = 0
  return {
    GetStatus: () => ({
      daemon_version: 'mock-0.0.0',
      protocol_version: '0.2',
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
    StopAll: () => ({ stopped: 0 }),
    PluginAllNotesOff: () => ({ released: 0, stale: 0, failed: 0 }),
    // 既定の mock daemon は feature `link-audio` 無効ビルドを模す（LINK_AUDIO_UNAVAILABLE）。player は
    // これを warn-once gap として握り潰す。実 egress を持つ daemon の挙動は override で差し替える。
    RegisterLinkAudioChannel: () => {
      throw Object.assign(new Error('mock daemon built without link-audio feature'), {
        code: 'LINK_AUDIO_UNAVAILABLE',
      })
    },
    SetLinkTempo: () => {
      throw Object.assign(new Error('mock daemon built without link-audio feature'), {
        code: 'LINK_AUDIO_UNAVAILABLE',
      })
    },
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

  it('daemon の DaemonError WARNING（LINK_EGRESS_DROP 等）を operator に warn で surface する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // daemon が LinkAudio egress drop を 1 Hz ticker で通知する想定の event を流す。
    server.broadcastEvent('DaemonError', {
      severity: 'warning',
      code: 'LINK_EGRESS_DROP',
      message: 'LinkAudio egress dropped samples (512 total interleaved)',
    })
    // subscribe した onDaemonError が console.warn するまで待つ（void に消えないこと）。
    await waitFor(() => warn.mock.calls.some((c) => String(c[0]).includes('LINK_EGRESS_DROP')))
    void p
    warn.mockRestore()
  })

  it('respawn 後も daemon-error を二重購読せず単発で surface する（off→on 再購読）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // daemon 死 → respawn → 再接続 → establishSession が daemon-error を off→on で再購読する。
    const dropMark = server.received.length
    server.dropConnections()
    await waitFor(() => server.received.slice(dropMark).some((r) => r.method === 'GetStatus'), {
      timeoutMs: 2000,
    })
    // GetStatus 受信後、establishSession の off→on 購読が完了する猶予を置いてから 1 件だけ流す。
    await new Promise((r) => setTimeout(r, 30))
    warn.mockClear()
    server.broadcastEvent('DaemonError', {
      severity: 'warning',
      code: 'LINK_EGRESS_DROP',
      message: 'LinkAudio egress dropped samples (512 total interleaved)',
    })
    await waitFor(() => warn.mock.calls.some((c) => String(c[0]).includes('LINK_EGRESS_DROP')))
    // off→on が効いていれば購読は 1 つ → 単発。off 欠落なら二重購読で 2 回 warn される（再購読回帰）。
    const dropWarns = warn.mock.calls.filter((c) => String(c[0]).includes('LINK_EGRESS_DROP'))
    expect(dropWarns.length).toBe(1)
    void p
    warn.mockRestore()
  })

  it('fatal severity の daemon-error は console.error に出す（warn に埋もれさせない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // ticker 経由の fatal な DaemonError（DEVICE_LOST）を流す。daemon-died とは別経路。
    server.broadcastEvent('DaemonError', {
      severity: 'fatal',
      code: 'DEVICE_LOST',
      message: 'audio device disappeared',
    })
    await waitFor(() => error.mock.calls.some((c) => String(c[0]).includes('DEVICE_LOST')))
    // fatal は console.error へ。severity を保ち、warning と同じ console.warn には出さない。
    expect(error.mock.calls.some((c) => String(c[0]).includes('DEVICE_LOST'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('DEVICE_LOST'))).toBe(false)
    void p
    error.mockRestore()
    warn.mockRestore()
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
    // eventDurationMs=250=sliceDuration → rate=1.0（自然尺・varispeed なし）。
    expect(rec.rate as number).toBeCloseTo(1.0, 5)
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

  it('slice の rate≠1.0 は varispeed レートを PlayAt で送る（warn しない・#319）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    // chop(8) → sliceDuration=0.125。eventDurationMs=500 → rate=0.125/0.5=0.25（<1 = 遅く低ピッチ）。
    p.scheduleSliceEvent('/audio/loop.wav', 0, 1, 8, 500, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    const rec = playAtRecords()[0]
    // slice 領域は source 自然尺（duration=sliceDuration=0.125）、varispeed は rate=0.25 で
    // daemon の render に委ねる（出力尺 = 0.125/0.25 = 0.5s = スロット尺）。
    expect(rec.duration_sec as number).toBeCloseTo(0.125, 5)
    expect(rec.rate as number).toBeCloseTo(0.25, 5)
    // varispeed は実装済みなので time-stretch 未対応 warn は出ない。
    const rateWarns = warn.mock.calls.filter((c) => String(c[0]).includes('rate='))
    expect(rateWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('scheduleEvent outputChannel は stale な「not wired」warn を出さない（A4-2b-2b で egress 配線済み）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA', 'drums')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    // feature-gap signal は registerLinkAudioChannel（sequence.output() 経由）が authoritative。
    // scheduleEvent は channel を tag するだけで「not wired」warn は出さない（egress 有効 daemon で誤誘導）。
    const staleWarns = warn.mock.calls.filter((c) => String(c[0]).includes('not wired'))
    expect(staleWarns.length).toBe(0)
    // outputChannel は PlayAt の channel フィールドとして転送される（A4-2b-1）。
    expect(playAtRecords()[0].channel).toBe('drums')
    warn.mockRestore()
  })

  it('scheduleEvent outputChannel あり → daemon.playAt に channel を転送する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA', 'reverb')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    expect(playAtRecords()[0].channel).toBe('reverb')
    warn.mockRestore()
  })

  it('scheduleEvent outputChannel なし → daemon.playAt に channel フィールドを含めない', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    expect(playAtRecords()[0]).not.toHaveProperty('channel')
  })

  it('scheduleSliceEvent outputChannel あり → daemon.playAt に channel を転送する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot()
    p.scheduleSliceEvent('/audio/loop.wav', 0, 1, 4, 250, 0, 0, 'seqA', 'drums')
    p.start()
    await waitFor(() => playAtRecords().length >= 1)
    expect(playAtRecords()[0].channel).toBe('drums')
    warn.mockRestore()
  })

  it('registerLinkAudioChannel: daemon が RegisterLinkAudioChannel を受理 → throw せず warn も出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 実 egress を持つ daemon（feature 有効）を模す: 受理して ok を返す。
    const p = await boot(
      defaultHandlers({ RegisterLinkAudioChannel: () => ({ status: 'registered' }) }),
    )
    await expect(p.registerLinkAudioChannel('drums')).resolves.toBeUndefined()
    expect(server.received.some((r) => r.method === 'RegisterLinkAudioChannel')).toBe(true)
    const ocWarns = warn.mock.calls.filter((c) => String(c[0]).includes('LinkAudio channel'))
    expect(ocWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('registerLinkAudioChannel: LINK_AUDIO_UNAVAILABLE（feature 無効ビルド）は warn-once で握り潰す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot() // 既定 handler が LINK_AUDIO_UNAVAILABLE を投げる
    await expect(p.registerLinkAudioChannel('drums')).resolves.toBeUndefined()
    await p.registerLinkAudioChannel('drums') // 2 回目も warn は増えない（warn-once）
    const gapWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('without the link-audio feature'),
    )
    expect(gapWarns.length).toBe(1)
    warn.mockRestore()
  })

  it('registerLinkAudioChannel: LINK_AUDIO_RUNTIME（runtime 失敗）は feature-gap と区別して rethrow する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot(
      defaultHandlers({
        RegisterLinkAudioChannel: () => {
          // runtime 失敗（channel 上限・consumer 不在等）→ feature-gap と誤認せず rethrow されるべき。
          throw Object.assign(new Error('link channel limit reached'), {
            code: 'LINK_AUDIO_RUNTIME',
          })
        },
      }),
    )
    await expect(p.registerLinkAudioChannel('drums')).rejects.toThrow()
    const gapWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('without the link-audio feature'),
    )
    expect(gapWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('setLinkTempo: daemon が SetLinkTempo を受理 → throw せず warn も出さない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Link テンポリードを持つ daemon（feature 有効）を模す: 受理して ok を返す。
    const p = await boot(defaultHandlers({ SetLinkTempo: () => ({ status: 'accepted' }) }))
    await expect(p.setLinkTempo(120)).resolves.toBeUndefined()
    expect(server.received.some((r) => r.method === 'SetLinkTempo')).toBe(true)
    const tempoWarns = warn.mock.calls.filter((c) => String(c[0]).includes('setLinkTempo'))
    expect(tempoWarns.length).toBe(0)
    warn.mockRestore()
  })

  it('setLinkTempo: LINK_AUDIO_UNAVAILABLE（feature 無効ビルド）は warn-once で握り潰す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot() // 既定 handler が LINK_AUDIO_UNAVAILABLE を投げる
    await expect(p.setLinkTempo(120)).resolves.toBeUndefined()
    await p.setLinkTempo(130) // 2 回目も warn は増えない（warn-once）
    const gapWarns = warn.mock.calls.filter((c) => String(c[0]).includes('setLinkTempo'))
    expect(gapWarns.length).toBe(1)
    warn.mockRestore()
  })

  it('setLinkTempo: LINK_AUDIO_RUNTIME（runtime 失敗）は feature-gap と区別して rethrow する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = await boot(
      defaultHandlers({
        SetLinkTempo: () => {
          // runtime 失敗（Link peer 不在等）→ feature-gap と誤認せず rethrow されるべき。
          throw Object.assign(new Error('link tempo push failed: no peers'), {
            code: 'LINK_AUDIO_RUNTIME',
          })
        },
      }),
    )
    await expect(p.setLinkTempo(120)).rejects.toThrow()
    const gapWarns = warn.mock.calls.filter((c) => String(c[0]).includes('setLinkTempo'))
    expect(gapWarns.length).toBe(0)
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

  it('argPath 付き scheduleEvent は dispatch 成功後に [STEP] marker を stdout へ出す (#390)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const p = await boot()
      p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA', undefined, '2')
      p.start()
      await waitFor(() => log.mock.calls.some((c) => String(c[0]).startsWith('[STEP] seqA 2 ')))
      expect(playAtRecords().length).toBe(1) // marker は音の dispatch に随伴する

      // 契約の往復: 実際に emit された行が extension 側の parseStepLine で
      // そのまま復元できること（emitter の書式変更はここで落ちる）。
      const stepLine = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[STEP] '))
      const parsed = parseStepLine(stepLine!)
      expect(parsed).toMatchObject({ seqName: 'seqA', argPath: '2' })
      expect(Number.isSafeInteger(parsed?.atEpochMs)).toBe(true)
    } finally {
      log.mockRestore()
    }
  })

  it('scheduleStepMarker（休符 0）は PlayAt/LoadSample なしで [STEP] だけ出す (#390)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const p = await boot()
      p.scheduleStepMarker(0, 'seqA', '1', 0)
      p.start()
      await waitFor(() => log.mock.calls.some((c) => String(c[0]).startsWith('[STEP] seqA 1 ')))
      await new Promise((r) => setTimeout(r, 30))
      expect(server.received.some((r) => r.method === 'LoadSample')).toBe(false)
      expect(playAtRecords().length).toBe(0)
    } finally {
      log.mockRestore()
    }
  })

  it('mute（-Infinity）中は休符 marker も出さない — 音イベントと同じ扱い (#390)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const p = await boot()
      p.scheduleStepMarker(0, 'seqA', '1', -Infinity)
      p.start()
      await new Promise((r) => setTimeout(r, 60))
      expect(log.mock.calls.some((c) => String(c[0]).includes('[STEP]'))).toBe(false)
    } finally {
      log.mockRestore()
    }
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
    // masterEffect は残存 gap（A4 era）として 1 回 warn する。outputChannel は A4-2b-2b で egress
    // 配線済みになり scheduleEvent からは warn しなくなったため、再 arm の検証には masterEffect を使う。
    await p.addEffect('master', 'compressor', {})
    p.stopAll()
    await p.addEffect('master', 'compressor', {}) // 次セッション = 再 arm 後
    const meWarns = warn.mock.calls.filter((c) => String(c[0]).includes('master effect'))
    expect(meWarns.length).toBe(2) // stopAll で再 arm
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
    // 遅れて再発火が来ても拾えるよう settle 猶予を置いてから確認（兄弟の不在 assert と同じ慣行）。
    await new Promise((r) => setTimeout(r, 30))
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
            protocol_version: '0.2',
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
    expect(server.received.some((r) => r.method === 'PluginAllNotesOff')).toBe(false)
  })

  it('stopAll() は StopAll の直後に PluginAllNotesOff を送る', async () => {
    const p = await boot()
    p.scheduleEvent('/audio/kick.wav', 0, 0, 0, 'seqA')
    p.start()
    // 少なくとも 1 回 PlayAt が dispatch されてから stopAll を呼ぶ。
    await waitFor(() => playAtRecords().length >= 1)
    p.stopAll()
    // stopAll は fire-and-forget（同期）。loopback WebSocket の往復を待つため waitFor を使う。
    await waitFor(() => server.received.some((r) => r.method === 'PluginAllNotesOff'))
    expect(
      server.received
        .filter((r) => r.method === 'StopAll' || r.method === 'PluginAllNotesOff')
        .map((r) => r.method),
    ).toEqual(['StopAll', 'PluginAllNotesOff'])
  })

  it('PluginAllNotesOff は released/stale/failed のいずれかがある時だけ stdout に要約を出す', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const flushSpy = vi.spyOn(DaemonClient.prototype, 'pluginAllNotesOff')
    let flushCount = 0
    const p = await boot(
      defaultHandlers({
        PluginAllNotesOff: () =>
          ++flushCount === 1
            ? { released: 2, stale: 1, failed: 1 }
            : { released: 0, stale: 0, failed: 0 },
      }),
    )
    p.stopAll()
    await waitFor(() => flushSpy.mock.calls.length === 1)
    await flushSpy.mock.results[0].value
    expect(logSpy).toHaveBeenCalledWith(
      '[rust-engine] plugin all-notes-off: released=2 stale=1 failed=1',
    )
    logSpy.mockClear()

    p.stopAll()
    await waitFor(() => flushSpy.mock.calls.length === 2)
    await flushSpy.mock.results[1].value
    expect(logSpy).not.toHaveBeenCalled()
    flushSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('respawn backoff 中に quit() しても clean に終わる（quit-during-respawn）', async () => {
    // Gap5: daemon 死 → respawn が RESPAWN_BACKOFF_MS(150ms) の待機に入った直後に
    // quit() を呼んでも unhandled rejection が出ず、respawn が完了せず clean に終わること。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = await boot()
    p.scheduleEvent('/audio/a.wav', 0, 0, 0, 'seqA')
    p.start()
    await waitFor(() => server.received.some((r) => r.method === 'PlayAt'))
    const statusBefore = server.received.filter((r) => r.method === 'GetStatus').length
    // dropConnections: server は listen 継続（再接続可能）で daemon 死を模す。
    // respawn が完全に通ると GetStatus が追加される — それを逆に「通らなかった」確認に使う。
    server.dropConnections()
    // onDaemonDied が respawning=true をセットし warn を出すまで待つ。
    // この時点で respawnLoop は setTimeout(150) の中で backoff 待機中。
    await waitFor(() => warnSpy.mock.calls.some((c) => String(c[0]).includes('respawning')), {
      timeoutMs: 1000,
    })
    // backoff の 150ms が切れる前に quit() を発行する（disposed=true → backoff 後の
    // disposed チェックで respawnLoop が早期 return する経路を踏む）。
    await p.quit() // resolve するはずで、throw しない
    player = null // afterEach の二重 quit を避ける
    // quit 後に settle 猶予を置く。もし respawn が完了していれば GetStatus が増える。
    await new Promise((r) => setTimeout(r, 300))
    const statusAfter = server.received.filter((r) => r.method === 'GetStatus').length
    // respawn は完了していない（disposed guard で早期 return）→ GetStatus は増えていない。
    expect(statusAfter).toBe(statusBefore)
    expect(p.isRunning).toBe(false)
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe('RustEnginePlayer plugin all-notes-off wiring without a socket', () => {
  it('StopAll の直後に flush し、非空要約だけを stdout に出す', async () => {
    const daemon = new DaemonClient()
    vi.spyOn(daemon, 'isRunning').mockReturnValue(true)
    const stop = vi.spyOn(daemon, 'stopAll').mockResolvedValue(0)
    const flush = vi
      .spyOn(daemon, 'pluginAllNotesOff')
      .mockResolvedValueOnce({ released: 2, stale: 1, failed: 1 })
      .mockResolvedValueOnce({ released: 0, stale: 0, failed: 0 })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const player = new RustEnginePlayer({ daemonClient: daemon })

    player.stopAll()
    await Promise.resolve()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]!)
    expect(log).toHaveBeenCalledWith(
      '[rust-engine] plugin all-notes-off: released=2 stale=1 failed=1',
    )

    log.mockClear()
    player.stopAll()
    await Promise.resolve()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('quit は disposed guard により RPC flush を送らない', async () => {
    const daemon = new DaemonClient()
    vi.spyOn(daemon, 'isRunning').mockReturnValue(true)
    const stop = vi.spyOn(daemon, 'stopAll').mockResolvedValue(0)
    const flush = vi
      .spyOn(daemon, 'pluginAllNotesOff')
      .mockResolvedValue({ released: 0, stale: 0, failed: 0 })
    const player = new RustEnginePlayer({ daemonClient: daemon })

    await player.quit()
    expect(stop).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('createAudioEngine() / resolveEngineKind()', () => {
  it('既定（未設定）で RustEnginePlayer を返す（cutover #108）', () => {
    expect(createAudioEngine({} as NodeJS.ProcessEnv)).toBeInstanceOf(RustEnginePlayer)
  })

  it('ORBITSCORE_ENGINE=rust でも RustEnginePlayer を返す', () => {
    expect(createAudioEngine({ ORBITSCORE_ENGINE: 'rust' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      RustEnginePlayer,
    )
  })

  it('ORBITSCORE_ENGINE=sc / supercollider で SuperColliderPlayer に opt-out する', () => {
    expect(createAudioEngine({ ORBITSCORE_ENGINE: 'sc' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      SuperColliderPlayer,
    )
    expect(
      createAudioEngine({ ORBITSCORE_ENGINE: 'supercollider' } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(SuperColliderPlayer)
  })

  it('resolveEngineKind は sc/supercollider を opt-out・それ以外（未設定含む）を既定 rust に正規化する', () => {
    expect(resolveEngineKind('sc')).toBe('supercollider')
    expect(resolveEngineKind('SC')).toBe('supercollider')
    expect(resolveEngineKind(' sc ')).toBe('supercollider')
    expect(resolveEngineKind('supercollider')).toBe('supercollider')
    expect(resolveEngineKind('rust')).toBe('rust')
    expect(resolveEngineKind(undefined)).toBe('rust')
    expect(resolveEngineKind('anything-else')).toBe('rust')
  })

  it('未設定 / 空 env では RustEnginePlayer を返し、警告は出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createAudioEngine({} as NodeJS.ProcessEnv)).toBeInstanceOf(RustEnginePlayer)
    expect(createAudioEngine({ ORBITSCORE_ENGINE: '' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      RustEnginePlayer,
    )
    expect(createAudioEngine({ ORBITSCORE_ENGINE: '   ' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      RustEnginePlayer,
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('未認識値（sc の typo 等）は Rust にフォールバックしつつ警告する（silent fallback を observable に）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createAudioEngine({ ORBITSCORE_ENGINE: 'scc' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      RustEnginePlayer,
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('scc')
    expect(warn.mock.calls[0][0]).toContain('未認識')
    warn.mockRestore()
  })

  it('明示 rust では警告を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createAudioEngine({ ORBITSCORE_ENGINE: 'rust' } as NodeJS.ProcessEnv)).toBeInstanceOf(
      RustEnginePlayer,
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

/**
 * #389 機構 B の数値ロジック（最小二乗フィット）の直接検証。本番では
 * onStreamStats(1Hz) がこれを呼んで anchorFit にキャッシュし、daemonNowSec が
 * O(1) で評価する — つまり実セッションのホットパスが依存する関数。
 */
describe('fitAnchorSamples (#389 mechanism B)', () => {
  it('returns null for fewer than 2 samples', () => {
    expect(fitAnchorSamples([])).toBeNull()
    expect(fitAnchorSamples([{ tsMs: 1000, daemonSec: 10 }])).toBeNull()
  })

  it('interpolates a 2-point window exactly (slope within bounds)', () => {
    const fit = fitAnchorSamples([
      { tsMs: 0, daemonSec: 10 },
      { tsMs: 1000, daemonSec: 11 },
    ])
    expect(fit).not.toBeNull()
    expect(fit!.slope).toBeCloseTo(1, 9)
    // 外挿: t=2000ms → 12s（直線の連続性）
    expect(fit!.intercept + fit!.slope * ((2000 - fit!.t0Ms) / 1000)).toBeCloseTo(12, 9)
  })

  it('averages block-quantization noise instead of tracking the last sample', () => {
    // 真のクロック: daemonSec = t/1000 + 10。サンプルは 0 / −8ms を交互に
    // 下方向量子化（issue の 512f ブロック位相うなりを模す）。
    const samples = Array.from({ length: 30 }, (_, i) => ({
      tsMs: i * 1000,
      daemonSec: i + 10 - (i % 2 === 0 ? 0 : 0.008),
    }))
    const fit = fitAnchorSamples(samples)
    expect(fit).not.toBeNull()
    // 外挿点での誤差が平均バイアス（−4ms）±2ms 以内 = 単一 last-wins anchor の
    // ±8ms 振動が平均化で消えていること。
    const predicted = fit!.intercept + fit!.slope * ((30_000 - fit!.t0Ms) / 1000)
    expect(Math.abs(predicted - (30 + 10 - 0.004))).toBeLessThan(0.002)
  })

  it('rejects a contaminated window (slope outside [0.95, 1.05])', () => {
    // respawn 型の不連続: 窓の途中で transport が 0 から再出発。
    expect(
      fitAnchorSamples([
        { tsMs: 0, daemonSec: 100 },
        { tsMs: 1000, daemonSec: 101 },
        { tsMs: 2000, daemonSec: 0 },
        { tsMs: 3000, daemonSec: 1 },
      ]),
    ).toBeNull()
  })

  it('rejects a degenerate window (zero time variance)', () => {
    expect(
      fitAnchorSamples([
        { tsMs: 5000, daemonSec: 10 },
        { tsMs: 5000, daemonSec: 10.001 },
      ]),
    ).toBeNull()
  })
})
