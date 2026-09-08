import { describe, expect, it, vi } from 'vitest'

import {
  DaemonClient,
  type WireLineOp,
} from '../../../packages/engine/src/audio/rust-engine/daemon-client'

describe('#611 daemon-client SetBusLine wire', () => {
  it('sends the complete ordered line without reshaping the wire contract', async () => {
    const client = new DaemonClient()
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({ status: 'accepted' })
    const line: WireLineOp[] = [
      { op: 'rack' },
      { op: 'gain', gain: 0.501187 },
      {
        op: 'output',
        dest: { kind: 'bus', name: 'aux-bus-0' },
        thru: true,
        gain: 0.25,
      },
      {
        op: 'output',
        dest: { kind: 'master' },
        thru: false,
        gain: 1,
      },
    ]

    await client.setBusLine('seq-bus-0', line)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('SetBusLine', {
      bus: 'seq-bus-0',
      line,
    })
  })
})
