import { describe, it, expect } from "vitest";

import { parseSourceToIR } from "../../packages/engine/src/parser/parser";
import { barDurationSeconds, quantizeToNextBar } from "../../packages/engine/src/scheduler";

const src = `
key C
tempo 120
meter 4/4 shared

sequence a {
  channel 1
  tempo 120
  meter 5/4 independent
}
`;

describe("quantizeToNextBar", () => {
  it("shared uses global bar, independent uses sequence bar", () => {
    const ir = parseSourceToIR(src);
    const seq = ir.sequences[0]!;

    // bar durations
    const barShared = barDurationSeconds(
      {
        ...seq,
        config: { ...seq.config, meter: { n: 5, d: 4, align: "shared" } },
      },
      ir,
    );
    const barIndep = barDurationSeconds(
      {
        ...seq,
        config: { ...seq.config, meter: { n: 5, d: 4, align: "independent" } },
      },
      ir,
    );
    expect(barShared).toBeCloseTo(2.0, 3); // 4/4 @120 -> 2.0s
    expect(barIndep).toBeCloseTo(2.5, 3); // 5/4 @120 -> 2.5s

    // quantize
    expect(
      quantizeToNextBar(
        2.1,
        {
          ...seq,
          config: { ...seq.config, meter: { n: 5, d: 4, align: "shared" } },
        },
        ir,
      ),
    ).toBeCloseTo(4.0, 3);
    expect(
      quantizeToNextBar(
        2.1,
        {
          ...seq,
          config: {
            ...seq.config,
            meter: { n: 5, d: 4, align: "independent" },
          },
        },
        ir,
      ),
    ).toBeCloseTo(2.5, 3);
  });
});
