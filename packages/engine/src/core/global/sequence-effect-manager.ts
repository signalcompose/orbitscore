import type { AudioEngine } from '../../audio/types'
import { createStatePathFallback } from '../project-state-store'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import {
  BusPool,
  EffectChainMap,
  normalizePluginInstanceName,
  resolveEffectSpec,
  type EffectChainMapOptions,
  type PluginSlot,
} from './effect-slot'

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

/**
 * Owns the per-sequence insert (`seq.effect()` — PH.2b / #434 S3) declarations:
 * one bus per sequence, allocated from the daemon's default bus pool
 * (`seq-bus-0`.."seq-bus-7"). 実装は #468 の共通基盤（`BusPool` + `EffectChainMap`）に
 * 委譲し、この manager 固有なのは「passthrough bus（`ensureBus()` — plugin 未ロードの
 * routing 用割当・MX.4）と insert の分離、および昇格失敗時に bus を返却しない
 * ロールバック」だけ。
 */
export class SequenceEffectManager {
  /** sequenceName → 割当 bus（passthrough 含む）。routing（output/send）が参照する。 */
  private readonly buses = new Map<string, string>()
  /** sequenceName → 実 insert 宣言（passthrough は含まない）。 */
  private readonly slots: EffectChainMap<string>
  private readonly pool = new BusPool(
    SEQUENCE_EFFECT_BUS_PREFIX,
    SEQUENCE_EFFECT_BUS_POOL_SIZE,
    (name) =>
      `Sequence '${name}': seq.effect() insert bus pool exhausted — v1 supports at ` +
      `most ${SEQUENCE_EFFECT_BUS_POOL_SIZE} sequences with a concurrent insert.`,
  )

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
    replacement: NonNullable<EffectChainMapOptions<string>['replacement']>,
  ) {
    this.slots = new EffectChainMap(audioEngine, (sequenceName) => `seq:${sequenceName}`, {
      externalReceiverId: (sequenceName) => sequenceName,
      statePathFallback: createStatePathFallback(audioManager),
      replacement,
    })
  }

  hasDeclaration(sequenceName: string): boolean {
    return this.buses.has(sequenceName)
  }

  /** Whether any sequence has declared an insert (used by `Global.linkAudio()`'s v1 exclusion gate). */
  hasAnyDeclaration(): boolean {
    return this.buses.size > 0
  }

  getBus(sequenceName: string): string | undefined {
    return this.buses.get(sequenceName)
  }

  chainFor(sequenceName: string): readonly PluginSlot[] {
    return this.slots.chainFor(sequenceName)
  }

  /** Sequence names with a loaded insert (passthrough-only buses are excluded). */
  keys(): readonly string[] {
    return this.slots.keys()
  }

  /**
   * Ensures a per-sequence bus is allocated WITHOUT loading a plugin into it (MX.4/#459/#453
   * M3): `seq.output(sum)` / `seq.send(aux, gain)` need a bus to route from even when
   * `seq.effect()` was never declared (a "pass-through insert" — DAW-style track with no
   * insert plugin but still a routable channel). Idempotent — returns the existing bus
   * whether it is a passthrough-only allocation or already has a real insert loaded via
   * `effect()`. If `effect()` is called later for the same sequence, it upgrades this same
   * bus in place instead of allocating a second one (see `effect()` below).
   */
  ensureBus(sequenceName: string): string {
    const existing = this.buses.get(sequenceName)
    if (existing) return existing
    const bus = this.pool.acquire(sequenceName)
    this.buses.set(sequenceName, bus)
    return bus
  }

  /** Declares (or idempotently re-declares) the insert for `sequenceName`. Returns the allocated bus name. */
  async effect(sequenceName: string, spec: string, pluginId?: string): Promise<string> {
    const resolved = resolveEffectSpec(
      spec,
      pluginId,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      `Sequence '${sequenceName}': seq.effect() cannot be used while LinkAudio is enabled in v1.`,
    )

    const duplicateMessage = () =>
      `Sequence '${sequenceName}': seq.effect() supports one insert per sequence in v1; ` +
      `chains (multiple inserts) are reserved for future support.`

    // passthrough（ensureBus 由来・insert 未ロード）は「既存 insert」ではない — 同じ bus を
    // その場で昇格する。実 insert が既にあれば slots.declare が冪等/self-heal/重複エラーを担う。
    const hadBus = this.buses.has(sequenceName)
    const bus = this.buses.get(sequenceName) ?? this.pool.acquire(sequenceName)
    this.buses.set(sequenceName, bus)
    try {
      await this.slots.declare(
        sequenceName,
        {
          role: 'effect',
          bus,
          normalizedName: normalizePluginInstanceName(spec),
          resolvedPath: resolved.path,
          pluginId: resolved.pluginId,
        },
        duplicateMessage,
      )
    } catch (err) {
      if (!hadBus) {
        // この呼び出しで新規に確保した bus の load 失敗: free-list へ返す（daemon 側も
        // activation を巻き戻すため、両側の状態が対称に戻る）。
        //
        // ただし直列化キュー（#527 review Important 1）が生んだ新しい成功経路がある:
        // 同一 sequenceName への `effect()` を await せず連打すると、後続呼び出しは
        // 「hadBus === true」（この呼び出しが確保した bus を同期的に見て再利用）で
        // pending キューに並ぶ。この呼び出しの declare() が失敗しても、後続はキューの
        // 順番で独立に再試行し、成功すればこの bus に生きた宣言を持つ。`!hadBus` の
        // 時点の判定はもう有効ではない — キューがまだ流れている最中に同期的に
        // `has()` を見ると、後続の `declareBody()` がまだ走っていない可能性がある
        // タイミングを掴んで「誰も使っていない」と誤判定しうる（#527 review round 3）。
        // `slots.settled()` でこの key へのキューが完全に片付くのを待ってから、
        // 真に誰も宣言を持っていない場合だけ解放する。
        await this.slots.settled(sequenceName)
        if (!this.slots.has(sequenceName)) {
          this.buses.delete(sequenceName)
          this.pool.release(bus)
        }
      }
      // 既存 bus（passthrough 昇格 / self-heal 再ロード）の失敗は bus を返却しない —
      // seq.output()/seq.send() の routing がその bus を参照し続けているため。
      // 【意図的な旧実装との差分】旧実装は self-heal 再ロード失敗で宣言ごと bus を消して
      // いた（hasDeclaration/hasAnyDeclaration が false に反転 = LinkAudio 排他ゲートが
      // 緩む + routing が参照中の bus 名が pool 外へ漏失）。本実装は bus を温存する —
      // MixerManager の従来挙動とも一致（#472 レビューで確認・回帰テストでピン留め済み）。
      throw err
    }
    return bus
  }
}
