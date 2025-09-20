import { beforeEach, describe, expect, it, vi } from 'vitest'

const openPortByNameMock = vi.fn<void, [string]>()
const openPortMock = vi.fn<void, [number]>()
const getPortCountMock = vi.fn<number, []>()
const getPortNameMock = vi.fn<string, [number]>()
const isPortOpenMock = vi.fn<boolean, []>()
const closePortMock = vi.fn<void, []>()
const destroyMock = vi.fn<void, []>()
const sendMessageMock = vi.fn<void, [number[]]>()

vi.mock('@julusian/midi', () => ({
  Output: class {
    openPortByName = openPortByNameMock
    openPort = openPortMock
    getPortCount = getPortCountMock
    getPortName = getPortNameMock
    isPortOpen = isPortOpenMock
    closePort = closePortMock
    destroy = destroyMock
    sendMessage = sendMessageMock
  },
}))

import { CoreMidiSink } from '../../packages/engine/src/midi'

describe('CoreMidiSink', () => {
  beforeEach(() => {
    openPortByNameMock.mockReset()
    openPortMock.mockReset()
    getPortCountMock.mockReset().mockReturnValue(1)
    getPortNameMock
      .mockReset()
      .mockImplementation((index) => (index === 0 ? 'Mock Port' : 'Unknown'))
    isPortOpenMock.mockReset().mockReturnValue(true)
    closePortMock.mockReset()
    destroyMock.mockReset()
    sendMessageMock.mockReset()
  })

  it('opens MIDI port by name when available', async () => {
    const sink = new CoreMidiSink()

    await sink.open('Mock Port')

    expect(openPortByNameMock).toHaveBeenCalledWith('Mock Port')
    expect(openPortMock).not.toHaveBeenCalled()
  })

  it('falls back to port enumeration when direct open fails', async () => {
    openPortByNameMock.mockImplementationOnce(() => {
      // Simulate driver not opening the port
    })
    isPortOpenMock.mockReset()
    isPortOpenMock.mockReturnValueOnce(false).mockReturnValueOnce(true)
    getPortCountMock.mockReturnValue(2)
    getPortNameMock.mockImplementation((index) => (index === 0 ? 'Target Bus' : 'Other'))

    const sink = new CoreMidiSink()
    await sink.open('Target Bus')

    expect(openPortByNameMock).toHaveBeenCalledWith('Target Bus')
    expect(openPortMock).toHaveBeenCalledWith(0)
  })

  it('clamps data bytes when sending MIDI messages', async () => {
    const sink = new CoreMidiSink()
    await sink.open('Mock Port')

    sendMessageMock.mockClear()

    sink.send({ timeMs: 0, status: 0x190, data1: 300, data2: -2 })

    expect(sendMessageMock).toHaveBeenCalledWith([0x90, 127, 0])
  })

  it('throws if send is called before opening a port', () => {
    const sink = new CoreMidiSink()

    expect(() => sink.send({ timeMs: 0, status: 0x90, data1: 60, data2: 100 })).toThrow()
  })

  it('closes and destroys the MIDI output on shutdown', async () => {
    const sink = new CoreMidiSink()
    await sink.open('Mock Port')

    await sink.close()

    expect(closePortMock).toHaveBeenCalled()
    expect(destroyMock).toHaveBeenCalled()
  })
})
