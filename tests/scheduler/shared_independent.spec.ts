import { describe, it, expect } from 'vitest';
import { parseSourceToIR } from '../../packages/engine/src/parser/parser';
import { Scheduler } from '../../packages/engine/src/scheduler';
import { TestMidiSink } from '../../packages/engine/src/midi';

const src = `
key C
tempo 120
meter 4/4 shared

sequence indepSeq {
  channel 1
  meter 5/4 independent
  tempo 120
  octave 0.0
  1@25%1bars
}

sequence sharedSeq {
  channel 2
  meter 5/4 shared
  tempo 120
  octave 0.0
  1@25%1bars
}
`;

describe('Scheduler: shared vs independent percent duration', () => {
  it('uses sequence meter for independent and global meter for shared', () => {
    const ir = parseSourceToIR(src);
    const sink = new TestMidiSink();
    const sched = new Scheduler(sink as any, ir);
    const msgs = sched.renderOffline();

    // helper to get duration of first note for a channel
    function durationMsForChannel(ch: number): number {
      const noteOns = msgs.filter(m => (m.status & 0xf0) === 0x90 && ((m.status & 0x0f) + 1) === ch);
      const noteOffs = msgs.filter(m => (m.status & 0xf0) === 0x80 && ((m.status & 0x0f) + 1) === ch);
      expect(noteOns.length).toBeGreaterThan(0);
      expect(noteOffs.length).toBeGreaterThan(0);
      return noteOffs[0]!.timeMs - noteOns[0]!.timeMs;
    }

    const durIndepMs = durationMsForChannel(1);
    const durSharedMs = durationMsForChannel(2);

    // independent: 5/4 → 1 bar = 5 * quarter(0.5s) = 2.5s → 25% = 0.625s
    expect(durIndepMs).toBeCloseTo(625, 0);

    // shared: global 4/4 → 1 bar = 4 * quarter(0.5s) = 2.0s → 25% = 0.5s
    expect(durSharedMs).toBeCloseTo(500, 0);
  });
});
