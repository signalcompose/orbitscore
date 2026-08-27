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

  it('global. の後に Global の語彙を補う（既存 provider が返す分は除く）', async () => {
    // 🔴 この provider は**既存 provider が返さなかった語彙だけ**を補う。
    // `tempo` / `sum` は既存がスニペット付きで返すのでここには現れない（二重表示の防止）。
    // 現れるのは既存の手書き表に無いもの＝語彙テーブルにしか無いもの。
    const src = `${SCORE}global.`
    const labels = await complete(src, 2, 7)
    expect(labels).not.toContain('tempo') // 既存が返す
    expect(labels).not.toContain('sum') // 既存が返す
    expect(labels).toContain('key') // 語彙にあるが既存の手書き表に無い
    expect(labels).toContain('midiLatency')
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

  it('慣例外の global 名でも Global として解決される', async () => {
    // 🔴 既存 provider は `linePrefix.includes('global.')` で global 判定するので、
    // `g.` には Global 候補を返さない（Sequence 側を返す）。一方こちらは**宣言**を見るので
    // 正しく Global と判定する。
    //
    // ただし二重表示の除外はこちらの判定（receiver === 'global'）で行うため、
    // 既存の Global 候補は除かれる。ここで確認するのは
    // **「Global として解決され、Global 固有の語彙が出ること」**。
    const src = ['var g = init GLOBAL', 'g.'].join('\n')
    const labels = await complete(src, 1, 2)
    expect(labels).toContain('key') // Global の語彙
    expect(labels).toContain('midiLatency')
    expect(labels).not.toContain('play') // Sequence と取り違えていない
  })

  it('文字列の中では出さない（既存の面を壊さない）', async () => {
    const src = `${SCORE}cb.audio("takes/a.`
    expect(await complete(src, 2, 18)).toEqual([])
  })
})

describe('🔴 既存 provider との二重表示を出さない (#495)', () => {
  it('既存が返す label はこちらから出さない', async () => {
    const { analyzeMethodChain, getContextualCompletions } = await import(
      '../../packages/vscode-extension/src/completion-context'
    )
    const src = `${SCORE}global.`
    const old = new Set(
      getContextualCompletions(analyzeMethodChain('global.', 7), true).map((i) => String(i.label)),
    )
    const mine = await complete(src, 2, 7)
    const overlap = mine.filter((label) => old.has(label))
    expect(overlap, `二重に出る候補: ${overlap.join(',')}`).toEqual([])
  })

  it('🔴 "global" で終わる変数名でも二重表示しない（F5）', async () => {
    // 旧 provider は `linePrefix.includes('global.')` という**部分一致**で global 判定する。
    // `myglobal.` はこれにマッチするので Global 候補17件を返す。こちらが宣言ベースの
    // 判定（sequence）で除外集合を作ると**全部二重表示**になる（実測で確認した）。
    // 除外は必ず**相手と同じ規則**で計算すること。
    const { analyzeMethodChain, getContextualCompletions } = await import(
      '../../packages/vscode-extension/src/completion-context'
    )
    const src = ['var global = init GLOBAL', 'var myglobal = init global.seq', 'myglobal.'].join(
      '\n',
    )
    const old = new Set(
      getContextualCompletions(analyzeMethodChain('myglobal.', 9), true).map((i) =>
        String(i.label),
      ),
    )
    const mine = await complete(src, 2, 9)
    const overlap = mine.filter((label) => old.has(label))
    expect(overlap, `二重に出る候補: ${overlap.join(',')}`).toEqual([])
  })

  it('それでも語彙にしか無いものは補われる（黙って何も出さない、にならない）', async () => {
    const src = `${SCORE}cb.`
    const labels = await complete(src, 2, 3)
    // #617 で足した ui は既存の手書き表に無いので、こちらが出す
    expect(labels).toContain('ui')
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
