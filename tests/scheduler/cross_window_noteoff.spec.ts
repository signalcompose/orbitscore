import { describe, it, expect } from 'vitest';
import { parseSourceToIR } from '../../packages/engine/src/parser/parser';
import { Scheduler } from '../../packages/engine/src/scheduler';
import { TestMidiSink } from '../../packages/engine/src/midi';

const src = `
key C
tempo 120
meter 4/4 shared

sequence s {
  channel 1
  tempo 120
  meter 4/4 shared
  octave 0.0
  1@U2
}
`;

describe('cross-window NoteOff scheduling', () => {
  it('NoteOff appears in later window even if NoteOn was earlier', () => {
    const ir = parseSourceToIR(src);
    const sched = new Scheduler(new TestMidiSink() as any, ir);

    // window 0-500ms
    const w1 = sched.collectWindow(0, 500);
    const hasOn0 = w1.some(m => (m.status & 0xf0) === 0x90 && m.timeMs === 0);
    expect(hasOn0).toBe(true);

    // window 500-1000ms should contain NoteOff at 1000ms for U2 (1s)
    const w2 = sched.collectWindow(500, 1001);
    const hasOff1s = w2.some(m => (m.status & 0xf0) === 0x80 && m.timeMs === 1000);
    expect(hasOff1s).toBe(true);
  });
});
