/**
 * #607: 構文エラーを「複数行入力の途中」と誤判定して silent に永久停止しない。
 *
 * 旧判定は `Expected RPAREN` を文字列一致で「未完」に含めていた。このメッセージは
 * `Expected RPAREN but got AT`（行の**途中**に不正トークンがある本物の構文エラー）でも
 * 出るため、構文エラーの evaluate が silent に保留され、**以後の全入力が未完バッファへ
 * 合体してセッション全体が沈黙のまま永久停止**した。
 *
 * 実機での事故（2026-08-01）: `[1,5,9]@v+10`（パーサ未対応のスタック @v）を含む
 * 40KB の楽譜を run_selection したところ、途中の宣言までは実行されるが以後が全て沈黙し、
 * `ok` を返しながら RUN も後続評価も実行されなかった。特定には CDP でのヒープ調査まで
 * 要した — このテストはその全経路を数ミリ秒で赤くする。
 *
 * 判定の原則: **「未完」= パーサが入力の終端（EOF）に達した場合だけ。**
 * トークンが残っているのに不正なら、待っても文は完結しない。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'

afterEach(() => {
  vi.restoreAllMocks()
})

function harness() {
  const executed: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message))
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const interpreter = {
    execute: async (_ir: unknown, options: { source?: string }) => {
      executed.push(options.source ?? '')
    },
  } as never
  const session = createReplSession(interpreter)
  return { session, executed, errors }
}

describe('createReplSession — syntax error vs incomplete input (#607)', () => {
  it('reports a mid-line syntax error immediately instead of buffering forever', async () => {
    const { session, executed, errors } = harness()

    // スタック全体への @v はパーサ未対応 → `Expected RPAREN but got AT`（EOF ではない）。
    session.pushLine('global.play(([1, 5, 9]@v+10, 0))')
    await session.idle()

    const reported = errors.filter((line) => line.startsWith('[ERROR]'))
    expect(
      reported.length,
      `構文エラーが即座に報告されていない (errors: ${JSON.stringify(errors)})`,
    ).toBeGreaterThan(0)
    expect(reported[0]).toContain('AT')

    // 🔴 事故の本体: エラーの**後の入力が実行されること**。バッファに合体して
    // 死んでいたら、この行も沈黙する。
    session.pushLine('global.tempo(120)')
    await session.idle()
    expect(executed, 'エラー後の行が実行されていない — バッファが死んでいる').toEqual([
      'global.tempo(120)',
    ])
  })

  it('still buffers genuinely incomplete multi-line input until it completes', async () => {
    const { session, executed, errors } = harness()

    // 開き括弧のまま行が終わる = パーサは EOF に達する = 本物の「未完」。
    session.pushLine('global.play((1, 2,')
    await session.idle()
    expect(errors.filter((line) => line.startsWith('[ERROR]'))).toEqual([])
    expect(executed).toEqual([])

    // 続き行で完結 → 全体が 1 回だけ実行される。
    session.pushLine('3))')
    await session.idle()
    expect(executed).toEqual(['global.play((1, 2,\n3))'])
    expect(errors.filter((line) => line.startsWith('[ERROR]'))).toEqual([])
  })

  it('names the offending token for an unexpected token after an argument', async () => {
    const { session, executed, errors } = harness()

    // `Expected comma or closing parenthesis` 経路（parse-statement:840）。旧文言は
    // トークン名が無く EOF と区別できなかった — got <TOKEN> を含むことを固定する。
    session.pushLine('global.play((1) 2)')
    await session.idle()

    const reported = errors.find((line) => line.includes('Expected comma or closing parenthesis'))
    expect(reported, `該当エラーが出ていない (errors: ${JSON.stringify(errors)})`).toBeDefined()
    expect(reported).toMatch(/but got \w+/)

    session.pushLine('global.tempo(90)')
    await session.idle()
    expect(executed).toEqual(['global.tempo(90)'])
  })
})
