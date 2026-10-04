import type {
  ChordBinding,
  ImportStatement,
  ModeBinding,
  PatternBinding,
  RandomBinding,
} from '../parser/audio-parser'
import { classifyArrayBinding } from '../signal-chain/rack'

import type { InterpreterState } from './types'

/**
 * Return the active global, or null after logging a "requires a global" error.
 * The five `var`-binding handlers (import / chord / pattern / mode / random) all mutate the
 * active global's namespace, so they share this guard; `label` names the
 * construct for the message (e.g. `` `import chords` ``, `chord "foo"`).
 */
export function requireGlobal(state: InterpreterState, label: string) {
  if (!state.currentGlobal) {
    console.error(`${label} requires a global (declare \`var g = init GLOBAL\` first).`)
    return null
  }
  return state.currentGlobal
}

/**
 * Process `import chords` (§6): load the stdlib chord qualities into the active
 * global's chord namespace. Statements execute in source order, so a later play()
 * sees the imported chords (評価時値渡し).
 */
export function processImportStatement(statement: ImportStatement, state: InterpreterState): void {
  if (statement.module !== 'chords') {
    console.warn(`Unknown import "${statement.module}" — v1.1 supports only \`import chords\`.`)
    return
  }
  requireGlobal(state, '`import chords`')?.importChords()
}

/** Process `var NAME = [ ... ]` (§6): bind the evaluated chord value. */
export function processArrayBinding(statement: ChordBinding, state: InterpreterState): void {
  const global = requireGlobal(state, `array "${statement.variableName}"`)
  if (!global) return
  const classified = classifyArrayBinding(statement.value, global)
  if (classified.kind === 'chord') global.defineChord(statement.variableName, classified.voices)
  else global.defineRack(statement.variableName, classified.rack)
}

/** Process `var NAME = <play-expr>` (§6.5): bind the raw pattern value. */
export function processPatternBinding(statement: PatternBinding, state: InterpreterState): void {
  requireGlobal(state, `pattern "${statement.variableName}"`)?.definePattern(
    statement.variableName,
    statement.elements,
  )
}

/** Process `var NAME = mode(...)` (§2.2): bind the user pitch lattice. */
export function processModeBinding(statement: ModeBinding, state: InterpreterState): void {
  requireGlobal(state, `mode "${statement.variableName}"`)?.defineMode(
    statement.variableName,
    statement.lattice,
    statement.period,
  )
}

/** Process `var NAME = random.MODE`: bind a copied random-source lattice. */
export function processRandomBinding(statement: RandomBinding, state: InterpreterState): void {
  requireGlobal(state, `random source "${statement.variableName}"`)?.defineRandom(
    statement.variableName,
    statement.source,
  )
}
