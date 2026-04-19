/**
 * DaemonClient の protocol 挙動検証。
 *
 * 実 daemon バイナリを spawn せず、`MockDaemonServer` で WebSocket 経路のみを検証する。
 * 子プロセス spawn の健全性は integration test（別途）で扱う。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import { DaemonProtocolError } from '../../../packages/engine/src/audio/rust-engine/errors'

import { MockDaemonServer } from './mock-daemon-server'

describe('DaemonClient with mock server', () => {
  let server: MockDaemonServer
  let client: DaemonClient

  beforeEach(async () => {
    server = new MockDaemonServer()
    client = new DaemonClient()
  })

  afterEach(async () => {
    await client.quit()
    await server.stop()
  })

  it('handshake を受信して isRunning=true になる', async () => {
    const url = await server.start({})
    await client.start({ wsUrlOverride: url })
    expect(client.isRunning()).toBe(true)
  })

  it('LoadSample の request/response を解決する', async () => {
    const url = await server.start({
      LoadSample: (params) => ({
        sample_id: 's-mock-1',
        frames: 44100,
        channels: 2,
        sample_rate: 48000,
        echo_path: params.path,
      }),
    })
    await client.start({ wsUrlOverride: url })
    const info = await client.loadSample('/tmp/kick.wav')
    expect(info.sampleId).toBe('s-mock-1')
    expect(info.frames).toBe(44100)
    expect(info.channels).toBe(2)
    expect(info.sampleRate).toBe(48000)
    const record = server.received.find((r) => r.method === 'LoadSample')
    expect(record?.params.path).toBe('/tmp/kick.wav')
  })

  it('PlayAt は playId を返す', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-mock-1' }),
    })
    await client.start({ wsUrlOverride: url })
    const res = await client.playAt('s-mock-1', 0.0, 0.8)
    expect(res.playId).toBe('p-mock-1')
  })

  it('Stop は status=stopped を true に変換する', async () => {
    const url = await server.start({
      Stop: (params) => {
        if (params.play_id === 'p-known') return { play_id: params.play_id, status: 'stopped' }
        return { play_id: params.play_id, status: 'not_found' }
      },
    })
    await client.start({ wsUrlOverride: url })
    expect(await client.stop('p-known')).toBe(true)
    expect(await client.stop('p-ghost')).toBe(false)
  })

  it('SetGlobalGain は resolve する', async () => {
    const url = await server.start({
      SetGlobalGain: () => ({ status: 'accepted' }),
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.setGlobalGain(0.5)).resolves.toBeUndefined()
  })

  it('error レスポンスは DaemonProtocolError に変換される', async () => {
    const url = await server.start({
      SetGlobalGain: () => {
        const e = new Error('value must be >= 0') as Error & { code?: string }
        e.code = 'PARAM_OUT_OF_RANGE'
        throw e
      },
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.setGlobalGain(-0.1)).rejects.toBeInstanceOf(DaemonProtocolError)
    await expect(client.setGlobalGain(-0.1)).rejects.toMatchObject({
      code: 'PARAM_OUT_OF_RANGE',
    })
  })

  it('event frame を EventEmitter に dispatch する', async () => {
    const url = await server.start({})
    await client.start({ wsUrlOverride: url })

    const received: unknown[] = []
    client.on('play-ended', (data) => received.push(data))
    server.broadcastEvent('PlayEnded', { play_id: 'p-1', time_sec: 1.5 })

    // event propagation は次の tick で到達する
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toHaveLength(1)
    expect((received[0] as { play_id: string }).play_id).toBe('p-1')
  })

  it('quit 後に isRunning=false になる', async () => {
    const url = await server.start({})
    await client.start({ wsUrlOverride: url })
    await client.quit()
    expect(client.isRunning()).toBe(false)
  })
})
