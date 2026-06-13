import { describe, it, expect } from 'vitest'

import { AudioTokenizer, parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Phase 1 increment 2a (#228) — pitch token + parser support
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1, §2.4
 *
 * Tokenizer: accidentals (`b`/`bb`/`#`/`##`), `^` (octave shift), `~` (detune).
 * Parser: produce a PlayPitch AST node carrying degree + alteration +
 * octaveShift + detune. A bare integer stays a plain number (audio-compatible).
 */

function tokenTypes(src: string): string[] {
  return new AudioTokenizer(src)
    .tokenize()
    .map((t) => t.type)
    .filter((t) => t !== 'EOF')
}

function playArgs(src: string): unknown[] {
  return parseAudioDSL(src).statements[0].args
}

describe('tokenizer — pitch tokens', () => {
  it('single sharp `#5` → ACCIDENTAL("#") NUMBER', () => {
    const toks = new AudioTokenizer('#5').tokenize()
    expect(toks[0]).toMatchObject({ type: 'ACCIDENTAL', value: '#' })
    expect(toks[1]).toMatchObject({ type: 'NUMBER', value: '5' })
  })

  it('double sharp `##5` → ACCIDENTAL("##")', () => {
    const toks = new AudioTokenizer('##5').tokenize()
    expect(toks[0]).toMatchObject({ type: 'ACCIDENTAL', value: '##' })
  })

  it('single flat `b3` → ACCIDENTAL("b") NUMBER', () => {
    const toks = new AudioTokenizer('b3').tokenize()
    expect(toks[0]).toMatchObject({ type: 'ACCIDENTAL', value: 'b' })
    expect(toks[1]).toMatchObject({ type: 'NUMBER', value: '3' })
  })

  it('double flat `bb7` → ACCIDENTAL("bb")', () => {
    const toks = new AudioTokenizer('bb7').tokenize()
    expect(toks[0]).toMatchObject({ type: 'ACCIDENTAL', value: 'bb' })
  })

  it('`^`, `~`, `+` become CARET, TILDE, PLUS', () => {
    expect(tokenTypes('^')).toEqual(['CARET'])
    expect(tokenTypes('~')).toEqual(['TILDE'])
    expect(tokenTypes('+')).toEqual(['PLUS'])
  })

  it('`b` NOT followed by a digit stays an identifier (variable named b)', () => {
    const toks = new AudioTokenizer('b )').tokenize()
    expect(toks[0]).toMatchObject({ type: 'IDENTIFIER', value: 'b' })
  })

  it('`3^+1` → NUMBER CARET PLUS NUMBER', () => {
    expect(tokenTypes('3^+1')).toEqual(['NUMBER', 'CARET', 'PLUS', 'NUMBER'])
  })

  it('`b7~-0.25` → ACCIDENTAL NUMBER TILDE MINUS NUMBER', () => {
    expect(tokenTypes('b7~-0.25')).toEqual(['ACCIDENTAL', 'NUMBER', 'TILDE', 'MINUS', 'NUMBER'])
  })
})

describe('parser — PlayPitch nodes', () => {
  it('bare integers stay plain numbers (audio-compatible)', () => {
    expect(playArgs('seq1.play(1, 0, 3)')).toEqual([1, 0, 3])
  })

  it('flat `b3` → pitch degree 3 alteration -1', () => {
    expect(playArgs('seq1.play(b3)')[0]).toMatchObject({
      type: 'pitch',
      degree: 3,
      alteration: -1,
      octaveShift: 0,
      detune: 0,
    })
  })

  it('sharp `#4` → alteration +1', () => {
    expect(playArgs('seq1.play(#4)')[0]).toMatchObject({ type: 'pitch', degree: 4, alteration: 1 })
  })

  it('double flat `bb7` → alteration -2', () => {
    expect(playArgs('seq1.play(bb7)')[0]).toMatchObject({
      type: 'pitch',
      degree: 7,
      alteration: -2,
    })
  })

  it('double sharp `##1` → alteration +2', () => {
    expect(playArgs('seq1.play(##1)')[0]).toMatchObject({ type: 'pitch', degree: 1, alteration: 2 })
  })

  it('octave shift `3^+1` → octaveShift +1', () => {
    expect(playArgs('seq1.play(3^+1)')[0]).toMatchObject({
      type: 'pitch',
      degree: 3,
      alteration: 0,
      octaveShift: 1,
    })
  })

  it('octave shift down `5^-1` → octaveShift -1', () => {
    expect(playArgs('seq1.play(5^-1)')[0]).toMatchObject({
      type: 'pitch',
      degree: 5,
      octaveShift: -1,
    })
  })

  it('detune `b7~-0.25` → alteration -1 detune -0.25', () => {
    expect(playArgs('seq1.play(b7~-0.25)')[0]).toMatchObject({
      type: 'pitch',
      degree: 7,
      alteration: -1,
      detune: -0.25,
    })
  })

  it('combined accidental + octave shift `b3^+1`', () => {
    expect(playArgs('seq1.play(b3^+1)')[0]).toMatchObject({
      type: 'pitch',
      degree: 3,
      alteration: -1,
      octaveShift: 1,
    })
  })

  it('mixes bare numbers and pitches: play(1, b3, 5, #4)', () => {
    const args = playArgs('seq1.play(1, b3, 5, #4)')
    expect(args[0]).toBe(1)
    expect(args[1]).toMatchObject({ type: 'pitch', degree: 3, alteration: -1 })
    expect(args[2]).toBe(5)
    expect(args[3]).toMatchObject({ type: 'pitch', degree: 4, alteration: 1 })
  })

  it('pitch inside nested groups: play((1, b3, 5))', () => {
    const args = playArgs('seq1.play((1, b3, 5))')
    expect(args[0]).toMatchObject({ type: 'nested' })
    const nested = (args[0] as { elements: unknown[] }).elements
    expect(nested[0]).toBe(1)
    expect(nested[1]).toMatchObject({ type: 'pitch', degree: 3, alteration: -1 })
    expect(nested[2]).toBe(5)
  })

  it('regression: audio .chop() modifier still parses', () => {
    expect(playArgs('seq1.play(1.chop(4))')[0]).toMatchObject({
      type: 'modified',
      value: 1,
      modifiers: [{ method: 'chop', value: 4 }],
    })
  })

  it('regression: meter syntax `beat(4 by 4)` unaffected', () => {
    const ir = parseAudioDSL('global.beat(4 by 4)')
    expect(ir.statements[0].args[0]).toMatchObject({ numerator: 4, denominator: 4 })
  })
})
