import { parseSourceToIR } from "../../packages/engine/src/parser/parser";
import * as fs from "node:fs";
import * as assert from "node:assert";

const src = fs.readFileSync("examples/demo.osc", "utf8");
const ir = parseSourceToIR(src);
assert.ok(ir.sequences.length >= 1, "sequence parsed");
assert.equal(ir.global.tempo, 120);
