import { describe, it, expect } from 'vitest';
import { parseSourceToIR } from '../../packages/engine/src/parser/parser';
import { Scheduler, durationToSeconds } from '../../packages/engine/src/scheduler';
import { TestMidiSink } from '../../packages/engine/src/midi';

const src = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  channel 1
  tempo 120
  meter 4/4 shared
  octave 0.0
  (1@U0.5, 5@U1)  0@U0.5  3@2s  12@25%2bars
}
`;

describe('Scheduler offline render', () => {
  it('should convert durations to seconds and schedule notes', () => {
    const ir = parseSourceToIR(src);
    const sink = new TestMidiSink();
    const sched = new Scheduler(sink as any, ir);
    const msgs = sched.renderOffline();

    // Expect some NoteOn and NoteOff pairs
    const noteOns = msgs.filter(m => (m.status & 0xf0) === 0x90);
    const noteOffs = msgs.filter(m => (m.status & 0xf0) === 0x80);
    expect(noteOns.length).toBeGreaterThan(0);
    expect(noteOffs.length).toBeGreaterThan(0);

    // First chord starts at t=0ms, second event is rest U0.5 → 120BPM, 4/4 → U1=quarter=0.5s
    // U0.5 = 0.25s
    const chordOnTimes = noteOns.slice(0, 2).map(n => n.timeMs);
    expect(chordOnTimes.every(t => t === 0)).toBe(true);

    // Chord durations: U0.5 (0.25s) and U1 (0.5s). Group duration=max=0.5s → next start at 500ms
    const afterChordStart = msgs.filter(m => m.timeMs === 500).length;
    expect(afterChordStart).toBeGreaterThan(0);

    // Rest U0.5 adds another 250ms → next start at 750ms
    const afterRestStart = msgs.filter(m => m.timeMs === 750).length;
    expect(afterRestStart).toBeGreaterThan(0);
  });
});
