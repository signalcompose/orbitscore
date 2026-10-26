/**
 * engine の出力の口 `host`（`packages/engine/src/audio/engine-backend.ts`・設計 848 台帳 P-07・#1022）。
 *
 * 約束: 既定は console と同じ（凍結版の REPL・`orbitscore play` が書く行は変わらない。step は
 * `[STEP] <seq> <argPath> <atEpochMs>` の 1 行）/ 呼んだその時に `console.*` を引く（spy が効く）/
 * `setHostOutput` で差し込んだ口へ回り、`null` で既定に戻る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  advancePatternGeneration,
  host,
  patternGenerationOf,
  setHostOutput,
  type EnginePatternEvent,
} from '../../packages/engine/src/audio/engine-backend'

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
    host.step({ seq: 'kick', argPath: '0.1', atEpochMs: 1700000000000, generation: 3 })
    host.pattern({ seq: 'kick', generation: 4 })
    // 世代は層 2 だけが使う: 既定の口の行（凍結版の拡張が読む `[STEP]` の文法）は変えない。
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
      pattern: (event) => seen.push(`pattern ${event.seq} ${event.generation}`),
    })
    host.log('x')
    host.warn('y')
    host.error('z')
    host.step({ seq: 'hh', argPath: '2', atEpochMs: 7 })
    host.pattern({ seq: 'hh', generation: 9 })
    expect(seen).toEqual(['log x', 'warn y', 'error z', 'step hh 2 7', 'pattern hh 9'])
    expect(log).not.toHaveBeenCalled()
    setHostOutput(null)
    host.log('back')
    expect(log).toHaveBeenCalledWith('back')
  })

  it('numbers each new pattern across all sequences and tells the host (design 997 D-P1)', () => {
    const patterns: EnginePatternEvent[] = []
    setHostOutput({
      log: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
      pattern: (event) => patterns.push(event),
    })
    advancePatternGeneration('kick')
    advancePatternGeneration('hat')
    advancePatternGeneration('kick')
    advancePatternGeneration('') // 名前の無いシーケンスは step を出さないので振らない
    expect(patterns.map((p) => p.seq)).toEqual(['kick', 'hat', 'kick'])
    const [kick1, hat1, kick2] = patterns.map((p) => p.generation)
    expect(hat1).toBe(kick1! + 1)
    expect(kick2).toBe(hat1! + 1)
    expect(patternGenerationOf('kick')).toBe(kick2)
    expect(patternGenerationOf('hat')).toBe(hat1)
    expect(patternGenerationOf('never-played')).toBeUndefined()
  })
})
