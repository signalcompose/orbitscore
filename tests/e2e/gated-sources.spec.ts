/**
 * `gated-sources.ts` 自身の検査（#668-A・PR-E4 で追加）。
 *
 * 🔴 **なぜ要るか。** PR-E1 でこのモジュールを入れた時、`gatedItTitles()` に**テストが
 * 無かった**。その結果、正規表現が `it(` の直後に文字列が来る前提になっており、実際の
 * suite が使う **`it.skipIf(!appAvailable)('title', ...)` のカリー形を 1 件も拾えていなかった**
 * （2026-09-03 実測）。
 *
 * それでも当時は緑だった — 拾えなくても「照合対象が無い」だけで、誰も困らなかったからである。
 * 検査 A-4（台帳のシナリオが実在するか）が消費し始めた瞬間に、**空振りで緑 → 正当な台帳
 * エントリで誤 red** という壊れ方をする。
 *
 * 「走査の層」は自分自身のテストを持たないと、こうして黙って壊れる。
 */
import { describe, expect, it } from 'vitest'

import { GATED_SOURCE_FILES, gatedItTitles, readGatedSources } from './gated-sources'

describe('gated-sources', () => {
  it('finds the gated suite source files', () => {
    expect(
      GATED_SOURCE_FILES.length,
      'No gated source files were found. Both the coverage ratchet and the assertion-hygiene ' +
        'check read these; an empty list makes them silently vacuous.',
    ).toBeGreaterThan(0)
  })

  it('reads a source that names the gated suite', () => {
    expect(readGatedSources()).toContain('OrbitStudio Agent Bridge MCP E2E')
  })

  it('picks up titles from the curried it.skipIf(...) form the suite actually uses', () => {
    // 🔴 これが PR-E1 で落とした穴。suite は 20 箇所すべて `it.skipIf(!appAvailable)(` で書く。
    const titles = gatedItTitles()
    expect(
      titles.length,
      'gatedItTitles() found no titles. The suite writes it.skipIf(!appAvailable)(...), so a ' +
        'regex that expects a string right after `it(` matches nothing (see #668-A / PR-E4).',
    ).toBeGreaterThan(0)
  })

  it('returns titles that the coverage ledger can anchor to', () => {
    // A-4 は `title.includes(scenario)` で照合する。実在する題名の一部で引ければ十分。
    const titles = gatedItTitles()
    expect(
      titles.some((title) => title.includes('drives real OrbitStudio')),
      `Expected the end-to-end scenario title among ${titles.length} titles: ${titles
        .slice(0, 5)
        .join(' | ')}`,
    ).toBe(true)
  })
})
