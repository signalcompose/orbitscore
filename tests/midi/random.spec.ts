import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * E2 (#257) — randomness (§12, decisions #50/#52/#53): `Xr` element presence, `.r` /
 * `.r(p)` stack thinning, `^r` random octave. Rolled per cycle at dispatch (silence
 * is allowed — no minimum-voice guarantee). Parse shape is asserted deterministically;
 * the stochastic behavior is asserted statistically over many runs.
 */

describe('E2 — random parse shape (§12)', () => {
  const arg = (src: string) => (parseAudioDSL(`p.play(${src})`).statements[0] as any).args[0]

  it('`5r` → a pitch with presence probability 0.5', () => {
    expect(arg('5r')).toMatchObject({ type: 'pitch', degree: 5, random: 0.5 })
  })

  it('`5^r` → a pitch with randomOctave', () => {
    expect(arg('5^r')).toMatchObject({ type: 'pitch', degree: 5, randomOctave: true })
  })

  it('`[1,3,5,7].r` → a stack with thinning probability 0.5', () => {
    expect(arg('[1,3,5,7].r')).toMatchObject({ type: 'stack', random: 0.5 })
  })

  it('`[1,3,5,7].r(0.3)` → thinning probability 0.3; out-of-range rejected', () => {
    expect(arg('[1,3,5,7].r(0.3)')).toMatchObject({ type: 'stack', random: 0.3 })
    expect(() => parseAudioDSL('p.play([1,3,5].r(2))')).toThrow(/between 0 and 1/)
  })

  it('`m7.r` wraps the chord ref in a one-voice stack with thinning', () => {
    expect(arg('m7.r')).toMatchObject({
      type: 'stack',
      random: 0.5,
      voices: [{ type: 'chord_ref', name: 'm7' }],
    })
  })
})

// ── dispatch harness (per-cycle roll observed over many runs) ──
const T0 = 1_000_000
function recordingOutput(log: number[]): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => (/iac/i.test(q) ? 'IACドライバ バス1' : q)),
    noteOn: vi.fn((_p: string, _c: number, note: number) => log.push(note)),
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

/** Play `src` once; return the note-ons emitted that cycle (only note-ons are recorded,
 * so ~one bar of timer advance is enough — no need to wait for note-offs). */
async function onceOns(src: string): Promise<number[]> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const ons: number[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(ons)))
  global.key('C')
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1).octave(4)
  seq.play(...(parseAudioDSL(`p.play(${src})`).statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(2100) // one 2s bar + margin (note-ons only)
  return ons
}

const N = 20 // statistical sample: P(false negative) ≈ 0.5^N ≈ 1e-6

describe('E2 — random dispatch behavior (§12, statistical)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`[1,3,5,7].r` thins voices per cycle (≤4, varies, silence allowed)', async () => {
    const counts: number[] = []
    const seen = new Set<number>()
    for (let i = 0; i < N; i++) {
      const ons = await onceOns('[1,3,5,7].r')
      counts.push(ons.length)
      ons.forEach((n) => seen.add(n))
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(4) // never more than the 4 chord tones
    expect(Math.min(...counts)).toBeLessThan(4) // at least one cycle dropped a voice
    for (const n of seen) expect([60, 64, 67, 71]).toContain(n) // only C/E/G/B
  }, 30000)

  it('`5^r` picks a random octave in ±1 (note ∈ {55, 67, 79})', async () => {
    const notes = new Set<number>()
    for (let i = 0; i < N; i++) for (const n of await onceOns('5^r')) notes.add(n)
    for (const n of notes) expect([55, 67, 79]).toContain(n) // G3/G4/G5
    expect(notes.size).toBeGreaterThan(1) // more than one octave actually occurs
  }, 30000)

  it('`(1, 3, 5r, 7)` randomly rests the 5 (melodic), 1/3/7 always sound', async () => {
    let droppedG = false
    let presentG = false
    for (let i = 0; i < N; i++) {
      const ons = await onceOns('1, 3, 5r, 7')
      expect(ons).toContain(60) // C always
      expect(ons).toContain(64) // E always
      expect(ons).toContain(71) // B always
      if (ons.includes(67)) presentG = true
      else droppedG = true
    }
    expect(droppedG).toBe(true) // the 5 (G) was dropped at least once
    expect(presentG).toBe(true) // and present at least once
  }, 30000)
})
