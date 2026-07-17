import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { BusPool, EffectSlotMap, resolveEffectSpec } from './effect-slot'

/**
 * `sum-bus-<n>` / `aux-bus-<n>` default pool prefixes. Must match
 * `DEFAULT_SUM_BUS_POOL_PREFIX` / `DEFAULT_AUX_BUS_POOL_PREFIX` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` (MX.4, #459/#453 M3) — changing
 * one requires changing the other.
 */
export const SUM_BUS_PREFIX = 'sum-bus-'
export const AUX_BUS_PREFIX = 'aux-bus-'

/**
 * v1 cap: at most 4 sum buses and 4 aux buses concurrently declared. Must match
 * `DEFAULT_SUM_BUS_POOL_SIZE` / `DEFAULT_AUX_BUS_POOL_SIZE` in `engine_wrap.rs`.
 */
export const MIXER_BUS_POOL_SIZE = 4

type MixerKind = 'sum' | 'aux'

/** Returned by `global.sum(name)` / `global.aux(name)` and the bare `sum(name)` / `aux(name)` reference. */
export interface MixerBusHandle {
  readonly bus: string
  /** Declares (or idempotently re-declares) the bus's own insert (MX.2/MX.3: v1 one insert). */
  effect(path: string, pluginId?: string): Promise<MixerBusHandle>
}

/** kind ごと（sum / aux）の宣言テーブル一式。 */
interface KindState {
  readonly buses: Map<string, string> // declared name → bus
  readonly inserts: EffectSlotMap<string> // keyed by bus name
  readonly pool: BusPool
}

/**
 * Owns `global.sum(name)` / `global.aux(name)` declarations (MX.2/MX.3, #459/#453 M3): one
 * bus per declared name, allocated from the daemon's default sum/aux bus pools
 * (`sum-bus-0..3` / `aux-bus-0..3`). 実装は #468 の共通基盤（`BusPool` + `EffectSlotMap`）
 * に委譲し、sum / aux は同型の `KindState` 2 面として持つ。
 *
 * The bus's own insert (`sum("drum").effect(...)`) reuses the SAME `LoadPlugin` endpoint
 * as `seq.effect()` (`role: 'effect', bus: <name>`) — the daemon does not distinguish insert
 * vs. sum vs. aux kind when attaching a plugin to a bus (only `SetBusRouting` enforces kind),
 * so no new engine-side wiring is needed for this half of M3.
 */
export class MixerManager {
  private readonly kinds: Record<MixerKind, KindState>

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {
    const makeKind = (kind: MixerKind, prefix: string): KindState => ({
      buses: new Map(),
      inserts: new EffectSlotMap(audioEngine),
      pool: new BusPool(
        prefix,
        MIXER_BUS_POOL_SIZE,
        (name) =>
          `global.${kind}("${name}"): ${kind} bus pool exhausted — v1 supports at most ` +
          `${MIXER_BUS_POOL_SIZE} concurrent ${kind} buses.`,
      ),
    })
    this.kinds = { sum: makeKind('sum', SUM_BUS_PREFIX), aux: makeKind('aux', AUX_BUS_PREFIX) }
  }

  /** Whether any sum or aux bus has been declared (used by `Global.linkAudio()`'s v1 exclusion gate). */
  hasAnyDeclaration(): boolean {
    return this.kinds.sum.buses.size > 0 || this.kinds.aux.buses.size > 0
  }

  /** Declares (or idempotently re-declares) a sum/group bus. MX.2: sum nesting is not supported in v1. */
  sum(name: string): MixerBusHandle {
    return this.declareBus('sum', name)
  }

  /** Declares (or idempotently re-declares) an aux/return bus. */
  aux(name: string): MixerBusHandle {
    return this.declareBus('aux', name)
  }

  /** Resolves a declared sum bus name to its allocated bus, or undefined if undeclared. */
  resolveSum(name: string): string | undefined {
    return this.kinds.sum.buses.get(name)
  }

  /** Resolves a declared aux bus name to its allocated bus, or undefined if undeclared. */
  resolveAux(name: string): string | undefined {
    return this.kinds.aux.buses.get(name)
  }

  private declareBus(kind: MixerKind, name: string): MixerBusHandle {
    if (!name || !name.trim()) {
      throw new Error(`global.${kind}(name) requires a non-empty name.`)
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error(`global.${kind}() cannot be used while LinkAudio is enabled in v1.`)
    }

    const state = this.kinds[kind]
    let bus = state.buses.get(name)
    if (bus === undefined) {
      bus = state.pool.acquire(name)
      state.buses.set(name, bus)
    }
    return this.makeHandle(kind, name, bus)
  }

  private makeHandle(kind: MixerKind, name: string, bus: string): MixerBusHandle {
    return {
      bus,
      effect: (path: string, pluginId?: string) => this.effectFor(kind, name, bus, path, pluginId),
    }
  }

  private async effectFor(
    kind: MixerKind,
    name: string,
    bus: string,
    spec: string,
    pluginId: string | undefined,
  ): Promise<MixerBusHandle> {
    // LinkAudio gate は declareBus() 済みでも維持する（respawn/reload 経路で effect() 単独が
    // 再実行され得るため — resolveEffectSpec が spec 検証 → gate → 解決の順序を保証する）。
    const resolved = resolveEffectSpec(
      spec,
      pluginId,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      `${kind}("${name}").effect() cannot be used while LinkAudio is enabled in v1.`,
    )
    await this.kinds[kind].inserts.declare(
      bus,
      bus,
      resolved.path,
      resolved.pluginId,
      () =>
        new Error(
          `${kind}("${name}").effect() supports one insert per bus in v1; chains (multiple ` +
            `inserts) are reserved for future support.`,
        ),
    )
    return this.makeHandle(kind, name, bus)
  }
}
