/**
 * Pure completion-context helpers for the DSL surfaces added in #512.
 *
 * This module intentionally has no vscode import: the provider supplies file
 * I/O and CompletionItems while these helpers only reason about source text.
 */

export type DslCompletionContext =
  | { readonly kind: 'import-names'; readonly typed: string; readonly importPath: string }
  | { readonly kind: 'import-path'; readonly typed: string }
  | { readonly kind: 'sum-name'; readonly typed: string }
  | { readonly kind: 'aux-name'; readonly typed: string }
  /**
   * `seq.` / `global.` / `sum("x").` の後のメソッド補完（#495 第1段）。
   *
   * `receiver` は候補源の選択に使う。候補は engine の DSL 語彙テーブル
   * （`SEQUENCE_DSL_METHODS` 等）から取るので、**DSL にメソッドを足せば補完にも自動で出る**
   * （`seq.ui()` を足したのに補完に出ない、が起きない）。
   */
  | {
      readonly kind: 'method'
      readonly typed: string
      readonly receiver: 'sequence' | 'global' | 'bus'
    }

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
    return { kind: 'import-path', typed: importPath[1] ?? '' }
  }

  const busArg = /\.(output|send)\(\s*"([^"\n]*)$/.exec(prefix)
  if (busArg && state === 'string') {
    return {
      kind: busArg[1] === 'output' ? 'sum-name' : 'aux-name',
      typed: busArg[2] ?? '',
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

  // `<receiver>.` の後 → メソッド補完（#495 第1段）。
  //
  // 🔴 レシーバの種類は**呼び出し側**（provider）が文書全体から判定する。ここは行だけを
  // 見るので、`sum("x").` のような**その場で分かる形**だけを解決し、変数名は
  // `receiver: 'sequence'` を既定にして provider に委ねる。
  const methodAccess =
    /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?:\(\s*"[^"\n]*"\s*\))?\s*\.([A-Za-z_$][\w$]*)?$/.exec(
      prefix,
    )
  if (methodAccess) {
    const head = methodAccess[1] ?? ''
    const typed = methodAccess[2] ?? ''
    // `sum("x").` / `aux("x").` はバスハンドル。`global.` は Global。
    // それ以外の識別子は宣言を見ないと決まらないので、provider 側で解決する。
    const receiver =
      head === 'sum' || head === 'aux' ? 'bus' : head === 'global' ? 'global' : 'sequence'
    return { kind: 'method', typed, receiver }
  }

  return null
}

/**
 * `var <name> = init global.seq` で宣言された sequence 名（#495 第1段）。
 *
 * メソッド補完のレシーバ判定に使う。`var global = init GLOBAL` は sequence ではないので
 * 含めない（`global.` は別の候補源を使う）。
 */
export function extractDeclaredSequenceNames(sourceText: string): string[] {
  const names = new Set<string>()
  for (const line of sourceText.split(/\r?\n/)) {
    const match = /^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*init\s+[A-Za-z_$][\w$]*\.seq\b/.exec(line)
    if (match?.[1] && lexicalStateAt(line, match.index) === 'code') names.add(match[1])
  }
  return [...names]
}

/**
 * `var <name> = init GLOBAL` で宣言された global 名（#495 第1段）。
 *
 * 慣例は `global` だが別名も書けるので、決め打ちにしない。
 */
export function extractDeclaredGlobalNames(sourceText: string): string[] {
  const names = new Set<string>()
  for (const line of sourceText.split(/\r?\n/)) {
    const match = /^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*init\s+GLOBAL\b/.exec(line)
    if (match?.[1] && lexicalStateAt(line, match.index) === 'code') names.add(match[1])
  }
  return [...names]
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
