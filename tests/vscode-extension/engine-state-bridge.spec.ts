import { describe, expect, it } from 'vitest'

import {
  EngineStateBridge,
  parseEngineStatusResultLine,
  resolveEngineState,
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

// 🔴 `get_engine_state` は LLM が「いま何が起きているか」を知る唯一の窓口なので、daemon の状態が
// 取れないことを理由に**例外で落ちてはいけない**。3 分岐すべてを固定する（2026-09-05 の監査で
// 「どの分岐もテストからも E2E からも触れられていない」と指摘された）。
describe('resolveEngineState', () => {
  const base = { running: true, liveCoding: false } as const

  it('does not ask the daemon at all when the engine is not running', async () => {
    let asked = 0
    const state = await resolveEngineState({ running: false, liveCoding: true }, async () => {
      asked += 1
      throw new Error('must not be called')
    })
    expect(asked).toBe(0)
    expect(state).toEqual({ running: false, liveCoding: true })
  })

  it('attaches output and callback when the bridge answers', async () => {
    const output = { device_name: 'USB Audio' }
    const callback = { alive: true }
    const state = await resolveEngineState(base, async () => ({
      requestId: 'r1',
      ok: true,
      output,
      callback,
    }))
    expect(state).toEqual({ running: true, liveCoding: false, output, callback })
  })

  it('degrades to statusError when the bridge reports a failure', async () => {
    const state = await resolveEngineState(base, async () => ({
      requestId: 'r1',
      ok: false,
      error: 'timed out waiting for engine response to //#getEngineState',
    }))
    expect(state.running).toBe(true)
    expect(state.output).toBeUndefined()
    expect(state.statusError).toBe('timed out waiting for engine response to //#getEngineState')
  })

  it('degrades to statusError when the bridge itself rejects', async () => {
    const state = await resolveEngineState(base, () =>
      Promise.reject(new Error('engine stdin is not writable (engine not running?)')),
    )
    expect(state.running).toBe(true)
    expect(state.statusError).toBe('engine stdin is not writable (engine not running?)')
  })

  it('stringifies a non-Error rejection instead of throwing', async () => {
    const state = await resolveEngineState(base, () => Promise.reject('stdin closed'))
    expect(state.statusError).toBe('stdin closed')
  })
})
