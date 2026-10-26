/**
 * 読めない文は構文エラー（spec「評価の単位」E-7・#965・設計 997 Q-3 = A）。以前のパーサは
 * 読めないトークンと `.` の無い識別子を黙って読み飛ばし、評価は `ok` を返していた。
 *
 * パーサは凍結版の REPL と `orbitscore play` も使うので、🔴 文言に `EOF` を入れない（凍結版の REPL は
 * `EOF` を含むパースのエラーを「入力の途中」と読んで次の行を待ち、次の正しい行まで巻き込む）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DslSyntaxError,
  parseAudioDSL,
  parseAudioDSLWithSpans,
} from '../../packages/engine/src/parser/audio-parser'

function errorOf(source: string): DslSyntaxError {
  try {
    parseAudioDSLWithSpans(source)
  } catch (error) {
    return error as DslSyntaxError
  }
  throw new Error(`expected a syntax error for ${JSON.stringify(source)}`)
}

describe('unreadable statements are syntax errors (E-7 / #965)', () => {
  it.each([
    [
      'this is not orbitscore (((',
      'Expected "." after this but got IDENTIFIER at line 1, column 6',
      { line: 0, character: 5 },
    ],
    [
      'kick play(1, 0)',
      'Expected "." after kick but got IDENTIFIER at line 1, column 6',
      { line: 0, character: 5 },
    ],
    [
      'global.tempo(120)\n) 1, 0',
      'Cannot read a statement that starts with RPAREN ")" at line 2, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
      { line: 1, character: 0 },
    ],
    [
      'alias fx as effect',
      'Expected "." after alias but got IDENTIFIER at line 1, column 7',
      { line: 0, character: 6 },
    ],
  ])('%j → %s', (source, message, position) => {
    expect(() => parseAudioDSL(source)).toThrow(message)
    const error = errorOf(source)
    expect(error.message).toBe(message)
    expect(error.position).toEqual(position)
  })

  it('never says EOF for an unreadable statement (the frozen REPL would wait and swallow the next line)', () => {
    for (const source of ['kick', 'kick\n', ')', '0, 1']) {
      expect(errorOf(source).message, source).not.toMatch(/\bEOF\b/)
    }
    expect(errorOf('kick').message).toBe(
      'Expected "." after kick but got the end of the input at line 1, column 5',
    )
  })

  it('still reads what was valid: a name on its own line followed by the method, and ; between statements', () => {
    expect(parseAudioDSLWithSpans('kick\n  .play(1, 0)').entries).toHaveLength(1)
    expect(parseAudioDSLWithSpans('kick.play(1); hat.play(1)').entries).toHaveLength(2)
    expect(parseAudioDSLWithSpans('sum("drum").gain(-3)').entries).toHaveLength(1)
  })
})

describe('the repository .orbs files do not rely on the old silent skipping', () => {
  it('no tracked .orbs file fails with the new E-7 errors', () => {
    // npm test は packages/engine から走るので、リポジトリのルートを基準にする。
    const repoRoot = path.resolve(__dirname, '../..')
    const files = execSync("git ls-files '*.orbs'", { cwd: repoRoot, encoding: 'utf8' })
      .trim()
      .split('\n')
    expect(files.length).toBeGreaterThan(100)
    const hits: string[] = []
    for (const file of files) {
      try {
        parseAudioDSL(fs.readFileSync(path.join(repoRoot, file), 'utf8'))
      } catch (error) {
        const message = (error as Error).message
        if (/^Cannot read a statement|^Expected "\." after /.test(message)) {
          hits.push(`${file}: ${message}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})
