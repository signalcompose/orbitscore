/**
 * engine の出力の口 `host`（`packages/engine/src/audio/engine-backend.ts`・設計 848 台帳 P-07・#1022）。
 *
 * 約束: 既定は console と同じ（凍結版の REPL・`orbitscore play` が書く行は変わらない。step は
 * `[STEP] <seq> <argPath> <atEpochMs>` の 1 行）/ 呼んだその時に `console.*` を引く（spy が効く）/
 * `setHostOutput` で差し込んだ口へ回り、`null` で既定に戻る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { host, setHostOutput } from '../../packages/engine/src/audio/engine-backend'

afterEach(() => {
  setHostOutput(null)
  vi.restoreAllMocks()
})

describe('the engine host output', () => {
  it('writes to console by default, with the same arguments', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    host.log('a %s', 'b', { x: 1 })
    host.warn('w')
    host.error('e')
    host.step({ seq: 'kick', argPath: '0.1', atEpochMs: 1700000000000 })
    expect(log.mock.calls).toEqual([['a %s', 'b', { x: 1 }], ['[STEP] kick 0.1 1700000000000']])
    expect(warn.mock.calls).toEqual([['w']])
    expect(error.mock.calls).toEqual([['e']])
  })

  it('routes to the output a host sets, and back to console with null', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen: string[] = []
    setHostOutput({
      log: (...args) => seen.push(`log ${args.join(' ')}`),
      warn: (...args) => seen.push(`warn ${args.join(' ')}`),
      error: (...args) => seen.push(`error ${args.join(' ')}`),
      step: (event) => seen.push(`step ${event.seq} ${event.argPath} ${event.atEpochMs}`),
    })
    host.log('x')
    host.warn('y')
    host.error('z')
    host.step({ seq: 'hh', argPath: '2', atEpochMs: 7 })
    expect(seen).toEqual(['log x', 'warn y', 'error z', 'step hh 2 7'])
    expect(log).not.toHaveBeenCalled()
    setHostOutput(null)
    host.log('back')
    expect(log).toHaveBeenCalledWith('back')
  })
})
