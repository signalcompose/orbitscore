/**
 * 評価の受付口 — 段階 1 の足場（設計 848 §4.5.1・台帳 P-01）。
 *
 * PROVISIONAL(P-01): 凍結版 `packages/engine/src/cli/repl-mode.ts` の `createReplSession`
 * （行を溜めてパースし、入力の終端で終わった時だけ未完として溜め、空行 2 連で強制実行する）の
 * **写し**である。#997 の評価のかたち（束 S-eval）で置き換わり、このモジュールごと消える。
 * それまでは凍結版との差分テスト（`tests/session/eval-intake-parity.spec.ts`・台帳 P-02）が
 * 一致を守る。凍結版に bug fix が入って差分テストが red になったら、同じ PR でここを直す。
 *
 * 🔴 写す相手は凍結版の **MCP の評価の経路**（`agent-handlers.ts` の `evaluateForAgent`）が
 * engine の stdin に流す行の列である:
 *
 * ```
 * //#evalBegin                     → batch.begin()
 * //#documentDirectory <dir>|空    → 要求の documentDirectory（毎回必須・null は空文字）
 * <code の各行>                    → handleCodeLine()（凍結版の handleLine の末尾と同じ）
 * //#evalEnd                       → batch.end()
 * //#evalMark {"requestId":…}      → 残ったバッファの強制実行と診断の返却（= 応答）
 * ```
 *
 * `session.evaluate` は応答で診断を返す（設計 §5.3.1）ので、人の評価でも MCP の評価でも
 * 最後の行（`//#evalMark`）まで写す。凍結版の人の経路（⌘Enter）は `//#evalMark` を送らず、
 * 未完の入力が次の評価へ持ち越される — これは写さない（要求の終わりで強制実行する・設計 §5.3.1）。
 *
 * 写さないもの（メタ行の通信路から来たもの。設計 §5.3 の「引き継がない」）:
 * - メタ行そのもの。評価するコードの中に `//#…` の行があっても、ここでは DSL のコメントとして
 *   パーサへ渡す（凍結版では帯域外の命令として解釈される）
 * - `//#documentDirectory` の行が 1 行として実行される空の評価（`execute()` の呼び出しが 1 回
 *   多い）。基準は各 `execute()` の `documentDirectory` で渡す
 * - 拡張が DSL として注入する `global.setDocumentDirectory(...)`。in-process では `execute()` が
 *   自分で設定する（`interpreter-v2.ts` の `documentDirectory` の処理）
 * - 改行や前後の空白を含む `documentDirectory` の加工（メタ行が 1 行であるための制約）
 *
 * 出力は構造化した値で返す: 診断は応答の `diagnostics`、凍結版が stderr に書く行は `log` へ
 * （`log.line` の `kind` は設計 §5.3.6）。凍結版が stdout に書く `✓` は応答の `ok` に吸収する。
 */

import { parseAudioDSL, type AudioIR } from '@orbitscore/engine/dist/parser/audio-parser'
import { AudioLine } from '@orbitscore/engine/dist/core/sequence/audio-line'

export type EvaluationSource = 'human' | 'agent'

export interface EvaluationRequest {
  code: string
  /** 毎回必須。`null` = 基準なし（`execute()` の空文字 = 前の基準のクリアへ写す・設計 §5.3.1）。 */
  documentDirectory: string | null
  source: EvaluationSource
}

export interface EvaluationDiagnostic {
  kind: 'parse' | 'runtime'
  message: string
}

export interface EvaluationOutcome {
  /** `diagnostics` が空の時だけ true（凍結版の `//#evalMark` と同じ）。 */
  ok: boolean
  diagnostics: EvaluationDiagnostic[]
  /** 実際に使った値（要求の値をそのまま返す）。 */
  documentDirectory: string | null
}

/** 凍結版が stderr に書いていた行。`kind` は設計 §5.3.6 の `log.line` の分類。 */
export interface IntakeLogLine {
  kind: 'diagnostic' | 'stall' | 'session'
  level: 'error'
  text: string
}

export interface IntakeExecuteOptions {
  source: string
  evalSource: EvaluationSource
  documentDirectory: string
}

export interface EvaluationIntakeDeps {
  /** `InterpreterV2.execute` を呼ぶ口。 */
  execute(ir: AudioIR, options: IntakeExecuteOptions): Promise<void>
  log(line: IntakeLogLine): void
  /** 既定は engine の `parseAudioDSL`。 */
  parse?: (code: string) => AudioIR
  /** 既定は `AudioLine.beginBatchAll()` / `endBatchAll()`（#611 §5.7）。 */
  batch?: { begin(): void; end(): void }
  /** 既定は凍結版と同じ 60 秒。 */
  stallReportMs?: number
}

export interface EvaluationIntake {
  evaluate(request: EvaluationRequest): Promise<EvaluationOutcome>
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
 * 凍結版の stdin を readline が分ける規則（`\n` / `\r` / `\r\n`）でコードを行に分ける。
 * 凍結版はコードの後ろに `\n//#evalEnd` を続けて送るので、コードの最後の行はその `\n` で
 * 終わる（コードが `\r` で終わる時は `\r\n` が 1 つの改行になる）。
 */
export function splitIntoReplLines(code: string): string[] {
  const parts = `${code}\n`.split(/\r\n|\r|\n/)
  parts.pop()
  return parts
}

interface RequestContext {
  documentDirectory: string
  evalSource: EvaluationSource
  diagnostics: EvaluationDiagnostic[]
}

export function createEvaluationIntake(deps: EvaluationIntakeDeps): EvaluationIntake {
  const parse = deps.parse ?? parseAudioDSL
  const batch = deps.batch ?? {
    begin: () => AudioLine.beginBatchAll(),
    end: () => AudioLine.endBatchAll(),
  }
  const stallReportMs = deps.stallReportMs ?? QUEUE_STALL_REPORT_MS

  let buffer = ''
  let emptyLineCount = 0
  let queue: Promise<void> = Promise.resolve()
  /** 受け付けたがまだ始まっていない段の数（全要求の行 + 各要求の最後の強制実行）。 */
  let waitingSteps = 0

  const reportError = (kind: IntakeLogLine['kind'], text: string): void => {
    deps.log({ kind, level: 'error', text })
  }

  async function executeCurrentBuffer(
    clearOnIncomplete: boolean,
    ctx: RequestContext,
  ): Promise<void> {
    const code = buffer.trim()
    if (!code) {
      buffer = ''
      emptyLineCount = 0
      return
    }
    // 🔴 #612: 「未完」判定はパース段のエラーにだけ適用する（実行時エラーの文言は
    // ユーザー由来の文字列を含み、`EOF` を含みうる）。
    let ir: AudioIR
    try {
      ir = parse(code)
    } catch (error: any) {
      // 🔴 #607: 「未完」と判定してよいのはパーサが入力の終端（EOF）に達した場合だけ。
      // 行の途中の不正トークンを未完として保留すると、以後の入力が合体して永久に止まる。
      if (!clearOnIncomplete && /\bEOF\b/.test(String(error.message ?? ''))) {
        return
      }
      reportError('diagnostic', `[ERROR] ${error.message}`)
      ctx.diagnostics.push({ kind: 'parse', message: String(error.message) })
      buffer = ''
      return
    }

    // ここから先は入力が完結している — 失敗しても保留せず必ず報告してバッファを捨てる。
    try {
      await deps.execute(ir, {
        source: code,
        evalSource: ctx.evalSource,
        documentDirectory: ctx.documentDirectory,
      })
    } catch (error: any) {
      reportError('diagnostic', `[ERROR] ${error.message}`)
      ctx.diagnostics.push({ kind: 'runtime', message: String(error.message) })
    }
    buffer = ''
  }

  /** 凍結版 `handleLine` のうち、メタ行でない行の処理（`repl-mode.ts` の末尾 2 分岐）。 */
  async function handleCodeLine(line: string, ctx: RequestContext): Promise<void> {
    if (line.trim() === '') {
      emptyLineCount++
      buffer += '\n'
      // 2+ 連続空行 = バッファ確定・強制実行
      if (emptyLineCount >= 2 && buffer.trim()) {
        await executeCurrentBuffer(true, ctx)
        emptyLineCount = 0
      }
      return
    }
    emptyLineCount = 0
    buffer += line + '\n'
    await executeCurrentBuffer(false, ctx)
  }

  /** 1 段が [`stallReportMs`] を超えても終わらないあいだ、繰り返し報告する（#607）。 */
  async function runWithStallReport(preview: string, step: () => Promise<void>): Promise<void> {
    const startedAt = Date.now()
    const shown = preview.trim().slice(0, 120)
    const timer = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      reportError(
        'stall',
        `[ERROR] REPL queue is still blocked after ${seconds}s by: ${shown}` +
          ` — ${waitingSteps} line(s) are waiting behind it and will not run until it finishes.` +
          ` They are accepted but NOT executed.`,
      )
    }, stallReportMs)
    timer.unref?.()
    try {
      await step()
    } finally {
      clearInterval(timer)
    }
  }

  async function runRequest(
    request: EvaluationRequest,
    lines: string[],
  ): Promise<EvaluationOutcome> {
    const ctx: RequestContext = {
      documentDirectory: request.documentDirectory ?? '',
      evalSource: request.source,
      diagnostics: [],
    }
    let notStarted = lines.length + 1
    try {
      batch.begin()
      // 凍結版では `//#documentDirectory` の行がここで 1 行として処理され、空行の数え上げを
      // 0 に戻してバッファを捨てる。ふつうは前の要求の強制実行の後に空白しか残らないので
      // 何も変えないが、想定外の失敗で途中のまま終わった要求のバッファを次の要求へ持ち越さない。
      buffer = ''
      emptyLineCount = 0
      try {
        for (const line of lines) {
          notStarted--
          waitingSteps--
          await runWithStallReport(line, () => handleCodeLine(line, ctx))
        }
      } finally {
        // #611 §5.7 guard 2 と同じ保証: 1 行の失敗でもバッチは必ず閉じる。
        batch.end()
      }
      // `//#evalMark` は提出の境界 — 未完のまま残った入力を強制実行してから報告する（#614）。
      notStarted--
      waitingSteps--
      if (buffer.trim()) {
        await runWithStallReport(buffer, () => executeCurrentBuffer(true, ctx))
        emptyLineCount = 0
      }
    } finally {
      waitingSteps -= notStarted
    }
    return {
      ok: ctx.diagnostics.length === 0,
      diagnostics: ctx.diagnostics,
      documentDirectory: request.documentDirectory,
    }
  }

  return {
    evaluate(request: EvaluationRequest): Promise<EvaluationOutcome> {
      const lines = splitIntoReplLines(request.code)
      waitingSteps += lines.length + 1
      const run = queue.then(() => runRequest(request, lines))
      // 1 件の想定外の失敗で以後の評価が全停止しないように、チェーン自体は reject を握る。
      // 黙って握ると劣化が見えなくなるので、必ず痕跡を残す（凍結版 `pushLine` の catch と同じ）。
      queue = run.then(
        () => undefined,
        (error: any) => {
          try {
            reportError(
              'session',
              `[ERROR] unexpected REPL queue failure: ${error?.message ?? String(error)}`,
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
