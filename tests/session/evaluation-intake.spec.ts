/**
 * 評価の受付口（#997 の評価のかたち・`packages/session/src/eval/evaluation-intake.ts`）の単体テスト。
 *
 * 凍結版との差は `eval-intake-parity.spec.ts` が「違いの記録」として見る。ここで見るのは層 2 の約束:
 * 応答の形（設計 848 §5.3.1・診断の `range` は 1.1）・出自（`evalSource`）・ログの行が `log` の
 * どの `kind` に入るか（§5.3.6）・滞留の報告（#607）・想定外の失敗でキューが止まらないこと。
 * 束 S-eval（#1022）で段階 1 の足場から置き換えた時に、各テストの期待値を新しい意味論へ更新した。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createEvaluationIntake,
  QUEUE_STALL_REPORT_MS,
  splitIntoReplLines,
  type IntakeExecuteOptions,
  type IntakeLogLine,
} from '../../packages/session/src/eval/evaluation-intake'

import { fakeExecuteStatements } from './helpers/fake-execute-statements'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 実行された文 1 つ（`source` は文の文字列・残りは要求の options）。 */
type StatementCall = IntakeExecuteOptions

function harness(execute?: (call: StatementCall) => Promise<void> | void) {
  const calls: StatementCall[] = []
  const logs: IntakeLogLine[] = []
  const batches: string[] = []
  const intake = createEvaluationIntake({
    execute: fakeExecuteStatements(async (text, options) => {
      const call = { ...(options as IntakeExecuteOptions), source: text }
      calls.push(call)
      await execute?.(call)
    }) as never,
    log: (line) => logs.push(line),
    batch: { begin: () => batches.push('begin'), end: () => batches.push('end') },
  })
  return { intake, calls, logs, batches }
}

describe('evaluation intake — response shape (design 848 §5.3.1)', () => {
  it('returns ok:true with no diagnostics and echoes the documentDirectory it used', async () => {
    const { intake, calls } = harness()
    const outcome = await intake.evaluate({
      code: 'global.tempo(120)',
      documentDirectory: '/ws/piece',
      source: 'human',
    })
    expect(outcome).toEqual({ ok: true, diagnostics: [], documentDirectory: '/ws/piece' })
    expect(calls).toEqual([
      { source: 'global.tempo(120)', evalSource: 'human', documentDirectory: '/ws/piece' },
    ])
  })

  it('maps documentDirectory null to the empty string (clear the base) and echoes null', async () => {
    const { intake, calls } = harness()
    const outcome = await intake.evaluate({
      code: 'global.tempo(120)',
      documentDirectory: null,
      source: 'human',
    })
    expect(calls[0]!.documentDirectory).toBe('')
    expect(outcome.documentDirectory).toBeNull()
  })

  it('passes a documentDirectory with a line break through unchanged (no meta-line constraint)', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({
      code: 'global.tempo(1)',
      documentDirectory: '/ws/odd\nname',
      source: 'agent',
    })
    expect(calls[0]!.documentDirectory).toBe('/ws/odd\nname')
  })

  it('records who evaluated (the frozen REPL always passed human)', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({ code: 'global.tempo(1)', documentDirectory: null, source: 'agent' })
    await intake.evaluate({ code: 'global.tempo(2)', documentDirectory: null, source: 'human' })
    expect(calls.map((call) => call.evalSource)).toEqual(['agent', 'human'])
  })

  it('reports a parse error as kind=parse with ok:false and logs the frozen stderr line', async () => {
    const { intake, logs } = harness()
    const outcome = await intake.evaluate({
      code: 'global.play(([1, 5, 9]@v+10, 0))',
      documentDirectory: null,
      source: 'agent',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics).toEqual([
      {
        kind: 'parse',
        message: 'Expected RPAREN but got AT at line 1, column 23',
        // 1.1: 読めなかったトークンの位置（0 始まり・幅 0）
        range: { start: { line: 0, character: 22 }, end: { line: 0, character: 22 } },
      },
    ])
    expect(logs).toEqual([
      {
        kind: 'diagnostic',
        level: 'error',
        text: '[ERROR] Expected RPAREN but got AT at line 1, column 23',
      },
    ])
  })

  it('reports a runtime error as kind=runtime; the statements around it still run', async () => {
    const { intake, calls } = harness((options) => {
      if (options.source.startsWith('drum')) throw new Error('Variable not found: drum')
    })
    const outcome = await intake.evaluate({
      code: 'global.tempo(120)\ndrum.play(1)\nglobal.start()',
      documentDirectory: null,
      source: 'human',
    })
    expect(outcome.diagnostics).toEqual([
      {
        kind: 'runtime',
        message: 'Variable not found: drum',
        // 1.1: 失敗した文の範囲（2 行目の全体）
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } },
      },
    ])
    expect(calls.map((call) => call.source)).toEqual([
      'global.tempo(120)',
      'drum.play(1)',
      'global.start()',
    ])
  })

  it('opens one batch per request (the whole request is one unit · E-6)', async () => {
    const { intake, batches } = harness()
    await intake.evaluate({
      code: 'a.play(1)\nb.play(1)',
      documentDirectory: null,
      source: 'human',
    })
    await intake.evaluate({ code: 'c.play(1)', documentDirectory: null, source: 'human' })
    expect(batches).toEqual(['begin', 'end', 'begin', 'end'])
  })

  it('closes the batch even when a step fails in an unexpected way', async () => {
    const batches: string[] = []
    let throwOnce = true
    const intake = createEvaluationIntake({
      execute: async () => [],
      // 報告の口そのものが壊れる（パース・実行の try/catch の外へ抜ける想定外の失敗）。
      log: () => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('log sink crashed')
        }
      },
      batch: { begin: () => batches.push('begin'), end: () => batches.push('end') },
    })
    await expect(
      intake.evaluate({
        code: 'global.play(([1, 5, 9]@v+10, 0))',
        documentDirectory: null,
        source: 'human',
      }),
    ).rejects.toThrow('log sink crashed')
    // 段階 2: 構文エラーは実行の前に分かるので、バッチを開かない（E-2）。
    expect(batches).toEqual([])
  })

  it('closes the batch when the engine itself fails, and reports it as a runtime error without a range', async () => {
    const batches: string[] = []
    const intake = createEvaluationIntake({
      execute: async () => {
        throw new Error('engine exploded')
      },
      log: () => {},
      batch: { begin: () => batches.push('begin'), end: () => batches.push('end') },
    })
    await expect(
      intake.evaluate({ code: 'global.tempo(1)', documentDirectory: null, source: 'human' }),
    ).resolves.toEqual({
      ok: false,
      diagnostics: [{ kind: 'runtime', message: 'engine exploded' }],
      documentDirectory: null,
    })
    expect(batches).toEqual(['begin', 'end'])
  })

  it('keeps the queue alive even if reporting the unexpected failure also throws', async () => {
    const intake = createEvaluationIntake({
      execute: async () => [],
      log: () => {
        throw new Error('log sink is down')
      },
      batch: { begin: () => {}, end: () => {} },
    })
    await expect(
      intake.evaluate({
        code: 'global.play(([1, 5, 9]@v+10, 0))',
        documentDirectory: null,
        source: 'human',
      }),
    ).rejects.toThrow('log sink is down')
    // 後ろの評価は何も報告しない入力なので、壊れた口に触れずに通る。
    await expect(
      intake.evaluate({ code: 'global.tempo(1)', documentDirectory: null, source: 'human' }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('evaluation intake — the queue (#476 / #607)', () => {
  it('runs requests in arrival order even when an earlier one is slow', async () => {
    const order: string[] = []
    const { intake } = harness(async (options) => {
      if (options.source === 'slow.play(1)') await new Promise((r) => setTimeout(r, 30))
      order.push(options.source)
    })
    const first = intake.evaluate({
      code: 'slow.play(1)',
      documentDirectory: null,
      source: 'human',
    })
    const second = intake.evaluate({
      code: 'fast.play(1)',
      documentDirectory: null,
      source: 'agent',
    })
    await Promise.all([first, second])
    expect(order).toEqual(['slow.play(1)', 'fast.play(1)'])
  })

  it('keeps accepting requests after an unexpected failure and leaves a trace', async () => {
    let calls = 0
    const logs: IntakeLogLine[] = []
    const intake = createEvaluationIntake({
      execute: async () => [],
      log: (line) => logs.push(line),
      batch: {
        begin: () => {
          calls++
          if (calls === 1) throw new Error('batch exploded')
        },
        end: () => {},
      },
    })
    await expect(
      intake.evaluate({ code: 'a.play(1)', documentDirectory: null, source: 'human' }),
    ).rejects.toThrow('batch exploded')
    await expect(
      intake.evaluate({ code: 'b.play(1)', documentDirectory: null, source: 'human' }),
    ).resolves.toMatchObject({ ok: true })
    expect(logs).toContainEqual({
      kind: 'session',
      level: 'error',
      text: '[ERROR] unexpected evaluation queue failure: batch exploded',
    })
  })

  it('reports a blocked step as kind=stall, repeatedly, naming the line and what waits behind it', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const { intake, logs } = harness(async (options) => {
      if (options.source === 'global.start()') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    const blocked = intake.evaluate({
      code: 'global.start()\nglobal.tempo(120)',
      documentDirectory: null,
      source: 'human',
    })
    const behind = intake.evaluate({
      code: 'drum.play(1)',
      documentDirectory: null,
      source: 'agent',
    })

    await vi.advanceTimersByTimeAsync(QUEUE_STALL_REPORT_MS + 1_000)
    const stalls = logs.filter((line) => line.kind === 'stall')
    expect(stalls).toHaveLength(1)
    expect(stalls[0]!.level).toBe('error')
    // 段階 2: 実行中の文を名指しする。待っているのは後ろの要求 1 つ（同じ要求の残りの文は数えない）
    expect(stalls[0]!.text).toContain(
      'evaluation queue is still blocked after 60s by: global.start()',
    )
    expect(stalls[0]!.text).toContain('— 1 request(s) are waiting behind it')

    await vi.advanceTimersByTimeAsync(QUEUE_STALL_REPORT_MS)
    expect(logs.filter((line) => line.kind === 'stall')).toHaveLength(2)

    release()
    await expect(blocked).resolves.toMatchObject({ ok: true })
    await expect(behind).resolves.toMatchObject({ ok: true })
    // 終わった後は鳴らない
    const before = logs.length
    await vi.advanceTimersByTimeAsync(QUEUE_STALL_REPORT_MS * 2)
    expect(logs).toHaveLength(before)
  })
})

describe('splitIntoReplLines — the LSP / readline line rule (range lines are counted this way)', () => {
  it.each([
    ['a', ['a']],
    ['a\n', ['a', '']],
    ['', ['']],
    ['a\r\nb', ['a', 'b']],
    ['a\rb\r', ['a', 'b']],
    ['a\n\nb', ['a', '', 'b']],
  ])('%j → %j', (code, lines) => {
    expect(splitIntoReplLines(code)).toEqual(lines)
  })
})
