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

  it('GetPluginState sends the resolved effect target and preserves the byte result', async () => {
    const url = await server.start({
      GetPluginState: () => ({
        path: '/songs/states/master.state',
        bytes_written: 123,
      }),
    })
    await client.start({ wsUrlOverride: url })

    await expect(
      client.savePluginState({ role: 'effect', bus: 'seq-bus-2' }, '/songs/states/master.state'),
    ).resolves.toEqual({
      path: '/songs/states/master.state',
      bytesWritten: 123,
    })
    expect(server.received.find((record) => record.method === 'GetPluginState')?.params).toEqual({
      path: '/songs/states/master.state',
      role: 'effect',
      bus: 'seq-bus-2',
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
  let badShebangBin: string

  beforeEach(() => {
    client = new DaemonClient()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-error-'))
    badShebangBin = path.join(tmpDir, 'orbit-audio-daemon')
    // exec bit はあるが shebang の interpreter が存在しないファイル。
    // execve が非同期の spawn 'error' (ENOENT) を発火する（Node の async-'error'
    // whitelist 内）。非実行ファイル (0o644) は resolveDaemonBinaryPath の
    // viability filter（isExecutableFile）で候補から外れてこの経路に到達しない
    // ため使えない。root 実行環境でもパーミッション bit に依存せず成立する。
    fs.writeFileSync(
      badShebangBin,
      `#!${path.join(tmpDir, 'no-such-interpreter')}\necho unreachable\n`,
      { mode: 0o755 },
    )
  })

  afterEach(async () => {
    await client.quit()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('spawn が \'error\' event で失敗するバイナリは "daemon spawn failed" で reject する', async () => {
    // exit/timeout 経路との判別のため文言まで固定して assert する。
    await expect(client.start({ daemonPath: badShebangBin })).rejects.toThrow(/daemon spawn failed/)
    expect(client.isRunning()).toBe(false)
  })
})

describe('DaemonClient audioDevice spawn args (#484 D1)', () => {
  // 実 daemon バイナリの代わりに argv をファイルへ書き出すだけの shell script を spawn し、
  // `--audio-device <name>` が実際に子プロセスへ渡ることを検証する（daemon 側の解決・縮退
  // ロジック自体は Rust unit test で検証済み・ここは TS→spawn args の配線のみが対象）。
  let client: DaemonClient
  let tmpDir: string
  let recorderBin: string
  let argvFile: string

  beforeEach(() => {
    client = new DaemonClient()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-audio-device-'))
    recorderBin = path.join(tmpDir, 'orbit-audio-daemon')
    argvFile = path.join(tmpDir, 'argv.txt')
    fs.writeFileSync(
      recorderBin,
      `#!/bin/sh
printf '%s\n' "$@" > "${argvFile}"
exit 1
`,
      { mode: 0o755 },
    )
  })

  afterEach(async () => {
    await client.quit()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('audioDevice 指定時は --audio-device <name> を argv に渡す', async () => {
    await expect(
      client.start({ daemonPath: recorderBin, audioDevice: 'USB Audio', startupTimeoutMs: 500 }),
    ).rejects.toThrow()
    const argv = fs.readFileSync(argvFile, 'utf-8').trim().split('\n')
    expect(argv).toEqual(['--audio-device', 'USB Audio'])
  })

  it('audioDevice 未指定時は追加 argv を渡さない', async () => {
    await expect(client.start({ daemonPath: recorderBin, startupTimeoutMs: 500 })).rejects.toThrow()
    const argv = fs.readFileSync(argvFile, 'utf-8')
    expect(argv.trim()).toBe('')
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
