/**
 * Postfix vocabulary of play elements, kept apart from the parser class that consumes it:
 * the voicing operators (§12) and pitch-scope chain methods (§3) a group or `[ ]` stack can
 * carry, their arities, and the juxtaposition-run rule a scope chain applies to its
 * preceding sibling groups. Pure data and one pure function — no token cursor.
 */
import type { PlayElement, ScopeMode, ScopeRoot } from './types'

/** Voicing operators parsed as postfix on a chord value / `[ ]` stack (§12, #49/#51). */
export const VOICING_OPS = new Set(['drop', 'invert', 'open', 'close', 'shell', 'rootless'])

/**
 * Pitch-scope chain methods on a group (§3): `.root()`/`.mode()`/`.oct()`/`.hold()`
 * and `.voicelead()`/`.vl()` (§6.3 auto voice-leading, C1). All build a PlayScoped node.
 */
export const SCOPE_CHAIN_OPS = new Set(['root', 'mode', 'oct', 'hold', 'voicelead', 'vl'])

/** The accumulated pitch-scope chain on a group (§3): the result of `ExpressionParser.parseScopeChain` (parse-expression.ts). */
export type ScopeChain = {
  root?: ScopeRoot
  mode?: ScopeMode
  oct?: number
  hold?: boolean
  voicelead?: boolean
}

/** Per-op `[min, max]` argument arity (§12.3): drop ≥1, invert exactly 1, the rest 0. */
export const VOICING_ARITY: Record<string, [number, number]> = {
  drop: [1, Infinity],
  invert: [1, 1],
  open: [0, 0],
  close: [0, 0],
  shell: [0, 0],
  rootless: [0, 0],
}

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
