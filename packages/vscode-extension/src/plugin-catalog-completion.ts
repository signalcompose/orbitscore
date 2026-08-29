/**
 * Pure completion-context helpers for plugin catalog name completion
 * (#463 C3, spec `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` §PC.3).
 *
 * Deliberately vscode-free (unlike completion-context.ts, which constructs
 * `vscode.CompletionItem`) so the extension's provider can build the actual
 * `vscode.CompletionItem[]` (with `range` etc.) itself while this module stays
 * unit-testable without a vscode mock.
 *
 * Owner requirement (2026-07-17): candidates must filter as the user keeps
 * typing inside the string, not only at the `"` trigger — so `detectPluginArgContext`
 * matches a PARTIAL string (no closing quote required) and returns the typed
 * prefix so far, and `filterCatalogEntries` narrows by that prefix.
 */

import type { PluginCatalogEntry } from './plugin-catalog-reader'

export type PluginVerb = 'effect' | 'instrument'

export interface PluginArgContext {
  readonly verb: PluginVerb
  /** Text typed so far between the opening quote and the cursor (no closing quote required). */
  readonly typed: string
  /** 0-based character offset of the opening quote's content start (i.e. right after `"`). */
  readonly quoteStartChar: number
}

export interface PluginCatalogCompletionCandidate {
  readonly entry: PluginCatalogEntry
  readonly label: string
  readonly insertText: string
}

// ──────────────────────────────────────────────────────────────────────
// ラック対応の文脈スキャナ（#628・SC.10.10 規範 1）
// ──────────────────────────────────────────────────────────────────────

/**
 * 後方スキャンで遡る行数の上限。無制限にすると、閉じ括弧を書き忘れた文書で
 * 1 打鍵ごとにファイル全体を舐めることになる。
 */
export const RACK_SCAN_MAX_LINES = 50

/** ラック文脈で補完対象になる呼び出し。`layer` は構造なので role を決めない。 */
const RACK_CALL_WORDS = new Set(['effect', 'instrument', 'plugin', 'layer'])

/**
 * カーソル位置がカタログ名の文字列リテラルの中にいるかを、**複数行のラックを
 * またいで**判定する（#628・SC.10.10 規範 1）。
 *
 * 単一行 regex（{@link detectPluginArgContext}）はラック配列の中・複数行・
 * `layer` の入れ子では発火しない。ラック形への移行でそのまま退行するため、
 * 有界の後方スキャナへ置き換える。
 *
 * 判定は 2 段:
 *
 * 1. **カーソル行**で、閉じていない `"` の中にいるか（文字列は行をまたがない）
 * 2. その外側の**閉じていない括弧**（`[` `(` の入れ子）を遡り、
 *    `effect(` / `instrument(` のどちらに到達するかで role を決める
 *
 * `plugin(` と `layer(` は途中の通過点で、role は**さらに外側**の
 * `effect` / `instrument` が決める（`instrument(layer(["…` は instrument）。
 *
 * @param lines   文書の全行（カーソル行までで足りるが、呼び出し側の都合で全行可）
 * @param line    カーソルの 0 始まり行番号
 * @param character カーソルの 0 始まり桁
 */
export function detectRackArgContext(
  lines: readonly string[],
  line: number,
  character: number,
): PluginArgContext | null {
  const cursorLine = lines[line]
  if (cursorLine === undefined) return null

  const quote = findOpenQuote(cursorLine.slice(0, character))
  if (quote === null) return null

  const verb = resolveEnclosingVerb(lines, line, quote.quoteIndex)
  if (!verb) return null

  return {
    verb,
    typed: cursorLine.slice(quote.quoteIndex + 1, character),
    quoteStartChar: quote.quoteIndex + 1,
  }
}

/**
 * 行の接頭辞に閉じていない `"` があれば、その位置を返す。
 *
 * 文字列は行をまたがないので、走査はこの行だけで完結する。`\"` は文字列の
 * 終端にしないが、DSL に文字列内エスケープの用例は無いので防御的な扱い。
 */
function findOpenQuote(prefix: string): { quoteIndex: number } | null {
  let open: number | null = null
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === '\\') {
      i += 1
      continue
    }
    if (prefix[i] !== '"') continue
    open = open === null ? i : null
  }
  return open === null ? null : { quoteIndex: open }
}

/**
 * 開き括弧を外側へ遡り、role を決める動詞（`effect` / `instrument`）を探す。
 *
 * 走査は {@link RACK_SCAN_MAX_LINES} 行で打ち切る。到達できなければ null
 * （= ラック文脈ではない）。
 */
function resolveEnclosingVerb(
  lines: readonly string[],
  line: number,
  fromChar: number,
): PluginVerb | null {
  // 未対応の閉じ括弧の数。これが 0 の状態で開き括弧に出会うと「外側の括弧」。
  let pendingClosers = 0
  const firstLine = Math.max(0, line - RACK_SCAN_MAX_LINES)

  for (let row = line; row >= firstLine; row -= 1) {
    const text = lines[row] ?? ''
    const start = row === line ? fromChar - 1 : text.length - 1

    for (let col = start; col >= 0; col -= 1) {
      const ch = text[col]
      if (ch === ')' || ch === ']') {
        pendingClosers += 1
        continue
      }
      if (ch !== '(' && ch !== '[') continue
      if (pendingClosers > 0) {
        pendingClosers -= 1
        continue
      }
      // 対応する閉じ括弧が無い = カーソルを囲んでいる括弧。
      if (ch === '[') continue // 配列は role を決めない。さらに外側を見る
      const word = identifierBefore(text, col)
      if (!word || !RACK_CALL_WORDS.has(word)) return null
      if (word === 'effect' || word === 'instrument') return word
      // `plugin(` / `layer(` は通過点。role はさらに外側が決める。
    }
  }
  return null
}

/** `index` の直前にある識別子を返す（`.effect(` の `effect`）。 */
function identifierBefore(text: string, index: number): string | null {
  let end = index
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1
  let begin = end
  while (begin > 0 && /[A-Za-z0-9_]/.test(text[begin - 1] ?? '')) begin -= 1
  const word = text.slice(begin, end)
  return word.length > 0 ? word : null
}

/**
 * Filters catalog entries for a completion request:
 * - role match (PC.3: `instrument(` → roles includes `instrument`; `effect(` → roles includes `effect`)
 * - both verbs accept CLAP and VST3 entries (PH.3); catalog name resolution prefers CLAP on a same-name tie
 * - same-vendor cross-format collisions become `format/name` candidates; remaining label collisions use `vendor/name`
 * - typed-prefix narrowing (case-insensitive substring match against the candidate or `vendor/name`)
 */
export function filterCatalogEntries(
  entries: readonly PluginCatalogEntry[],
  verb: PluginVerb,
  typed: string,
): PluginCatalogCompletionCandidate[] {
  const needle = typed.trim().toLowerCase()
  const roleEntries = entries.filter((entry) => entry.roles.includes(verb))
  const formatsByVendorAndName = new Map<string, Set<string>>()
  for (const entry of roleEntries) {
    const key = vendorAndNameKey(entry)
    const formats = formatsByVendorAndName.get(key) ?? new Set<string>()
    formats.add(normalizeCatalogKey(entry.format))
    formatsByVendorAndName.set(key, formats)
  }

  const baseCandidates = roleEntries.map((entry) => {
    const hasFormatCollision = (formatsByVendorAndName.get(vendorAndNameKey(entry))?.size ?? 0) > 1
    return {
      entry,
      label: hasFormatCollision ? `${entry.format.toLowerCase()}/${entry.name}` : entry.name,
    }
  })
  const vendorsByLabel = new Map<string, Set<string>>()
  for (const { entry, label } of baseCandidates) {
    const vendors = vendorsByLabel.get(normalizeCatalogKey(label)) ?? new Set<string>()
    vendors.add(normalizeCatalogKey(entry.vendor))
    vendorsByLabel.set(normalizeCatalogKey(label), vendors)
  }

  return baseCandidates.flatMap(({ entry, label: baseLabel }) => {
    const label =
      (vendorsByLabel.get(normalizeCatalogKey(baseLabel))?.size ?? 0) > 1
        ? `${entry.vendor}/${entry.name}`
        : baseLabel
    if (needle === '') return [{ entry, label, insertText: label }]
    const qualified = `${entry.vendor}/${entry.name}`.toLowerCase()
    if (!label.toLowerCase().includes(needle) && !qualified.includes(needle)) return []
    return [{ entry, label, insertText: label }]
  })
}

export function normalizeCatalogKey(value: string): string {
  return value.trim().normalize('NFC').toLowerCase()
}

function vendorAndNameKey(entry: PluginCatalogEntry): string {
  return `${normalizeCatalogKey(entry.vendor)}\u0000${normalizeCatalogKey(entry.name)}`
}

// ──────────────────────────────────────────────────────────────────────
// Quick Pick 用の一覧（#638）
// ──────────────────────────────────────────────────────────────────────

/** One row of the "browse plugins" Quick Pick. */
export interface PluginPickItem {
  readonly label: string
  /** Shown dimmed after the label, and searchable — vendor and format. */
  readonly description: string
  /** What to write into the document (the same disambiguated form completion inserts). */
  readonly insertText: string
}

/**
 * Builds the browsable plugin list for one verb.
 *
 * Completion only helps once you remember a fragment of the name. With 274
 * effects and 74 instruments in a real catalog, "what could I put here" needs
 * a list you can page through, so this deliberately takes no typed prefix.
 *
 * Rows reuse `filterCatalogEntries` so the label a user picks here is
 * character-for-character the one completion would have inserted — including
 * the `format/name` and `vendor/name` disambiguation. Sorted by label so the
 * list is stable and scannable; vendor and format ride in `description`, which
 * VS Code also matches when the user types.
 */
export function buildPluginPickItems(
  entries: readonly PluginCatalogEntry[],
  verb: PluginVerb,
): PluginPickItem[] {
  return filterCatalogEntries(entries, verb, '')
    .map(({ entry, label, insertText }) => ({
      label,
      description: `${entry.vendor} · ${entry.format.toUpperCase()}`,
      insertText,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.description.localeCompare(b.description))
}
