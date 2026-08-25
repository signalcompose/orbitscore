/**
 * #607: shutdown が daemon に到達することの**配線**テスト。
 *
 * 実害の機序（実機で実測）: REPL モードでは `executeCommand()` が返らないため
 * `cli-audio.ts` の `globalInterpreter` は永遠に null。shutdown ハンドラは
 * `shutdown(null)` を呼び、`if (interpreter)` ブロックごと飛ばして `process.exit(0)`
 * へ直行していた。**`audioEngine.quit()` は一度も呼ばれず、Rust daemon が孤児化**し、
 * coreaudiod の音声出力コンテキストを保持し続けた（蓄積すると CPU が飽和する）。
 *
 * 🔴 テストは**実コードを通す**こと。式を手で複製すると、実装を壊す変異が生き残る
 * （最初の実装がまさにそれで、変異 (A)(B) を素通しした）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getActiveInterpreter,
  setActiveInterpreter,
} from '../../packages/engine/src/cli/active-interpreter'
import { startREPL } from '../../packages/engine/src/cli/repl-mode'
import { resolveShutdownInterpreter, shutdown } from '../../packages/engine/src/cli/shutdown'
import type { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

// startREPL は readline を開いてプロセスを生かし続けるので、テストでは差し替える。
vi.mock('readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('readline')>()
  return { ...actual, createInterface: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })) }
})

function fakeInterpreter(quit: () => Promise<void> = async () => {}): InterpreterV2 {
  return { getGlobals: () => [], audioEngine: { quit } } as unknown as InterpreterV2
}

describe('shutdown が daemon に到達する配線 (#607)', () => {
  afterEach(() => {
    setActiveInterpreter(null)
    vi.restoreAllMocks()
  })

  it('戻り値が null でも registry の interpreter へフォールバックする', () => {
    const i = fakeInterpreter()
    setActiveInterpreter(i)
    // 実コード（resolveShutdownInterpreter）を呼ぶ。式の複製ではない。
    expect(resolveShutdownInterpreter(() => null)).toBe(i)
  })

  it('戻り値がある場合はそちらを優先する', () => {
    const fromReturn = fakeInterpreter()
    const fromRegistry = fakeInterpreter()
    setActiveInterpreter(fromRegistry)
    expect(resolveShutdownInterpreter(() => fromReturn)).toBe(fromReturn)
  })

  it('両方 null なら null（フォールバックが偽の値を作らない）', () => {
    expect(resolveShutdownInterpreter(() => null)).toBeNull()
  })

  it('startREPL は受け取った interpreter を生成経路で publish する', () => {
    // startREPL は返らないので await しない。readline は vi.mock で差し替え済み。
    const i = fakeInterpreter()
    void startREPL(i)
    expect(getActiveInterpreter()).toBe(i)
  })

  it('interpreter を渡せば audioEngine.quit() がちょうど1回呼ばれる', async () => {
    const quit = vi.fn(async () => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    await shutdown(fakeInterpreter(quit))
    expect(quit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
