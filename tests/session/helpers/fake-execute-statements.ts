/**
 * 偽の interpreter の `executeStatements`（層 2 の評価の入口・#1022）。本物と同じ約束だけを真似る:
 * 文をソースの順に 1 つずつ渡し、各文の直前に `hooks.onStatement` を呼び、投げた文はその文だけを
 * 失敗にして（`hooks.onFailure` を呼び）残りを続ける。`perStatement` は文の文字列（`entry.text`）と options を受ける。
 */
import type { ParsedRequest } from '../../../packages/engine/src/parser/audio-parser'

export interface FakeExecuteOptions {
  source?: string
  evalSource?: string
  documentDirectory?: string
}

export function fakeExecuteStatements(
  perStatement: (text: string, options: FakeExecuteOptions) => unknown = () => {},
) {
  return async (
    request: ParsedRequest,
    options: FakeExecuteOptions = {},
    hooks: {
      onStatement?(index: number): void
      onFailure?(index: number, message: string): void
    } = {},
  ): Promise<Array<{ index: number; message: string }>> => {
    const failures: Array<{ index: number; message: string }> = []
    for (const [index, entry] of request.entries.entries()) {
      hooks.onStatement?.(index)
      try {
        await perStatement(entry.text, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ index, message })
        hooks.onFailure?.(index, message)
      }
    }
    return failures
  }
}
