import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { parseSourceToIR } from '../../packages/engine/src/parser/parser'
import { Scheduler } from '../../packages/engine/src/scheduler'
import { TestMidiSink } from '../../packages/engine/src/midi'

describe('Live Coding Integration', () => {
  let scheduler: Scheduler
  let midiSink: TestMidiSink

  beforeEach(() => {
    midiSink = new TestMidiSink()
  })

  afterEach(() => {
    if (scheduler) {
      scheduler.stop()
    }
  })

  it('should start with initial code and continue playing', async () => {
    const initialCode = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 3@U1 5@U1 8@U1
}
`

    const ir = parseSourceToIR(initialCode)
    scheduler = new Scheduler(midiSink, ir)
    scheduler.start()

    // Wait for some events to be scheduled
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(scheduler.isPlaying()).toBe(true)
    expect(midiSink.sent.length).toBeGreaterThan(0)
  })

  it('should update sequences live without stopping playback', async () => {
    const initialCode = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 3@U1 5@U1 8@U1
}
`

    const updatedCode = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 5@U1 8@U1 12@U1
}
`

    // Start with initial code
    const initialIR = parseSourceToIR(initialCode)
    scheduler = new Scheduler(midiSink, initialIR)
    scheduler.start()

    // Wait for initial events
    await new Promise((resolve) => setTimeout(resolve, 100))
    const initialMessageCount = midiSink.sent.length

    // Live update with new code
    const updatedIR = parseSourceToIR(updatedCode)
    scheduler.liveUpdate(updatedIR)

    // Wait for new events
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Should still be playing and have new events
    expect(scheduler.isPlaying()).toBe(true)
    expect(midiSink.sent.length).toBeGreaterThan(initialMessageCount)
  })

  it('should handle multiple sequence updates', async () => {
    const code1 = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 3@U1
}
`

    const code2 = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  5@U1 8@U1
}
`

    const code3 = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 3@U1 5@U1 8@U1
}
`

    // Start with first code
    const ir1 = parseSourceToIR(code1)
    scheduler = new Scheduler(midiSink, ir1)
    scheduler.start()

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Update to second code
    const ir2 = parseSourceToIR(code2)
    scheduler.liveUpdate(ir2)

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Update to third code
    const ir3 = parseSourceToIR(code3)
    scheduler.liveUpdate(ir3)

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should still be playing throughout all updates
    expect(scheduler.isPlaying()).toBe(true)
    expect(midiSink.sent.length).toBeGreaterThan(0)
  })

  it('should maintain loop state during live updates', async () => {
    const code = `
key C
tempo 120
meter 4/4 shared

sequence piano {
  bus "IAC Driver Bus 1"
  channel 1
  meter 4/4 shared
  tempo 120
  octave 4
  defaultDur @U1
  
  1@U1 3@U1 5@U1 8@U1
}
`

    const ir = parseSourceToIR(code)
    scheduler = new Scheduler(midiSink, ir)
    scheduler.start()

    // Set a loop
    scheduler.setLoop({ startBar: 0, endBar: 2, enabled: true })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Live update
    scheduler.liveUpdate(ir)

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Loop state should be maintained
    const loopState = scheduler.getLoopState()
    expect(loopState.enabled).toBe(true)
    expect(loopState.startBar).toBe(0)
    expect(loopState.endBar).toBe(2)
  })
})
