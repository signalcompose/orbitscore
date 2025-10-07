/**
 * Parser utility functions for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import { AudioToken, AudioTokenType } from './types'

/**
 * Parser utility functions
 */
export class ParserUtils {
  /**
   * Check if parser has reached end of tokens
   */
  static isEOF(tokens: AudioToken[], pos: number): boolean {
    return pos >= tokens.length || tokens[pos]?.type === 'EOF'
  }

  /**
   * Get current token at position
   */
  static current(tokens: AudioToken[], pos: number): AudioToken {
    return tokens[pos] || { type: 'EOF', value: '', line: 0, column: 0 }
  }

  /**
   * Peek at token at offset from current position
   */
  static peek(tokens: AudioToken[], pos: number, offset: number = 1): AudioToken {
    return tokens[pos + offset] || { type: 'EOF', value: '', line: 0, column: 0 }
  }

  /**
   * Advance position and return current token
   */
  static advance(tokens: AudioToken[], pos: number): { token: AudioToken; newPos: number } {
    const token = ParserUtils.current(tokens, pos)
    const newPos = ParserUtils.isEOF(tokens, pos) ? pos : pos + 1
    return { token, newPos }
  }

  /**
   * Expect specific token type and advance
   */
  static expect(
    tokens: AudioToken[],
    pos: number,
    type: AudioTokenType,
  ): { token: AudioToken; newPos: number } {
    const token = ParserUtils.current(tokens, pos)
    if (token.type !== type) {
      throw new Error(
        `Expected ${type} but got ${token.type} at line ${token.line}, column ${token.column}`,
      )
    }
    return ParserUtils.advance(tokens, pos)
  }

  /**
   * Skip newline tokens
   */
  static skipNewlines(tokens: AudioToken[], pos: number): number {
    let newPos = pos
    while (ParserUtils.current(tokens, newPos).type === 'NEWLINE') {
      const result = ParserUtils.advance(tokens, newPos)
      newPos = result.newPos
    }
    return newPos
  }

  /**
   * Parse a number value from token
   */
  static parseNumber(token: AudioToken): number {
    return parseFloat(token.value)
  }

  /**
   * Parse a string value from token
   */
  static parseString(token: AudioToken): string {
    return token.value
  }

  /**
   * Parse a boolean value from identifier
   */
  static parseBoolean(value: string): boolean {
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error(`Invalid boolean value: ${value}`)
  }

  /**
   * Check if identifier is a boolean literal
   */
  static isBooleanLiteral(value: string): boolean {
    return value === 'true' || value === 'false'
  }

  /**
   * Check if identifier is a random syntax
   * Valid random syntax: 'r', 'r0', 'r50', 'r123', etc.
   * Invalid: 'rabc', 'rtest', etc. (these are treated as regular identifiers)
   */
  static isRandomSyntax(value: string): boolean {
    if (value === 'r') return true
    if (value.startsWith('r') && value.length > 1) {
      const rest = value.substring(1)
      // Check if the rest is a valid number
      const num = parseFloat(rest)
      return !isNaN(num) && isFinite(num)
    }
    return false
  }

  /**
   * Check if identifier is Infinity or inf
   */
  static isInfinity(value: string): boolean {
    return value === 'Infinity' || value === 'inf'
  }
}
