/**
 * Shared building blocks for the four effect/instrument-declaring managers (#468・
 * #527 で `PluginInstrumentManager` も合流):
 * `PluginEffectManager`（master insert）/ `SequenceEffectManager`（per-seq insert）/
 * `MixerManager`（sum・aux insert）/ `PluginInstrumentManager`（instrument）。各 manager に
 * ~15 行ずつ複製されていた「validate → LinkAudio gate → resolve」「冪等再宣言 + respawn 後
 * self-heal + install/rollback」「prefix 連番 + free-list の bus pool」をここに一本化する。
 */

import * as fs from 'fs'
import * as path from 'path'

import type { AudioEngine, EffectChainApplyRequest, EffectChainPlanStage } from '../../audio/types'
import { DaemonProtocolError } from '../../audio/rust-engine/errors'
import type { RackRecipe } from '../../signal-chain/rack'
import {
  projectStateStoreFor,
  stateFileNameForIdentity,
  type PluginStateIdentity,
} from '../project-state-store'

import { AudioManager } from './audio-manager'
import { effectReplaceNotice } from './effect-replace-notice'
import { LinkAudioManager } from './link-audio-manager'
import {
  KNOWN_PLUGIN_EXTENSIONS,
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
  readonly receiver: string
  /** SC.5 のレシーバ内同名出現順（0始まり）。UIH.5 chain indexとは別物。 */
  readonly occurrence: number
  readonly normalizedName: string
  readonly resolvedPath: string
  readonly pluginId?: string
  /** `.orbs` 宣言が明示した state path。冪等再宣言の同一性判定はこの値だけを見る。 */
  readonly declaredStatePath?: string
  /** 実際の load に渡した state path（明示値、または project.yaml のフォールバック）。 */
  readonly statePath?: string
  readonly load: Promise<void>
}

export interface EffectSlot extends PluginSlotBase {
  readonly role: 'effect'
  readonly bus: string | undefined
}

export interface InstrumentSlot extends PluginSlotBase {
  readonly role: 'instrument'
  readonly instance: string
}

export type PluginSlot = EffectSlot | InstrumentSlot

export type CatalogElement = EffectSlot & {
  readonly kind: 'catalog'
  readonly enabled: boolean
}

export interface StandardElement {
  readonly kind: 'standard'
  readonly role: 'effect'
  readonly bus: string | undefined
  readonly instanceId: PluginInstanceId
  readonly receiver: string
  readonly occurrence: number
  readonly normalizedName: string
  readonly name: string
  readonly params: Readonly<Record<string, number>>
  readonly enabled: boolean
}

export type ChainElement = CatalogElement | StandardElement
export type RegisteredChainElement = PluginSlot | StandardElement

export type RackSpec = readonly RackElementSpec[]
export type RackElementSpec = CatalogElementSpec | StandardElementSpec

export interface CatalogElementSpec {
  readonly kind: 'catalog'
  readonly normalizedName: string
  readonly resolvedPath: string
  readonly pluginId: string | undefined
  readonly declaredStatePath?: string
  readonly enabled: boolean
}

export interface StandardElementSpec {
  readonly kind: 'standard'
  readonly name: string
  readonly params: Readonly<Record<string, number>>
  readonly enabled: boolean
}

/** Resolve the interpreter's category-classified recipe immediately before applying a rack. */
export function resolveEffectRack(
  recipe: RackRecipe,
  deps: { audioManager: AudioManager; linkAudioManager: LinkAudioManager },
  linkAudioErrorMessage: string,
): RackSpec {
  if (recipe.some((element) => element.kind === 'layer')) {
    throw new Error(
      'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    )
  }
  return recipe.map((element): RackElementSpec => {
    if (element.kind === 'layer') {
      // Guarded above; keep the exhaustiveness local so TypeScript does not widen the map body.
      throw new Error(
        'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
      )
    }
    if (element.kind === 'standard') {
      return {
        kind: 'standard',
        name: element.name,
        params: { ...element.params },
        enabled: element.enabled,
      }
    }
    const qualifiedSpec = element.format
      ? `${element.format}/${element.spec}`
      : element.vendor
        ? `${element.vendor}/${element.spec}`
        : element.spec
    const resolved = resolveEffectSpec(qualifiedSpec, element.pluginId, deps, linkAudioErrorMessage)
    return {
      kind: 'catalog',
      normalizedName: normalizePluginInstanceName(element.spec),
      resolvedPath: resolved.path,
      pluginId: resolved.pluginId,
      enabled: element.enabled,
    }
  })
}

interface UncertainReplacement {
  readonly bus: string | undefined
  /** The forgotten effect tenant still deserves best-effort cleanup on recovery. */
  readonly forgottenSlot?: PluginSlot
}

/**
 * 1 宣言分の入力。`normalizedName`（instance identity 用の表示名）と `resolvedPath`
 * （ロード対象の実ファイル）は意味が全く違うのに同じ `string` なので、位置引数で並べず
 * 名前付きで受け取る（取り違えを型で防げないため）。
 */
export interface PluginDeclaration {
  readonly role: 'effect' | 'instrument'
  /** master insert は undefined。bus 付きは insert bus 名 */
  readonly bus: string | undefined
  readonly normalizedName: string
  readonly resolvedPath: string
  readonly pluginId: string | undefined
  /**
   * instrument slot pool の宛先（'instrument' role 専用・#540 P1）。note 側の
   * `plugin:<seqName>` port と同じ規約で、daemon がこの ID に slot を割り当てる。
   */
  readonly instance?: string
  /**
   * `.orbs` が明示した保存済みプラグイン state ファイルの解決済みパス（#540 P2）。
   * project.yaml から得る実効値とは分離し、冪等判定にはこの宣言値だけを使う。
   */
  readonly statePath?: string
}

export type PluginStatePathFallbackResolver = (
  identity: PluginStateIdentity,
) => Promise<string | undefined>

export interface EffectChainMapOptions<K> {
  readonly maxLength?: number
  readonly statePathFallback?: PluginStatePathFallbackResolver
  /**
   * project.yaml の SC.5 identity に使う外向き receiver 名。sequence effect / instrument
   * では `receiverId` が返す内部 namespace (`seq:<name>`) と異なり、master effect では
   * どちらも `'master'` で同値。
   */
  readonly externalReceiverId?: (key: K) => string
  /** Effect bus for ApplyEffectChain; undefined selects the master rack. */
  readonly effectBus?: (key: K) => string | undefined
  /** Project directory used for deterministic drop-save paths and post-commit registration. */
  readonly projectDirectory?: () => string
  /** Opt-in for in-place daemon replacement. */
  readonly replacement?: {
    readonly beforeReplace: (key: K, oldSlot: PluginSlot) => Promise<void>
    readonly onQuarantinedSlot?: (key: K) => void
    /**
     * Registry handling after ReplacePlugin rejects.
     *
     * Instrument replacement can retain the old declaration after a definitive
     * daemon rejection. Effect replacement cannot know whether teardown already
     * happened, so every rejection forgets the declaration and makes the next
     * declaration use ReplacePlugin as an ensure operation.
     */
    readonly failurePolicy: 'retain-on-reject' | 'forget-and-ensure'
  }
}

export class EffectSlotLimitError extends Error {
  // Unreferenced within this codebase today — kept for the typed-error contract.
  // S4/#522's Rust protocol extension is the expected consumer (commit db01cd8).
  readonly code = 'EFFECT_SLOT_LIMIT'

  constructor(message: string) {
    super(message)
    this.name = 'EffectSlotLimitError'
  }
}

function elementToken(element: ChainElement | RackElementSpec): string {
  return element.kind === 'catalog'
    ? `catalog:${element.normalizedName}`
    : `standard:${element.name}`
}

/** LCS with an explicit tie rule: keep the earlier old element when two solutions are equal. */
function lcsPairs(
  previous: readonly ChainElement[],
  next: RackSpec,
): Array<{ previousIndex: number; nextIndex: number }> {
  const oldTokens = previous.map(elementToken)
  const nextTokens = next.map(elementToken)
  const lengths = Array.from({ length: oldTokens.length + 1 }, () =>
    Array<number>(nextTokens.length + 1).fill(0),
  )
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = nextTokens.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        oldTokens[i] === nextTokens[j]
          ? 1 + lengths[i + 1]![j + 1]!
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const pairs: Array<{ previousIndex: number; nextIndex: number }> = []
  let i = 0
  let j = 0
  while (i < oldTokens.length && j < nextTokens.length) {
    if (oldTokens[i] === nextTokens[j]) {
      pairs.push({ previousIndex: i, nextIndex: j })
      i += 1
      j += 1
    } else if (lengths[i + 1]![j]! > lengths[i]![j + 1]!) {
      i += 1
    } else {
      // Tie: advance the new side, preserving the earlier old candidate for a later match.
      j += 1
    }
  }
  return pairs
}

function sameCatalogSpec(old: ChainElement, spec: RackElementSpec): boolean {
  return (
    old.kind === 'catalog' &&
    spec.kind === 'catalog' &&
    old.resolvedPath === spec.resolvedPath &&
    old.pluginId === spec.pluginId &&
    old.declaredStatePath === spec.declaredStatePath
  )
}

function sameCatalogElement(old: ChainElement, next: ChainElement): boolean {
  return (
    old.kind === 'catalog' &&
    next.kind === 'catalog' &&
    old.resolvedPath === next.resolvedPath &&
    old.pluginId === next.pluginId &&
    old.declaredStatePath === next.declaredStatePath
  )
}

function rackApplyProtocolError(error: DaemonProtocolError, rack: RackSpec): DaemonProtocolError {
  const match = error.message.match(/index\s+(\d+)/i)
  const index = match ? Number(match[1]) : 0
  const element = rack[index]
  const name =
    element === undefined
      ? '<rack>'
      : element.kind === 'catalog'
        ? element.normalizedName
        : element.name
  const cause = error.message.replace(/^\[[^\]]+\]\s*/, '')
  return new DaemonProtocolError(
    error.code,
    `effect chain apply failed at index ${index} (${name}): ${cause}; the previous chain is kept`,
    error.details,
  )
}

/**
 * key ごとの宣言集合。`declare()` は単一 instrument の旧経路を維持し、`applyRack()` は
 * effect の完全な多段ラックを管理する。両経路は同じ per-key キューを共有する。
 */
export class EffectChainMap<K> {
  private readonly chains = new Map<K, PluginSlot[]>()
  private readonly rackChains = new Map<K, ChainElement[]>()
  private readonly maxLength: number
  private readonly statePathFallback?: PluginStatePathFallbackResolver
  private readonly externalReceiverId?: (key: K) => string
  private readonly effectBus?: (key: K) => string | undefined
  private readonly projectDirectory?: () => string
  private readonly replacement?: EffectChainMapOptions<K>['replacement']
  /** A rejected ensure leaves commit status unknown and retains cleanup context. */
  private readonly uncertainReplacements = new Map<K, UncertainReplacement>()
  private readonly uncertainRacks = new Set<K>()
  // key ごとの直列化キュー（#527 review Important 1）。値は「前呼び出しの決着
  // （成功/失敗いずれも）待ち」で、前呼び出しの成否は自分の結果に影響させない
  // （catch で握りつぶし、必ず次の呼び出しへ進める）。
  private readonly pending = new Map<K, Promise<void>>()

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly receiverId: (key: K) => string,
    options: EffectChainMapOptions<K> = {},
  ) {
    this.maxLength = options.maxLength ?? 1
    this.statePathFallback = options.statePathFallback
    this.externalReceiverId = options.externalReceiverId
    this.effectBus = options.effectBus
    this.projectDirectory = options.projectDirectory
    this.replacement = options.replacement
  }

  has(key: K): boolean {
    return (this.rackChains.get(key)?.length ?? this.chains.get(key)?.length ?? 0) > 0
  }

  /** Whether a rack image (including an intentional empty rack) was committed for this key. */
  hasAppliedRack(key: K): boolean {
    return this.rackChains.has(key)
  }

  /** いずれかの key に非空チェーンがあるか（#540 P1: `PluginInstrumentManager.hasDeclaration`）。 */
  hasAny(): boolean {
    for (const chain of this.rackChains.values()) {
      if (chain.length > 0) return true
    }
    for (const chain of this.chains.values()) {
      if (chain.length > 0) return true
    }
    return false
  }

  /** Whether replacement outcome is unknown for one key. */
  hasUncertain(key: K): boolean {
    return this.uncertainReplacements.has(key) || this.uncertainRacks.has(key)
  }

  /**
   * 観測用の参照専用ビュー。**コピーを返す** — `readonly` 配列型はコンパイル時の保護でしかなく、
   * 内部配列そのものを渡すと `as any` 経由の mutate で登記が壊れる（要素の各フィールドも
   * `PluginSlotBase` 側で `readonly` 化済み — #527 review round 3 Minor）。S4/#522 の Rust
   * プロトコル拡張がここを消費し始めるため、その前に閉じておく。
   */
  chainFor(key: K): readonly PluginSlot[] {
    return [...(this.chains.get(key) ?? [])]
  }

  /** Rack-only typed observer for effect managers. */
  rackFor(key: K): readonly ChainElement[] {
    return [...(this.rackChains.get(key) ?? [])]
  }

  /** Non-empty chain keys, returned as a copy so callers cannot mutate the registry. */
  keys(): readonly K[] {
    return [...new Set([...this.chains.keys(), ...this.rackChains.keys()])]
  }

  /**
   * `key` への現在キューされている `declare()` 呼び出しがすべて決着するまで待つ
   * （#527 review round 3）。呼び出し元が「自分の宣言が失敗した後、外部管理のリソース
   * （bus 等）を解放してよいか」を `has()` で判定する場合、**この await を経てから**
   * 判定すること — 直列化キューの後続 `declareBody()` がまだ走っていない可能性がある
   * 状態で `has()` を見ると、後続が成功して chain を埋める直前のタイミングを掴んで
   * 誤って「誰も使っていない」と判定しうる（呼び出し元の catch ブロックから同期的に
   * `has()` を見るだけでは、キューの残り段数分だけ判定が早すぎることがある）。
   */
  async settled(key: K): Promise<void> {
    await (this.pending.get(key) ?? Promise.resolve())
  }

  /**
   * 宣言する（または冪等に再宣言する）。同一 spec の再宣言は既存 load を待ち、
   * respawn 後の stale cache（`isPluginActive?.(role, bus) === false`）なら
   * 再ロードで self-heal する。異なる spec は上限エラーを throw（v1: 1 slot）。
   * 新規宣言の load 失敗は宣言を取り除いて rethrow（呼び出し側は catch で bus の
   * 返却等の後始末を行える）。
   *
   * `key` ごとに直列化する（#527 review Important 1）: 同一 key への `declare()` を
   * await せずに連打すると、両方が同じ `existing` を `replacing` として捕まえ、先に
   * 同期区間を走らせた方だけがチェーン配列の置換（object identity 比較）に勝ち、
   * もう片方の置換は無音の no-op になる（勝った側の load が後で失敗すると catch の
   * rollback がチェーンごと削除する一方、負けた側は自分の entry がチェーンに無い
   * ため rollback が素通りする — engine 側は実際にロード済みなのに `has()` が
   * false を返す事故になる）。呼び出し本体（`declareBody`）を key 単位の
   * pending promise の後ろに直列でつなぐことで、このレースを避ける。
   */
  async declare(key: K, spec: PluginDeclaration, duplicateMessage: () => string): Promise<void> {
    return this.enqueue(key, () => this.declareBody(key, spec, duplicateMessage))
  }

  /** Settle a complete effect rack through one prepare-commit daemon command. */
  async applyRack(key: K, rack: RackSpec): Promise<void> {
    return this.enqueue(key, () => this.applyRackBody(key, rack))
  }

  private async applyRackBody(key: K, rack: RackSpec): Promise<void> {
    if (!this.audioEngine.applyEffectChain) {
      throw new Error('Effect rack hosting requires the Rust engine backend.')
    }
    const previous = this.rackChains.get(key) ?? []
    const mode: EffectChainApplyRequest['mode'] = this.uncertainRacks.has(key) ? 'rebuild' : 'diff'
    const pairs = mode === 'rebuild' ? [] : lcsPairs(previous, rack)
    const previousForNew = new Map(
      pairs.map(({ previousIndex, nextIndex }) => [nextIndex, previousIndex]),
    )
    const keptPrevious = new Set<number>()
    const dropPrevious = new Set<number>()
    const receiver = this.receiverId(key)
    const externalReceiver = this.externalReceiverId?.(key) ?? receiver
    const bus = this.effectBus?.(key)

    const usedOccurrences = new Map<string, Set<number>>()
    const reserve = (name: string, occurrence: number): void => {
      const used = usedOccurrences.get(name) ?? new Set<number>()
      used.add(occurrence)
      usedOccurrences.set(name, used)
    }
    const allocate = (name: string): number => {
      const used = usedOccurrences.get(name) ?? new Set<number>()
      let occurrence = 0
      while (used.has(occurrence)) occurrence += 1
      used.add(occurrence)
      usedOccurrences.set(name, used)
      return occurrence
    }

    // Every LCS-corresponding element survives as the same identity, including an in-place
    // catalog spec replacement. Unmatched dropped identities are free for deterministic reuse.
    for (const nextIndex of rack.keys()) {
      const previousIndex = previousForNew.get(nextIndex)
      const old = previousIndex === undefined ? undefined : previous[previousIndex]
      if (old) reserve(old.normalizedName, old.occurrence)
    }

    const next: ChainElement[] = []
    for (const [nextIndex, spec] of rack.entries()) {
      const previousIndex = previousForNew.get(nextIndex)
      const old = previousIndex === undefined ? undefined : previous[previousIndex]
      const sameSpec = old !== undefined && (old.kind === 'standard' || sameCatalogSpec(old, spec))
      const occurrence =
        old && (sameSpec || previousIndex !== undefined)
          ? old.occurrence
          : allocate(spec.kind === 'catalog' ? spec.normalizedName : spec.name)
      if (old) reserve(old.normalizedName, occurrence)
      const normalizedName = spec.kind === 'catalog' ? spec.normalizedName : spec.name
      const instanceId = old?.instanceId ?? `${receiver}/${normalizedName}#${occurrence + 1}`
      if (spec.kind === 'catalog') {
        next.push({
          kind: 'catalog',
          role: 'effect',
          bus,
          instanceId,
          receiver,
          occurrence,
          normalizedName,
          resolvedPath: spec.resolvedPath,
          pluginId: spec.pluginId,
          declaredStatePath: spec.declaredStatePath,
          statePath: old?.kind === 'catalog' ? old.statePath : undefined,
          enabled: spec.enabled,
          load: Promise.resolve(),
        })
      } else {
        next.push({
          kind: 'standard',
          role: 'effect',
          bus,
          instanceId,
          receiver,
          occurrence,
          normalizedName,
          name: spec.name,
          params: { ...spec.params },
          enabled: spec.enabled,
        })
      }
      if (old && sameSpec) keptPrevious.add(previousIndex!)
      else if (old) dropPrevious.add(previousIndex!)
    }
    for (const index of previous.keys()) {
      if (!keptPrevious.has(index) && !dropPrevious.has(index)) dropPrevious.add(index)
    }
    const directory = this.projectDirectory?.()
    const saveByPrevious = new Map<
      number,
      {
        identity: PluginStateIdentity
        absolutePath: string
        relativePath: string
        slot: CatalogElement
      }
    >()
    if (directory) {
      for (const previousIndex of [...dropPrevious].sort((a, b) => a - b)) {
        const old = previous[previousIndex]
        if (!old || old.kind !== 'catalog') continue
        const identity: PluginStateIdentity = {
          receiver: externalReceiver,
          role: 'effect',
          normalizedName: old.normalizedName,
          occurrence: old.occurrence,
        }
        const relativePath = `states/${stateFileNameForIdentity(identity)}`
        saveByPrevious.set(previousIndex, {
          identity,
          relativePath,
          absolutePath: path.join(directory, ...relativePath.split('/')),
          slot: old,
        })
      }
      if (saveByPrevious.size > 0) {
        await fs.promises.mkdir(path.join(directory, 'states'), { recursive: true })
      }
    }

    const operations: EffectChainPlanStage[] = []
    for (const [nextIndex, element] of next.entries()) {
      const previousIndex = previousForNew.get(nextIndex)
      const old = previousIndex === undefined ? undefined : previous[previousIndex]
      const keep =
        old !== undefined && (old.kind === 'standard' || sameCatalogElement(old, element))
      if (keep) {
        operations.push({
          op: 'keep',
          prev_index: previousIndex!,
          enabled: element.enabled,
          ...(element.kind === 'standard' ? { params: element.params } : {}),
        })
        continue
      }
      if (element.kind === 'standard') {
        operations.push({
          op: 'load',
          kind: 'standard',
          name: element.name,
          params: element.params,
          enabled: element.enabled,
        })
        continue
      }
      const identity: PluginStateIdentity = {
        receiver: externalReceiver,
        role: 'effect',
        normalizedName: element.normalizedName,
        occurrence: element.occurrence,
      }
      const replacementState =
        previousIndex === undefined ? undefined : saveByPrevious.get(previousIndex)?.absolutePath
      const fallbackState =
        replacementState ??
        element.declaredStatePath ??
        (this.statePathFallback ? await this.statePathFallback(identity) : undefined)
      if (fallbackState) {
        console.log(
          `[plugin-state] restoring '${externalReceiver}/effect/${element.normalizedName}/${element.occurrence}' from ${fallbackState}`,
        )
      }
      ;(next[nextIndex] as CatalogElement) = { ...element, statePath: fallbackState }
      operations.push({
        op: 'load',
        kind: 'catalog',
        path: element.resolvedPath,
        ...(element.pluginId === undefined ? {} : { plugin_id: element.pluginId }),
        ...(fallbackState === undefined ? {} : { state: fallbackState }),
        enabled: element.enabled,
      })
    }

    for (const previousIndex of [...dropPrevious].sort((a, b) => a - b)) {
      const old = previous[previousIndex]
      if (old?.kind === 'catalog') await this.replacement?.beforeReplace(key, old)
    }

    const request: EffectChainApplyRequest = {
      ...(bus === undefined ? {} : { bus }),
      mode,
      chain: operations,
      saveDropped: [...saveByPrevious.entries()].map(([prev_index, saved]) => ({
        prev_index,
        path: saved.absolutePath,
      })),
    }
    let result: Awaited<ReturnType<NonNullable<AudioEngine['applyEffectChain']>>>
    try {
      // Deliberately no empty-diff early return: this command is also the daemon health check.
      result = await this.audioEngine.applyEffectChain(request)
    } catch (error) {
      if (error instanceof DaemonProtocolError) {
        throw rackApplyProtocolError(error, rack)
      }
      this.rackChains.delete(key)
      this.uncertainRacks.add(key)
      throw error
    }

    this.rackChains.set(key, next)
    this.uncertainRacks.delete(key)
    if (directory) {
      const store = projectStateStoreFor(this.audioEngine, directory)
      for (const dropped of result.dropped) {
        const saved = saveByPrevious.get(dropped.prevIndex)
        if (!saved) continue
        await store.registerSavedState(saved.identity, saved.relativePath, dropped.bytesWritten, {
          resolvedPath: saved.slot.resolvedPath,
          pluginId: saved.slot.pluginId,
        })
      }
    }
  }

  /** Removes one named effect through the same per-key queue as declaration/replacement. */
  async remove(key: K, expectedNormalizedName: string, occurrence = 0): Promise<void> {
    return this.enqueue(key, () => this.removeBody(key, expectedNormalizedName, occurrence))
  }

  private async enqueue<T>(key: K, body: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve()
    const settled = previous.catch(() => undefined).then(() => body())
    const tracked = settled.then(
      () => {},
      () => {},
    )
    this.pending.set(key, tracked)
    try {
      return await settled
    } finally {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    }
  }

  private async removeBody(
    key: K,
    expectedNormalizedName: string,
    occurrence: number,
  ): Promise<void> {
    const receiver = this.externalReceiverId?.(key) ?? this.receiverId(key)
    const existing = this.chains.get(key)?.[0]
    const uncertain = this.uncertainReplacements.get(key)
    const cleanupSlot = existing ?? uncertain?.forgottenSlot
    if (!cleanupSlot && !uncertain) {
      throw new Error(
        `${receiver}: remove("${expectedNormalizedName}") — no effect insert is declared.`,
      )
    }
    if (cleanupSlot && cleanupSlot.normalizedName !== expectedNormalizedName) {
      throw new Error(
        `${receiver}: remove("${expectedNormalizedName}") does not match the declared insert '${cleanupSlot.normalizedName}'.`,
      )
    }
    if (occurrence !== 0) {
      throw new Error(
        `${receiver}: remove("${expectedNormalizedName}", ${occurrence}) — v1 supports a single insert; occurrence must be 0.`,
      )
    }
    if (!this.audioEngine.unloadPlugin) {
      throw new Error('Plugin removal requires the Rust engine backend.')
    }

    if (existing) {
      await existing.load
      await this.replacement?.beforeReplace(key, existing)
    } else if (cleanupSlot) {
      await this.beforeReplaceForgottenSlot(key, cleanupSlot)
    }
    const bus = existing?.role === 'effect' ? existing.bus : uncertain?.bus
    try {
      await this.audioEngine.unloadPlugin('effect', bus)
    } catch (error) {
      this.chains.delete(key)
      this.uncertainReplacements.set(key, { bus, forgottenSlot: cleanupSlot })
      throw error
    }
    this.chains.delete(key)
    this.uncertainReplacements.delete(key)
  }

  private async declareBody(
    key: K,
    spec: PluginDeclaration,
    duplicateMessage: () => string,
  ): Promise<void> {
    const chain = this.chains.get(key) ?? []
    const existing = chain[0]
    if (existing) {
      if (
        existing.role === spec.role &&
        existing.resolvedPath === spec.resolvedPath &&
        existing.pluginId === spec.pluginId &&
        existing.declaredStatePath === spec.statePath
      ) {
        await existing.load
        // Self-heal: respawn 後の復元失敗で engine 側だけ宣言が消えている場合、
        // 冪等パスで false success を返さず再ロードする（PluginEffectManager 由来の
        // silent-failure guard）。isPluginActive を持たない engine（SC/素の mock）は
        // 従来の no-op 冪等のまま。
        if (this.audioEngine.isPluginActive?.(spec.role, spec.bus, spec.instance) === false) {
          await this.issueLoad(key, spec, existing)
        }
        return
      }
      if (this.replacement) {
        await this.issueReplacement(key, spec, existing)
        return
      }
      // 上限超過の型はこのマップが一元的に決める。呼び出し側は文言だけを渡す
      // （`EffectSlotLimitError` は effect チェーンの上限専用 — `code` を消費する
      // S4/#522 の Rust プロトコル拡張が effect を対象にしているため、他 role に
      // 流用しない）。
      throw spec.role === 'effect'
        ? new EffectSlotLimitError(duplicateMessage())
        : new Error(duplicateMessage())
    }
    // `chain[0]` が空 = チェーンも空なので、ここに `chain.length >= maxLength` の
    // ガードは要らない（到達不能）。複数 insert を許す時に必要になるのは長さ判定では
    // なく、先頭だけでなくチェーン全体と spec を突き合わせる形への書き換え（PR-1b）。
    if (this.replacement && this.uncertainReplacements.has(key)) {
      await this.issueReplacement(key, spec)
    } else {
      await this.issueLoad(key, spec)
    }
  }

  private async issueReplacement(
    key: K,
    spec: PluginDeclaration,
    existing?: PluginSlot,
  ): Promise<void> {
    if (!this.audioEngine.replacePlugin) {
      throw new Error('Plugin replacement requires the Rust engine backend.')
    }
    const { role, bus, normalizedName, resolvedPath, pluginId, instance } = spec
    const uncertain = this.uncertainReplacements.get(key)
    const forgottenSlot = existing === undefined ? uncertain?.forgottenSlot : undefined
    const chain = this.chains.get(key) ?? []
    const occurrence = chain.filter(
      (slot) => slot !== existing && slot.normalizedName === normalizedName,
    ).length
    const receiver = this.receiverId(key)
    const instanceId = `${receiver}/${normalizedName}#${occurrence + 1}`
    const externalReceiver =
      spec.statePath === undefined ? this.externalReceiverId?.(key) : undefined
    const fallbackStatePath =
      externalReceiver !== undefined && this.statePathFallback !== undefined
        ? await this.statePathFallback({
            receiver: externalReceiver,
            role,
            normalizedName,
            occurrence,
          })
        : undefined
    const statePath = spec.statePath ?? fallbackStatePath
    if (fallbackStatePath !== undefined) {
      console.log(
        `[plugin-state] restoring '${externalReceiver}/${role}/${normalizedName}/${occurrence}' from ${fallbackStatePath}`,
      )
    }
    const optionalArgs: (string | undefined)[] = [bus, instance, statePath]
    while (optionalArgs.length > 0 && optionalArgs[optionalArgs.length - 1] === undefined) {
      optionalArgs.pop()
    }

    if (existing) await this.replacement!.beforeReplace(key, existing)
    else if (forgottenSlot) await this.beforeReplaceForgottenSlot(key, forgottenSlot)
    let result: Awaited<ReturnType<NonNullable<AudioEngine['replacePlugin']>>>
    try {
      result = await this.audioEngine.replacePlugin(
        resolvedPath,
        pluginId,
        role,
        ...(optionalArgs as [string?, string?, string?]),
      )
    } catch (error) {
      if (this.replacement!.failurePolicy === 'forget-and-ensure') {
        this.chains.delete(key)
        this.uncertainReplacements.set(key, {
          bus: role === 'effect' ? bus : undefined,
          forgottenSlot: existing ?? forgottenSlot,
        })
      } else if (!(error instanceof DaemonProtocolError)) {
        if (existing) this.chains.delete(key)
        this.uncertainReplacements.set(key, { bus: undefined })
      }
      throw error
    }
    const load = Promise.resolve()
    const entry: PluginSlot =
      role === 'effect'
        ? {
            role,
            bus,
            instanceId,
            receiver,
            occurrence,
            normalizedName,
            resolvedPath,
            pluginId,
            declaredStatePath: spec.statePath,
            statePath,
            load,
          }
        : {
            role,
            instance: instance ?? 'default',
            instanceId,
            receiver,
            occurrence,
            normalizedName,
            resolvedPath,
            pluginId,
            declaredStatePath: spec.statePath,
            statePath,
            load,
          }
    const current = this.chains.get(key) ?? []
    this.chains.set(
      key,
      existing ? current.map((slot) => (slot === existing ? entry : slot)) : [entry],
    )
    this.uncertainReplacements.delete(key)
    if (result.quarantinedSlot) this.replacement!.onQuarantinedSlot?.(key)
  }

  /**
   * 🔴 この best-effort 保存は「**daemon はコミット後に Err を返さない**」という不変条件に
   * 乗っている（#625 最終監査 §2c）。`GetPluginState` の daemonTarget は slot 座標（role +
   * bus）だけで、**そこに載っている plugin の identity を検証しない**。もし「TS は失敗と
   * 判定・daemon は新テナント B をコミット済み」という状態が作れてしまうと、ここで B の
   * state が旧 A の state ファイルへ無言で上書きされる — I-1 が塞いだのと同じ silent data
   * loss になる。
   *
   * 現在その状態は作れない: quiesce timeout では daemon は旧 A のまま、teardown 後の attach
   * 失敗では slot が Empty/Closed（保存は daemon エラーになり warn へ落ちる）、WS 切断では
   * respawn 後の新 daemon の空 slot になる。**この不変条件を壊す変更（コミット後に Err を
   * 返す経路の追加）を daemon 側に入れるなら、先に GetPluginState 応答へ plugin 名を含めて
   * TS 側で照合すること。**
   */
  private async beforeReplaceForgottenSlot(key: K, oldSlot: PluginSlot): Promise<void> {
    try {
      await this.replacement!.beforeReplace(key, oldSlot)
    } catch (error) {
      const receiver = this.externalReceiverId?.(key) ?? this.receiverId(key)
      const message = error instanceof Error ? error.message : String(error)
      // 🔴 stream の選択は `effectReplaceNotice` が握る（呼び出し側で `console.warn` を
      // 使わないこと）。理由はそのモジュールの docstring を参照 — 拡張は engine の stderr を
      // 内容を見ずに `ERROR:` で記録するので、正常に継続する通知を warn で出すと E2E R-E4
      // 「復旧は ERROR 行を増やさない」が落ちる。実際に落ちた（#625・4 回目の再発）。
      effectReplaceNotice(
        `Best-effort cleanup of the uncertain old effect for '${receiver}' failed; replacement/removal will continue: ${message}`,
      )
    }
  }

  private async issueLoad(key: K, spec: PluginDeclaration, replacing?: PluginSlot): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    const { role, bus, normalizedName, resolvedPath, pluginId, instance } = spec
    const chain = this.chains.get(key) ?? []
    const occurrence =
      replacing?.occurrence ??
      chain.filter((slot) => slot !== replacing && slot.normalizedName === normalizedName).length
    const receiver = replacing?.receiver ?? this.receiverId(key)
    const instanceId = replacing?.instanceId ?? `${receiver}/${normalizedName}#${occurrence + 1}`
    // manifest は宣言値が無い新規 slot だけで参照する。respawn self-heal では、初回 load で
    // 確定した実効値を常に優先して同じパスを指し続ける（ファイル内容は再読込されうる）。
    const externalReceiver =
      replacing === undefined && spec.statePath === undefined
        ? this.externalReceiverId?.(key)
        : undefined
    const fallbackStatePath =
      externalReceiver !== undefined && this.statePathFallback !== undefined
        ? await this.statePathFallback({
            receiver: externalReceiver,
            role,
            normalizedName,
            occurrence,
          })
        : undefined
    const statePath = replacing?.statePath ?? spec.statePath ?? fallbackStatePath
    if (fallbackStatePath !== undefined) {
      console.log(
        `[plugin-state] restoring '${externalReceiver}/${role}/${normalizedName}/${occurrence}' from ${fallbackStatePath}`,
      )
    }
    // bus / instance / statePath は末尾 optional（#540 P1/P2）。末尾の undefined を落とし、
    // 「必要な位置までの引数だけを渡す」契約を保つ。したがって statePath の無い master
    // insert は従来どおり 3 引数だが、statePath があればその位置までの undefined も渡す。
    const optionalArgs: (string | undefined)[] = [bus, instance, statePath]
    while (optionalArgs.length > 0 && optionalArgs[optionalArgs.length - 1] === undefined) {
      optionalArgs.pop()
    }
    const load = this.audioEngine
      .loadPlugin(resolvedPath, pluginId, role, ...(optionalArgs as [string?, string?, string?]))
      .then(() => undefined)
    const entry: PluginSlot =
      role === 'effect'
        ? {
            role,
            bus,
            instanceId,
            receiver,
            occurrence,
            normalizedName,
            resolvedPath,
            pluginId,
            declaredStatePath: spec.statePath,
            statePath,
            load,
          }
        : {
            role,
            instance: instance ?? 'default',
            instanceId,
            receiver,
            occurrence,
            normalizedName,
            resolvedPath,
            pluginId,
            declaredStatePath: spec.statePath,
            statePath,
            load,
          }
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

/**
 * SC.5 の instance identity に使う plugin 名を安定化する。拡張子の集合は
 * `KNOWN_PLUGIN_EXTENSIONS` を正本として参照する（ここで正規表現に書き下すと、
 * AU（`.component`）対応などで片方だけ更新される二重管理になる）。
 *
 * `\` を `/` に寄せてから `path.basename` に渡す（#527 review Important 3 Minor）:
 * POSIX 上の `path.basename` は `\` をセパレータとして扱わないため、そのままでは
 * Windows 形式のパス（`C:\Plugins\Synth.vst3`）がドライブレターごと素通りしてしまう。
 */
export function normalizePluginInstanceName(spec: string): string {
  const normalized = spec.trim().normalize('NFC').replace(/\\/g, '/')
  const unqualified = path.basename(normalized)
  const extension = path.extname(unqualified).toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.includes(extension)
    ? unqualified.slice(0, -extension.length)
    : unqualified
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
