import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * WORK_LOG のローテーションを**仕組みで**強制する（#686）。
 *
 * 🔴 `docs/core/PROJECT_RULES.md` §1a は「2,000 行を超えたらアーカイブ」と定めていたが、
 * 2026-09-02 の時点で **14,926 行 / 1,221 KB** まで膨らんでいた（**規則の 7.5 倍**）。
 * 規則自体は 2025-09 から存在し、`docs/archive/` には 2026-06 までのアーカイブが実在する
 * ので、**仕組みが無いまま人の記憶に頼った結果、6 月以降だけ止まった**ということになる。
 *
 * CLAUDE.md の「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に従い、
 * 閾値をテストにする。**このテストが red になったらアーカイブする**のであって、
 * 閾値を上げてはいけない（lint の閾値をコードに合わせて緩めないのと同じ理由）。
 */
const WORK_LOG = path.resolve(__dirname, '../../docs/development/WORK_LOG.md')
const MAX_LINES = 2000

describe('WORK_LOG rotation (PROJECT_RULES §1a)', () => {
  it(`stays under ${MAX_LINES} lines`, () => {
    const lines = fs.readFileSync(WORK_LOG, 'utf8').split('\n').length

    expect(
      lines,
      `docs/development/WORK_LOG.md が ${lines} 行あり、上限 ${MAX_LINES} 行を超えています。\n` +
        '閾値を上げるのではなく、アーカイブしてください:\n' +
        '  1. 古い月のエントリを docs/archive/WORK_LOG_YYYY-MM.md へ移す\n' +
        '     （見出しは `### ... (Mon D, YYYY)` の形。日付を持たない ### は本文なので分割点にしない）\n' +
        '  2. アーカイブ側の先頭に PROJECT_RULES §1a のヘッダを付ける\n' +
        '  3. 本体末尾の "## Archived sections" にリンクを追加する',
    ).toBeLessThanOrEqual(MAX_LINES)
  })

  it('keeps the archive index in step with the files on disk', () => {
    // 索引と実体がずれると「アーカイブしたのに辿れない」状態になる。
    const body = fs.readFileSync(WORK_LOG, 'utf8')
    const linked = new Set(
      [...body.matchAll(/\.\.\/archive\/(WORK_LOG_\d{4}-\d{2}\.md)/g)].map((m) => m[1]),
    )
    const onDisk = fs
      .readdirSync(path.resolve(__dirname, '../../docs/archive'))
      .filter((name) => /^WORK_LOG_\d{4}-\d{2}\.md$/.test(name))

    const missing = onDisk.filter((name) => !linked.has(name))
    expect(
      missing,
      'docs/archive/ にあるのに WORK_LOG.md の "## Archived sections" から辿れません。',
    ).toEqual([])
  })
})
