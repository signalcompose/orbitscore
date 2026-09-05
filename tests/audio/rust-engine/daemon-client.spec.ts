/**
 * DaemonClient の protocol 挙動検証。
 *
 * 大半のテストは実 daemon バイナリを spawn せず、`MockDaemonServer` で WebSocket
 * 経路のみを検証する。spawn 失敗時のエラー変換はここで検証し（'error' event →
 * DaemonStartupError）、spawn 成功後の統合的健全性は gated real-daemon 系の対象。
 */

import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWarmExecutable, SPAWN_TEST_TIMEOUT_MS } from '../../helpers/spawn-fixture'
import {
  DaemonClient,
  createDaemonStderrLineRouter,
  isDaemonNonErrorTracingLine,
  resolveDaemonBinaryPath,
} from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import {
  DaemonConnectionError,
  DaemonNotFoundError,
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

  it('listAudioDevices は ListAudioDevices の devices 配列をそのまま返す（#484 D1）', async () => {
    const url = await server.start({
      ListAudioDevices: () => ({
        devices: [
          {
            name: 'Built-in Output',
            isDefault: true,
            maxOutputChannels: 2,
            defaultSampleRate: 48000,
            direction: 'output',
          },
          {
            name: 'USB Audio',
            isDefault: false,
            maxOutputChannels: 8,
            defaultSampleRate: 44100,
            direction: 'output',
          },
        ],
      }),
    })
    await client.start({ wsUrlOverride: url })
    const devices = await client.listAudioDevices()
    expect(devices).toHaveLength(2)
    expect(devices[0]).toEqual({
      name: 'Built-in Output',
      isDefault: true,
      maxOutputChannels: 2,
      defaultSampleRate: 48000,
      direction: 'output',
    })
    expect(devices[1].name).toBe('USB Audio')
    const record = server.received.find((r) => r.method === 'ListAudioDevices')
    expect(record).toBeDefined()
  })

  it('listAudioDevices は devices が配列でない応答を空配列として扱う', async () => {
    const url = await server.start({
      ListAudioDevices: () => ({}),
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.listAudioDevices()).resolves.toEqual([])
  })

  it('LoadPlugin は response を camelCase に変換し effect role と plugin_id を送る', async () => {
    const url = await server.start({
      LoadPlugin: () => ({
        plugin_id: 'com.example.echo',
        plugin_name: 'Example Echo',
        note_port_index: 2,
      }),
    })
    await client.start({ wsUrlOverride: url })
    await expect(
      client.loadPlugin('/tmp/echo.clap', 'com.example.echo', 'effect'),
    ).resolves.toEqual({
      pluginId: 'com.example.echo',
      pluginName: 'Example Echo',
      notePortIndex: 2,
    })
    const record = server.received.find((r) => r.method === 'LoadPlugin')
    expect(record?.params).toEqual({
      path: '/tmp/echo.clap',
      plugin_id: 'com.example.echo',
      role: 'effect',
    })
  })

  it('LoadPlugin error は code を保持した DaemonProtocolError に変換する', async () => {
    const url = await server.start({
      LoadPlugin: () => {
        const error = new Error('clap host is unavailable') as Error & { code?: string }
        error.code = 'CLAP_UNAVAILABLE'
        throw error
      },
    })
    await client.start({ wsUrlOverride: url })
    await expect(client.loadPlugin('/tmp/echo.clap', undefined, 'effect')).rejects.toBeInstanceOf(
      DaemonProtocolError,
    )
    await expect(client.loadPlugin('/tmp/echo.clap', undefined, 'effect')).rejects.toMatchObject({
      code: 'CLAP_UNAVAILABLE',
    })
  })

  it('LoadPlugin sends instrument role and PluginNoteOn/Off wire params', async () => {
    const url = await server.start({
      LoadPlugin: () => ({ plugin_id: 'synth', plugin_name: 'Synth', note_port_index: 0 }),
      PluginNoteOn: () => ({}),
      PluginNoteOff: () => ({}),
    })
    await client.start({ wsUrlOverride: url })
    await client.loadPlugin('/tmp/synth.clap', undefined, 'instrument')
    await client.pluginNoteOn(60, 0, 0.75)
    await client.pluginNoteOff(60, 0, 0.25)

    expect(server.received.find((r) => r.method === 'LoadPlugin')?.params.role).toBe('instrument')
    expect(server.received.find((r) => r.method === 'PluginNoteOn')?.params).toEqual({
      key: 60,
      channel: 0,
      velocity: 0.75,
    })
    expect(server.received.find((r) => r.method === 'PluginNoteOff')?.params).toEqual({
      key: 60,
      channel: 0,
      velocity: 0.25,
    })
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

  it('PlayAt bus あり: bus フィールドを params に含める（#434 S3 insert routing）', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-bus-1' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.playAt('s-mock-1', 0.0, 0.8, 0, 0, 0, 1, undefined, 'seq-bus-0')
    const rec = server.received.find((r) => r.method === 'PlayAt')
    expect(rec?.params.bus).toBe('seq-bus-0')
    expect(rec?.params).not.toHaveProperty('channel')
  })

  it('PlayAt bus なし（undefined）: bus フィールドを params から省く', async () => {
    const url = await server.start({
      PlayAt: () => ({ play_id: 'p-no-bus-1' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.playAt('s-mock-1', 0.0, 0.8)
    const rec = server.received.find((r) => r.method === 'PlayAt')
    expect(rec?.params).not.toHaveProperty('bus')
  })

  it('LoadPlugin bus あり: bus フィールドを params に含める（#434 S3）', async () => {
    const url = await server.start({
      LoadPlugin: () => ({ plugin_id: 'reverb', plugin_name: 'Reverb', note_port_index: 0 }),
    })
    await client.start({ wsUrlOverride: url })
    await client.loadPlugin('/tmp/reverb.clap', undefined, 'effect', 'seq-bus-0')
    const record = server.received.find((r) => r.method === 'LoadPlugin')
    expect(record?.params).toEqual({
      path: '/tmp/reverb.clap',
      role: 'effect',
      bus: 'seq-bus-0',
    })
  })

  it('LoadPlugin instance/state_path あり: 両フィールドを params に含める（#540 P1/P2）', async () => {
    const url = await server.start({
      LoadPlugin: () => ({ plugin_id: 'kontakt', plugin_name: 'Kontakt', note_port_index: 0 }),
    })
    await client.start({ wsUrlOverride: url })
    await client.loadPlugin(
      '/plugins/kontakt.vst3',
      undefined,
      'instrument',
      undefined,
      'plugin:kick',
      '/songs/kick.vstpreset',
    )
    const record = server.received.find((r) => r.method === 'LoadPlugin')
    expect(record?.params).toEqual({
      path: '/plugins/kontakt.vst3',
      role: 'instrument',
      instance: 'plugin:kick',
      state_path: '/songs/kick.vstpreset',
    })
  })

  it('LoadPlugin instance/state_path なし: フィールド自体を省略する（互換・#540）', async () => {
    const url = await server.start({
      LoadPlugin: () => ({ plugin_id: 'synth', plugin_name: 'Synth', note_port_index: 0 }),
    })
    await client.start({ wsUrlOverride: url })
    await client.loadPlugin('/plugins/synth.clap', undefined, 'instrument')
    const record = server.received.find((r) => r.method === 'LoadPlugin')
    expect(record?.params).toEqual({
      path: '/plugins/synth.clap',
      role: 'instrument',
    })
    expect(record?.params).not.toHaveProperty('instance')
    expect(record?.params).not.toHaveProperty('state_path')
  })

  it('ReplacePlugin sends the exact instrument spec and maps quarantined_slot', async () => {
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({
      plugin_id: 'new-id',
      plugin_name: 'New Synth',
      note_port_index: 3,
      quarantined_slot: true,
    })
    await expect(
      client.replacePlugin(
        '/plugins/new.vst3',
        'new-id',
        'instrument',
        undefined,
        'plugin:kick',
        '/songs/new.state',
      ),
    ).resolves.toEqual({
      pluginId: 'new-id',
      pluginName: 'New Synth',
      notePortIndex: 3,
      quarantinedSlot: true,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('ReplacePlugin', {
      path: '/plugins/new.vst3',
      plugin_id: 'new-id',
      role: 'instrument',
      instance: 'plugin:kick',
      state_path: '/songs/new.state',
    })
  })

  it('R3 ReplacePlugin and UnloadPlugin preserve the effect bus target and omit bus for master', async () => {
    const request = vi.spyOn(client as any, 'request').mockImplementation(async (method: string) =>
      method === 'UnloadPlugin'
        ? { status: 'unloaded' }
        : {
            plugin_id: 'effect-id',
            plugin_name: 'Effect',
            note_port_index: 0,
            quarantined_slot: false,
          },
    )

    await client.replacePlugin('/plugins/sequence.clap', 'sequence-id', 'effect', 'seq-bus-0')
    await client.replacePlugin('/plugins/master.clap', undefined, 'effect')
    await client.unloadPlugin('effect', 'seq-bus-0')
    await client.unloadPlugin('effect')

    expect(request).toHaveBeenCalledTimes(4)
    expect(request).toHaveBeenNthCalledWith(1, 'ReplacePlugin', {
      path: '/plugins/sequence.clap',
      plugin_id: 'sequence-id',
      role: 'effect',
      bus: 'seq-bus-0',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'ReplacePlugin', {
      path: '/plugins/master.clap',
      role: 'effect',
    })
    expect(request.mock.calls[1]![1]).not.toHaveProperty('bus')
    expect(request).toHaveBeenNthCalledWith(3, 'UnloadPlugin', {
      role: 'effect',
      bus: 'seq-bus-0',
    })
    expect(request).toHaveBeenNthCalledWith(4, 'UnloadPlugin', { role: 'effect' })
  })

  it('GetPluginState sends the resolved effect target and preserves the byte result', async () => {
    const url = await server.start({
      GetPluginState: () => ({
        path: '/songs/states/master.state',
        bytes_written: 123,
      }),
    })
    await client.start({ wsUrlOverride: url })

    await expect(
      client.savePluginState(
        { role: 'effect', bus: 'seq-bus-2', chainPath: [1] },
        '/songs/states/master.state',
      ),
    ).resolves.toEqual({
      path: '/songs/states/master.state',
      bytesWritten: 123,
    })
    expect(server.received.find((record) => record.method === 'GetPluginState')?.params).toEqual({
      path: '/songs/states/master.state',
      role: 'effect',
      bus: 'seq-bus-2',
      chain_path: [1],
    })
  })

  it('GetPluginState sends an instrument instance without an effect bus', async () => {
    const url = await server.start({
      GetPluginState: () => ({
        path: '/songs/states/lead.state',
        bytes_written: 12,
      }),
    })
    await client.start({ wsUrlOverride: url })

    await client.savePluginState(
      { role: 'instrument', instance: 'plugin:lead' },
      '/songs/states/lead.state',
    )
    expect(server.received.find((record) => record.method === 'GetPluginState')?.params).toEqual({
      path: '/songs/states/lead.state',
      role: 'instrument',
      instance: 'plugin:lead',
      chain_path: [0],
    })
  })

  it.each([
    ['missing', undefined],
    ['non-numeric', 'twelve'],
  ])(
    'GetPluginState rejects a %s bytes_written value at the daemon boundary without opening a socket',
    async (_label, value) => {
      const request = vi.spyOn(client as any, 'request').mockResolvedValue({
        path: '/songs/states/lead.state',
        ...(value === undefined ? {} : { bytes_written: value }),
      })

      await expect(
        client.savePluginState(
          { role: 'instrument', instance: 'plugin:lead' },
          '/songs/states/lead.state',
        ),
      ).rejects.toThrow(`invalid bytes_written value: ${String(value)}`)
      expect(request).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledWith('GetPluginState', {
        path: '/songs/states/lead.state',
        role: 'instrument',
        instance: 'plugin:lead',
        chain_path: [0],
      })
    },
  )

  it('sends one complete ApplyEffectChain plan and maps the dropped-state response', async () => {
    const url = await server.start({
      ApplyEffectChain: () => ({
        status: 'applied',
        child_pid: 912,
        dropped: [{ prev_index: 1, path: '/states/B.state', bytes_written: 44 }],
      }),
    })
    await client.start({ wsUrlOverride: url })
    const request = {
      bus: 'seq-bus-2',
      mode: 'diff' as const,
      chain: [
        { op: 'keep' as const, prev_index: 0, enabled: false },
        {
          op: 'load' as const,
          kind: 'standard' as const,
          name: 'Gain',
          params: { db: -6 },
          enabled: true,
        },
      ],
      saveDropped: [{ prev_index: 1, path: '/states/B.state' }],
    }

    await expect(client.applyEffectChain(request)).resolves.toEqual({
      status: 'applied',
      childPid: 912,
      dropped: [{ prevIndex: 1, path: '/states/B.state', bytesWritten: 44 }],
    })
    expect(server.received.find((record) => record.method === 'ApplyEffectChain')?.params).toEqual({
      role: 'effect',
      bus: 'seq-bus-2',
      mode: 'diff',
      chain: request.chain,
      save_dropped: request.saveDropped,
    })
  })

  it('PluginNoteOn/Off instance あり/なし: instance フィールドの含有/省略（#540 P1）', async () => {
    const url = await server.start({
      PluginNoteOn: () => ({ status: 'note_on', key: 60 }),
      PluginNoteOff: () => ({ status: 'note_off', key: 60 }),
    })
    await client.start({ wsUrlOverride: url })
    await client.pluginNoteOn(60, 0, 0.8, 'plugin:kick')
    await client.pluginNoteOff(60, 0, undefined, 'plugin:kick')
    await client.pluginNoteOn(61, 0, 0.8)
    const notes = server.received.filter((r) => r.method.startsWith('PluginNote'))
    expect(notes[0]?.params).toEqual({
      key: 60,
      channel: 0,
      velocity: 0.8,
      instance: 'plugin:kick',
    })
    expect(notes[1]?.params).toEqual({ key: 60, channel: 0, instance: 'plugin:kick' })
    expect(notes[2]?.params).toEqual({ key: 61, channel: 0, velocity: 0.8 })
    expect(notes[2]?.params).not.toHaveProperty('instance')
  })

  it('SetSourceRouting は source/unit/target を daemon の wire 形どおり送る', async () => {
    const url = await server.start({
      SetSourceRouting: () => ({ status: 'routed' }),
    })
    await client.start({ wsUrlOverride: url })
    await client.setSourceRouting('plugin:kick', 0, 'seq-bus-0')
    await client.setSourceRouting('plugin:kick', 0, null)
    const routings = server.received.filter((r) => r.method === 'SetSourceRouting')
    expect(routings).toHaveLength(2)
    expect(routings[0]?.params).toEqual({
      source: 'plugin:kick',
      unit: 0,
      target: 'seq-bus-0',
    })
    expect(routings[1]?.params).toEqual({ source: 'plugin:kick', unit: 0, target: null })
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

  it('PluginAllNotesOff は空 params を送り released/stale/failed を返す', async () => {
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValue({ released: 3, stale: 2, failed: 1 })

    await expect(client.pluginAllNotesOff()).resolves.toEqual({ released: 3, stale: 2, failed: 1 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('PluginAllNotesOff', {})
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
  //
  // 🔴 #520: 実行ファイルは beforeAll で 1 回だけ作る（詳細は tests/helpers/spawn-fixture.ts）。
  let client: DaemonClient
  let tmpDir: string
  let badShebangBin: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-error-'))
    // exec bit はあるが shebang の interpreter が存在しないファイル。
    // execve が非同期の spawn 'error' (ENOENT) を発火する（Node の async-'error'
    // whitelist 内）。非実行ファイル (0o644) は resolveDaemonBinaryPath の
    // viability filter（isExecutableFile）で候補から外れてこの経路に到達しない
    // ため使えない。root 実行環境でもパーミッション bit に依存せず成立する。
    badShebangBin = await createWarmExecutable(
      tmpDir,
      'orbit-audio-daemon',
      `#!${path.join(tmpDir, 'no-such-interpreter')}\necho unreachable\n`,
    )
  }, SPAWN_TEST_TIMEOUT_MS)

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    client = new DaemonClient()
  })

  afterEach(async () => {
    await client.quit()
  })

  it(
    'spawn が \'error\' event で失敗するバイナリは "daemon spawn failed" で reject する',
    async () => {
      // exit/timeout 経路との判別のため文言まで固定して assert する。
      await expect(client.start({ daemonPath: badShebangBin })).rejects.toThrow(
        /daemon spawn failed/,
      )
      expect(client.isRunning()).toBe(false)
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})

describe('DaemonClient audioDevice spawn args (#484 D1)', () => {
  // 実 daemon バイナリの代わりに argv をファイルへ書き出すだけの shell script を spawn し、
  // `--audio-device <name>` が実際に子プロセスへ渡ることを検証する（daemon 側の解決・縮退
  // ロジック自体は Rust unit test で検証済み・ここは TS→spawn args の配線のみが対象）。
  //
  // 🔴 #520: 検証対象は「argv に何が渡るか」だけで、子プロセスが何 ms で起動・exit するかは
  // 検証対象ではない。以前は `startupTimeoutMs: 500` を明示していたため高負荷時に timeout が
  // exit を追い越して assert が落ちていた。いまは明示せず production の
  // DEFAULT_STARTUP_TIMEOUT_MS に委ねる。**ここに小さい startupTimeoutMs を書き足すと戻る。**
  //
  // 🔴 recorder script は `beforeAll` で 1 回だけ作って warm up する。per-test で作ると
  // macOS のセキュリティ評価を毎回払う（詳細は tests/helpers/spawn-fixture.ts）。
  let client: DaemonClient
  let tmpDir: string
  let recorderBin: string
  let argvFile: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-audio-device-'))
    argvFile = path.join(tmpDir, 'argv.txt')
    recorderBin = await createWarmExecutable(
      tmpDir,
      'orbit-audio-daemon',
      `#!/bin/sh
printf '%s\n' "$@" > "${argvFile}"
exit 1
`,
    )
  }, SPAWN_TEST_TIMEOUT_MS)

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    client = new DaemonClient()
    // warm up の空 spawn が書いた argv を持ち越さない。各 it は自分の spawn の結果だけを見る。
    fs.rmSync(argvFile, { force: true })
  })

  afterEach(async () => {
    await client.quit()
  })

  it(
    'audioDevice 指定時は --audio-device <name> を argv に渡す',
    async () => {
      await expect(
        client.start({ daemonPath: recorderBin, audioDevice: 'USB Audio' }),
      ).rejects.toThrow(/daemon exited before ready/)
      await vi.waitFor(() => expect(fs.existsSync(argvFile)).toBe(true))
      const argv = fs.readFileSync(argvFile, 'utf-8').trim().split('\n')
      expect(argv).toEqual(['--audio-device', 'USB Audio'])
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    'audioDevice 未指定時は追加 argv を渡さない',
    async () => {
      await expect(client.start({ daemonPath: recorderBin })).rejects.toThrow(
        /daemon exited before ready/,
      )
      await vi.waitFor(() => expect(fs.existsSync(argvFile)).toBe(true))
      const argv = fs.readFileSync(argvFile, 'utf-8')
      expect(argv.trim()).toBe('')
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  it(
    '自然終了した child の後始末は SIGKILL 昇格を報告しない (#520)',
    async () => {
      // start 失敗時の cleanup は killChildGracefully を通る。recorder script は自力で
      // exit 1 するので、自然終了を検知せず SIGTERM を送る実装だと 'exit' が再発火せず
      // deadline 満了まで待たされ、偽の昇格診断が出る。
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(client.start({ daemonPath: recorderBin })).rejects.toThrow(
          /daemon exited before ready/,
        )
        // 🔴 assert は必ず mockRestore() より前に置く。mockRestore() は mock.calls も
        // 消すため、復元後に読むとガードを外す変異が生き残る（実際に一度生き残った）。
        expect(warn.mock.calls.some((c) => String(c[0]).includes('escalated to SIGKILL'))).toBe(
          false,
        )
      } finally {
        warn.mockRestore()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
})

describe('DaemonClient killChildGracefully の両方向 (#520)', () => {
  // 上の #484 D1 ブロックは「実際の start 失敗 cleanup がガードに到達すること」を
  // 配線として押さえるが、**ガードが広すぎても同じ観測になる**（早期リターンしすぎても
  // 「警告が出ない」は成立する）。ここでガード本体の 2 方向を決定論的に固定する。
  //
  // 判定は「警告が出た / 出ない」ではなく **kill シーケンスの順序**で行う。
  // fake は #532（extension.ts stopEngine）で実証済みのパターンを踏襲し、
  // 「kill() は killed を即 true にするが exitCode/signalCode は動かさない」という
  // Node の実挙動を再現する。
  const KILL_DEADLINE_MS = 500 // daemon-client.ts の DEFAULT_KILL_TIMEOUT_MS（非公開）

  function fakeChild(initial: { exitCode?: number | null; signalCode?: string | null }): {
    child: ChildProcess
    killCalls: string[]
    fireExit: () => void
  } {
    const killCalls: string[] = []
    const state = {
      killed: false,
      exitCode: initial.exitCode ?? null,
      signalCode: initial.signalCode ?? null,
    }
    // 'exit' ハンドラは**記録する**。no-op mock にすると「SIGTERM で素直に終了する」
    // 経路（deadline 前に onExit が走り clearTimeout + resolve する）が一度も走らず、
    // `child.once('exit', onExit)` を削る変異が生き残る（ラウンド2 の指摘）。
    let exitHandlers: Array<() => void> = []
    const child = {
      get killed() {
        return state.killed
      },
      get exitCode() {
        return state.exitCode
      },
      get signalCode() {
        return state.signalCode
      },
      kill: vi.fn((signal?: string) => {
        killCalls.push(String(signal))
        state.killed = true
        return true
      }),
      once: vi.fn((event: string, fn: () => void) => {
        if (event === 'exit') exitHandlers.push(fn)
        return child
      }),
      off: vi.fn((event: string, fn: () => void) => {
        if (event === 'exit') exitHandlers = exitHandlers.filter((h) => h !== fn)
        return child
      }),
    }
    return {
      child: child as unknown as ChildProcess,
      killCalls,
      // 実 child の 'exit' 相当。once の意味論に合わせて一度きり。
      fireExit: () => {
        const fired = exitHandlers
        exitHandlers = []
        for (const h of fired) h()
      },
    }
  }

  async function killChild(client: DaemonClient, child: ChildProcess): Promise<void> {
    await (
      client as unknown as { killChildGracefully(c: ChildProcess): Promise<void> }
    ).killChildGracefully(child)
  }

  it('生存している child は SIGTERM → SIGKILL の順に昇格し、昇格を報告する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const { child, killCalls } = fakeChild({ exitCode: null, signalCode: null })
      const pending = killChild(new DaemonClient(), child)
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS + 1)
      await pending
      // 順序まで固定する。SIGKILL だけ・SIGTERM だけ・逆順のいずれも red にする。
      expect(killCalls).toEqual(['SIGTERM', 'SIGKILL'])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('escalated to SIGKILL'))).toBe(true)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('SIGTERM で素直に終了する child は SIGKILL へ昇格しない', async () => {
    // deadline 前に 'exit' が来る経路。ここが壊れると、行儀のよい child まで毎回
    // 500ms 待たされた上で SIGKILL され、偽の昇格警告が出る。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const { child, killCalls, fireExit } = fakeChild({ exitCode: null, signalCode: null })
      const pending = killChild(new DaemonClient(), child)
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS / 2)
      fireExit()
      // deadline を跨いでも、clearTimeout が効いていれば SIGKILL は増えない。
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS)
      await pending
      expect(killCalls).toEqual(['SIGTERM'])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('escalated to SIGKILL'))).toBe(false)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('exitCode が立っている child にはシグナルを一切送らない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { child, killCalls } = fakeChild({ exitCode: 1 })
      await killChild(new DaemonClient(), child)
      expect(killCalls).toEqual([])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('escalated to SIGKILL'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('signalCode が立っている child にもシグナルを一切送らない', async () => {
    // exitCode 側だけを見るガードに縮めると、この 1 件だけが red になる
    // （シグナルで死んだ child は exitCode が null のまま）。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { child, killCalls } = fakeChild({ exitCode: null, signalCode: 'SIGTERM' })
      await killChild(new DaemonClient(), child)
      expect(killCalls).toEqual([])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('escalated to SIGKILL'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
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

  it('explicit path が executable file として解決される場合 source は explicit', () => {
    const explicitPath = path.join(tmpDir, 'orbit-audio-daemon')
    fs.writeFileSync(explicitPath, '', { mode: 0o755 })
    const resolution = resolveDaemonBinaryPath(explicitPath)
    expect(resolution).toEqual({ path: explicitPath, source: 'explicit' })
  })

  it('explicit 未指定・ORBIT_AUDIO_DAEMON_PATH 解決時は source は env', () => {
    const envPath = path.join(tmpDir, 'orbit-audio-daemon')
    fs.writeFileSync(envPath, '', { mode: 0o755 })
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

  it('実行権限のない候補は viability filter で選ばれない', () => {
    // exec bit の無いファイル（.vsix 展開でパーミッションが落ちた bundle を模す）は
    // 候補から外れる。後続候補（monorepo build）の有無は環境依存なので、
    // 「この path が選ばれない」ことだけを assert する（DaemonNotFoundError も可）。
    const nonExec = path.join(tmpDir, 'orbit-audio-daemon')
    fs.writeFileSync(nonExec, '', { mode: 0o644 })
    try {
      const resolution = resolveDaemonBinaryPath(nonExec)
      expect(resolution.path).not.toBe(nonExec)
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonNotFoundError)
    }
  })
})

// #605 の起動後 stderr 転送は全行を console.error に流していたため、daemon の INFO
// tracing まで拡張側で `ERROR:` として記録され、get_log の ERROR 前後比較（gated E2E・
// LLM の自己検証）を実際に壊した。level token で振り分ける分類の正本がこのテスト。
describe('createDaemonStderrLineRouter (#618 chunk 境界での行分割)', () => {
  const route = (chunks: string[]) => {
    const nonError: string[] = []
    const error: string[] = []
    const router = createDaemonStderrLineRouter(
      (line) => nonError.push(line),
      (line) => error.push(line),
    )
    for (const chunk of chunks) router(chunk)
    return { nonError, error }
  }

  // 🔴 実測（#618 の E2E をカタログ経路へ寄せた際）: 行がチャンク境界で割れると、
  // level トークンを持たない後半が独立した行として **ERROR に分類された**。
  it('🔴 チャンクを跨いだ行を1本に組み直す（後半が ERROR に落ちない）', () => {
    const { nonError, error } = route([
      'INFO [orbit-vst3-instrument-child] state restored from "/x/y.state" (',
      '8 bytes)\n',
    ])
    expect(nonError).toEqual([
      'INFO [orbit-vst3-instrument-child] state restored from "/x/y.state" (8 bytes)',
    ])
    expect(error).toEqual([])
  })

  it('改行が来るまで emit しない（未完の行を早出ししない）', () => {
    const { nonError, error } = route(['INFO [orbit-clap-instrument-child] partial'])
    expect(nonError).toEqual([])
    expect(error).toEqual([])
  })

  it('1チャンクに複数行が来ても全部さばく・level で振り分ける', () => {
    const { nonError, error } = route([
      'INFO [orbit-vst3-instrument-child] ok\n[orbit-vst3-instrument-child] boom\n',
    ])
    expect(nonError).toEqual(['INFO [orbit-vst3-instrument-child] ok'])
    expect(error).toEqual(['[orbit-vst3-instrument-child] boom'])
  })
})

describe('rack child の PID 通知が ERROR に分類されない (#628 §6)', () => {
  // 🔴 実機 E2E の PID オラクルはこの行を `get_log` から読む（rack child は
  // `--chain <manifest>` 起動なので `pgrep -f <pluginPath>` では捕まらない）。
  // この行が ERROR へ倒れると、**同じ E2E が見ている「ERROR 増 0」を自分で落とす**。
  // stderr の既定は fail-loud で ERROR なので、通ることを明示的に固定する。
  it('daemon の tracing::info! 形式（ISO timestamp + level）が非エラーとして受理される', () => {
    expect(
      isDaemonNonErrorTracingLine(
        '2026-08-28T02:31:44.123456Z  INFO orbit_audio_daemon::outproc_effect: ' +
          '[orbit-effect-rack] child spawned pid=48732 shm=/tmp/orbit-shm-0',
      ),
    ).toBe(true)
  })

  it('level を名乗らない同内容の行は従来どおり ERROR 側へ倒れる（fail-loud の既定を弱めない）', () => {
    expect(isDaemonNonErrorTracingLine('[orbit-effect-rack] child spawned pid=48732')).toBe(false)
  })
})

describe('isDaemonNonErrorTracingLine (#605 stderr 転送の level 振り分け)', () => {
  // #618 E2E 実測: child は daemon の stderr を継承し tracing を持たないため、level を
  // 名乗らない成功行が **ERROR として記録される**（`state restored from ...` が該当し、
  // state 付きの宣言・respawn・差し替えのたびに ERROR カウントを汚していた）。
  it('🔴 child が名乗った INFO は非エラー・名乗らない行と ERROR/WARN は従来どおりエラー', () => {
    expect(
      isDaemonNonErrorTracingLine(
        'INFO [orbit-vst3-instrument-child] state restored from "/x/y.state" (8 bytes)',
      ),
    ).toBe(true)
    expect(isDaemonNonErrorTracingLine('DEBUG [orbit-clap-instrument-child] hello')).toBe(true)
    expect(
      isDaemonNonErrorTracingLine('[orbit-vst3-instrument-child] plugin.process() failed'),
    ).toBe(false)
    expect(
      isDaemonNonErrorTracingLine('ERROR [orbit-vst3-instrument-child] state restore failed'),
    ).toBe(false)
    expect(isDaemonNonErrorTracingLine('INFO something else entirely')).toBe(false)
  })

  // 🔴 #628 実機ゲート実測 + owner 判断（2026-08-28）で **`WARN` は非エラー側へ移した**。
  // 以前この describe は `WARN ... toBe(false)` を assert していた。意味論が変わったので
  // 期待値を更新している（テストを緩めたのではなく、**決定が変わった**）。
  //
  // 発端: rack child に tracing subscriber を入れた副作用で `orbit-clap-host` の中継が
  // un-silence され、**プラグイン自身の正常動作の警告**が `ERROR:` として記録された。
  // 実機ゲートで**既存テストを含む 7 件**が「ERROR 行が増えた」で落ちた（15 → 17）。
  //
  // 行そのものは `get_log` に残る — `console.error` ではなく `console.log` へ回るだけ。
  it('🔴 WARN は非エラー（警告はエラーではない。行は get_log に残る）', () => {
    // 実機で実際に踏んだ行をそのままアンカーにする（手で整えた文言を使わない）。
    expect(
      isDaemonNonErrorTracingLine(
        '2026-08-28T12:19:01.534614Z  WARN orbit_clap_host::controller: ' +
          '[orbit-clap-host] NotePortsExtension なし; port 0 を使用',
      ),
    ).toBe(true)
    expect(isDaemonNonErrorTracingLine('WARN [orbit-vst3-instrument-child] degraded')).toBe(true)
    // ERROR は従来どおりエラー側。WARN を通したことで ERROR まで緩めていないことを固定する。
    expect(
      isDaemonNonErrorTracingLine(
        '2026-08-28T12:19:01.534614Z ERROR orbit_clap_host::controller: [orbit-clap-host] boom',
      ),
    ).toBe(false)
    // level を名乗らない行は従来どおりエラー側（fail-loud）。
    expect(isDaemonNonErrorTracingLine('WARN something else entirely')).toBe(false)
  })

  // #625 実機 E2E 実測: VST3/CLAP の host crate は **child プロセスの中にリンクされて動く**
  // ので、行の出所は child でもタグは `[orbit-vst3-host]` を名乗る。判定を `-child` 終端に
  // 限っていたため、host が `INFO ` を名乗っても ERROR へ倒れ、**state 復元のたびに正常動作が
  // ERROR として記録されていた**（R-E4 がこれで落ちた）。
  it('🔴 host crate のタグ（-child で終わらない）でも level を名乗れば非エラー', () => {
    expect(
      isDaemonNonErrorTracingLine(
        'INFO [orbit-vst3-host] setComponentState after state restore returned 0x3 ' +
          '(best-effort; audio state is already applied)',
      ),
    ).toBe(true)
    expect(
      isDaemonNonErrorTracingLine(
        'INFO [orbit-vst3-effect-child] --plugin-id=X は Phase 1 VST3 effect では未使用',
      ),
    ).toBe(true)
    // 🔴 タグを広げても「level を名乗らない行」「ERROR を名乗る行」は従来どおり
    // エラー側に倒れること（緩めすぎて本物のエラーを飲み込んでいないことの確認）。
    expect(
      isDaemonNonErrorTracingLine('[orbit-vst3-host] IComponent::setState rejected the state'),
    ).toBe(false)
    expect(isDaemonNonErrorTracingLine('ERROR [orbit-vst3-host] boom')).toBe(false)
    // `WARN` は #628 で非エラー側へ移した（owner 判断・2026-08-28）。この行の期待値だけが
    // 変わっており、その上下（level 無し / ERROR）は不変であることを並べて固定する。
    expect(isDaemonNonErrorTracingLine('WARN [orbit-vst3-host] degraded')).toBe(true)
    // 自分のコンポーネントのタグでない行は、level を名乗っていても認めない。
    expect(isDaemonNonErrorTracingLine('INFO [some-plugin-vendor] chatter')).toBe(false)
  })

  // 実機の daemon が出す ANSI 色付き tracing 行（gated E2E の実測から採取）。
  const ansiInfoLine =
    '\x1b[2m2026-08-25T17:30:47.243628Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
    '\x1b[2morbit_audio_daemon\x1b[0m\x1b[2m:\x1b[0m orbit-audio-daemon listening on 127.0.0.1:61554'

  it('INFO/DEBUG/TRACE の tracing 行は non-error（ANSI 色コード付きの実機形式を含む）', () => {
    expect(isDaemonNonErrorTracingLine(ansiInfoLine)).toBe(true)
    expect(
      isDaemonNonErrorTracingLine('2026-08-25T17:30:47Z DEBUG orbit_audio_daemon: detail'),
    ).toBe(true)
    expect(
      isDaemonNonErrorTracingLine('2026-08-25T17:30:47Z TRACE orbit_audio_daemon: detail'),
    ).toBe(true)
  })

  it('ERROR の tracing 行はエラー側に残る（WARN は #628 で非エラーへ）', () => {
    expect(isDaemonNonErrorTracingLine('2026-08-25T17:30:47Z ERROR orbit_audio_daemon: boom')).toBe(
      false,
    )
    // 🔴 ANSI 色付きの WARN も非エラーとして扱う（色コードを剥がしてから level を読む）。
    // この行は以前 `false` を期待していた。#628 の実機ゲートで、プラグイン自身の正常動作の
    // 警告が ERROR 件数を汚し**既存テストを含む 7 件**を落としたため、owner 判断で移した。
    expect(
      isDaemonNonErrorTracingLine(
        '\x1b[2m2026-08-25T17:30:47Z\x1b[0m \x1b[33m WARN\x1b[0m outproc attach failed (retryable): x',
      ),
    ).toBe(true)
  })

  it('level token を読み取れない行（panic・生 print）は fail-loud にエラー側へ倒す', () => {
    expect(isDaemonNonErrorTracingLine("thread 'main' panicked at src/main.rs:1:1:")).toBe(false)
    expect(isDaemonNonErrorTracingLine('some bare diagnostic output')).toBe(false)
    // 本文中に INFO が現れるだけの行を level token と誤認しない（token は行頭の
    // ISO timestamp 直後のみ）。緩めると本物のエラーが log から消える側に倒れる。
    expect(isDaemonNonErrorTracingLine('plugin said: INFO is my name')).toBe(false)
    expect(isDaemonNonErrorTracingLine('loaded INFO panel for plugin')).toBe(false)
  })
})
