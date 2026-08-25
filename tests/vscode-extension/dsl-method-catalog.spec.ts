/**
 * #495 第1段: DSL メソッド補完の候補表が engine の語彙と一致していることの検査。
 *
 * 🔴 なぜ必要か
 *
 * 拡張は engine を**プロセス境界越しに**使う設計なので、補完の候補表は engine の語彙の
 * **写し**になる。写しは乖離する — 実際、`seq.ui()`（#617）を engine に足した時点では
 * 補完に出なかった。
 *
 * このテストは engine 側を正本とし、**一字一句の一致**を固定する。DSL にメソッドを足して
 * 候補表を更新し忘れると red になる。
 */

import { describe, expect, it } from 'vitest'

import {
  BUS_DSL_METHODS,
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
} from '../../packages/engine/src/signal-chain/runtime'
import {
  BUS_METHODS,
  GLOBAL_METHODS,
  SEQUENCE_METHODS,
} from '../../packages/vscode-extension/src/dsl-method-catalog'

const sorted = (xs: Iterable<string>): string[] => [...xs].sort()

describe('補完の候補表は engine の DSL 語彙と一致する (#495)', () => {
  it('sequence', () => {
    expect(sorted(SEQUENCE_METHODS)).toEqual(sorted(SEQUENCE_DSL_METHODS))
  })

  it('global', () => {
    expect(sorted(GLOBAL_METHODS)).toEqual(sorted(GLOBAL_DSL_METHODS))
  })

  it('bus', () => {
    expect(sorted(BUS_METHODS)).toEqual(sorted(BUS_DSL_METHODS))
  })

  it('🔴 #617 で足した ui が三方に揃っている（乖離の実例）', () => {
    expect(SEQUENCE_METHODS).toContain('ui')
    expect(BUS_METHODS).toContain('ui')
    expect(SEQUENCE_DSL_METHODS.has('ui')).toBe(true)
  })

  it('候補表に重複が無い', () => {
    for (const [name, xs] of [
      ['sequence', SEQUENCE_METHODS],
      ['global', GLOBAL_METHODS],
      ['bus', BUS_METHODS],
    ] as const) {
      expect(new Set(xs).size, `${name} に重複がある`).toBe(xs.length)
    }
  })
})
