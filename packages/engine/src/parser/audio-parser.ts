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
  ImportStatement,
  MixerHandleStatement,
  MethodChain,
  RandomValue,
  PlayElement,
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

  public parse(): AudioIR {
    const result: AudioIR = {
      sequenceInits: [],
      statements: [],
      fileImports: [],
    }
    // IM.1: file import はファイル先頭領域（最初の非 import 文より前）のみ。
    // import 文（stdlib 含む）以外を見たら以降の file import はエラー。
    let seenNonImport = false

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    while (!ParserUtils.isEOF(this.tokens, this.pos)) {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.isEOF(this.tokens, this.pos)) break

      const statementParser = new StatementParser(this.tokens, this.pos)
      const stmtResult = statementParser.parseStatement()
      this.pos = stmtResult.newPos

      if (stmtResult.statement) {
        // Handle different statement types
        if (stmtResult.statement.type === 'global_init') {
          result.globalInit = stmtResult.statement as GlobalInit
        } else if (stmtResult.statement.type === 'seq_init') {
          result.sequenceInits.push(stmtResult.statement as SequenceInit)
        } else if (stmtResult.statement.type === 'file_import') {
          if (seenNonImport) {
            throw new Error(
              `import "${(stmtResult.statement as FileImportStatement).path}": ` +
                `import statements must appear before any other statement (IM.1).`,
            )
          }
          result.fileImports!.push(stmtResult.statement as FileImportStatement)
        } else {
          result.statements.push(stmtResult.statement as Statement)
        }
        // import 文（stdlib / file の両方）だけが先頭領域を延長する — 不変条件はこの1行。
        if (stmtResult.statement.type !== 'import' && stmtResult.statement.type !== 'file_import') {
          seenNonImport = true
        }
      }

      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    }

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
