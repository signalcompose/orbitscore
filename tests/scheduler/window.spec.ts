import { describe, it, expect } from "vitest";

import { parseSourceToIR } from "../../packages/engine/src/parser/parser";
import { Scheduler } from "../../packages/engine/src/scheduler";
import { TestMidiSink } from "../../packages/engine/src/midi";

const src = `
key C
tempo 120
meter 4/4 shared

sequence s {
  channel 1
  tempo 120
  meter 4/4 shared
  octave 0.0
  1@U1 1@U1 1@U1 1@U1
}
`;

describe("Scheduler collectWindow", () => {
  it("collects messages inside a time window", () => {
    const ir = parseSourceToIR(src);
    const sched = new Scheduler(new TestMidiSink() as any, ir);
    const msgs = sched.collectWindow(0, 1000); // 1秒
    // 120BPM 4/4, U1=quarter=0.5s → 0ms, 500ms のNoteOnが含まれる想定
    const noteOns = msgs.filter((m) => (m.status & 0xf0) === 0x90);
    expect(noteOns.some((m) => m.timeMs === 0)).toBe(true);
    expect(noteOns.some((m) => m.timeMs === 500)).toBe(true);
  });
});
