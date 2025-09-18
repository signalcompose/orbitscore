export type MidiMessage = {
  timeMs: number
  status: number
  data1: number
  data2: number
}

export interface MidiOut {
  open(portName: string): Promise<void>
  send(msg: MidiMessage): void
  close(): Promise<void>
}

export class TestMidiSink implements MidiOut {
  public sent: MidiMessage[] = []
  async open(): Promise<void> {}
  send(m: MidiMessage) {
    this.sent.push(m)
  }
  async close(): Promise<void> {}
}

// TODO: CoreMIDI 実装（@julusian/midi で IAC を開く）
