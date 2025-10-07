/**
 * Statement parsing for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import { AudioToken, GlobalInit, SequenceInit, Statement, MethodChain } from './types'
import { ParserUtils } from './parser-utils'
import { ExpressionParser } from './parse-expression'

/**
 * Statement parser for audio DSL
 */
export class StatementParser {
  private tokens: AudioToken[]
  private pos: number

  constructor(tokens: AudioToken[], pos: number) {
    this.tokens = tokens
    this.pos = pos
  }

  /**
   * Parse a single statement
   */
  parseStatement(): { statement: any; newPos: number } {
    const token = ParserUtils.current(this.tokens, this.pos)

    // Variable declaration: var x = init GLOBAL
    if (token.type === 'VAR') {
      return this.parseVarDeclaration()
    }

    // Method calls: global.tempo(140) or seq1.play(0)
    if (token.type === 'IDENTIFIER') {
      return this.parseMethodCall()
    }

    // Skip unknown tokens
    const advanceResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = advanceResult.newPos
    return { statement: null, newPos: this.pos }
  }

  /**
   * Parse variable declaration
   */
  private parseVarDeclaration(): { statement: GlobalInit | SequenceInit; newPos: number } {
    const varResult = ParserUtils.expect(this.tokens, this.pos, 'VAR')
    this.pos = varResult.newPos
    const varNameResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = varNameResult.newPos
    const equalsResult = ParserUtils.expect(this.tokens, this.pos, 'EQUALS')
    this.pos = equalsResult.newPos
    const initResult = ParserUtils.expect(this.tokens, this.pos, 'INIT')
    this.pos = initResult.newPos

    // Check for GLOBAL (global initialization)
    if (
      ParserUtils.current(this.tokens, this.pos).type === 'GLOBAL' ||
      ParserUtils.current(this.tokens, this.pos).value === 'GLOBAL'
    ) {
      const globalResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = globalResult.newPos
      // Check if it's GLOBAL.seq (old syntax, still support for backward compatibility)
      if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
        const dotResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = dotResult.newPos
        if (ParserUtils.current(this.tokens, this.pos).value === 'seq') {
          const seqResult = ParserUtils.advance(this.tokens, this.pos)
          this.pos = seqResult.newPos
          return {
            statement: { type: 'seq_init', variableName: varNameResult.token.value },
            newPos: this.pos,
          }
        }
      }
      return {
        statement: { type: 'global_init', variableName: varNameResult.token.value },
        newPos: this.pos,
      }
    }

    // Check for variable.seq (new syntax: init global.seq)
    if (ParserUtils.current(this.tokens, this.pos).type === 'IDENTIFIER') {
      const globalVarResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = globalVarResult.newPos
      if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
        const dotResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = dotResult.newPos
        if (ParserUtils.current(this.tokens, this.pos).value === 'seq') {
          const seqResult = ParserUtils.advance(this.tokens, this.pos)
          this.pos = seqResult.newPos
          return {
            statement: {
              type: 'seq_init',
              variableName: varNameResult.token.value,
              globalVariable: globalVarResult.token.value,
            },
            newPos: this.pos,
          }
        }
      }
      // If not .seq, it might be another type of initialization
      throw new Error(`Unexpected initialization: init ${globalVarResult.token.value}`)
    }

    throw new Error('Expected GLOBAL or variable name after init')
  }

  /**
   * Parse method call
   */
  private parseMethodCall(): { statement: Statement | null; newPos: number } {
    const targetResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = targetResult.newPos
    const target = targetResult.token.value

    if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const dotResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = dotResult.newPos
      const methodResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
      this.pos = methodResult.newPos
      const method = methodResult.token.value

      // Handle special case for .force modifier
      if (
        ParserUtils.current(this.tokens, this.pos).type === 'DOT' &&
        ParserUtils.peek(this.tokens, this.pos).value === 'force'
      ) {
        const forceDotResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = forceDotResult.newPos
        const forceResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = forceResult.newPos
        // This is a transport command with force
        if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
          // Transport with arguments (e.g., global.loop(seq1, seq2))
          const argsResult = this.parseArguments()
          this.pos = argsResult.newPos
          return {
            statement: {
              type: 'transport',
              target,
              command: method,
              force: true,
              sequences: argsResult.args,
            },
            newPos: this.pos,
          }
        }
        return {
          statement: {
            type: 'transport',
            target,
            command: method,
            force: true,
          },
          newPos: this.pos,
        }
      }

      // Parse method arguments
      if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
        const argsResult = this.parseArguments()
        this.pos = argsResult.newPos

        // Check for method chaining (e.g., .audio(...).chop(...))
        const chain: MethodChain[] = []
        while (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
          const chainDotResult = ParserUtils.advance(this.tokens, this.pos)
          this.pos = chainDotResult.newPos
          const chainMethodResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
          this.pos = chainMethodResult.newPos
          const chainMethod = chainMethodResult.token.value

          // Check if chained method has arguments
          if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
            const chainArgsResult = this.parseArguments()
            this.pos = chainArgsResult.newPos
            chain.push({ method: chainMethod, args: chainArgsResult.args })
          } else {
            chain.push({ method: chainMethod, args: [] })
          }
        }

        const result: any = {
          type: target === 'global' ? 'global' : 'sequence',
          target,
          method,
          args: argsResult.args,
        }

        if (chain.length > 0) {
          result.chain = chain
        }

        return { statement: result, newPos: this.pos }
      }

      // Method without parentheses (transport commands)
      return {
        statement: {
          type: 'transport',
          target,
          command: method,
        },
        newPos: this.pos,
      }
    }

    // Identifier without method call (invalid syntax, skip it)
    return { statement: null, newPos: this.pos }
  }

  /**
   * Parse method arguments
   */
  private parseArguments(): { args: any[]; newPos: number } {
    const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparenResult.newPos
    const args: any[] = []

    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RPAREN' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
      const expressionParser = new ExpressionParser(this.tokens, this.pos)
      const argResult = expressionParser.parseArgument()
      this.pos = argResult.newPos
      args.push(argResult.value)

      if (ParserUtils.current(this.tokens, this.pos).type === 'COMMA') {
        const commaResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = commaResult.newPos
      } else if (ParserUtils.current(this.tokens, this.pos).type === 'RPAREN') {
        // End of arguments
        break
      } else if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
        // Special case: consecutive nested elements like (1)(2)
        // Continue parsing without requiring comma
        continue
      } else {
        throw new Error('Expected comma or closing parenthesis')
      }
    }

    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos
    return { args, newPos: this.pos }
  }
}
