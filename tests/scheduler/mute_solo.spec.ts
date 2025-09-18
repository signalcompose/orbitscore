import { describe, it, expect } from 'vitest';
import { parseSourceToIR } from '../../packages/engine/src/parser/parser';
import { Scheduler } from '../../packages/engine/src/scheduler';
import { TestMidiSink } from '../../packages/engine/src/midi';

const src = `
key C
tempo 120
meter 4/4 shared

sequence a {
  channel 1
  tempo 120
  1@U1
}

sequence b {
  channel 2
  tempo 120
  1@U1
}
`;

describe('mute/solo filtering in collectWindow', () => {
  it('mutes sequence a and allows only b', () => {
    const ir = parseSourceToIR(src);
    const sched = new Scheduler(new TestMidiSink() as any, ir);
    sched.setMute('a', true);
    const msgs = sched.collectWindow(0, 2000);
    const chs = new Set(msgs.map(m => ((m.status & 0x0f) + 1)));
    expect(chs.has(1)).toBe(false);
    expect(chs.has(2)).toBe(true);
  });

  it('solos sequence a only', () => {
    const ir = parseSourceToIR(src);
    const sched = new Scheduler(new TestMidiSink() as any, ir);
    sched.setSolo(['a']);
    const msgs = sched.collectWindow(0, 2000);
    const chs = new Set(msgs.map(m => ((m.status & 0x0f) + 1)));
    expect(chs.has(1)).toBe(true);
    expect(chs.has(2)).toBe(false);
  });
});
