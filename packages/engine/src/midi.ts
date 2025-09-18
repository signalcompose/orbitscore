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
export class CoreMidiSink implements MidiOut {
  private sent: MidiMessage[] = []
  
  async open(portName: string = 'IAC Driver Bus 1'): Promise<void> {
    console.log(`Opening MIDI port: ${portName}`)
    // TODO: Implement with @julusian/midi
  }
  
  send(msg: MidiMessage): void {
    // For now, just log
    console.log(`MIDI: [${msg.timeMs}ms] ${msg.status.toString(16)} ${msg.data1} ${msg.data2}`)
    this.sent.push(msg)
  }
  
  async close(): Promise<void> {
    console.log('Closing MIDI port')
    // TODO: Implement with @julusian/midi
  }
}
