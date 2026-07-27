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
    output.noteOn('plugin:lead', 1, 60, velocity, 'lead')
    // #540 P1: port（`plugin:<seqName>`）は daemon の instance ID としてそのまま渡る。
    expect(engine.pluginNoteOn).toHaveBeenCalledWith(60, 0, normalized, 'plugin:lead')
  })

  it('tracks noteOn/Off and maps scheduler channel 1 to wire channel 0', () => {
    const { engine, output } = harness()
    output.noteOn('plugin:lead', 1, 60, 96, 'lead')
    expect(output.getActiveNotes()).toEqual([
      { port: 'plugin:lead', channel: 1, note: 60, owner: 'lead' },
    ])
    output.noteOff('plugin:lead', 1, 60, 'lead')
    expect(engine.pluginNoteOff).toHaveBeenCalledWith(60, 0, undefined, 'plugin:lead')
    expect(output.getActiveNotes()).toEqual([])
  })

  it('panic enumerates active notes and clears tracking, keeping each note addressed to its own instance', () => {
    const { engine, output } = harness()
    output.noteOn('plugin:a', 1, 60, 96, 'lead')
    output.noteOn('plugin:b', 2, 64, 96, 'pad')
    output.panic()
    // #540 P1: 異なるシーケンス（= 異なる instance）の note-off が入れ替わらないこと。
    expect(engine.pluginNoteOff.mock.calls).toEqual([
      [60, 0, undefined, 'plugin:a'],
      [64, 1, undefined, 'plugin:b'],
    ])
    expect(output.getActiveNotes()).toEqual([])
  })

  it('releaseOwner releases only that owner and pitchBend is a silent no-op', () => {
    const { engine, output } = harness()
    output.noteOn('plugin:lead', 1, 60, 96, 'lead')
    output.noteOn('plugin:lead', 1, 64, 96, 'pad')
    output.pitchBend('plugin:lead', 1, 1)
    output.releaseOwner('lead')
    expect(engine.pluginNoteOff).toHaveBeenCalledTimes(1)
    expect(engine.pluginNoteOff).toHaveBeenCalledWith(60, 0, undefined, 'plugin:lead')
    expect(output.getActiveNotes()).toEqual([
      { port: 'plugin:lead', channel: 1, note: 64, owner: 'pad' },
    ])
  })

  it('accepts virtual ports, lists no hardware ports, and closeAll panics', () => {
    const { engine, output } = harness()
    expect(output.ensurePort('anything')).toBe('anything')
    expect(output.listPorts()).toEqual([])
    output.noteOn('plugin:lead', 1, 60, 96, 'lead')
    output.closeAll()
    expect(engine.pluginNoteOff).toHaveBeenCalledWith(60, 0, undefined, 'plugin:lead')
  })
})
