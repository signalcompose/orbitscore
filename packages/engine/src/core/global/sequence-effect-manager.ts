import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { resolvePluginPath, validatePluginExtension } from './plugin-resolver'

/**
 * Bus name prefix for the daemon's default per-sequence insert bus pool. Must
 * match `DEFAULT_EFFECT_BUS_POOL_PREFIX` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` — changing one requires
 * changing the other (#434 S3).
 */
export const SEQUENCE_EFFECT_BUS_PREFIX = 'seq-bus-'

/**
 * v1 concurrent-insert cap. Must match `DEFAULT_EFFECT_BUS_POOL_SIZE` in
 * `rust/crates/orbit-audio-daemon/src/engine_wrap.rs` (PH.2b: "同時に持てる
 * シーケンス数には上限がある（既定 8）").
 */
export const SEQUENCE_EFFECT_BUS_POOL_SIZE = 8

interface SeqEffectDeclaration {
  bus: string
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

/**
 * Owns the per-sequence insert (`seq.effect()` — PH.2b / #434 S3) declarations:
 * one bus per sequence, allocated from the daemon's default bus pool
 * (`seq-bus-0`.."seq-bus-7"). Mirrors `PluginEffectManager` /
 * `PluginInstrumentManager`'s eager-load + idempotent-redeclare pattern, keyed
 * by sequence name instead of a single master slot.
 */
export class SequenceEffectManager {
  private readonly declarations = new Map<string, SeqEffectDeclaration>()
  private nextBusIndex = 0
  /**
   * 失敗した宣言から返却された bus 名の free-list。ライブコーディングでは
   * 「typo → 失敗 → 直して再宣言」が普通に起きるため、失敗が pool を恒久消費すると
   * 数回のリトライで枯渇する（#461 review Important）。返却された名前を優先的に再利用する。
   */
  private freedBuses: string[] = []

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {}

  hasDeclaration(sequenceName: string): boolean {
    return this.declarations.has(sequenceName)
  }

  /** Whether any sequence has declared an insert (used by `Global.linkAudio()`'s v1 exclusion gate). */
  hasAnyDeclaration(): boolean {
    return this.declarations.size > 0
  }

  getBus(sequenceName: string): string | undefined {
    return this.declarations.get(sequenceName)?.bus
  }

  /** Declares (or idempotently re-declares) the insert for `sequenceName`. Returns the allocated bus name. */
  async effect(sequenceName: string, spec: string, pluginId?: string): Promise<string> {
    // Order mirrors PluginEffectManager.effect(): validate the spec, gate on
    // LinkAudio, then resolve the path (see that file's doc comment for why).
    validatePluginExtension(spec, 'effect')

    if (this.linkAudioManager.isEnabled()) {
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() cannot be used while LinkAudio is enabled in v1.`,
      )
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'effect',
    )

    const existing = this.declarations.get(sequenceName)
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        // Self-heal on stale cache after a daemon respawn (see PluginEffectManager
        // for the full rationale). Engines without isPluginActive keep the old
        // no-op idempotent behavior.
        if (this.audioEngine.isPluginActive?.('effect', existing.bus) === false) {
          await this.issueLoad(sequenceName, existing.bus, resolvedPath, pluginId)
        }
        return existing.bus
      }
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() supports one insert per sequence in v1; ` +
          `chains (multiple inserts) are reserved for future support.`,
      )
    }

    const bus = this.freedBuses.pop() ?? this.allocateFreshBus(sequenceName)
    try {
      await this.issueLoad(sequenceName, bus, resolvedPath, pluginId)
    } catch (err) {
      // ロールバック: 失敗した宣言の bus を free-list に返す（daemon 側も activation を
      // 巻き戻すため、両側の状態が対称に戻る）。
      this.freedBuses.push(bus)
      throw err
    }
    return bus
  }

  private allocateFreshBus(sequenceName: string): string {
    if (this.nextBusIndex >= SEQUENCE_EFFECT_BUS_POOL_SIZE) {
      throw new Error(
        `Sequence '${sequenceName}': seq.effect() insert bus pool exhausted — v1 supports at ` +
          `most ${SEQUENCE_EFFECT_BUS_POOL_SIZE} sequences with a concurrent insert.`,
      )
    }
    const bus = `${SEQUENCE_EFFECT_BUS_PREFIX}${this.nextBusIndex}`
    this.nextBusIndex += 1
    return bus
  }

  private async issueLoad(
    sequenceName: string,
    bus: string,
    resolvedPath: string,
    pluginId: string | undefined,
  ): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    const load = this.audioEngine
      .loadPlugin(resolvedPath, pluginId, 'effect', bus)
      .then(() => undefined)
    const declaration: SeqEffectDeclaration = { bus, resolvedPath, pluginId, load }
    this.declarations.set(sequenceName, declaration)
    try {
      await load
    } catch (err) {
      if (this.declarations.get(sequenceName) === declaration) {
        this.declarations.delete(sequenceName)
      }
      throw err
    }
  }
}
