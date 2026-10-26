/**
 * 凍結版から層 2 へ写したモジュールが、記録した差（パッチ）のとおりであること
 * （設計 848 §4.5.1・§10.3）。一覧と規則は `frozen-copies.ts`。拡張版と共存する間だけの spec（台帳 P-09）。
 *
 * 差は `git diff --no-index` の hunk で比べる（アルゴリズム・文脈行数・空行の書き方を固定し、
 * 利用者の git 設定に左右されない）。hunk の見出しの関数名の部分は比べない。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FROZEN_COPIES } from './frozen-copies'

const ROOT = path.resolve(__dirname, '../..')
const PATCH_DIR = path.join(__dirname, 'frozen-copies')
const UPDATE = process.env.UPDATE_FROZEN_COPY_PATCHES === '1'

function hunks(original: string, copy: string): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'diff.suppressBlankEmpty=false',
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--diff-algorithm=myers',
      '--indent-heuristic',
      '--inter-hunk-context=0',
      '-U3',
      '--',
      original,
      copy,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git diff failed (${result.status}): ${result.stderr}`)
  }
  const lines = result.stdout.split('\n')
  const first = lines.findIndex((line) => line.startsWith('@@'))
  if (first < 0) return ''
  return lines
    .slice(first)
    .map((line) => (line.startsWith('@@') ? line.replace(/^(@@ [^@]+ @@).*$/, '$1') : line))
    .join('\n')
}

describe('modules copied from the frozen extension differ only by the recorded patch (design 848 §4.5.1)', () => {
  it.each(FROZEN_COPIES)('$copy = $original + its patch', ({ copy, original, why }) => {
    const patchFile = path.join(PATCH_DIR, `${path.basename(copy)}.patch`)
    const actual = hunks(original, copy)
    if (UPDATE) {
      if (actual === '') fs.rmSync(patchFile, { force: true })
      else fs.writeFileSync(patchFile, actual)
    }
    const expected = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
    expect(actual, `${copy} の凍結版からの差`).toBe(expected)
    // 差があるのに理由が無い・理由があるのに差が無い、のどちらも作らない。
    expect(why === undefined, `${copy}: why はパッチがある時だけ書く`).toBe(expected === '')
  })

  it('has no stray patch without an entry', () => {
    const listed = new Set(FROZEN_COPIES.map(({ copy }) => `${path.basename(copy)}.patch`))
    const onDisk = fs.existsSync(PATCH_DIR) ? fs.readdirSync(PATCH_DIR) : []
    expect(onDisk.filter((file) => !listed.has(file))).toEqual([])
  })
})
