/**
 * §L1 (#229) — session log writer (.orbslog).
 *
 * Spec: docs/specs-v2/SESSION_LOG_SPEC_v1.html (全節 / §3.1 v1 scope)
 *
 * Flight-recorder model: every eval is held in a rolling buffer from engine
 * start; `global.start()` opens the file and flushes (1) a meta header, (2) the
 * buffered evals as the PREAMBLE (transport: null), (3) a `start` transport
 * record, then subsequent evals are appended line-by-line (append-only, one
 * fs write per line → a crash loses at most one partial line). `global.stop()`
 * writes a `stop` record; a later `start()` opens a NEW file (§1).
 *
 * The writer is OFF unless explicitly installed at a real entry point
 * (CLI / REPL / extension) — unit-test paths construct Global without one, so
 * `global.start()` produces no file (§3.1). Pure I/O + buffering: the caller
 * supplies the already-computed triple stamp (wall / transport / effect), so
 * this module has no engine dependency and is unit-testable in isolation.
 */

import * as fs from 'fs'
import * as path from 'path'

/** Who initiated an eval (§3 `evalSource`). */
export type EvalSource = 'human' | 'agent' | 'replay'

/** Format a Date as `YYYYMMDD-HHMMSS` (local time) for the log filename (§2). */
export function formatLogStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** One `eval` record's payload (the triple stamp is filled by the caller). */
export interface EvalRecord {
  /** Verbatim evaluated source (§3 `code`). */
  code: string
  /** ms from engine/buffer start, stamped at occurrence (§3 `wall`). */
  wall: number
  /** Musical time `bar:beat`, or null before transport runs (§3 `transport`). */
  transport: string | null
  /**
   * Resolved quantize boundary `bar:beat` at which this eval takes effect, else
   * null. v1 (§3.1): non-null ONLY for LOOP launches; quantized `play()` swaps and
   * tempo/beat/length changes use null (follow-up). (§3 `effect`)
   */
  effect: string | null
  /** Originating `.orbs` (relative), or null on the unnamed editor path (§3 `sourceFile`). */
  sourceFile: string | null
  /** Eval provenance (§3 `evalSource`). */
  evalSource: EvalSource
}

/** Inputs for opening a session file at `global.start()`. */
export interface SessionStart {
  /** ISO timestamp of `global.start()` (§3 meta `startedAt`). */
  startedAtISO: string
  /** `YYYYMMDD-HHMMSS` for the filename (derived from the start time by the caller). */
  stamp: string
  /** ms from engine/buffer start for the `start` transport record. */
  wall: number
  /** The `.orbs` that evaluated `start()` — drives basename + directory. null → `untitled` in cwd. */
  sourceFile: string | null
}

/** Engine/version identity for the meta header. */
export interface SessionMeta {
  engineVersion: string
  dslVersion: string
}

/**
 * Append-only JSONL writer for one `.orbslog` session at a time. Construct once
 * per engine; `recordEval` buffers until `start()`, then appends; `stop()` ends
 * the session and a later `start()` opens a fresh file.
 */
export class SessionLogWriter {
  private readonly meta: SessionMeta
  private readonly cwd: string
  /** Rolling preamble buffer: evals seen before the current session's `start()`. */
  private preamble: EvalRecord[] = []
  /** Open session file path, or null when no session is active (pre-start / post-stop). */
  private filePath: string | null = null
  /**
   * Set after an I/O error: logging is a flight recorder, NOT a music component —
   * a disk-full / permission failure mid-session must never break playback. Once
   * an fs write throws, we warn once and go silent for the session (a fresh
   * `start()` re-attempts). A flag, not `filePath = null`, so `recordEval` does
   * NOT re-buffer into an unbounded preamble over a long broken-disk session.
   */
  private disabled = false

  constructor(meta: SessionMeta, cwd: string) {
    this.meta = meta
    this.cwd = cwd
  }

  /** The active log file path (for diagnostics / get_session_tail), or null. */
  getFilePath(): string | null {
    return this.filePath
  }

  /**
   * Record an eval. Before `start()` it accumulates in the rolling preamble
   * buffer (stamped at occurrence); after `start()` it is appended immediately.
   */
  recordEval(rec: EvalRecord): void {
    if (this.disabled) return
    if (this.filePath === null) {
      this.preamble.push(rec)
      return
    }
    this.append(this.evalLine(rec))
  }

  /**
   * Open the session file (§1): write the meta header, flush the buffered
   * preamble (transport forced to null — transport had not run), then a `start`
   * transport record. A second `start()` after a `stop()` opens a NEW file and
   * the evals seen since then become the next preamble.
   */
  start(s: SessionStart): void {
    const basename = s.sourceFile
      ? path.basename(s.sourceFile, path.extname(s.sourceFile))
      : 'untitled'
    const dir = s.sourceFile ? path.dirname(s.sourceFile) : this.cwd
    // Two sessions opened within the same second collide on the timestamp; add a
    // counter so a stop→start within one second doesn't overwrite the first file.
    let candidate = path.join(dir, `${basename}.${s.stamp}.orbslog`)
    for (let n = 2; fs.existsSync(candidate); n++) {
      candidate = path.join(dir, `${basename}.${s.stamp}-${n}.orbslog`)
    }

    const metaLine = JSON.stringify({
      type: 'meta',
      logVersion: 1,
      engineVersion: this.meta.engineVersion,
      dslVersion: this.meta.dslVersion,
      startedAt: s.startedAtISO,
      sourceFile: s.sourceFile,
    })
    // Drain the preamble regardless of outcome (don't retain it on failure).
    const buffered = this.preamble
    this.preamble = []
    this.disabled = false // a fresh session re-attempts after a prior failure
    try {
      // Truncate-create the file with the meta header (a fresh session per start).
      fs.writeFileSync(candidate, metaLine + '\n')
    } catch (e) {
      this.disabled = true
      this.filePath = null
      console.warn(
        `⚠️  session-log: failed to open ${candidate} — logging disabled (playback continues): ${e}`,
      )
      return
    }
    this.filePath = candidate

    // Preamble: every buffered eval, transport forced null (§1 — transport未走行).
    for (const rec of buffered) {
      this.append(this.evalLine({ ...rec, transport: null, effect: null }))
    }
    this.append(JSON.stringify({ type: 'transport', wall: s.wall, event: 'start' }))
  }

  /**
   * Write the `stop` transport record and end the session (§1). `transport`
   * should be computed by the caller BEFORE the transport clock is cleared.
   * No-op if no session is open. A later `start()` opens a fresh file.
   */
  stop(wall: number, transport: string | null): void {
    if (this.filePath === null) return
    this.append(JSON.stringify({ type: 'transport', wall, transport, event: 'stop' }))
    this.filePath = null
  }

  /** Serialize one `eval` record to a JSONL line (omit-null kept explicit per §3 example). */
  private evalLine(rec: EvalRecord): string {
    return JSON.stringify({
      type: 'eval',
      wall: rec.wall,
      transport: rec.transport,
      effect: rec.effect,
      code: rec.code,
      sourceFile: rec.sourceFile,
      evalSource: rec.evalSource,
    })
  }

  /**
   * Append one line + newline with a per-line fs write (crash loses ≤1 line, §1).
   * Best-effort: an fs error disables logging for the session rather than throwing
   * into the caller — a flight recorder must never break the music.
   */
  private append(line: string): void {
    if (this.disabled || this.filePath === null) return
    try {
      fs.appendFileSync(this.filePath, line + '\n')
    } catch (e) {
      this.disabled = true
      console.warn(`⚠️  session-log: write error — logging disabled (playback continues): ${e}`)
    }
  }
}
