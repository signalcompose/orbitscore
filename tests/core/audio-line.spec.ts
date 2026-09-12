import { describe, expect, it } from 'vitest'

import {
  AudioLine,
  elementKey,
  toWire,
  type LineElement,
} from '../../packages/engine/src/core/sequence/audio-line'

const master = (thru = false, db = 0): LineElement => ({
  kind: 'output',
  dest: { kind: 'master' },
  thru,
  db,
  sugar: 'output',
})

const bus = (
  name: string,
  thru: boolean,
  db = 0,
  sugar: 'output' | 'send' = 'output',
): LineElement => ({ kind: 'output', dest: { kind: 'bus', bus: name }, thru, db, sugar })

function batch(line: AudioLine, elements: LineElement[]): void {
  line.beginBatch()
  elements.forEach((element) => line.upsert(element))
  line.endBatch()
}

describe('AudioLine', () => {
  it('U1 supplies only the rack marker for an empty line', () => {
    expect(new AudioLine().program()).toEqual([{ kind: 'rack' }])
  })

  it('U2 keeps a send without synthesizing a terminal master', () => {
    const line = new AudioLine()
    batch(line, [bus('verb', true, -12, 'send')])
    expect(line.program()).toEqual([{ kind: 'rack' }, bus('verb', true, -12, 'send')])
  })

  it('U3 preserves a pre-rack output written before rack', () => {
    const line = new AudioLine()
    batch(line, [bus('verb', true), { kind: 'rack' }])
    expect(line.program()).toEqual([bus('verb', true), { kind: 'rack' }])
  })

  it('U4 preserves a post-rack output written after rack', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'rack' }, bus('verb', true)])
    expect(line.program()).toEqual([{ kind: 'rack' }, bus('verb', true)])
  })

  it('U5 inserts single-element batches in default strip order', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'rack' }])
    batch(line, [{ kind: 'gain', db: -6 }])
    batch(line, [{ kind: 'pan', pan: -100 }])
    expect(line.program()).toEqual([
      { kind: 'rack' },
      { kind: 'gain', db: -6 },
      { kind: 'pan', pan: -100 },
    ])
  })

  it('U6 keeps rack at its default first position across batches', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'gain', db: -6 }])
    batch(line, [{ kind: 'rack' }])
    expect(line.program()).toEqual([{ kind: 'rack' }, { kind: 'gain', db: -6 }])
  })

  it('U7 decrements the cursor after moving an earlier element', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'rack' }, { kind: 'gain', db: -6 }, master()])
    batch(line, [{ kind: 'gain', db: -12 }, { kind: 'rack' }])
    expect(line.program()).toEqual([{ kind: 'gain', db: -12 }, { kind: 'rack' }, master()])
  })

  it('keeps two existing elements and the cursor stable when a later batch upserts them left-to-right', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'rack' }, { kind: 'gain', db: -6 }])

    line.beginBatch()
    line.upsert({ kind: 'rack' })
    line.upsert({ kind: 'gain', db: -12 })
    // A third insertion observes the cursor left by the second upsert. With `index > cursor`,
    // gain moves before rack and pan is then inserted between them.
    line.upsert({ kind: 'pan', pan: 30 })
    line.endBatch()

    expect(line.program()).toEqual([
      { kind: 'rack' },
      { kind: 'gain', db: -12 },
      { kind: 'pan', pan: 30 },
    ])
  })

  it('U8 replaces an existing terminal when a batch starts with another terminal', () => {
    const line = new AudioLine()
    batch(line, [bus('drums', false)])
    batch(line, [bus('cue', false)])
    expect(line.program()).toEqual([{ kind: 'rack' }, bus('cue', false)])
  })

  it('U9 retains two terminal outputs written in one batch', () => {
    const line = new AudioLine()
    batch(line, [bus('drums', false), bus('cue', false)])
    expect(line.program()).toEqual([{ kind: 'rack' }, bus('drums', false), bus('cue', false)])
  })

  it('U10 counts same-destination output ordinals within the batch', () => {
    const line = new AudioLine()
    batch(line, [bus('verb', true), { kind: 'rack' }, bus('verb', false)])
    expect(line.program()).toEqual([bus('verb', true), { kind: 'rack' }, bus('verb', false)])
    expect(elementKey(bus('verb', false), 1)).toBe('output:bus:verb#1')
  })

  it('U11 updates the first same-destination send outside its original batch', () => {
    const line = new AudioLine()
    batch(line, [bus('verb', true, -12, 'send')])
    batch(line, [bus('verb', true, -6, 'send')])
    // The second batch must REPLACE the -12 dB send, not append a second one — assert on the
    // whole program (including the implicit rack marker `program()` adds), so a stray extra
    // output cannot hide the way a filtered outputs-only view would have let it.
    expect(line.program()).toEqual([{ kind: 'rack' }, bus('verb', true, -6, 'send')])
  })

  it('degenerates outside a batch to value replacement without reordering', () => {
    const line = new AudioLine()
    batch(line, [{ kind: 'gain', db: -6 }, { kind: 'rack' }, master()])

    line.upsert({ kind: 'gain', db: -18 })

    expect(line.program()).toEqual([{ kind: 'gain', db: -18 }, { kind: 'rack' }, master()])
  })

  it('U12 converts disabled-send negative infinity to wire gain zero', () => {
    expect(toWire([bus('verb', true, -Infinity, 'send')])).toEqual([
      { op: 'output', dest: { kind: 'bus', name: 'verb' }, thru: true, gain: 0 },
    ])
  })

  it('guard: beginBatch() called twice without an intervening endBatch() implicitly closes the abandoned batch instead of corrupting the cursor', () => {
    const line = new AudioLine()
    line.beginBatch()
    line.upsert({ kind: 'rack' })
    line.upsert({ kind: 'gain', db: -6 })
    // No endBatch() here — simulates a host that died between `//#evalBegin` and `//#evalEnd`.
    line.beginBatch()
    line.upsert({ kind: 'pan', pan: -100 })
    line.endBatch()
    expect(line.program()).toEqual([
      { kind: 'rack' },
      { kind: 'gain', db: -6 },
      { kind: 'pan', pan: -100 },
    ])
  })

  it('guard: beginBatchAll()/endBatchAll() open and close a batch on every live AudioLine, including ones constructed while the frame is already open', () => {
    const before = new AudioLine()
    AudioLine.beginBatchAll()
    const during = new AudioLine()
    // `during` was constructed AFTER beginBatchAll() ran — it must still be in batch mode,
    // or a sequence declared mid-evaluation would silently lose position sensitivity (E2E-6).
    before.upsert({ kind: 'rack' })
    before.upsert({ kind: 'gain', db: -6 })
    during.upsert({ kind: 'rack' })
    during.upsert(bus('verb', true))
    AudioLine.endBatchAll()
    expect(before.program()).toEqual([{ kind: 'rack' }, { kind: 'gain', db: -6 }])
    expect(during.program()).toEqual([{ kind: 'rack' }, bus('verb', true)])

    // Outside the frame again, both lines degenerate to value-only updates.
    before.upsert({ kind: 'gain', db: -18 })
    expect(before.program()).toEqual([{ kind: 'rack' }, { kind: 'gain', db: -18 }])
  })

  it('U13 converts gain, pan, and mono device destinations and refuses link output', () => {
    expect(
      toWire([
        { kind: 'gain', db: -6 },
        { kind: 'pan', pan: -100 },
        {
          kind: 'output',
          dest: { kind: 'device', channels: [3] },
          thru: false,
          db: 0,
          sugar: 'output',
        },
      ]),
    ).toEqual([
      { op: 'gain', gain: 10 ** (-6 / 20) },
      { op: 'pan', pan: -1 },
      { op: 'output', dest: { kind: 'device', channels: [3] }, thru: false, gain: 1 },
    ])

    expect(() =>
      toWire([
        {
          kind: 'output',
          dest: { kind: 'link', channel: 'kick' },
          thru: false,
          db: 0,
          sugar: 'output',
        },
      ]),
    ).toThrow('LinkAudio destinations are not emitted')
  })
})
