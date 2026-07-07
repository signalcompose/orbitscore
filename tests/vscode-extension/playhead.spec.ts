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

  it('uses the FIRST play call when the seq has several (MVP scope)', () => {
    const text = 'drum.play(1, 2)\ndrum.play(3, 4, 5)\n'
    expect(sliceAll(text, 'drum')).toEqual(['1', '2'])
  })

  it('stops at the matching close paren of a chained call', () => {
    expect(sliceAll('drum.play(1, 2).beat(4 by 4)', 'drum')).toEqual(['1', '2'])
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

  it('matches the orbitscore.playheadPalette default in package.json', async () => {
    const fs = await import('node:fs')
    const packageJson = JSON.parse(
      fs.readFileSync(
        new URL('../../packages/vscode-extension/package.json', import.meta.url),
        'utf8',
      ),
    )
    const configured =
      packageJson.contributes.configuration.properties['orbitscore.playheadPalette'].default
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
