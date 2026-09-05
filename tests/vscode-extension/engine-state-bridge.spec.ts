import { describe, expect, it } from 'vitest'

import {
  EngineStateBridge,
  parseEngineStatusResultLine,
} from '../../packages/vscode-extension/src/engine-state-bridge'

describe('EngineStateBridge', () => {
  it('round-trips output and callback without flattening fields', async () => {
    const bridge = new EngineStateBridge()
    let sent = ''
    const pending = bridge.send((line) => {
      sent = line
      return true
    })
    const requestId = JSON.parse(sent.slice('//#getEngineState '.length)) as {
      requestId: string
    }
    const output = {
      device_name: 'USB Audio',
      first_callback_ms: 12,
      last_switch_failure: 'probe timed out',
    }
    const callback = { count: 42, alive: true, last_frames: 512 }
    expect(
      bridge.handleLine(
        JSON.stringify({
          engineState: { requestId: requestId.requestId, ok: true, output, callback },
        }),
      ),
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      requestId: requestId.requestId,
      ok: true,
      output,
      callback,
    })
    expect(bridge.pendingCount).toBe(0)
  })

  it('rejects malformed snapshots instead of returning partial observability', () => {
    expect(
      parseEngineStatusResultLine(
        JSON.stringify({
          engineState: { requestId: 'r1', ok: true, output: {}, callback: null },
        }),
      ),
    ).toBeUndefined()
  })

  it('drains pending status requests when the engine exits', async () => {
    const bridge = new EngineStateBridge()
    const pending = bridge.send(() => true)
    bridge.drainAll('engine exited')
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'engine exited' })
    expect(bridge.pendingCount).toBe(0)
  })
})
