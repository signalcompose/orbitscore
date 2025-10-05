/**
 * Audio-based DSL Parser
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 *
 * This is the new parser for the audio-based OrbitScore DSL.
 */

// Token types for the audio DSL
export type AudioTokenType =
  | 'VAR' // var keyword
  | 'INIT' // init keyword
  | 'BY' // by keyword (for meter)
  | 'GLOBAL' // GLOBAL constant
  | 'IDENTIFIER' // variable names, method names
  | 'NUMBER' // numeric values
  | 'STRING' // string literals
  | 'DOT' // . (method call)
  | 'LPAREN' // (
  | 'RPAREN' // )
  | 'COMMA' // ,
  | 'EQUALS' // =
  | 'MINUS' // - (for negative numbers)
  | 'NEWLINE' // line break
  | 'EOF' // end of file

export type AudioToken = {
  type: AudioTokenType
  value: string
  line: number
  column: number
}

/**
 * Tokenizer for the audio-based DSL
 */
export class AudioTokenizer {
  private src: string
  private pos: number = 0
  private line: number = 1
  private column: number = 1

  // Keywords that should be recognized
  private static readonly KEYWORDS = new Set(['var', 'init', 'by', 'GLOBAL', 'force'])

  constructor(src: string) {
    this.src = src
  }

  private isEOF(): boolean {
    return this.pos >= this.src.length
  }

  private peek(offset: number = 0): string {
    const pos = this.pos + offset
    return pos >= this.src.length ? '\0' : this.src[pos]!
  }

  private advance(): string {
    if (this.isEOF()) return '\0'
    const char = this.src[this.pos++]!
    if (char === '\n') {
      this.line++
      this.column = 1
    } else {
      this.column++
    }
    return char
  }

  private skipWhitespace(): void {
    while (!this.isEOF() && /\s/.test(this.peek()) && this.peek() !== '\n') {
      this.advance()
    }
  }

  private skipComment(): void {
    if (this.peek() === '/' && this.peek(1) === '/') {
      // Single-line comment
      while (!this.isEOF() && this.peek() !== '\n') {
        this.advance()
      }
    }
  }

  private readNumber(): string {
    let num = ''
    while (!this.isEOF() && /[0-9]/.test(this.peek())) {
      num += this.advance()
    }
    // Handle decimal point
    if (this.peek() === '.' && /[0-9]/.test(this.peek(1))) {
      num += this.advance() // consume '.'
      while (!this.isEOF() && /[0-9]/.test(this.peek())) {
        num += this.advance()
      }
    }
    return num
  }

  private readIdentifier(): string {
    let id = ''
    while (!this.isEOF() && /[a-zA-Z0-9_]/.test(this.peek())) {
      id += this.advance()
    }
    return id
  }

  private readString(): string {
    const quote = this.advance() // consume opening quote
    let str = ''
    while (!this.isEOF() && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.advance() // consume backslash
        if (!this.isEOF()) {
          str += this.advance() // add escaped character
        }
      } else {
        str += this.advance()
      }
    }
    if (!this.isEOF()) {
      this.advance() // consume closing quote
    }
    return str
  }

  public tokenize(): AudioToken[] {
    const tokens: AudioToken[] = []

    while (!this.isEOF()) {
      this.skipWhitespace()
      this.skipComment()

      if (this.isEOF()) break

      const line = this.line
      const column = this.column
      const char = this.peek()

      // Newline
      if (char === '\n') {
        tokens.push({ type: 'NEWLINE', value: '\n', line, column })
        this.advance()
        continue
      }

      // Numbers
      if (/[0-9]/.test(char)) {
        const num = this.readNumber()
        tokens.push({ type: 'NUMBER', value: num, line, column })
        continue
      }

      // Identifiers and keywords
      if (/[a-zA-Z_]/.test(char)) {
        const id = this.readIdentifier()
        const type = AudioTokenizer.KEYWORDS.has(id)
          ? (id.toUpperCase() as AudioTokenType)
          : 'IDENTIFIER'
        tokens.push({ type, value: id, line, column })
        continue
      }

      // Strings
      if (char === '"' || char === "'") {
        const str = this.readString()
        tokens.push({ type: 'STRING', value: str, line, column })
        continue
      }

      // Single character tokens
      switch (char) {
        case '.':
          tokens.push({ type: 'DOT', value: '.', line, column })
          this.advance()
          break
        case '(':
          tokens.push({ type: 'LPAREN', value: '(', line, column })
          this.advance()
          break
        case ')':
          tokens.push({ type: 'RPAREN', value: ')', line, column })
          this.advance()
          break
        case ',':
          tokens.push({ type: 'COMMA', value: ',', line, column })
          this.advance()
          break
        case '=':
          tokens.push({ type: 'EQUALS', value: '=', line, column })
          this.advance()
          break
        case '-':
          tokens.push({ type: 'MINUS', value: '-', line, column })
          this.advance()
          break
        default:
          // Skip unknown characters
          this.advance()
      }
    }

    tokens.push({ type: 'EOF', value: '', line: this.line, column: this.column })
    return tokens
  }
}

/**
 * IR types for the audio-based DSL
 */
export type AudioIR = {
  globalInit?: GlobalInit
  sequenceInits: SequenceInit[]
  statements: Statement[]
}

export type GlobalInit = {
  type: 'global_init'
  variableName: string
}

export type SequenceInit = {
  type: 'seq_init'
  variableName: string
  globalVariable?: string // For new syntax: init global.seq
}

export type Statement = GlobalStatement | SequenceStatement | TransportStatement

export type GlobalStatement = {
  type: 'global'
  method: string
  args: any[]
}

export type SequenceStatement = {
  type: 'sequence'
  target: string
  method: string
  args: any[]
  chain?: MethodChain[]
}

export type MethodChain = {
  method: string
  args: any[]
}

// Play structure types
export type PlayElement =
  | number // slice number (e.g., 1, 2, 3)
  | PlayNested // nested structure (e.g., (1)(2))
  | PlayWithModifier // with .chop(), .time(), etc.

export type PlayNested = {
  type: 'nested'
  elements: PlayElement[]
}

export type PlayWithModifier = {
  type: 'modified'
  value: number | PlayNested
  modifiers: PlayModifier[]
}

export type PlayModifier = {
  method: 'chop' | 'time' | 'fixpitch'
  value: number
}

export type TransportStatement = {
  type: 'transport'
  target: string
  command: string
  force?: boolean
  sequences?: string[]
}

export type Meter = {
  numerator: number
  denominator: number
}

export type CompositeMeter = {
  meters: Meter[]
  repeat?: number
}

/**
 * Parser for the audio-based DSL
 */
export class AudioParser {
  private tokens: AudioToken[]
  private pos: number = 0

  constructor(tokens: AudioToken[]) {
    this.tokens = tokens
  }

  private isEOF(): boolean {
    return this.pos >= this.tokens.length || this.current().type === 'EOF'
  }

  private current(): AudioToken {
    return this.tokens[this.pos] || { type: 'EOF', value: '', line: 0, column: 0 }
  }

  private peek(offset: number = 1): AudioToken {
    return this.tokens[this.pos + offset] || { type: 'EOF', value: '', line: 0, column: 0 }
  }

  private advance(): AudioToken {
    const token = this.current()
    if (!this.isEOF()) this.pos++
    return token
  }

  private expect(type: AudioTokenType): AudioToken {
    const token = this.current()
    if (token.type !== type) {
      throw new Error(
        `Expected ${type} but got ${token.type} at line ${token.line}, column ${token.column}`,
      )
    }
    return this.advance()
  }

  private skipNewlines(): void {
    while (this.current().type === 'NEWLINE') {
      this.advance()
    }
  }

  public parse(): AudioIR {
    const result: AudioIR = {
      sequenceInits: [],
      statements: [],
    }

    this.skipNewlines()

    while (!this.isEOF()) {
      this.skipNewlines()
      if (this.isEOF()) break

      const stmt = this.parseStatement()
      if (stmt) {
        // Handle different statement types
        if (stmt.type === 'global_init') {
          result.globalInit = stmt as GlobalInit
        } else if (stmt.type === 'seq_init') {
          result.sequenceInits.push(stmt as SequenceInit)
        } else {
          result.statements.push(stmt as Statement)
        }
      }

      this.skipNewlines()
    }

    return result
  }

  private parseStatement(): any {
    const token = this.current()

    // Variable declaration: var x = init GLOBAL
    if (token.type === 'VAR') {
      return this.parseVarDeclaration()
    }

    // Method calls: global.tempo(140) or seq1.play(0)
    if (token.type === 'IDENTIFIER') {
      return this.parseMethodCall()
    }

    // Skip unknown tokens
    this.advance()
    return null
  }

  private parseVarDeclaration(): any {
    this.expect('VAR')
    const varName = this.expect('IDENTIFIER').value
    this.expect('EQUALS')
    this.expect('INIT')

    // Check for GLOBAL (global initialization)
    if (this.current().type === 'GLOBAL' || this.current().value === 'GLOBAL') {
      this.advance()
      // Check if it's GLOBAL.seq (old syntax, still support for backward compatibility)
      if (this.current().type === 'DOT') {
        this.advance()
        if (this.current().value === 'seq') {
          this.advance()
          return { type: 'seq_init', variableName: varName }
        }
      }
      return { type: 'global_init', variableName: varName }
    }

    // Check for variable.seq (new syntax: init global.seq)
    if (this.current().type === 'IDENTIFIER') {
      const globalVar = this.advance().value
      if (this.current().type === 'DOT') {
        this.advance()
        if (this.current().value === 'seq') {
          this.advance()
          return { type: 'seq_init', variableName: varName, globalVariable: globalVar }
        }
      }
      // If not .seq, it might be another type of initialization
      throw new Error(`Unexpected initialization: init ${globalVar}`)
    }

    throw new Error('Expected GLOBAL or variable name after init')
  }

  private parseMethodCall(): any {
    const target = this.expect('IDENTIFIER').value

    if (this.current().type === 'DOT') {
      this.advance()
      const method = this.expect('IDENTIFIER').value

      // Handle special case for .force modifier
      if (this.current().type === 'DOT' && this.peek().value === 'force') {
        this.advance()
        this.advance()
        // This is a transport command with force
        if (this.current().type === 'LPAREN') {
          // Transport with arguments (e.g., global.loop(seq1, seq2))
          const args = this.parseArguments()
          return {
            type: 'transport',
            target,
            command: method,
            force: true,
            sequences: args,
          }
        }
        return {
          type: 'transport',
          target,
          command: method,
          force: true,
        }
      }

      // Parse method arguments
      if (this.current().type === 'LPAREN') {
        const args = this.parseArguments()

        // Check for method chaining (e.g., .audio(...).chop(...))
        const chain: MethodChain[] = []
        while (this.current().type === 'DOT') {
          this.advance()
          const chainMethod = this.expect('IDENTIFIER').value

          // Check if chained method has arguments
          if (this.current().type === 'LPAREN') {
            const chainArgs = this.parseArguments()
            chain.push({ method: chainMethod, args: chainArgs })
          } else {
            chain.push({ method: chainMethod, args: [] })
          }
        }

        const result: any = {
          type: target === 'global' ? 'global' : 'sequence',
          target,
          method,
          args,
        }

        if (chain.length > 0) {
          result.chain = chain
        }

        return result
      }

      // Method without parentheses (transport commands)
      return {
        type: 'transport',
        target,
        command: method,
      }
    }

    return null
  }

  private parseArguments(): any[] {
    this.expect('LPAREN')
    const args: any[] = []

    while (this.current().type !== 'RPAREN' && !this.isEOF()) {
      args.push(this.parseArgument())

      if (this.current().type === 'COMMA') {
        this.advance()
      } else if (this.current().type === 'RPAREN') {
        // End of arguments
        break
      } else if (this.current().type === 'LPAREN') {
        // Special case: consecutive nested elements like (1)(2)
        // Continue parsing without requiring comma
        continue
      } else {
        throw new Error('Expected comma or closing parenthesis')
      }
    }

    this.expect('RPAREN')
    return args
  }

  private parseArgument(): any {
    const token = this.current()

    // Handle negative numbers (MINUS followed by NUMBER)
    if (token.type === 'MINUS') {
      this.advance() // consume MINUS
      const numToken = this.expect('NUMBER')
      const value = -parseFloat(numToken.value)
      return value
    }

    // Numbers
    if (token.type === 'NUMBER') {
      const value = parseFloat(this.advance().value)

      // Check for "n by m" meter syntax
      if (this.current().type === 'BY') {
        this.advance()
        const denominator = this.expect('NUMBER')
        return { numerator: value, denominator: parseFloat(denominator.value) }
      }

      // Check for play modifiers (.chop, .time, .fixpitch)
      if (this.current().type === 'DOT') {
        return this.parsePlayWithModifier(value)
      }

      return value
    }

    // Strings
    if (token.type === 'STRING') {
      return this.advance().value
    }

    // Identifiers (for key names like C, D, etc.)
    if (token.type === 'IDENTIFIER') {
      const value = this.advance().value

      // Check for "n by m" meter syntax (shouldn't happen with identifiers, but keep for safety)
      if (this.current().type === 'BY') {
        this.advance()
        const denominator = this.parseArgument()
        return { numerator: parseInt(value), denominator }
      }

      return value
    }

    // Nested play structures or composite meters
    if (token.type === 'LPAREN') {
      // Look ahead to determine if this is a play structure or meter
      const lookahead = this.peek()
      if (lookahead.type === 'NUMBER') {
        const lookahead2 = this.peek(2)
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

  private parsePlayWithModifier(value: number | PlayNested): PlayWithModifier {
    const modifiers: PlayModifier[] = []

    while (this.current().type === 'DOT') {
      this.advance()
      const method = this.expect('IDENTIFIER').value

      if (method === 'chop' || method === 'time' || method === 'fixpitch') {
        this.expect('LPAREN')
        const arg = this.expect('NUMBER')
        this.expect('RPAREN')
        modifiers.push({
          method: method as 'chop' | 'time' | 'fixpitch',
          value: parseFloat(arg.value),
        })
      }
    }

    return {
      type: 'modified',
      value,
      modifiers,
    }
  }

  private parseNestedPlay(): PlayNested {
    const elements: PlayElement[] = []

    // Parse nested structure like ((1)(2)) or (1, 2, 3)
    this.expect('LPAREN')

    while (this.current().type !== 'RPAREN' && !this.isEOF()) {
      if (this.current().type === 'LPAREN') {
        // Nested element
        elements.push(this.parseNestedPlay())
      } else if (this.current().type === 'NUMBER') {
        const value = parseFloat(this.advance().value)

        // Check for modifiers
        if (this.current().type === 'DOT') {
          elements.push(this.parsePlayWithModifier(value))
        } else {
          elements.push(value)
        }
      }

      // Handle comma or continue
      if (this.current().type === 'COMMA') {
        this.advance()
      } else if (this.current().type === 'RPAREN') {
        // End of this nested structure
        break
      } else if (this.current().type === 'LPAREN') {
        // Another nested element, continue the loop
        continue
      } else {
        // Unexpected token
        break
      }
    }

    this.expect('RPAREN')

    // Check for modifiers on the nested structure itself
    if (this.current().type === 'DOT') {
      return this.parsePlayWithModifier({ type: 'nested', elements }) as any
    }

    return { type: 'nested', elements }
  }

  private parseCompositeMeter(): CompositeMeter {
    const meters: Meter[] = []

    while (this.current().type === 'LPAREN') {
      this.advance()
      const num = this.expect('NUMBER')
      this.expect('BY')
      const den = this.expect('NUMBER')
      this.expect('RPAREN')

      meters.push({
        numerator: parseInt(num.value),
        denominator: parseInt(den.value),
      })
    }

    return { meters }
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
