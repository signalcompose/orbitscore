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

  it('a prototype-chain name ("__proto__") is treated as unknown, not a crash', () => {
    const warn = vi.fn()
    // own-property lookup only: must fall back to density, not hit Object.prototype.
    const mask = cellToGrid('__proto__', 0.25, warn)
    expect(onsetIdx(mask)).toEqual([0, 4])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('a positive density that rounds to 0 onsets warns (a 0.05 typo, not silent)', () => {
    const warn = vi.fn()
    const mask = cellToGrid(undefined, 0.05, warn) // round(0.05×8)=0 → silent
    expect(onsetIdx(mask)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(/too low/)
  })

  it('density exactly 0 lays out WITHOUT a warning (intentional)', () => {
    const warn = vi.fn()
    expect(onsetIdx(cellToGrid(undefined, 0, warn))).toEqual([])
    expect(warn).not.toHaveBeenCalled()
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

/**
 * Like {@link compHits} but records note-off times too, returning the sounding
 * duration (off − on) of each note. Used to assert that `gate()` shapes the
 * comped stab length (the documented mechanism, §6.4).
 */
async function compNoteDurations(src: string, setup: (seq: Sequence) => void): Promise<number[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const ons: Hit[] = []
  const offs: Hit[] = []
  const out: MidiOutput = {
    ...recordingOutput(ons),
    noteOff: vi.fn((_p: string, _c: number, note: number) =>
      offs.push({ note, t: Date.now() - T0 }),
    ),
  }
  const global = new Global(sched, new MidiManager(() => out))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  setup(seq)
  seq.comp(...(parseAudioDSL(`p.comp(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(5000)
  // single-onset source → each note appears once; pair on→off by note.
  return ons.map((on) => offs.find((o) => o.note === on.note)!.t - on.t)
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

  it('quarters is a 4-slot flat-four — a stab on every beat (not an 8-grid)', async () => {
    // 4/4 bar 2000ms / 4 slots → 500ms each. quarters {0,1,2,3} → 0,500,1000,1500.
    const hits = await compHits('[1,3,5]', (s) => s.cell('quarters'))
    expect(relStabTimes(hits)).toEqual([0, 500, 1000, 1500])
    expect(hits).toHaveLength(12) // 3 notes × 4 beats
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

  it('a named cell wins over density(): cell("twofour").density(1) fires 2 stabs, not 8 (and warns)', async () => {
    // density(1) alone would hit all 8 slots; the cell must win → twofour {1,3} → 2 stabs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hits = await compHits('[1,3,5]', (s) => s.cell('twofour').density(1))
    expect(relStabTimes(hits)).toEqual([0, 1000])
    expect(hits).toHaveLength(6) // 3 notes × 2 stabs
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the cell wins; density is ignored/))
    warn.mockRestore()
  })

  it('density(1) over 3/4 hits all 8 slots evenly (structural polymeter)', async () => {
    // 1500ms bar / 8 = 187.5ms; 8 onsets at 0,187.5,…,1312.5 → 8 distinct stab times.
    const hits = await compHits('[1,3,5]', (s) => s.beat(3, 4).density(1))
    expect(relStabTimes(hits)).toHaveLength(8)
    expect(hits).toHaveLength(24) // 3 notes × 8 stabs — the full eighth grid over 3/4
  })

  it('a single-degree arg (not a stack) is comped as a one-note "chord"', async () => {
    const hits = await compHits('3') // degree 3 in key C = E4 = 64
    expect([...new Set(hits.map((h) => h.note))]).toEqual([64])
    expect(hits).toHaveLength(2) // charleston → 2 stabs of the single note
  })

  it('a rest (0) as a chord arg lays out that bar silently', async () => {
    // bar1 = C major, bar2 = rest, bar3 = C major → bars 1 & 3 sound, bar 2 silent.
    const hits = await compHits('[1,3,5], 0, [1,3,5]', () => {}, 8000)
    const t0 = Math.min(...hits.map((h) => h.t))
    const bar2 = hits.filter((h) => h.t - t0 >= 2000 && h.t - t0 < 4000)
    expect(bar2).toHaveLength(0) // the rest bar is silent
    expect(hits.filter((h) => h.t - t0 >= 4000).length).toBe(6) // bar 3 sounds again
  })

  it('gate() shapes the comped stab length (off at gate × slot)', async () => {
    // density(0.125) → exactly 1 onset/bar (slot 0); 4/4 slot = 250ms.
    // gate 0.4 → each note sounds ~100ms; default gate 0.8 → ~200ms.
    const tight = await compNoteDurations('[1,3,5]', (s) => s.density(0.125).gate(0.4))
    tight.forEach((d) => expect(d).toBeGreaterThan(80))
    tight.forEach((d) => expect(d).toBeLessThan(140))
    const loose = await compNoteDurations('[1,3,5]', (s) => s.density(0.125).gate(0.8))
    loose.forEach((d) => expect(d).toBeGreaterThan(180))
    loose.forEach((d) => expect(d).toBeLessThan(240))
  })

  it('comp() with no chords is a no-op and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.setSystemTime(T0)
    const sched = mockScheduler()
    const log: Hit[] = []
    const global = new Global(sched, new MidiManager(() => recordingOutput(log)))
    global.key('C')
    global.start()
    const seq = new Sequence(global, sched)
    seq.setName('piano')
    seq.midi('iac', 1).octave(4)
    seq.comp() // no chords
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect(log).toHaveLength(0) // nothing scheduled
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/needs at least one chord/))
    warn.mockRestore()
  })

  it('density(NaN) warns and falls back to 0.5 (4 stabs), not a silent bar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hits = await compHits('[1,3,5]', (s) => s.density(NaN))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not a finite number/))
    expect(relStabTimes(hits)).toEqual([0, 500, 1000, 1500]) // density 0.5 = 4 quarter pulses
    warn.mockRestore()
  })
})
