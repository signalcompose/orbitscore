import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import { RustEnginePlayer } from '../../../packages/engine/src/audio/rust-engine/rust-engine-player'
import { Global } from '../../../packages/engine/src/core/global'
import { Sequence } from '../../../packages/engine/src/core/sequence'

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

describe('plugin UI safepoint conductor', () => {
  let daemon: DaemonClient
  let player: RustEnginePlayer | null
  let directory: string
  let saveState: ReturnType<typeof vi.spyOn>
  let ack: ReturnType<typeof vi.spyOn>
  let quitDaemon: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-ui-safepoint-'))
    daemon = new DaemonClient()
    vi.spyOn(daemon, 'loadPlugin').mockResolvedValue({
      pluginId: 'mock-plugin',
      pluginName: 'Mock Plugin',
      notePortIndex: 0,
    })
    saveState = vi.spyOn(daemon, 'savePluginState')
    ack = vi.spyOn(daemon, 'ackUiSafepoint').mockResolvedValue()
    quitDaemon = vi.spyOn(daemon, 'quit').mockResolvedValue()
    player = new RustEnginePlayer({ daemonClient: daemon })
  })

  afterEach(async () => {
    if (player) await player.quit()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function declaredInstrument(): Promise<Global> {
    const global = new Global(player!)
    global.setDocumentDirectory(directory)
    const pluginPath = path.join(directory, 'Mock.clap')
    fs.mkdirSync(pluginPath)
    await global.instrument('lead', pluginPath)
    // #601 I1: 保存対象の identity は open 時に確定する。close イベントを流すテストは
    // 実機と同じく、先に UI を開いてセッションを確立しておく（open の解決には
    // 登録済み sequence が要る）。
    new Sequence(global, player!).setName('lead')
    vi.spyOn(daemon, 'openPluginUi').mockResolvedValue()
    await global.openPluginUi('lead', 0)
    return global
  }

  it('dispatches all three daemon event frame names and sends AckUiSafepoint wire fields unchanged', async () => {
    const framing = new DaemonClient()
    const closed = vi.fn()
    const done = vi.fn()
    const respawn = vi.fn()
    framing.on('plugin-ui-closed', closed)
    framing.on('plugin-ui-close-done', done)
    framing.on('plugin-ui-closed-by-respawn', respawn)
    const handleMessage = (framing as any).handleMessage.bind(framing) as (raw: string) => void
    handleMessage(JSON.stringify({ type: 'event', event: 'PluginUiClosed', data: { marker: 1 } }))
    handleMessage(
      JSON.stringify({ type: 'event', event: 'PluginUiCloseDone', data: { marker: 2 } }),
    )
    handleMessage(
      JSON.stringify({ type: 'event', event: 'PluginUiClosedByRespawn', data: { marker: 3 } }),
    )
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith({ marker: 1 })
    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith({ marker: 2 })
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith({ marker: 3 })

    const request = vi.spyOn(framing as any, 'request').mockResolvedValue({ status: 'acked' })
    await framing.ackUiSafepoint({ role: 'instrument', instance: 'plugin:lead' }, 0, 37, 41)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('AckUiSafepoint', {
      target: { role: 'instrument', instance: 'plugin:lead' },
      index: 0,
      generation: 37,
      evt_seq: 41,
    })
  })

  it('forwards OPEN_UI and CLOSE_UI daemon requests exactly once with exact wire arguments', async () => {
    const request = vi.spyOn(daemon as any, 'request').mockResolvedValue({ status: 'ok' })
    const target = { role: 'instrument' as const, instance: 'plugin:lead' }

    await daemon.openPluginUi(target, 0, 'OrbitScore — Massive-X (lead:0)')
    await daemon.acceptClosePluginUi(target, 0)

    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(1, 'OpenPluginUI', {
      target,
      index: 0,
      windowTitle: 'OrbitScore — Massive-X (lead:0)',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'ClosePluginUI', { target, index: 0 })
  })

  it('times out a heavyweight OPEN_UI instead of waiting forever for attach completion', async () => {
    const open = vi.spyOn(daemon, 'openPluginUi').mockImplementation(() => new Promise(() => {}))

    await expect(
      player!.openPluginUi(
        { role: 'instrument', instance: 'plugin:lead' },
        0,
        'OrbitScore — Massive-X (lead:0)',
        20,
      ),
    ).rejects.toThrow('timed out waiting for plugin UI to open')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      0,
      'OrbitScore — Massive-X (lead:0)',
    )
  })

  it('does not complete close on the command ack and resolves only for matching UI_CLOSED_DONE', async () => {
    const accept = vi.spyOn(daemon, 'acceptClosePluginUi').mockResolvedValue()
    const target = { role: 'instrument' as const, instance: 'plugin:lead' }
    let settled = false

    const closing = player!.closePluginUi(target, 0, 250).then((completion) => {
      settled = true
      return completion
    })
    await waitFor(() => accept.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(settled).toBe(false)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith(target, 0)

    daemon.emit('plugin-ui-close-done', {
      target: { role: 'instrument', instance: 'plugin:other', index: 0 },
      completion: 'safepoint-completed',
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(settled).toBe(false)

    daemon.emit('plugin-ui-close-done', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
      completion: 'safepoint-completed',
    })

    await expect(closing).resolves.toBe('safepoint-completed')
    expect(settled).toBe(true)
  })

  it('registers the DONE waiter before CLOSE_UI so an event racing the ack is not lost', async () => {
    const target = { role: 'instrument' as const, instance: 'plugin:lead' }
    const accept = vi.spyOn(daemon, 'acceptClosePluginUi').mockImplementation(async () => {
      daemon.emit('plugin-ui-close-done', {
        target: { ...target, index: 0 },
        completion: 'safepoint-completed',
      })
    })

    await expect(player!.closePluginUi(target, 0, 100)).resolves.toBe('safepoint-completed')
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith(target, 0)
  })

  it('times out loudly when CLOSE_UI is acked but UI_CLOSED_DONE never arrives', async () => {
    vi.spyOn(daemon, 'acceptClosePluginUi').mockResolvedValue()

    await expect(
      player!.closePluginUi({ role: 'effect', bus: 'seq-bus-0' }, 1, 20),
    ).rejects.toThrow('timed out waiting for UI_CLOSED_DONE')
  })

  it('saves through ProjectStateStore before acking the identical generation and evt_seq once', async () => {
    await declaredInstrument()
    saveState.mockImplementation(async (_target, statePath) => {
      fs.writeFileSync(statePath, 'plugin-state')
      return { path: statePath, bytesWritten: 12 }
    })

    daemon.emit('plugin-ui-closed', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
      generation: 37,
      evt_seq: 41,
    })
    await waitFor(() => ack.mock.calls.length >= 1)

    expect(saveState).toHaveBeenCalledTimes(1)
    expect(saveState).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      expect.stringMatching(/\/states\/.+\.state$/),
    )
    expect(ack).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith({ role: 'instrument', instance: 'plugin:lead' }, 0, 37, 41)
    expect(saveState.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0])
    const manifest = parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')) as {
      states: Record<string, string>
    }
    expect(manifest.states).toHaveProperty('lead/instrument/Mock/0')
  })

  it('does not ack when the existing project-state save fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await declaredInstrument()
    saveState.mockRejectedValue(new Error('state serialization failed'))

    daemon.emit('plugin-ui-closed', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
      generation: 2,
      evt_seq: 3,
    })
    await waitFor(() =>
      error.mock.calls.some(([message]) => String(message).includes('save failed')),
    )

    expect(saveState).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledTimes(0)
    expect(fs.existsSync(path.join(directory, 'project.yaml'))).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('AckUiSafepoint was not sent'))
  })

  it('reports timeout-without-save loudly exactly once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    daemon.emit('plugin-ui-close-done', {
      target: { role: 'effect', bus: 'seq-bus-2', index: 1 },
      completion: 'timeout-without-save',
    })
    await waitFor(() => error.mock.calls.length === 1)

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('closed after timing out without saving state'),
    )
  })

  it('🔴 R2: respawn closure notifies the registered listener with the target', async () => {
    // Global はこのリスナでセッション簿記を破棄する。呼ばれないと `hasOpenPluginUi` が
    // stale なまま「もう開いている」と誤認し、DSL の ui() が永久に no-op になる。
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const listener = vi.fn()
    player.setPluginUiClosedByRespawnListener(listener)

    daemon.emit('plugin-ui-closed-by-respawn', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
    })
    await waitFor(() => listener.mock.calls.length === 1)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ role: 'instrument', instance: 'plugin:lead', index: 0 })
    error.mockRestore()
  })

  it('reports respawn closure loudly without issuing save, ack, or another daemon request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const request = vi.spyOn(daemon as any, 'request')

    daemon.emit('plugin-ui-closed-by-respawn', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
    })
    await waitFor(() => error.mock.calls.length === 1)

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('was not reopened'))
    expect(saveState).toHaveBeenCalledTimes(0)
    expect(ack).toHaveBeenCalledTimes(0)
    expect(request).toHaveBeenCalledTimes(0)
  })

  /// respawn が close 待ちを中断したとき、呼び出し元は**失敗を受け取らねばならない**。
  ///
  /// child がクラッシュして再起動された時点で、その UI のセーフポイントは**実行されていない**
  /// （直前のテストが「保存も ack もしない」ことを固定している）。ここで成功として resolve すると、
  /// **音色が一切保存されていないのに呼び出し元は「保存完了」を受け取る** —— この PR が
  /// 塞ごうとしているサイレント障害そのものになる。
  ///
  /// main の変異検証で発見: `pending.reject(...)` を `pending.resolve('safepoint-completed')` に
  /// 差し替えても全テストが green のままだった。既存の respawn テストはイベントハンドラ側
  /// （保存・ack・再オープンをしないこと）しか見ておらず、**待っている呼び出し元**が無検証だった。
  it('rejects a pending close when a respawn takes the window first', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const accept = vi.spyOn(daemon, 'acceptClosePluginUi').mockResolvedValue()
    const target = { role: 'instrument' as const, instance: 'plugin:lead' }

    const closing = player!.closePluginUi(target, 0, 250)
    await waitFor(() => accept.mock.calls.length === 1)

    daemon.emit('plugin-ui-closed-by-respawn', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
    })

    await expect(closing).rejects.toThrow(/respawn before UI_CLOSED_DONE/)
    // 保存は一度も走っていない。成功を返してはならない理由がこれ。
    expect(saveState).toHaveBeenCalledTimes(0)
    expect(ack).toHaveBeenCalledTimes(0)
  })

  it('waits for an in-flight save and ack before daemon teardown', async () => {
    let finishSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    await declaredInstrument()
    saveState.mockImplementation(async (_target, statePath) => {
      await saveGate
      fs.writeFileSync(statePath, 'plugin-state')
      return { path: statePath, bytesWritten: 12 }
    })
    daemon.emit('plugin-ui-closed', {
      target: { role: 'instrument', instance: 'plugin:lead', index: 0 },
      generation: 7,
      evt_seq: 8,
    })
    await waitFor(() => saveState.mock.calls.length === 1)

    let quitSettled = false
    const quitting = player!.quit().then(() => {
      quitSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quitSettled).toBe(false)
    expect(ack).toHaveBeenCalledTimes(0)
    expect(quitDaemon).toHaveBeenCalledTimes(0)

    finishSave!()
    await quitting
    player = null
    expect(ack).toHaveBeenCalledTimes(1)
    expect(quitDaemon).toHaveBeenCalledTimes(1)
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(quitDaemon.mock.invocationCallOrder[0])
  })
})
