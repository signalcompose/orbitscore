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
  CompositeMeter,
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
   * Parse a single argument
   */
  parseArgument(): { value: any; newPos: number } {
    const token = ParserUtils.current(this.tokens, this.pos)

    // Handle negative numbers, -Infinity, and -inf
    if (token.type === 'MINUS') {
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

    // Numbers
    if (token.type === 'NUMBER') {
      const numResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = numResult.newPos
      const value = ParserUtils.parseNumber(numResult.token)

      // Check for "n by m" meter syntax
      if (ParserUtils.current(this.tokens, this.pos).type === 'BY') {
        const byResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = byResult.newPos
        const denominatorResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
        this.pos = denominatorResult.newPos
        return {
          value: {
            numerator: value,
            denominator: ParserUtils.parseNumber(denominatorResult.token),
          },
          newPos: this.pos,
        }
      }

      // Check for play modifiers (.chop, .time, .fixpitch)
      if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
        const modifierResult = this.parsePlayWithModifier(value)
        return { value: modifierResult.value, newPos: modifierResult.newPos }
      }

      return { value, newPos: this.pos }
    }

    // Strings
    if (token.type === 'STRING') {
      const strResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = strResult.newPos
      return { value: ParserUtils.parseString(strResult.token), newPos: this.pos }
    }

    // Identifiers (for key names like C, D, etc., or random syntax 'r', or boolean literals)
    if (token.type === 'IDENTIFIER') {
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
        const byResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = byResult.newPos
        const denominatorResult = this.parseArgument()
        this.pos = denominatorResult.newPos
        return {
          value: { numerator: parseInt(value), denominator: denominatorResult.value },
          newPos: this.pos,
        }
      }

      return { value, newPos: this.pos }
    }

    // Nested play structures or composite meters
    if (token.type === 'LPAREN') {
      // Look ahead to determine if this is a play structure or meter
      const lookahead = ParserUtils.peek(this.tokens, this.pos)
      if (lookahead.type === 'NUMBER') {
        const lookahead2 = ParserUtils.peek(this.tokens, this.pos, 2)
        if (lookahead2.type === 'BY') {
          // This is a meter like (3 by 4)
          return this.parseCompositeMeter()
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

    throw new Error(`Unexpected token in argument: ${token.type}`)
  }

  /**
   * Parse random value syntax
   */
  private parseRandomValue(value: string): { value: RandomValue; newPos: number } {
    if (value === 'r') {
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
      } else {
        // Just 'r' - full random
        return { value: { type: 'full-random' }, newPos: this.pos }
      }
    } else if (value.startsWith('r') && value.length > 1) {
      // Parse 'r0', 'r50', etc. followed by '%<range>'
      // Extract center value from identifier (e.g., 'r0' -> 0, 'r50' -> 50)
      const centerStr = value.substring(1) // Remove 'r' prefix
      const center = parseFloat(centerStr)

      if (isNaN(center)) {
        // Not a random syntax, treat as regular identifier
        return { value: value as any, newPos: this.pos }
      }

      // Check if followed by PERCENT
      if (ParserUtils.current(this.tokens, this.pos).type === 'PERCENT') {
        const percentResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = percentResult.newPos
        const rangeResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
        this.pos = rangeResult.newPos
        const range = ParserUtils.parseNumber(rangeResult.token)

        return { value: { type: 'random-walk', center, range }, newPos: this.pos }
      } else {
        // r<num> without %, treat as regular identifier (invalid syntax)
        throw new Error(`Invalid random syntax: expected '%' after '${value}'`)
      }
    }

    return { value: value as any, newPos: this.pos }
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

      if (method === 'chop' || method === 'time' || method === 'fixpitch') {
        const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
        this.pos = lparenResult.newPos
        const argResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
        this.pos = argResult.newPos
        const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
        this.pos = rparenResult.newPos
        modifiers.push({
          method: method as 'chop' | 'time' | 'fixpitch',
          value: ParserUtils.parseNumber(argResult.token),
        })
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
  private parseNestedPlay(): { value: PlayNested; newPos: number } {
    const elements: PlayElement[] = []

    // Parse nested structure like ((1)(2)) or (1, 2, 3)
    const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparenResult.newPos

    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RPAREN' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
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

      // Handle comma or continue
      if (ParserUtils.current(this.tokens, this.pos).type === 'COMMA') {
        const commaResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = commaResult.newPos
      } else if (ParserUtils.current(this.tokens, this.pos).type === 'RPAREN') {
        // End of this nested structure
        break
      } else if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
        // Another nested element, continue the loop
        continue
      } else {
        // Unexpected token
        break
      }
    }

    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos

    // Check for modifiers on the nested structure itself
    if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const modifierResult = this.parsePlayWithModifier({ type: 'nested', elements })
      return { value: modifierResult.value as any, newPos: modifierResult.newPos }
    }

    return { value: { type: 'nested', elements }, newPos: this.pos }
  }

  /**
   * Parse composite meter
   */
  private parseCompositeMeter(): { value: CompositeMeter; newPos: number } {
    const meters: Meter[] = []

    while (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
      const lparenResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = lparenResult.newPos
      const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = numResult.newPos
      const byResult = ParserUtils.expect(this.tokens, this.pos, 'BY')
      this.pos = byResult.newPos
      const denResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = denResult.newPos
      const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
      this.pos = rparenResult.newPos

      meters.push({
        numerator: parseInt(numResult.token.value),
        denominator: parseInt(denResult.token.value),
      })
    }

    return { value: { meters }, newPos: this.pos }
  }
}
