/**
 * Tokenizer for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import { AudioToken, AudioTokenType } from './types'

/**
 * Tokenizer for the audio-based DSL
 */
export class AudioTokenizer {
  private src: string
  private pos: number = 0
  private line: number = 1
  private column: number = 1

  // Keywords that should be recognized
  private static readonly KEYWORDS = new Set([
    'var',
    'init',
    'by',
    'GLOBAL',
    'force',
    'RUN',
    'LOOP',
    'MUTE',
    'import',
  ])

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

  /**
   * Count a run of flat markers (`b`) starting at the current position that
   * forms a pitch alteration, i.e. one or more `b` immediately followed by a
   * digit (the degree). Returns 0 when the `b` run is not an alteration (so it
   * falls through to identifier reading — e.g. a variable literally named `b`).
   *
   * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1 (`b` = -1, `bb` = -2).
   */
  private peekFlatAlterationRun(): number {
    let i = 0
    while (this.peek(i) === 'b') i++
    return i > 0 && /[0-9]/.test(this.peek(i)) ? i : 0
  }

  /** Read a run of identical accidental characters (`#...` or `b...`). */
  private readAccidentalRun(marker: string): string {
    let run = ''
    while (this.peek() === marker) {
      run += this.advance()
    }
    return run
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

      // Pitch alteration prefixes: `#`/`##` and `b`/`bb` (followed by a degree).
      // The audio DSL comments with `//`, so `#` never collides with a comment
      // (verified: no existing .orbs uses bare `#`). A `b` run is an alteration
      // only when followed by a digit; otherwise it falls through to identifier
      // reading so a variable named `b` still works.
      if (char === '#') {
        const run = this.readAccidentalRun('#')
        tokens.push({ type: 'ACCIDENTAL', value: run, line, column })
        continue
      }
      const flatRun = this.peekFlatAlterationRun()
      if (flatRun > 0) {
        const run = this.readAccidentalRun('b')
        tokens.push({ type: 'ACCIDENTAL', value: run, line, column })
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
        case '+':
          tokens.push({ type: 'PLUS', value: '+', line, column })
          this.advance()
          break
        case '^':
          tokens.push({ type: 'CARET', value: '^', line, column })
          this.advance()
          break
        case '~':
          tokens.push({ type: 'TILDE', value: '~', line, column })
          this.advance()
          break
        case '[':
          tokens.push({ type: 'LBRACKET', value: '[', line, column })
          this.advance()
          break
        case ']':
          tokens.push({ type: 'RBRACKET', value: ']', line, column })
          this.advance()
          break
        case '%':
          tokens.push({ type: 'PERCENT', value: '%', line, column })
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
