/** VS Code decoration state and rendering for live playhead highlights. */
import * as vscode from 'vscode'

import {
  colorForSeq,
  findPlayArgRangeForPath,
  type PlayheadColorConfig,
  type StepEvent,
} from './playhead'

// --- Live playhead highlight (#390) ---
// The engine emits `[STEP] <seqName> <argPath> <atEpochMs>` on stdout for each
// dispatched play event (see playhead.ts for the grammar). setupStdoutHandler
// parses these from the RAW stream (shouldFilterLine keeps them out of the
// Output channel), delays until the event's grid time, then highlights the
// corresponding `<seqName>.play(...)` argument (argPath descends into nested
// groups — "1.0" lights the first element inside the second arg). ONE
// decoration type PER RESOLVED COLOR (lazily created, keyed by "#RRGGBB");
// each seq gets a vivid color first-come from `orbitscore.playheadPalette`
// (see playhead.ts colorForSeq; per-seq pinning is the planned DSL feature
// #391). ONE active range per seq (replaced on each step, so the highlight
// "moves" per beat and wraps at loop start). Cleared on seq stop (`⏹ <seq>`
// line), global stop, engine stop / exit, and deactivate.
export const playheadDecorationTypes = new Map<string, vscode.TextEditorDecorationType>()
const playheadPaletteAssignments = new Map<string, number>()
const playheadActiveRanges = new Map<string, { docUriString: string; range: vscode.Range }>()
const playheadTimeouts = new Set<NodeJS.Timeout>()

function playheadColorConfig(): PlayheadColorConfig {
  const config = vscode.workspace.getConfiguration('orbitscore')
  // seqColors intentionally absent: per-seq pinning arrives as a DSL feature
  // (#391), not a setting (owner 2026-07-07).
  return {
    palette: config.get<string[]>('playheadPalette'),
  }
}

function ensurePlayheadDecorationType(color: string): vscode.TextEditorDecorationType {
  let decorationType = playheadDecorationTypes.get(color)
  if (!decorationType) {
    decorationType = vscode.window.createTextEditorDecorationType({
      // 50% alpha fill + solid border: must stay readable on top of the editor
      // selection background (owner feedback 2026-07-07 — theme find-match
      // color was too faint).
      backgroundColor: `${color}80`,
      border: `1.5px solid ${color}`,
      borderRadius: '3px',
    })
    playheadDecorationTypes.set(color, decorationType)
  }
  return decorationType
}

/** Drop all decoration types (e.g. after a color-config change) and redraw. */
export function resetPlayheadDecorationTypes(): void {
  for (const decorationType of playheadDecorationTypes.values()) {
    decorationType.dispose() // dispose also removes it from every editor
  }
  playheadDecorationTypes.clear()
  applyPlayheadDecorations()
}

/** Re-apply the current per-seq playhead ranges to every visible editor. */
function applyPlayheadDecorations(): void {
  const colorConfig = playheadColorConfig()
  for (const editor of vscode.window.visibleTextEditors) {
    const uri = editor.document.uri.toString()
    // Start every known type at [] so a seq that stopped (or moved) has its
    // previous color cleared, then fill in the live ranges per color.
    const rangesByType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>()
    for (const decorationType of playheadDecorationTypes.values()) {
      rangesByType.set(decorationType, [])
    }
    for (const [seqName, entry] of playheadActiveRanges) {
      if (entry.docUriString !== uri) continue
      const decorationType = ensurePlayheadDecorationType(
        colorForSeq(seqName, colorConfig, playheadPaletteAssignments),
      )
      const ranges = rangesByType.get(decorationType) ?? []
      ranges.push(entry.range)
      rangesByType.set(decorationType, ranges)
    }
    for (const [decorationType, ranges] of rangesByType) {
      editor.setDecorations(decorationType, ranges)
    }
  }
}

/**
 * Schedule the decoration for one parsed `[STEP]`. Dispatch is lookahead-early,
 * so wait until `atEpochMs` (the event's grid time — actual audio lands a
 * uniform ~50ms daemon lookahead later, see playhead.ts) before moving the
 * highlight; a marginally late line still tracks (clamped to now), while stale
 * lines (>1s late, e.g. replayed buffered output) are dropped.
 */
export function handleStepLine(step: StepEvent): void {
  const delayMs = step.atEpochMs - Date.now()
  if (delayMs < -1000) return
  const timeout = setTimeout(
    () => {
      playheadTimeouts.delete(timeout)
      showPlayheadStep(step)
    },
    Math.max(0, delayMs),
  )
  playheadTimeouts.add(timeout)
}

function showPlayheadStep(step: StepEvent): void {
  for (const editor of vscode.window.visibleTextEditors) {
    // Resolves the full dot path ("1.0" → first element inside the 2nd arg),
    // degrading to the deepest resolvable ancestor (stacks are one visual
    // unit). Null = even the top-level arg is gone (user edited away the
    // pattern) — skip; leaving the previous highlight is less misleading
    // than lighting a wrong arg.
    const argRange = findPlayArgRangeForPath(editor.document.getText(), step.seqName, step.argPath)
    if (!argRange) continue
    playheadActiveRanges.set(step.seqName, {
      docUriString: editor.document.uri.toString(),
      range: new vscode.Range(
        editor.document.positionAt(argRange.start),
        editor.document.positionAt(argRange.end),
      ),
    })
    applyPlayheadDecorations()
    return // first visible editor containing the call wins (MVP)
  }
}

export function clearPlayheadForSequence(seqName: string): void {
  if (playheadActiveRanges.delete(seqName)) {
    applyPlayheadDecorations()
  }
}

export function clearAllPlayheadDecorations(): void {
  for (const timeout of playheadTimeouts) {
    clearTimeout(timeout)
  }
  playheadTimeouts.clear()
  if (playheadActiveRanges.size > 0) {
    playheadActiveRanges.clear()
    applyPlayheadDecorations()
  }
}

// -- Playhead test seams (#527 review round 3 Critical #1) ------------------
//
// `clearAllPlayheadDecorations()` had no independent test coverage at all —
// every existing assertion about `setupExitHandler`/`setupStdoutHandler`
// checked only `engineProcess` (governed by `clearEngineState`), so swapping
// which real implementation lands under the `clearEngineState` vs.
// `clearAllPlayheads` effect keys type-checked and left every test green.
// These seams let a spec seed a playhead range and observe its OWN clearing
// (via the real `editor.setDecorations` call, once a fake editor is pushed
// into the `vscode` mock's `window.visibleTextEditors`) as a signal
// independent of `engineProcess`.
/** Seed a playhead active range as if a real `[STEP]` line had resolved to it
 * — bypasses playhead.ts's document-text parsing (already covered by
 * playhead.spec.ts) and also pre-creates the color's decoration type via
 * `ensurePlayheadDecorationType`, so `clearAllPlayheadDecorations()`'s
 * `editor.setDecorations(type, [])` call is observable rather than skipped
 * for want of a registered decoration type. */
export function __setPlayheadActiveRangeForTest(
  seqName: string,
  docUriString: string,
  // `unknown`, not `vscode.Range`: the mock's `Range` (tests/mocks/vscode.ts)
  // is a minimal duck-typed stand-in that does not structurally satisfy the
  // real `@types/vscode` interface, and nothing this seam's consumers read
  // needs more than `{ start, end }` — accepting the real type here would
  // just push an `as unknown as vscode.Range` cast onto every call site.
  range: unknown,
): void {
  ensurePlayheadDecorationType(
    colorForSeq(seqName, playheadColorConfig(), playheadPaletteAssignments),
  )
  playheadActiveRanges.set(seqName, { docUriString, range: range as vscode.Range })
}
export function __getPlayheadActiveRangeCountForTest(): number {
  return playheadActiveRanges.size
}
/** Number of pending playhead-step `setTimeout`s — `handleStepLine` adds one
 * synchronously on every `[STEP]` line it processes (unless the event is
 * stale), independent of clearSequence/clearAllPlayheads/
 * handleSelectAudioDeviceLine, so this is a signal specific to `handleStep`
 * wiring in `setupStdoutHandler`. */
export function __getPlayheadTimeoutCountForTest(): number {
  return playheadTimeouts.size
}
/** Resets all module-private playhead state between specs — disposes every
 * decoration type and clears every pending timeout, so one spec's seeded
 * range/decoration type never leaks into the next. */
export function __resetPlayheadStateForTest(): void {
  for (const timeout of playheadTimeouts) clearTimeout(timeout)
  playheadTimeouts.clear()
  playheadActiveRanges.clear()
  for (const decorationType of playheadDecorationTypes.values()) decorationType.dispose()
  playheadDecorationTypes.clear()
  playheadPaletteAssignments.clear()
}
