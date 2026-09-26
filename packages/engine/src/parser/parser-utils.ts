/**
 * Parser utility functions for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import { degreeToSemitone } from '../midi/degree-resolution'

import {
  AudioToken,
  AudioTokenType,
  PlayElement,
  PlayPitch,
  PlayRandomDegree,
  RandomBinding,
} from './types'

export function isPitchModifierToken(token: AudioToken): boolean {
  return (
    token.type === 'CARET' ||
    token.type === 'TILDE' ||
    token.type === 'AT' ||
    (token.type === 'IDENTIFIER' && token.value === 'r')
  )
}

/** Stack-internal ^N is structural and never updates the melodic running range. */
export function asStackVoice<T extends PlayPitch | PlayRandomDegree>(pitch: T): T {
  return pitch.rangeSet ? { ...pitch, rangeSet: false } : pitch
}

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

type PitchBase = { type: 'pitch'; degree: number; alteration: number }
type RandomDegreeBase = { type: 'random_degree'; initialRandom?: number }

function parseSignedNumber(tokens: AudioToken[], start: number): { value: number; newPos: number } {
  let pos = start
  let sign = 1
  const type = ParserUtils.current(tokens, pos).type
  if (type === 'PLUS') pos = ParserUtils.advance(tokens, pos).newPos
  else if (type === 'MINUS') {
    sign = -1
    pos = ParserUtils.advance(tokens, pos).newPos
  }
  const number = ParserUtils.expect(tokens, pos, 'NUMBER')
  return { value: sign * ParserUtils.parseNumber(number.token), newPos: number.newPos }
}

export function parsePitchModifiers(
  tokens: AudioToken[],
  pos: number,
  base: PitchBase,
): { value: PlayPitch; newPos: number }
export function parsePitchModifiers(
  tokens: AudioToken[],
  pos: number,
  base: RandomDegreeBase,
): { value: PlayRandomDegree; newPos: number }
export function parsePitchModifiers(
  tokens: AudioToken[],
  start: number,
  base: PitchBase | RandomDegreeBase,
): { value: PlayPitch | PlayRandomDegree; newPos: number } {
  let pos = start
  let octaveShift = 0
  let rangeSet = false
  let detune = 0
  let random = base.type === 'random_degree' ? base.initialRandom : undefined
  let randomOctave = false
  let velocity: number | undefined
  let velocityDelta: number | undefined
  let articulation: number | undefined

  for (;;) {
    const current = ParserUtils.current(tokens, pos)
    if (current.type === 'AT') {
      pos = ParserUtils.advance(tokens, pos).newPos
      const sub = ParserUtils.current(tokens, pos)
      const raw = sub.type === 'IDENTIFIER' ? String(sub.value) : ''
      const kind = raw[0]
      const rest = raw.slice(1)
      if (kind !== 'v' && kind !== 'g') {
        throw new Error(`expected @v (velocity) or @g (articulation), got @${raw || '?'}`)
      }
      if (rest !== '' && !/^\d+$/.test(rest)) {
        throw new Error(`@${kind} expects an integer, e.g. @v100 or @g30 (got @${raw})`)
      }
      pos = ParserUtils.advance(tokens, pos).newPos
      if (kind === 'v') {
        if (rest === '') {
          const next = ParserUtils.current(tokens, pos).type
          if (next !== 'PLUS' && next !== 'MINUS') {
            throw new Error('@v needs a value, e.g. @v100 or @v+20')
          }
          const parsed = parseSignedNumber(tokens, pos)
          velocityDelta = parsed.value
          pos = parsed.newPos
        } else velocity = Math.max(1, Math.min(127, parseInt(rest, 10)))
      } else {
        if (rest === '') throw new Error('@g needs a gate percent, e.g. @g30 (= 0.30)')
        articulation = parseInt(rest, 10) / 100
      }
      continue
    }
    if (current.type === 'CARET') {
      pos = ParserUtils.advance(tokens, pos).newPos
      const after = ParserUtils.current(tokens, pos)
      if (after.type === 'IDENTIFIER' && after.value === 'r') {
        pos = ParserUtils.advance(tokens, pos).newPos
        randomOctave = true
      } else {
        const parsed = parseSignedNumber(tokens, pos)
        octaveShift = parsed.value
        pos = parsed.newPos
        rangeSet = true
      }
      continue
    }
    if (current.type === 'TILDE') {
      const parsed = parseSignedNumber(tokens, ParserUtils.advance(tokens, pos).newPos)
      detune = parsed.value
      pos = parsed.newPos
      continue
    }
    if (current.type === 'IDENTIFIER' && current.value === 'r') {
      pos = ParserUtils.advance(tokens, pos).newPos
      random = 0.5
      continue
    }
    break
  }

  const modifiers = {
    octaveShift,
    rangeSet,
    detune,
    ...(random !== undefined && { random }),
    ...(randomOctave && { randomOctave: true as const }),
    ...(velocity !== undefined && { velocity }),
    ...(velocityDelta !== undefined && { velocityDelta }),
    ...(articulation !== undefined && { articulation }),
  }
  return base.type === 'random_degree'
    ? { value: { type: 'random_degree', ...modifiers }, newPos: pos }
    : {
        value: {
          type: 'pitch',
          degree: base.degree,
          alteration: base.alteration,
          ...modifiers,
        },
        newPos: pos,
      }
}

export type PlayIdentifierKind =
  | 'value'
  | 'random_value'
  | 'random_degree'
  | 'optional_random_degree'
  | 'reference'

/** Disambiguate random values, random degrees, and names in a play-element position. */
export function classifyPlayIdentifier(
  token: AudioToken,
  next: AudioToken,
  forceReference: boolean,
): PlayIdentifierKind {
  if (ParserUtils.isBooleanLiteral(token.value)) return 'value'
  if (
    (ParserUtils.isRandomSyntax(token.value) && next.type === 'PERCENT') ||
    (token.value === 'r' && next.type === 'MINUS')
  ) {
    return 'random_value'
  }
  if (token.value === 'r') return 'random_degree'
  if (token.value === 'rr') return 'optional_random_degree'
  const startsModifier =
    next.type === 'CARET' ||
    next.type === 'TILDE' ||
    next.type === 'AT' ||
    (next.type === 'IDENTIFIER' && next.value === 'r')
  return forceReference || ParserUtils.isRandomSyntax(token.value) || startsModifier
    ? 'reference'
    : 'value'
}

const RESERVED_RANDOM_BINDING_NAME_DIAGNOSTIC =
  'r / rr は音高の乱数として予約されています。' +
  '別の名前を使ってください（例: var r1 = random.dorian）'
const RANDOM_BINDING_SOURCE_DIAGNOSTIC =
  'random の後に mode 変数の名前を書いてください（例: var r1 = random.dorian）'

export function assertRandomBindingName(name: string): void {
  if (name === 'r' || name === 'rr') throw new Error(RESERVED_RANDOM_BINDING_NAME_DIAGNOSTIC)
}

export function parseRandomBinding(
  tokens: AudioToken[],
  start: number,
  name: string,
): { statement: RandomBinding; newPos: number } {
  let pos = ParserUtils.advance(tokens, start).newPos // random
  if (ParserUtils.current(tokens, pos).type !== 'DOT') {
    throw new Error(RANDOM_BINDING_SOURCE_DIAGNOSTIC)
  }
  pos = ParserUtils.advance(tokens, pos).newPos
  const source = ParserUtils.current(tokens, pos)
  if (source.type !== 'IDENTIFIER') throw new Error(RANDOM_BINDING_SOURCE_DIAGNOSTIC)
  pos = ParserUtils.advance(tokens, pos).newPos
  if (ParserUtils.current(tokens, pos).type === 'LPAREN') {
    throw new Error('random.<mode変数> does not accept call form; write `var r1 = random.dorian`')
  }
  return { statement: { type: 'random_binding', name, source: source.value }, newPos: pos }
}

/** Semitone offset of one root-scope `mode(...)` element (§2.2). */
export function modeElementSemitone(element: PlayElement): number {
  if (typeof element === 'number') {
    if (element === 0) throw new Error('mode(…) に 0（休符）は書けません')
    return degreeToSemitone(element)
  }
  if (element && typeof element === 'object' && element.type === 'pitch') {
    if (element.degree === 0) throw new Error('mode(…) に 0（休符）は書けません')
    return degreeToSemitone(element.degree, element.alteration, element.octaveShift)
  }
  throw new Error('mode(...) elements must be degrees (e.g. mode(1, 2, b3, 4, 5, 6, b7))')
}
