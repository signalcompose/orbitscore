/**
 * Shared building blocks for the three effect-declaring managers (#468):
 * `PluginEffectManager`（master insert）/ `SequenceEffectManager`（per-seq insert）/
 * `MixerManager`（sum・aux insert）。各 manager に ~15 行ずつ複製されていた
 * 「validate → LinkAudio gate → resolve」「冪等再宣言 + respawn 後 self-heal +
 * install/rollback」「prefix 連番 + free-list の bus pool」をここに一本化する。
 */

import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import {
  isPluginPathSpec,
  resolvePluginSpec,
  validatePluginExtension,
  type ResolvedPluginSpec,
} from './plugin-resolver'

/**
 * effect spec の共通前処理。順序は load-bearing（PluginEffectManager 由来）:
 * spec 検証 → LinkAudio gate → パス解決。未保存ファイル等で resolve が
 * 「cannot resolve」を投げる前に、より本質的な LinkAudio 競合エラーを出すため。
 * 拡張子検証（`validatePluginExtension`）は path-direct spec にのみ適用する
 * （#463 C2: カタログ名はここで弾かず、`resolvePluginSpec` のカタログ解決に委ねる）。
 */
export function resolveEffectSpec(
  spec: string,
  pluginId: string | undefined,
  deps: { audioManager: AudioManager; linkAudioManager: LinkAudioManager },
  linkAudioErrorMessage: string,
  catalogPathOverride?: string,
): ResolvedPluginSpec {
  if (isPluginPathSpec(spec)) {
    validatePluginExtension(spec, 'effect')
  }
  if (deps.linkAudioManager.isEnabled()) {
    throw new Error(linkAudioErrorMessage)
  }
  return resolvePluginSpec(
    spec,
    pluginId,
    deps.audioManager.getAudioPaths(),
    deps.audioManager.getDocumentDirectory(),
    'effect',
    catalogPathOverride,
  )
}

export type PluginInstanceId = string

interface PluginSlotBase {
  readonly instanceId: PluginInstanceId
  readonly normalizedName: string
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

export interface EffectSlot extends PluginSlotBase {
  readonly role: 'effect'
  readonly bus: string | undefined
}

export interface InstrumentSlot extends PluginSlotBase {
  readonly role: 'instrument'
}

export type PluginSlot = EffectSlot | InstrumentSlot

export class EffectSlotLimitError extends Error {
  // Unreferenced within this codebase today — kept for the typed-error contract.
  // S4/#522's Rust protocol extension is the expected consumer (commit db01cd8).
  readonly code = 'EFFECT_SLOT_LIMIT'

  constructor(message: string) {
    super(message)
    this.name = 'EffectSlotLimitError'
  }
}

/**
 * key ごとに plugin chain を持つ宣言集合。PR-1a では上限 1 を維持するが、
 * 登記自体は複数 insert と instrument role を表現できる形にしておく。
 * `declare()` が冪等再宣言・respawn 後 self-heal（`isPluginActive === false` で再ロード）・
 * 失敗時の宣言ロールバック（自分が入れた宣言のみ削除）を一手に実装する。
 */
export class EffectChainMap<K> {
  private readonly chains = new Map<K, PluginSlot[]>()

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly receiverId: (key: K) => string,
    private readonly maxLength = 1,
  ) {}

  has(key: K): boolean {
    return (this.chains.get(key)?.length ?? 0) > 0
  }

  /**
   * 宣言する（または冪等に再宣言する）。同一 spec の再宣言は既存 load を待ち、
   * respawn 後の stale cache（`isPluginActive?.('effect', bus) === false`）なら
   * 再ロードで self-heal する。異なる spec は `duplicateError` を throw（v1: 1 slot）。
   * 新規宣言の load 失敗は宣言を取り除いて rethrow（呼び出し側は catch で bus の
   * 返却等の後始末を行える）。
   */
  async declare(
    key: K,
    bus: string | undefined,
    role: 'effect' | 'instrument',
    normalizedName: string,
    resolvedPath: string,
    pluginId: string | undefined,
    duplicateError: () => Error,
  ): Promise<void> {
    const chain = this.chains.get(key) ?? []
    const existing = chain[0]
    if (existing) {
      if (
        existing.role === role &&
        existing.resolvedPath === resolvedPath &&
        existing.pluginId === pluginId
      ) {
        await existing.load
        // Self-heal: respawn 後の復元失敗で engine 側だけ宣言が消えている場合、
        // 冪等パスで false success を返さず再ロードする（PluginEffectManager 由来の
        // silent-failure guard）。isPluginActive を持たない engine（SC/素の mock）は
        // 従来の no-op 冪等のまま。
        if (this.audioEngine.isPluginActive?.(role, bus) === false) {
          await this.issueLoad(key, bus, role, normalizedName, resolvedPath, pluginId, existing)
        }
        return
      }
      const error = duplicateError()
      throw role === 'effect' ? new EffectSlotLimitError(error.message) : error
    }
    if (chain.length >= this.maxLength) {
      const error = duplicateError()
      throw role === 'effect' ? new EffectSlotLimitError(error.message) : error
    }
    await this.issueLoad(key, bus, role, normalizedName, resolvedPath, pluginId)
  }

  private async issueLoad(
    key: K,
    bus: string | undefined,
    role: 'effect' | 'instrument',
    normalizedName: string,
    resolvedPath: string,
    pluginId: string | undefined,
    replacing?: PluginSlot,
  ): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    // bus 無し（master insert）は 3 引数のまま呼ぶ（既存の呼び出し契約を変えない —
    // explicit undefined でも実 engine は等価だが、契約をピンするテスト/モックがある）。
    const load = (
      bus === undefined
        ? this.audioEngine.loadPlugin(resolvedPath, pluginId, role)
        : this.audioEngine.loadPlugin(resolvedPath, pluginId, role, bus)
    ).then(() => undefined)
    const chain = this.chains.get(key) ?? []
    const occurrence =
      chain.filter((slot) => slot !== replacing && slot.normalizedName === normalizedName).length +
      1
    const instanceId =
      replacing?.instanceId ?? `${this.receiverId(key)}/${normalizedName}#${occurrence}`
    const entry: PluginSlot =
      role === 'effect'
        ? { role, bus, instanceId, normalizedName, resolvedPath, pluginId, load }
        : { role, instanceId, normalizedName, resolvedPath, pluginId, load }
    const nextChain = replacing
      ? chain.map((slot) => (slot === replacing ? entry : slot))
      : [...chain, entry]
    this.chains.set(key, nextChain)
    try {
      await load
    } catch (err) {
      const current = this.chains.get(key)
      if (current?.includes(entry)) {
        const rolledBack = current.filter((slot) => slot !== entry)
        if (rolledBack.length === 0) this.chains.delete(key)
        else this.chains.set(key, rolledBack)
      }
      throw err
    }
  }
}

/** SC.5 の instance identity に使う plugin 名を安定化する。 */
export function normalizePluginInstanceName(spec: string): string {
  const unqualified = spec.trim().normalize('NFC').split('/').pop() ?? spec
  return unqualified.replace(/\.(?:clap|vst3|component)$/i, '')
}

/**
 * `<prefix><n>` 連番 + free-list の bus pool（SequenceEffectManager / MixerManager 由来）。
 * 失敗した宣言が pool を恒久消費しないよう、返却された名前を優先再利用する
 * （#461 review Important の free-list 根拠）。
 */
export class BusPool {
  private nextIndex = 0
  private readonly freed: string[] = []

  constructor(
    private readonly prefix: string,
    private readonly size: number,
    private readonly exhaustedMessage: (name: string) => string,
  ) {}

  /** free-list 優先で bus 名を確保する。枯渇時は exhaustedMessage で throw。 */
  acquire(name: string): string {
    const freed = this.freed.pop()
    if (freed !== undefined) return freed
    if (this.nextIndex >= this.size) {
      throw new Error(this.exhaustedMessage(name))
    }
    const bus = `${this.prefix}${this.nextIndex}`
    this.nextIndex += 1
    return bus
  }

  /** 失敗した宣言の bus を pool へ返す。 */
  release(bus: string): void {
    this.freed.push(bus)
  }
}
