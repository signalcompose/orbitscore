/**
 * 評価の受付口の差分テスト — 段階 2 は「違いの記録」（設計 848 §4.5.1・設計 997 §7・台帳 P-02）。
 *
 * PROVISIONAL(P-02): 凍結版と層 2 の受付口に同じ評価の列を流し、観測（`AudioLine` のバッチの開閉・
 * 実行された単位とその基準ディレクトリ・`[ERROR]` の行・各評価の結果）を読める形の行の列に要約して
 * 比べる。**凍結版と違ってよいのは `DIFFERENCES` に載せた件だけ**で、各件は設計 997 §6 の番号と
 * 決定（D-xx）を理由に持ち、凍結版と層 2 の両方の観測を書く。一覧に無い差・一覧と違う観測は red
 * （#997 が意図しない振る舞いの変化を黙って入れない）。拡張版の退役でこの検査ごと消す。
 *
 * 🔴 凍結版の側は**本物の経路**で作る: 拡張の `writeCodeToEngine`（`engine-process.ts`）が
 * 書く行の列と、`evaluateForAgent` が続けて送る `//#evalMark` の行を、readline と同じ規則で
 * 行に分けて凍結版の `createReplSession` に流す。凍結版が bug fix で変われば、記録の `frozen` が
 * red になる（その時は同じ PR で記録を直し、層 2 に同じ修正が要るかを確かめる）。
 *
 * 実行された単位（`run:`）は、凍結版では 1 回の `execute()`（パースが通った最短の先頭）、層 2 では
 * 1 文（engine の `executeStatements` が受ける `entries`）。どちらも同じ文字列（ソースの切り出し）で
 * 書くので、1 文ずつ実行される評価は同じ行になる。
 *
 * 比べる前に凍結版の観測から落とすもの（メタ行の通信路から来たもの）:
 * 1. `//#documentDirectory` の行だけを source とする `execute()`（中身は空の評価。落とす前に
 *    文が 0 であることを確かめる）
 * 2. 拡張が DSL として注入する `global.setDocumentDirectory("…")` の `execute()`（in-process では
 *    `executeStatements()` の `documentDirectory` が同じことをする）
 *
 * コーパスに入れないもの（凍結版と層 2 で意図して違い、ここの観測では比べられないもの）:
 * - 評価するコードの中の `//#…` の行（凍結版では帯域外の命令になる。層 2 ではコメント）
 * - 改行や前後の空白を含む `documentDirectory`（凍結版はメタ行に載せるために加工する）
 * - 人の経路（⌘Enter）の「未完の入力が次の評価へ持ち越される」振る舞い（層 2 は要求ごとに完結）
 * - `evalSource: 'agent'`（凍結版の REPL は常に `human` を渡す）
 * - `.orbslog` の記録の件数（要求 1 つ = 1 件。`tests/interpreter/execute-statements.spec.ts` が見る）
 *
 * 記録を直す時は `PRINT_EVAL_DIFFERENCES=<ファイル> npx vitest run tests/session/eval-intake-parity.spec.ts`
 * で、各件の今の観測（凍結版と層 2）が 1 行 1 件の JSON でそのファイルへ書かれる。差の理由は
 * 人が設計 997 §6 と照らして書く（出力をそのまま貼って通さない）。
 */
import fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'
import { AudioLine } from '../../packages/engine/src/core/sequence/audio-line'
import type { AudioIR, ParsedRequest } from '../../packages/engine/src/parser/audio-parser'
import { writeCodeToEngine } from '../../packages/vscode-extension/src/engine-process'
import {
  __setEngineProcessForTest,
  setGlobalInitialized,
} from '../../packages/vscode-extension/src/extension-state'
import {
  createEvaluationIntake,
  type EvaluationDiagnostic,
} from '../../packages/session/src/eval/evaluation-intake'

interface EvaluationInput {
  code: string
  documentDirectory: string | null
}

interface CorpusCase {
  name: string
  evaluations: EvaluationInput[]
  /** この source の `execute()` を失敗させる（実行時エラーの再現）。 */
  runtimeErrorFor?: (source: string) => string | undefined
  /** この source の `execute()` を遅らせる（FIFO の再現）。 */
  delayMsFor?: (source: string) => number
}

/** 観測した出来事を起きた順に並べたもの。stderr の `[ERROR]` の行も同じ列に置く。 */
type TraceEvent =
  | { type: 'batch-begin' }
  | { type: 'batch-end' }
  | { type: 'execute'; source: string; documentDirectory: string | undefined; evalSource: unknown }
  | { type: 'error-line'; text: string }

interface Observation {
  trace: TraceEvent[]
  outcomes: Array<{ ok: boolean; diagnostics: EvaluationDiagnostic[] }>
}

const WS = '/ws/piece'

/**
 * 差分テストのコーパス。設計 §4.5.1 の列挙: 複数行の文・未完・構文エラー・実行時エラー・
 * 空行 2 連・evalBegin / evalEnd の枠・#607 / #612 / #614 の回帰ケース・#997 の検証ケース。
 */
const CORPUS: CorpusCase[] = [
  {
    name: '1 行ずつ完結する文の列（基準あり）',
    evaluations: [
      {
        code: [
          'var global = init GLOBAL',
          'global.tempo(120)',
          'var drum = init global.seq',
          'drum.audio("kick.wav")',
          'drum.play(1, 0, 1, 0)',
          'LOOP(drum)',
        ].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '基準なし（null = 空のメタ行・前の基準のクリア）',
    evaluations: [
      { code: 'global.tempo(120)', documentDirectory: WS },
      { code: 'import { kick } from "./drums.orbs"', documentDirectory: null },
      { code: 'global.tempo(90)', documentDirectory: '/ws/other' },
    ],
  },
  {
    name: '複数行にまたがる文（入力の終端で未完 → 溜めて完結した時に 1 回だけ実行）',
    evaluations: [
      {
        code: ['drum.play(', '  1, 0,', '  1, 0', ')', 'global.start()'].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '空行 1 つは複数行の文を切らない',
    evaluations: [{ code: ['drum.play(1,', '', '0)'].join('\n'), documentDirectory: WS }],
  },
  {
    name: '空行 2 連は未完の文を強制実行して切る（行単位の区切りの事例）',
    evaluations: [{ code: ['drum.play(1,', '', '', '0)'].join('\n'), documentDirectory: WS }],
  },
  {
    name: '#607: 行の途中の構文エラーは即座に報告し、後続の行は実行される',
    evaluations: [
      {
        code: ['global.play(([1, 5, 9]@v+10, 0))', 'global.tempo(120)'].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '#612: 実行時エラーの文言に EOF が含まれても未完として保留しない',
    evaluations: [
      {
        code: ['drum.audio("takes/EOF.wav")', 'global.tempo(120)'].join('\n'),
        documentDirectory: WS,
      },
    ],
    runtimeErrorFor: (source) =>
      source.includes('EOF.wav')
        ? "ENOENT: no such file or directory, open '/ws/piece/takes/EOF.wav'"
        : undefined,
  },
  {
    name: '#614: 未完のまま終わった入力は要求の終わりで強制実行され、診断が返る（バッチの外）',
    evaluations: [
      { code: 'global.play((1, 2,', documentDirectory: WS },
      { code: 'global.tempo(120)', documentDirectory: WS },
    ],
  },
  {
    name: '#614: 診断は評価ごとに区切られる（前の評価の失敗を引きずらない）',
    evaluations: [
      { code: 'global.play(([1, 5, 9]@v+10, 0))', documentDirectory: WS },
      { code: 'global.tempo(120)', documentDirectory: WS },
    ],
  },
  {
    name: '実行時エラーの前の文は実行済み・後の文も実行される（1 行ずつ）',
    evaluations: [
      {
        code: ['global.tempo(120)', 'drum.play(1, 0)', 'global.start()'].join('\n'),
        documentDirectory: WS,
      },
    ],
    runtimeErrorFor: (source) =>
      source.startsWith('drum.play') ? 'Variable not found: drum' : undefined,
  },
  {
    name: '#476: 遅い文を挟んでも全行が 1 回ずつ順序どおり（複数の評価が同時に並ぶ）',
    evaluations: [
      { code: ['var global = init GLOBAL', 'global.start()'].join('\n'), documentDirectory: WS },
      { code: ['global.tempo(140)', 'global.beat(4 by 4)'].join('\n'), documentDirectory: WS },
    ],
    delayMsFor: (source) => (source.includes('global.start') ? 30 : 0),
  },
  {
    name: '末尾の改行・空の評価・コメントだけの評価',
    evaluations: [
      { code: 'global.tempo(120)\n', documentDirectory: WS },
      { code: '', documentDirectory: WS },
      { code: '// just a comment', documentDirectory: WS },
      { code: '\n\n\n', documentDirectory: WS },
    ],
  },
  {
    name: 'CRLF と CR の改行（readline と同じ規則で行に分ける）',
    evaluations: [
      { code: 'global.tempo(120)\r\ndrum.play(\r\n1, 0)\r\n', documentDirectory: WS },
      { code: 'global.tempo(100)\rglobal.start()\r', documentDirectory: WS },
    ],
  },
  {
    name: '1 行に 2 つの文',
    evaluations: [{ code: 'global.tempo(120) global.start()', documentDirectory: WS }],
  },
  {
    name: '前の評価の末尾の空行は次の評価の空行の数え上げに持ち越されない',
    evaluations: [
      { code: 'drum.play(1, 0)\n', documentDirectory: WS },
      { code: ['', 'drum.play(1,', '', '0)'].join('\n'), documentDirectory: WS },
    ],
  },

  // --- #997 の検証ケース（区切り方が関わる振る舞いの今の形を固定する。段階 2 で「違いの記録」へ）---
  {
    name: '#997 / #965: 読めない文は 0 文の評価として黙って通り ok になる',
    evaluations: [
      { code: 'this is not orbitscore (((', documentDirectory: WS },
      { code: 'kick play(1, 0)', documentDirectory: WS },
    ],
  },
  {
    name: '#997 / #620: MCP の経路では診断は評価ごとに回収される（前の評価の構文エラーが次に付かない）',
    evaluations: [
      { code: 'kick.play(1 0)', documentDirectory: WS },
      { code: 'global.tempo(120)', documentDirectory: WS },
    ],
  },
  {
    name: '#997 / #695: 1 回の選択の文は 1 行ずつ別の評価（execute）になる',
    evaluations: [
      {
        code: ['hh.play(1, 0, 0, 1)', 'kick.play(1, 0)', 'LOOP(hh, kick)'].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '#997 / #987: コメントだけの行も 0 文の評価になる（切り替えブロック）',
    evaluations: [
      {
        code: [
          '// 切り替えブロック（このブロックだけを流す）',
          'hh.play(1, 0, 0, 1, 0, 1, 0, 0)',
          'LOOP(hh)',
        ].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '#997 / #630 (i): 行ごとのパースでは「import は先頭」（IM.1）が選択の評価に効かない',
    evaluations: [
      {
        code: ['var global = init GLOBAL', 'import { kick } from "./drums.orbs"'].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '#997 / #630 (iii): 複数行の import はエラーの後に残りの断片が 0 文で黙って通る',
    evaluations: [
      {
        code: ['import {', '  kick,', '  snare', '} from "./drums.orbs"'].join('\n'),
        documentDirectory: WS,
      },
    ],
  },
  {
    name: '#997 / #631: alias はまだ無い構文で 0 文になる',
    evaluations: [{ code: 'alias fx as effect', documentDirectory: WS }],
  },
  {
    name: '#997: 複数行の文の中の空行 2 連は文を割り、残りの断片が 0 文で通る',
    evaluations: [
      { code: ['hh.play(', '  1, 0,', '', '', '  0, 1', ')'].join('\n'), documentDirectory: WS },
    ],
  },
]

/** readline と同じ規則（`\n` / `\r` / `\r\n`）でチャンクの列を行に分ける。 */
function toReplLines(chunks: string[]): string[] {
  const parts = chunks.join('').split(/\r\n|\r|\n/)
  // 末尾は改行で終わっているので最後の要素は空文字（行ではない）。
  expect(parts.pop()).toBe('')
  return parts
}

function irIsEmpty(ir: AudioIR): boolean {
  return (
    ir.statements.length === 0 &&
    ir.sequenceInits.length === 0 &&
    !ir.globalInit &&
    !(ir.fileImports?.length ?? 0)
  )
}

function injectedSetDocumentDirectory(dir: string): string {
  return `global.setDocumentDirectory("${dir.replace(/[\\"]/g, '\\$&')}")`
}

function spyOnBatches(trace: TraceEvent[]): void {
  vi.spyOn(AudioLine, 'beginBatchAll').mockImplementation(() => {
    trace.push({ type: 'batch-begin' })
  })
  vi.spyOn(AudioLine, 'endBatchAll').mockImplementation(() => {
    trace.push({ type: 'batch-end' })
  })
}

function makeExecute(corpus: CorpusCase, trace: TraceEvent[], irs: Map<number, AudioIR>) {
  return async (
    ir: AudioIR,
    options: { source?: string; documentDirectory?: string; evalSource?: unknown },
  ): Promise<void> => {
    const source = options.source ?? ''
    irs.set(trace.length, ir)
    trace.push({
      type: 'execute',
      source,
      documentDirectory: options.documentDirectory,
      evalSource: options.evalSource,
    })
    const delay = corpus.delayMsFor?.(source) ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const message = corpus.runtimeErrorFor?.(source)
    if (message) throw new Error(message)
  }
}

/** 凍結版: 拡張の `writeCodeToEngine` + `//#evalMark` → `createReplSession`。 */
async function observeFrozen(corpus: CorpusCase): Promise<Observation> {
  const trace: TraceEvent[] = []
  const irs = new Map<number, AudioIR>()
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message))
  })
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    const text = String(message)
    if (text.startsWith('[ERROR]')) trace.push({ type: 'error-line', text })
  })
  spyOnBatches(trace)

  const chunks: string[] = []
  __setEngineProcessForTest({
    killed: false,
    stdin: {
      writable: true,
      write: (chunk: string) => {
        chunks.push(chunk)
        return true
      },
    },
  } as never)
  setGlobalInitialized(false)

  const session = createReplSession({ execute: makeExecute(corpus, trace, irs) } as never)
  const injected = new Set<string>()
  corpus.evaluations.forEach((evaluation, index) => {
    expect(writeCodeToEngine(evaluation.code, evaluation.documentDirectory)).toBe(true)
    // agent-handlers.ts の evaluateForAgent が続けて送る行（correlated-line-bridge.ts の形）。
    chunks.push(`//#evalMark ${JSON.stringify({ requestId: `r${index}` })}\n`)
    if (evaluation.documentDirectory) {
      injected.add(injectedSetDocumentDirectory(evaluation.documentDirectory))
    }
  })
  for (const line of toReplLines(chunks)) session.pushLine(line)
  await session.idle()

  const normalized = trace.filter((event, index) => {
    if (event.type !== 'execute') return true
    if (/^\s*\/\/#documentDirectory\b[^\n]*$/.test(event.source)) {
      expect(irIsEmpty(irs.get(index)!), `meta-only execute must be empty: ${event.source}`).toBe(
        true,
      )
      return false
    }
    return !injected.has(event.source)
  })
  const outcomes = logs
    .filter((line) => line.trim().startsWith('{"evalMark"'))
    .map((line) => {
      const mark = (JSON.parse(line) as { evalMark: Record<string, unknown> }).evalMark
      return {
        ok: mark.ok as boolean,
        diagnostics: mark.diagnostics as EvaluationDiagnostic[],
      }
    })
  return { trace: normalized, outcomes }
}

/** 層 2 の偽の `executeStatements`: 文ごとに `execute` の出来事を積む（文の文字列 = `source`）。 */
function makeExecuteStatements(corpus: CorpusCase, trace: TraceEvent[]) {
  return async (
    request: ParsedRequest,
    options: { documentDirectory?: string; evalSource?: unknown },
    _context: unknown,
    hooks: { onFailure(index: number, message: string): void },
  ): Promise<Array<{ index: number; message: string }>> => {
    const failures: Array<{ index: number; message: string }> = []
    for (const [index, entry] of request.entries.entries()) {
      trace.push({
        type: 'execute',
        source: entry.text,
        documentDirectory: options.documentDirectory,
        evalSource: options.evalSource,
      })
      const delay = corpus.delayMsFor?.(entry.text) ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const message = corpus.runtimeErrorFor?.(entry.text)
      if (message) {
        failures.push({ index, message })
        hooks.onFailure(index, message)
      }
    }
    return failures
  }
}

/** 層 2: `createEvaluationIntake` に同じ評価を同時に並べる。 */
async function observeIntake(corpus: CorpusCase): Promise<Observation> {
  const trace: TraceEvent[] = []
  spyOnBatches(trace)
  const intake = createEvaluationIntake({
    execute: makeExecuteStatements(corpus, trace),
    log: (line) => {
      if (line.kind === 'diagnostic') trace.push({ type: 'error-line', text: line.text })
    },
  })
  const pending = corpus.evaluations.map((evaluation) =>
    intake.evaluate({ ...evaluation, source: 'human' }),
  )
  const results = await Promise.all(pending)
  await intake.idle()
  // 1.1 の `range` は凍結版に無い欄なので、比べる前に落とす（位置は evaluation-intake.spec が見る）。
  return {
    trace,
    outcomes: results.map(({ ok, diagnostics }) => ({
      ok,
      diagnostics: diagnostics.map(({ kind, message }) => ({ kind, message })),
    })),
  }
}

/**
 * 観測を読める形の行の列にする（違いの記録の期待値はこの形で書く）。`run:` は実行された単位
 * （凍結版は 1 回の `execute()`、層 2 は 1 文）で、改行は `⏎` に、`\r` は落とす。
 */
function summarize(observation: Observation): string[] {
  const lines = observation.trace.map((event) => {
    if (event.type === 'batch-begin') return 'begin'
    if (event.type === 'batch-end') return 'end'
    if (event.type === 'error-line') return `error: ${event.text}`
    const text = event.source.replace(/\r\n?/g, '\n').replace(/\n/g, '⏎')
    return `run(${event.documentDirectory}): ${text}`
  })
  observation.outcomes.forEach((outcome, index) => {
    lines.push(
      outcome.ok
        ? `outcome ${index}: ok`
        : `outcome ${index}: ${outcome.diagnostics.map((d) => `${d.kind}: ${d.message}`).join(' | ')}`,
    )
  })
  return lines
}

beforeEach(() => {
  setGlobalInitialized(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  __setEngineProcessForTest(null)
  setGlobalInitialized(false)
})

/**
 * 凍結版との差の一覧（段階 2 の期待値）。観測は 2026-10-26 の実測（`summarize` の出力）をそのまま
 * 書いた。🔴 **増やす時は、設計 997 §6 に検証ケースの行があること**（無い差は意図しない変化）。
 */
const DIFFERENCES: Record<string, { reason: string; frozen: string[]; layer2: string[] }> = {
  '空行 2 連は未完の文を強制実行して切る（行単位の区切りの事例）': {
    reason: 'V-14 / D-U2: 空行は文を切らない（1 度に読む）',
    frozen: [
      'begin',
      'error: [ERROR] Expected RPAREN but got EOF at line 1, column 13',
      'error: [ERROR] Cannot read a statement that starts with NUMBER "0" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
      'end',
      'outcome 0: parse: Expected RPAREN but got EOF at line 1, column 13 | parse: Cannot read a statement that starts with NUMBER "0" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
    ],
    layer2: ['begin', 'run(/ws/piece): drum.play(1,⏎⏎⏎0)', 'end', 'outcome 0: ok'],
  },
  '#607: 行の途中の構文エラーは即座に報告し、後続の行は実行される': {
    reason: 'V-21 / D-E1（Q-1 = A）: 構文エラーがあれば、その評価のどの文も実行しない',
    frozen: [
      'begin',
      'error: [ERROR] Expected RPAREN but got AT at line 1, column 23',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected RPAREN but got AT at line 1, column 23',
    ],
    layer2: [
      'error: [ERROR] Expected RPAREN but got AT at line 1, column 23',
      'outcome 0: parse: Expected RPAREN but got AT at line 1, column 23',
    ],
  },
  '#614: 未完のまま終わった入力は要求の終わりで強制実行され、診断が返る（バッチの外）': {
    reason: 'V-24 / D-E1: 閉じていない文は構文エラー。構文エラーの評価はバッチを開かない',
    frozen: [
      'begin',
      'end',
      'error: [ERROR] Expected RPAREN but got EOF at line 1, column 19',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected RPAREN but got EOF at line 1, column 19',
      'outcome 1: ok',
    ],
    layer2: [
      'error: [ERROR] Expected RPAREN but got EOF at line 1, column 19',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected RPAREN but got EOF at line 1, column 19',
      'outcome 1: ok',
    ],
  },
  '#614: 診断は評価ごとに区切られる（前の評価の失敗を引きずらない）': {
    reason: 'V-24 / D-E1: 構文エラーの評価はバッチを開かない（診断が評価ごとなのは同じ）',
    frozen: [
      'begin',
      'error: [ERROR] Expected RPAREN but got AT at line 1, column 23',
      'end',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected RPAREN but got AT at line 1, column 23',
      'outcome 1: ok',
    ],
    layer2: [
      'error: [ERROR] Expected RPAREN but got AT at line 1, column 23',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected RPAREN but got AT at line 1, column 23',
      'outcome 1: ok',
    ],
  },
  '末尾の改行・空の評価・コメントだけの評価': {
    reason:
      'V-22 / D-U2: 文が 1 つも無い評価は何も実行せず、バッチも開かない（コメントは文ではない）',
    frozen: [
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'begin',
      'end',
      'begin',
      'run(/ws/piece): // just a comment',
      'end',
      'begin',
      'end',
      'outcome 0: ok',
      'outcome 1: ok',
      'outcome 2: ok',
      'outcome 3: ok',
    ],
    layer2: [
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: ok',
      'outcome 1: ok',
      'outcome 2: ok',
      'outcome 3: ok',
    ],
  },
  '1 行に 2 つの文': {
    reason: 'V-23 / D-U2: 実行の単位は文（同じ行の 2 文は 2 つ。実行される中身と順は同じ）',
    frozen: ['begin', 'run(/ws/piece): global.tempo(120) global.start()', 'end', 'outcome 0: ok'],
    layer2: [
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'run(/ws/piece): global.start()',
      'end',
      'outcome 0: ok',
    ],
  },
  '#997 / #965: 読めない文は 0 文の評価として黙って通り ok になる': {
    reason:
      'V-1 / V-2 / V-24: 読めない文は位置つきの構文エラー（E-7。パーサは凍結版と共有なので文言は同じ）。差は構文エラーの評価がバッチを開かないことだけ',
    frozen: [
      'begin',
      'error: [ERROR] Expected "." after this but got IDENTIFIER at line 1, column 6',
      'end',
      'begin',
      'error: [ERROR] Expected "." after kick but got IDENTIFIER at line 1, column 6',
      'end',
      'outcome 0: parse: Expected "." after this but got IDENTIFIER at line 1, column 6',
      'outcome 1: parse: Expected "." after kick but got IDENTIFIER at line 1, column 6',
    ],
    layer2: [
      'error: [ERROR] Expected "." after this but got IDENTIFIER at line 1, column 6',
      'error: [ERROR] Expected "." after kick but got IDENTIFIER at line 1, column 6',
      'outcome 0: parse: Expected "." after this but got IDENTIFIER at line 1, column 6',
      'outcome 1: parse: Expected "." after kick but got IDENTIFIER at line 1, column 6',
    ],
  },
  '#997 / #620: MCP の経路では診断は評価ごとに回収される（前の評価の構文エラーが次に付かない）': {
    reason: 'V-5 / V-24: 診断が評価ごとなのは同じ。差は構文エラーの評価がバッチを開かないことだけ',
    frozen: [
      'begin',
      'error: [ERROR] Expected comma or closing parenthesis but got NUMBER at line 1, column 13',
      'end',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected comma or closing parenthesis but got NUMBER at line 1, column 13',
      'outcome 1: ok',
    ],
    layer2: [
      'error: [ERROR] Expected comma or closing parenthesis but got NUMBER at line 1, column 13',
      'begin',
      'run(/ws/piece): global.tempo(120)',
      'end',
      'outcome 0: parse: Expected comma or closing parenthesis but got NUMBER at line 1, column 13',
      'outcome 1: ok',
    ],
  },
  '#997 / #987: コメントだけの行も 0 文の評価になる（切り替えブロック）': {
    reason: 'V-22 / D-U2: コメントは文ではないので実行の単位にならない',
    frozen: [
      'begin',
      'run(/ws/piece): // 切り替えブロック（このブロックだけを流す）',
      'run(/ws/piece): hh.play(1, 0, 0, 1, 0, 1, 0, 0)',
      'run(/ws/piece): LOOP(hh)',
      'end',
      'outcome 0: ok',
    ],
    layer2: [
      'begin',
      'run(/ws/piece): hh.play(1, 0, 0, 1, 0, 1, 0, 0)',
      'run(/ws/piece): LOOP(hh)',
      'end',
      'outcome 0: ok',
    ],
  },
  '#997 / #630 (i): 行ごとのパースでは「import は先頭」（IM.1）が選択の評価に効かない': {
    reason: 'V-10 / D-I1: IM.1 は評価ごとに効く（ファイル全体を play した時と同じエラー）',
    frozen: [
      'begin',
      'run(/ws/piece): var global = init GLOBAL',
      'run(/ws/piece): import { kick } from "./drums.orbs"',
      'end',
      'outcome 0: ok',
    ],
    layer2: [
      'error: [ERROR] import "./drums.orbs": import statements must appear before any other statement (IM.1).',
      'outcome 0: parse: import "./drums.orbs": import statements must appear before any other statement (IM.1).',
    ],
  },
  '#997 / #630 (iii): 複数行の import はエラーの後に残りの断片が 0 文で黙って通る': {
    reason:
      'V-11 / D-E1: 構文エラーなら断片を通さない（複数行の import を受けるかは Q-6 = B で今は受けない）',
    frozen: [
      'begin',
      'error: [ERROR] Expected IDENTIFIER but got NEWLINE at line 1, column 9',
      'error: [ERROR] Expected "." after snare but got the end of the input at line 1, column 6',
      'error: [ERROR] Cannot read a statement that starts with RBRACE "}" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
      'end',
      'outcome 0: parse: Expected IDENTIFIER but got NEWLINE at line 1, column 9 | parse: Expected "." after snare but got the end of the input at line 1, column 6 | parse: Cannot read a statement that starts with RBRACE "}" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
    ],
    layer2: [
      'error: [ERROR] Expected IDENTIFIER but got NEWLINE at line 1, column 9',
      'outcome 0: parse: Expected IDENTIFIER but got NEWLINE at line 1, column 9',
    ],
  },
  '#997 / #631: alias はまだ無い構文で 0 文になる': {
    reason: 'V-12 / V-24: 読めない文は構文エラー（E-7・文言は凍結版と同じ）。差はバッチだけ',
    frozen: [
      'begin',
      'error: [ERROR] Expected "." after alias but got IDENTIFIER at line 1, column 7',
      'end',
      'outcome 0: parse: Expected "." after alias but got IDENTIFIER at line 1, column 7',
    ],
    layer2: [
      'error: [ERROR] Expected "." after alias but got IDENTIFIER at line 1, column 7',
      'outcome 0: parse: Expected "." after alias but got IDENTIFIER at line 1, column 7',
    ],
  },
  '#997: 複数行の文の中の空行 2 連は文を割り、残りの断片が 0 文で通る': {
    reason: 'V-14 / D-U2: 空行は文を切らない',
    frozen: [
      'begin',
      'error: [ERROR] Expected RPAREN but got EOF at line 2, column 8',
      'error: [ERROR] Cannot read a statement that starts with NUMBER "0" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
      'error: [ERROR] Cannot read a statement that starts with RPAREN ")" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
      'end',
      'outcome 0: parse: Expected RPAREN but got EOF at line 2, column 8 | parse: Cannot read a statement that starts with NUMBER "0" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…)) | parse: Cannot read a statement that starts with RPAREN ")" at line 1, column 1 (a statement starts with var, import, RUN, LOOP, MUTE, or <name>.<method>(…))',
    ],
    layer2: ['begin', 'run(/ws/piece): hh.play(⏎  1, 0,⏎⏎⏎  0, 1⏎)', 'end', 'outcome 0: ok'],
  },
}

describe('evaluation intake vs the frozen REPL (stage 2 = the record of differences · ledger P-02)', () => {
  for (const corpus of CORPUS) {
    it(corpus.name, async () => {
      const frozen = await observeFrozen(corpus)
      vi.restoreAllMocks()
      const intake = await observeIntake(corpus)

      // 観測そのものが空でないこと（何も見ていない比較を通さない）。
      expect(frozen.outcomes).toHaveLength(corpus.evaluations.length)
      expect(frozen.trace.some((event) => event.type === 'batch-begin')).toBe(true)

      const printTo = process.env.PRINT_EVAL_DIFFERENCES
      if (printTo) {
        fs.appendFileSync(
          printTo,
          `${JSON.stringify({ name: corpus.name, frozen: summarize(frozen), layer2: summarize(intake) })}\n`,
        )
      }
      const expected = DIFFERENCES[corpus.name]
      if (!expected) {
        expect(summarize(intake)).toEqual(summarize(frozen))
        return
      }
      expect(expected.reason).toMatch(/^V-\d+/)
      expect(summarize(frozen), 'the frozen side changed — update the record').toEqual(
        expected.frozen,
      )
      expect(summarize(intake)).toEqual(expected.layer2)
      expect(expected.layer2).not.toEqual(expected.frozen)
    })
  }

  it('every recorded difference names a corpus case (no stale entries)', () => {
    const names = new Set(CORPUS.map((corpus) => corpus.name))
    expect(Object.keys(DIFFERENCES).filter((name) => !names.has(name))).toEqual([])
  })

  it('the normalization drops only meta-line artifacts (both kinds are observed)', async () => {
    // 落とす規則が空振りしていないこと: 基準ありの評価は注入を、どの評価もメタ行の空の
    // 評価を、凍結版の生の観測に必ず含む。
    const corpus: CorpusCase = {
      name: 'probe',
      evaluations: [
        { code: 'var global = init GLOBAL', documentDirectory: WS },
        { code: 'global.tempo(120)', documentDirectory: WS },
      ],
    }
    const raw: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunks: string[] = []
    __setEngineProcessForTest({
      killed: false,
      stdin: { writable: true, write: (chunk: string) => chunks.push(chunk) > 0 },
    } as never)
    const session = createReplSession({
      execute: async (_ir: unknown, options: { source?: string }) => {
        raw.push(options.source ?? '')
      },
    } as never)
    for (const evaluation of corpus.evaluations) {
      writeCodeToEngine(evaluation.code, evaluation.documentDirectory)
    }
    for (const line of toReplLines(chunks)) session.pushLine(line)
    await session.idle()

    expect(raw.filter((source) => source.startsWith('//#documentDirectory'))).toHaveLength(2)
    expect(raw.filter((source) => source === injectedSetDocumentDirectory(WS))).toHaveLength(2)
  })
})
