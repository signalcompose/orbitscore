/**
 * 評価の受付口（段階 1 の足場・`packages/session/src/eval/evaluation-intake.ts`）の単体テスト。
 *
 * 凍結版との一致は `eval-intake-parity.spec.ts` が見る。ここで見るのは、凍結版と比べられない
 * 層 2 固有の約束: 応答の形（設計 848 §5.3.1）・出自（`evalSource`）・stderr の行が `log` の
 * どの `kind` に入るか（§5.3.6）・滞留の報告（#607）・想定外の失敗でキューが止まらないこと。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AudioIR } from '../../packages/engine/src/parser/audio-parser'
import {
  createEvaluationIntake,
  QUEUE_STALL_REPORT_MS,
  splitIntoReplLines,
  type IntakeExecuteOptions,
  type IntakeLogLine,
} from '../../packages/session/src/eval/evaluation-intake'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(execute?: (options: IntakeExecuteOptions) => Promise<void> | void) {
  const calls: IntakeExecuteOptions[] = []
  const logs: IntakeLogLine[] = []
  const batches: string[] = []
  const intake = createEvaluationIntake({
    execute: async (_ir: AudioIR, options) => {
      calls.push(options)
      await execute?.(options)
    },
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
      {
        source: '//#documentDirectory /ws/piece',
        evalSource: 'human',
        documentDirectory: '/ws/piece',
      },
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
    expect(calls.map((call) => call.documentDirectory)).toEqual(['', ''])
    expect(calls[0]!.source).toBe('//#documentDirectory')
    expect(outcome.documentDirectory).toBeNull()
  })

  it('passes a documentDirectory with a line break through unchanged (no meta-line constraint)', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({
      code: 'global.tempo(1)',
      documentDirectory: '/ws/odd\nname',
      source: 'agent',
    })
    expect(calls.map((call) => call.documentDirectory)).toEqual(['/ws/odd\nname', '/ws/odd\nname'])
  })

  it('records who evaluated (the frozen REPL always passed human)', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({ code: 'global.tempo(1)', documentDirectory: null, source: 'agent' })
    await intake.evaluate({ code: 'global.tempo(2)', documentDirectory: null, source: 'human' })
    expect(calls.map((call) => call.evalSource)).toEqual(['agent', 'agent', 'human', 'human'])
  })

  it('sets or clears the document base at the head of every request, even without executable code', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({ code: 'global.tempo(1)', documentDirectory: '/ws/a', source: 'human' })
    await intake.evaluate({ code: 'global.play((@', documentDirectory: '/ws/b', source: 'human' })
    await intake.evaluate({ code: '', documentDirectory: null, source: 'human' })

    expect(
      calls
        .filter((call) => call.source.startsWith('//#documentDirectory'))
        .map((call) => [call.source, call.documentDirectory]),
    ).toEqual([
      ['//#documentDirectory /ws/a', '/ws/a'],
      ['//#documentDirectory /ws/b', '/ws/b'],
      ['//#documentDirectory', ''],
    ])
  })

  it('does not trim or otherwise rewrite an absolute documentDirectory', async () => {
    const { intake, calls } = harness()
    await intake.evaluate({
      code: '',
      documentDirectory: '/ws/ piece ',
      source: 'human',
    })
    expect(calls[0]).toMatchObject({
      source: '//#documentDirectory /ws/ piece ',
      documentDirectory: '/ws/ piece ',
    })
  })

  it.each([
    [{ code: 42, documentDirectory: null, source: 'human' }, 'code must be a string'],
    [{ documentDirectory: null, source: 'human' }, 'code must be a string'],
    [{ code: 'global.start()', source: 'human' }, 'documentDirectory must be'],
    [
      { code: 'global.start()', documentDirectory: 42, source: 'human' },
      'documentDirectory must be',
    ],
    [
      { code: 'global.start()', documentDirectory: 'relative/piece', source: 'human' },
      'documentDirectory must be',
    ],
    [
      { code: 'global.start()', documentDirectory: '', source: 'human' },
      'documentDirectory must be',
    ],
  ])('rejects an invalid request before it reaches the queue: %j', async (request, message) => {
    const { intake, calls, batches } = harness()
    await expect(intake.evaluate(request as never)).rejects.toThrow(TypeError)
    await expect(intake.evaluate(request as never)).rejects.toThrow(message)
    expect(calls).toEqual([])
    expect(batches).toEqual([])
  })

  it('reports a parse error as kind=parse with ok:false and logs the frozen stderr line', async () => {
    const { intake, logs } = harness()
    const outcome = await intake.evaluate({
      code: 'global.play(([1, 5, 9]@v+10, 0))',
      documentDirectory: null,
      source: 'agent',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics).toHaveLength(1)
    expect(outcome.diagnostics[0]).toMatchObject({ kind: 'parse' })
    expect(outcome.diagnostics[0]!.message).toMatch(/Expected RPAREN.*AT/)
    expect(logs).toEqual([
      { kind: 'diagnostic', level: 'error', text: `[ERROR] ${outcome.diagnostics[0]!.message}` },
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
    expect(outcome.diagnostics).toEqual([{ kind: 'runtime', message: 'Variable not found: drum' }])
    expect(calls.map((call) => call.source)).toEqual([
      '//#documentDirectory',
      'global.tempo(120)',
      'drum.play(1)',
      'global.start()',
    ])
  })

  it('opens one batch per request and closes it before the end-of-request flush', async () => {
    const { intake, batches } = harness()
    await intake.evaluate({
      code: 'a.play(1)\nb.play(1)',
      documentDirectory: null,
      source: 'human',
    })
    await intake.evaluate({ code: 'c.play(1)', documentDirectory: null, source: 'human' })
    expect(batches).toEqual(['begin', 'end', 'begin', 'end'])
  })

  it('returns diagnostics and runs later lines when the log sink throws', async () => {
    const batches: string[] = []
    const calls: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const intake = createEvaluationIntake({
      execute: async (_ir, options) => {
        calls.push(options.source)
        if (options.source === 'a.play(1)') throw new Error('audio failed')
      },
      log: () => {
        throw new Error('sink EPIPE')
      },
      batch: { begin: () => batches.push('begin'), end: () => batches.push('end') },
    })
    const outcome = await intake.evaluate({
      code: 'a.play(1)\nb.play(1)\nc.play(1)',
      documentDirectory: null,
      source: 'human',
    })
    expect(outcome).toMatchObject({
      ok: false,
      diagnostics: [{ kind: 'runtime', message: 'audio failed' }],
    })
    expect(calls).toEqual(['//#documentDirectory', 'a.play(1)', 'b.play(1)', 'c.play(1)'])
    expect(batches).toEqual(['begin', 'end'])
    expect(stderr).toHaveBeenCalledWith('[ERROR] evaluation intake log sink failed: sink EPIPE\n')
  })

  it('keeps the queue alive even if the diagnostic log sink stays down', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const intake = createEvaluationIntake({
      execute: async () => {},
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
    ).resolves.toMatchObject({ ok: false })
    await expect(
      intake.evaluate({ code: 'global.tempo(1)', documentDirectory: null, source: 'human' }),
    ).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['a string', 'thrown text'],
    ['a plain object', { why: 'broken' }],
    ['null', null],
  ])('turns %s thrown by execute into a runtime diagnostic', async (_label, thrown) => {
    const { intake } = harness((options) => {
      if (!options.source.startsWith('//#')) throw thrown
    })
    const outcome = await intake.evaluate({
      code: 'global.start()',
      documentDirectory: null,
      source: 'human',
    })
    expect(outcome.diagnostics).toEqual([{ kind: 'runtime', message: String(thrown) }])
  })

  it.each([
    ['a string', 'parse text'],
    ['a plain object', { why: 'parse failed' }],
    ['null', null],
  ])('turns %s thrown by the parser into a parse diagnostic', async (_label, thrown) => {
    const intake = createEvaluationIntake({
      execute: async () => {},
      log: () => {},
      parse: () => {
        throw thrown
      },
    })
    const outcome = await intake.evaluate({
      code: 'anything',
      documentDirectory: null,
      source: 'human',
    })
    expect(outcome.diagnostics).toEqual([{ kind: 'parse', message: String(thrown) }])
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
    expect(order.filter((source) => !source.startsWith('//#'))).toEqual([
      'slow.play(1)',
      'fast.play(1)',
    ])
  })

  it('continues the same request after an unexpected line failure and leaves a trace', async () => {
    let calls = 0
    const logs: IntakeLogLine[] = []
    const executed: string[] = []
    const intake = createEvaluationIntake({
      execute: async (_ir, options) => executed.push(options.source),
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
      intake.evaluate({
        code: 'a.play(1)\nb.play(1)',
        documentDirectory: null,
        source: 'human',
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      intake.evaluate({ code: 'c.play(1)', documentDirectory: null, source: 'human' }),
    ).resolves.toMatchObject({ ok: true })
    expect(executed.filter((source) => !source.startsWith('//#'))).toEqual([
      'a.play(1)',
      'b.play(1)',
      'c.play(1)',
    ])
    expect(logs).toContainEqual({
      kind: 'session',
      level: 'error',
      text: '[ERROR] unexpected REPL queue failure: batch exploded',
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
    expect(stalls[0]!.text).toContain('REPL queue is still blocked after 60s by: global.start()')
    // 待っているのは、同じ要求の残り + evalEnd / evalMark と、後ろの要求の
    // evalBegin / documentDirectory / code / evalEnd / evalMark（凍結版と同じくメタ行込み）。
    expect(stalls[0]!.text).toContain('— 8 line(s) are waiting behind it')

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

  it('does not let a throwing log sink escape from the stall timer', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const intake = createEvaluationIntake({
      execute: async (_ir, options) => {
        if (options.source === 'global.start()') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      },
      log: () => {
        throw new Error('timer sink failed')
      },
      stallReportMs: 10,
    })
    const pending = intake.evaluate({
      code: 'global.start()',
      documentDirectory: null,
      source: 'human',
    })
    await vi.advanceTimersByTimeAsync(11)
    expect(stderr).toHaveBeenCalledWith(
      '[ERROR] evaluation intake log sink failed: timer sink failed\n',
    )
    release()
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('removes not-started steps from the wait count when a request fails before its first line', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const logs: IntakeLogLine[] = []
    const intake = createEvaluationIntake({
      execute: async (_ir, options) => {
        if (options.source === 'blocked.play(1)') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      },
      log: (line) => logs.push(line),
      stallReportMs: 10,
    })
    const broken = {
      code: 'never.play(1)',
      documentDirectory: null,
      get source(): never {
        throw new Error('source getter failed')
      },
    }
    const rejected = intake.evaluate(broken)
    const blocked = intake.evaluate({
      code: 'blocked.play(1)',
      documentDirectory: null,
      source: 'human',
    })
    await expect(rejected).rejects.toThrow('source getter failed')
    await vi.advanceTimersByTimeAsync(11)
    const stall = logs.find((line) => line.kind === 'stall')
    // この要求自身の evalEnd と evalMark だけ。前の要求の 5 段を引きずらない。
    expect(stall?.text).toContain('— 2 line(s) are waiting behind it')
    release()
    await expect(blocked).resolves.toMatchObject({ ok: true })
  })
})

describe('splitIntoReplLines — the frozen readline line rule', () => {
  it.each([
    ['a', ['a']],
    ['a\n', ['a', '']],
    ['', ['']],
    ['a\r\nb', ['a', 'b']],
    ['a\rb\r', ['a', 'b']],
    ['a\n\nb', ['a', '', 'b']],
    ['// note\u2028global.tempo(120)', ['// note', 'global.tempo(120)']],
    ['// note\u2029global.tempo(120)', ['// note', 'global.tempo(120)']],
  ])('%j → %j', (code, lines) => {
    expect(splitIntoReplLines(code)).toEqual(lines)
  })
})
