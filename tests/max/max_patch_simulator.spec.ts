import * as dgram from 'dgram'

import { describe, it, expect } from 'vitest'

interface MidiEvent {
  type: 'note' | 'cc' | 'pb'
  ch: number
  note?: number
  vel?: number
  cc?: number
  val: number
}

class MaxPatchSimulator {
  private client: dgram.Socket
  private port: number
  private host: string

  constructor(port: number = 7474, host: string = '127.0.0.1') {
    this.client = dgram.createSocket('udp4')
    this.port = port
    this.host = host
  }

  sendMidiEvent(event: MidiEvent): void {
    const message = JSON.stringify(event)
    this.client.send(message, this.port, this.host)
  }

  sendNoteOn(channel: number, note: number, velocity: number): void {
    this.sendMidiEvent({
      type: 'note',
      ch: channel,
      note: note,
      vel: velocity,
      val: 0,
    })
  }

  sendNoteOff(channel: number, note: number): void {
    this.sendMidiEvent({
      type: 'note',
      ch: channel,
      note: note,
      vel: 0,
      val: 0,
    })
  }

  sendCC(channel: number, controller: number, value: number): void {
    this.sendMidiEvent({
      type: 'cc',
      ch: channel,
      cc: controller,
      val: value,
    })
  }

  sendPitchBend(channel: number, value: number): void {
    this.sendMidiEvent({
      type: 'pb',
      ch: channel,
      val: value,
    })
  }

  close(): void {
    this.client.close()
  }
}

describe('Max/MSP Patch Simulator', () => {
  let simulator: MaxPatchSimulator
  let server: dgram.Socket
  let receivedMessages: string[] = []

  beforeEach(async () => {
    simulator = new MaxPatchSimulator()
    server = dgram.createSocket('udp4')
    receivedMessages = []

    server.on('message', (msg) => {
      receivedMessages.push(msg.toString())
    })

    return new Promise<void>((resolve) => {
      server.bind(7474, () => {
        resolve()
      })
    })
  }, 5000)

  afterEach(async () => {
    simulator.close()
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }, 5000)

  it('should simulate note on events', async () => {
    simulator.sendNoteOn(1, 60, 100)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    const event = JSON.parse(receivedMessages[0])
    expect(event.type).toBe('note')
    expect(event.ch).toBe(1)
    expect(event.note).toBe(60)
    expect(event.vel).toBe(100)
  })

  it('should simulate note off events', async () => {
    simulator.sendNoteOff(1, 60)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    const event = JSON.parse(receivedMessages[0])
    expect(event.type).toBe('note')
    expect(event.ch).toBe(1)
    expect(event.note).toBe(60)
    expect(event.vel).toBe(0)
  })

  it('should simulate CC events', async () => {
    simulator.sendCC(1, 1, 64)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    const event = JSON.parse(receivedMessages[0])
    expect(event.type).toBe('cc')
    expect(event.ch).toBe(1)
    expect(event.cc).toBe(1)
    expect(event.val).toBe(64)
  })

  it('should simulate pitch bend events', async () => {
    simulator.sendPitchBend(1, 8192)

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    const event = JSON.parse(receivedMessages[0])
    expect(event.type).toBe('pb')
    expect(event.ch).toBe(1)
    expect(event.val).toBe(8192)
  })
})
