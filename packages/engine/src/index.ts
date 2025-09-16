import { parseSourceToIR } from "./parser/parser";
import { TestMidiSink } from "./midi";
import { Scheduler } from "./scheduler";
import * as fs from "node:fs";

const file = process.argv[2] ?? "examples/demo.osc";
const src = fs.readFileSync(file, "utf8");
const ir = parseSourceToIR(src);
const sink = new TestMidiSink(); // 実機は CoreMIDI へ切替
const sched = new Scheduler(sink as any, ir);
sched.start();
console.log("OrbitScore Engine started (test sink). Ctrl+C to stop.");
