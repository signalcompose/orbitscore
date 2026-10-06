import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { gitLsFiles } from './file-size-targets'

/**
 * root で skip するテストの件数のラチェット（#684・設計 668 §13「併せて」）。
 *
 * `skipWhenDacIsBypassed()` は root で DAC 依存のテストを skip する。skip は red にならないので、
 * 呼び出しが増えても誰も気づかず「root では未検証」の範囲だけが黙って広がる。件数を固定し、
 * **増える編集は red・減る編集は緑**にする（他のラチェットと同じ形）。
 *
 * 増やす前に、chmod 以外の方法で失敗を作れないかを先に検討すること（#684 の案 B）。
 */
const BASELINE = 3
const CALL = 'skipWhenDacIsBypassed('
const repoRoot = path.resolve(__dirname, '../..')

describe('root-skip ratchet (#684)', () => {
  it(`calls skipWhenDacIsBypassed() at most ${BASELINE} times across tests/`, () => {
    // 走査対象は隣のラチェットと同じく git の index（`file-size-targets.ts`）。
    // このファイル自身は CALL を文字列定数として持つだけで、呼び出していない。
    const calls = gitLsFiles(repoRoot, ':(glob)tests/**/*.spec.ts')
      .filter((file) => file !== 'tests/repo/privileges-skip-ratchet.spec.ts')
      .flatMap((file) => {
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
        if (!source.includes(CALL)) return []
        return source
          .split('\n')
          .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
          .filter(({ line }) => line.includes(CALL) && !line.trim().startsWith('*'))
          .map(({ at }) => at)
      })
    expect(
      calls.length,
      `skipWhenDacIsBypassed() call sites grew beyond ${BASELINE}: ${calls.join(', ')}`,
    ).toBeLessThanOrEqual(BASELINE)
    // 生存確認: 検索が空振りしていない（helper の改名で 0 件になったら気づく）。
    expect(calls.length).toBeGreaterThan(0)
  })
})
