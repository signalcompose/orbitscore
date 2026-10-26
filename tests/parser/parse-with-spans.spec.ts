/**
 * `parseAudioDSLWithSpans`（OrbitStudio の層 2 の評価・spec「評価の単位」E-1・#997 / #1022）。
 *
 * 約束: 読んだ文は `parseAudioDSL` と同じ構文木 / 文は**ソースの順**（宣言を種類ごとに分けない）/
 * 範囲は LSP と同じ 0 始まり・UTF-16・行は `\n` `\r\n` `\r` / 構文エラーは同じ文言で位置つき。
 */
import { describe, expect, it } from 'vitest'

import {
  DslSyntaxError,
  parseAudioDSL,
  parseAudioDSLWithSpans,
} from '../../packages/engine/src/parser/audio-parser'

const at = (line: number, character: number) => ({ line, character })

function syntaxError(source: string): DslSyntaxError {
  try {
    parseAudioDSLWithSpans(source)
  } catch (error) {
    expect(error).toBeInstanceOf(DslSyntaxError)
    return error as DslSyntaxError
  }
  throw new Error('expected a syntax error')
}

describe('parseAudioDSLWithSpans — entries in source order', () => {
  it('keeps the source order and the kinds, with the same nodes as parseAudioDSL', () => {
    const source = [
      'kick.play(1, 0)',
      'var global = init GLOBAL',
      'var kick = init global.seq',
      'LOOP(kick)',
    ].join('\n')
    const { entries } = parseAudioDSLWithSpans(source)
    expect(entries.map((entry) => entry.kind)).toEqual([
      'statement',
      'global_init',
      'seq_init',
      'statement',
    ])
    expect(entries.map((entry) => entry.text)).toEqual(source.split('\n'))
    // parseAudioDSL は宣言を前へ寄せるが、構文木そのものは同じ
    const ir = parseAudioDSL(source)
    expect(entries[0]!.node).toEqual(ir.statements[0])
    expect(entries[1]!.node).toEqual(ir.globalInit)
    expect(entries[2]!.node).toEqual(ir.sequenceInits[0])
    expect(entries[3]!.node).toEqual(ir.statements[1])
  })

  it('reports each statement span (0-based, end exclusive)', () => {
    const { entries } = parseAudioDSLWithSpans('global.tempo(120)\n  kick.play(1, 0)  \n')
    expect(entries.map((entry) => entry.span)).toEqual([
      { start: at(0, 0), end: at(0, 17) },
      { start: at(1, 2), end: at(1, 17) },
    ])
  })

  it('does not split a statement at blank lines, and joins a leading-dot line to the chain (E-1)', () => {
    const { entries } = parseAudioDSLWithSpans(
      ['hh.play(', '  1, 0,', '', '', '  0, 1', ')', 'kick.play(1, 0)', '  .gain(-6)'].join('\n'),
    )
    expect(entries.map((entry) => entry.text)).toEqual([
      'hh.play(\n  1, 0,\n\n\n  0, 1\n)',
      'kick.play(1, 0)\n  .gain(-6)',
    ])
    expect(entries[1]!.span).toEqual({ start: at(6, 0), end: at(7, 11) })
  })

  it('ends a statement after the closing quote of a string, even across lines and escapes', () => {
    const source = 'import { kick } from "./x\ny.orbs"\nkick.audio("a\\"b.wav")'
    const { entries } = parseAudioDSLWithSpans(source)
    expect(entries[0]!.text).toBe('import { kick } from "./x\ny.orbs"')
    expect(entries[0]!.span.end).toEqual(at(1, 7))
    expect(entries[1]!.text).toBe('kick.audio("a\\"b.wav")')
    expect(entries[1]!.span).toEqual({ start: at(2, 0), end: at(2, 22) })
  })

  it('counts lines with \\r\\n and a lone \\r like LSP, and characters in UTF-16 units', () => {
    const { entries } = parseAudioDSLWithSpans('a.audio("🥁")\r\nb.play(1)\rc.play(1)')
    expect(entries.map((entry) => entry.span.start)).toEqual([at(0, 0), at(1, 0), at(2, 0)])
    // 🥁 はサロゲートペア（2 単位）
    expect(entries[0]!.span.end).toEqual(at(0, 13))
  })

  it('returns no entries for comments and blank text', () => {
    expect(parseAudioDSLWithSpans('// only a comment\n\n\n').entries).toEqual([])
    expect(parseAudioDSLWithSpans('').entries).toEqual([])
  })
})

describe('parseAudioDSLWithSpans — positioned syntax errors (E-2)', () => {
  it('keeps the parseAudioDSL message and takes the position from it (0-based)', () => {
    const source = 'global.tempo(120)\nkick.play(1 0)'
    const error = syntaxError(source)
    expect(() => parseAudioDSL(source)).toThrow(error.message)
    expect(error.message).toBe(
      'Expected comma or closing parenthesis but got NUMBER at line 2, column 13',
    )
    expect(error.position).toEqual(at(1, 12))
  })

  it('points an unclosed call at the end of the request (no "wait for more")', () => {
    expect(syntaxError('kick.play(1, 0, 1').position).toEqual(at(0, 17))
  })

  it('points an error without a position in its text at the statement it was reading', () => {
    const error = syntaxError(
      'global.tempo(1)\nvar global = init GLOBAL\nimport { a } from "./x.orbs"',
    )
    expect(error.message).toBe(
      'import "./x.orbs": import statements must appear before any other statement (IM.1).',
    )
    expect(error.position).toEqual(at(2, 0))
  })
})
