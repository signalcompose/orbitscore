import { describe, it, expect, beforeEach, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import { MidiOutput } from '../../packages/engine/src/midi/midi-output'

/**
 * Phase 1 increment 5b (#228) — Sequence MIDI config surface (§1)
 * midi() / gate / vel / octave / root + audio exclusion.
 */

function mockMidiOutput(ports: string[] = ['IACドライバ バス1']): MidiOutput {
  return {
    ensurePort: vi.fn((q: string) => {
      const hit = ports.find((p) => p.toLowerCase().includes(q.toLowerCase()))
      if (!hit) throw new Error(`no port matches "${q}"`)
      return hit
    }),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ports),
    closeAll: vi.fn(),
  }
}

describe('Sequence MIDI config (§1)', () => {
  let global: Global
  let seq: Sequence
  let out: MidiOutput

  beforeEach(() => {
    const mockPlayer = {
      boot: vi.fn(),
      getCurrentTime: vi.fn().mockReturnValue(0),
      getMasterGainDb: vi.fn().mockReturnValue(0),
      resolveAudioSpec: vi.fn(),
    } as never
    out = mockMidiOutput()
    global = new Global(mockPlayer, new MidiManager(() => out))
    seq = new Sequence(global, mockPlayer)
    seq.setName('piano')
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('is not MIDI by default', () => {
    expect(seq.isMidi()).toBe(false)
  })

  it('midi() resolves the port (localized substring) and sets MIDI mode', () => {
    seq.midi('iac', 1)
    expect(seq.isMidi()).toBe(true)
    expect(out.ensurePort).toHaveBeenCalledWith('iac')
    const s = seq.getState()
    expect(s.midiPort).toBe('IACドライバ バス1')
    expect(s.midiChannel).toBe(1)
  })

  it('midi() rejects an out-of-range channel', () => {
    expect(() => seq.midi('iac', 0)).toThrow()
    expect(() => seq.midi('iac', 17)).toThrow()
  })

  it('midi() throws on an unknown port, listing nothing matched', () => {
    expect(() => seq.midi('nonexistent', 1)).toThrow()
  })

  it('default gate/vel/octave match the spec', () => {
    const s = seq.getState()
    expect(s.gate).toBe(0.8)
    expect(s.vel).toBe(96)
    expect(s.octave).toBe(4)
  })

  it('gate/vel/octave/root setters clamp and store', () => {
    seq.midi('iac', 1).gate(0.7).vel(100).octave(5).root(3)
    const s = seq.getState()
    expect(s.gate).toBe(0.7)
    expect(s.vel).toBe(100)
    expect(s.octave).toBe(5)
    expect(s.rootDegree).toBe(3)
  })

  it('gate clamps to 0..1, vel clamps to 1..127', () => {
    seq.gate(2)
    expect(seq.getState().gate).toBe(1)
    seq.gate(-1)
    expect(seq.getState().gate).toBe(0)
    seq.vel(200)
    expect(seq.getState().vel).toBe(127)
    seq.vel(0)
    expect(seq.getState().vel).toBe(1)
  })

  it('midi() and audio() are mutually exclusive', () => {
    seq.midi('iac', 1)
    expect(() => seq.audio('kick.wav')).toThrow(/cannot be combined with midi/)
  })

  it('audio() then midi() also throws', () => {
    const audioSeq = new Sequence(global, { resolveAudioSpec: vi.fn() } as never)
    audioSeq.setName('drums')
    // give the global a resolver
    vi.spyOn(global, 'resolveAudioSpec').mockReturnValue('/abs/kick.wav')
    audioSeq.audio('kick.wav')
    expect(() => audioSeq.midi('iac', 1)).toThrow(/cannot be combined with audio/)
  })

  it('chop() throws in MIDI mode', () => {
    seq.midi('iac', 1)
    expect(() => seq.chop(4)).toThrow(/cannot be combined with midi/)
  })
})
