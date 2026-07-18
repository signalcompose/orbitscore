/**
 * Pure completion-context helpers for the DSL surfaces added in #512.
 *
 * This module intentionally has no vscode import: the provider supplies file
 * I/O and CompletionItems while these helpers only reason about source text.
 */

export type DslCompletionContext =
  | { readonly kind: 'import-names'; readonly typed: string; readonly importPath: string }
  | { readonly kind: 'import-path'; readonly typed: string; readonly quoteStartChar: number }
  | { readonly kind: 'sequence-methods'; readonly typed: string }
  | { readonly kind: 'global-methods'; readonly typed: string }
  | { readonly kind: 'sum-name'; readonly typed: string; readonly quoteStartChar: number }
  | { readonly kind: 'aux-name'; readonly typed: string; readonly quoteStartChar: number }

// Source: public DSL methods on engine `src/core/sequence.ts`. This static
// mirror can diverge; #495 phase 2 AST work will eliminate that risk.
export const SEQUENCE_METHODS = [
  'audio',
  'beat',
  'cell',
  'chop',
  'comp',
  'defaultGain',
  'defaultPan',
  'density',
  'effect',
  'gain',
  'gate',
  'hold',
  'instrument',
  'length',
  'loop',
  'midi',
  'mute',
  'octave',
  'output',
  'pan',
  'play',
  'quantize',
  'root',
  'run',
  'send',
  'stop',
  'tempo',
  'unmute',
  'vel',
  'vl',
  'voicelead',
] as const

// Source: public DSL methods on engine `src/core/global.ts`. This static
// mirror can diverge; #495 phase 2 AST work will eliminate that risk.
export const GLOBAL_METHODS = [
  'audioDevice',
  'audioPath',
  'aux',
  'beat',
  'compressor',
  'defineChord',
  'defineMode',
  'definePattern',
  'effect',
  'gain',
  'instrument',
  'key',
  'limiter',
  'loop',
  'midiLatency',
  'normalizer',
  'quantize',
  'start',
  'stop',
  'sum',
  'tempo',
] as const

/** Returns true when `position` is inside a line comment or string literal. */
function lexicalStateAt(text: string, position: number): 'code' | 'comment' | 'string' {
  let state: 'code' | 'comment' | 'string' = 'code'
  for (let index = 0; index < position; index++) {
    const char = text[index]
    if (state === 'comment') {
      if (char === '\n') state = 'code'
      continue
    }
    if (state === 'string') {
      if (char === '\\') index++
      else if (char === '"') state = 'code'
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      state = 'comment'
      index++
    } else if (char === '"') {
      state = 'string'
    }
  }
  return state
}

/**
 * Detects a completion surface on one line. String-only surfaces are allowed
 * only in their specific call/import strings; all other strings/comments are
 * rejected before their regex is tested.
 */
export function detectDslCompletionContext(
  lineText: string,
  position: number,
): DslCompletionContext | null {
  const prefix = lineText.slice(0, position)
  const state = lexicalStateAt(lineText, position)

  if (state === 'comment') return null

  const importPath = /\bimport\s*\{[^}"\n]*\}\s*from\s*"([^"\n]*)$/.exec(prefix)
  if (importPath && state === 'string') {
    return {
      kind: 'import-path',
      typed: importPath[1] ?? '',
      quoteStartChar: position - (importPath[1] ?? '').length,
    }
  }

  const busArg = /\.?(output|send)\(\s*"([^"\n]*)$/.exec(prefix)
  if (busArg && state === 'string') {
    const typed = busArg[2] ?? ''
    return {
      kind: busArg[1] === 'output' ? 'sum-name' : 'aux-name',
      typed,
      quoteStartChar: position - typed.length,
    }
  }

  if (state !== 'code') return null

  // The path can be after the cursor, so inspect the whole comment-free line
  // while preserving the code-only prefix requirement above.
  const importNames = /\bimport\s*\{\s*([^}]*)$/.exec(prefix)
  if (importNames) {
    const pathMatch = /\}\s*from\s*"([^"\n]+)"/.exec(lineText.slice(position))
    const pathStart = position + (pathMatch?.index ?? 0)
    if (pathMatch && lexicalStateAt(lineText, pathStart) === 'code') {
      const list = importNames[1] ?? ''
      const typed = /(?:^|,)\s*([A-Za-z_$][\w$]*)?$/.exec(list)?.[1] ?? ''
      return { kind: 'import-names', typed, importPath: pathMatch[1] }
    }
  }

  const method = /\b(seq|global)\.([A-Za-z_$][\w$]*)?$/.exec(prefix)
  if (!method) return null
  return {
    kind: method[1] === 'global' ? 'global-methods' : 'sequence-methods',
    typed: method[2] ?? '',
  }
}

/** Mirrors engine `declaredNames`: global/sequence initializers and `var` bindings. */
export function extractTopLevelDeclaredNames(sourceText: string): string[] {
  const names = new Set<string>()
  for (const line of sourceText.split(/\r?\n/)) {
    const match = /^\s*var\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)
    if (match?.[1] && lexicalStateAt(line, match.index) === 'code') names.add(match[1])
  }
  return [...names]
}

/** Returns names declared by `global.sum("...")` or `global.aux("...")` before the cursor. */
export function extractDeclaredBusNames(sourceText: string, kind: 'sum' | 'aux'): string[] {
  const names = new Set<string>()
  const pattern = new RegExp(`\\bglobal\\.${kind}\\(\\s*"([^"\\n]+)"`, 'g')
  for (const match of sourceText.matchAll(pattern)) {
    if (lexicalStateAt(sourceText, match.index ?? 0) === 'code' && match[1]) names.add(match[1])
  }
  return [...names]
}

export function filterDslCandidates(candidates: readonly string[], typed: string): string[] {
  const needle = typed.toLowerCase()
  return candidates.filter((candidate) => candidate.toLowerCase().includes(needle))
}
