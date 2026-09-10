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

/** One ordered audio line, including the evaluation-batch cursor rules. */
export class AudioLine {
  private elements: LineElement[] = []
  private cursor = 0
  private inBatch = false
  private firstInBatch = false
  private readonly ordinals = new Map<string, number>()

  beginBatch(): void {
    // Beginning another batch implicitly closes the abandoned one.
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
