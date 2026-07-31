import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReplSession, extractPluginUiMeta } from '../../packages/engine/src/cli/repl-mode'

afterEach(() => vi.restoreAllMocks())

describe('//#pluginUi REPL meta', () => {
  it('parses the guarded open schema exactly and rejects malformed indices', () => {
    expect(
      extractPluginUiMeta(
        '//#pluginUi {"requestId":"open-1","action":"open","receiver":"sum:drum","index":1,"expectedName":"Glue Comp"}',
      ),
    ).toEqual({
      requestId: 'open-1',
      action: 'open',
      receiver: 'sum:drum',
      index: 1,
      expectedName: 'Glue Comp',
    })
    expect(() =>
      extractPluginUiMeta(
        '//#pluginUi {"requestId":"bad","action":"close","receiver":"lead","index":-1}',
      ),
    ).toThrow('non-negative integer index')
  })

  it('routes open and close once with exact arguments, in FIFO order, without evaluating DSL', async () => {
    const openPluginUi = vi.fn().mockResolvedValue({ normalizedName: 'Massive-X' })
    const closePluginUi = vi.fn().mockResolvedValue({ completion: 'safepoint-completed' })
    const execute = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const session = createReplSession({ openPluginUi, closePluginUi, execute } as any)

    session.pushLine(
      '//#pluginUi {"requestId":"open-1","action":"open","receiver":"lead","index":0,"expectedName":"Massive-X"}',
    )
    session.pushLine(
      '//#pluginUi {"requestId":"close-1","action":"close","receiver":"lead","index":0}',
    )
    await session.idle()

    expect(openPluginUi).toHaveBeenCalledTimes(1)
    expect(openPluginUi).toHaveBeenCalledWith('lead', 0, 'Massive-X')
    expect(closePluginUi).toHaveBeenCalledTimes(1)
    expect(closePluginUi).toHaveBeenCalledWith('lead', 0)
    expect(openPluginUi.mock.invocationCallOrder[0]).toBeLessThan(
      closePluginUi.mock.invocationCallOrder[0],
    )
    expect(execute).toHaveBeenCalledTimes(0)
    expect(log).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({
      pluginUi: {
        requestId: 'close-1',
        action: 'close',
        ok: true,
        result: { completion: 'safepoint-completed' },
      },
    })
  })

  it('returns a correlated loud error with protocol details', async () => {
    const failure = Object.assign(
      new Error('CAP-UI-OPEN unavailable. Valid indices: 1 (effect, Echo).'),
      {
        code: 'PLUGIN_UI_UNAVAILABLE',
        details: { capability: 'CAP-UI-OPEN' },
      },
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const session = createReplSession({
      openPluginUi: vi.fn().mockRejectedValue(failure),
      closePluginUi: vi.fn(),
      execute: vi.fn(),
    } as any)

    session.pushLine(
      '//#pluginUi {"requestId":"open-error","action":"open","receiver":"lead","index":1}',
    )
    await session.idle()

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      pluginUi: {
        requestId: 'open-error',
        action: 'open',
        ok: false,
        error: 'CAP-UI-OPEN unavailable. Valid indices: 1 (effect, Echo).',
        code: 'PLUGIN_UI_UNAVAILABLE',
        details: { capability: 'CAP-UI-OPEN' },
      },
    })
  })

  // #601 I6: pushLine 経由で handleLine の catch 分岐そのものを通す
  // （extractPluginUiMeta の直接呼び出しでは requestId 復元 → 応答経路の選択が無検証だった）。

  it('answers a malformed meta line on stdout when the requestId is recoverable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const openPluginUi = vi.fn()
    const session = createReplSession({
      openPluginUi,
      closePluginUi: vi.fn(),
      execute: vi.fn(),
    } as any)

    // action が不正 → extractPluginUiMeta が throw → catch → requestId は本文から復元できる
    session.pushLine(
      '//#pluginUi {"requestId":"bad-action-1","action":"toggle","receiver":"lead","index":0}',
    )
    await session.idle()

    expect(openPluginUi).toHaveBeenCalledTimes(0)
    expect(error).toHaveBeenCalledTimes(0)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      pluginUi: {
        requestId: 'bad-action-1',
        ok: false,
        error: "//#pluginUi action must be 'open' or 'close'",
      },
    })
  })

  it('falls back to a loud [ERROR] line when no requestId can be recovered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const session = createReplSession({
      openPluginUi: vi.fn(),
      closePluginUi: vi.fn(),
      execute: vi.fn(),
    } as any)

    // JSON が壊れていて requestId も取り出せない → 相関応答は不可能 → stderr へ loud に
    session.pushLine('//#pluginUi {broken json')
    await session.idle()

    expect(log).toHaveBeenCalledTimes(0)
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[ERROR\] invalid \/\/#pluginUi JSON:/)
  })
})
