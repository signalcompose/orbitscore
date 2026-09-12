import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { countCodeLines } from './code-lines'
import { listMeasuredFiles } from './file-size-targets'

/**
 * `countCodeLines('ts', …)` の独立検算（#888 レビュー指摘 F-1）。
 *
 * `code-lines.ts` の TS 側の状態機械は、正規表現リテラルの判定や入れ子テンプレート
 * リテラルの扱いなど**発見的（heuristic）な部分**を持つ（`code-lines.ts` 冒頭コメント）。
 * ラチェットの信用は「数え方が正しい」ことに依存するので、heuristic を改良するだけで
 * 済ませず、**言語の正規の実装（TypeScript のパーサ）を基準にした独立オラクル**で
 * TS 全件を検算する。
 *
 * オラクルの作り方: `ts.createSourceFile` で構文木を作り、**葉ノード（子を持たない
 * ノード）が占める文字位置**を印す。JSDoc ノード（`FirstJSDocNode`〜`LastJSDocNode`）は
 * 除外する（JSDoc コメントはコードではない）。印のついた文字を1文字でも含む行を
 * 「コード行」とする。この定義は `countCodeLines` の「空白・コメント以外の文字を
 * 1文字でも含む行」と等価であるはずである。
 *
 * 🔴 既知の差が1件だけある: `packages/engine/src/cli-audio.ts` の shebang 行
 * （`#!/usr/bin/env node`）。TypeScript パーサはこれを trivia として扱いどのノードにも
 * 属させないが、`countCodeLines` は非空白文字を含む行としてコード行に数える。
 * **実装の方が多く数える側**（§3.3「迷ったら数える」の安全側）なので許容する。
 * これ以外のずれは 1 件でも red にする（許容リストを増やす編集はレビューで止める）。
 */

const repoRoot = path.resolve(__dirname, '../..')

/** shebang 以外に既知の差を増やさない（増やす編集はレビューで止める・上のコメント参照）。 */
const KNOWN_ORACLE_DIFFERENCES: ReadonlyMap<string, { implementation: number; oracle: number }> =
  new Map([['packages/engine/src/cli-audio.ts', { implementation: 17, oracle: 16 }]])

/** JSDoc ノードを除いた葉トークンが占める文字位置に印を付ける。 */
function markTokenPositions(sourceFile: ts.SourceFile, sourceLength: number): Uint8Array {
  const isToken = new Uint8Array(sourceLength)
  const walk = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return
    }
    if (node.getChildCount(sourceFile) === 0) {
      for (let i = node.getStart(sourceFile); i < node.getEnd(); i++) isToken[i] = 1
      return
    }
    for (const child of node.getChildren(sourceFile)) walk(child)
  }
  walk(sourceFile)
  return isToken
}

/** オラクルによる「コード行」数（TypeScript パーサ基準）。 */
function oracleCodeLineCount(source: string, fileName: string): number {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const isToken = markTokenPositions(sourceFile, source.length)

  const lines = source.split('\n')
  let offset = 0
  let code = 0
  for (const line of lines) {
    const start = offset
    const end = offset + line.length
    let hasToken = false
    for (let i = start; i < end; i++) {
      if (isToken[i] === 1) {
        hasToken = true
        break
      }
    }
    if (hasToken) code++
    offset = end + 1 // 分割で消えた '\n' の分を進める
  }
  return code
}

describe('countCodeLines(ts) is verified against an independent TypeScript-parser oracle', () => {
  const tsFiles = listMeasuredFiles(repoRoot).filter((f) => f.lang === 'ts')

  it('F-1: 検算対象の TS ファイルが実在する（真空防止）', () => {
    expect(tsFiles.length).toBeGreaterThan(0)
  })

  it('F-1: 全 TS ファイルで countCodeLines と TypeScript パーサ・オラクルが一致する（既知の1件を除く）', () => {
    const mismatches: string[] = []

    for (const file of tsFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
      const implementation = countCodeLines(source, 'ts').code
      const oracle = oracleCodeLineCount(source, file.path)

      const known = KNOWN_ORACLE_DIFFERENCES.get(file.path)
      if (known) {
        expect(
          implementation,
          `${file.path}: 既知差分リストの implementation 値が現状と食い違っています。` +
            'リストを更新するか、既知差分自体が解消されたなら消してください。',
        ).toBe(known.implementation)
        expect(oracle, `${file.path}: 既知差分リストの oracle 値が現状と食い違っています。`).toBe(
          known.oracle,
        )
        continue
      }

      if (implementation !== oracle) {
        mismatches.push(`  ${file.path}: implementation=${implementation} / oracle=${oracle}`)
      }
    }

    expect(
      mismatches,
      'countCodeLines(ts) と TypeScript パーサ・オラクルが食い違いました:\n' +
        mismatches.join('\n') +
        '\n\n既知の許容リスト（shebang 行）以外のずれは許されません。' +
        'code-lines.ts の heuristic を見直してください。',
    ).toEqual([])
  })
})
