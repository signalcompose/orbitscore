/**
 * Audio-based DSL Parser
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 *
 * This is the new parser for the audio-based OrbitScore DSL.
 *
 * @deprecated This file is being refactored into smaller modules.
 * For new code, consider using the modules directly from './'.
 */

import { AudioToken, AudioIR, GlobalInit, SequenceInit, Statement } from './types'
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
  MethodChain,
  RandomValue,
  PlayElement,
  PlayNested,
  PlayWithModifier,
  PlayModifier,
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
    }

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
        } else {
          result.statements.push(stmtResult.statement as Statement)
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
