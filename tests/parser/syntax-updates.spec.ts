/**
 * Tests for updated parser syntax support
 */

import { describe, it, expect } from 'vitest'

import { AudioTokenizer, AudioParser } from '../../packages/engine/src/parser/audio-parser'

describe('Parser Syntax Updates', () => {
  it('should parse "init global.seq" syntax', () => {
    const code = `
var global = init GLOBAL
var seq = init global.seq
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    expect(ir.globalInit).toEqual({
      type: 'global_init',
      variableName: 'global',
    })
    expect(ir.sequenceInits).toHaveLength(1)
    expect(ir.sequenceInits[0]).toEqual({
      type: 'seq_init',
      variableName: 'seq',
      globalVariable: 'global',
    })
  })

  it('should still support legacy "init GLOBAL.seq" syntax', () => {
    const code = `
var seq = init GLOBAL.seq
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()

    expect(ir.sequenceInits).toHaveLength(1)
    expect(ir.sequenceInits[0]).toEqual({
      type: 'seq_init',
      variableName: 'seq',
    })
  })

  it('should parse "beat(n by m)" syntax correctly', () => {
    const code = `
global.beat(4 by 4)
seq.beat(3 by 4)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const result = parser.parse().statements

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      type: 'global',
      target: 'global',
      method: 'beat',
      args: [{ numerator: 4, denominator: 4 }],
    })
    expect(result[1]).toEqual({
      type: 'sequence',
      target: 'seq',
      method: 'beat',
      args: [{ numerator: 3, denominator: 4 }],
    })
  })

  it('should parse method chains with beat and length', () => {
    const code = `
seq.beat(4 by 4).length(2)
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const result = parser.parse().statements

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'sequence',
      target: 'seq',
      method: 'beat',
      args: [{ numerator: 4, denominator: 4 }],
      chain: [
        {
          method: 'length',
          args: [2],
        },
      ],
    })
  })

  it('should parse complete initialization sequence', () => {
    const code = `
var global = init GLOBAL
global.tempo(120)
global.beat(4 by 4)

var seq = init global.seq
seq.beat(4 by 4).length(1)
seq.audio("test.wav").chop(8)
seq.play(1, 0, 1, 0)
seq.run()
`
    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const ir = parser.parse()
    const result = ir.statements

    // Check that global init was parsed
    expect(ir.globalInit).toEqual({
      type: 'global_init',
      variableName: 'global',
    })

    // Check that sequence init was parsed
    expect(ir.sequenceInits).toHaveLength(1)
    expect(ir.sequenceInits[0]).toEqual({
      type: 'seq_init',
      variableName: 'seq',
      globalVariable: 'global',
    })

    // Check statements
    expect(result).toHaveLength(6)
    expect(result[0].type).toBe('global')
    expect(result[0].method).toBe('tempo')
    expect(result[1].type).toBe('global')
    expect(result[1].method).toBe('beat')
    expect(result[2].type).toBe('sequence')
    expect(result[2].method).toBe('beat')
    expect(result[2].chain).toHaveLength(1)
    expect(result[2].chain[0].method).toBe('length')
  })

  it('should allow multiline arguments inside parentheses', () => {
    const code = `
seq.play(
  1,
  (2, 3),
  4,
)
`

    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const result = parser.parse().statements

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'sequence',
      target: 'seq',
      method: 'play',
      args: [
        1,
        {
          type: 'nested',
          elements: [2, 3],
        },
        4,
      ],
    })
  })

  it('should allow multiline method chains with nested play', () => {
    const code = `
seq.audio("test.wav")
  .chop(4)
  .play(
    (1, 0),
    2,
    (
      3,
      (4, 5),
    ),
  )
`

    const tokenizer = new AudioTokenizer(code)
    const tokens = tokenizer.tokenize()
    const parser = new AudioParser(tokens)
    const result = parser.parse().statements

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'sequence',
      target: 'seq',
      method: 'audio',
      args: ['test.wav'],
      chain: [
        {
          method: 'chop',
          args: [4],
        },
        {
          method: 'play',
          args: [
            {
              type: 'nested',
              elements: [1, 0],
            },
            2,
            {
              type: 'nested',
              elements: [
                3,
                {
                  type: 'nested',
                  elements: [4, 5],
                },
              ],
            },
          ],
        },
      ],
    })
  })
})
