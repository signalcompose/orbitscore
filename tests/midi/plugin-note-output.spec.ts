import { describe, expect, it, vi } from 'vitest'

import { PluginNoteOutput } from '../../packages/engine/src/midi/plugin-note-output'

function harness() {
  const engine = {
    pluginNoteOn: vi.fn().mockResolvedValue(undefined),
    pluginNoteOff: vi.fn().mockResolvedValue(undefined),
  } as any
  return { engine, output: new PluginNoteOutput(engine) }
}

describe('PluginNoteOutput', () => {
  it.each([
    [1, 1 / 127],
    [127, 1],
    [-10, 1 / 127],
    [200, 1],
  ])('normalizes and clamps velocity %s', (velocity, normalized) => {
    const { engine, output } = harness()
    output.noteOn('plugin', 1, 60, velocity, 'lead')
    expect(engine.pluginNoteOn).toHaveBeenCalledWith(60, 0, normalized)
  })

  it('tracks noteOn/Off and maps scheduler channel 1 to wire channel 0', () => {
    const { engine, output } = harness()
    output.noteOn('plugin', 1, 60, 96, 'lead')
    expect(output.getActiveNotes()).toEqual([
      { port: 'plugin', channel: 1, note: 60, owner: 'lead' },
    ])
    output.noteOff('plugin', 1, 60, 'lead')
    expect(engine.pluginNoteOff).toHaveBeenCalledWith(60, 0)
    expect(output.getActiveNotes()).toEqual([])
  })

  it('panic enumerates active notes and clears tracking', () => {
    const { engine, output } = harness()
    output.noteOn('a', 1, 60, 96, 'lead')
    output.noteOn('b', 2, 64, 96, 'pad')
    output.panic()
    expect(engine.pluginNoteOff.mock.calls).toEqual([
      [60, 0],
      [64, 1],
    ])
    expect(output.getActiveNotes()).toEqual([])
  })

  it('releaseOwner releases only that owner and pitchBend is a silent no-op', () => {
    const { engine, output } = harness()
    output.noteOn('plugin', 1, 60, 96, 'lead')
    output.noteOn('plugin', 1, 64, 96, 'pad')
    output.pitchBend('plugin', 1, 1)
    output.releaseOwner('lead')
    expect(engine.pluginNoteOff).toHaveBeenCalledTimes(1)
    expect(output.getActiveNotes()).toEqual([
      { port: 'plugin', channel: 1, note: 64, owner: 'pad' },
    ])
  })

  it('accepts virtual ports, lists no hardware ports, and closeAll panics', () => {
    const { engine, output } = harness()
    expect(output.ensurePort('anything')).toBe('anything')
    expect(output.listPorts()).toEqual([])
    output.noteOn('plugin', 1, 60, 96, 'lead')
    output.closeAll()
    expect(engine.pluginNoteOff).toHaveBeenCalledWith(60, 0)
  })
})
