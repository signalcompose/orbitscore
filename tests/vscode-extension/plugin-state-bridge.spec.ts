import { describe, expect, it, vi } from 'vitest'

import {
  parsePluginStateResultLine,
  PluginStateBridge,
} from '../../packages/vscode-extension/src/plugin-state-bridge'

describe('PluginStateBridge', () => {
  it('correlates out-of-order replies by requestId instead of FIFO', async () => {
    const bridge = new PluginStateBridge()
    const writes: string[] = []
    const send = (requestId: string) =>
      bridge.send(
        (line) => {
          writes.push(line)
          return true
        },
        { requestId, sequence: `sequence ${requestId}`, index: 0 },
      )
    const first = send('a')
    const second = send('b')
    expect(writes).toEqual([
      '//#savePluginState {"requestId":"a","sequence":"sequence a","index":0}\n',
      '//#savePluginState {"requestId":"b","sequence":"sequence b","index":0}\n',
    ])

    bridge.handleLine('{"savePluginState":{"requestId":"b","ok":true,"saved":{"bytes":2}}}')
    bridge.handleLine('{"savePluginState":{"requestId":"a","ok":true,"saved":{"bytes":1}}}')
    await expect(first).resolves.toMatchObject({ requestId: 'a', ok: true })
    await expect(second).resolves.toMatchObject({ requestId: 'b', ok: true })
  })

  it('times out and drains pending requests loudly', async () => {
    vi.useFakeTimers()
    const bridge = new PluginStateBridge()
    const timedOut = bridge.send(
      () => true,
      { requestId: 'timeout', sequence: 'lead', index: 0 },
      10,
    )
    await vi.advanceTimersByTimeAsync(10)
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('timed out'),
    })

    const drained = bridge.send(() => true, { requestId: 'exit', sequence: 'lead', index: 0 })
    bridge.drainAll('engine exited')
    await expect(drained).resolves.toEqual({
      requestId: 'exit',
      ok: false,
      error: 'engine exited',
    })
    vi.useRealTimers()
  })

  it('preserves daemon code and details in parsed error replies', () => {
    expect(
      parsePluginStateResultLine(
        '{"savePluginState":{"requestId":"x","ok":false,"error":"timeout","code":"PLUGIN_STATE_TIMEOUT","details":{"elapsed":5}}}',
      ),
    ).toEqual({
      requestId: 'x',
      ok: false,
      error: 'timeout',
      code: 'PLUGIN_STATE_TIMEOUT',
      details: { elapsed: 5 },
    })
  })
})
