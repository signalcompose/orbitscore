/**
 * 中継の RPC 1 回分（`createRelayCall`・設計 848 §6.2 の RL-3 / RL-4 / RL-5）。接続を差し替えて、
 * 繋ぎ直す条件と回数だけを見る（プロセスとしての振る舞いは `relay-process.spec.ts`）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createRelayCall,
  NOT_RUNNING_MESSAGE,
  unknownOutcomeMessage,
  updatedMessage,
} from '../../packages/session/src/relay/relay-main'
import {
  ProtocolMismatchError,
  RpcCallError,
  RpcConnectionClosedError,
  type SessionConnection,
} from '../../packages/session/src/rpc/client'

function connection(call: SessionConnection['call']): SessionConnection & { close: () => void } {
  return {
    hello: { protocol_version: '1.0', session_version: 't', capabilities: [] },
    clientId: 'c',
    call,
    close: vi.fn(),
    closed: Promise.resolve(),
  }
}

const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

describe('createRelayCall (design 848 §6.2)', () => {
  it('RL-3: retries a refused connection with the configured waits, then says "not running"', async () => {
    const connect = vi.fn().mockRejectedValue(refused())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const call = createRelayCall('/x.sock', {
      client: { name: 't', version: '0' },
      retryDelaysMs: [10, 20, 30],
      connect,
      sleep,
    })
    await expect(call('engine.getState')).rejects.toThrow(NOT_RUNNING_MESSAGE)
    expect(connect).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[10], [20], [30]])
  })

  it('RL-3: a session that comes back during the waits is used without the client doing anything', async () => {
    const live = connection(vi.fn().mockResolvedValue({ running: false }))
    const connect = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(live)
    const call = createRelayCall('/x.sock', {
      client: { name: 't', version: '0' },
      retryDelaysMs: [1],
      connect,
      sleep: async () => {},
    })
    expect(await call('engine.getState')).toEqual({ running: false })
    expect(live.close).toHaveBeenCalledTimes(1)
  })

  it('RL-4: a call that was sent is never resent when the connection drops', async () => {
    const dropped = connection(
      vi.fn().mockRejectedValue(new RpcConnectionClosedError('session.evaluate')),
    )
    const connect = vi.fn().mockResolvedValue(dropped)
    const call = createRelayCall('/x.sock', {
      client: { name: 't', version: '0' },
      connect,
      sleep: async () => {},
    })
    await expect(call('session.evaluate', { code: 'x' })).rejects.toThrow(
      unknownOutcomeMessage('session.evaluate'),
    )
    expect(connect).toHaveBeenCalledTimes(1)
    expect(dropped.call).toHaveBeenCalledTimes(1)
  })

  it('RL-5: a different MAJOR is not retried and asks to reconnect', async () => {
    const connect = vi.fn().mockRejectedValue(new ProtocolMismatchError('2.0'))
    const call = createRelayCall('/x.sock', {
      client: { name: 't', version: '0' },
      connect,
      sleep: async () => {},
    })
    await expect(call('engine.getState')).rejects.toThrow(updatedMessage('2.0'))
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('keeps a layer-2 error (frozen wording) as it is', async () => {
    const failing = connection(
      vi
        .fn()
        .mockRejectedValue(new RpcCallError(-32012, 'NO_EDITOR_ATTACHED', 'no editor is attached')),
    )
    const call = createRelayCall('/x.sock', {
      client: { name: 't', version: '0' },
      connect: vi.fn().mockResolvedValue(failing),
    })
    await expect(call('editor.getState')).rejects.toMatchObject({
      errorName: 'NO_EDITOR_ATTACHED',
      message: 'no editor is attached',
    })
    expect(failing.close).toHaveBeenCalledTimes(1)
  })
})
