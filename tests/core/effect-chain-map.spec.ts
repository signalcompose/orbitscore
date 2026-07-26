/**
 * #527 review Important 1-3: `EffectChainMap` / `normalizePluginInstanceName`
 * white-box coverage.
 *
 * These tests instantiate `EffectChainMap` directly (rather than through one of
 * the four managers) because none of the managers expose `instanceId` or the
 * internal chain — this is the seam the S4/#522 Rust protocol extension will
 * consume, so `chainFor()` below is a minimal read-only accessor added for that
 * purpose (see effect-slot.ts).
 */

import { describe, it, expect, vi } from 'vitest'

import {
  EffectChainMap,
  normalizePluginInstanceName,
  type PluginDeclaration,
} from '../../packages/engine/src/core/global/effect-slot'
import type { PluginLoadResult } from '../../packages/engine/src/audio/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const loadResult: PluginLoadResult = { pluginId: 'p', pluginName: 'echo', notePortIndex: 0 }

const baseSpec: PluginDeclaration = {
  role: 'effect',
  bus: undefined,
  normalizedName: 'echo',
  resolvedPath: '/plugins/echo.clap',
  pluginId: undefined,
}

describe('EffectChainMap.declare() concurrent self-heal race (#527 Important 1)', () => {
  it('does not leave has() reporting nothing declared when a concurrent self-heal race settles', async () => {
    // Reproduces: two declare() calls for the same key + spec race in while the
    // engine reports the plugin inactive (post-respawn self-heal). Both read the
    // same `existing` slot as `replacing`; whichever's issueLoad runs its
    // synchronous prefix FIRST wins the chain-array replacement (object-identity
    // match), and the OTHER's replacement silently becomes a no-op. If the
    // "tracked" (first) reload then fails while the "dropped" (second) reload
    // actually succeeds, the failure's rollback deletes the whole key — so the
    // engine has a live plugin while `has()` says nothing is declared.
    const initialLoad = deferred<PluginLoadResult>()
    const reloadReject = deferred<PluginLoadResult>()
    const reloadResolve = deferred<PluginLoadResult>()
    let loadCallCount = 0
    const isActive = { value: false }
    const loadPlugin = vi.fn().mockImplementation(() => {
      loadCallCount += 1
      if (loadCallCount === 1) return initialLoad.promise
      if (loadCallCount === 2) return reloadReject.promise
      return reloadResolve.promise
    })
    const isPluginActive = vi.fn(() => isActive.value)
    const audioEngine = { loadPlugin, isPluginActive } as any
    const map = new EffectChainMap<string>(audioEngine, () => 'master')

    const initial = map.declare('key', baseSpec, () => 'dup')
    initialLoad.resolve(loadResult)
    await initial
    expect(map.has('key')).toBe(true)

    // Respawn: the engine forgot the plugin, so the next declare()(s) self-heal.
    isActive.value = false
    const first = map.declare('key', baseSpec, () => 'dup')
    const second = map.declare('key', baseSpec, () => 'dup')
    reloadReject.reject(new Error('daemon rejected the reissue'))
    reloadResolve.resolve(loadResult)

    const results = await Promise.allSettled([first, second])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')

    // The second reload actually succeeded in the engine — the map must not
    // silently report nothing declared.
    expect(map.has('key')).toBe(true)
  })

  it('serializes concurrent self-heal declare() calls so the second is not a redundant duplicate reload', async () => {
    const initialLoad = deferred<PluginLoadResult>()
    const reload = deferred<PluginLoadResult>()
    let loadCallCount = 0
    const isActive = { value: false }
    const loadPlugin = vi.fn().mockImplementation(() => {
      loadCallCount += 1
      if (loadCallCount === 1) return initialLoad.promise
      // Mirrors reality: the engine reports the plugin active again only once
      // the reload it is tied to actually resolves.
      return reload.promise.then((result) => {
        isActive.value = true
        return result
      })
    })
    const isPluginActive = vi.fn(() => isActive.value)
    const audioEngine = { loadPlugin, isPluginActive } as any
    const map = new EffectChainMap<string>(audioEngine, () => 'master')

    const initial = map.declare('key', baseSpec, () => 'dup')
    initialLoad.resolve(loadResult)
    await initial

    isActive.value = false
    const first = map.declare('key', baseSpec, () => 'dup')
    const second = map.declare('key', baseSpec, () => 'dup')
    reload.resolve(loadResult)

    await Promise.all([first, second])

    // Serialized: the second call's self-heal check must observe the first
    // call's completed reload, so it must not issue its own duplicate RPC.
    expect(loadCallCount).toBe(2)
  })
})

describe('EffectChainMap instanceId (#527 Important 2)', () => {
  it('generates "<receiverId>/<normalizedName>#<occurrence>" for a normal declaration', async () => {
    const loadPlugin = vi.fn().mockResolvedValue(loadResult)
    const audioEngine = { loadPlugin } as any
    const map = new EffectChainMap<string>(audioEngine, (name) => `seq:${name}`)

    await map.declare('kick', baseSpec, () => 'dup')

    expect(map.chainFor('kick')[0]?.instanceId).toBe('seq:kick/echo#1')
  })

  it('preserves the existing instanceId across a self-heal reload rather than minting a new one', async () => {
    // Occurrence-based minting alone would recompute to the SAME string here
    // (the reload replaces the sole slot with the same normalizedName, so
    // `occurrence` is 1 either way) — that would make this test pass even if
    // preservation were dropped. To actually exercise "preserved, not
    // recomputed", make `receiverId(key)` return a DIFFERENT string on the
    // second call (as it would after e.g. a sequence rename) — if the
    // instanceId were minted fresh, it would pick up that new receiverId.
    const loadPlugin = vi.fn().mockResolvedValue(loadResult)
    const isPluginActive = vi.fn().mockReturnValue(false)
    const audioEngine = { loadPlugin, isPluginActive } as any
    let receiverIdCalls = 0
    const receiverId = vi.fn().mockImplementation((name: string) => {
      receiverIdCalls += 1
      return receiverIdCalls === 1 ? `seq:${name}` : `seq:${name}-RENAMED`
    })
    const map = new EffectChainMap<string>(audioEngine, receiverId)

    await map.declare('kick', baseSpec, () => 'dup')
    const before = map.chainFor('kick')[0]?.instanceId

    // Idempotent re-declaration with the engine reporting inactive (respawn) —
    // takes the self-heal reload path.
    await map.declare('kick', baseSpec, () => 'dup')
    const after = map.chainFor('kick')[0]?.instanceId

    expect(before).toBe('seq:kick/echo#1')
    // Must stay pinned to the original, NOT pick up the "-RENAMED" receiverId
    // that a fresh mint would have produced.
    expect(after).toBe(before)
    expect(loadPlugin).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['seq', (name: string) => `seq:${name}`, 'kick', 'seq:kick/echo#1'],
    ['master (no key)', () => 'master', 'master', 'master/echo#1'],
    ['instrument (no key)', () => 'instrument', 'instrument', 'instrument/echo#1'],
    ['mixer <kind>:<name>', (name: string) => `sum:${name}`, 'drums', 'sum:drums/echo#1'],
  ])(
    'receiver prefix for %s differs per manager shape',
    async (_label, receiverId, key, expected) => {
      const loadPlugin = vi.fn().mockResolvedValue(loadResult)
      const audioEngine = { loadPlugin } as any
      const map = new EffectChainMap<string>(audioEngine, receiverId)

      await map.declare(key, baseSpec, () => 'dup')

      expect(map.chainFor(key)[0]?.instanceId).toBe(expected)
    },
  )
})

describe('EffectChainMap.declare() role mismatch (optional pin, not a defect)', () => {
  it('rejects a second declaration at the same key whose role differs from the existing one', async () => {
    // Not reachable through any manager today (each manager only ever declares
    // a single fixed role for a given EffectChainMap instance), but the map
    // itself is generic over role — pin the branch directly since it's cheap.
    const loadPlugin = vi.fn().mockResolvedValue(loadResult)
    const audioEngine = { loadPlugin } as any
    const map = new EffectChainMap<string>(audioEngine, () => 'master')

    await map.declare('key', baseSpec, () => 'dup')
    await expect(
      map.declare('key', { ...baseSpec, role: 'instrument' }, () => 'dup'),
    ).rejects.toThrow('dup')
  })
})

describe('normalizePluginInstanceName (#527 Important 3)', () => {
  it('extracts the basename', () => {
    expect(normalizePluginInstanceName('/plugins/vendor/Echo.clap')).toBe('Echo')
  })

  it('normalizes to NFC', () => {
    // "é" as combining e + acute accent (NFD) vs precomposed (NFC).
    const nfd = 'caf\u0065\u0301.clap'
    expect(normalizePluginInstanceName(nfd)).toBe('café'.normalize('NFC'))
  })

  it('strips a known plugin extension via KNOWN_PLUGIN_EXTENSIONS', () => {
    expect(normalizePluginInstanceName('Synth.vst3')).toBe('Synth')
    expect(normalizePluginInstanceName('Synth.clap')).toBe('Synth')
    expect(normalizePluginInstanceName('Synth.component')).toBe('Synth')
  })

  it('strips an uppercase extension case-insensitively', () => {
    expect(normalizePluginInstanceName('Synth.VST3')).toBe('Synth')
  })

  it('keeps dots inside the name and strips only the trailing known extension', () => {
    expect(normalizePluginInstanceName('TAL.Reverb.4.vst3')).toBe('TAL.Reverb.4')
  })

  it('leaves a catalog name with no extension untouched', () => {
    expect(normalizePluginInstanceName('TAL Reverb 4')).toBe('TAL Reverb 4')
  })

  it('handles a trailing slash (bundle directory) by basenaming the parent', () => {
    expect(normalizePluginInstanceName('/plugins/Synth.vst3/')).toBe('Synth')
  })

  it('handles a Windows-style backslash path on POSIX (Minor fix)', () => {
    // path.basename() alone does not split on `\` when running on POSIX, so a
    // Windows-style path used to yield "C:\Plugins\Synth" (backslashes and
    // drive letter intact) instead of "Synth".
    expect(normalizePluginInstanceName('C:\\Plugins\\Synth.vst3')).toBe('Synth')
  })
})
