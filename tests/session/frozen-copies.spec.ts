/**
 * 凍結版から層 2 へ写したモジュールが、写した時のまま一致していること（設計 848 §4.5.1・§10.3）。
 *
 * 凍結版は変わらないので、この spec が縛るのは層 2 の側である。層 2 で写しを変える時は、
 * `frozen-copies.ts` の一覧から外して理由を書く（写しが「凍結版と同じ」という前提を、黙って崩さない）。
 * 拡張版と共存する間だけの spec（台帳 P-09）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FROZEN_COPIES } from './frozen-copies'

const ROOT = path.resolve(__dirname, '../..')

describe('modules copied from the frozen extension stay identical (design 848 §4.5.1)', () => {
  it.each(FROZEN_COPIES)('$copy equals $original', ({ copy, original, rewrites = [] }) => {
    let expected = fs.readFileSync(path.join(ROOT, original), 'utf8')
    for (const [from, to] of rewrites) {
      expect(expected, `rewrite source not found in ${original}: ${from}`).toContain(from)
      expected = expected.split(from).join(to)
    }
    expect(fs.readFileSync(path.join(ROOT, copy), 'utf8')).toBe(expected)
  })
})
