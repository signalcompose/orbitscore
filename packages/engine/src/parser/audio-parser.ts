/**
 * Audio-based DSL Parser
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 *
 * This is the new parser for the audio-based OrbitScore DSL.
 *
 * @deprecated This file is being refactored into smaller modules.
 * For new code, consider using the modules directly from './'.
 */

import {
  AudioToken,
  AudioIR,
  FileImportStatement,
  GlobalInit,
  SequenceInit,
  Statement,
} from './types'
import { AudioTokenizer } from './tokenizer'
import { ParserUtils } from './parser-utils'
import { StatementParser } from './parse-statement'

// Re-export AudioTokenizer for backward compatibility
export { AudioTokenizer }

// Re-export types for backward compatibility
export type {
  AudioIR,
  GlobalInit,
  SequenceInit,
  Statement,
  GlobalStatement,
  SequenceStatement,
  TransportStatement,
  ChordBinding,
  PatternBinding,
  ModeBinding,
  RandomBinding,
  ImportStatement,
  MixerHandleStatement,
  MethodChain,
  ValueArray,
  ValueCall,
  ValueExpression,
  ValueRef,
  RandomValue,
  PlayElement,
  PlayRandomDegree,
  PlayNested,
  PlayWithModifier,
  PlayModifier,
  PlayRepeat,
  Meter,
} from './types'

/**
 * Parser for the audio-based DSL
 *
 * @deprecated This class is now a thin wrapper around the parser modules.
 * For new code, consider using the modules directly from './'.
 */
export class AudioParser {
  private tokens: AudioToken[]
  private pos: number = 0

  constructor(tokens: AudioToken[]) {
    this.tokens = tokens
  }

  /** `forEachStatement` が今読んでいる文の先頭のトークン（構文エラーの位置に使う）。 */
  public statementStart = 0

  /**
   * 文を 1 つずつ読み、読めた文を `visit` に渡す（`parse` と `parseAudioDSLWithSpans` の共通の走査）。
   * `startPos` / `endPos` は文のトークンの範囲（`endPos` は含まない）。
   */
  public forEachStatement(
    visit: (
      statement: GlobalInit | SequenceInit | FileImportStatement | Statement,
      startPos: number,
      endPos: number,
    ) => void,
  ): void {
    // IM.1: file import はファイル先頭領域（最初の非 import 文より前）のみ。
    // import 文（stdlib 含む）以外を見たら以降の file import はエラー。
    let seenNonImport = false

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    while (!ParserUtils.isEOF(this.tokens, this.pos)) {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.isEOF(this.tokens, this.pos)) break

      this.statementStart = this.pos
      const statementParser = new StatementParser(this.tokens, this.pos)
      const stmtResult = statementParser.parseStatement()
      this.pos = stmtResult.newPos

      if (stmtResult.statement) {
        if (stmtResult.statement.type === 'file_import' && seenNonImport) {
          throw new Error(
            `import "${(stmtResult.statement as FileImportStatement).path}": ` +
              `import statements must appear before any other statement (IM.1).`,
          )
        }
        visit(
          stmtResult.statement as GlobalInit | SequenceInit | FileImportStatement | Statement,
          this.statementStart,
          this.pos,
        )
        // import 文（stdlib / file の両方）だけが先頭領域を延長する — 不変条件はこの1行。
        if (stmtResult.statement.type !== 'import' && stmtResult.statement.type !== 'file_import') {
          seenNonImport = true
        }
      }

      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    }
  }

  public parse(): AudioIR {
    const result: AudioIR = {
      sequenceInits: [],
      statements: [],
      fileImports: [],
    }
    this.forEachStatement((statement) => {
      // Handle different statement types
      if (statement.type === 'global_init') {
        result.globalInit = statement as GlobalInit
      } else if (statement.type === 'seq_init') {
        result.sequenceInits.push(statement as SequenceInit)
      } else if (statement.type === 'file_import') {
        result.fileImports!.push(statement as FileImportStatement)
      } else {
        result.statements.push(statement as Statement)
      }
    })
    return result
  }
}

/**
 * Main parsing function
 */
export function parseAudioDSL(source: string): AudioIR {
  const tokenizer = new AudioTokenizer(source)
  const tokens = tokenizer.tokenize()
  const parser = new AudioParser(tokens)
  return parser.parse()
}

/** 0 始まり・UTF-16 の位置（LSP と同じ）。 */
export interface SourcePosition {
  line: number
  character: number
}

/** ソースの範囲（`end` は含まない）。 */
export interface SourceSpan {
  start: SourcePosition
  end: SourcePosition
}

/** `parseAudioDSLWithSpans` が返す 1 文（ソースの順）。`text` は範囲の文字列そのもの。 */
export type ParsedEntry =
  | { kind: 'file_import'; node: FileImportStatement; span: SourceSpan; text: string }
  | { kind: 'global_init'; node: GlobalInit; span: SourceSpan; text: string }
  | { kind: 'seq_init'; node: SequenceInit; span: SourceSpan; text: string }
  | { kind: 'statement'; node: Statement; span: SourceSpan; text: string }

export interface ParsedRequest {
  entries: ParsedEntry[]
}

/** 位置つきの構文エラー。`message` は `parseAudioDSL` が投げるものと同じ文言。 */
export class DslSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: SourcePosition,
  ) {
    super(message)
    this.name = 'DslSyntaxError'
  }
}

/**
 * 評価の要求を 1 度に読み、文の列を**ソースの順**に範囲つきで返す（OrbitStudio の層 2 の評価・
 * spec「評価の単位」E-1・#997 / #1022）。読んだ結果は `parseAudioDSL` と同じ構文木で、違うのは
 * 宣言を種類ごとに分けず、文の位置を持つことだけ。
 *
 * 位置は LSP と同じ行の規則（`\n`・`\r\n`・`\r`）で数える。トークナイザは単独の `\r` を改行と
 * みなさないので、同じ長さの `\n` に置き換えてから読む（位置はずれない）。
 */
export function parseAudioDSLWithSpans(source: string): ParsedRequest {
  const text = source.replace(/\r(?!\n)/g, '\n')
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const offsetOf = (token: AudioToken): number =>
    (lineStarts[token.line - 1] ?? text.length) + token.column - 1
  const positionOf = (offset: number): SourcePosition => {
    let line = 0
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++
    return { line, character: offset - lineStarts[line]! }
  }
  /** トークンの終わり（文字列は閉じ引用符の後・トークナイザの `readString` と同じ読み方）。 */
  const endOffsetOf = (token: AudioToken): number => {
    const start = offsetOf(token)
    if (token.type !== 'STRING') return start + token.value.length
    const quote = text[start]
    let i = start + 1
    while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
    return Math.min(text.length, i + 1)
  }

  const tokens = new AudioTokenizer(text).tokenize()
  const parser = new AudioParser(tokens)
  const entries: ParsedEntry[] = []
  try {
    parser.forEachStatement((statement, startPos, endPos) => {
      let last = endPos - 1
      while (
        last > startPos &&
        (tokens[last]!.type === 'NEWLINE' || tokens[last]!.type === 'EOF')
      ) {
        last--
      }
      const startOffset = offsetOf(tokens[startPos]!)
      const endOffset = endOffsetOf(tokens[last]!)
      const span = { start: positionOf(startOffset), end: positionOf(endOffset) }
      const entryText = text.slice(startOffset, endOffset)
      const kind =
        statement.type === 'file_import' ||
        statement.type === 'global_init' ||
        statement.type === 'seq_init'
          ? statement.type
          : 'statement'
      entries.push({ kind, node: statement, span, text: entryText } as ParsedEntry)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // パーサの多くの文言は失敗したトークンの位置を持つ。無くて入力の終端（EOF）の話なら終端、
    // それ以外は読んでいた文の先頭。
    const at = [...message.matchAll(/at line (\d+), column (\d+)/g)].pop()
    const startToken = /\bEOF\b/.test(message)
      ? tokens[tokens.length - 1]
      : tokens[parser.statementStart]
    const position = at
      ? positionOf((lineStarts[Number(at[1]) - 1] ?? text.length) + Number(at[2]) - 1)
      : startToken
        ? positionOf(offsetOf(startToken))
        : { line: 0, character: 0 }
    throw new DslSyntaxError(message, position)
  }
  return { entries }
}
