import { describe, it, expect } from 'vitest'

import { AudioTokenizer, parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

describe('AudioTokenizer', () => {
  describe('Basic tokens', () => {
    it('should tokenize keywords', () => {
      const tokenizer = new AudioTokenizer('var init by GLOBAL')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'VAR', value: 'var' })
      expect(tokens[1]).toMatchObject({ type: 'INIT', value: 'init' })
      expect(tokens[2]).toMatchObject({ type: 'BY', value: 'by' })
      expect(tokens[3]).toMatchObject({ type: 'GLOBAL', value: 'GLOBAL' })
    })

    it('should tokenize identifiers', () => {
      const tokenizer = new AudioTokenizer('global seq1 tempo')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'IDENTIFIER', value: 'global' })
      expect(tokens[1]).toMatchObject({ type: 'IDENTIFIER', value: 'seq1' })
      expect(tokens[2]).toMatchObject({ type: 'IDENTIFIER', value: 'tempo' })
    })

    it('should tokenize numbers', () => {
      const tokenizer = new AudioTokenizer('140 3.14 480')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'NUMBER', value: '140' })
      expect(tokens[1]).toMatchObject({ type: 'NUMBER', value: '3.14' })
      expect(tokens[2]).toMatchObject({ type: 'NUMBER', value: '480' })
    })

    it('should tokenize strings', () => {
      const tokenizer = new AudioTokenizer('"../audio/piano.wav" \'test\'')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'STRING', value: '../audio/piano.wav' })
      expect(tokens[1]).toMatchObject({ type: 'STRING', value: 'test' })
    })

    it('should tokenize operators and punctuation', () => {
      const tokenizer = new AudioTokenizer('.(),=')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'DOT', value: '.' })
      expect(tokens[1]).toMatchObject({ type: 'LPAREN', value: '(' })
      expect(tokens[2]).toMatchObject({ type: 'RPAREN', value: ')' })
      expect(tokens[3]).toMatchObject({ type: 'COMMA', value: ',' })
      expect(tokens[4]).toMatchObject({ type: 'EQUALS', value: '=' })
    })

    it('should handle comments', () => {
      const tokenizer = new AudioTokenizer('tempo // this is a comment\n140')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'IDENTIFIER', value: 'tempo' })
      expect(tokens[1]).toMatchObject({ type: 'NEWLINE', value: '\n' })
      expect(tokens[2]).toMatchObject({ type: 'NUMBER', value: '140' })
    })
  })

  describe('Complex expressions', () => {
    it('should tokenize method calls', () => {
      const tokenizer = new AudioTokenizer('global.tempo(140)')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'IDENTIFIER', value: 'global' })
      expect(tokens[1]).toMatchObject({ type: 'DOT', value: '.' })
      expect(tokens[2]).toMatchObject({ type: 'IDENTIFIER', value: 'tempo' })
      expect(tokens[3]).toMatchObject({ type: 'LPAREN', value: '(' })
      expect(tokens[4]).toMatchObject({ type: 'NUMBER', value: '140' })
      expect(tokens[5]).toMatchObject({ type: 'RPAREN', value: ')' })
    })

    it('should tokenize variable declarations', () => {
      const tokenizer = new AudioTokenizer('var global = init GLOBAL')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toMatchObject({ type: 'VAR', value: 'var' })
      expect(tokens[1]).toMatchObject({ type: 'IDENTIFIER', value: 'global' })
      expect(tokens[2]).toMatchObject({ type: 'EQUALS', value: '=' })
      expect(tokens[3]).toMatchObject({ type: 'INIT', value: 'init' })
      expect(tokens[4]).toMatchObject({ type: 'GLOBAL', value: 'GLOBAL' })
    })
  })
})

describe('AudioParser', () => {
  describe('Initialization statements', () => {
    it('should parse global initialization', () => {
      const ir = parseAudioDSL('var global = init GLOBAL')
      expect(ir.globalInit).toMatchObject({
        type: 'global_init',
        variableName: 'global',
      })
    })

    it('should parse sequence initialization', () => {
      const ir = parseAudioDSL('var seq1 = init GLOBAL.seq')
      expect(ir.sequenceInits).toHaveLength(1)
      expect(ir.sequenceInits[0]).toMatchObject({
        type: 'seq_init',
        variableName: 'seq1',
      })
    })

    it('should parse multiple sequence initializations', () => {
      const ir = parseAudioDSL(`
        var seq1 = init GLOBAL.seq
        var seq2 = init GLOBAL.seq
        var drums = init GLOBAL.seq
      `)
      expect(ir.sequenceInits).toHaveLength(3)
      expect(ir.sequenceInits[0].variableName).toBe('seq1')
      expect(ir.sequenceInits[1].variableName).toBe('seq2')
      expect(ir.sequenceInits[2].variableName).toBe('drums')
    })
  })

  describe('Global parameters', () => {
    it('should parse global.tempo()', () => {
      const ir = parseAudioDSL('global.tempo(140)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'tempo',
        args: [140],
      })
    })

    it('should parse global.tick()', () => {
      const ir = parseAudioDSL('global.tick(480)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'tick',
        args: [480],
      })
    })

    it('should parse global.beat() with simple meter', () => {
      const ir = parseAudioDSL('global.beat(4 by 4)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'beat',
        args: [{ numerator: 4, denominator: 4 }],
      })
    })

    it.skip('should parse global.beat() with composite meter', () => {
      const ir = parseAudioDSL('global.beat((3 by 4)(2 by 4))')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'beat',
        args: [
          {
            meters: [
              { numerator: 3, denominator: 4 },
              { numerator: 2, denominator: 4 },
            ],
          },
        ],
      })
    })

    it('should parse global.key()', () => {
      const ir = parseAudioDSL('global.key(C)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'key',
        args: ['C'],
      })
    })
  })

  describe('Transport commands', () => {
    it('should parse global.start()', () => {
      const ir = parseAudioDSL('global.start()')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'global',
        target: 'global',
        method: 'start',
        args: [],
      })
    })

    it('should parse global.start.force()', () => {
      const ir = parseAudioDSL('global.start.force()')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'transport',
        target: 'global',
        command: 'start',
        force: true,
      })
    })

    it('should parse seq1.mute()', () => {
      const ir = parseAudioDSL('seq1.mute()')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'mute',
        args: [],
      })
    })
  })

  describe('Sequence configuration', () => {
    it('should parse seq.tempo()', () => {
      const ir = parseAudioDSL('seq1.tempo(120)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'tempo',
        args: [120],
      })
    })

    it('should parse seq.gain() with 0 dB (default)', () => {
      const ir = parseAudioDSL('seq1.gain(0)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [0],
      })
    })

    it('should parse seq.gain() with negative dB', () => {
      const ir = parseAudioDSL('seq1.gain(-6)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [-6],
      })
    })

    it('should parse seq.gain() with positive dB (boost)', () => {
      const ir = parseAudioDSL('seq1.gain(6)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [6],
      })
    })

    it('should parse seq.gain() with decimal dB value', () => {
      const ir = parseAudioDSL('seq1.gain(-3.5)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [-3.5],
      })
    })

    it('should parse seq.gain() with -Infinity', () => {
      const ir = parseAudioDSL('seq1.gain(-Infinity)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [-Infinity],
      })
    })

    it('should parse seq.gain() with -inf (short form)', () => {
      const ir = parseAudioDSL('seq1.gain(-inf)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [-Infinity],
      })
    })

    it('should parse chained gain and pan with dB', () => {
      const ir = parseAudioDSL('seq1.gain(-6).pan(-50)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'gain',
        args: [-6],
        chain: [{ method: 'pan', args: [-50] }],
      })
    })

    it('should parse seq.pan() with negative value', () => {
      const ir = parseAudioDSL('seq1.pan(-100)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'pan',
        args: [-100],
      })
    })

    it('should parse seq.pan() with zero', () => {
      const ir = parseAudioDSL('seq1.pan(0)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'pan',
        args: [0],
      })
    })

    it('should parse seq.pan() with positive value', () => {
      const ir = parseAudioDSL('seq1.pan(100)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'pan',
        args: [100],
      })
    })

    it('should parse seq.pan() with negative decimal', () => {
      const ir = parseAudioDSL('seq1.pan(-50)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'pan',
        args: [-50],
      })
    })

    it('should parse seq.audio()', () => {
      const ir = parseAudioDSL('seq1.audio("../audio/piano.wav")')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'audio',
        args: ['../audio/piano.wav'],
      })
    })

    it('should parse seq.audio().chop() chain', () => {
      const ir = parseAudioDSL('seq1.audio("../audio/piano.wav").chop(16)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'audio',
        args: ['../audio/piano.wav'],
        chain: [{ method: 'chop', args: [16] }],
      })
    })

    it('should parse multiple chained methods', () => {
      const ir = parseAudioDSL('seq1.audio("../audio/piano.wav").chop(16).reverse()')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'audio',
        args: ['../audio/piano.wav'],
        chain: [
          { method: 'chop', args: [16] },
          { method: 'reverse', args: [] },
        ],
      })
    })
  })

  describe('Play structures', () => {
    it('should parse simple play with numbers', () => {
      const ir = parseAudioDSL('seq1.play(1, 2, 3, 4)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'play',
        args: [1, 2, 3, 4],
      })
    })

    it('should parse nested play structure', () => {
      const ir = parseAudioDSL('seq1.play((1)(2)(3))')
      expect(ir.statements).toHaveLength(1)
      const args = ir.statements[0].args
      expect(args).toHaveLength(3)
      expect(args[0]).toMatchObject({ type: 'nested', elements: [1] })
      expect(args[1]).toMatchObject({ type: 'nested', elements: [2] })
      expect(args[2]).toMatchObject({ type: 'nested', elements: [3] })
    })

    it('should parse play with .chop() modifier', () => {
      const ir = parseAudioDSL('seq1.play(1.chop(4))')
      expect(ir.statements).toHaveLength(1)
      const args = ir.statements[0].args
      expect(args[0]).toMatchObject({
        type: 'modified',
        value: 1,
        modifiers: [{ method: 'chop', value: 4 }],
      })
    })

    it('should parse play with .time() modifier', () => {
      const ir = parseAudioDSL('seq1.play(3.time(2))')
      expect(ir.statements).toHaveLength(1)
      const args = ir.statements[0].args
      expect(args[0]).toMatchObject({
        type: 'modified',
        value: 3,
        modifiers: [{ method: 'time', value: 2 }],
      })
    })

    it('should parse play with .fixpitch() modifier', () => {
      const ir = parseAudioDSL('seq1.play(5).fixpitch(0)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'play',
        args: [5],
        chain: [{ method: 'fixpitch', args: [0] }],
      })
    })

    it('should parse complex play with mixed elements', () => {
      const ir = parseAudioDSL('seq1.play(1.chop(2), (3)(4), 5.time(3))')
      expect(ir.statements).toHaveLength(1)
      const args = ir.statements[0].args
      expect(args).toHaveLength(4)
      // First argument: 1.chop(2)
      expect(args[0]).toMatchObject({
        type: 'modified',
        value: 1,
        modifiers: [{ method: 'chop', value: 2 }],
      })
      // Second argument: (3)
      expect(args[1]).toMatchObject({ type: 'nested', elements: [3] })
      // Third argument: (4)
      expect(args[2]).toMatchObject({ type: 'nested', elements: [4] })
      // Fourth argument: 5.time(3)
      expect(args[3]).toMatchObject({
        type: 'modified',
        value: 5,
        modifiers: [{ method: 'time', value: 3 }],
      })
    })
  })

  describe('Multiple statements', () => {
    it('should parse multiple statements', () => {
      const source = `
        global.tempo(140)
        global.tick(480)
        seq1.tempo(120)
      `
      const ir = parseAudioDSL(source)
      expect(ir.statements).toHaveLength(3)
    })
  })
})

describe('Integration tests', () => {
  it('should parse a complete example', () => {
    const source = `
      // Initialize global transport
      var global = init GLOBAL
      
      // Set global parameters
      global.tempo(140)
      global.tick(480)
      global.beat(4 by 4)
      global.key(C)
      
      // Initialize a sequence
      var seq1 = init GLOBAL.seq
      seq1.tempo(120)
      seq1.audio("../audio/piano.wav")
      
      // Start playback
      global.start()
    `

    const ir = parseAudioDSL(source)
    expect(ir).toBeDefined()
    // More specific assertions can be added as implementation progresses
  })
})

describe('Random value syntax', () => {
  it('should parse gain(r) - full random', () => {
    const ir = parseAudioDSL('seq1.gain(r)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'gain',
      args: [{ type: 'full-random' }],
    })
  })

  it('should parse pan(r) - full random', () => {
    const ir = parseAudioDSL('seq1.pan(r)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'pan',
      args: [{ type: 'full-random' }],
    })
  })

  it('should parse gain(r0%4) - random walk around 0dB ±4dB', () => {
    const ir = parseAudioDSL('seq1.gain(r0%4)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'gain',
      args: [{ type: 'random-walk', center: 0, range: 4 }],
    })
  })

  it('should parse gain(r-6%3) - random walk around -6dB ±3dB', () => {
    const ir = parseAudioDSL('seq1.gain(r-6%3)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'gain',
      args: [{ type: 'random-walk', center: -6, range: 3 }],
    })
  })

  it('should parse pan(r50%30) - random walk around 50 ±30', () => {
    const ir = parseAudioDSL('seq1.pan(r50%30)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'pan',
      args: [{ type: 'random-walk', center: 50, range: 30 }],
    })
  })

  it('should parse pan(r-50%20) - random walk around -50 ±20', () => {
    const ir = parseAudioDSL('seq1.pan(r-50%20)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'pan',
      args: [{ type: 'random-walk', center: -50, range: 20 }],
    })
  })

  it('should parse chained random gain and pan', () => {
    const ir = parseAudioDSL('seq1.gain(r-3%2).pan(r)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'gain',
      args: [{ type: 'random-walk', center: -3, range: 2 }],
      chain: [{ method: 'pan', args: [{ type: 'full-random' }] }],
    })
  })

  it('should parse gain with decimal center and range', () => {
    const ir = parseAudioDSL('seq1.gain(r-3.5%1.5)')
    expect(ir.statements).toHaveLength(1)
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'seq1',
      method: 'gain',
      args: [{ type: 'random-walk', center: -3.5, range: 1.5 }],
    })
  })
})
