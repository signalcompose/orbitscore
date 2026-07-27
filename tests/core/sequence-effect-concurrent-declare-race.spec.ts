/**
 * #527 review round 3: the `EffectChainMap.declare()` per-key serialization
 * (added to fix Important 1's concurrent self-heal race) opened a NEW success
 * path that `SequenceEffectManager.effect()`'s bus bookkeeping didn't account
 * for.
 *
 * `tests/core/effect-chain-map.spec.ts` only checks `EffectChainMap` internal
 * consistency (`map.has(key)`) — this file checks the one layer out:
 * `SequenceEffectManager.getBus()` / the `BusPool` free-list, which is where
 * the bot-reported regression actually surfaces.
 *
 * Repro (two `effect()` calls for the same sequence, fired without awaiting
 * between them):
 *
 * 1. p1 sees no bus yet (`hadBus = false`), acquires `seq-bus-0`, enters
 *    `declare()` and suspends on `loadPlugin`.
 * 2. p2 (same synchronous burst) sees the bus p1 just set (`hadBus = true`,
 *    reuses `seq-bus-0`). Its `declare()` call queues behind p1's via
 *    `EffectChainMap`'s per-key `pending` serialization.
 * 3. p1's `loadPlugin` rejects (transient failure) → `issueLoad`'s rollback
 *    empties the chain → p1's `declare()` rejects.
 * 4. p2's queued `declareBody()` now runs: chain is empty, so it does a FRESH
 *    `issueLoad` → `loadPlugin` resolves → p2 succeeds.
 * 5. Back in p1's `SequenceEffectManager.effect()` catch block: `hadBus` was
 *    `false` at snapshot time, so the OLD code unconditionally deleted the bus
 *    and returned it to the free-list — even though p2 now holds a live
 *    declaration on it. Engine has a live plugin on `seq-bus-0`; bookkeeping
 *    says nothing is there and the bus is free for reuse.
 */

import { describe, it, expect, vi } from 'vitest'

import { SequenceEffectManager } from '../../packages/engine/src/core/global/sequence-effect-manager'
import { AudioManager } from '../../packages/engine/src/core/global/audio-manager'
import { LinkAudioManager } from '../../packages/engine/src/core/global/link-audio-manager'

function harness(loadPlugin: ReturnType<typeof vi.fn>) {
  const audioEngine = { loadPlugin } as any
  const audioManager = new AudioManager()
  audioManager.setDocumentDirectory('/songs')
  const manager = new SequenceEffectManager(
    audioEngine,
    audioManager,
    new LinkAudioManager(audioEngine),
  )
  return { manager, loadPlugin }
}

describe('SequenceEffectManager — concurrent declare() bus bookkeeping (#527 review round 3)', () => {
  it('does not free a bus that a queued successor call went on to occupy', async () => {
    const loadPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient load failure'))
      .mockResolvedValueOnce({})
    const { manager } = harness(loadPlugin)

    const p1 = manager.effect('kick', './echo.clap')
    const p2 = manager.effect('kick', './echo.clap')

    const results = await Promise.allSettled([p1, p2])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    const bus = (results[1] as PromiseFulfilledResult<string>).value

    // p2 actually holds a live declaration on `bus` — bookkeeping must agree.
    expect(manager.hasDeclaration('kick')).toBe(true)
    expect(manager.getBus('kick')).toBe(bus)

    // The bus must not have been returned to the free-list either: a THIRD
    // sequence declaring afterward must not be handed the same physical bus
    // that 'kick' is still actively using.
    loadPlugin.mockResolvedValue({})
    const otherBus = await manager.effect('snare', './comp.clap')
    expect(otherBus).not.toBe(bus)
  })

  it('still frees the bus on a plain (non-concurrent) failure, as before', async () => {
    // Regression guard for the fix itself: the ordinary single-call failure
    // path (#461 review Important's free-list return) must keep working
    // once the failure handling awaits `slots.settled()` first.
    const loadPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce({})
    const { manager } = harness(loadPlugin)

    await expect(manager.effect('kick', './typo.clap')).rejects.toThrow('load failed')
    expect(manager.hasDeclaration('kick')).toBe(false)

    // Retry reuses the freed bus (not a fresh one further down the pool).
    const bus = await manager.effect('kick', './reverb.clap')
    expect(bus).toBe('seq-bus-0')
  })
})
