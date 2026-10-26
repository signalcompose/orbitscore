/**
 * 評価の受付口 — #997 の評価のかたち（設計 997 §4・spec「評価の単位」E-1〜E-6・束 S-eval #1022）。
 *
 * 1 回の要求（`session.evaluate`）を次の順で処理する:
 *
 * 1. **1 度に読む**（E-1）: `code` 全体を engine の `parseAudioDSLWithSpans` で読み、文の列（ソースの順・
 *    範囲つき）にする。空行は文を切らず、行頭の `.` は前の文のチェーンの続き
 * 2. **構文エラーなら何も実行しない**（E-2・Q-1 = A）: 診断は位置つき（`range` = 要求の `code` の座標）
 * 3. **1 まとまりで実行する**（E-6）: `AudioLine` のバッチを 1 回開き、engine の `executeStatements` に
 *    文の列を渡す（ソースの順・実行時エラーはその文だけ・import の失敗は残りを止める = E-3〜E-5）。
 *    `.orbslog` の記録は 1 件
 *
 * 段階 1 の足場（凍結版 `repl-mode.ts` の区切り方の写し）はこのモジュールで置き換えた（台帳 P-01）。
 * 凍結版との差は `tests/session/eval-intake-parity.spec.ts` が「違いの記録」として 1 件ずつ持つ（P-02）。
 *
 * 要求は 1 本の FIFO で直列に処理する（#476）。1 つの要求が [`QUEUE_STALL_REPORT_MS`] を超えても
 * 終わらない間は、実行中の文と後ろで待つ要求の数を繰り返し報告する（#607。打ち切らない）。
 */

import { AudioLine } from '@orbitscore/engine/dist/core/sequence/audio-line'
import {
  DslSyntaxError,
  parseAudioDSLWithSpans,
  type ParsedRequest,
  type SourceSpan,
} from '@orbitscore/engine/dist/parser/audio-parser'

export type EvaluationSource = 'human' | 'agent'

export interface EvaluationRequest {
  code: string
  /** 毎回必須。`null` = 基準なし（`executeStatements()` の空文字 = 前の基準のクリアへ写す・設計 848 §5.3.1）。 */
  documentDirectory: string | null
  source: EvaluationSource
}

export interface EvaluationDiagnostic {
  kind: 'parse' | 'runtime'
  message: string
  /**
   * 要求の `code` の中の位置（0 始まり・UTF-16）。構文エラーは読めなかったトークンの位置（幅 0）、
   * 実行時エラーは失敗した文の範囲。分からない時（engine の想定外の失敗）は無い。
   */
  range?: SourceSpan
}

export interface EvaluationOutcome {
  /** `diagnostics` が空の時だけ true。 */
  ok: boolean
  diagnostics: EvaluationDiagnostic[]
  /** 実際に使った値（要求の値をそのまま返す）。 */
  documentDirectory: string | null
}

/** 受付口が出すログの行。`kind` は設計 848 §5.3.6 の `log.line` の分類。 */
export interface IntakeLogLine {
  kind: 'diagnostic' | 'stall' | 'session'
  level: 'error'
  text: string
}

export interface IntakeExecuteOptions {
  /** 要求の `code` 全体（`.orbslog` の 1 レコードの `code`）。 */
  source: string
  evalSource: EvaluationSource
  documentDirectory: string
}

/** engine が呼ぶ口（`index` は `request.entries` の添字）。 */
export interface IntakeExecuteHooks {
  /** 文の実行の直前。 */
  onStatement(index: number): void
  /** 文が失敗したその時（ログの順を凍結版と同じにする — 失敗は後ろの文の出力より先に出る）。 */
  onFailure(index: number, message: string): void
}

/** 実行時に失敗した文（`index` は `request.entries` の添字）。 */
export interface StatementFailure {
  index: number
  message: string
}

/**
 * 層 2 が要求に添える帰属（`evalId` / `clientId`）。受付口は解釈せず、その要求の処理中に呼ぶ
 * `execute` と `log` へそのまま渡す（`log.line` の `evalId` / `clientId` のため）。
 */
export interface IntakeContext {
  evalId?: string
  clientId?: string
}

export interface EvaluationIntakeDeps {
  /** `InterpreterV2.executeStatements` を呼ぶ口。失敗した文の一覧を返す。 */
  execute(
    request: ParsedRequest,
    options: IntakeExecuteOptions,
    context: IntakeContext,
    hooks: IntakeExecuteHooks,
  ): Promise<StatementFailure[]>
  log(line: IntakeLogLine, context: IntakeContext): void
  /** 既定は engine の `parseAudioDSLWithSpans`。 */
  parse?: (code: string) => ParsedRequest
  /** 既定は `AudioLine.beginBatchAll()` / `endBatchAll()`（#611 §5.7）。 */
  batch?: { begin(): void; end(): void }
  /** 既定は 60 秒（凍結版と同じ）。 */
  stallReportMs?: number
}

export interface EvaluationIntake {
  evaluate(request: EvaluationRequest, context?: IntakeContext): Promise<EvaluationOutcome>
  /** キューが空になるまで待つ（テスト・shutdown 用）。 */
  idle(): Promise<void>
}

/**
 * 実行中の評価が滞留していることを報告するまでの待ち時間（凍結版 `QUEUE_STALL_REPORT_MS`・#607）。
 * 打ち切らずに報告するだけ（instrument 6 本の attach は実測 30 秒超）。daemon の
 * `CHILD_READY_TIMEOUT`（60s）を超えてなお終わらない時だけ鳴らす。
 */
export const QUEUE_STALL_REPORT_MS = 60_000

/**
 * LSP と同じ行の規則（`\n` / `\r` / `\r\n`）でテキストを行に分ける。位置（`range` の `line`）は
 * この規則で数える（凍結版の stdin を readline が分ける規則とも同じ）。末尾の改行の後は空の 1 行。
 */
export function splitIntoReplLines(code: string): string[] {
  const parts = `${code}\n`.split(/\r\n|\r|\n/)
  parts.pop()
  return parts
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createEvaluationIntake(deps: EvaluationIntakeDeps): EvaluationIntake {
  const parse = deps.parse ?? parseAudioDSLWithSpans
  const batch = deps.batch ?? {
    begin: () => AudioLine.beginBatchAll(),
    end: () => AudioLine.endBatchAll(),
  }
  const stallReportMs = deps.stallReportMs ?? QUEUE_STALL_REPORT_MS

  let queue: Promise<void> = Promise.resolve()
  /** 受け付けたがまだ始まっていない要求の数。 */
  let waitingRequests = 0

  const reportError = (
    kind: IntakeLogLine['kind'],
    text: string,
    context: IntakeContext = {},
  ): void => {
    deps.log({ kind, level: 'error', text }, context)
  }

  /** 実行が [`stallReportMs`] を超えても終わらないあいだ、繰り返し報告する（#607）。 */
  async function runWithStallReport<T>(
    current: () => string,
    context: IntakeContext,
    step: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      reportError(
        'stall',
        `[ERROR] evaluation queue is still blocked after ${seconds}s by: ${current().trim().slice(0, 120)}` +
          ` — ${waitingRequests} request(s) are waiting behind it and will not run until it finishes.` +
          ` They are accepted but NOT executed.`,
        context,
      )
    }, stallReportMs)
    timer.unref?.()
    try {
      return await step()
    } finally {
      clearInterval(timer)
    }
  }

  async function runRequest(
    request: EvaluationRequest,
    context: IntakeContext,
  ): Promise<EvaluationOutcome> {
    const diagnostics: EvaluationDiagnostic[] = []
    const report = (diagnostic: EvaluationDiagnostic): void => {
      reportError('diagnostic', `[ERROR] ${diagnostic.message}`, context)
      diagnostics.push(diagnostic)
    }
    const outcome = (): EvaluationOutcome => ({
      ok: diagnostics.length === 0,
      diagnostics,
      documentDirectory: request.documentDirectory,
    })

    let parsed: ParsedRequest
    try {
      parsed = parse(request.code)
    } catch (error) {
      const position = error instanceof DslSyntaxError ? error.position : undefined
      report({
        kind: 'parse',
        message: messageOf(error),
        ...(position ? { range: { start: position, end: position } } : {}),
      })
      return outcome()
    }
    if (parsed.entries.length === 0) return outcome()

    let currentIndex = 0
    const reported = new Set<number>()
    const reportFailure = (index: number, message: string): void => {
      if (reported.has(index)) return
      reported.add(index)
      const span = parsed.entries[index]?.span
      report({ kind: 'runtime', message, ...(span ? { range: span } : {}) })
    }
    batch.begin()
    try {
      const failures = await runWithStallReport(
        () => parsed.entries[currentIndex]?.text ?? request.code,
        context,
        () =>
          deps.execute(
            parsed,
            {
              source: request.code,
              evalSource: request.source,
              documentDirectory: request.documentDirectory ?? '',
            },
            context,
            {
              onStatement: (index) => {
                currentIndex = index
              },
              onFailure: reportFailure,
            },
          ),
      )
      // onFailure を呼ばない実装でも、返った失敗は落とさない（報告済みのものは二重にしない）。
      for (const failure of failures) reportFailure(failure.index, failure.message)
    } catch (error) {
      // engine の想定外の失敗（起動の失敗など）。どの文かは分からないので位置は付けない。
      report({ kind: 'runtime', message: messageOf(error) })
    } finally {
      // #611 §5.7 guard 2 と同じ保証: 失敗してもバッチは必ず閉じる。
      batch.end()
    }
    return outcome()
  }

  return {
    evaluate(request: EvaluationRequest, context: IntakeContext = {}): Promise<EvaluationOutcome> {
      waitingRequests++
      const run = queue.then(() => {
        waitingRequests--
        return runRequest(request, context)
      })
      // 1 件の想定外の失敗で以後の評価が全停止しないように、チェーン自体は reject を握る。
      // 黙って握ると劣化が見えなくなるので、必ず痕跡を残す（凍結版 `pushLine` の catch と同じ）。
      queue = run.then(
        () => undefined,
        (error: unknown) => {
          try {
            reportError(
              'session',
              `[ERROR] unexpected evaluation queue failure: ${messageOf(error)}`,
            )
          } catch {
            // 報告の口まで壊れていてもキューは止めない（失敗そのものは呼び出し元へ reject で届く）。
          }
        },
      )
      return run
    },
    idle(): Promise<void> {
      return queue
    },
  }
}
