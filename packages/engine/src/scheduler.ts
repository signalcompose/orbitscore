import type { IR } from "./ir";
import type { MidiOut } from "./midi";

const LOOK_AHEAD_MS = 50;
const TICK_MS = 5;

/** 共有/独立メーターに対応する再生位置とループを管理し、NoteOn/Off を窓出し */
export class Scheduler {
  constructor(private out: MidiOut, private ir: IR) {}
  start() {
    // TODO:
    // - グローバル Playhead（Bar:Beat）を進める
    // - Loop 窓 (startBar,endBar,enabled) と Jump/Scene/Mute/Solo を小節頭で反映
    // - shared: 全シーケンスが同じ小節線を共有
    // - independent: 各シーケンスが自分の小節線で回り込み
  }
  stop() {}
}
