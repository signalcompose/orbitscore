import { describe, it, expect, beforeEach, vi } from 'vitest'

import { MidiBackend, MidiBackendPort } from '../../packages/engine/src/midi/midi-output'
import { RtMidiOutput } from '../../packages/engine/src/midi/rtmidi-output'

/**
 * RtMidiOutput tests — Phase 1 (#228)
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §1, §2.4, §7, §7-2
 *
 * All tests use a mock MidiBackend so no real MIDI hardware is required.
 */

// ---------------------------------------------------------------------------
// Mock backend helpers
// ---------------------------------------------------------------------------

/** Per-port message log: records every sendMessage() call. */
interface MockPort extends MidiBackendPort {
  messages: number[][]
  closed: boolean
}

function makeMockPort(): MockPort {
  const port: MockPort = {
    messages: [],
    closed: false,
    sendMessage(msg: number[]) {
      port.messages.push([...msg])
    },
    closePort() {
      port.closed = true
    },
  }
  return port
}

/**
 * Build a mock backend from a list of port names.
 * Each `openPort(i)` call returns a fresh MockPort that is also appended to
 * `openedPorts` so tests can inspect sent bytes after the fact.
 */
function makeMockBackend(portNames: string[]): {
  backend: MidiBackend
  openedPorts: Map<number, MockPort>
} {
  const openedPorts = new Map<number, MockPort>()

  const backend: MidiBackend = {
    listPortNames: () => [...portNames],
    openPort(index: number): MidiBackendPort {
      const p = makeMockPort()
      openedPorts.set(index, p)
      return p
    },
  }

  return { backend, openedPorts }
}

// ---------------------------------------------------------------------------
// Port resolution (§1)
// ---------------------------------------------------------------------------

describe('RtMidiOutput — port resolution (§1)', () => {
  it('resolves by exact match', () => {
    const { backend } = makeMockBackend(['IAC Driver Bus 1'])
    const out = new RtMidiOutput(backend)
    expect(out.ensurePort('IAC Driver Bus 1')).toBe('IAC Driver Bus 1')
  })

  it('resolves by case-insensitive substring', () => {
    const { backend } = makeMockBackend(['IAC Driver Bus 1'])
    const out = new RtMidiOutput(backend)
    expect(out.ensurePort('iac driver')).toBe('IAC Driver Bus 1')
  })

  it('resolves localized name — "iac" matches "IACドライバ バス1"', () => {
    const { backend } = makeMockBackend(['IACドライバ バス1'])
    const out = new RtMidiOutput(backend)
    expect(out.ensurePort('iac')).toBe('IACドライバ バス1')
  })

  it('returns resolved name (not the query) when names differ', () => {
    const { backend } = makeMockBackend(['IACドライバ バス1'])
    const out = new RtMidiOutput(backend)
    const resolved = out.ensurePort('バス')
    expect(resolved).toBe('IACドライバ バス1')
  })

  it('is idempotent — calling ensurePort twice opens the port only once', () => {
    let openCount = 0
    const backend: MidiBackend = {
      listPortNames: () => ['TestPort'],
      openPort() {
        openCount++
        return makeMockPort()
      },
    }
    const out = new RtMidiOutput(backend)
    out.ensurePort('TestPort')
    out.ensurePort('TestPort')
    expect(openCount).toBe(1)
  })

  it('when multiple ports match, uses the first and warns', () => {
    const { backend } = makeMockBackend(['IAC Bus 1', 'IAC Bus 2', 'Other'])
    const out = new RtMidiOutput(backend)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolved = out.ensurePort('iac')
    expect(resolved).toBe('IAC Bus 1')
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]?.[0]).toContain('IAC Bus 1')
    expect(warnSpy.mock.calls[0]?.[0]).toContain('IAC Bus 2')

    warnSpy.mockRestore()
  })

  it('throws when no port matches, listing available ports', () => {
    const { backend } = makeMockBackend(['Foo', 'Bar'])
    const out = new RtMidiOutput(backend)
    expect(() => out.ensurePort('ZZZ')).toThrowError(/ZZZ/)
    expect(() => out.ensurePort('ZZZ')).toThrowError(/Foo/)
    expect(() => out.ensurePort('ZZZ')).toThrowError(/Bar/)
  })

  it('error message when no ports are available at all', () => {
    const { backend } = makeMockBackend([])
    const out = new RtMidiOutput(backend)
    expect(() => out.ensurePort('anything')).toThrowError(/none/)
  })
})

// ---------------------------------------------------------------------------
// noteOn / noteOff — status bytes and active-note tracking
// ---------------------------------------------------------------------------

describe('RtMidiOutput — noteOn / noteOff', () => {
  let out: RtMidiOutput
  let port0: MockPort

  beforeEach(() => {
    const { backend, openedPorts } = makeMockBackend(['TestPort'])
    out = new RtMidiOutput(backend)
    out.ensurePort('TestPort')
    port0 = openedPorts.get(0)!
  })

  it('noteOn channel 1 → status 0x90', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    expect(port0.messages[0]).toEqual([0x90, 60, 100])
  })

  it('noteOn channel 16 → status 0x9F', () => {
    out.noteOn('TestPort', 16, 64, 80, 'seq1')
    expect(port0.messages[0]).toEqual([0x9f, 64, 80])
  })

  it('noteOff channel 1 → status 0x80 with velocity 0', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOff('TestPort', 1, 60, 'seq1')
    expect(port0.messages[1]).toEqual([0x80, 60, 0])
  })

  it('noteOff channel 16 → status 0x8F', () => {
    out.noteOn('TestPort', 16, 64, 80, 'seq1')
    out.noteOff('TestPort', 16, 64, 'seq1')
    expect(port0.messages[1]).toEqual([0x8f, 64, 0])
  })

  it('noteOn adds to active tracking', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    const notes = out.getActiveNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ channel: 1, note: 60, owner: 'seq1' })
  })

  it('noteOff removes the matching entry from tracking', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOff('TestPort', 1, 60, 'seq1')
    expect(out.getActiveNotes()).toHaveLength(0)
  })

  it('noteOff for untracked note still sends the byte (idempotent safety)', () => {
    out.noteOff('TestPort', 1, 60, 'seq1')
    expect(port0.messages).toHaveLength(1)
    expect(port0.messages[0]).toEqual([0x80, 60, 0])
  })

  it('tracked active note carries the resolved port name', () => {
    // query is "test" but resolved is "TestPort"
    out.noteOn('test', 1, 60, 100, 'seq1')
    const notes = out.getActiveNotes()
    expect(notes[0]?.port).toBe('TestPort')
  })

  it('multiple noteOn for same pitch tracks each separately', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 1, 60, 80, 'seq2')
    expect(out.getActiveNotes()).toHaveLength(2)
  })

  it('noteOff removes only the first matching entry when duplicates exist', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 1, 60, 80, 'seq1')
    out.noteOff('TestPort', 1, 60, 'seq1')
    expect(out.getActiveNotes()).toHaveLength(1)
  })

  it('clamps note to 0..127', () => {
    out.noteOn('TestPort', 1, 200, 100, 'seq1') // over range
    expect(port0.messages[0]).toEqual([0x90, 127, 100])
    out.noteOn('TestPort', 1, -5, 100, 'seq1') // under range
    expect(port0.messages[1]).toEqual([0x90, 0, 100])
  })

  it('clamps velocity to 1..127 (never 0 to avoid note-off semantics)', () => {
    out.noteOn('TestPort', 1, 60, 0, 'seq1') // 0 → 1
    expect(port0.messages[0]?.[2]).toBe(1)
    out.noteOn('TestPort', 1, 60, 200, 'seq1') // 200 → 127
    expect(port0.messages[1]?.[2]).toBe(127)
  })

  it('getActiveNotes returns a copy (not a mutable reference)', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    const snap1 = out.getActiveNotes()
    out.noteOn('TestPort', 1, 62, 100, 'seq1')
    expect(snap1).toHaveLength(1) // original snapshot unchanged
    expect(out.getActiveNotes()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// releaseOwner
// ---------------------------------------------------------------------------

describe('RtMidiOutput — releaseOwner (§7-2)', () => {
  let out: RtMidiOutput
  let port0: MockPort

  beforeEach(() => {
    const { backend, openedPorts } = makeMockBackend(['TestPort'])
    out = new RtMidiOutput(backend)
    out.ensurePort('TestPort')
    port0 = openedPorts.get(0)!
  })

  it('sends note-offs only for the given owner, leaves others sounding', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seqA')
    out.noteOn('TestPort', 1, 62, 100, 'seqB') // different owner
    out.noteOn('TestPort', 1, 64, 100, 'seqA')

    out.releaseOwner('seqA')

    // seqA's two notes should have note-offs sent
    const noteOffMsgs = port0.messages.filter((m) => (m[0]! & 0xf0) === 0x80)
    expect(noteOffMsgs).toHaveLength(2)
    const offNotes = noteOffMsgs.map((m) => m[1])
    expect(offNotes).toContain(60)
    expect(offNotes).toContain(64)
  })

  it("removes released owner's notes from tracking, keeps others", () => {
    out.noteOn('TestPort', 1, 60, 100, 'seqA')
    out.noteOn('TestPort', 1, 62, 100, 'seqB')

    out.releaseOwner('seqA')

    const remaining = out.getActiveNotes()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.owner).toBe('seqB')
  })

  it('hanging-note invariant: after releaseOwner, active notes = 0', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 2, 64, 100, 'seq1')
    out.noteOn('TestPort', 3, 67, 100, 'seq1')

    out.releaseOwner('seq1')

    expect(out.getActiveNotes()).toHaveLength(0)
  })

  it('hanging-note invariant: note-off count == note-on count after releaseOwner', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 1, 64, 100, 'seq1')
    out.noteOn('TestPort', 1, 67, 100, 'seq1')

    const noteOnCount = port0.messages.filter((m) => (m[0]! & 0xf0) === 0x90).length
    out.releaseOwner('seq1')
    const noteOffCount = port0.messages.filter((m) => (m[0]! & 0xf0) === 0x80).length

    expect(noteOffCount).toBe(noteOnCount)
  })

  it('releaseOwner for unknown owner is a no-op', () => {
    out.noteOn('TestPort', 1, 60, 100, 'seqA')
    out.releaseOwner('seqB') // nothing to release
    expect(out.getActiveNotes()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// panic (§7-2, WCTM §8)
// ---------------------------------------------------------------------------

describe('RtMidiOutput — panic (§7-2)', () => {
  it('sends CC123 then CC120 on all 16 channels for each open port', () => {
    const { backend, openedPorts } = makeMockBackend(['Port A', 'Port B'])
    const out = new RtMidiOutput(backend)
    out.ensurePort('Port A')
    out.ensurePort('Port B')

    out.panic()

    for (const [, port] of openedPorts) {
      // 16 channels × 2 CC messages = 32 messages per port
      expect(port.messages).toHaveLength(32)

      for (let ch = 1; ch <= 16; ch++) {
        const wire = ch - 1
        // CC123 (All Notes Off) per channel
        const cc123 = port.messages[(ch - 1) * 2]
        expect(cc123).toEqual([0xb0 | wire, 123, 0])
        // CC120 (All Sound Off) per channel
        const cc120 = port.messages[(ch - 1) * 2 + 1]
        expect(cc120).toEqual([0xb0 | wire, 120, 0])
      }
    }
  })

  it('clears all active note tracking', () => {
    const { backend } = makeMockBackend(['TestPort'])
    const out = new RtMidiOutput(backend)
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 1, 64, 100, 'seq2')

    out.panic()

    expect(out.getActiveNotes()).toHaveLength(0)
  })

  it('panic on a single port sends exactly 32 CC messages', () => {
    const { backend, openedPorts } = makeMockBackend(['OnlyPort'])
    const out = new RtMidiOutput(backend)
    out.ensurePort('OnlyPort')
    out.panic()

    const port = openedPorts.get(0)!
    const ccMsgs = port.messages.filter((m) => (m[0]! & 0xf0) === 0xb0)
    expect(ccMsgs).toHaveLength(32) // 16 × CC123 + 16 × CC120
  })

  it('hanging-note invariant via panic: active notes == 0 after noteOn + panic', () => {
    const { backend } = makeMockBackend(['TestPort'])
    const out = new RtMidiOutput(backend)
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.noteOn('TestPort', 2, 62, 100, 'seq1')
    out.panic()
    expect(out.getActiveNotes()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// pitchBend (§2.4)
// ---------------------------------------------------------------------------

describe('RtMidiOutput — pitchBend (§2.4)', () => {
  let out: RtMidiOutput
  let port0: MockPort

  beforeEach(() => {
    const { backend, openedPorts } = makeMockBackend(['TestPort'])
    out = new RtMidiOutput(backend)
    out.ensurePort('TestPort')
    port0 = openedPorts.get(0)!
  })

  it('center (0 semitones) → 14-bit 8192 → [lsb=0x00, msb=0x40]', () => {
    out.pitchBend('TestPort', 1, 0)
    // 8192 = 0x2000: lsb = 0x00, msb = 0x40
    expect(port0.messages[0]).toEqual([0xe0, 0x00, 0x40])
  })

  it('full up (+2 semitones) → 16383 → [lsb=0x7F, msb=0x7F]', () => {
    out.pitchBend('TestPort', 1, 2)
    expect(port0.messages[0]).toEqual([0xe0, 0x7f, 0x7f])
  })

  it('full down (-2 semitones) → 0 → [lsb=0x00, msb=0x00]', () => {
    out.pitchBend('TestPort', 1, -2)
    expect(port0.messages[0]).toEqual([0xe0, 0x00, 0x00])
  })

  it('clamps semitones beyond +2 to 16383', () => {
    out.pitchBend('TestPort', 1, 999)
    expect(port0.messages[0]).toEqual([0xe0, 0x7f, 0x7f])
  })

  it('clamps semitones below -2 to 0', () => {
    out.pitchBend('TestPort', 1, -999)
    expect(port0.messages[0]).toEqual([0xe0, 0x00, 0x00])
  })

  it('status byte uses correct channel — channel 1 → 0xE0, channel 16 → 0xEF', () => {
    out.pitchBend('TestPort', 1, 0)
    out.pitchBend('TestPort', 16, 0)
    expect(port0.messages[0]?.[0]).toBe(0xe0)
    expect(port0.messages[1]?.[0]).toBe(0xef)
  })

  it('+1 semitone maps to roughly the midpoint between center and max', () => {
    out.pitchBend('TestPort', 1, 1)
    const msg = port0.messages[0]!
    const value = msg[1]! | (msg[2]! << 7)
    // +1/2 * 8192 + 8192 = 12288
    expect(value).toBe(12288)
  })
})

// ---------------------------------------------------------------------------
// listPorts and closeAll
// ---------------------------------------------------------------------------

describe('RtMidiOutput — listPorts', () => {
  it('returns port names from backend', () => {
    const { backend } = makeMockBackend(['Port Alpha', 'Port Beta'])
    const out = new RtMidiOutput(backend)
    expect(out.listPorts()).toEqual(['Port Alpha', 'Port Beta'])
  })
})

describe('RtMidiOutput — closeAll', () => {
  it('closes all open ports', () => {
    const { backend, openedPorts } = makeMockBackend(['Port X', 'Port Y'])
    const out = new RtMidiOutput(backend)
    out.ensurePort('Port X')
    out.ensurePort('Port Y')

    out.closeAll()

    expect(openedPorts.get(0)?.closed).toBe(true)
    expect(openedPorts.get(1)?.closed).toBe(true)
  })

  it('sends panic (CC123+CC120 on all channels) before closing', () => {
    const { backend, openedPorts } = makeMockBackend(['TestPort'])
    const out = new RtMidiOutput(backend)
    out.ensurePort('TestPort')
    out.noteOn('TestPort', 1, 60, 100, 'seq1')

    out.closeAll()

    const port = openedPorts.get(0)!
    const ccMsgs = port.messages.filter((m) => (m[0]! & 0xf0) === 0xb0)
    expect(ccMsgs).toHaveLength(32)
  })

  it('clears active note tracking', () => {
    const { backend } = makeMockBackend(['TestPort'])
    const out = new RtMidiOutput(backend)
    out.noteOn('TestPort', 1, 60, 100, 'seq1')
    out.closeAll()
    expect(out.getActiveNotes()).toHaveLength(0)
  })
})
