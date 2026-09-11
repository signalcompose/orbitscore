import { gainDbToAmplitude } from '../../audio/audio-gain-utils'
import type { WireDest, WireLineOp } from '../../audio/types'

/** A resolved output destination. Device channel numbers are one-based. */
export type OutputDest =
  | { readonly kind: 'master' }
  | { readonly kind: 'bus'; readonly bus: string }
  | {
      readonly kind: 'device'
      readonly channels: readonly [number, number] | readonly [number]
    }
  | { readonly kind: 'render'; readonly id: string }
  | { readonly kind: 'link'; readonly channel: string }

export function destKey(dest: OutputDest): string {
  switch (dest.kind) {
    case 'master':
      return 'master'
    case 'bus':
      return `bus:${dest.bus}`
    case 'device':
      return `device:${dest.channels.join(',')}`
    case 'render':
      return `render:${dest.id}`
    case 'link':
      return `link:${dest.channel}`
  }
}

export type LineElement =
  | { readonly kind: 'rack' }
  | { readonly kind: 'gain'; readonly db: number }
  | { readonly kind: 'pan'; readonly pan: number }
  | {
      readonly kind: 'output'
      readonly dest: OutputDest
      readonly thru: boolean
      readonly db: number
      readonly sugar: 'output' | 'send'
    }

export function elementKey(element: LineElement, ordinal = 0): string {
  return element.kind === 'output' ? `output:${destKey(element.dest)}#${ordinal}` : element.kind
}

/** #611 §2.1/§2.3: `output()` / `MixerBusHandle.output()` の options。 */
export interface OutputOptions {
  readonly thru?: boolean
  readonly db?: number
}

/** #611 MX.3: `db` may be positional or named, but never both. */
export interface SendOptions {
  readonly db?: number
  readonly enabled?: boolean
}

/** Reject the legacy-looking numeric second argument before it can be silently ignored. */
export function assertOutputOptions(
  value: unknown,
  call = 'output',
): asserts value is OutputOptions {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return
  throw new Error(
    `${call}() expects an options object as its second argument. ` +
      `Did you mean output(dest, { db: -12 }) or send(dest, -12)?`,
  )
}

/** Resolve the one normative dB value accepted by `send`: positional or named. */
export function resolveSendLevel(
  dbOrOptions: number | SendOptions | undefined,
  trailingOptions: SendOptions = {},
  call = 'send',
): { db: number; enabled: boolean | undefined } {
  const positionalDb = typeof dbOrOptions === 'number' ? dbOrOptions : undefined
  const options =
    typeof dbOrOptions === 'object' && dbOrOptions !== null ? dbOrOptions : trailingOptions
  if (positionalDb !== undefined && trailingOptions.db !== undefined) {
    throw new Error(
      `${call}() received both a positional db value and db:. ` +
        `Remove either the second positional argument or the named db:.`,
    )
  }
  const db = positionalDb ?? options.db
  if (!Number.isFinite(db)) {
    throw new Error(`${call}() gain must be finite (dB).`)
  }
  return { db: db as number, enabled: options.enabled }
}

/**
 * #611 §2.1/§3.3 の共有解決ステップ: `"master"` 予約語 → 宣言済み sum/aux バス名 →
 * `"L,R"` 物理チャンネル対。どれにも当たらなければ `undefined` を返し、**残りのステップは
 * 呼び手が持つ**（`Sequence.output()` は LinkAudio 名へ、`MixerManager` は throw へ）。
 *
 * バスの引き当てだけをコールバックにしてあるのは、`Sequence` が `global.resolveMixerBus`、
 * `MixerManager` が自分の `resolveNode` を使うため — 正規表現と分岐の順序は仕様（§3.3）
 * そのものなので、2 箇所に写すと片方だけ直る。
 */
/**
 * #611 §2.2/§3.8: 宣言済みの物理アウトノード（`mix.output(n, m)` / `mix.output(n)`）が
 * 指す宛先。**常にデバイス。`(1, 2)` に特例は無い。**
 *
 * 🔴 **「トラック」と「デバイス」は別の概念**（owner 2026-09-11）:
 *
 * ```
 * kick ──┐
 * snare ─┼→ master トラック: [rack][gain][pan] → output → デバイス 1,2
 * hat  ──┘                    ↑ ここに合流する
 *
 * pad  ─────────────────────────────────→ デバイス 3,4（トラックを経由しない）
 * ```
 *
 * - `output(master)` は **master トラックの頭に合流**する。その後 master のラックと
 *   `global.gain()` を通り、**master トラックが自分の出口として持っているデバイス**へ出る
 * - `mix.output(1, 2)` は **デバイスの 1,2 ch を名指す**。トラックではない
 *
 * 以前ここには「`(1, 2)` は master と同じ wire 宛先にする」特例があった。これは
 * **master トラックの出口がたまたま 1,2 であることと、デバイスの 1,2 を混同**していた —
 * master の出口を 3,4 に変えたら、`mix.output(1, 2)` が master を指すのは意味を成さない。
 *
 * デバイスへ直接向けた音が master の出力と同じ線で加算されるのは**仕様どおり**であって
 * 防ぐべき事故ではない（DAW でトラックを出力 1-2 に直接向けたときと同じ）。
 *
 * なお、シーケンス（やバス）自身のラック・gain・pan は**宛先が master でも 3,4 でも同じように
 * かかる** — RT は同じ加工済みバッファを読み、違うのは master という段を通るかどうかだけ。
 */
export function physicalOutputDest(channels: readonly number[]): OutputDest {
  return channels.length === 1
    ? { kind: 'device', channels: [channels[0]] }
    : { kind: 'device', channels: [channels[0], channels[1]] }
}

export function resolveNamedOutputDest(
  value: string,
  lookupBus: (name: string) => { bus: string } | undefined,
): OutputDest | undefined {
  if (value === 'master') return { kind: 'master' }
  const bus = lookupBus(value)
  if (bus) return { kind: 'bus', bus: bus.bus }
  const pairMatch = value.match(/^(\d+)\s*,\s*(\d+)$/)
  if (pairMatch) {
    return { kind: 'device', channels: [Number(pairMatch[1]), Number(pairMatch[2])] }
  }
  return undefined
}

function defaultRank(element: LineElement): number {
  switch (element.kind) {
    case 'rack':
      return 0
    case 'gain':
      return 1
    case 'pan':
      return 2
    case 'output':
      return element.thru ? 3 : 4
  }
}

/**
 * #611 §5.7: every live `AudioLine` (one per Sequence / MixerBusHandle) so the
 * `//#evalBegin` / `//#evalEnd` frame can open/close a batch on all of them without each DSL
 * caller (`output()`/`send()`/`gain()`/`pan()`) touching `beginBatch`/`endBatch` itself.
 *
 * Elements are `WeakRef`s, not the lines themselves. `beginBatchAll`/`endBatchAll` must
 * ITERATE this registry, which rules out a `WeakSet` — but holding the lines strongly would
 * pin every abandoned line (a re-declared sequence's previous `_line`) for the life of the
 * process, and re-declaring a sequence is the normal move in a live-coding session, not an
 * edge case. Dead refs are pruned during the iteration that finds them, so the registry
 * tracks live lines rather than growing monotonically with the session.
 */
const allLines = new Set<WeakRef<AudioLine>>()

/** Iterate the live lines, dropping refs whose line has been collected. */
function forEachLiveLine(visit: (line: AudioLine) => void): void {
  for (const ref of allLines) {
    const line = ref.deref()
    if (line === undefined) allLines.delete(ref)
    else visit(line)
  }
}

/**
 * Whether an `//#evalBegin`/`//#evalEnd` frame is currently open. A `Sequence` (or a mixer
 * bus) declared mid-evaluation — e.g. `var kick = audio(...)` on a later line of the SAME
 * evaluated chunk — constructs its `AudioLine` AFTER `beginBatchAll()` already ran, so without
 * this flag the new line would never see `inBatch = true` and would silently degenerate to
 * "value-only update, position unchanged" for the rest of that evaluation — breaking position
 * sensitivity (#649 §7.6, E2E-6) for every sequence declared and wired in one breath, which is
 * the common case.
 */
let frameOpen = false

/**
 * #883 §2.3「実現の省略」: a line needs a daemon bus only when it asks for something the
 * direct engine path cannot realize — a rack, or an exit that is not a plain master exit.
 *
 * 🔴 **This is the single definition.** 束 S の instrument 経路（設計 §2.2.1）は
 * `SetSourceRouting` の宛先（`none` / `master` / `bus`）を**同じ述語**で選ぶ。ここに
 * 置かずに呼び出し側へ書き写すと、audio 経路と instrument 経路の判定がドリフトする。
 */
export function lineNeedsBus(elements: readonly LineElement[]): boolean {
  return elements.some(
    (element) =>
      element.kind === 'rack' ||
      (element.kind === 'output' &&
        !(element.dest.kind === 'master' && !element.thru && element.db === 0)),
  )
}

/** One ordered audio line, including the evaluation-batch cursor rules. */
export class AudioLine {
  private elements: LineElement[] = []
  private cursor = 0
  private inBatch = false
  private readonly ordinals = new Map<string, number>()

  constructor() {
    allLines.add(new WeakRef(this))
    // Join an already-open frame immediately — see `frameOpen`'s doc comment.
    if (frameOpen) this.beginBatch()
  }

  /**
   * Whether an `//#evalBegin`/`//#evalEnd` frame batch is currently open on this line.
   * Used by `Sequence`/`MixerBusHandle` DSL methods (`output()`/`send()`/`gain()`/`pan()`) to
   * decide whether to open their OWN one-call micro-batch: outside any frame (raw stdin, a
   * programmatic call, most unit tests), each call should still get the position-sensitive
   * batch rules (terminal replacement, default-strip insertion) rather than degenerating all
   * the way down to rule 4's bare value-only update — but a call made INSIDE an already-open
   * frame must NOT start a nested batch, which would reset the shared cursor mid-evaluation
   * and break position sensitivity across statements (#611 §5.7, E2E-6).
   */
  isInBatch(): boolean {
    return this.inBatch
  }

  /** #611 §5.7: `//#evalBegin` opens a batch on every live `AudioLine`. */
  static beginBatchAll(): void {
    frameOpen = true
    forEachLiveLine((line) => line.beginBatch())
  }

  /** #611 §5.7: `//#evalEnd` closes the batch on every live `AudioLine`. */
  static endBatchAll(): void {
    frameOpen = false
    forEachLiveLine((line) => line.endBatch())
  }

  /**
   * Whether nothing has been written yet in the current batch — rule 1 (terminal replacement,
   * default-strip insertion) applies to exactly that first `upsert`.
   *
   * Derived rather than tracked in its own field: `beginBatch()` is the only thing that sets
   * `cursor` to 0, and every `upsert` path leaves `cursor >= 1` (each assignment is
   * `<index> + 1` with `index >= 0`, and the splice branch's `-= 1` is always paired with a
   * matching `+= 1`). So `cursor === 0` IS "first in this batch" — a separate flag would be a
   * second copy of the same fact, free to drift out of step with the cursor it mirrors.
   */
  private get firstInBatch(): boolean {
    return this.cursor === 0
  }

  beginBatch(): void {
    // Beginning another batch implicitly closes the abandoned one (#611 §5.7 guard 1:
    // a missing `//#evalEnd` — e.g. the host crashing mid-evaluation — must not leave
    // `inBatch` stuck true forever; the next `//#evalBegin` self-heals it).
    this.endBatch()
    this.cursor = 0
    this.inBatch = true
    this.ordinals.clear()
  }

  endBatch(): void {
    this.inBatch = false
    this.ordinals.clear()
  }

  /**
   * Write one element, self-wrapping in a one-call batch when no `//#evalBegin` frame is
   * already open. A lone `output()`/`send()`/`gain()`/`pan()`/`effect()` call made OUTSIDE a
   * frame (raw stdin, a programmatic call, most unit tests) still gets the position-sensitive
   * batch rules (terminal replacement §5.1, default-strip insertion) instead of degenerating
   * to rule 4's bare value-only update; a call made INSIDE an open frame must NOT start a
   * nested batch, which would reset the shared cursor mid-evaluation and break position
   * sensitivity across statements (#611 §5.7, E2E-6).
   *
   * 🔴 This is the line's own rule, not a convention for callers to remember. It lived as an
   * identical four-line preamble in `Sequence.upsertLine()` and `MixerManager.applyLineElement()`
   * before #852; a third writer that called bare `upsert()` would have silently lost position
   * sensitivity, with no type or test to catch it.
   */
  upsertAutoBatch(element: LineElement): void {
    const selfBatch = !this.inBatch
    if (selfBatch) this.beginBatch()
    this.upsert(element)
    if (selfBatch) this.endBatch()
  }

  /** #649 cursor rules; outside a batch this degenerates to value-only replacement. */
  upsert(element: LineElement): void {
    const ordinal = this.nextOrdinal(element)
    const key = elementKey(element, ordinal)
    const index = this.indexOfKey(key)

    if (!this.inBatch) {
      if (index >= 0) this.elements[index] = element
      else this.insertAtDefault(element)
      return
    }

    if (this.firstInBatch) {
      if (index >= 0) {
        this.elements[index] = element
        this.cursor = index + 1
        return
      }
      if (element.kind === 'output' && !element.thru) {
        const terminal = this.elements.findIndex(
          (candidate) => candidate.kind === 'output' && !candidate.thru,
        )
        if (terminal >= 0) {
          this.elements[terminal] = element
          this.cursor = terminal + 1
          return
        }
      }
      const insertedAt = this.insertAtDefault(element)
      this.cursor = insertedAt + 1
      return
    }

    if (index >= this.cursor) {
      this.elements[index] = element
      this.cursor = index + 1
    } else if (index >= 0) {
      this.elements.splice(index, 1)
      this.cursor -= 1
      this.elements.splice(this.cursor, 0, element)
      this.cursor += 1
    } else {
      this.elements.splice(this.cursor, 0, element)
      this.cursor += 1
    }
  }

  /** Return the complete program without mutating the declared elements. */
  program(): readonly LineElement[] {
    const program = [...this.elements]
    if (!program.some((element) => element.kind === 'output' && !element.thru)) {
      program.push({
        kind: 'output',
        dest: { kind: 'master' },
        thru: false,
        db: 0,
        sugar: 'output',
      })
    }
    if (!program.some((element) => element.kind === 'rack')) {
      program.unshift({ kind: 'rack' })
    }
    return program
  }

  snapshot(): readonly LineElement[] {
    return [...this.elements]
  }

  /**
   * #883 §2.3: does this line need a daemon bus, or can the direct engine path realize it?
   *
   * Reads `elements` directly instead of going through `snapshot()` — the predicate only
   * scans, and `snapshot()` copies the whole array on every `output()` / `send()`, which
   * live coding re-evaluates constantly.
   */
  needsBus(): boolean {
    return lineNeedsBus(this.elements)
  }

  private nextOrdinal(element: LineElement): number {
    if (element.kind !== 'output' || !this.inBatch) return 0
    const key = destKey(element.dest)
    const ordinal = this.ordinals.get(key) ?? 0
    this.ordinals.set(key, ordinal + 1)
    return ordinal
  }

  private indexOfKey(key: string): number {
    const outputOrdinals = new Map<string, number>()
    for (let index = 0; index < this.elements.length; index += 1) {
      const element = this.elements[index]
      let ordinal = 0
      if (element.kind === 'output') {
        const dest = destKey(element.dest)
        ordinal = outputOrdinals.get(dest) ?? 0
        outputOrdinals.set(dest, ordinal + 1)
      }
      if (elementKey(element, ordinal) === key) return index
    }
    return -1
  }

  private insertAtDefault(element: LineElement): number {
    const rank = defaultRank(element)
    const index = this.elements.findIndex((candidate) => defaultRank(candidate) > rank)
    const insertedAt = index < 0 ? this.elements.length : index
    this.elements.splice(insertedAt, 0, element)
    return insertedAt
  }
}

function wireDest(dest: Exclude<OutputDest, { kind: 'link' }>): WireDest {
  switch (dest.kind) {
    case 'master':
      return { kind: 'master' }
    case 'bus':
      return { kind: 'bus', name: dest.bus }
    case 'device':
      return dest.channels.length === 1
        ? { kind: 'device', channels: [dest.channels[0]] }
        : { kind: 'device', channels: [dest.channels[0], dest.channels[1]] }
    case 'render':
      return { kind: 'render', id: dest.id }
  }
}

/** Convert a complete AudioLine program to the daemon wire vocabulary. */
export function toWire(program: readonly LineElement[]): WireLineOp[] {
  return program.map((element): WireLineOp => {
    switch (element.kind) {
      case 'rack':
        return { op: 'rack' }
      case 'gain':
        return { op: 'gain', gain: gainDbToAmplitude(element.db) }
      case 'pan':
        return { op: 'pan', pan: element.pan / 100 }
      case 'output':
        if (element.dest.kind === 'link') {
          throw new Error('LinkAudio destinations are not emitted in SetBusLine programs.')
        }
        return {
          op: 'output',
          dest: wireDest(element.dest),
          thru: element.thru,
          gain: gainDbToAmplitude(element.db),
        }
    }
  })
}
