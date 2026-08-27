import { describe, expect, it, vi } from 'vitest'

import type { SuperColliderPlayer } from '../../packages/engine/src/audio/supercollider-player'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import {
  BUS_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'

function harness(name = 'cb') {
  const player = {
    boot: vi.fn().mockResolvedValue(undefined),
    getCurrentTime: vi.fn().mockReturnValue(0),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getMasterGainDb: vi.fn().mockReturnValue(0),
  } as unknown as SuperColliderPlayer
  const global = new Global(player)
  const sequence = new Sequence(global, player)
  sequence.setName(name)
  return { global, sequence }
}

describe('ui() DSL surface after #628', () => {
  it('keeps no-argument seq.ui() as the idempotent instrument form', async () => {
    const { global, sequence } = harness()
    const open = vi.spyOn(global, 'openPluginUiIdempotent').mockResolvedValue(undefined)

    await expect(sequence.ui()).resolves.toBe(sequence)

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('cb', 0)
  })

  it('uses a catalog name for effect UI open and close', async () => {
    const { global, sequence } = harness('lead')
    const open = vi.spyOn(global, 'openPluginUisByName').mockResolvedValue(undefined)
    const close = vi.spyOn(global, 'closePluginUisByName').mockResolvedValue(undefined)

    await sequence.ui('Serum')
    await sequence.ui('Serum', false)

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('lead', 'Serum')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith('lead', 'Serum')
  })

  it('rejects the retired numeric-index form before opening anything', async () => {
    const { global, sequence } = harness()
    const open = vi.spyOn(global, 'openPluginUisByName')

    await expect(sequence.ui(1 as never)).rejects.toThrow('numeric indexes are not supported')
    expect(open).toHaveBeenCalledTimes(0)
  })

  it('uses the same catalog-name form for sum and aux buses', async () => {
    const { global } = harness()
    const open = vi.spyOn(global, 'openPluginUisByName').mockResolvedValue(undefined)
    const close = vi.spyOn(global, 'closePluginUisByName').mockResolvedValue(undefined)

    await global.sum('strings').ui('Glue')
    await global.aux('verb').ui('Verb', false)

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('sum:strings', 'Glue')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith('aux:verb', 'Verb')
  })

  it('rejects a no-argument mixer-bus ui() because buses have no instrument slot', async () => {
    const { global } = harness()
    await expect(global.sum('strings').ui()).rejects.toThrow('has no instrument UI')
  })

  it('keeps ui in sequence and bus DSL vocabularies', () => {
    expect(SEQUENCE_DSL_METHODS.has('ui')).toBe(true)
    expect(BUS_DSL_METHODS.has('ui')).toBe(true)
  })
})
