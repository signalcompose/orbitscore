import { describe, it, expect } from 'vitest'

import {
  colorForSeq,
  findPlayArgRangeForPath,
  findPlayArgRanges,
  normalizeHexColor,
  paletteIndexForSeq,
  parseStepLine,
  PLAYHEAD_PALETTE,
} from '../../packages/vscode-extension/src/playhead'
import * as playheadSource from '../../packages/vscode-extension/src/playhead'
import { readExtensionManifest } from '../helpers/vscode-extension-manifest'

// #390 live playhead — pure helpers (no vscode dependency, so no mock needed).

describe('parseStepLine', () => {
  it('parses a flat top-level step marker', () => {
    expect(parseStepLine('[STEP] drum 2 1751234567890')).toEqual({
      seqName: 'drum',
      argPath: '2',
      atEpochMs: 1751234567890,
    })
  })

  it('parses a dot-joined nested path (reserved for the nested phase)', () => {
    expect(parseStepLine('[STEP] drum 1.0 1751234567890')).toEqual({
      seqName: 'drum',
      argPath: '1.0',
      atEpochMs: 1751234567890,
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseStepLine('  [STEP] kick 0 42  ')).toEqual({
      seqName: 'kick',
      argPath: '0',
      atEpochMs: 42,
    })
  })

  it('returns null for garbage and near-misses', () => {
    expect(parseStepLine('')).toBeNull()
    expect(parseStepLine('🔊 Playing: kick.wav')).toBeNull()
    expect(parseStepLine('[STEP]')).toBeNull()
    expect(parseStepLine('[STEP] drum')).toBeNull()
    expect(parseStepLine('[STEP] drum 2')).toBeNull()
    expect(parseStepLine('[STEP] drum two 123')).toBeNull()
    expect(parseStepLine('[STEP] drum 2 12.5')).toBeNull() // epoch must be an integer
    expect(parseStepLine('[STEP] drum 2 123 trailing')).toBeNull()
    expect(parseStepLine('prefix [STEP] drum 2 123')).toBeNull()
  })
})

describe('findPlayArgRanges', () => {
  const sliceAll = (text: string, seqName: string): string[] =>
    findPlayArgRanges(text, seqName).map((r) => text.slice(r.start, r.end))

  it('finds flat top-level args', () => {
    const text = 'var drum = init global.seq\ndrum.play(1, 1, 1, 1)\n'
    const ranges = findPlayArgRanges(text, 'drum')
    expect(ranges).toHaveLength(4)
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['1', '1', '1', '1'])
    // Offsets are distinct and increasing (each range points at its own arg).
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBeGreaterThan(ranges[i - 1].end)
    }
  })

  it('groups args with inner parens as ONE top-level arg', () => {
    expect(sliceAll('drum.play((1, 2), 3)', 'drum')).toEqual(['(1, 2)', '3'])
  })

  it('groups stack brackets and legato braces as ONE top-level arg', () => {
    expect(sliceAll('drum.play(1, [1, 3, 5], {2, 4})', 'drum')).toEqual([
      '1',
      '[1, 3, 5]',
      '{2, 4}',
    ])
  })

  it('trims whitespace from each arg range', () => {
    expect(sliceAll('drum.play( 1 ,  2 )', 'drum')).toEqual(['1', '2'])
  })

  it('returns [] when the seq has no play call', () => {
    expect(findPlayArgRanges('kick.play(1, 2)', 'drum')).toEqual([])
    expect(findPlayArgRanges('', 'drum')).toEqual([])
  })

  it('returns [] for an empty or never-closed arg list', () => {
    expect(findPlayArgRanges('drum.play()', 'drum')).toEqual([])
    expect(findPlayArgRanges('drum.play(1, 2', 'drum')).toEqual([])
  })

  it('picks the named seq call, not another seq', () => {
    const text = 'kick.play(9, 9)\ndrum.play(1, 2)\n'
    expect(sliceAll(text, 'drum')).toEqual(['1', '2'])
    // And the ranges really live on the drum line, after the kick call.
    const kickEnd = text.indexOf('\n')
    for (const r of findPlayArgRanges(text, 'drum')) {
      expect(r.start).toBeGreaterThan(kickEnd)
    }
  })

  it('does not match a longer identifier ending in the seq name', () => {
    expect(findPlayArgRanges('mydrum.play(1, 2)', 'drum')).toEqual([])
  })

  it('without an anchor, falls back to the FIRST non-comment play call', () => {
    const text = '// drum.play(7)\ndrum.play(1, 2)\ndrum.play(3, 4, 5)\n'
    expect(sliceAll(text, 'drum')).toEqual(['1', '2'])
  })

  it('stops at the matching close paren of a chained call', () => {
    expect(sliceAll('drum.play(1, 2).beat(4 by 4)', 'drum')).toEqual(['1', '2'])
  })
})

describe('play call source tracking', () => {
  it('P1: finds every non-comment play call in document order with exact offsets', () => {
    const text = '// ignored.play(0)\nhh.play(1)\nbd.play(2)\nhh.play(3)\n'
    const calls = playheadSource.findPlayCalls(text)

    expect(calls.map((call) => call.seqName)).toEqual(['hh', 'bd', 'hh'])
    for (const call of calls) {
      expect(call.callStart).toBe(text.indexOf(call.seqName, call.callStart))
      expect(call.openParen).toBe(text.indexOf('(', call.callStart))
    }
  })

  it('P2: keeps the existing identifier boundaries while allowing whitespace', () => {
    const calls = playheadSource.findPlayCalls(
      'mydrum.play(1)\nfoo.drum.play(2)\ndrum . play (3)\n',
    )

    expect(calls.filter((call) => call.seqName === 'drum')).toHaveLength(1)
    expect(calls.at(-1)?.seqName).toBe('drum')
  })

  it('P3: excludes _play calls', () => {
    expect(playheadSource.findPlayCalls('hh._play(1)')).toEqual([])
  })

  it('P4: ignores calls in whole-line and trailing line comments', () => {
    const text = '// hh.play(9)\nhh.play(1) // bd.play(8)\n// bd.play(7)\n'
    expect(playheadSource.findPlayCalls(text).map((call) => call.seqName)).toEqual(['hh'])
  })

  it('P5: ignores double/single-quoted calls and honors escaped quotes', () => {
    const text = [
      'var a = "hh.play(9) and \\" bd.play(8)"',
      "var b = 'hh.play(7) and \\' bd.play(6)'",
      'hh.play(1)',
    ].join('\n')
    expect(playheadSource.findPlayCalls(text).map((call) => call.seqName)).toEqual(['hh'])
  })

  it('P6: ends an unterminated string at the newline', () => {
    const text = 'var a = "hh.play(9)\nhh.play(1)\n'
    expect(playheadSource.findPlayCalls(text)).toEqual([
      {
        seqName: 'hh',
        callStart: text.lastIndexOf('hh.play'),
        openParen: text.lastIndexOf('('),
      },
    ])
  })

  it('P7: does not treat block-comment syntax as a comment', () => {
    expect(playheadSource.findPlayCalls('/* hh.play(9) */')).toHaveLength(1)
  })

  it('P8: skips comments while splitting multiline play arguments', () => {
    const text = 'hh.play(\n  1, // kick, (x\n  0\n)'
    expect(
      findPlayArgRanges(text, 'hh').map((range) => text.slice(range.start, range.end)),
    ).toEqual(['1', '0'])
  })

  it('P9: shifts an anchor for edits before its head, including insertion at callStart', () => {
    const text = 'xx hh.play(1)'
    const anchor = playheadSource.findPlayCalls(text)[0]

    expect(
      playheadSource.shiftPlayCallAnchor(anchor, [
        { rangeOffset: 0, rangeLength: 0, text: 'abc' },
        { rangeOffset: anchor.callStart + 3, rangeLength: 0, text: '!' },
      ]),
    ).toEqual({ ...anchor, callStart: anchor.callStart + 4, openParen: anchor.openParen + 4 })
  })

  it('P10: leaves an anchor unchanged for edits after play(', () => {
    const text = 'hh.play(1, 2)'
    const anchor = playheadSource.findPlayCalls(text)[0]
    expect(
      playheadSource.shiftPlayCallAnchor(anchor, [
        { rangeOffset: anchor.openParen + 1, rangeLength: 1, text: '999' },
      ]),
    ).toEqual(anchor)
  })

  it('P11: invalidates overlapping heads and applies multiple changes sequentially', () => {
    const text = 'xx\nhh.play(1)'
    const anchor = playheadSource.findPlayCalls(text)[0]
    expect(
      playheadSource.shiftPlayCallAnchor(anchor, [
        { rangeOffset: anchor.callStart + 1, rangeLength: 2, text: 'z' },
      ]),
    ).toBeNull()

    const cases = [
      [
        { rangeOffset: 0, rangeLength: 0, text: 'A' },
        { rangeOffset: 1, rangeLength: 0, text: 'B' },
      ],
      [
        { rangeOffset: 0, rangeLength: 1, text: '' },
        { rangeOffset: 0, rangeLength: 0, text: 'xyz' },
      ],
    ]
    for (const changes of cases) {
      let edited = text
      for (const change of changes) {
        edited =
          edited.slice(0, change.rangeOffset) +
          change.text +
          edited.slice(change.rangeOffset + change.rangeLength)
      }
      const shifted = playheadSource.shiftPlayCallAnchor(anchor, changes)
      expect(shifted).not.toBeNull()
      expect(edited.slice(shifted!.callStart, shifted!.openParen + 1)).toBe('hh.play(')
    }
  })

  it('P12: distinguishes a resolved range, an out-of-range path, and a missing call', () => {
    const text = 'hh.play(1)\nhh.play(2, 3)'
    const anchor = playheadSource.findPlayCalls(text)[1]
    expect(playheadSource.resolvePlayheadStep(text, 'hh', '1', anchor)).toEqual({
      kind: 'range',
      range: { start: text.lastIndexOf('3'), end: text.lastIndexOf('3') + 1 },
    })
    expect(playheadSource.resolvePlayheadStep(text, 'hh', '9', anchor)).toEqual({
      kind: 'out-of-range',
    })
    expect(playheadSource.resolvePlayheadStep(text, 'bd', '0')).toEqual({ kind: 'no-call' })
  })
})

describe('findPlayArgRangeForPath', () => {
  const TEXT = 'drum.play(1, (2, 3), [4, 5], {6, 7}, (8, (9, 10)))'
  const resolve = (argPath: string, text = TEXT, seq = 'drum'): string | null => {
    const range = findPlayArgRangeForPath(text, seq, argPath)
    return range ? text.slice(range.start, range.end) : null
  }

  it('resolves single-segment paths to top-level args', () => {
    expect(resolve('0')).toBe('1')
    expect(resolve('2')).toBe('[4, 5]')
  })

  it('descends into nested and legato groups, recursively', () => {
    expect(resolve('1.0')).toBe('2')
    expect(resolve('1.1')).toBe('3')
    expect(resolve('3.1')).toBe('7')
    expect(resolve('4.0')).toBe('8')
    expect(resolve('4.1.0')).toBe('9')
  })

  it('treats a stack as one visual unit (no descent)', () => {
    expect(resolve('2.0')).toBe('[4, 5]')
  })

  it('falls back to the deepest resolvable ancestor', () => {
    expect(resolve('1.9')).toBe('(2, 3)') // deep segment out of range
    expect(resolve('0.0')).toBe('1') // leaf cannot descend
  })

  it('does not descend an element whose group is not the whole text (group runs / chains)', () => {
    expect(resolve('0.0', 'm.play((1)(2).oct(1), 3)', 'm')).toBe('(1)(2).oct(1)')
  })

  it('returns null for an out-of-range top index or malformed path', () => {
    expect(resolve('9')).toBeNull()
    expect(resolve('')).toBeNull()
    expect(resolve('x.0')).toBeNull()
    expect(resolve('-1')).toBeNull()
  })
})

describe('paletteIndexForSeq', () => {
  it('assigns first-come ordinals and keeps them stable', () => {
    const assigned = new Map<string, number>()
    expect(paletteIndexForSeq('drum', assigned)).toBe(0)
    expect(paletteIndexForSeq('bass', assigned)).toBe(1)
    expect(paletteIndexForSeq('drum', assigned)).toBe(0) // unchanged on re-query
    expect(paletteIndexForSeq('hat', assigned)).toBe(2)
  })

  it('does NOT reduce the ordinal modulo any palette (callers do that)', () => {
    const assigned = new Map<string, number>()
    for (let i = 0; i < PLAYHEAD_PALETTE.length + 1; i++) {
      paletteIndexForSeq(`seq${i}`, assigned)
    }
    expect(paletteIndexForSeq(`seq${PLAYHEAD_PALETTE.length}`, assigned)).toBe(
      PLAYHEAD_PALETTE.length,
    )
  })
})

describe('normalizeHexColor', () => {
  it('normalizes #RRGGBB and #RGB to uppercase #RRGGBB', () => {
    expect(normalizeHexColor('#ff2d75')).toBe('#FF2D75')
    expect(normalizeHexColor(' #FF2D75 ')).toBe('#FF2D75')
    expect(normalizeHexColor('#f0a')).toBe('#FF00AA')
  })

  it('rejects everything else', () => {
    expect(normalizeHexColor('')).toBeNull()
    expect(normalizeHexColor('red')).toBeNull()
    expect(normalizeHexColor('FF2D75')).toBeNull() // missing #
    expect(normalizeHexColor('#ff2d7')).toBeNull() // 5 digits
    expect(normalizeHexColor('#ff2d75aa')).toBeNull() // alpha not accepted here
  })

  it('built-in palette entries are already normalized (alpha suffix appendable)', () => {
    for (const color of PLAYHEAD_PALETTE) {
      expect(normalizeHexColor(color)).toBe(color)
    }
  })
})

describe('PLAYHEAD_PALETTE', () => {
  it('has 32 distinct entries (owner request 2026-07-07)', () => {
    expect(PLAYHEAD_PALETTE).toHaveLength(32)
    expect(new Set(PLAYHEAD_PALETTE).size).toBe(PLAYHEAD_PALETTE.length)
  })

  it('matches the orbitscore.playheadPalette default in package.json', () => {
    const properties = readExtensionManifest().contributes?.configuration?.properties
    const configured = (properties?.['orbitscore.playheadPalette'] as { default?: unknown })
      ?.default
    expect(configured).toEqual([...PLAYHEAD_PALETTE])
  })
})

describe('colorForSeq', () => {
  it('assigns from the built-in palette first-come and wraps around', () => {
    const assigned = new Map<string, number>()
    expect(colorForSeq('drum', {}, assigned)).toBe(PLAYHEAD_PALETTE[0])
    expect(colorForSeq('bass', {}, assigned)).toBe(PLAYHEAD_PALETTE[1])
    expect(colorForSeq('drum', {}, assigned)).toBe(PLAYHEAD_PALETTE[0]) // stable
    for (let i = 2; i < PLAYHEAD_PALETTE.length; i++) {
      colorForSeq(`seq${i}`, {}, assigned)
    }
    expect(colorForSeq('overflow', {}, assigned)).toBe(PLAYHEAD_PALETTE[0]) // wrap
  })

  it('prefers a valid per-seq override and does not burn a palette slot on it', () => {
    const assigned = new Map<string, number>()
    const config = { seqColors: { drum: '#123abc' } }
    expect(colorForSeq('drum', config, assigned)).toBe('#123ABC')
    // hat is the FIRST palette consumer — drum's override did not take slot 0.
    expect(colorForSeq('hat', config, assigned)).toBe(PLAYHEAD_PALETTE[0])
  })

  it('falls back to the palette when the override is not a hex color', () => {
    const assigned = new Map<string, number>()
    expect(colorForSeq('drum', { seqColors: { drum: 'red' } }, assigned)).toBe(PLAYHEAD_PALETTE[0])
  })

  it('uses the user palette (invalid entries skipped) over the built-in one', () => {
    const assigned = new Map<string, number>()
    const config = { palette: ['#111111', 'nope', '#222'] }
    expect(colorForSeq('a', config, assigned)).toBe('#111111')
    expect(colorForSeq('b', config, assigned)).toBe('#222222') // 'nope' skipped
    expect(colorForSeq('c', config, assigned)).toBe('#111111') // wraps on the 2 valid entries
  })

  it('ignores an all-invalid user palette entirely', () => {
    const assigned = new Map<string, number>()
    expect(colorForSeq('drum', { palette: ['red', 'blue'] }, assigned)).toBe(PLAYHEAD_PALETTE[0])
  })

  it('re-maps existing ordinals when the palette changes length', () => {
    const assigned = new Map<string, number>()
    for (let i = 0; i < 3; i++) colorForSeq(`seq${i}`, {}, assigned)
    // Same assignments map, shorter palette: ordinal 2 now wraps onto entry 0.
    expect(colorForSeq('seq2', { palette: ['#111111', '#222222'] }, assigned)).toBe('#111111')
  })
})
