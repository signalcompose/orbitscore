/**
 * DaemonClient の protocol 挙動検証。
 *
 * 大半のテストは実 daemon バイナリを spawn せず、`MockDaemonServer` で WebSocket
 * 経路のみを検証する。spawn 失敗時のエラー変換はここで検証し（'error' event →
 * DaemonStartupError）、spawn 成功後の統合的健全性は gated real-daemon 系の対象。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DaemonClient,
  resolveDaemonBinaryPath,
} from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import {
  DaemonConnectionError,
  DaemonProtocolError,
} from '../../../packages/engine/src/audio/rust-engine/errors'

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

  it('PlayAt channel あり: channel フィールドを params に含める', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-ch-1' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.playAt('s-mock-1', 0.0, 0.8, 0, 0, 0, 1, 'drums')
    const rec = server.received.find((r) => r.method === 'PlayAt')
    expect(rec?.params.channel).toBe('drums')
  })

  it('PlayAt channel なし（undefined）: channel フィールドを params から省く', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-no-ch-1' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.playAt('s-mock-1', 0.0, 0.8)
    const rec = server.received.find((r) => r.method === 'PlayAt')
    expect(rec?.params).not.toHaveProperty('channel')
  })

  it('PlayAt channel 空文字: channel フィールドを params から省く', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-empty-ch-1' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.playAt('s-mock-1', 0.0, 0.8, 0, 0, 0, 1, '')
    const rec = server.received.find((r) => r.method === 'PlayAt')
    expect(rec?.params).not.toHaveProperty('channel')
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

  it('RegisterLinkAudioChannel は channel を params に送って resolve する', async () => {
    const url = await server.start({
      RegisterLinkAudioChannel: () => ({ status: 'registered', channel: 'drums' }),
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.registerLinkAudioChannel('drums')).resolves.toBeUndefined()
    const rec = server.received.find((r) => r.method === 'RegisterLinkAudioChannel')
    expect(rec?.params.channel).toBe('drums')
  })

  it('RegisterLinkAudioChannel の LINK_AUDIO_UNAVAILABLE は DaemonProtocolError に変換される', async () => {
    const url = await server.start({
      RegisterLinkAudioChannel: () => {
        const e = new Error('engine built without link-audio feature') as Error & {
          code?: string
        }
        e.code = 'LINK_AUDIO_UNAVAILABLE'
        throw e
      },
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.registerLinkAudioChannel('drums')).rejects.toMatchObject({
      code: 'LINK_AUDIO_UNAVAILABLE',
    })
  })

  it('SetLinkTempo は bpm を params に送って resolve する', async () => {
    const url = await server.start({
      SetLinkTempo: () => ({ status: 'accepted' }),
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.setLinkTempo(120)).resolves.toBeUndefined()
    const rec = server.received.find((r) => r.method === 'SetLinkTempo')
    expect(rec?.params.bpm).toBe(120)
  })

  it('SetLinkTempo の LINK_AUDIO_UNAVAILABLE は DaemonProtocolError に変換される', async () => {
    const url = await server.start({
      SetLinkTempo: () => {
        const e = new Error('engine built without link-audio feature') as Error & {
          code?: string
        }
        e.code = 'LINK_AUDIO_UNAVAILABLE'
        throw e
      },
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.setLinkTempo(120)).rejects.toMatchObject({
      code: 'LINK_AUDIO_UNAVAILABLE',
    })
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

  it('handshake 途中で server が close したら start() は reject する', async () => {
    // handshake を送らない mock server に接続すると、クライアントは待機状態に入る。
    // その最中に server.stop() すると ws close が飛び、handshakePromise が
    // 短時間で reject されるはず (hang しない)。
    const url = await server.start({}, /* skipHandshake */ true)
    const startPromise = client.start({
      wsUrlOverride: url,
      handshakeTimeoutMs: 2_000,
    })
    // open 後すぐに server を止めて close を飛ばす
    await new Promise((r) => setTimeout(r, 20))
    await server.stop()
    await expect(startPromise).rejects.toBeInstanceOf(DaemonConnectionError)
    expect(client.isRunning()).toBe(false)
  })

  it('handshake フレームが届かないと handshakeTimeout で reject する', async () => {
    // skipHandshake=true の mock に接続すると handshake frame が来ないので
    // handshakeTimeoutMs 経過後に reject されるはず。protocol_version 不一致時も
    // 同じ timeout 経路に落ちるため、version mismatch の具体検証は別 Issue で
    // mock server を拡張して扱う。
    const url = await server.start({}, true)
    const p = client.start({ wsUrlOverride: url, handshakeTimeoutMs: 200 })
    await expect(p).rejects.toBeInstanceOf(DaemonConnectionError)
  })
})

describe('DaemonClient real spawn error handling (C3)', () => {
  // 実 daemon バイナリを spawn する（mock 不使用）。'error' event 経路
  // （spawn 失敗 → DaemonStartupError 変換）を実際の子プロセス spawn で検証する。
  let client: DaemonClient
  let tmpDir: string
  let unexecutableBin: string

  beforeEach(() => {
    client = new DaemonClient()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-error-'))
    unexecutableBin = path.join(tmpDir, 'orbit-audio-daemon')
    // ファイルは存在するが実行権限を付けない（EACCES 狙い）。ENOENT は
    // resolveDaemonBinary の existsSync でフォールスルーしてしまい、この
    // 経路には到達しないため使えない。
    fs.writeFileSync(unexecutableBin, '#!/bin/sh\necho unreachable\n', { mode: 0o644 })
  })

  afterEach(async () => {
    await client.quit()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('実行権限のないバイナリへの spawn は "daemon spawn failed" で reject する', async () => {
    // exit/timeout 経路との判別のため文言まで固定して assert する。
    await expect(client.start({ daemonPath: unexecutableBin })).rejects.toThrow(
      /daemon spawn failed/,
    )
    expect(client.isRunning()).toBe(false)
  })
})

describe('resolveDaemonBinaryPath (C2)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-resolve-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('explicit path が existsSync で解決される場合 source は explicit', () => {
    const explicitPath = path.join(tmpDir, 'orbit-audio-daemon')
    fs.writeFileSync(explicitPath, '')
    const resolution = resolveDaemonBinaryPath(explicitPath)
    expect(resolution).toEqual({ path: explicitPath, source: 'explicit' })
  })

  it('explicit 未指定・ORBIT_AUDIO_DAEMON_PATH 解決時は source は env', () => {
    const envPath = path.join(tmpDir, 'orbit-audio-daemon')
    fs.writeFileSync(envPath, '')
    const prev = process.env.ORBIT_AUDIO_DAEMON_PATH
    process.env.ORBIT_AUDIO_DAEMON_PATH = envPath
    try {
      const resolution = resolveDaemonBinaryPath()
      expect(resolution).toEqual({ path: envPath, source: 'env' })
    } finally {
      if (prev === undefined) delete process.env.ORBIT_AUDIO_DAEMON_PATH
      else process.env.ORBIT_AUDIO_DAEMON_PATH = prev
    }
  })
})
