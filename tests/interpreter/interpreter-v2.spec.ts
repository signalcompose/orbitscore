/**
 * Tests for the object-oriented Interpreter V2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'
import { AudioTokenizer, AudioParser } from '../../packages/engine/src/parser/audio-parser'

describe.skip('Interpreter V2 - Object-Oriented Implementation', () => {
  let interpreter: InterpreterV2

  beforeEach(() => {
    interpreter = new InterpreterV2()
  })

  afterEach(async () => {
    // Clean up SuperCollider server
    if (interpreter) {
      const state = interpreter.getState()
      for (const globalName in state.globals) {
        const global = state.globals[globalName]
        if (global && typeof global.stop === 'function') {
          global.stop()
        }
      }
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })

  it('should create Global instance on init GLOBAL', async () => {
    const code = `
var global = init GLOBAL
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.globals).toHaveProperty('global')
    expect(state.globals.global).toMatchObject({
      tempo: 120,
      tick: 480,
      beat: { numerator: 4, denominator: 4 },
      key: 'C',
      isRunning: false,
      isLooping: false,
    })
  })

  it('should support method chaining on Global', async () => {
    const code = `
var global = init GLOBAL
global.tempo(140).beat(3 by 4).tick(960)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.globals.global).toMatchObject({
      tempo: 140,
      tick: 960,
      beat: { numerator: 3, denominator: 4 },
    })
  })

  it('should create Sequence instance via global.seq', async () => {
    const code = `
var global = init GLOBAL
var drum = init global.seq
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.sequences).toHaveProperty('drum')
    expect(state.sequences.drum).toMatchObject({
      name: 'drum',
      isMuted: false,
      isPlaying: false,
    })
  })

  it('should support method chaining on Sequence', async () => {
    const code = `
var global = init GLOBAL
var seq = init global.seq
seq.tempo(160).beat(5 by 4).length(2)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.sequences.seq).toMatchObject({
      name: 'seq',
      tempo: 160,
      beat: { numerator: 5, denominator: 4 },
      length: 2,
    })
  })

  it('should handle play pattern with proper timing', async () => {
    const code = `
var global = init GLOBAL
global.tempo(120)
var seq = init global.seq
seq.play(1, 0, 1, 0)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.sequences.seq.playPattern).toEqual([1, 0, 1, 0])
    expect(state.sequences.seq.timedEvents).toHaveLength(4)

    // Check timing (120 BPM, 4/4, so 1 bar = 2000ms)
    const events = state.sequences.seq.timedEvents
    expect(events[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 500 })
    expect(events[1]).toMatchObject({ sliceNumber: 0, startTime: 500, duration: 500 })
    expect(events[2]).toMatchObject({ sliceNumber: 1, startTime: 1000, duration: 500 })
    expect(events[3]).toMatchObject({ sliceNumber: 0, startTime: 1500, duration: 500 })
  })

  it('should handle transport commands', async () => {
    const code = `
var global = init GLOBAL
global.run()
var seq = init global.seq
seq.mute()
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    expect(state.globals.global.isRunning).toBe(true)
    expect(state.sequences.seq.isMuted).toBe(true)
  })

  it('should support complete DSL workflow', async () => {
    const code = `
var global = init GLOBAL
global.tempo(140).beat(4 by 4)

var drum = init global.seq
drum.beat(4 by 4).length(1)
drum.play(1, 0, 0, 1)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    await interpreter.execute(ir)
    const state = interpreter.getState()

    // Check global configuration
    expect(state.globals.global).toMatchObject({
      tempo: 140,
      beat: { numerator: 4, denominator: 4 },
    })

    // Check sequence configuration
    expect(state.sequences.drum).toMatchObject({
      name: 'drum',
      beat: { numerator: 4, denominator: 4 },
      length: 1,
    })

    // Check play pattern was processed
    expect(state.sequences.drum.playPattern).toEqual([1, 0, 0, 1])
    expect(state.sequences.drum.timedEvents).toHaveLength(4)
  })
})
