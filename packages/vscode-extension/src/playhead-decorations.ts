/** VS Code decoration state and rendering for live playhead highlights. */
import * as vscode from 'vscode'

import {
  colorForSeq,
  createPlayheadDoc,
  findPlayCalls,
  resolvePlayheadStep,
  shiftPlayCallAnchor,
  type PlayheadColorConfig,
  type StepEvent,
} from './playhead'
import { engineGeneration } from './extension-state'

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
// #391). ONE active entry per seq (replaced on each step, so the highlight
// "moves" per beat and wraps at loop start). Cleared on seq stop (`⏹ <seq>`
// line), global stop, engine stop / exit, and deactivate.
export const playheadDecorationTypes = new Map<string, vscode.TextEditorDecorationType>()
const playheadPaletteAssignments = new Map<string, number>()
interface PlayheadAnchor {
  callStart: number
  openParen: number
}

interface ActivePlayheadEntry {
  docUriString: string
  argPath: string
  anchor?: PlayheadAnchor
}

const playheadActiveRanges = new Map<string, ActivePlayheadEntry>()
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
  const docsByUri = new Map<string, ReturnType<typeof createPlayheadDoc>>()
  for (const editor of vscode.window.visibleTextEditors) {
    const uri = editor.document.uri.toString()
    const entries = [...playheadActiveRanges].filter(([, entry]) => entry.docUriString === uri)
    // Start every known type at [] so a seq that stopped (or moved) has its
    // previous color cleared, then fill in the live ranges per color.
    const rangesByType = new Map<vscode.TextEditorDecorationType, vscode.Range[]>()
    for (const decorationType of playheadDecorationTypes.values()) {
      rangesByType.set(decorationType, [])
    }
    let doc = docsByUri.get(uri)
    if (entries.length > 0 && !doc) {
      doc = createPlayheadDoc(editor.document.getText())
      docsByUri.set(uri, doc)
    }
    const text = doc?.text ?? ''
    for (const [seqName, entry] of entries) {
      let anchor = entry.anchor
      const source = currentPlayheadSource(seqName)
      if (source?.docUriString === uri) {
        if (source.anchor === null) continue
        anchor = source.anchor
      }
      const resolution = resolvePlayheadStep(text, seqName, entry.argPath, anchor, doc)
      if (resolution.kind !== 'range') continue
      const decorationType = ensurePlayheadDecorationType(
        colorForSeq(seqName, colorConfig, playheadPaletteAssignments),
      )
      const ranges = rangesByType.get(decorationType) ?? []
      ranges.push(
        new vscode.Range(
          editor.document.positionAt(resolution.range.start),
          editor.document.positionAt(resolution.range.end),
        ),
      )
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

interface PlayheadSource {
  docUriString: string
  engineGeneration: number
  anchor: PlayheadAnchor | null
}

const playheadSources = new Map<string, PlayheadSource>()

/** Record the last play call per sequence from only the ranges sent to the engine. */
export function recordPlayheadSources(
  document: vscode.TextDocument,
  sentRanges: readonly vscode.Range[],
): void {
  const calls = sentRanges.flatMap((range) => {
    const rangeStart = document.offsetAt(range.start)
    return findPlayCalls(document.getText(range)).map((call) => ({
      ...call,
      callStart: call.callStart + rangeStart,
      openParen: call.openParen + rangeStart,
    }))
  })
  calls.sort((a, b) => a.callStart - b.callStart)
  const docUriString = document.uri.toString()
  for (const call of calls) {
    playheadSources.set(call.seqName, {
      docUriString,
      engineGeneration,
      anchor: { callStart: call.callStart, openParen: call.openParen },
    })
  }
}

/** Make agent-supplied play calls fall back to the first visible editor call. */
export function forgetPlayheadSourcesInCode(code: string): void {
  for (const call of findPlayCalls(code)) {
    playheadSources.delete(call.seqName)
  }
}

/** Shift recorded call offsets and redraw active entries from the edited text. */
export function notePlayheadDocumentChange(event: vscode.TextDocumentChangeEvent): void {
  if (playheadSources.size === 0 && playheadActiveRanges.size === 0) return
  const docUriString = event.document.uri.toString()
  for (const source of playheadSources.values()) {
    if (source.docUriString !== docUriString || source.anchor === null) continue
    source.anchor = shiftPlayCallAnchor(source.anchor, event.contentChanges)
  }
  if ([...playheadActiveRanges.values()].some((entry) => entry.docUriString === docUriString)) {
    applyPlayheadDecorations()
  }
}

function currentPlayheadSource(seqName: string): PlayheadSource | undefined {
  const source = playheadSources.get(seqName)
  return source?.engineGeneration === engineGeneration ? source : undefined
}

function setActivePlayheadEntry(
  editor: vscode.TextEditor,
  seqName: string,
  argPath: string,
  anchor?: PlayheadAnchor,
): void {
  playheadActiveRanges.set(seqName, {
    docUriString: editor.document.uri.toString(),
    argPath,
    ...(anchor ? { anchor } : {}),
  })
  applyPlayheadDecorations()
}

function showPlayheadStep(step: StepEvent): void {
  const source = currentPlayheadSource(step.seqName)
  // A recorded source belongs only to the file that was actually run (#987 C1),
  // so do not search another visible editor for the same sequence.
  const editors = source
    ? vscode.window.visibleTextEditors.filter(
        (candidate) => candidate.document.uri.toString() === source.docUriString,
      )
    : vscode.window.visibleTextEditors

  // An invalidated recorded call must clear instead of falling back to the first
  // play(): that could light an unsounding line—the exact bug in Issue #987 §1.
  if (source?.anchor === null) {
    clearPlayheadForSequence(step.seqName)
    return
  }

  for (const editor of editors) {
    const resolution = resolvePlayheadStep(
      editor.document.getText(),
      step.seqName,
      step.argPath,
      source?.anchor,
    )
    switch (resolution.kind) {
      case 'no-call':
        // Do not fall back to the first play(): lighting an unsounding line is
        // the issue's original bug, so a missing recorded call clears safely (§1).
        if (source) {
          clearPlayheadForSequence(step.seqName)
          return
        }
        continue
      case 'out-of-range':
        // Keep the previous display, matching existing behavior; choosing another
        // argument would misleadingly light a value that is not sounding.
        if (source) return
        continue
      case 'range':
        setActivePlayheadEntry(editor, step.seqName, step.argPath, source?.anchor ?? undefined)
        return
    }
    const exhaustive: never = resolution
    return exhaustive
  }
}

export function clearPlayheadForSequence(seqName: string): void {
  if (playheadActiveRanges.delete(seqName)) applyPlayheadDecorations()
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
// These seams let a spec seed a playhead entry and observe its OWN clearing
// (via the real `editor.setDecorations` call, once a fake editor is pushed
// into the `vscode` mock's `window.visibleTextEditors`) as a signal
// independent of `engineProcess`.
/** Seed a playhead active entry as if a real `[STEP]` line had resolved to it
 * — bypasses playhead.ts's document-text parsing (already covered by
 * playhead.spec.ts) and also pre-creates the color's decoration type via
 * `ensurePlayheadDecorationType`, so `clearAllPlayheadDecorations()`'s
 * `editor.setDecorations(type, [])` call is observable rather than skipped
 * for want of a registered decoration type. */
export function __setPlayheadActiveRangeForTest(
  seqName: string,
  docUriString: string,
  // Kept for compatibility with wiring specs that predate derived entries;
  // coordinates are intentionally ignored because production entries no
  // longer store a vscode.Range.
  _range: unknown,
): void {
  ensurePlayheadDecorationType(
    colorForSeq(seqName, playheadColorConfig(), playheadPaletteAssignments),
  )
  playheadActiveRanges.set(seqName, { docUriString, argPath: '0' })
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
  playheadSources.clear()
}
