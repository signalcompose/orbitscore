import { describe, expect, it, vi } from 'vitest'

import {
  PluginUiBridge,
  parsePluginUiResultLine,
} from '../../packages/vscode-extension/src/plugin-ui-bridge'

describe('PluginUiBridge', () => {
  it('writes one exact correlated open meta line and resolves its result', async () => {
    const bridge = new PluginUiBridge()
    const write = vi.fn().mockReturnValue(true)
    const input = {
      requestId: 'ui-1',
      action: 'open' as const,
      receiver: 'sum:drum',
      index: 1,
      expectedName: 'GlueComp',
    }

    const pending = bridge.send(write, input, 100)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toBe(`//#pluginUi ${JSON.stringify(input)}\n`)
    expect(typeof write.mock.calls[0]![1]).toBe('function')

    expect(
      bridge.handleLine(
        JSON.stringify({
          pluginUi: {
            requestId: 'ui-1',
            action: 'open',
            ok: true,
            result: { normalizedName: 'GlueComp' },
          },
        }),
      ),
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      requestId: 'ui-1',
      action: 'open',
      ok: true,
      result: { normalizedName: 'GlueComp' },
    })
    expect(bridge.pendingCount).toBe(0)
  })

  it('does not let a close request consume an open response with the same request id', async () => {
    const bridge = new PluginUiBridge()
    const pending = bridge.send(
      () => true,
      { requestId: 'ui-2', action: 'close', receiver: 'lead', index: 0 },
      100,
    )

    bridge.handleLine(
      JSON.stringify({
        pluginUi: { requestId: 'ui-2', action: 'open', ok: true, result: {} },
      }),
    )

    await expect(pending).resolves.toEqual({
      requestId: 'ui-2',
      action: 'close',
      ok: false,
      error: "engine returned plugin UI action 'open' for pending 'close' request",
    })
  })

  it('times out, drains, and preserves loud engine error details', async () => {
    const timedOut = new PluginUiBridge().send(
      () => true,
      { requestId: 'timeout', action: 'close', receiver: 'lead', index: 0 },
      5,
    )
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out waiting for engine response'),
    })

    expect(
      parsePluginUiResultLine(
        '{"pluginUi":{"requestId":"err","action":"open","ok":false,"error":"CAP-UI-OPEN unavailable","code":"PLUGIN_UI_UNAVAILABLE","details":{"valid":"0 (instrument, Massive-X)"}}}',
      ),
    ).toEqual({
      requestId: 'err',
      action: 'open',
      ok: false,
      error: 'CAP-UI-OPEN unavailable',
      code: 'PLUGIN_UI_UNAVAILABLE',
      details: { valid: '0 (instrument, Massive-X)' },
    })

    const bridge = new PluginUiBridge()
    const first = bridge.send(
      () => true,
      { requestId: 'drain-1', action: 'open', receiver: 'lead', index: 0 },
      100,
    )
    const second = bridge.send(
      () => true,
      { requestId: 'drain-2', action: 'close', receiver: 'lead', index: 0 },
      100,
    )
    bridge.drainAll('engine exited')
    await expect(first).resolves.toMatchObject({
      action: 'open',
      ok: false,
      error: 'engine exited',
    })
    await expect(second).resolves.toMatchObject({
      action: 'close',
      ok: false,
      error: 'engine exited',
    })
    expect(bridge.pendingCount).toBe(0)
  })

  // #601 review M2: the four failure paths below existed with zero coverage.

  it('rejects a duplicate requestId without writing a second meta line', async () => {
    const bridge = new PluginUiBridge()
    const write = vi.fn().mockReturnValue(true)
    const first = bridge.send(
      write,
      { requestId: 'dup-1', action: 'open', receiver: 'lead', index: 0 },
      100,
    )

    const duplicate = bridge.send(
      write,
      { requestId: 'dup-1', action: 'close', receiver: 'lead', index: 0 },
      100,
    )

    await expect(duplicate).resolves.toEqual({
      requestId: 'dup-1',
      action: 'close',
      ok: false,
      error: "duplicate plugin UI request id 'dup-1'",
    })
    // 元の pending は無傷のまま（2通目の書き込みも発生しない）。
    expect(write).toHaveBeenCalledTimes(1)
    expect(bridge.pendingCount).toBe(1)
    bridge.drainAll('cleanup')
    await first
  })

  it('fails fast when writeLine reports false instead of waiting for the timeout', async () => {
    const bridge = new PluginUiBridge()

    const pending = bridge.send(
      () => false,
      { requestId: 'wf-1', action: 'open', receiver: 'lead', index: 0 },
      10_000,
    )

    await expect(pending).resolves.toEqual({
      requestId: 'wf-1',
      action: 'open',
      ok: false,
      error: 'failed to write //#pluginUi to engine stdin',
    })
    expect(bridge.pendingCount).toBe(0)
  })

  it('fails fast when writeLine throws synchronously', async () => {
    const bridge = new PluginUiBridge()

    const pending = bridge.send(
      () => {
        throw new Error('stdin is gone')
      },
      { requestId: 'wt-1', action: 'close', receiver: 'lead', index: 0 },
      10_000,
    )

    await expect(pending).resolves.toEqual({
      requestId: 'wt-1',
      action: 'close',
      ok: false,
      error: 'stdin is gone',
    })
    expect(bridge.pendingCount).toBe(0)
  })

  it('consumes a well-formed line with no pending entry without touching other pendings', async () => {
    const bridge = new PluginUiBridge()
    const unrelated = bridge.send(
      () => true,
      { requestId: 'other-1', action: 'open', receiver: 'lead', index: 0 },
      100,
    )

    const consumed = bridge.handleLine(
      JSON.stringify({
        pluginUi: { requestId: 'nobody-waiting', action: 'open', ok: true, result: {} },
      }),
    )

    // 行としては pluginUi 結果なので true（呼び出し側の malformed 警告を出させない）が、
    // 他の pending を誤って解決しない。
    expect(consumed).toBe(true)
    expect(bridge.pendingCount).toBe(1)
    bridge.drainAll('cleanup')
    await unrelated
  })
})
