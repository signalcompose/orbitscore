import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * E3 (#253) — key-center register: `global.key("D4")` sets the tonic pitch class AND a
 * base octave for degree 1, declaring the whole piece's register in one place. A plain
 * `global.key("D")` keeps the default octave (4); an explicit `seq.octave()` overrides.
 */

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

/** Play degree `1` under `key`, optionally setting seq.octave; return degree-1's MIDI note. */
async function rootNote(key: string, seqOctave?: number): Promise<number> {
  vi.setSystemTime(T0)
  const sched = mockScheduler()
  const ons: number[] = []
  const global = new Global(sched, new MidiManager(() => recordingOutput(ons)))
  global.key(key)
  global.start()
  const seq = new Sequence(global, sched)
  seq.setName('piano')
  seq.midi('iac', 1)
  if (seqOctave !== undefined) seq.octave(seqOctave)
  seq.play(...(parseAudioDSL('p.play(1)').statements[0].args as never[]))
  await seq.run()
  await vi.advanceTimersByTimeAsync(2100)
  return ons[0]!
}

describe('E3 — key-center register (#253)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`global.key("D3")` places degree 1 at D3 (50) without seq.octave()', async () => {
    expect(await rootNote('D3')).toBe(50)
  })

  it('`global.key("D")` (no octave) keeps the default octave 4 → D4 (62)', async () => {
    expect(await rootNote('D')).toBe(62)
  })

  it('`global.key("Bb5")` places degree 1 at Bb5 (82)', async () => {
    expect(await rootNote('Bb5')).toBe(82)
  })

  it('an explicit `seq.octave()` overrides the key-center octave', async () => {
    // global.key("D4") would give D4=62, but seq.octave(5) wins → D5=74
    expect(await rootNote('D4', 5)).toBe(74)
  })

  it('the key octave parses but does not change the pitch class (C4=60, C3=48)', async () => {
    expect(await rootNote('C')).toBe(60)
    expect(await rootNote('C3')).toBe(48)
  })
})
