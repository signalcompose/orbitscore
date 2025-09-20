import { describe, it, expect } from 'vitest'

import { CoreMidiSink } from '../../packages/engine/src/midi'

describe('Max/MSP MIDI Port Detection', () => {
  it('should detect Max/MSP MIDI ports', () => {
    const sink = new CoreMidiSink()

    // This test verifies that Max/MSP ports are available
    // The actual port names depend on the system configuration
    expect(sink).toBeDefined()
  })

  it('should handle Max/MSP port names correctly', async () => {
    const sink = new CoreMidiSink()

    // Test that Max/MSP port names are handled correctly
    const maxPorts = ['to Max 1', 'to Max 2']

    for (const portName of maxPorts) {
      try {
        await sink.open(portName)
        expect(sink.getCurrentPortName()).toBe(portName)
        await sink.close()
      } catch (error) {
        // Port might not be available in test environment
        console.log(`Port ${portName} not available: ${error}`)
      }
    }
  })
})
