/**
 * `InterpreterV2.executeStatements`（OrbitStudio の層 2 の評価の入口・spec「評価の単位」E-3〜E-6・
 * #997 / #1022）。`execute()`（1 つの IR）との違いを確かめる: 宣言を前へ寄せない / 実行時エラーは
 * その文だけ / import の失敗は残りを止める / `.orbslog` の記録は 1 件 / hooks は文の直前と失敗の時。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'
import {
  parseAudioDSL,
  parseAudioDSLWithSpans,
} from '../../packages/engine/src/parser/audio-parser'

let interpreter: InterpreterV2
let dir: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-execstmts-'))
  interpreter = new InterpreterV2()
  const audioEngine = interpreter.audioEngine as any
  audioEngine.boot = vi.fn().mockResolvedValue(undefined)
  audioEngine.getCurrentTime = vi.fn().mockReturnValue(0)
  audioEngine.scheduleEvent = vi.fn()
  audioEngine.scheduleSliceEvent = vi.fn()
  audioEngine.getMasterGainDb = vi.fn().mockReturnValue(0)
  await interpreter.boot()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const run = (source: string, options: Parameters<InterpreterV2['executeStatements']>[1] = {}) =>
  interpreter.executeStatements(parseAudioDSLWithSpans(source), options)

describe('executeStatements — source order, failures, imports (E-3 / E-4 / E-5)', () => {
  it('runs in source order: a use before its declaration fails, unlike execute() which hoists', async () => {
    const source = [
      'var global = init GLOBAL',
      'kick.length(2)',
      'var kick = init global.seq',
    ].join('\n')
    const failures = await run(source)
    expect(failures.map((failure) => failure.index)).toEqual([1])
    expect(interpreter.getState().sequences.kick).toBeDefined()

    const hoisted = new InterpreterV2({ audioEngine: interpreter.audioEngine })
    await expect(hoisted.execute(parseAudioDSL(source))).resolves.toBeUndefined()
  })

  it('a runtime failure fails only that statement; the following statements still run', async () => {
    const failures = await run(
      ['var global = init GLOBAL', 'boom.length(2)', 'global.tempo(133)'].join('\n'),
    )
    expect(failures).toEqual([{ index: 1, message: expect.stringContaining('boom') }])
    expect(interpreter.getState().globals.global.tempo).toBe(133)
  })

  it('runs every init GLOBAL in order (execute() keeps only the last one)', async () => {
    await run(['var g = init GLOBAL', 'var h = init GLOBAL'].join('\n'))
    expect(Object.keys(interpreter.getState().globals).sort()).toEqual(['g', 'h'])
  })

  it('an import failure stops the rest of the request', async () => {
    const failures = await run(
      ['import { a } from "./missing.orbs"', 'var global = init GLOBAL'].join('\n'),
      { documentDirectory: dir },
    )
    expect(failures).toEqual([{ index: 0, message: expect.stringContaining('file not found') }])
    expect(interpreter.getState().globals).toEqual({})
  })

  it('evaluates a working import before the request’s own statements', async () => {
    fs.writeFileSync(
      path.join(dir, 'parts.orbs'),
      'var global = init GLOBAL\nvar kick = init global.seq\n',
    )
    const failures = await run(
      ['import { kick } from "./parts.orbs"', 'kick.length(3)'].join('\n'),
      { documentDirectory: dir },
    )
    expect(failures).toEqual([])
    expect(interpreter.getState().sequences.kick).toBeDefined()
  })
})

describe('executeStatements — one record and the hooks (E-6)', () => {
  it('records the request once with its whole code', async () => {
    interpreter.enableSessionLog({ cwd: dir })
    const writer = (interpreter as any).state.sessionLog
    const recordEval = vi.spyOn(writer, 'recordEval')
    const source = ['var global = init GLOBAL', 'global.tempo(120)', 'global.beat(4 by 4)'].join(
      '\n',
    )
    await run(source, { source, evalSource: 'agent' })
    expect(recordEval).toHaveBeenCalledTimes(1)
    expect(recordEval).toHaveBeenCalledWith(
      expect.objectContaining({ code: source, evalSource: 'agent' }),
    )
  })

  it('calls onStatement before each statement and onFailure at the failure, in order', async () => {
    const events: string[] = []
    await interpreter.executeStatements(
      parseAudioDSLWithSpans(
        ['var global = init GLOBAL', 'boom.length(2)', 'global.tempo(90)'].join('\n'),
      ),
      {},
      {
        onStatement: (index) => events.push(`statement ${index}`),
        onFailure: (index) => events.push(`failure ${index}`),
      },
    )
    expect(events).toEqual(['statement 0', 'statement 1', 'failure 1', 'statement 2'])
  })
})
