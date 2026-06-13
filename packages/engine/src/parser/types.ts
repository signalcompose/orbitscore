/**
 * Type definitions for the audio-based DSL parser
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

// Token types for the audio DSL
export type AudioTokenType =
  | 'VAR' // var keyword
  | 'INIT' // init keyword
  | 'BY' // by keyword (for meter)
  | 'GLOBAL' // GLOBAL constant
  | 'RUN' // RUN reserved keyword
  | 'LOOP' // LOOP reserved keyword
  | 'MUTE' // MUTE reserved keyword
  | 'IDENTIFIER' // variable names, method names
  | 'NUMBER' // numeric values
  | 'STRING' // string literals
  | 'DOT' // . (method call)
  | 'LPAREN' // (
  | 'RPAREN' // )
  | 'COMMA' // ,
  | 'EQUALS' // =
  | 'MINUS' // - (for negative numbers)
  | 'PLUS' // + (for octave shift / detune sign, e.g. 3^+1)
  | 'PERCENT' // % (for random range)
  | 'ACCIDENTAL' // pitch alteration prefix: b, bb, #, ## (degree b/# notation)
  | 'CARET' // ^ (octave shift modifier, e.g. 3^+1)
  | 'TILDE' // ~ (detune modifier, e.g. b7~-0.25)
  | 'LBRACKET' // [ (stack — reserved, not yet supported in v1.1)
  | 'RBRACKET' // ] (stack — reserved, not yet supported in v1.1)
  | 'NEWLINE' // line break
  | 'EOF' // end of file

export type AudioToken = {
  type: AudioTokenType
  value: string
  line: number
  column: number
}

// AST types for the audio DSL
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
  target: string
  method: string
  args: any[]
  chain?: MethodChain[]
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
  | number // slice number (audio) or bare degree (MIDI), e.g. 1, 2, 3
  | PlayNested // nested structure (e.g., (1)(2))
  | PlayWithModifier // with .chop(), .time(), etc.
  | PlayPitch // degree with alteration / octave-shift / detune (e.g. b3, #5, 3^+1)
  | PlayScoped // group(s) with a .root()/.mode()/.oct() pitch-scope chain (§2.3, §3)
  | PlayStack // `[ ]` simultaneous-note-on stack (§4)

export type PlayNested = {
  type: 'nested'
  elements: PlayElement[]
}

/**
 * A `[ ]` simultaneous-note-on stack (§4 / DESIGN_DISCUSSION_RECORD §9).
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §4, §6
 *
 * Unlike `( )` (which divides its slot among children in time), a stack occupies
 * ONE sibling slot and all `voices` share the SAME start time and the FULL slot
 * duration — they sound at once. A voice may itself be a subtree (`[1, (5,3,2,1)]`
 * = one-part polyphony): the nested `( )` subdivides the same span the held voice
 * occupies (timing implements this as parallel recursion, §4).
 *
 * The node is produced by the parser ALWAYS — appearing in an AUDIO sequence is a
 * dispatch-time diagnostic error (§10-5, "[ ] reserved in audio"), mirroring how a
 * PlayPitch in an audio sequence errors at dispatch rather than at parse.
 *
 * `voices` is the RAW element list before chord evaluation: it may carry
 * {@link PlayChordRef} / {@link PlayChordRemoval} markers that the evaluator (§6)
 * resolves away. After evaluation it is plain {@link PlayElement}[] (symbolic only).
 */
export type PlayStack = {
  type: 'stack'
  voices: StackElement[]
  /**
   * A whole-stack octave shift from a trailing `^N` on the `]` or a chord name
   * (§6 `m7^+1`). Structural (does NOT move the §2.4 running range). 0/absent = none.
   */
  octaveShift?: number
}

/**
 * A raw `[ ]` stack element before chord evaluation: a {@link PlayElement} plus
 * the two evaluation-only markers ({@link PlayChordRef}, {@link PlayChordRemoval}).
 * The chord evaluator (§6) resolves these to plain PlayElement voices.
 */
export type StackElement = PlayElement | PlayChordRef | PlayChordRemoval

/**
 * A bare identifier inside a `[ ]` stack (or as a bare play arg): a reference to a
 * bound chord value, resolved at evaluation against the chord namespace (§6).
 * `octaveShift` carries a trailing `^N` (`m7^+1`) — a whole-chord structural shift
 * applied to the spread voices.
 */
export type PlayChordRef = {
  type: 'chord_ref'
  name: string
  octaveShift: number // from `^N`; 0 if none
}

/**
 * A removal marker `-N` / `-bN` inside a `[ ]` stack (§6): after spread, remove the
 * voice whose literal `(degree, alteration)` matches. No match = no-op + warning
 * (literal match only; resolved-pitch matching is rejected — `-3` would become
 * context-dependent, §6).
 */
export type PlayChordRemoval = {
  type: 'chord_removal'
  degree: number
  alteration: number
}

/**
 * One or more juxtaposed groups sharing a lexical pitch scope, produced by a
 * `.root()` / `.mode()` / `.oct()` chain on a (run of) group(s) (§2.3, §3).
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §3 / DESIGN_DISCUSSION_RECORD §9.3
 *
 * Created ONLY when a scope chain is present. A bare `(A)(B)` juxtaposition with
 * no chain stays separate sibling args (unchanged splice behavior). `groups` is
 * the juxtaposition run (length 1 for a single `(A).root(X)`); they remain
 * temporal siblings (each keeps its own slot) and only share the pitch context.
 * The scope is resolved lexically (inner → outer → seq default → error) during
 * the timing walk, where the nesting is still visible — never at parse time
 * (§7-0: symbolic pitch is preserved until dispatch).
 */
export type PlayScoped = {
  type: 'scoped'
  groups: PlayElement[]
  root?: ScopeRoot // present iff `.root()` was chained
  mode?: ScopeMode // present iff `.mode()` was chained (v1.1: parsed + reserved; dispatch throws)
  oct?: number // present iff `.oct(N)` was chained (group-lexical octave register)
}

/**
 * A `.root()` argument, kept symbolic until dispatch.
 * - `note`: a note-name token (`F#`, `Bb`) — pitch class resolved at parse via
 *   note-name.ts; `spelling` is retained for §7-0 reversibility (D# vs Eb).
 * - `degree`: a numeric/altered degree of `global.key()` (`3`, `b6`) — resolved
 *   against the key at dispatch (key-undeclared numeric root is an error then).
 */
export type ScopeRoot =
  | { kind: 'note'; pitchClass: number; spelling: string }
  | { kind: 'degree'; degree: number; alteration: number }

/** A `.mode()` argument. v1.1 reserves the syntax; dispatch throws (mode = Phase 2.2). */
export type ScopeMode = { kind: 'unimplemented'; raw: string }

/**
 * A MIDI degree carrying pitch alteration and event modifiers.
 *
 * Spec: docs/specs-v2/PITCH_DSL_SPEC_v1.1.html §2.1, §2.4
 *
 * Produced only when an accidental (`b`/`#`/`bb`/`##`) or a modifier
 * (`^` octave shift, `~` detune) is present. A bare integer stays a `number`
 * (degree 0 = rest), so audio slice-number parsing is unaffected. The value is
 * interpreted as a degree at MIDI dispatch; appearing in an audio sequence is a
 * diagnostic error (a slice number has no alteration).
 */
export type PlayPitch = {
  type: 'pitch'
  degree: number // 1+ pitched, 0 = rest
  alteration: number // semitones from accidentals: b=-1, #=+1, bb/##=±2
  octaveShift: number // from `^N`: the running pitch range this note SETS (§2.4). 0 if no `^`.
  rangeSet: boolean // true if `^` was written (sticky range set point); false = inherit running range
  detune: number // semitones from `~` (e.g. b7~-0.25 → -0.25). 0 if absent
}

export type PlayWithModifier = {
  type: 'modified'
  value: number | PlayNested
  modifiers: PlayModifier[]
}

export type PlayModifier = {
  method: 'chop' // Note: 'time' and 'fixpitch' removed - not yet implemented
  value: number
}

export type Meter = {
  numerator: number
  denominator: number
}

// Note: CompositeMeter has been removed - not yet implemented
// Future: may add support for composite meters like 4/4+3/8

export type TransportStatement = {
  type: 'transport'
  target: string
  command: string
  force?: boolean
  sequences?: string[]
}

// Random value types
export type RandomValue =
  | { type: 'full-random' } // r
  | { type: 'random-walk'; center: number; range: number } // r0%20, r-6%4
