/**
 * Expression parsing for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import {
  AudioToken,
  RandomValue,
  PlayElement,
  PlayNested,
  PlayWithModifier,
  PlayModifier,
  Meter,
} from './types'
import { ParserUtils } from './parser-utils'

/**
 * Expression parser for audio DSL
 */
export class ExpressionParser {
  private tokens: AudioToken[]
  private pos: number

  constructor(tokens: AudioToken[], pos: number) {
    this.tokens = tokens
    this.pos = pos
  }

  /**
   * Parse a single argument (dispatcher method)
   */
  parseArgument(): { value: any; newPos: number } {
    const token = ParserUtils.current(this.tokens, this.pos)

    if (token.type === 'MINUS') {
      return this.parseNegativeNumber()
    }

    if (token.type === 'NUMBER') {
      return this.parseNumber()
    }

    if (token.type === 'STRING') {
      return this.parseString()
    }

    if (token.type === 'IDENTIFIER') {
      return this.parseIdentifier()
    }

    if (token.type === 'LPAREN') {
      return this.parseParenthesizedExpression()
    }

    throw new Error(`Unexpected token in argument: ${token.type}`)
  }

  /**
   * Parse negative numbers, -Infinity, and -inf
   */
  private parseNegativeNumber(): { value: number; newPos: number } {
    const result = ParserUtils.advance(this.tokens, this.pos)
    this.pos = result.newPos
    const nextToken = ParserUtils.current(this.tokens, this.pos)

    // Check for -Infinity or -inf
    if (nextToken.type === 'IDENTIFIER' && ParserUtils.isInfinity(nextToken.value)) {
      const infResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = infResult.newPos
      return { value: -Infinity, newPos: this.pos }
    }

    // Regular negative number
    const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = numResult.newPos
    const value = -ParserUtils.parseNumber(numResult.token)
    return { value, newPos: this.pos }
  }

  /**
   * Parse numbers with optional meter syntax or play modifiers
   */
  private parseNumber(): { value: any; newPos: number } {
    const numResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = numResult.newPos
    const value = ParserUtils.parseNumber(numResult.token)

    // Check for "n by m" meter syntax
    if (ParserUtils.current(this.tokens, this.pos).type === 'BY') {
      return this.parseMeterFromNumber(value)
    }

    // Check for play modifiers (.chop, .time, .fixpitch)
    if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const modifierResult = this.parsePlayWithModifier(value)
      return { value: modifierResult.value, newPos: modifierResult.newPos }
    }

    return { value, newPos: this.pos }
  }

  /**
   * Parse meter syntax from a number (e.g., "3 by 4")
   */
  private parseMeterFromNumber(numerator: number): { value: Meter; newPos: number } {
    const byResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = byResult.newPos
    const denominatorResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = denominatorResult.newPos
    return {
      value: {
        numerator,
        denominator: ParserUtils.parseNumber(denominatorResult.token),
      },
      newPos: this.pos,
    }
  }

  /**
   * Parse string literals
   */
  private parseString(): { value: string; newPos: number } {
    const strResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = strResult.newPos
    return { value: ParserUtils.parseString(strResult.token), newPos: this.pos }
  }

  /**
   * Parse identifiers (key names, random syntax, boolean literals)
   */
  private parseIdentifier(): { value: any; newPos: number } {
    const idResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = idResult.newPos
    const value = idResult.token.value

    // Check for boolean literals
    if (ParserUtils.isBooleanLiteral(value)) {
      return { value: ParserUtils.parseBoolean(value), newPos: this.pos }
    }

    // Check for random syntax: 'r', 'r0%20', 'r-6%3', etc.
    if (ParserUtils.isRandomSyntax(value)) {
      return this.parseRandomValue(value)
    }

    // Check for "n by m" meter syntax (shouldn't happen with identifiers, but keep for safety)
    if (ParserUtils.current(this.tokens, this.pos).type === 'BY') {
      return this.parseMeterFromIdentifier(value)
    }

    return { value, newPos: this.pos }
  }

  /**
   * Parse meter syntax from an identifier
   */
  private parseMeterFromIdentifier(numerator: string): { value: Meter; newPos: number } {
    const byResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = byResult.newPos
    const denominatorResult = this.parseArgument()
    this.pos = denominatorResult.newPos
    return {
      value: { numerator: parseInt(numerator), denominator: denominatorResult.value },
      newPos: this.pos,
    }
  }

  /**
   * Parse parenthesized expressions (nested play or single meters)
   */
  private parseParenthesizedExpression(): { value: any; newPos: number } {
    // Look ahead to determine if this is a play structure or meter
    const lookahead = ParserUtils.peek(this.tokens, this.pos)
    if (lookahead.type === 'NUMBER') {
      const lookahead2 = ParserUtils.peek(this.tokens, this.pos, 2)
      if (lookahead2.type === 'BY') {
        // This is a meter like (3 by 4)
        return this.parseSingleMeter()
      } else if (
        lookahead2.type === 'RPAREN' ||
        lookahead2.type === 'DOT' ||
        lookahead2.type === 'COMMA'
      ) {
        // This is a play structure like (1), (1).chop(2), or (1, 2)
        return this.parseNestedPlay()
      }
    } else if (lookahead.type === 'LPAREN') {
      // Nested play structure like ((1)(2))
      return this.parseNestedPlay()
    }

    // Default to nested play (not composite meter)
    return this.parseNestedPlay()
  }

  /**
   * Parse random value syntax
   */
  private parseRandomValue(value: string): { value: RandomValue; newPos: number } {
    if (value === 'r') {
      return this.parseSimpleRandomOrWalk()
    }

    if (value.startsWith('r') && value.length > 1) {
      return this.parseRandomWalkWithCenter(value)
    }

    // Should not reach here if isRandomSyntax check was done properly
    throw new Error(`Internal error: Unexpected random syntax format '${value}'`)
  }

  /**
   * Parse simple 'r' or 'r-6%3' syntax
   */
  private parseSimpleRandomOrWalk(): { value: RandomValue; newPos: number } {
    // Check if followed by MINUS (for negative center like r-6%3)
    if (ParserUtils.current(this.tokens, this.pos).type === 'MINUS') {
      const minusResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = minusResult.newPos
      const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = numResult.newPos
      const center = -ParserUtils.parseNumber(numResult.token)

      // Expect PERCENT
      const percentResult = ParserUtils.expect(this.tokens, this.pos, 'PERCENT')
      this.pos = percentResult.newPos
      const rangeResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = rangeResult.newPos
      const range = ParserUtils.parseNumber(rangeResult.token)

      return { value: { type: 'random-walk', center, range }, newPos: this.pos }
    }

    // Just 'r' - full random
    return { value: { type: 'full-random' }, newPos: this.pos }
  }

  /**
   * Parse 'r0', 'r50', etc. followed by '%<range>'
   */
  private parseRandomWalkWithCenter(value: string): { value: RandomValue; newPos: number } {
    // Extract center value from identifier (e.g., 'r0' -> 0, 'r50' -> 50)
    const centerStr = value.substring(1) // Remove 'r' prefix
    const center = parseFloat(centerStr)

    if (isNaN(center)) {
      throw new Error(`Internal error: Invalid random syntax '${value}' passed to parseRandomValue`)
    }

    // Check if followed by PERCENT
    if (ParserUtils.current(this.tokens, this.pos).type === 'PERCENT') {
      const percentResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = percentResult.newPos
      const rangeResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = rangeResult.newPos
      const range = ParserUtils.parseNumber(rangeResult.token)

      return { value: { type: 'random-walk', center, range }, newPos: this.pos }
    }

    // r<num> without %, treat as regular identifier (invalid syntax)
    throw new Error(`Invalid random syntax: expected '%' after '${value}'`)
  }

  /**
   * Parse play structure with modifiers
   */
  private parsePlayWithModifier(value: number | PlayNested): {
    value: PlayWithModifier
    newPos: number
  } {
    const modifiers: PlayModifier[] = []

    while (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const dotResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = dotResult.newPos
      const methodResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
      this.pos = methodResult.newPos
      const method = methodResult.token.value

      if (method === 'chop') {
        const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
        this.pos = lparenResult.newPos
        const argResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
        this.pos = argResult.newPos
        const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
        this.pos = rparenResult.newPos
        modifiers.push({
          method: method as 'chop',
          value: ParserUtils.parseNumber(argResult.token),
        })
      } else if (method === 'time' || method === 'fixpitch') {
        throw new Error(
          `${method}() is not yet implemented. ` +
            `This feature is planned for future release. ` +
            `See GitHub issue tracker for updates.`,
        )
      }
    }

    return {
      value: {
        type: 'modified',
        value,
        modifiers,
      },
      newPos: this.pos,
    }
  }

  /**
   * Parse nested play structure
   */
  private parseNestedPlay(): { value: PlayNested | PlayWithModifier; newPos: number } {
    const elements: PlayElement[] = []

    // Parse nested structure like ((1)(2)) or (1, 2, 3)
    const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparenResult.newPos

    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RPAREN' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'RPAREN') {
        break
      }
      this.parseNestedPlayElement(elements)

      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      // Handle comma or continue
      if (!this.handleNestedPlaySeparator()) {
        break
      }
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    }

    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos

    // Check for modifiers on the nested structure itself
    if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const modifierResult = this.parsePlayWithModifier({ type: 'nested', elements })
      return { value: modifierResult.value, newPos: modifierResult.newPos }
    }

    return { value: { type: 'nested', elements }, newPos: this.pos }
  }

  /**
   * Parse a single element within a nested play structure
   */
  private parseNestedPlayElement(elements: PlayElement[]): void {
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
      // Nested element
      const nestedResult = this.parseNestedPlay()
      this.pos = nestedResult.newPos
      elements.push(nestedResult.value)
    } else if (ParserUtils.current(this.tokens, this.pos).type === 'NUMBER') {
      const numResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = numResult.newPos
      const value = ParserUtils.parseNumber(numResult.token)

      // Check for modifiers
      if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
        const modifierResult = this.parsePlayWithModifier(value)
        this.pos = modifierResult.newPos
        elements.push(modifierResult.value)
      } else {
        elements.push(value)
      }
    }
  }

  /**
   * Handle separators in nested play structures
   * @returns true if should continue parsing, false if should stop
   */
  private handleNestedPlaySeparator(): boolean {
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    if (ParserUtils.current(this.tokens, this.pos).type === 'COMMA') {
      const commaResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = commaResult.newPos
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      return true
    }

    if (ParserUtils.current(this.tokens, this.pos).type === 'RPAREN') {
      // End of this nested structure
      return false
    }

    if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
      // Another nested element, continue the loop
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      return true
    }

    // Unexpected token
    return false
  }

  /**
   * Parse single meter in parentheses: (3 by 4)
   * Note: Composite meters like (3 by 4)(5 by 4) are not supported
   */
  private parseSingleMeter(): { value: Meter; newPos: number } {
    const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparenResult.newPos
    const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = numResult.newPos
    const byResult = ParserUtils.expect(this.tokens, this.pos, 'BY')
    this.pos = byResult.newPos
    const denResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = denResult.newPos
    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos

    const meter: Meter = {
      numerator: parseInt(numResult.token.value),
      denominator: parseInt(denResult.token.value),
    }

    // Check if there's another meter following (composite meter syntax)
    // This is not supported, so throw an error
    if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
      const nextToken = ParserUtils.peek(this.tokens, this.pos)
      const nextNextToken = ParserUtils.peek(this.tokens, this.pos, 2)
      if (nextToken.type === 'NUMBER' && nextNextToken.type === 'BY') {
        throw new Error(
          'Composite meters like (3 by 4)(5 by 4) are not supported. ' +
            'Use a single meter notation like (3 by 4) or 3 by 4.',
        )
      }
    }

    return { value: meter, newPos: this.pos }
  }
}
