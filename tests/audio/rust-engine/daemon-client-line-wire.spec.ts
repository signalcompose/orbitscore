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

  // 🔴 束 A が型を広げた 2 つ（`pan` op と mono の `channels: [number]`）を、この spec は
  // 1 件も通していなかった（`/code:pr-review-team` の test-analyzer・2026-09-11）。
  // 設計 §11 は PR-A1 の検証コマンドとしてこのファイルを名指ししているので、
  // 「実行はされるが変更点は通らない」状態になっていた。
  it('carries the pan op and a mono device destination through unchanged', async () => {
    const client = new DaemonClient()
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({ status: 'accepted' })
    const line: WireLineOp[] = [
      { op: 'rack' },
      { op: 'pan', pan: -1 },
      {
        op: 'output',
        dest: { kind: 'device', channels: [3] },
        thru: false,
        gain: 1,
      },
    ]

    await client.setBusLine('seq-bus-1', line)

    expect(request).toHaveBeenCalledTimes(1)
    // 参照の同一性ではなく**中身**で見る（`toHaveBeenCalledWith` は deep equal なので、
    // 途中で配列を組み直しても中身が同じなら通る = 転送が形を変えていないことの検査になる）。
    expect(request).toHaveBeenCalledWith('SetBusLine', {
      bus: 'seq-bus-1',
      line: [
        { op: 'rack' },
        { op: 'pan', pan: -1 },
        { op: 'output', dest: { kind: 'device', channels: [3] }, thru: false, gain: 1 },
      ],
    })
  })
})
