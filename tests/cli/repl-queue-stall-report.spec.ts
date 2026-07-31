/**
 * #607: 詰まった REPL キューを**沈黙させない**。
 *
 * `pushLine` は全行を単一の promise チェーンへ載せる（#476 の FIFO 直列化）。
 * その設計は正しいが、**1 行が resolve しないと以後の入力が永久に待たされる**副作用がある。
 * `pushLine` は `void` を返すので、呼び出し元（MCP の `evaluate_orbitscore` 等）には
 * 成功に見え、**`ok` が返るのに何も実行されない**という最悪の見え方になる。
 *
 * 2026-08-01 に実機で発生: Kontakt を 6 声宣言したところ instrument のロードが 1 件
 * 未解決のまま残り、以後の `global.start()` / RUN がすべて「ok」を返しながら実行されず、
 * capture は無音のままだった。原因の特定に数時間かかった直接の理由が**この沈黙**である。
 *
 * 打ち切り（タイムアウト）ではなく報告に留める理由: instrument 6 本の attach は実測で
 * 30 秒を超えるので、正当な長時間処理を殺してはいけない。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'

/** 実装の報告間隔（`QUEUE_STALL_REPORT_MS`）より確実に長い待ち時間。 */
const PAST_FIRST_REPORT_MS = 61_000

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * 指定した行だけが**永久に resolve しない** interpreter。
 * 返す `release` を呼ぶまでチェーンは進まない（テスト終了時に必ず呼ぶ）。
 */
function blockingInterpreter(blockOn: string) {
  let release: () => void = () => {}
  const executed: string[] = []
  const interpreter = {
    execute: async (_ir: unknown, options: { source?: string }) => {
      const code = options.source ?? ''
      if (code.includes(blockOn)) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      executed.push(code)
    },
  } as never
  return { interpreter, executed, release: () => release() }
}

describe('createReplSession — blocked queue reporting (#607)', () => {
  it('names the blocking line and how many lines are stuck behind it', async () => {
    vi.useFakeTimers()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message))
    })

    const { interpreter, executed, release } = blockingInterpreter('global.start')
    const session = createReplSession(interpreter)

    session.pushLine('global.start()')
    // チェーンを 1 段進めて「実行中」に入らせる。
    await vi.advanceTimersByTimeAsync(0)
    session.pushLine('global.tempo(120)')
    session.pushLine('drums.play()')

    // ここまでは静か — 正当な長時間処理を鳴らさないため。
    expect(errors, '報告間隔より前に鳴ってはいけない').toEqual([])

    await vi.advanceTimersByTimeAsync(PAST_FIRST_REPORT_MS)

    const report = errors.find((line) => line.includes('REPL queue is still blocked'))
    expect(report, `詰まりが報告されていない (errors: ${JSON.stringify(errors)})`).toBeDefined()
    // 🔴 「何かが詰まった」だけでは診断にならない。**どの行が**塞いでいるかを名指しすること。
    expect(report).toContain('global.start()')
    // 🔴 **背後に何行待っているか**も必須。1 行だけ遅いのか、セッション全体が死んでいるのかが分かる。
    expect(report).toContain('2 line(s) are waiting')
    // 受理と実行が別であることを明示していること（`ok` の見え方が誤解を生んだ原因）。
    expect(report).toContain('NOT executed')

    // 詰まっているあいだ、後続行は本当に 1 行も実行されていない（報告が事実であることの裏取り）。
    expect(executed).toEqual([])

    release()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('stays silent for a slow line that still finishes within the report interval', async () => {
    vi.useFakeTimers()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message))
    })

    // 🔴 「一瞬で終わる行」で無音を確かめても意味がない — 閾値を 1ms に縮める変異が
    //    生き残る。instrument 6 本の attach（実測 30 秒超）を模した**遅いが正当な行**で
    //    押さえる。閾値がこれより短くなったら誤報として検出される。
    const SLOW_BUT_LEGITIMATE_MS = 30_000
    const executed: string[] = []
    const interpreter = {
      execute: async (_ir: unknown, options: { source?: string }) => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_BUT_LEGITIMATE_MS))
        executed.push(options.source ?? '')
      },
    } as never
    const session = createReplSession(interpreter)

    session.pushLine('global.tempo(120)')
    await vi.advanceTimersByTimeAsync(PAST_FIRST_REPORT_MS)

    expect(executed, '遅い行は最終的に実行されること').toEqual(['global.tempo(120)'])
    expect(
      errors.filter((line) => line.includes('REPL queue is still blocked')),
      '閾値内に終わる正当な長時間処理を詰まりと報告してはいけない（誤報は沈黙と同じくらい有害）',
    ).toEqual([])
  })
})
