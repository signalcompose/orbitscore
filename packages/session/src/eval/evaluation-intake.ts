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
 * - 拡張が DSL として注入する `global.setDocumentDirectory(...)`。in-process では `execute()` が
 *   自分で設定する（`interpreter-v2.ts` の `documentDirectory` の処理）
 * - 改行や前後の空白を含む `documentDirectory` の加工（メタ行が 1 行であるための制約）
 * - 人の経路が未保存の文書に送る `documentDirectory: '.'`。層 2 の WebView は保存先が無ければ
 *   `null` を送り、受付口も契約どおり絶対パスか `null` だけを受ける（設計 §5.3.1）
 * - 凍結版が常に `evalSource: 'human'` を渡すこと。層 2 は要求の `source` を渡す（doc 694 G4）
 * - MCP の経路に無い振る舞い。差分テストは MCP の経路だけを駆動するため、#620 の人の経路の
 *   診断漏れと、2 回に分けた選択実行で未完の入力を持ち越す振る舞いは段階 1 では観測しない
 *
 * 出力は構造化した値で返す: 診断は応答の `diagnostics`、凍結版が stderr に書く行は `log` へ
 * （`log.line` の `kind` は設計 §5.3.6）。凍結版が stdout に書く `✓` は応答の `ok` に吸収する。
 */

import path from 'node:path'

import { AudioLine } from '@orbitscore/engine/dist/core/sequence/audio-line'
import { parseAudioDSL, type AudioIR } from '@orbitscore/engine/dist/parser/audio-parser'

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
 * 出荷物の Node 24 以上で readline が分ける規則
 * （`\n` / `\r` / `\r\n` / U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR）で行に分ける。
 * 凍結版はコードの後ろに `\n//#evalEnd` を続けて送るので、コードの最後の行はその `\n` で
 * 終わる（コードが `\r` で終わる時は `\r\n` が 1 つの改行になる）。
 */
export function splitIntoReplLines(code: string): string[] {
  const parts = `${code}\n`.split(/\r?\n|\r(?!\n)|\u2028|\u2029/)
  parts.pop()
  return parts
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const documentDirectoryMeta = (documentDirectory: string | null): string =>
  `//#documentDirectory${documentDirectory === null ? '' : ` ${documentDirectory}`}`

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
  /** 受け付けたがまだ始まっていない段の数（要求のメタ行・コード行をすべて含む）。 */
  let waitingSteps = 0

  const reportError = (kind: IntakeLogLine['kind'], text: string): void => {
    try {
      deps.log({ kind, level: 'error', text })
    } catch (error: unknown) {
      // `diagnostics` が主、log は従。従の sink が壊れても評価を壊さず、別の口に痕跡を残す。
      try {
        process.stderr.write(`[ERROR] evaluation intake log sink failed: ${messageOf(error)}\n`)
      } catch {
        // stderr 自体の故障には安全な第 3 の同期出力先が無い。timer から例外だけは漏らさない。
      }
    }
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
    } catch (error: unknown) {
      const message = messageOf(error)
      // 🔴 #607: 「未完」と判定してよいのはパーサが入力の終端（EOF）に達した場合だけ。
      // 行の途中の不正トークンを未完として保留すると、以後の入力が合体して永久に止まる。
      if (!clearOnIncomplete && /\bEOF\b/.test(message)) {
        return
      }
      ctx.diagnostics.push({ kind: 'parse', message })
      reportError('diagnostic', `[ERROR] ${message}`)
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
    } catch (error: unknown) {
      const message = messageOf(error)
      ctx.diagnostics.push({ kind: 'runtime', message })
      reportError('diagnostic', `[ERROR] ${message}`)
    }
    buffer = ''
  }

  async function executeDocumentDirectoryMeta(meta: string, ctx: RequestContext): Promise<void> {
    emptyLineCount = 0
    const ir: AudioIR = { sequenceInits: [], statements: [], fileImports: [] }
    try {
      await deps.execute(ir, {
        source: meta,
        evalSource: ctx.evalSource,
        documentDirectory: ctx.documentDirectory,
      })
    } catch (error: unknown) {
      const message = messageOf(error)
      ctx.diagnostics.push({ kind: 'runtime', message })
      reportError('diagnostic', `[ERROR] ${message}`)
    }
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
    // 凍結版でキューに載る evalBegin / documentDirectory / code / evalEnd / evalMark の全段。
    let notStarted = lines.length + 4
    try {
      const ctx: RequestContext = {
        documentDirectory: request.documentDirectory ?? '',
        evalSource: request.source,
        diagnostics: [],
      }

      // 凍結版の pushLine は 1 行ごとに想定外の失敗を握って次の行へ進む。evalMark まで進めて
      // 応答を返すことを、ここでも要求単位の reject より優先する。
      const runLine = async (preview: string, step: () => Promise<void> | void): Promise<void> => {
        notStarted--
        waitingSteps--
        try {
          await runWithStallReport(preview, async () => step())
        } catch (error: unknown) {
          reportError('session', `[ERROR] unexpected REPL queue failure: ${messageOf(error)}`)
        }
      }

      await runLine('//#evalBegin', () => batch.begin())

      // メタ行は batch の内側で最初に空の IR として execute される。これにより、コードが空でも
      // 全行が parse error でも、要求ごとに基準を設定（null は空文字でクリア）する。
      const meta = documentDirectoryMeta(request.documentDirectory)
      await runLine(meta, () => executeDocumentDirectoryMeta(meta, ctx))

      for (const line of lines) {
        await runLine(line, () => handleCodeLine(line, ctx))
      }
      await runLine('//#evalEnd', () => batch.end())
      await runLine('//#evalMark', async () => {
        // `//#evalMark` は提出の境界 — 未完のまま残った入力を強制実行してから報告する（#614）。
        if (buffer.trim()) {
          await executeCurrentBuffer(true, ctx)
          emptyLineCount = 0
        }
      })

      return {
        ok: ctx.diagnostics.length === 0,
        diagnostics: ctx.diagnostics,
        documentDirectory: request.documentDirectory,
      }
    } finally {
      waitingSteps -= notStarted
    }
  }

  return {
    evaluate(request: EvaluationRequest): Promise<EvaluationOutcome> {
      if (typeof request?.code !== 'string') {
        return Promise.reject(new TypeError('evaluation code must be a string'))
      }
      if (
        request.documentDirectory !== null &&
        (typeof request.documentDirectory !== 'string' ||
          !path.isAbsolute(request.documentDirectory))
      ) {
        return Promise.reject(
          new TypeError('evaluation documentDirectory must be an absolute path or null'),
        )
      }
      const lines = splitIntoReplLines(request.code)
      waitingSteps += lines.length + 4
      const run = queue.then(() => runRequest(request, lines))
      // 1 件の想定外の失敗で以後の評価が全停止しないように、チェーン自体は reject を握る。
      // 黙って握ると劣化が見えなくなるので、必ず痕跡を残す（凍結版 `pushLine` の catch と同じ）。
      queue = run.then(
        () => undefined,
        (error: unknown) => {
          reportError('session', `[ERROR] unexpected REPL queue failure: ${messageOf(error)}`)
        },
      )
      return run
    },
    idle(): Promise<void> {
      return queue
    },
  }
}
