/**
 * Shared building blocks for the four effect/instrument-declaring managers (#468・
 * #527 で `PluginInstrumentManager` も合流):
 * `PluginEffectManager`（master insert）/ `SequenceEffectManager`（per-seq insert）/
 * `MixerManager`（sum・aux insert）/ `PluginInstrumentManager`（instrument）。各 manager に
 * ~15 行ずつ複製されていた「validate → LinkAudio gate → resolve」「冪等再宣言 + respawn 後
 * self-heal + install/rollback」「prefix 連番 + free-list の bus pool」をここに一本化する。
 */

import * as path from 'path'

import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
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
  readonly normalizedName: string
  readonly resolvedPath: string
  readonly pluginId?: string
  /**
   * 保存済み state ファイル（#540 P2・現状 instrument のみが設定する）。ロード identity の
   * 一部として idempotence 判定に参加する（effect では常に undefined 同士の比較）。
   */
  readonly statePath?: string
  readonly load: Promise<void>
}

export interface EffectSlot extends PluginSlotBase {
  readonly role: 'effect'
  readonly bus: string | undefined
}

export interface InstrumentSlot extends PluginSlotBase {
  readonly role: 'instrument'
}

export type PluginSlot = EffectSlot | InstrumentSlot

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
   * 保存済みプラグイン state ファイルの解決済みパス（'instrument' role 専用・#540 P2）。
   * ロード identity の一部 — 同 path/pluginId でも state が違えば別宣言（v1 は差し替え拒否）。
   */
  readonly statePath?: string
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

/**
 * key ごとに plugin chain を持つ宣言集合。PR-1a では上限 1 を維持するが、
 * 登記自体は複数 insert と instrument role を表現できる形にしておく。
 * `declare()` が冪等再宣言・respawn 後 self-heal（`isPluginActive === false` で再ロード）・
 * 失敗時の宣言ロールバック（自分が入れた宣言のみ削除）を一手に実装する。
 */
export class EffectChainMap<K> {
  private readonly chains = new Map<K, PluginSlot[]>()
  // key ごとの直列化キュー（#527 review Important 1）。値は「前呼び出しの決着
  // （成功/失敗いずれも）待ち」で、前呼び出しの成否は自分の結果に影響させない
  // （catch で握りつぶし、必ず次の呼び出しへ進める）。
  private readonly pending = new Map<K, Promise<void>>()

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly receiverId: (key: K) => string,
    private readonly maxLength = 1,
  ) {}

  has(key: K): boolean {
    return (this.chains.get(key)?.length ?? 0) > 0
  }

  /** いずれかの key に非空チェーンがあるか（#540 P1: `PluginInstrumentManager.hasDeclaration`）。 */
  hasAny(): boolean {
    for (const chain of this.chains.values()) {
      if (chain.length > 0) return true
    }
    return false
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
    const previous = this.pending.get(key) ?? Promise.resolve()
    const settled = previous
      .catch(() => undefined)
      .then(() => this.declareBody(key, spec, duplicateMessage))
    const tracked = settled.catch(() => undefined)
    this.pending.set(key, tracked)
    try {
      await settled
    } finally {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    }
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
        existing.statePath === spec.statePath
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
    await this.issueLoad(key, spec)
  }

  private async issueLoad(key: K, spec: PluginDeclaration, replacing?: PluginSlot): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    const { role, bus, normalizedName, resolvedPath, pluginId, instance, statePath } = spec
    // bus 無し（master insert）は 3 引数のまま呼ぶ（既存の呼び出し契約を変えない —
    // explicit undefined でも実 engine は等価だが、契約をピンするテスト/モックがある）。
    // bus / instance / statePath は末尾 optional（#540 P1/P2）— 分岐を列挙する代わりに
    // 末尾の undefined を落として「与えられた引数だけを渡す」契約を保つ。
    const optionalArgs: (string | undefined)[] = [bus, instance, statePath]
    while (optionalArgs.length > 0 && optionalArgs[optionalArgs.length - 1] === undefined) {
      optionalArgs.pop()
    }
    const load = this.audioEngine
      .loadPlugin(resolvedPath, pluginId, role, ...(optionalArgs as [string?, string?, string?]))
      .then(() => undefined)
    const chain = this.chains.get(key) ?? []
    const occurrence =
      chain.filter((slot) => slot !== replacing && slot.normalizedName === normalizedName).length +
      1
    const instanceId =
      replacing?.instanceId ?? `${this.receiverId(key)}/${normalizedName}#${occurrence}`
    const entry: PluginSlot =
      role === 'effect'
        ? { role, bus, instanceId, normalizedName, resolvedPath, pluginId, load }
        : { role, instanceId, normalizedName, resolvedPath, pluginId, statePath, load }
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
