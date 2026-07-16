/**
 * global.sum() / global.aux() — mixer group/return bus declarations (MX.2/MX.3, #459/#453 M3).
 */

import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { MIXER_BUS_POOL_SIZE } from '../../packages/engine/src/core/global/mixer-manager'

function makeGlobal(loadPlugin = vi.fn().mockResolvedValue({})) {
  const engine = {
    loadPlugin,
    boot: vi.fn(),
    quit: vi.fn(),
    isRunning: true,
  } as any
  const global = new Global(engine)
  global.setDocumentDirectory('/songs/session')
  return { global, loadPlugin }
}

describe('Global.sum() / Global.aux()', () => {
  it('allocates the first pool bus per kind, in declaration order', () => {
    const { global } = makeGlobal()
    expect(global.sum('drum').bus).toBe('sum-bus-0')
    expect(global.sum('lead').bus).toBe('sum-bus-1')
    expect(global.aux('rev').bus).toBe('aux-bus-0')
    expect(global.aux('delay').bus).toBe('aux-bus-1')
  })

  it('is idempotent: re-declaring the same name returns the same bus', () => {
    const { global } = makeGlobal()
    expect(global.sum('drum').bus).toBe('sum-bus-0')
    expect(global.sum('drum').bus).toBe('sum-bus-0')
    expect(global.resolveSumBus('drum')).toBe('sum-bus-0')
  })

  it('resolveSumBus()/resolveAuxBus() return undefined for an undeclared name', () => {
    const { global } = makeGlobal()
    expect(global.resolveSumBus('nope')).toBeUndefined()
    expect(global.resolveAuxBus('nope')).toBeUndefined()
  })

  it('exhausts the sum pool after the v1 cap (4) with an explicit message', () => {
    const { global } = makeGlobal()
    for (let i = 0; i < MIXER_BUS_POOL_SIZE; i++) global.sum(`s${i}`)
    expect(() => global.sum('overflow')).toThrow('pool exhausted')
  })

  it('exhausts the aux pool after the v1 cap (4) with an explicit message', () => {
    const { global } = makeGlobal()
    for (let i = 0; i < MIXER_BUS_POOL_SIZE; i++) global.aux(`a${i}`)
    expect(() => global.aux('overflow')).toThrow('pool exhausted')
  })

  it('rejects sum()/aux() while LinkAudio is enabled', () => {
    const { global } = makeGlobal()
    global.linkAudio()
    expect(() => global.sum('drum')).toThrow('LinkAudio')
    expect(() => global.aux('rev')).toThrow('LinkAudio')
  })

  it('blocks a later global.linkAudio() once a sum/aux bus has been declared', () => {
    const { global } = makeGlobal()
    global.sum('drum')
    expect(() => global.linkAudio()).toThrow('plugin hosting')
  })

  it('handle.effect() loads via LoadPlugin(role=effect, bus=<sum/aux bus>)', async () => {
    const { global, loadPlugin } = makeGlobal()
    const handle = global.sum('drum')
    await handle.effect('./GlueComp.clap')
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'GlueComp.clap'),
      undefined,
      'effect',
      'sum-bus-0',
    )
  })

  it('handle.effect() is idempotent on the same path + pluginId', async () => {
    const { global, loadPlugin } = makeGlobal()
    await global.sum('drum').effect('./GlueComp.clap', 'glue-id')
    await global.sum('drum').effect('GlueComp.clap', 'glue-id')
    expect(loadPlugin).toHaveBeenCalledTimes(1)
  })

  it('handle.effect() rejects re-declaration with a different path', async () => {
    const { global } = makeGlobal()
    await global.sum('drum').effect('./GlueComp.clap')
    await expect(global.sum('drum').effect('./OtherComp.clap')).rejects.toThrow(
      'one insert per bus',
    )
  })

  it('handle.effect() rejects non-.clap specs', async () => {
    const { global } = makeGlobal()
    await expect(global.sum('drum').effect('Reverb.vst3')).rejects.toThrow('not yet supported')
  })

  it('sum("drum") and aux("rev") are independent namespaces/pools', () => {
    const { global } = makeGlobal()
    global.sum('shared-name')
    expect(global.aux('shared-name').bus).toBe('aux-bus-0')
    expect(global.resolveSumBus('shared-name')).toBe('sum-bus-0')
    expect(global.resolveAuxBus('shared-name')).toBe('aux-bus-0')
  })
})
