import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createReplSession,
  extractSavePluginStateMeta,
} from '../../packages/engine/src/cli/repl-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('//#savePluginState REPL meta', () => {
  it('parses a JSON payload without losing spaces or punctuation in sequence names', () => {
    expect(
      extractSavePluginStateMeta(
        '//#savePluginState {"requestId":"req-1","sequence":"lead / one","index":0}',
      ),
    ).toEqual({ requestId: 'req-1', sequence: 'lead / one', index: 0 })
  })

  it('rejects malformed schema instead of guessing defaults', () => {
    expect(() =>
      extractSavePluginStateMeta(
        '//#savePluginState {"requestId":"req-1","sequence":"lead","index":1.5}',
      ),
    ).toThrow('non-negative integer index')
  })

  it('emits one request-ID-correlated success envelope and does not evaluate DSL', async () => {
    const savePluginState = vi.fn().mockResolvedValue({
      path: '/songs/states/lead.state',
      bytesWritten: 12,
      identityKey: 'lead/instrument/Synth/0',
    })
    const execute = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const session = createReplSession({ savePluginState, execute } as any)

    session.pushLine('//#savePluginState {"requestId":"req-1","sequence":"lead","index":0}')
    await session.idle()

    expect(savePluginState).toHaveBeenCalledTimes(1)
    expect(savePluginState).toHaveBeenCalledWith('lead', 0)
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      savePluginState: {
        requestId: 'req-1',
        ok: true,
        saved: { identityKey: 'lead/instrument/Synth/0' },
      },
    })
  })

  it('preserves protocol code and details in the error envelope', async () => {
    const failure = Object.assign(new Error('mailbox timed out after 5s'), {
      code: 'PLUGIN_STATE_TIMEOUT',
      details: { elapsed: 5 },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const session = createReplSession({
      savePluginState: vi.fn().mockRejectedValue(failure),
      execute: vi.fn(),
    } as any)

    session.pushLine('//#savePluginState {"requestId":"req-2","sequence":"master","index":1}')
    await session.idle()

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      savePluginState: {
        requestId: 'req-2',
        ok: false,
        error: 'mailbox timed out after 5s',
        code: 'PLUGIN_STATE_TIMEOUT',
        details: { elapsed: 5 },
      },
    })
  })
})
