import { describe, expect, it, vi } from 'vitest'

import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'

describe('#628 daemon-client rack wire without a socket', () => {
  it('serializes the complete ApplyEffectChain request and result', async () => {
    const client = new DaemonClient()
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({
      status: 'applied',
      child_pid: 51,
      dropped: [{ prev_index: 1, path: '/states/b.state', bytes_written: 9 }],
    })

    await expect(
      client.applyEffectChain({
        bus: 'seq-bus-2',
        mode: 'diff',
        chain: [
          { op: 'keep', prev_index: 0, enabled: true },
          {
            op: 'load',
            kind: 'standard',
            name: 'Gain',
            params: { db: -6 },
            enabled: true,
          },
        ],
        saveDropped: [{ prev_index: 1, path: '/states/b.state' }],
      }),
    ).resolves.toEqual({
      status: 'applied',
      childPid: 51,
      dropped: [{ prevIndex: 1, path: '/states/b.state', bytesWritten: 9 }],
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('ApplyEffectChain', {
      role: 'effect',
      bus: 'seq-bus-2',
      mode: 'diff',
      chain: [
        { op: 'keep', prev_index: 0, enabled: true },
        {
          op: 'load',
          kind: 'standard',
          name: 'Gain',
          params: { db: -6 },
          enabled: true,
        },
      ],
      save_dropped: [{ prev_index: 1, path: '/states/b.state' }],
    })
  })

  it('sends explicit chain_path for state and all three UI commands', async () => {
    const client = new DaemonClient()
    const request = vi
      .spyOn(client as any, 'request')
      .mockResolvedValueOnce({ path: '/states/c.state', bytes_written: 12 })
      .mockResolvedValue({ status: 'ok' })
    const target = { role: 'effect' as const, bus: 'seq-bus-2', chainPath: [2] }

    await client.savePluginState(target, '/states/c.state')
    await client.openPluginUi(target, 1, 'C', 99)
    await client.acceptClosePluginUi(target, 1, 99)
    await client.ackUiSafepoint(target, 1, 99, 7, 11)

    expect(request).toHaveBeenCalledTimes(4)
    expect(request).toHaveBeenNthCalledWith(1, 'GetPluginState', {
      path: '/states/c.state',
      role: 'effect',
      bus: 'seq-bus-2',
      chain_path: [2],
    })
    expect(request).toHaveBeenNthCalledWith(2, 'OpenPluginUI', {
      target: { role: 'effect', bus: 'seq-bus-2' },
      chain_path: [2],
      window: 99,
      windowTitle: 'C',
    })
    expect(request).toHaveBeenNthCalledWith(3, 'ClosePluginUI', {
      target: { role: 'effect', bus: 'seq-bus-2' },
      chain_path: [2],
      window: 99,
    })
    expect(request).toHaveBeenNthCalledWith(4, 'AckUiSafepoint', {
      target: { role: 'effect', bus: 'seq-bus-2' },
      chain_path: [2],
      window: 99,
      generation: 7,
      evt_seq: 11,
    })
  })
})
