import { describe, it, expect } from "vitest";

import { parseSourceToIR } from "../../packages/engine/src/parser/parser";
import {
  barIndexToSeconds,
  computeLoopApplyTime,
  planJump,
} from "../../packages/engine/src/scheduler";

const src = `
key C
tempo 120
meter 4/4 shared

sequence s {
  channel 1
  tempo 120
  meter 4/4 shared
}
`;

describe("Loop/Jump planning", () => {
  it("computes apply time at next bar and jump targets", () => {
    const ir = parseSourceToIR(src);
    const seq = ir.sequences[0]!;

    // bar index to seconds (4/4 @120 => 2.0s per bar)
    expect(barIndexToSeconds(0, seq, ir)).toBeCloseTo(0.0, 3);
    expect(barIndexToSeconds(1, seq, ir)).toBeCloseTo(2.0, 3);
    expect(barIndexToSeconds(3, seq, ir)).toBeCloseTo(6.0, 3);

    // quantized apply (next bar boundary)
    expect(computeLoopApplyTime(2.1, seq, ir)).toBeCloseTo(4.0, 3);

    // jump plan: apply at next boundary, jump to target bar head
    const plan = planJump(2.1, 5, seq, ir);
    expect(plan.applyAtSec).toBeCloseTo(4.0, 3);
    expect(plan.jumpToSec).toBeCloseTo(10.0, 3);
  });
});
