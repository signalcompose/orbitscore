import type {
  ChordBinding,
  ImportStatement,
  ModeBinding,
  PatternBinding,
  RandomBinding,
} from '../parser/audio-parser'
import { classifyArrayBinding } from '../signal-chain/rack'

import type { InterpreterState } from './types'

export function requireGlobal(state: InterpreterState, label: string) {
  if (!state.currentGlobal) {
    console.error(`${label} requires a global (declare \`var g = init GLOBAL\` first).`)
    return null
  }
  return state.currentGlobal
}

export function processImportStatement(statement: ImportStatement, state: InterpreterState): void {
  if (statement.module !== 'chords') {
    console.warn(`Unknown import "${statement.module}" — v1.1 supports only \`import chords\`.`)
    return
  }
  requireGlobal(state, '`import chords`')?.importChords()
}

export function processArrayBinding(statement: ChordBinding, state: InterpreterState): void {
  const global = requireGlobal(state, `array "${statement.variableName}"`)
  if (!global) return
  const classified = classifyArrayBinding(statement.value, global)
  if (classified.kind === 'chord') global.defineChord(statement.variableName, classified.voices)
  else global.defineRack(statement.variableName, classified.rack)
}

export function processPatternBinding(statement: PatternBinding, state: InterpreterState): void {
  requireGlobal(state, `pattern "${statement.variableName}"`)?.definePattern(
    statement.variableName,
    statement.elements,
  )
}

export function processModeBinding(statement: ModeBinding, state: InterpreterState): void {
  requireGlobal(state, `mode "${statement.variableName}"`)?.defineMode(
    statement.variableName,
    statement.lattice,
    statement.period,
  )
}

export function processRandomBinding(statement: RandomBinding, state: InterpreterState): void {
  requireGlobal(state, `random source "${statement.name}"`)?.defineRandom(
    statement.name,
    statement.source,
  )
}
