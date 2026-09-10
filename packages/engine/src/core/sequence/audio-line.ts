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
 * #611 §5.7: every `AudioLine` ever constructed (one per Sequence / MixerBusHandle) so the
 * `//#evalBegin` / `//#evalEnd` frame can open/close a batch on all of them without each DSL
 * caller (`output()`/`send()`/`gain()`/`pan()`) touching `beginBatch`/`endBatch` itself. A plain
 * `Set` (not a `WeakSet`) because `beginBatchAll`/`endBatchAll` must iterate it; abandoned lines
 * (a re-declared sequence's previous `_line`) stay referenced for the life of the process — an
 * accepted v1 cost, not a correctness issue (a stale batch on a dead line never assembles into
 * a `program()` anyone reads again).
 */
const allLines = new Set<AudioLine>()

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

/** One ordered audio line, including the evaluation-batch cursor rules. */
export class AudioLine {
  private elements: LineElement[] = []
  private cursor = 0
  private inBatch = false
  private firstInBatch = false
  private readonly ordinals = new Map<string, number>()

  constructor() {
    allLines.add(this)
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
    for (const line of allLines) line.beginBatch()
  }

  /** #611 §5.7: `//#evalEnd` closes the batch on every live `AudioLine`. */
  static endBatchAll(): void {
    frameOpen = false
    for (const line of allLines) line.endBatch()
  }

  beginBatch(): void {
    // Beginning another batch implicitly closes the abandoned one (#611 §5.7 guard 1:
    // a missing `//#evalEnd` — e.g. the host crashing mid-evaluation — must not leave
    // `inBatch` stuck true forever; the next `//#evalBegin` self-heals it).
    this.endBatch()
    this.cursor = 0
    this.inBatch = true
    this.firstInBatch = true
    this.ordinals.clear()
  }

  endBatch(): void {
    this.inBatch = false
    this.firstInBatch = false
    this.ordinals.clear()
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
      this.firstInBatch = false
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

  outputs(): readonly Extract<LineElement, { kind: 'output' }>[] {
    return this.elements.filter(
      (element): element is Extract<LineElement, { kind: 'output' }> => element.kind === 'output',
    )
  }

  snapshot(): readonly LineElement[] {
    return [...this.elements]
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
