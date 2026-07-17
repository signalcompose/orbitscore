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

interface EffectSlotEntry {
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

/**
 * key ごとに 1 つの effect 宣言（v1: チェーン不可）を持つ slot 集合。
 * `declare()` が冪等再宣言・respawn 後 self-heal（`isPluginActive === false` で再ロード）・
 * 失敗時の宣言ロールバック（自分が入れた宣言のみ削除）を一手に実装する。
 */
export class EffectSlotMap<K> {
  private readonly slots = new Map<K, EffectSlotEntry>()

  constructor(private readonly audioEngine: AudioEngine) {}

  has(key: K): boolean {
    return this.slots.has(key)
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
    resolvedPath: string,
    pluginId: string | undefined,
    duplicateError: () => Error,
  ): Promise<void> {
    const existing = this.slots.get(key)
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        // Self-heal: respawn 後の復元失敗で engine 側だけ宣言が消えている場合、
        // 冪等パスで false success を返さず再ロードする（PluginEffectManager 由来の
        // silent-failure guard）。isPluginActive を持たない engine（SC/素の mock）は
        // 従来の no-op 冪等のまま。
        if (this.audioEngine.isPluginActive?.('effect', bus) === false) {
          await this.issueLoad(key, bus, resolvedPath, pluginId)
        }
        return
      }
      throw duplicateError()
    }
    await this.issueLoad(key, bus, resolvedPath, pluginId)
  }

  private async issueLoad(
    key: K,
    bus: string | undefined,
    resolvedPath: string,
    pluginId: string | undefined,
  ): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    // bus 無し（master insert）は 3 引数のまま呼ぶ（既存の呼び出し契約を変えない —
    // explicit undefined でも実 engine は等価だが、契約をピンするテスト/モックがある）。
    const load = (
      bus === undefined
        ? this.audioEngine.loadPlugin(resolvedPath, pluginId, 'effect')
        : this.audioEngine.loadPlugin(resolvedPath, pluginId, 'effect', bus)
    ).then(() => undefined)
    const entry: EffectSlotEntry = { resolvedPath, pluginId, load }
    this.slots.set(key, entry)
    try {
      await load
    } catch (err) {
      if (this.slots.get(key) === entry) this.slots.delete(key)
      throw err
    }
  }
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
