import * as dgram from 'dgram'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('Max/MSP UDP Telemetry Integration', () => {
  let server: dgram.Socket
  let receivedMessages: string[] = []
  let port: number

  beforeEach(async () => {
    // Use a random port to avoid conflicts
    port = 7474 + Math.floor(Math.random() * 1000)
    server = dgram.createSocket('udp4')
    receivedMessages = []

    server.on('message', (msg) => {
      receivedMessages.push(msg.toString())
    })

    return new Promise<void>((resolve) => {
      server.bind(port, () => {
        console.log(`UDP server listening on port ${port}`)
        resolve()
      })
    })
  }, 5000)

  afterEach(async () => {
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }, 5000)

  it('should receive MIDI note events from Max/MSP', async () => {
    // Simulate Max/MSP sending a note event
    const testMessage = '{"type":"note","ch":1,"note":60,"vel":100}'

    // Send test message to our UDP server
    const client = dgram.createSocket('udp4')
    client.send(testMessage, port, '127.0.0.1')

    // Wait for message to be received
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]).toBe(testMessage)

    client.close()
  })

  it('should receive MIDI CC events from Max/MSP', async () => {
    const testMessage = '{"type":"cc","ch":1,"cc":1,"val":64}'

    const client = dgram.createSocket('udp4')
    client.send(testMessage, port, '127.0.0.1')

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]).toBe(testMessage)

    client.close()
  })

  it('should receive MIDI pitch bend events from Max/MSP', async () => {
    const testMessage = '{"type":"pb","ch":1,"val":8192}'

    const client = dgram.createSocket('udp4')
    client.send(testMessage, port, '127.0.0.1')

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]).toBe(testMessage)

    client.close()
  })
})
