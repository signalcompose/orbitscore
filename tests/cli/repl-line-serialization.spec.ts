/**
 * #476: REPL 行処理の FIFO 直列化。
 *
 * 旧実装は readline の同 tick 連続 'line' イベントを直列化せず、遅い execute
 * （plugin ロード等）中に共有 buffer が伸びて「累積 buffer の重複実行・行の消失」を
 * 起こした（実機 E2E で発見）。本テストは「遅い execute を挟んでも全行が 1 回ずつ・
 * 順序どおり実行される」ことをピン留めする。
 */

import { describe, it, expect } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'

function mockInterpreter(delayMsFor: (code: string) => number) {
  const executed: string[] = []
  return {
    executed,
    interpreter: {
      execute: async (_ir: unknown, options: { source?: string }) => {
        const code = options.source ?? ''
        const delay = delayMsFor(code)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        executed.push(code)
      },
    } as any,
  }
}

describe('createReplSession — line serialization (#476)', () => {
  it('executes every line exactly once, in order, even with a slow statement in the middle', async () => {
    // 3 行目（sum の effect 相当）だけ遅い — 旧実装ではこの間に後続行が buffer に積まれ
    // 重複実行・消失が起きた
    const { interpreter, executed } = mockInterpreter((code) =>
      code.includes('global.start') ? 80 : 0,
    )
    const session = createReplSession(interpreter)
    const lines = [
      'var global = init GLOBAL',
      'global.tempo(120)',
      'global.start()',
      'var kick = init global.seq',
      'RUN(kick)',
    ]
    // readline の同 tick 連発を再現: 同期的に全行 push
    for (const l of lines) session.pushLine(l)
    await session.idle()

    expect(executed).toEqual(lines)
  })

  it('an execute failure on one line does not lose the following lines', async () => {
    const { interpreter, executed } = mockInterpreter(() => 0)
    const failing = interpreter as any
    const orig = failing.execute
    failing.execute = async (ir: unknown, options: { source?: string }) => {
      if ((options.source ?? '').includes('BOOM')) throw new Error('boom')
      return orig(ir, options)
    }
    const session = createReplSession(interpreter)
    session.pushLine('var global = init GLOBAL')
    session.pushLine('RUN(BOOM)')
    session.pushLine('global.tempo(120)')
    await session.idle()
    expect(executed).toEqual(['var global = init GLOBAL', 'global.tempo(120)'])
  })

  it('keeps buffering an incomplete multi-line statement and executes it once complete', async () => {
    const { interpreter, executed } = mockInterpreter(() => 0)
    const session = createReplSession(interpreter)
    // 括弧が閉じるまで parse は incomplete → buffering、閉じた時点で全体を 1 回実行
    session.pushLine('RUN(kick,')
    session.pushLine('snare)')
    await session.idle()
    expect(executed).toEqual(['RUN(kick,\nsnare)'])
  })
})
