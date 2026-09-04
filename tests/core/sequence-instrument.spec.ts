import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { MidiManager } from '../../packages/engine/src/core/global/midi-manager'
import type { MidiOutput } from '../../packages/engine/src/midi/midi-output'

const T0 = 1_000_000

function scheduler() {
  return {
    isRunning: true,
    startTime: T0,
    getCurrentTime: () => 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    getMasterGainDb: () => 0,
  } as never
}

function harness() {
  const audio = scheduler() as any
  audio.loadPlugin = vi.fn().mockResolvedValue({})
  audio.pluginNoteOn = vi.fn().mockResolvedValue(undefined)
  audio.pluginNoteOff = vi.fn().mockResolvedValue(undefined)
  const midiOutput: MidiOutput = {
    ensurePort: vi.fn(() => 'IAC'),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    releaseOwner: vi.fn(),
    panic: vi.fn(),
    getActiveNotes: vi.fn(() => []),
    listPorts: vi.fn(() => ['IAC']),
    closeAll: vi.fn(),
  }
  const global = new Global(audio, new MidiManager(() => midiOutput))
  global.setDocumentDirectory('/songs')
  global.key('C')
  const seq = new Sequence(global, audio)
  seq.setName('synth')
  return { audio, global, seq }
}

describe('Sequence instrument dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('accepts a VST3 instrument declaration', async () => {
    const { audio, seq } = harness()
    await expect(seq.instrument('synth.vst3')).resolves.toBe(seq)
    // #540 P1: instance は note 側 port と同じ `plugin:<seqName>` 規約（5引数目）。
    expect(audio.loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs', 'synth.vst3'),
      undefined,
      'instrument',
      undefined,
      'plugin:synth',
    )
  })

  it('routes a .vstpreset second argument to state, not pluginId (#540 P2 heuristic)', async () => {
    const { audio, seq } = harness()
    await seq.instrument('synth.vst3', 'kick.vstpreset')
    expect(audio.loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs', 'synth.vst3'),
      undefined, // pluginId ではない
      'instrument',
      undefined,
      'plugin:synth',
      path.resolve('/songs', 'kick.vstpreset'),
    )
  })

  it('keeps a non-state second argument as pluginId and accepts the 3-arg form (#540 P2)', async () => {
    const first = harness()
    await first.seq.instrument('synth.vst3', 'my-plugin-id')
    expect(first.audio.loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs', 'synth.vst3'),
      'my-plugin-id',
      'instrument',
      undefined,
      'plugin:synth',
    )

    const second = harness()
    await second.seq.instrument('synth.vst3', 'my-plugin-id', 'kick.vstpreset')
    expect(second.audio.loadPlugin).toHaveBeenCalledWith(
      path.resolve('/songs', 'synth.vst3'),
      'my-plugin-id',
      'instrument',
      undefined,
      'plugin:synth',
      path.resolve('/songs', 'kick.vstpreset'),
    )
  })

  it('awaits eager declaration, marks note mode, and resolves degrees to plugin notes', async () => {
    const { audio, global, seq } = harness()
    const chained = await seq.instrument('synth.clap')
    chained.octave(4)
    expect(seq.isInstrument()).toBe(true)
    expect(seq.isMidi()).toBe(false)
    expect(seq.isNoteSequence()).toBe(true)
    // #645 PR-D0: note sequences resolve to hardware (the pre-#645 `undefined`), never
    // `skip` — the LinkAudio `.output()` requirement is scoped to sounding sequences.
    expect(seq.resolveDispatchChannel()).toEqual({ kind: 'hardware' })

    global.start()
    seq.play(1, 0, 3)
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)

    expect(audio.pluginNoteOn.mock.calls.map((call: unknown[]) => call[0])).toEqual([60, 64])
    expect(audio.pluginNoteOn).toHaveBeenCalledWith(60, 0, 96 / 127, 'plugin:synth')
  })

  it('enforces instrument/midi/audio/chop exclusion in both directions', async () => {
    const first = harness()
    await first.seq.instrument('synth.clap')
    expect(() => first.seq.midi('iac', 1)).toThrow('instrument')
    expect(() => first.seq.audio('kick.wav')).toThrow('instrument')
    expect(() => first.seq.chop(4)).toThrow('instrument')

    const midi = harness()
    midi.seq.midi('iac', 1)
    await expect(midi.seq.instrument('synth.clap')).rejects.toThrow('midi')

    const audio = harness()
    vi.spyOn(audio.global, 'resolveAudioSpec').mockReturnValue('/songs/kick.wav')
    audio.seq.audio('kick.wav')
    await expect(audio.seq.instrument('synth.clap')).rejects.toThrow('audio')

    const chopped = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chopped.seq.chop(4)
    await expect(chopped.seq.instrument('synth.clap')).rejects.toThrow('chop')
  })

  it('warns once for detune and never enqueues pitch bend', async () => {
    const { audio, global, seq } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seq.instrument('synth.clap')
    global.start()
    const detuned = {
      type: 'pitch',
      degree: 1,
      alteration: 0,
      octaveShift: 0,
      rangeSet: false,
      detune: 0.5,
    }
    seq.play(detuned as never, detuned as never)
    await seq.run()
    await vi.advanceTimersByTimeAsync(2100)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(audio.pluginNoteOn).toHaveBeenCalledTimes(2)
  })

  it('global.stop panics the plugin scheduler by enumerating active notes', async () => {
    const { audio, global, seq } = harness()
    await seq.instrument('synth.clap')
    global.quantize('off')
    global.start()
    seq.play(1)
    await seq.run()
    await vi.advanceTimersByTimeAsync(105)
    expect(audio.pluginNoteOn).toHaveBeenCalledTimes(1)
    expect(audio.pluginNoteOff).not.toHaveBeenCalled()
    global.stop()
    expect(audio.pluginNoteOff).toHaveBeenCalledWith(60, 0, undefined, 'plugin:synth')
  })

  it('gain() during LOOP clears pending notes via the plugin scheduler (clearOwner)', async () => {
    const { global, seq } = harness()
    await seq.instrument('synth.clap')
    global.quantize('off')
    global.start()
    seq.play(1, 3, 5, 0)
    await seq.loop()

    const clearOwnerSpy = vi.spyOn(global.getMidiManager().getPluginScheduler(), 'clearOwner')

    seq.gain(-6)

    expect(clearOwnerSpy).toHaveBeenCalledWith('synth')
  })

  it('play() replacement during LOOP defers to the next cycle (no immediate clearOwner)', async () => {
    const { global, seq } = harness()
    await seq.instrument('synth.clap')
    global.quantize('off')
    global.start()
    seq.play(1, 3, 5, 0)
    await seq.loop()

    const clearOwnerSpy = vi.spyOn(global.getMidiManager().getPluginScheduler(), 'clearOwner')

    seq.play(1, 1, 1, 1)

    expect(clearOwnerSpy).not.toHaveBeenCalled()
  })
})
