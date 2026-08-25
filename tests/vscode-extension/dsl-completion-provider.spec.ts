/**
 * #495 第1段: 補完 provider **本体**を駆動する（文脈検出ではなく配線のテスト）。
 *
 * 🔴 なぜ本体を呼ぶか
 *
 * 文脈検出（`detectDslCompletionContext`）が正しくても、provider がその結果を
 * **正しい候補源に繋いでいなければ**補完は出ない。#614 では `handleLine` を誤った分岐に
 * 入れて全 timeout したのに**ユニットテストは全件緑**だった。同じ穴を残さないため、
 * ここでは `provideCompletionItems` を実際に呼んで返る候補を検査する。
 */

import { describe, expect, it } from 'vitest'

import { dslCompletionItemProvider } from '../../packages/vscode-extension/src/extension'
import { Position } from '../mocks/vscode'

/** vscode の TextDocument の、provider が触る面だけを持つ最小の偽物。 */
function doc(source: string) {
  const lines = source.split('\n')
  return {
    getText: () => source,
    lineAt: (p: { line: number }) => ({ text: lines[p.line] ?? '' }),
    uri: { fsPath: '/tmp/score.orbs' },
  } as never
}

async function complete(source: string, line: number, character: number): Promise<string[]> {
  const items = await dslCompletionItemProvider.provideCompletionItems(
    doc(source),
    new Position(line, character) as never,
    {} as never,
    {} as never,
  )
  if (!items) return []
  const list = Array.isArray(items) ? items : items.items
  return list.map((i) => String(i.label))
}

const SCORE = ['var global = init GLOBAL', 'var cb = init global.seq', ''].join('\n')

describe('補完 provider 本体 — メソッド候補 (#495)', () => {
  it('🔴 seq. の後に Sequence のメソッドが出る', async () => {
    const src = `${SCORE}cb.`
    const labels = await complete(src, 2, 3)
    expect(labels).toContain('play')
    expect(labels).toContain('instrument')
    // #617 で足したものが出ることを固定する（語彙に足したのに補完に出ない、を防ぐ）
    expect(labels).toContain('ui')
  })

  it('global. の後に Global のメソッドが出る', async () => {
    const src = `${SCORE}global.`
    const labels = await complete(src, 2, 7)
    expect(labels).toContain('tempo')
    expect(labels).toContain('sum')
    // Sequence 専用のものは出さない（候補源を取り違えていない）
    expect(labels).not.toContain('play')
  })

  it('sum("x"). の後に bus のメソッドが出る', async () => {
    const src = `${SCORE}sum("strings").`
    const labels = await complete(src, 2, 15)
    expect(labels.sort()).toEqual(['effect', 'ui'])
  })

  it('打ちかけの文字で絞り込む', async () => {
    const src = `${SCORE}cb.inst`
    const labels = await complete(src, 2, 7)
    expect(labels).toContain('instrument')
    expect(labels).not.toContain('play')
  })

  it('🔴 宣言されていない識別子には出さない（無関係な foo. を汚さない）', async () => {
    const src = `${SCORE}notDeclared.`
    expect(await complete(src, 2, 12)).toEqual([])
  })

  it('global 変数を Sequence と取り違えない', async () => {
    const src = `${SCORE}global.`
    const labels = await complete(src, 2, 7)
    expect(labels).not.toContain('audio')
  })

  it('慣例外の global 名でも Global の候補が出る', async () => {
    const src = ['var g = init GLOBAL', 'g.'].join('\n')
    const labels = await complete(src, 1, 2)
    expect(labels).toContain('tempo')
  })

  it('文字列の中では出さない（既存の面を壊さない）', async () => {
    const src = `${SCORE}cb.audio("takes/a.`
    expect(await complete(src, 2, 18)).toEqual([])
  })
})

describe('補完 provider — 既存の面を壊していない (#495)', () => {
  it('output(" では宣言済み sum 名が出る', async () => {
    const src = ['var global = init GLOBAL', 'global.sum("strings")', 'cb.output("'].join('\n')
    const labels = await complete(src, 2, 11)
    expect(labels).toContain('strings')
  })

  it('補完対象でない位置では undefined を返す', async () => {
    expect(await complete('var cb = init global.seq', 0, 3)).toEqual([])
  })
})

describe('補完プロバイダの登録内容 (#495)', () => {
  // 🔴 provider 本体が正しくても、**トリガー文字に `.` が無ければ打った時に出てこない**。
  // provider を直接呼ぶテストでは気づけない（変異検証で発見した穴）。
  it('DSL プロバイダが `.` をトリガーに登録されている', async () => {
    const vscodeMock = await import('../mocks/vscode')
    const ext = await import('../../packages/vscode-extension/src/extension')
    vscodeMock.resetRegisteredCompletionProviders()
    ext.registerCompletionProviders({ subscriptions: [] } as never)

    const dsl = vscodeMock.registeredCompletionProviders.find(
      (r) => r.provider === ext.dslCompletionItemProvider,
    )
    expect(dsl, 'DSL 補完プロバイダが登録されていない').toBeDefined()
    expect(dsl!.triggers).toContain('.')
    // 既存のトリガーも保つ（文字列系の面を壊さない）
    expect(dsl!.triggers).toContain('"')
    expect(dsl!.triggers).toContain('{')
  })
})
