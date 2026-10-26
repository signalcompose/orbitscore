/**
 * E2E が engine へ送る DSL の文字列が、厳しくしたパーサ（spec「評価の単位」E-7・設計 997 D-E3・#1022 の
 * N1-d5）で読めること — 昔の「読めない文を黙って飛ばす」振る舞いに頼る文字列が 0（設計 997 §7.3。
 * §2.4 は追跡されている `.orbs` だけを数え、spec の中の文字列は数えていなかった）。
 *
 * gated E2E は macOS 実機でしか走らないので、読み飛ばしに頼る文字列は実機のゲートで初めて落ちる。ここは
 * `tests/e2e` のソースを TypeScript の構文木で読み、**DSL が engine へ渡る位置**にある **DSL らしい**文字列を
 * 取り出して、Linux の `npm test` で先に読む。
 *
 * - 位置: `code` / `lines` / `replace` の値・`[…].join(…)` の配列・名前が DSL を示す変数（`dsl` / `score` /
 *   `code` / `lines` / `declaration` / 末尾 `line`）・配列を返すアロー関数・`evaluate(…)` の第 1 引数・
 *   `writeFileSync` の内容・`…Scenario(…)` の引数。検索に使う断片（`indexOf` / `includes` の引数）は送らないので取らない
 * - DSL らしさ: どこかの行が DSL の文の頭（`var x = init` / `a.b(` / `LOOP(` / `RUN(` / `MUTE(` / `import {`）で始まる
 * - テンプレートの `${…}` は値が分からないので仮の値で埋める: `JSON.stringify(…)` は文字列 `"s"`、文の頭で直後が
 *   `(` なら命令 `LOOP`、それ以外は識別子 `p<i>`。仮の値のせいで落ちた時は**ここの規則を直す**（spec の DSL を曲げない）
 *
 * 落とすのは E-7 の 3 つの文言（読み飛ばしていたもの）だけ。意図して構文エラーを送る E2E は別の文言で落ちるので通す。
 */
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

const E2E_DIR = __dirname

/** DSL を engine へ送らず、別の目的の文字列（検査する TS のコード片・ログの行）だけを持つ spec。 */
const EXCLUDED = new Map<string, string>([
  [
    'gated-assertion-hygiene.spec.ts',
    'gated の spec の書き方を検査する spec。文字列は TS のコード片',
  ],
  ['helpers/helpers.spec.ts', 'ログ・ファイルの helper の unit。文字列は任意のテキスト'],
  ['dsl-e2e-coverage.spec.ts', 'DSL の語の一覧（ラチェットの baseline）'],
  ['gated-dsl-strict-parse.spec.ts', 'この spec 自身（抽出の検査に、わざと壊した DSL を持つ）'],
])

const DSL_STATEMENT =
  /(^|\n)\s*(var\s+\w+\s*=\s*init\b|[A-Za-z_]\w*\.[A-Za-z_]\w*\s*\(|LOOP\s*\(|RUN\s*\(|MUTE\s*\(|import\s*\{)/

/** 厳しくしたパーサが足した文言（以前は黙って読み飛ばしていた入力）。 */
const E7_MESSAGE =
  /Cannot read a statement that starts with|Expected "\." after|Unexpected character/

export interface DslCandidate {
  file: string
  line: number
  position: string
  text: string
}

function textOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  let text = node.head.text
  node.templateSpans.forEach((span, i) => {
    const command = /(^|\n)\s*$/.test(text) && span.literal.text.startsWith('(')
    const placeholder = /^JSON\.stringify\(/.test(span.expression.getText())
      ? '"s"'
      : command
        ? 'LOOP'
        : `p${i}`
    text += placeholder + span.literal.text
  })
  return text
}

function dslTextOf(node: ts.Node): string | null {
  if (!ts.isArrayLiteralExpression(node)) return textOf(node)
  const parts = node.elements.map(textOf)
  return parts.length > 0 && parts.every((part) => part !== null) ? parts.join('\n') : null
}

/** DSL が engine へ渡る位置なら、その種類。 */
function dslPosition(node: ts.Node): string | null {
  let parent = node.parent
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    parent = parent.parent
  }
  if (!parent) return null
  if (ts.isPropertyAssignment(parent)) {
    const name = parent.name.getText()
    return ['code', 'lines', 'replace'].includes(name) ? `property ${name}` : null
  }
  if (ts.isArrayLiteralExpression(node)) {
    if (ts.isPropertyAccessExpression(parent) && parent.name.getText() === 'join') return 'join'
    if (ts.isArrowFunction(parent)) return 'arrow return'
  }
  if (ts.isVariableDeclaration(parent)) {
    return /dsl|score|code|lines|declaration|line$/i.test(parent.name.getText()) ? 'variable' : null
  }
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText()
    const index = parent.arguments.indexOf(node as ts.Expression)
    if (/(^|\.)evaluate$/.test(callee) && index === 0) return 'evaluate()'
    if (/writeFileSync$/.test(callee) && index === 1) return 'writeFileSync()'
    if (/Scenario$/.test(callee) && index >= 0) return 'scenario()'
  }
  return null
}

/** TypeScript のソースから、DSL が engine へ渡る位置の DSL らしい文字列を取り出す。 */
export function dslCandidates(file: string, source: string): DslCandidate[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: DslCandidate[] = []
  const visit = (node: ts.Node): void => {
    const position = dslPosition(node)
    const text = position ? dslTextOf(node) : null
    if (position && text !== null && DSL_STATEMENT.test(text)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.push({ file, line, position, text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** 読み飛ばしに頼る（E-7 の文言で落ちる）なら、その文言。 */
export function skippingError(text: string): string | null {
  try {
    parseAudioDSL(text)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return E7_MESSAGE.test(message) ? message : null
  }
}

function e2eSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return e2eSources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

function corpus(): DslCandidate[] {
  return e2eSources(E2E_DIR)
    .map((full) => path.relative(E2E_DIR, full).split(path.sep).join('/'))
    .filter((file) => !EXCLUDED.has(file))
    .flatMap((file) => dslCandidates(file, fs.readFileSync(path.join(E2E_DIR, file), 'utf8')))
}

describe('the E2E suites do not rely on the parser silently skipping statements (design 997 §7.3)', () => {
  it('every DSL string sent to the engine parses without the E-7 errors', () => {
    const relying = corpus().flatMap((candidate) => {
      const message = skippingError(candidate.text)
      return message
        ? [`${candidate.file}:${candidate.line} (${candidate.position}): ${message}`]
        : []
    })
    expect(
      relying,
      'These E2E strings depended on the old parser skipping what it could not read. Fix the DSL, ' +
        'or, if a `${…}` placeholder caused it, fix the placeholder rule at the top of this spec.',
    ).toEqual([])
  })

  it('still finds DSL in each kind of position (the extractor has not gone blind)', () => {
    const found = corpus()
    // 2026-10-26 の実測: 132 件（property code 58・evaluate() 23・join 21・variable 14・scenario() 9 ほか）。
    // 下限は抽出が黙って見えなくなったことに気づくためのもの（E2E を消して減るのは構わない）。
    expect(found.length).toBeGreaterThanOrEqual(100)
    const positions = new Set(found.map((candidate) => candidate.position))
    for (const position of ['property code', 'property lines', 'join', 'variable', 'evaluate()']) {
      expect(positions, position).toContain(position)
    }
    for (const file of EXCLUDED.keys())
      expect(fs.existsSync(path.join(E2E_DIR, file)), file).toBe(true)
  })

  it('catches a skipped statement in the positions it reads, and ignores search fragments', () => {
    const source = [
      "await client.call('evaluate_orbitscore', { code: 'var a = init global.seq\\nkick\\na.play(1)' })",
      "const dslLines = ['var b = init global.seq', 'b.play(1) !']",
      'const score = (seq: string, run: string) => [`var ${seq} = init global.seq`, `${run}(${seq})`]',
      "const at = dslLines.indexOf('LOOP(b) junk')",
      'expect(log).toContain(\'global.sum("drum") junk\')',
    ].join('\n')
    const found = dslCandidates('synthetic.ts', source)
    expect(found.map((candidate) => [candidate.line, candidate.position])).toEqual([
      [1, 'property code'],
      [2, 'variable'],
      [3, 'arrow return'],
    ])
    expect(skippingError(found[0]!.text)).toMatch(/Expected "\." after kick/)
    expect(skippingError(found[1]!.text)).toMatch(/Unexpected character "!"/)
    // `${run}(${seq})` は命令の仮の値で埋まるので、テンプレートの譜面は通る。
    expect(found[2]!.text).toBe('var p0 = init global.seq\nLOOP(p1)')
    expect(skippingError(found[2]!.text)).toBeNull()
    // 意図した構文エラー（E-7 でない文言）は読み飛ばしではないので通す。
    expect(skippingError('LOOP(')).toBeNull()
  })
})
