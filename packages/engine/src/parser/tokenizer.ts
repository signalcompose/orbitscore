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
    'STOP',
    'MUTE',
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
