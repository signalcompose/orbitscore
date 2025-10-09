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
  | 'PERCENT' // % (for random range)
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

export type Meter = {
  numerator: number
  denominator: number
}

export type CompositeMeter = {
  meters: Meter[]
  repeat?: number
}

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
