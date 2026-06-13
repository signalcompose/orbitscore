/**
 * Expression parsing for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

import { noteNameToPitchClass } from '../midi/note-name'

import {
  AudioToken,
  RandomValue,
  PlayElement,
  PlayNested,
  PlayWithModifier,
  PlayModifier,
  PlayPitch,
  PlayScoped,
  PlayStack,
  StackElement,
  PlayChordRef,
  PlayChordRemoval,
  ScopeRoot,
  ScopeMode,
  Meter,
} from './types'
import { ParserUtils } from './parser-utils'

/**
 * If the last element of `list` is a scope chain (PlayScoped) and there are
 * preceding sibling groups since `runStart`, collapse the juxtaposition run
 * into its `groups`, so `(A)(B).root(X)` shares one scope (§3). No-op otherwise
 * — a no-chain run stays as separate siblings. Shared by the nested-level
 * (ExpressionParser) and statement-level (StatementParser) parse loops; both
 * call it AFTER pushing the just-parsed element, so the run rule lives in one
 * place (the pre-/post-push arithmetic is otherwise an easy source of drift).
 */
export function collapseScopedRun(list: PlayElement[], runStart: number): void {
  const lastIdx = list.length - 1
  const last = list[lastIdx]
  if (last && typeof last === 'object' && last.type === 'scoped' && runStart < lastIdx) {
    const preceding = list.splice(runStart, lastIdx - runStart)
    last.groups = [...preceding, ...last.groups]
  }
}

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

    if (token.type === 'ACCIDENTAL') {
      return this.parsePitch()
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

    if (token.type === 'LBRACKET') {
      return this.parseStack()
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

    // Check for pitch modifiers (^ octave shift, ~ detune) → bare degree becomes
    // a PlayPitch (e.g. 3^+1, 7~-0.25). A bare integer with no modifier stays a
    // plain number so audio slice-number parsing is unaffected.
    const afterNum = ParserUtils.current(this.tokens, this.pos).type
    if (afterNum === 'CARET' || afterNum === 'TILDE') {
      return this.parsePitchModifiers(value, 0)
    }

    return { value, newPos: this.pos }
  }

  /**
   * Convert an accidental run ("#", "##", "b", "bb") to a semitone offset.
   * Spec §2.1: b=-1, #=+1, bb/##=±2; duplicates allowed but warn beyond 2.
   */
  private accidentalToAlteration(run: string): number {
    const sign = run[0] === '#' ? 1 : -1
    if (run.length > 2) {
      console.warn(
        `⚠️  Accidental "${run}" has ${run.length} markers; the spec recommends at most 2 (bb / ##).`,
      )
    }
    return sign * run.length
  }

  /** Read an optional +/- sign followed by a NUMBER and return the signed value. */
  private parseSignedNumber(): number {
    let sign = 1
    const t = ParserUtils.current(this.tokens, this.pos).type
    if (t === 'PLUS') {
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
    } else if (t === 'MINUS') {
      sign = -1
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
    }
    const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = numResult.newPos
    return sign * ParserUtils.parseNumber(numResult.token)
  }

  /**
   * Parse optional `^` (pitch range set-point) and `~` (detune) modifiers onto a
   * degree, producing a PlayPitch. Both modifiers are optional and order-
   * independent. `^N` is STICKY (§2.4): it records `octaveShift` AND sets
   * `rangeSet`, marking this note as a running-range set point — the value
   * propagates to subsequent degrees in the play() (threaded at dispatch) until
   * another `^M`/`^0` overrides it. The parser only records the per-note
   * annotation; the running range is applied during scheduling, not here.
   */
  private parsePitchModifiers(
    degree: number,
    alteration: number,
  ): { value: PlayPitch; newPos: number } {
    let octaveShift = 0
    let rangeSet = false
    let detune = 0
    let parsed = true
    while (parsed) {
      parsed = false
      const t = ParserUtils.current(this.tokens, this.pos).type
      if (t === 'CARET') {
        // `^N` sets the sticky pitch range (§2.4). rangeSet marks this note as a
        // running-range set point so the scheduling walk persists it onward.
        this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
        octaveShift = this.parseSignedNumber()
        rangeSet = true
        parsed = true
      } else if (t === 'TILDE') {
        this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
        detune = this.parseSignedNumber()
        parsed = true
      }
    }
    return {
      value: { type: 'pitch', degree, alteration, octaveShift, rangeSet, detune },
      newPos: this.pos,
    }
  }

  /** Parse an accidental-prefixed pitch: ACCIDENTAL NUMBER [^...] [~...]. */
  private parsePitch(): { value: PlayPitch; newPos: number } {
    const accResult = ParserUtils.advance(this.tokens, this.pos)
    this.pos = accResult.newPos
    const alteration = this.accidentalToAlteration(accResult.token.value)

    const numResult = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = numResult.newPos
    const degree = ParserUtils.parseNumber(numResult.token)

    return this.parsePitchModifiers(degree, alteration)
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
   * Parse a `.root()` / `.mode()` / `.oct()` pitch-scope chain after a group
   * (§2.3, §3). Returns the accumulated scope. Duplicate or conflicting chains
   * (`.root().root()`, `.root()`+`.mode()`) are diagnostic errors — last-wins is
   * not allowed; only nesting overrides (§3, decision #10). The scope stays
   * symbolic here; it is resolved lexically at dispatch (§7-0).
   */
  private parseScopeChain(): { root?: ScopeRoot; mode?: ScopeMode; oct?: number } {
    const scope: { root?: ScopeRoot; mode?: ScopeMode; oct?: number } = {}

    while (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const method = ParserUtils.peek(this.tokens, this.pos).value
      if (method !== 'root' && method !== 'mode' && method !== 'oct') break

      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos // DOT
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos // method IDENTIFIER
      const lparen = ParserUtils.expect(this.tokens, this.pos, 'LPAREN')
      this.pos = lparen.newPos

      if (method === 'root') {
        if (scope.root !== undefined) {
          throw new Error(
            'duplicate .root() on the same group — last-wins is not allowed; ' +
              'override only by nesting (§3)',
          )
        }
        if (scope.mode !== undefined) {
          throw new Error('.root() and .mode() cannot both be set on the same group (§3)')
        }
        scope.root = this.parseRootArg()
      } else if (method === 'mode') {
        if (scope.mode !== undefined) {
          throw new Error('duplicate .mode() on the same group (§3)')
        }
        if (scope.root !== undefined) {
          throw new Error('.root() and .mode() cannot both be set on the same group (§3)')
        }
        scope.mode = this.parseModeArg()
      } else {
        if (scope.oct !== undefined) {
          throw new Error('duplicate .oct() on the same group (§3)')
        }
        scope.oct = this.parseSignedNumber()
      }

      const rparen = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
      this.pos = rparen.newPos
    }

    return scope
  }

  /**
   * Parse a `.root()` argument: a note name (`F#`, `Bb`, `C`) or a degree of
   * `global.key()` (`3`, `b6`). Note names are reassembled from tokens here (no
   * tokenizer mode): `Bb`/`C` arrive as one IDENTIFIER; `F#` as IDENTIFIER + a
   * `#` ACCIDENTAL. The pitch class is resolved now; the spelling is kept for
   * §7-0 reversibility. Degree roots resolve against the key at dispatch.
   */
  private parseRootArg(): ScopeRoot {
    const cur = ParserUtils.current(this.tokens, this.pos)

    if (cur.type === 'IDENTIFIER') {
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      let spelling = cur.value
      // `Bb`/`Db` already carry their flats in the identifier; only a sharp run
      // lexes separately as an ACCIDENTAL, so append that if present.
      const next = ParserUtils.current(this.tokens, this.pos)
      if (next.type === 'ACCIDENTAL' && next.value[0] === '#') {
        this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
        spelling += next.value
      }
      return { kind: 'note', pitchClass: noteNameToPitchClass(spelling), spelling }
    }

    if (cur.type === 'ACCIDENTAL') {
      const alteration = this.accidentalToAlteration(cur.value)
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      const num = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
      this.pos = num.newPos
      return { kind: 'degree', degree: this.expectRootDegree(num.token), alteration }
    }

    if (cur.type === 'NUMBER') {
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      return { kind: 'degree', degree: this.expectRootDegree(cur), alteration: 0 }
    }

    throw new Error(
      `.root() expects a note name (e.g. F#) or a degree (e.g. 3, b6), got ${cur.type}`,
    )
  }

  /**
   * Parse a degree-root number, rejecting 0 (a rest is not a valid pitch center).
   * Parallels the `seq.root()` setter guard — `.root(0)` must error, not silently
   * fall back to the key tonic (§2.3).
   */
  private expectRootDegree(token: AudioToken): number {
    const degree = ParserUtils.parseNumber(token)
    // Match the seq.root() setter guard: a positive integer. 0 is a rest, and a
    // fractional degree is meaningless (would otherwise throw later at resolve).
    if (!Number.isInteger(degree) || degree < 1) {
      throw new Error(
        `.root() degree must be a positive integer (1+); 0 is a rest, not a valid root.`,
      )
    }
    return degree
  }

  /**
   * Parse a `.mode()` argument. v1.1 reserves the syntax (mode lattice = Phase
   * 2.2): capture the raw arg for duplicate/conflict diagnostics; dispatch
   * throws not-implemented (parallel to time()/fixpitch()).
   */
  private parseModeArg(): ScopeMode {
    const parts: string[] = []
    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RPAREN' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
      parts.push(String(ParserUtils.current(this.tokens, this.pos).value ?? ''))
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
    }
    return { kind: 'unimplemented', raw: parts.join(' ') }
  }

  /**
   * §3 "a chain closes the juxtaposition run": after a `.root()/.mode()/.oct()`
   * chain, a `(` with no comma is a parse error — the comma (or `)` / arg end)
   * bounds the run. Newlines are lexically insignificant, so skip them first.
   * Peeks only; does not advance.
   */
  private assertChainClosesRun(): void {
    const after = ParserUtils.skipNewlines(this.tokens, this.pos)
    if (ParserUtils.current(this.tokens, after).type === 'LPAREN') {
      throw new Error(
        'expected comma after chained group: a .root()/.mode()/.oct() chain ' +
          'closes the juxtaposition run (§3)',
      )
    }
  }

  /**
   * Parse nested play structure
   */
  private parseNestedPlay(): {
    value: PlayNested | PlayWithModifier | PlayScoped
    newPos: number
  } {
    const elements: PlayElement[] = []
    // Start of the current juxtaposition run within this group (reset on comma).
    let runStart = 0

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
      collapseScopedRun(elements, runStart)

      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      // Handle comma or continue. A comma ends the juxtaposition run.
      const sepType = ParserUtils.current(this.tokens, this.pos).type
      if (!this.handleNestedPlaySeparator()) {
        break
      }
      if (sepType === 'COMMA') {
        runStart = elements.length
      }
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    }

    const rparenResult = ParserUtils.expect(this.tokens, this.pos, 'RPAREN')
    this.pos = rparenResult.newPos

    // Check for a chain on the group itself. `.root()/.mode()/.oct()` are pitch-
    // scope chains → a PlayScoped node (§3); `.chop()` is the audio modifier.
    if (ParserUtils.current(this.tokens, this.pos).type === 'DOT') {
      const method = ParserUtils.peek(this.tokens, this.pos).value
      if (method === 'root' || method === 'mode' || method === 'oct') {
        const scope = this.parseScopeChain()
        this.assertChainClosesRun()
        // B2: single group. Juxtaposition runs (multiple groups sharing the
        // scope) are assembled by the caller (B3).
        return {
          value: { type: 'scoped', groups: [{ type: 'nested', elements }], ...scope },
          newPos: this.pos,
        }
      }
      const modifierResult = this.parsePlayWithModifier({ type: 'nested', elements })
      return { value: modifierResult.value, newPos: modifierResult.newPos }
    }

    return { value: { type: 'nested', elements }, newPos: this.pos }
  }

  /**
   * Parse a `[ ]` simultaneous-note-on stack (§4). Voices are parallel — NOT a
   * juxtaposition run — so, unlike parseNestedPlay, this never calls
   * collapseScopedRun. A trailing `^N` on the `]` is a whole-stack octave shift
   * (§6 `m7^+1`). Always produces a PlayStack regardless of sequence domain; the
   * audio-vs-MIDI rejection (§10-5) is a dispatch-time diagnostic.
   */
  private parseStack(): { value: PlayStack; newPos: number } {
    const voices: StackElement[] = []
    const lbracket = ParserUtils.expect(this.tokens, this.pos, 'LBRACKET')
    this.pos = lbracket.newPos

    while (
      ParserUtils.current(this.tokens, this.pos).type !== 'RBRACKET' &&
      !ParserUtils.isEOF(this.tokens, this.pos)
    ) {
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'RBRACKET') {
        break
      }
      this.parseStackElement(voices)
      this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
      if (ParserUtils.current(this.tokens, this.pos).type === 'COMMA') {
        this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      } else {
        break
      }
    }

    const rbracket = ParserUtils.expect(this.tokens, this.pos, 'RBRACKET')
    this.pos = rbracket.newPos

    // Optional trailing `^N`: a whole-stack octave shift (§6). Structural — never
    // a running-range set point (§2.4), so it lives on the node, not in a voice.
    if (ParserUtils.current(this.tokens, this.pos).type === 'CARET') {
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      const octaveShift = this.parseSignedNumber()
      return { value: { type: 'stack', voices, octaveShift }, newPos: this.pos }
    }

    return { value: { type: 'stack', voices }, newPos: this.pos }
  }

  /**
   * Parse a single voice within a `[ ]` stack. Extends the nested-element grammar
   * with the two chord markers: a bare IDENTIFIER → {@link PlayChordRef} (a bound
   * chord value, resolved at evaluation), and a leading MINUS → {@link
   * PlayChordRemoval} (§6 literal removal — inside `[ ]` a `-` is always a removal,
   * never a negative number, since stack voices are degrees ≥ 1). A `^N` on a
   * pitched voice is STRUCTURAL (rangeSet cleared, §2.4).
   */
  private parseStackElement(voices: StackElement[]): void {
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)
    const cur = ParserUtils.current(this.tokens, this.pos).type

    if (cur === 'LBRACKET') {
      const stackResult = this.parseStack()
      this.pos = stackResult.newPos
      voices.push(stackResult.value)
    } else if (cur === 'LPAREN') {
      // Independent subtree voice, e.g. [1, (5, 3, 2, 1)] (one-part polyphony, §4).
      const nestedResult = this.parseNestedPlay()
      this.pos = nestedResult.newPos
      voices.push(nestedResult.value)
    } else if (cur === 'MINUS') {
      voices.push(this.parseChordRemoval())
    } else if (cur === 'IDENTIFIER') {
      voices.push(this.parseChordRef())
    } else if (cur === 'ACCIDENTAL') {
      const pitchResult = this.parsePitch()
      this.pos = pitchResult.newPos
      voices.push(this.asStackVoice(pitchResult.value))
    } else if (cur === 'NUMBER') {
      const numResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = numResult.newPos
      const value = ParserUtils.parseNumber(numResult.token)
      const next = ParserUtils.current(this.tokens, this.pos).type
      if (next === 'CARET' || next === 'TILDE') {
        const pitchResult = this.parsePitchModifiers(value, 0)
        this.pos = pitchResult.newPos
        voices.push(this.asStackVoice(pitchResult.value))
      } else {
        voices.push(value)
      }
    } else {
      throw new Error(`Unexpected token in stack [ ]: ${cur}`)
    }
  }

  /**
   * Mark a PlayPitch as a stack voice: clear `rangeSet` so a voice `^N` is
   * structural (§2.4 — stack-internal `^N` places the voice's octave but does NOT
   * move the running range, unlike a melodic `^N`).
   */
  private asStackVoice(pitch: PlayPitch): PlayPitch {
    return pitch.rangeSet ? { ...pitch, rangeSet: false } : pitch
  }

  /**
   * Parse a bare chord-name reference inside a stack: IDENTIFIER [`^N`] (§6). The
   * name is resolved at evaluation against the chord namespace. A trailing `^N` is
   * a whole-chord structural octave shift applied to the spread voices.
   */
  private parseChordRef(): PlayChordRef {
    const id = ParserUtils.advance(this.tokens, this.pos)
    this.pos = id.newPos
    if (ParserUtils.current(this.tokens, this.pos).type === 'CARET') {
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
      return { type: 'chord_ref', name: id.token.value, octaveShift: this.parseSignedNumber() }
    }
    return { type: 'chord_ref', name: id.token.value, octaveShift: 0 }
  }

  /**
   * Parse a removal marker inside a stack: MINUS [ACCIDENTAL] NUMBER (`-5`, `-b3`).
   * Inside `[ ]` a leading `-` is always a removal (§6), never a negative number.
   */
  private parseChordRemoval(): PlayChordRemoval {
    this.pos = ParserUtils.advance(this.tokens, this.pos).newPos // MINUS
    let alteration = 0
    const cur = ParserUtils.current(this.tokens, this.pos)
    if (cur.type === 'ACCIDENTAL') {
      alteration = this.accidentalToAlteration(cur.value)
      this.pos = ParserUtils.advance(this.tokens, this.pos).newPos
    }
    const num = ParserUtils.expect(this.tokens, this.pos, 'NUMBER')
    this.pos = num.newPos
    return { type: 'chord_removal', degree: ParserUtils.parseNumber(num.token), alteration }
  }

  /**
   * Parse a single element within a nested play structure
   */
  private parseNestedPlayElement(elements: PlayElement[]): void {
    this.pos = ParserUtils.skipNewlines(this.tokens, this.pos)

    const cur = ParserUtils.current(this.tokens, this.pos).type

    if (cur === 'LBRACKET') {
      // Stack [ ] (§4): a simultaneous-note-on group. Parsed here; the audio-vs-
      // MIDI rejection (§10-5) is a dispatch-time diagnostic, not a parse error.
      const stackResult = this.parseStack()
      this.pos = stackResult.newPos
      elements.push(stackResult.value)
    } else if (cur === 'LPAREN') {
      // Nested element
      const nestedResult = this.parseNestedPlay()
      this.pos = nestedResult.newPos
      elements.push(nestedResult.value)
    } else if (cur === 'ACCIDENTAL') {
      // Altered degree, e.g. b3, #5, bb7
      const pitchResult = this.parsePitch()
      this.pos = pitchResult.newPos
      elements.push(pitchResult.value)
    } else if (cur === 'IDENTIFIER') {
      // A bare chord-name element inside a group, e.g. (0, m7, 0).root(3) (§6/§9.1).
      // Resolved (spread to a one-slot stack) at evaluation against the namespace.
      elements.push(this.parseChordRef())
    } else if (cur === 'NUMBER') {
      const numResult = ParserUtils.advance(this.tokens, this.pos)
      this.pos = numResult.newPos
      const value = ParserUtils.parseNumber(numResult.token)

      const next = ParserUtils.current(this.tokens, this.pos).type
      if (next === 'DOT') {
        // Audio slice modifier (.chop)
        const modifierResult = this.parsePlayWithModifier(value)
        this.pos = modifierResult.newPos
        elements.push(modifierResult.value)
      } else if (next === 'CARET' || next === 'TILDE') {
        // Bare degree with octave-shift / detune modifier, e.g. 3^+1, 7~-0.25
        const pitchResult = this.parsePitchModifiers(value, 0)
        this.pos = pitchResult.newPos
        elements.push(pitchResult.value)
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
