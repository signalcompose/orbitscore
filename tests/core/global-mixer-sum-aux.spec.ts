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

  it('resolves a bare mixer name when only sum or only aux declares it', () => {
    const sumOnly = makeGlobal().global
    sumOnly.sum('drum')
    expect(sumOnly.resolveMixerBus('drum')).toEqual({ kind: 'sum', bus: 'sum-bus-0' })

    const auxOnly = makeGlobal().global
    auxOnly.aux('drum')
    expect(auxOnly.resolveMixerBus('drum')).toEqual({ kind: 'aux', bus: 'aux-bus-0' })
  })

  it('rejects a bare mixer name declared as both sum and aux with both explicit forms', () => {
    const { global } = makeGlobal()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      global.sum('drum')
      global.aux('drum')
      global.sum('drum')
      global.aux('drum')

      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ambiguous.*both sum and aux/i))
      expect(() => global.resolveMixerBus('drum')).toThrow(
        /global\.sum\("drum"\).*global\.aux\("drum"\)/,
      )
    } finally {
      warn.mockRestore()
    }
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

  it('handle.effect() accepts .vst3 specs', async () => {
    const { global, loadPlugin } = makeGlobal()
    await expect(global.sum('drum').effect('Reverb.vst3')).resolves.toBeDefined()
    expect(loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs/session', 'Reverb.vst3'),
      undefined,
      'effect',
      'sum-bus-0',
    )
  })

  it('keeps same-named sum and aux declarations in independent namespaces/pools', () => {
    const { global } = makeGlobal()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      global.sum('shared-name')
      expect(global.aux('shared-name').bus).toBe('aux-bus-0')
      expect(global.resolveSumBus('shared-name')).toBe('sum-bus-0')
      expect(global.resolveAuxBus('shared-name')).toBe('aux-bus-0')
      // The second-kind warning fires exactly once for this declaration order
      // (sum first, aux second) too — the namespaces stay independent, but the
      // ambiguity is still announced (#579).
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects "master" as a sum/aux name — it is reserved for the output endpoint (#523 IMPORTANT 6)', () => {
    // `.master` means "reset routing to hardware/master". Nothing stopped a
    // user from declaring `global.sum("master")`, after which `.master`
    // silently resolved to their sum bus instead — no error, reserved meaning
    // lost. Declaring an output endpoint named `master` (`mix.output(1, 2)`)
    // must stay legal: that node genuinely IS the master.
    const { global } = makeGlobal()
    expect(() => global.sum('master')).toThrow(/master.*reserved|reserved.*master/i)
    expect(() => global.aux('master')).toThrow(/master.*reserved|reserved.*master/i)
  })

  it('commits routing state only after the daemon accepts it, so a rejected call is not merged into a later one (#523 CRITICAL 5)', async () => {
    // MixerManager.route() builds `next` from the last COMMITTED routing and
    // only calls `this.routings.set(source, next)` after `setBusRouting`
    // resolves. If that commit ever moved before the `await`, a rejected send
    // would still be recorded, and the next (unrelated) call on the same
    // source would silently resend it merged into its own payload.
    const setBusRouting = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon rejected'))
      .mockResolvedValueOnce(undefined)
    const engine = { setBusRouting, boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine)
    const handle = global.sum('drum')

    await expect(handle.routeSend('aux-bus-0', 0.5)).rejects.toThrow('daemon rejected')

    await handle.routeOutput('master')

    expect(setBusRouting).toHaveBeenNthCalledWith(2, 'sum-bus-0', 'master', [])
  })
})
