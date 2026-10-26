/**
 * `editor.runSelection` で何を評価するか（設計 848 §5.4・§12 補正）: 選択が在ればその範囲、無ければ
 * カーソルの行の subject-block（同じ変数を操作する行の全部）か、単独の文（`LOOP(...)` 等）。
 *
 * 凍結版 `run-selection.ts` の `getLineSubject` と `runSelection` の範囲の決め方を、VS Code の文書の
 * 代わりに同期済みの写しのテキストで書き直したもの。凍結版と同じ範囲・同じテキストになることは
 * `tests/session/selection-block-parity.spec.ts` が凍結版の `runSelection` を vscode の mock で走らせて
 * 突き合わせる。**ここを変える時は凍結版と食い違わないこと**（⌘Enter で評価される範囲がずれる）。
 */
import { lineStarts, offsetAt, positionAt, type Position, type Range } from './document-store'

/**
 * 行が操作する変数の名前。単独の命令とコメントは null（凍結版 `getLineSubject` と同じ規則）。
 *
 *   "var drum = init global.seq" → "drum"
 *   "drum.audio('kick.wav')"     → "drum"
 *   "LOOP(drum, snare)"          → null
 */
export function getLineSubject(lineText: string): string | null {
  const trimmed = lineText.trim()
  if (!trimmed || trimmed.startsWith('//')) return null
  const varMatch = trimmed.match(/^var\s+(\w+)\s*=/)
  if (varMatch) return varMatch[1] ?? null
  const dotMatch = trimmed.match(/^(\w+)\./)
  if (dotMatch) return dotMatch[1] ?? null
  return null
}

export interface SelectionBlock {
  /** 評価するテキスト（前後の空白は落とした後）。 */
  code: string
  /** 評価した範囲（エディタが flash する範囲・`session.evaluate` の `target.range`）。 */
  range: Range
  /**
   * `code` の行 i が始まる文書の位置（設計 997 D-P2）。subject-block は離れた行を繋ぐので `range` からは
   * 戻らない。診断と `transport.step.source` を文書の座標へ写すのに使う（wire には載せない）。
   */
  lines: Position[]
}

/** LSP と同じ行の規則で数えた `code` の行数。 */
function lineCount(code: string): number {
  return code.split(/\r\n|\r|\n/).length
}

/**
 * 文書の `range` のテキスト（またはその前後の空白を落としたもの）が `code` の時、`code` の各行が始まる
 * 文書の位置。そうでなければ undefined（`code` は文書のその範囲から取ったものではない）。
 */
export function contiguousCodeLines(
  text: string,
  range: Range,
  code: string,
): Position[] | undefined {
  const starts = lineStarts(text)
  const startOffset = offsetAt(text, range.start, starts)
  const raw = text.slice(startOffset, offsetAt(text, range.end, starts))
  if (raw !== code && raw.trim() !== code) return undefined
  const lead = raw === code ? 0 : raw.length - raw.trimStart().length
  const first = positionAt(text, startOffset + lead, starts)
  return Array.from({ length: lineCount(code) }, (_, i) =>
    i === 0 ? first : { line: first.line + i, character: 0 },
  )
}

/** 括弧の深さの差（凍結版と同じく文字列やコメントの中も数える）。 */
function parenDelta(text: string): number {
  let balance = 0
  for (const char of text) {
    if (char === '(') balance++
    if (char === ')') balance--
  }
  return balance
}

/**
 * 選択（空なら `range.start` がカーソル）から評価する範囲とテキストを決める。位置は LSP と同じ
 * 0 始まり・UTF-16。
 */
export function resolveSelectionBlock(text: string, selection: Range): SelectionBlock {
  const starts = lineStarts(text)
  const slice = (range: Range) =>
    text.slice(offsetAt(text, range.start, starts), offsetAt(text, range.end, starts))
  const contiguous = (range: Range): SelectionBlock => {
    const code = slice(range).trim()
    return { code, range, lines: contiguousCodeLines(text, range, code) ?? [] }
  }
  const isEmpty =
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  if (!isEmpty) return contiguous(selection)

  const lines = text.split(/\r\n|\r|\n/)
  const lineRange = (first: number, last: number): Range => ({
    start: { line: first, character: 0 },
    end: { line: last, character: (lines[last] ?? '').length },
  })
  const currentLine = selection.start.line
  const subject = getLineSubject(lines[currentLine] ?? '')

  if (!subject) {
    // 単独の命令（LOOP・RUN・MUTE 等）: 括弧が閉じるまでの 1 文だけ。
    let endLine = currentLine
    let balance = parenDelta(lines[currentLine] ?? '')
    while (balance > 0 && endLine + 1 < lines.length) {
      endLine++
      balance += parenDelta(lines[endLine] ?? '')
    }
    return contiguous(lineRange(currentLine, endLine))
  }

  // 同じ変数の行（宣言とメソッド呼び出し）を文書の全体から集める。括弧が開いたままの行は続きの行も。
  const collected: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (getLineSubject(lines[i] ?? '') !== subject) continue
    collected.push(i)
    let balance = parenDelta(lines[i] ?? '')
    while (balance > 0 && i + 1 < lines.length) {
      i++
      collected.push(i)
      balance += parenDelta(lines[i] ?? '')
    }
  }
  const first = collected[0] ?? currentLine
  const last = collected[collected.length - 1] ?? currentLine
  const joined = collected.map((line) => lines[line] ?? '').join('\n')
  // 先頭の行は subject の行（空でない）なので、trim が落とすのはその行の頭の空白だけ。
  const lead = joined.length - joined.trimStart().length
  return {
    code: joined.trim(),
    range: lineRange(first, last),
    lines: collected.map((line, i) => ({ line, character: i === 0 ? lead : 0 })),
  }
}

/** 1 始まりの位置（MCP `set_selection` の形）。 */
export function oneBasedCursor(position: Position): { startLine: number; startChar: number } {
  return { startLine: position.line + 1, startChar: position.character + 1 }
}
