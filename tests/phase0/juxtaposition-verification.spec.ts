import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'

/**
 * Phase 0 検証 0-1: タプル並置 `(1)(2)` の現行パーサー挙動
 *
 * Issue #226 / PITCH_DSL_SPEC_v1.1 §3.3 の前提確認。
 *
 * 検証する問い:
 *   「`(1)(2)` のようなカンマなしのグループ並置は、現行パーサーで兄弟展開されるか?」
 *
 * 結論（このテストが固定する現行挙動）:
 *   1. 並置 `(1)(2)` は兄弟2グループに展開される（パースエラーにならない）= 前提成立
 *   2. パーサーは並置 `(1)(2)` とカンマ区切り `(1), (2)` を「同一の args 配列」に
 *      フラット化する。タイミング上は完全に同一。
 *   3. ⚠️ Phase 2 含意: 現状 AST は「並置」と「カンマ区切り」を区別しない。
 *      spec §3.3 の `.root()` スコープ規則（「チェーンは並置を閉じる」「カンマが
 *      スコープ終端」）の実装には、この区別を AST に保持する拡張が Phase 2 で必要。
 *      これは spec も織り込み済みのパーサー作業であり、前提崩壊ではない。
 */
describe('Phase 0-1: tuple juxtaposition `(1)(2)` parser behavior', () => {
  it('並置 (1)(2)(3) は兄弟3グループに展開される（エラーにならない）', () => {
    const ir = parseAudioDSL('seq1.play((1)(2)(3))')
    const args = ir.statements[0].args

    expect(args).toHaveLength(3)
    expect(args[0]).toMatchObject({ type: 'nested', elements: [1] })
    expect(args[1]).toMatchObject({ type: 'nested', elements: [2] })
    expect(args[2]).toMatchObject({ type: 'nested', elements: [3] })
  })

  it('並置 (1)(2) とカンマ区切り (1), (2) は同一の args 構造になる（区別が捨てられる）', () => {
    const juxtaposed = parseAudioDSL('seq1.play((1)(2))').statements[0].args
    const commaSeparated = parseAudioDSL('seq1.play((1), (2))').statements[0].args

    // 並置とカンマ区切りで args 配列は構造的に同一 = パーサーは両者を区別しない
    expect(juxtaposed).toEqual(commaSeparated)
    expect(juxtaposed).toHaveLength(2)
    expect(juxtaposed[0]).toMatchObject({ type: 'nested', elements: [1] })
    expect(juxtaposed[1]).toMatchObject({ type: 'nested', elements: [2] })
  })

  it('並置されたトップレベル2グループは、1小節を2スロットに等分する', () => {
    const args = parseAudioDSL('seq1.play((1)(2))').statements[0].args

    // barDuration=2000ms (4/4, 120BPM, length=1 相当) を 2 グループで等分 → 各 1000ms
    const events = calculateEventTiming(args as never, 2000)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ sliceNumber: 1, startTime: 0, duration: 1000 })
    expect(events[1]).toMatchObject({ sliceNumber: 2, startTime: 1000, duration: 1000 })
  })

  it('並置とカンマ区切りはタイミング列も完全一致する', () => {
    const jux = parseAudioDSL('seq1.play((1)(2))').statements[0].args
    const comma = parseAudioDSL('seq1.play((1), (2))').statements[0].args

    const eventsJux = calculateEventTiming(jux as never, 2000)
    const eventsComma = calculateEventTiming(comma as never, 2000)

    expect(eventsJux).toEqual(eventsComma)
  })
})
