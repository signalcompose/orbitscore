import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { resolvePluginPath, validatePluginExtension } from './plugin-resolver'

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

interface MixerBusDeclaration {
  bus: string
}

interface MixerInsertDeclaration {
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

/** Returned by `global.sum(name)` / `global.aux(name)` and the bare `sum(name)` / `aux(name)` reference. */
export interface MixerBusHandle {
  readonly bus: string
  /** Declares (or idempotently re-declares) the bus's own insert (MX.2/MX.3: v1 one insert). */
  effect(path: string, pluginId?: string): Promise<MixerBusHandle>
}

/**
 * Owns `global.sum(name)` / `global.aux(name)` declarations (MX.2/MX.3, #459/#453 M3): one
 * bus per declared name, allocated from the daemon's default sum/aux bus pools
 * (`sum-bus-0..3` / `aux-bus-0..3`). Mirrors `SequenceEffectManager`'s eager-load +
 * idempotent-redeclare pattern, but keyed by declared name in two independent namespaces
 * (sum vs. aux) instead of by sequence name.
 *
 * The bus's own insert (`sum("drum").effect(...)`) reuses the SAME `LoadPlugin` endpoint
 * as `seq.effect()` (`role: 'effect', bus: <name>`) — the daemon does not distinguish insert
 * vs. sum vs. aux kind when attaching a plugin to a bus (only `SetBusRouting` enforces kind),
 * so no new engine-side wiring is needed for this half of M3.
 */
export class MixerManager {
  private readonly sumBuses = new Map<string, MixerBusDeclaration>()
  private readonly auxBuses = new Map<string, MixerBusDeclaration>()
  private readonly sumInserts = new Map<string, MixerInsertDeclaration>() // keyed by bus name
  private readonly auxInserts = new Map<string, MixerInsertDeclaration>() // keyed by bus name
  private nextSumIndex = 0
  private nextAuxIndex = 0
  // Mirrors SequenceEffectManager's free-list rationale (#461 review Important): a failed
  // declaration must not permanently consume a pool slot.
  private freedSumBuses: string[] = []
  private freedAuxBuses: string[] = []

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {}

  /** Whether any sum or aux bus has been declared (used by `Global.linkAudio()`'s v1 exclusion gate). */
  hasAnyDeclaration(): boolean {
    return this.sumBuses.size > 0 || this.auxBuses.size > 0
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
    return this.sumBuses.get(name)?.bus
  }

  /** Resolves a declared aux bus name to its allocated bus, or undefined if undeclared. */
  resolveAux(name: string): string | undefined {
    return this.auxBuses.get(name)?.bus
  }

  private declareBus(kind: MixerKind, name: string): MixerBusHandle {
    if (!name || !name.trim()) {
      throw new Error(`global.${kind}(name) requires a non-empty name.`)
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error(`global.${kind}() cannot be used while LinkAudio is enabled in v1.`)
    }

    const buses = kind === 'sum' ? this.sumBuses : this.auxBuses
    let declaration = buses.get(name)
    if (!declaration) {
      const freed = kind === 'sum' ? this.freedSumBuses : this.freedAuxBuses
      const bus = freed.pop() ?? this.allocateFreshBus(kind, name)
      declaration = { bus }
      buses.set(name, declaration)
    }
    return this.makeHandle(kind, name, declaration.bus)
  }

  private allocateFreshBus(kind: MixerKind, name: string): string {
    const index = kind === 'sum' ? this.nextSumIndex : this.nextAuxIndex
    if (index >= MIXER_BUS_POOL_SIZE) {
      throw new Error(
        `global.${kind}("${name}"): ${kind} bus pool exhausted — v1 supports at most ` +
          `${MIXER_BUS_POOL_SIZE} concurrent ${kind} buses.`,
      )
    }
    if (kind === 'sum') {
      this.nextSumIndex += 1
      return `${SUM_BUS_PREFIX}${index}`
    }
    this.nextAuxIndex += 1
    return `${AUX_BUS_PREFIX}${index}`
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
    // Order mirrors PluginEffectManager.effect() / SequenceEffectManager.effect(): validate
    // the spec, gate on LinkAudio (declaration order can't produce this in practice since
    // declareBus() already gated, but a respawn/reload path could re-run effect() alone),
    // then resolve the path.
    validatePluginExtension(spec, 'effect')

    if (this.linkAudioManager.isEnabled()) {
      throw new Error(
        `${kind}("${name}").effect() cannot be used while LinkAudio is enabled in v1.`,
      )
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'effect',
    )

    const inserts = kind === 'sum' ? this.sumInserts : this.auxInserts
    const existing = inserts.get(bus)
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        if (this.audioEngine.isPluginActive?.('effect', bus) === false) {
          await this.issueLoad(kind, bus, resolvedPath, pluginId)
        }
        return this.makeHandle(kind, name, bus)
      }
      throw new Error(
        `${kind}("${name}").effect() supports one insert per bus in v1; chains (multiple ` +
          `inserts) are reserved for future support.`,
      )
    }

    await this.issueLoad(kind, bus, resolvedPath, pluginId)
    return this.makeHandle(kind, name, bus)
  }

  private async issueLoad(
    kind: MixerKind,
    bus: string,
    resolvedPath: string,
    pluginId: string | undefined,
  ): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    const inserts = kind === 'sum' ? this.sumInserts : this.auxInserts
    const load = this.audioEngine
      .loadPlugin(resolvedPath, pluginId, 'effect', bus)
      .then(() => undefined)
    const declaration: MixerInsertDeclaration = { resolvedPath, pluginId, load }
    inserts.set(bus, declaration)
    try {
      await load
    } catch (err) {
      if (inserts.get(bus) === declaration) inserts.delete(bus)
      throw err
    }
  }
}
