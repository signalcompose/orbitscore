/**
 * #495 第1段: `<receiver>.` の後のメソッド補完。
 *
 * owner ビジョン（#495）:
 * > コンテキストに合わせて他のところでも効くようにしたい。…変数が持ってるファンクション
 * > （メソッド）もそう。
 *
 * 既存の補完は**文字列の中**（import パス / バス名 / プラグイン名）だけを埋めていた。
 * ここはドットの後の面を足す。
 */

import { describe, expect, it } from 'vitest'

import {
  detectDslCompletionContext,
  extractDeclaredGlobalNames,
  extractDeclaredSequenceNames,
} from '../../packages/vscode-extension/src/dsl-completion-context'

describe('メソッド補完の文脈検出 (#495)', () => {
  it('global. を Global レシーバとして検出する', () => {
    expect(detectDslCompletionContext('global.', 7)).toMatchObject({
      kind: 'method',
      typed: '',
      receiver: 'global',
    })
  })

  it('打ちかけの文字を typed として返す', () => {
    expect(detectDslCompletionContext('global.tem', 10)).toMatchObject({
      kind: 'method',
      typed: 'tem',
      receiver: 'global',
    })
  })

  it('sum("x"). はバスハンドル', () => {
    const line = 'sum("strings").'
    expect(detectDslCompletionContext(line, line.length)).toMatchObject({
      kind: 'method',
      receiver: 'bus',
    })
  })

  it('aux("x"). もバスハンドル', () => {
    const line = 'aux("verb").ui'
    expect(detectDslCompletionContext(line, line.length)).toMatchObject({
      kind: 'method',
      typed: 'ui',
      receiver: 'bus',
    })
  })

  it('変数名は sequence として返す（最終判定は provider が宣言を見る）', () => {
    expect(detectDslCompletionContext('cb.', 3)).toMatchObject({
      kind: 'method',
      receiver: 'sequence',
    })
  })

  it('文字列の中では発火しない（既存の面を壊さない）', () => {
    const line = 'cb.audio("takes/a.'
    expect(detectDslCompletionContext(line, line.length)).not.toMatchObject({ kind: 'method' })
  })

  it('コメントの中では発火しない', () => {
    const line = '// cb.'
    expect(detectDslCompletionContext(line, line.length)).toBeNull()
  })

  it('ドットが無ければ発火しない', () => {
    expect(detectDslCompletionContext('cb', 2)).toBeNull()
  })
})

describe('レシーバ判定のための宣言抽出 (#495)', () => {
  const source = [
    'var global = init GLOBAL',
    'var cb = init global.seq',
    'var vln1 = init global.seq',
    '// var commented = init global.seq',
    'var notASeq = 3',
  ].join('\n')

  it('init global.seq の名前を集める', () => {
    expect(extractDeclaredSequenceNames(source).sort()).toEqual(['cb', 'vln1'])
  })

  it('init GLOBAL の名前を集める', () => {
    expect(extractDeclaredGlobalNames(source)).toEqual(['global'])
  })

  it('🔴 global を sequence に混ぜない（候補源を取り違えない）', () => {
    expect(extractDeclaredSequenceNames(source)).not.toContain('global')
  })

  it('コメント行の宣言は拾わない', () => {
    expect(extractDeclaredSequenceNames(source)).not.toContain('commented')
  })

  it('慣例外の global 名も拾う（decided by 宣言, not 名前）', () => {
    expect(extractDeclaredGlobalNames('var g = init GLOBAL')).toEqual(['g'])
  })
})
