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
})
