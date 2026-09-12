import { describe, it, expect, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { processArguments } from '../../packages/engine/src/interpreter/evaluate-method'

describe('#884 round 2: send() の宛先は両実装で必須', () => {
  const engine = () =>
    ({
      setBusLine: vi.fn().mockResolvedValue(undefined),
      boot: vi.fn(),
      quit: vi.fn(),
      isRunning: true,
    }) as any

  it('パーサは send(db: -6) を [undefined, options] に整形する', async () => {
    const processed = await processArguments('send', [
      { type: 'named_arg', name: 'db', value: -6 },
    ] as any)
    expect(processed).toEqual([undefined, { db: -6 }])
  })

  it('MixerBusHandle.send() が宛先省略を loud に拒否する', async () => {
    const g = new Global(engine())
    const handle = g.sum('drum884')
    await expect((handle as any).send(undefined, { db: -6 })).rejects.toThrow(
      /requires a destination; received undefined/,
    )
  })

  it('Sequence.send() も同じ文言で拒否する', () => {
    const g = new Global(engine())
    const seq = g.seq
    seq.setName('k884')
    expect(() => (seq as any).send(undefined, { db: -6 })).toThrow(
      /requires a destination; received undefined/,
    )
  })

  it('実際の型を文言に出す（null 決め打ちではない）', () => {
    const g = new Global(engine())
    const seq = g.seq
    seq.setName('k884b')
    expect(() => (seq as any).send(42, { db: -6 })).toThrow(/received number/)
  })
})
