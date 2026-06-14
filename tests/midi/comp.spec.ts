import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { cellToGrid, COMP_CELL_NAMES } from '../../packages/engine/src/midi/comp-rhythm'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * C2a (#271) — `.comp(...)` comping rhythm engine (§6.4). Each argument is one
 * bar's chord; a meter-INDEPENDENT cell figure cuts the bar into equal slots and
 * places the chord at the onset slots (the DSL's native `( )` division). Over an
 * odd meter an even-grid cell rides an intentional polymeter. The pure kernel is
 * asserted directly; the wiring + polymeter timing are asserted at dispatch.
 */

describe('C2a — cellToGrid kernel (§6.4)', () => {
  // cellToGrid returns a presence mask: index = slot, value = sounds. A named
  // cell ignores density, so those calls omit it (density defaults internally).
  const onsetIdx = (mask: boolean[]) => mask.flatMap((on, i) => (on ? [i] : []))

  it('charleston is an 8-slot figure on beat 1 + beat 2& (meter-independent)', () => {
    const mask = cellToGrid('charleston')
    expect(mask.length).toBe(8)
    expect(onsetIdx(mask)).toEqual([0, 3])
  })

  it('redgarland = beat 2& + 4& (off-beats only)', () => {
    expect(onsetIdx(cellToGrid('redgarland'))).toEqual([3, 7])
  })

  it('offbeats = every "and"', () => {
    expect(onsetIdx(cellToGrid('offbeats'))).toEqual([1, 3, 5, 7])
  })

  it('quarters = a 4-slot flat-four (every beat)', () => {
    const mask = cellToGrid('quarters')
    expect(mask.length).toBe(4)
    expect(onsetIdx(mask)).toEqual([0, 1, 2, 3])
  })

  it('twofour = beats 2 & 4 (Basie-sparse)', () => {
    const mask = cellToGrid('twofour')
    expect(mask.length).toBe(4)
    expect(onsetIdx(mask)).toEqual([1, 3])
  })

  it('density 0 lays out (no onset); density 1 hits every slot', () => {
    expect(onsetIdx(cellToGrid(undefined, 0))).toEqual([])
    expect(cellToGrid(undefined, 1).every((on) => on)).toBe(true)
  })

  it('density spreads onsets evenly (0.5 → quarter pulses on an 8-grid)', () => {
    expect(onsetIdx(cellToGrid(undefined, 0.5))).toEqual([0, 2, 4, 6])
    expect(onsetIdx(cellToGrid(undefined, 0.25))).toEqual([0, 4])
  })

  it('density clamps out-of-range input', () => {
    expect(onsetIdx(cellToGrid(undefined, -1))).toEqual([])
    expect(cellToGrid(undefined, 5).every((on) => on)).toBe(true)
  })

  it('an unknown cell warns and falls back to density', () => {
    const warn = vi.fn()
    const mask = cellToGrid('bogus', 0.25, warn)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(/unknown cell "bogus"/)
    expect(onsetIdx(mask)).toEqual([0, 4]) // density 0.25 grid, not the unknown cell
  })

  it('exposes the known cell names for discoverability', () => {
    expect(COMP_CELL_NAMES).toEqual(
      expect.arrayContaining(['charleston', 'redgarland', 'offbeats', 'quarters', 'twofour']),
    )
  })
})

// ── dispatch harness: capture (note, time) of each note-on over the bar(s) ──
const T0 = 1_000_000
type Hit = { note: number; t: number }
function recordingOutput(log: Hit[]): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number) => log.push({ note, t: Date.now() - T0 })),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IACドライバ バス1']),
    closeAll: vi.fn(),
  }
}
function mockScheduler() {
  return {
    isRunning: true,
    startTime: T0,
    getCurrentTime: () => 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    getMasterGainDb: () => 0,
  } as never
}

/**
 * key C, octave 4; configure `seq` (cell/density/beat) via `setup`, run
 * `seq.comp(<src>)`, advance the timers, and return the recorded note-ons.
 */
async function compHits(
  src: string,
  setup: (seq: Sequence) => void = () => {},
  advanceMs = 5000,
): Promise<Hit[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const log: Hit[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(log)))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  setup(seq)
  seq.comp(...(parseAudioDSL(`p.comp(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(advanceMs)
  return log
}

describe('C2a — comp dispatch (§6.4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // run() schedules with a +100ms "in the future" buffer (run-sequence.ts); the
  // figure/polymeter claims are about intervals, so normalize to the first onset.
  const relStabTimes = (hits: Hit[]) => {
    if (hits.length === 0) return []
    const t0 = Math.min(...hits.map((h) => h.t))
    return [...new Set(hits.map((h) => Math.round((h.t - t0) * 10) / 10))].sort((a, b) => a - b)
  }

  it('default (no cell): a bare comp swings the chord with charleston (2 stabs/bar)', async () => {
    // 4/4, tempo 120 → bar 2000ms, 8 slots → 250ms each. Charleston {0,3} → 0, +750.
    const hits = await compHits('[1,3,5]')
    expect(hits.map((h) => h.note).sort((a, b) => a - b)).toEqual([60, 60, 64, 64, 67, 67])
    expect(relStabTimes(hits)).toEqual([0, 750]) // beat 1 + beat 2&
  })

  it('an odd meter rides a polymeter: charleston over 3/4 cuts the bar into 8', async () => {
    // 3/4, tempo 120 → bar 1500ms, 8 slots → 187.5ms each. {0,3} → 0, +562.5.
    // (8-against-3 cross-rhythm; a 6-slot meter-aligned grid would put it at 750.)
    const hits = await compHits('[1,3,5]', (s) => s.beat(3, 4))
    const [first, second] = relStabTimes(hits)
    expect(first).toBe(0)
    // slot 3 of an 8-slot division of the 1500ms bar ≈ 562.5ms (±fake-timer ms rounding);
    // distinctly NOT the 6-slot meter-aligned position (750ms) — proves the polymeter.
    expect(second).toBeGreaterThan(555)
    expect(second).toBeLessThan(575)
    expect(hits).toHaveLength(6) // still two full chord stabs — no fallback in odd meter
  })

  it('a named cell selects the figure (twofour → beats 2 & 4)', async () => {
    // 4/4, 4 slots → 500ms each. twofour {1,3} → +500, +1500 → interval 1000.
    const hits = await compHits('[1,3,5]', (s) => s.cell('twofour'))
    expect(relStabTimes(hits)).toEqual([0, 1000])
  })

  it('density 0 lays out — a silent bar (no note-ons)', async () => {
    const hits = await compHits('[1,3,5]', (s) => s.density(0))
    expect(hits).toHaveLength(0)
  })

  it('N chords expand to N bars in order', async () => {
    // two chords, charleston; bar1 = C major [1,3,5], bar2 = G [5,7,2].
    // 4/4, length 2 → 4000ms; each bar 2000ms. bar2 downbeat one bar after bar1.
    const hits = await compHits('[1,3,5], [5,7,2]')
    const t0 = Math.min(...hits.map((h) => h.t))
    const bar2 = hits.filter((h) => h.t - t0 >= 2000)
    expect(bar2.length).toBe(6) // two stabs in bar 2 as well
    expect(Math.round(Math.min(...bar2.map((h) => h.t)) - t0)).toBe(2000) // bar 2 on its downbeat
  })

  it('composes with .voicelead(): the comped chords are voice-led', async () => {
    // C [1,3,5] then G [5,7,2]; with seq.voicelead() the B is led down to B3=59.
    const led = await compHits('[1,3,5], [5,7,2]', (s) => s.voicelead())
    expect(led.map((h) => h.note)).toContain(59) // B3 — voice-led down
    expect(led.map((h) => h.note)).not.toContain(71) // not B4
    // baseline without voice-leading keeps the B at B4 (71)
    const plain = await compHits('[1,3,5], [5,7,2]')
    expect(plain.map((h) => h.note)).toContain(71)
    expect(plain.map((h) => h.note)).not.toContain(59)
  })
})
