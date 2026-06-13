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

export type PlayNested = {
  type: 'nested'
  elements: PlayElement[]
}

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
  octaveShift: number // from `^` (e.g. 3^+1 → +1). 0 if absent
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
