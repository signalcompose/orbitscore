/**
 * Statement parsing for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import {
  AudioToken,
  GlobalInit,
  SequenceInit,
  Statement,
  MethodChain,
  ChordBinding,
  PatternBinding,
  ImportStatement,
  PlayStack,
  PlayElement,
} from './types'
import { ParserUtils } from './parser-utils'
import { ExpressionParser, collapseScopedRun } from './parse-expression'

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

    // Variable declaration: var x = init GLOBAL  /  var m7 = chord([...])
    if (token.type === 'VAR') {
      return this.parseVarDeclaration()
    }

    // Module import: import chords (§6)
    if (token.type === 'IMPORT') {
      return this.parseImport()
    }

    // Reserved keywords: RUN(), LOOP(), MUTE()
    if (token.type === 'RUN' || token.type === 'LOOP' || token.type === 'MUTE') {
      return this.parseReservedKeyword()
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
  private parseVarDeclaration(): {
    statement: GlobalInit | SequenceInit | ChordBinding | PatternBinding
    newPos: number
  } {
    const varResult = ParserUtils.expect(this.tokens, this.pos, 'VAR')
    this.pos = varResult.newPos
    const varNameResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = varNameResult.newPos
    const equalsResult = ParserUtils.expect(this.tokens, this.pos, 'EQUALS')
    this.pos = equalsResult.newPos

    // `var m7 = chord([ ... ])` — a chord-value binding (§6). The `init ...`
    // initializers below are unchanged.
    const rhs = ParserUtils.current(this.tokens, this.pos)
    if (rhs.type === 'IDENTIFIER' && rhs.value === 'chord') {
      return this.parseChordBinding(varNameResult.token.value)
    }

    // `var NAME = (...)` / `(...)(...)` / `(...).root()` / `(...)*n` — a pattern
    // binding (§6.5). No existing var RHS starts with `(`, so this is unambiguous.
    if (rhs.type === 'LPAREN') {
      return this.parsePatternBinding(varNameResult.token.value)
    }

    const initResult = ParserUtils.expect(this.tokens, this.pos, 'INIT')
    this.pos = initResult.newPos

    // Check for GLOBAL (global initialization)
    if (
      ParserUtils.current(this.tokens, this.pos).type === 'GLOBAL' ||
      ParserUtils.current(this.tokens, this.pos).value === 'GLOBAL'
    ) {
      return this.parseGlobalInit(varNameResult.token.value)
    }

    // Check for variable.seq (new syntax: init global.seq)
    if (ParserUtils.current(this.tokens, this.pos).type === 'IDENTIFIER') {
      return this.parseSequenceInit(varNameResult.token.value)
    }

    throw new Error('Expected GLOBAL, a variable name, or chord([...]) after `=`')
  }

  /**
   * Parse `var NAME = chord([ ... ])` (§6). The bracket contents are parsed by the
   * expression parser (a PlayStack); only its raw voices are kept on the binding,
   * to be evaluated (spread/removal/`^N`) by the interpreter at execution order.
   */
  private parseChordBinding(variableName: string): { statement: ChordBinding; newPos: number } {
    const chordKw = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER') // 'chord'
    this.pos = chordKw.newPos
    const lparen = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparen.newPos

    if (ParserUtils.current(this.tokens, this.pos).type !== 'LBRACKET') {
      throw new Error('chord(...) expects a `[ ... ]` stack literal, e.g. chord([1, b3, 5, b7])')
    }
    const ep = new ExpressionParser(this.tokens, this.pos)
    const stackResult = ep.parseArgument()
    this.pos = stackResult.newPos
    const stack = stackResult.value as PlayStack

    const rparen = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparen.newPos

    return {
      statement: { type: 'chord_binding', variableName, voices: stack.voices },
      newPos: this.pos,
    }
  }

  /**
   * Parse `import chords` (§6). Only the `chords` stdlib is accepted in v1.1.
   */
  private parseImport(): { statement: ImportStatement; newPos: number } {
    const importKw = ParserUtils.expect(this.tokens, this.pos, 'IMPORT')
    this.pos = importKw.newPos
    const moduleResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = moduleResult.newPos
    const module = moduleResult.token.value
    if (module !== 'chords') {
      throw new Error(`Unknown import "${module}". v1.1 supports only \`import chords\` (§6).`)
    }
    return { statement: { type: 'import', module }, newPos: this.pos }
  }

  /**
   * Parse `var NAME = <play-expr>` (§6.5): a pattern binding. The RHS is a run of
   * top-level play siblings (a group, a juxtaposition `(...)(...)`, or a chained /
   * `*n` form), parsed exactly like inline play-args (collapseScopedRun + the
   * `*n`/chain postfix) minus the wrapping parens. Terminates at the statement end.
   * A top-level comma is rejected (§6.5 Q2): a binding is a single root-scope cell
   * or a juxtaposition run, not a comma list.
   */
  private parsePatternBinding(variableName: string): { statement: PatternBinding; newPos: number } {
    const elements: PlayElement[] = []
    let runStart = 0

    for (;;) {
      const argParser = new ExpressionParser(this.tokens, this.pos)
      const argResult = argParser.parseArgument()
      this.pos = argResult.newPos
      elements.push(argResult.value)
      collapseScopedRun(elements, runStart)

      const lastIdx = elements.length - 1
      const post = new ExpressionParser(this.tokens, this.pos).parsePostfix(elements[lastIdx]!)
      if (post.changed) {
        this.pos = post.newPos
        elements[lastIdx] = post.value as PlayElement
        runStart = lastIdx
      }

      const t = ParserUtils.current(this.tokens, this.pos).type
      if (t === 'COMMA') {
        throw new Error(
          'a pattern binding is a single cell or a juxtaposition run; ' +
            'use juxtaposition `(...)(...)`, not commas (§6.5).',
        )
      }
      if (t === 'LPAREN') {
        continue // juxtaposition: another group with no comma
      }
      break // NEWLINE / EOF / end of statement
    }

    return { statement: { type: 'pattern_binding', variableName, elements }, newPos: this.pos }
  }

  /**
   * Parse global initialization (init GLOBAL)
   */
  private parseGlobalInit(variableName: string): {
    statement: GlobalInit | SequenceInit
    newPos: number
  } {
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
          statement: { type: 'seq_init', variableName },
          newPos: this.pos,
        }
      }
    }

    return {
      statement: { type: 'global_init', variableName },
      newPos: this.pos,
    }
  }

  /**
   * Parse sequence initialization (init variable.seq)
   */
  private parseSequenceInit(variableName: string): { statement: SequenceInit; newPos: number } {
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
            variableName,
            globalVariable: globalVarResult.token.value,
          },
          newPos: this.pos,
        }
      }
    }

    // If not .seq, it might be another type of initialization
    throw new Error(`Unexpected initialization: init ${globalVarResult.token.value}`)
  }

  /**
   * Parse method call (dispatcher)
   */
  private parseMethodCall(): { statement: Statement | null; newPos: number } {
    const targetResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = targetResult.newPos
    const target = targetResult.token.value

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    if (ParserUtils.current(this.tokens, this.pos).type !== 'DOT') {
      // Identifier without method call (invalid syntax, skip it)
      return { statement: null, newPos: this.pos }
    }

    const dotResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = dotResult.newPos
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    const methodResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
    this.pos = methodResult.newPos
    const method = methodResult.token.value

    // Check for .force modifier
    if (
      ParserUtils.current(this.tokens, this.pos).type === 'DOT' &&
      ParserUtils.peek(this.tokens, this.pos).value === 'force'
    ) {
      return this.parseForceModifier(target, method)
    }

    // Parse method with arguments
    if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
      return this.parseMethodWithArguments(target, method)
    }

    // Method without parentheses (transport commands)
    return this.parseTransportCommand(target, method)
  }

  /**
   * Parse .force modifier
   */
  private parseForceModifier(
    target: string,
    method: string,
  ): { statement: Statement; newPos: number } {
    const forceDotResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = forceDotResult.newPos
    const forceResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = forceResult.newPos

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

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

  /**
   * Parse method with arguments and optional chaining
   */
  private parseMethodWithArguments(
    target: string,
    method: string,
  ): { statement: Statement; newPos: number } {
    const argsResult = this.parseArguments()
    this.pos = argsResult.newPos

    // Check if this is a transport command
    const transportCommands = ['start', 'loop', 'run', 'mute']
    if (transportCommands.includes(method)) {
      return {
        statement: {
          type: 'transport',
          target,
          command: method,
          sequences: argsResult.args,
        },
        newPos: this.pos,
      }
    }

    // Check for method chaining (e.g., .audio(...).chop(...))
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    const chain = this.parseMethodChain()

    // Note: We cannot determine if target is global or sequence at parse time
    // since variable names are arbitrary. Use 'sequence' type and let the interpreter
    // determine the actual type by checking state.globals and state.sequences.
    const result: any = {
      type: 'sequence',
      target,
      method,
      args: argsResult.args,
    }

    if (chain.length > 0) {
      result.chain = chain
    }

    return { statement: result, newPos: this.pos }
  }

  /**
   * Parse method chaining (e.g., .audio(...).chop(...))
   */
  private parseMethodChain(): MethodChain[] {
    const chain: MethodChain[] = []

    // Allow newlines between chained methods
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    let current = ParserUtils.current(this.tokens, this.pos)

    while (current.type === 'DOT') {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      const chainDotResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = chainDotResult.newPos
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      const chainMethodResult = ParserUtils.expect(this.tokens, this.pos, 'IDENTIFIER')
      this.pos = chainMethodResult.newPos
      const chainMethod = chainMethodResult.token.value

      // Check if chained method has arguments
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'LPAREN') {
        const chainArgsResult = this.parseArguments()
        this.pos = chainArgsResult.newPos
        chain.push({ method: chainMethod, args: chainArgsResult.args })
      } else {
        chain.push({ method: chainMethod, args: [] })
      }

      // Update current for next iteration
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      current = ParserUtils.current(this.tokens, this.pos)
    }

    return chain
  }

  /**
   * Parse transport command (method without parentheses)
   */
  private parseTransportCommand(
    target: string,
    command: string,
  ): { statement: Statement; newPos: number } {
    return {
      statement: {
        type: 'transport',
        target,
        command,
      },
      newPos: this.pos,
    }
  }

  /**
   * Parse reserved keyword (RUN, LOOP, MUTE)
   */
  private parseReservedKeyword(): { statement: Statement; newPos: number } {
    const keywordToken = ParserUtils.current(this.tokens, this.pos)
    const command = keywordToken.value.toLowerCase()
    this.pos = ParserUtils.advance(this.tokens, this.pos).newPos

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    // Expect opening parenthesis
    if (ParserUtils.current(this.tokens, this.pos).type !== 'LPAREN') {
      throw new Error(`Expected opening parenthesis after ${keywordToken.value}`)
    }

    // Parse sequence names
    const argsResult = this.parseArguments()
    this.pos = argsResult.newPos

    // Convert arguments to sequence names (expect identifiers)
    const sequences: string[] = []
    for (const arg of argsResult.args) {
      if (typeof arg === 'string') {
        sequences.push(arg)
      } else {
        throw new Error(`Expected sequence name, got ${JSON.stringify(arg)}`)
      }
    }

    return {
      statement: {
        type: 'transport',
        target: '__RESERVED_KEYWORD__', // Special marker for reserved keywords (RUN/LOOP/MUTE)
        command,
        sequences,
      },
      newPos: this.pos,
    }
  }

  /**
   * Parse method arguments
   */
  private parseArguments(): { args: any[]; newPos: number } {
    const lparenResult = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
    this.pos = lparenResult.newPos
    const args: any[] = []
    // Index where the current juxtaposition run began (reset after each comma).
    // A `.root()/.mode()/.oct()` chain collapses the run since this index (§3).
    let runStart = 0

    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RPAREN' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'RPAREN') {
        break
      }
      const expressionParser = new ExpressionParser(this.tokens, this.pos)
      const argResult = expressionParser.parseArgument()
      this.pos = argResult.newPos
      // A scope chain (PlayScoped) applies to the whole juxtaposition run: pull
      // the preceding sibling groups (since the last comma) into its groups so
      // `(A)(B).root(X)` shares one scope. No-chain `(A)(B)` stays separate.
      args.push(argResult.value)
      collapseScopedRun(args, runStart)

      // §6.5 / §3 postfix on the just-completed arg (`*n`, then a chain). Shared
      // with the nested-level parser via ExpressionParser.parsePostfix.
      const lastIdx = args.length - 1
      const postParser = new ExpressionParser(this.tokens, this.pos)
      const post = postParser.parsePostfix(args[lastIdx])
      if (post.changed) {
        this.pos = post.newPos
        args[lastIdx] = post.value
        runStart = lastIdx // a *n / chain closes the juxtaposition run (§6.5 Q1)
      }

      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'COMMA') {
        const commaResult = ParserUtils.advance(this.tokens, this.pos)
        this.pos = commaResult.newPos
        this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
        runStart = args.length // comma ends the run
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

    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos
    return { args, newPos: this.pos }
  }
}
