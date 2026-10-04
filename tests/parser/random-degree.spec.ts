import { describe, expect, it } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

function args(src: string): any[] {
  return (parseAudioDSL(src).statements[0] as any).args
}

const bareRandomDegree = {
  type: 'random_degree',
  octaveShift: 0,
  rangeSet: false,
  detune: 0,
}

describe('#969 — mode bindings reject rests', () => {
  it('1: rejects `mode(0, 5)` with the specified diagnostic', () => {
    expect(() => parseAudioDSL('var z = mode(0, 5)')).toThrow('mode(…) に 0（休符）は書けません')
  })
})

describe('#967 stage 1 — random degree parsing', () => {
  it('2: uses the same random_degree node in play(), (), {}, and [] pitch positions', () => {
    const parsed = args('p.play(r, (r), {r}, [r])')
    expect(parsed[0]).toEqual(bareRandomDegree)
    expect(parsed[1].elements[0]).toEqual(bareRandomDegree)
    expect(parsed[2].elements[0]).toEqual(bareRandomDegree)
    expect(parsed[3].voices[0]).toEqual(bareRandomDegree)
  })

  it('2: treats `rr` and whitespace-separated `r r` as probability 0.5', () => {
    const expected = { ...bareRandomDegree, random: 0.5 }
    expect(args('p.play(rr)')[0]).toEqual(expected)
    expect(args('p.play(r r)')[0]).toEqual(expected)
  })

  it('2: parses random-degree pitch modifiers through the degree modifier shape', () => {
    expect(args('p.play(r^1^r~-0.5@v110@g30)')[0]).toEqual({
      ...bareRandomDegree,
      octaveShift: 1,
      rangeSet: true,
      detune: -0.5,
      randomOctave: true,
      velocity: 110,
      articulation: 0.3,
    })
  })

  it('2: accepts `.r` and `.r(p)` after a random degree', () => {
    const parsed = args('p.play(r.r, r.r(0.3))')
    expect(parsed[0]).toEqual({ ...bareRandomDegree, random: 0.5 })
    expect(parsed[1]).toEqual({ ...bareRandomDegree, random: 0.3 })
  })

  it('3: parses r<digits> without `%` as a name reference and with `%` as a random value', () => {
    const parsed = args('p.play(r1, r1^1, r1%3)')
    expect(parsed[0]).toEqual({ type: 'chord_ref', name: 'r1', octaveShift: 0 })
    expect(parsed[1]).toMatchObject({
      type: 'chord_ref',
      name: 'r1',
      octaveShift: 1,
      rangeSet: true,
    })
    expect(parsed[2]).toEqual({ type: 'random-walk', center: 1, range: 3 })
  })

  it('4: rejects `var r` and `var rr` with E1', () => {
    const message =
      'r / rr は音高の乱数として予約されています。別の名前を使ってください（例: var r1 = random.dorian）'
    expect(() => parseAudioDSL('var r = mode(1, 5)')).toThrow(message)
    expect(() => parseAudioDSL('var rr = [1, 3, 5]')).toThrow(message)
  })

  it('5: parses `random.<name>` as a random_binding statement', () => {
    expect(parseAudioDSL('var r1 = random.dorian').statements[0]).toEqual({
      type: 'random_binding',
      variableName: 'r1',
      source: 'dorian',
    })
  })

  it('5: gives random_binding precedence over mixer lookahead for `random.sum`', () => {
    expect(parseAudioDSL('var r1 = random.sum').statements[0]).toEqual({
      type: 'random_binding',
      variableName: 'r1',
      source: 'sum',
    })
  })

  it('5: rejects missing or non-identifier random sources with E2', () => {
    const message = 'random の後に mode 変数の名前を書いてください（例: var r1 = random.dorian）'
    expect(() => parseAudioDSL('var r1 = random')).toThrow(message)
    expect(() => parseAudioDSL('var r1 = random.')).toThrow(message)
    expect(() => parseAudioDSL('var r1 = random.1')).toThrow(message)
  })

  it('5: rejects the out-of-scope `random.mode(...)` call form', () => {
    expect(() => parseAudioDSL('var r1 = random.mode(1, 2, 3)')).toThrow(/call form/)
  })

  it('6: records ^N, ^r, ~, @v, and @g on a name reference', () => {
    expect(args('p.play(source^1^r~0.25@v+20@g120)')[0]).toMatchObject({
      type: 'chord_ref',
      name: 'source',
      octaveShift: 1,
      rangeSet: true,
      randomOctave: true,
      detune: 0.25,
      velocityDelta: 20,
      articulation: 1.2,
    })
  })

  it('6: distinguishes `.r(p)` on a name reference from its trailing-r modifier', () => {
    expect(args('p.play(source.r(0.25))')[0]).toEqual({
      type: 'stack',
      voices: [{ type: 'chord_ref', name: 'source', octaveShift: 0 }],
      random: 0.25,
      referenceThin: true,
    })
  })

  it('7: rejects `_r` voice ties with E9', () => {
    expect(() => parseAudioDSL('p.play([1, _r, 5])')).toThrow(
      '_ の声部タイは度数にだけ付けられます',
    )
  })

  it('rejects repetition postfixes inside stacks with the origin/main parse error', () => {
    for (const source of ['p.play([c*2, 1])', 'p.play([r*2, 1])']) {
      expect(() => parseAudioDSL(source)).toThrow(/Expected RBRACKET but got ASTERISK/)
    }
  })
})

describe('#967 random-value regression guard', () => {
  it('keeps gain/pan random values unchanged outside play() element positions', () => {
    expect(args('seq.gain(r)')[0]).toEqual({ type: 'full-random' })
    expect(args('seq.pan(r)')[0]).toEqual({ type: 'full-random' })
    expect(args('seq.gain(r1%3)')[0]).toEqual({ type: 'random-walk', center: 1, range: 3 })
    expect(args('seq.pan(r0%10)')[0]).toEqual({ type: 'random-walk', center: 0, range: 10 })
    expect(args('p.play(riff)')[0]).toBe('riff')
  })
})
