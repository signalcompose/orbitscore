/**
 * 評価の受付口の差分テスト — 段階 1 は「一致」（設計 848 §4.5.1・台帳 P-02）。
 *
 * PROVISIONAL(P-02): 凍結版と層 2 の受付口に同じ評価の列を流し、
 * `InterpreterV2.execute` への呼び出し（`source` / `documentDirectory` / `evalSource`）・
 * `AudioLine` のバッチの開閉・stderr に出る `[ERROR]` の行を**起きた順の 1 本の列**で比べ、
 * あわせて各評価の診断（凍結版の `//#evalMark` の応答 = 層 2 の応答）を比べる。
 * 段階 2（束 S-eval・#997）で期待値を「凍結版との差の一覧」に書き換え、拡張版の退役で消す。
 *
 * 🔴 凍結版の側は**本物の経路**で作る: 拡張の `writeCodeToEngine`（`engine-process.ts`）が
 * 書く行の列と、`evaluateForAgent` が続けて送る `//#evalMark` の行を、本物の
 * `readline.createInterface` + `PassThrough` で行に分けて凍結版の `createReplSession` に流す。
 * 凍結版の枠の付け方が bug fix で変われば、
 * この検査が red になる（その時は同じ PR で `packages/session/src/eval/` の写しを直す）。
 *
 * 比べる前に凍結版の観測から落とすもの（メタ行の通信路から来たもの・写しの冒頭の注釈と同じ）:
 * 1. 拡張が DSL として注入する `global.setDocumentDirectory("…")` の `execute()`（in-process では
 *    `execute()` の `documentDirectory` が同じことをする）
 *
 * コーパスに入れないもの（凍結版と層 2 で意図して違う。理由は写しの冒頭の注釈）:
 * - 評価するコードの中の `//#…` の行（凍結版では帯域外の命令になる）
 * - 改行や前後の空白を含む `documentDirectory`（凍結版はメタ行に載せるために加工する）
 * - 人の経路（⌘Enter）の「未完の入力が次の評価へ持ち越される」振る舞い（層 2 は要求の終わりで
 *   強制実行する・設計 §5.3.1）。凍結版の側は MCP の経路（`//#evalMark` つき）で作る
 * - `evalSource: 'agent'`（凍結版の REPL は常に `human` を渡す。層 2 は要求の `source` を渡す ——
 *   doc 694 G4 の意図を `evaluation-intake.spec.ts` が別に確かめる）
 * - 差分テストが駆動するのは MCP の経路だけ。#620 の人の経路の診断漏れと、2 回に分けた
 *   選択実行で未完の入力を持ち越す振る舞いは段階 1 の観測外
 *
 * 出荷物の観測（要件ではなく、VS Code の更新で変わりうる）: 2026-10-26、VS Code 1.143.1 /
 * Electron 43.7.7 / Node v24.21.0。Node 24 で readline に U+2028 / U+2029 が加わったため、
 * そのコーパスだけはテストを走らせる Node の major が 24 以上の時に駆動する。
 */
import { PassThrough } from 'node:stream'
import readline from 'node:readline'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createReplSession } from '../../packages/engine/src/cli/repl-mode'
import { AudioLine } from '../../packages/engine/src/core/sequence/audio-line'
import type { AudioIR } from '../../packages/engine/src/parser/audio-parser'
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
  /** Node 24 で readline に加わった区切り規則を使うケース。 */
  node24Only?: boolean
  /** 同じ parser を両側が呼んでも固定できない、今日の明示的な期待。 */
  expected?: {
    outcomes: Array<{ ok: boolean; diagnostics: EvaluationDiagnostic[] }>
    codeExecuteSources: string[]
    codeIrEmpty: boolean[]
  }
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
  executeIrs: AudioIR[]
}

const WS = '/ws/piece'
const NODE_MAJOR = Number(process.versions.node.split('.')[0])

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
    name: '要求頭の基準設定は、正常 → 構文エラーだけ → null の空評価でも毎回実行される',
    evaluations: [
      { code: 'var global = init GLOBAL', documentDirectory: '/ws/a' },
      { code: 'global.play((@', documentDirectory: '/ws/b' },
      { code: '', documentDirectory: null },
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
    name: '空白だけの行も空行として数え、複数行の文を切らない',
    evaluations: [{ code: ['drum.play(1,', '  ', '\t', '0)'].join('\n'), documentDirectory: WS }],
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
    name: 'Node 24 readline: U+2028 / U+2029 も行を分け、コメント後の文を実行する',
    evaluations: [
      { code: '// note\u2028global.tempo(120)', documentDirectory: WS },
      { code: '// note\u2029global.tempo(90)', documentDirectory: WS },
    ],
    node24Only: true,
  },
  {
    name: '1 行に 2 つの文',
    evaluations: [{ code: 'global.tempo(120) global.start()', documentDirectory: WS }],
  },
  {
    name: '末尾の改行がある評価の次でも、先頭の空行を含む複数行の文を同じ列で実行する',
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
    expected: {
      outcomes: [
        { ok: true, diagnostics: [] },
        { ok: true, diagnostics: [] },
      ],
      codeExecuteSources: ['this is not orbitscore (((', 'kick play(1, 0)'],
      codeIrEmpty: [true, true],
    },
  },
  {
    name: '#997 / #620: MCP の経路では診断は評価ごとに回収される（前の評価の構文エラーが次に付かない）',
    evaluations: [
      { code: 'kick.play(1 0)', documentDirectory: WS },
      { code: 'global.tempo(120)', documentDirectory: WS },
    ],
    expected: {
      outcomes: [
        {
          ok: false,
          diagnostics: [
            {
              kind: 'parse',
              message: 'Expected comma or closing parenthesis but got NUMBER at line 1, column 13',
            },
          ],
        },
        { ok: true, diagnostics: [] },
      ],
      codeExecuteSources: ['global.tempo(120)'],
      codeIrEmpty: [false],
    },
  },
  {
    name: '#997 / #695: 1 回の選択の文は 1 行ずつ別の評価（execute）になる',
    evaluations: [
      {
        code: ['hh.play(1, 0, 0, 1)', 'kick.play(1, 0)', 'LOOP(hh, kick)'].join('\n'),
        documentDirectory: WS,
      },
    ],
    expected: {
      outcomes: [{ ok: true, diagnostics: [] }],
      codeExecuteSources: ['hh.play(1, 0, 0, 1)', 'kick.play(1, 0)', 'LOOP(hh, kick)'],
      codeIrEmpty: [false, false, false],
    },
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
    expected: {
      outcomes: [{ ok: true, diagnostics: [] }],
      codeExecuteSources: [
        '// 切り替えブロック（このブロックだけを流す）',
        'hh.play(1, 0, 0, 1, 0, 1, 0, 0)',
        'LOOP(hh)',
      ],
      codeIrEmpty: [true, false, false],
    },
  },
  {
    name: '#997 / #630 (i): 行ごとのパースでは「import は先頭」（IM.1）が選択の評価に効かない',
    evaluations: [
      {
        code: ['var global = init GLOBAL', 'import { kick } from "./drums.orbs"'].join('\n'),
        documentDirectory: WS,
      },
    ],
    expected: {
      outcomes: [{ ok: true, diagnostics: [] }],
      codeExecuteSources: ['var global = init GLOBAL', 'import { kick } from "./drums.orbs"'],
      codeIrEmpty: [false, false],
    },
  },
  {
    name: '#997 / #630 (iii): 複数行の import はエラーの後に残りの断片が 0 文で黙って通る',
    evaluations: [
      {
        code: ['import {', '  kick,', '  snare', '} from "./drums.orbs"'].join('\n'),
        documentDirectory: WS,
      },
    ],
    expected: {
      outcomes: [
        {
          ok: false,
          diagnostics: [
            {
              kind: 'parse',
              message: 'Expected IDENTIFIER but got NEWLINE at line 1, column 9',
            },
          ],
        },
      ],
      codeExecuteSources: ['snare', '} from "./drums.orbs"'],
      codeIrEmpty: [true, true],
    },
  },
  {
    name: '#997 / #631: alias はまだ無い構文で 0 文になる',
    evaluations: [{ code: 'alias fx as effect', documentDirectory: WS }],
    expected: {
      outcomes: [{ ok: true, diagnostics: [] }],
      codeExecuteSources: ['alias fx as effect'],
      codeIrEmpty: [true],
    },
  },
  {
    name: '#997: 複数行の文の中の空行 2 連は文を割り、残りの断片が 0 文で通る',
    evaluations: [
      { code: ['hh.play(', '  1, 0,', '', '', '  0, 1', ')'].join('\n'), documentDirectory: WS },
    ],
    expected: {
      outcomes: [
        {
          ok: false,
          diagnostics: [
            { kind: 'parse', message: 'Expected RPAREN but got EOF at line 2, column 8' },
          ],
        },
      ],
      codeExecuteSources: ['0, 1', ')'],
      codeIrEmpty: [true, true],
    },
  },
]

/** 凍結版の engine と同じ `readline.Interface` に、拡張が書いたチャンクをそのまま通す。 */
async function toReplLines(chunks: string[]): Promise<string[]> {
  const input = new PassThrough()
  const lines: string[] = []
  const rl = readline.createInterface({ input, terminal: false })
  const closed = new Promise<void>((resolve) => rl.once('close', resolve))
  rl.on('line', (line) => lines.push(line))
  for (const chunk of chunks) input.write(chunk)
  input.end()
  await closed
  return lines
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
  for (const line of await toReplLines(chunks)) session.pushLine(line)
  await session.idle()

  const normalized = trace.filter((event, index) => {
    if (event.type !== 'execute') return true
    if (/^\s*\/\/#documentDirectory\b[^\n]*$/.test(event.source)) {
      expect(irIsEmpty(irs.get(index)!), `meta-only execute must be empty: ${event.source}`).toBe(
        true,
      )
    }
    return !injected.has(event.source)
  })
  const executeIrs = normalized
    .map((event) => {
      const index = trace.indexOf(event)
      return event.type === 'execute' ? irs.get(index) : undefined
    })
    .filter((ir): ir is AudioIR => ir !== undefined)
  const outcomes = logs
    .filter((line) => line.trim().startsWith('{"evalMark"'))
    .map((line) => {
      const mark = (JSON.parse(line) as { evalMark: Record<string, unknown> }).evalMark
      return {
        ok: mark.ok as boolean,
        diagnostics: mark.diagnostics as EvaluationDiagnostic[],
      }
    })
  return { trace: normalized, outcomes, executeIrs }
}

/** 層 2: `createEvaluationIntake` に同じ評価を同時に並べる。 */
async function observeIntake(corpus: CorpusCase): Promise<Observation> {
  const trace: TraceEvent[] = []
  const irs = new Map<number, AudioIR>()
  spyOnBatches(trace)
  const intake = createEvaluationIntake({
    execute: makeExecute(corpus, trace, irs),
    log: (line) => {
      if (line.kind === 'diagnostic') trace.push({ type: 'error-line', text: line.text })
    },
  })
  const pending = corpus.evaluations.map((evaluation) =>
    intake.evaluate({ ...evaluation, source: 'human' }),
  )
  const results = await Promise.all(pending)
  await intake.idle()
  const executeIrs = trace
    .map((event, index) => (event.type === 'execute' ? irs.get(index) : undefined))
    .filter((ir): ir is AudioIR => ir !== undefined)
  return {
    trace,
    outcomes: results.map(({ ok, diagnostics }) => ({ ok, diagnostics })),
    executeIrs,
  }
}

beforeEach(() => {
  setGlobalInitialized(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  __setEngineProcessForTest(null)
  setGlobalInitialized(false)
})

describe('evaluation intake parity with the frozen REPL (stage 1 = identical · ledger P-02)', () => {
  for (const corpus of CORPUS) {
    // U+2028 / U+2029 は Node 24 の readline で初めて区切りになった。Node 22 の CI では、
    // 出荷物ではない古い readline と足場を比べない（固定規則は unit が Node の版によらず見る）。
    it.skipIf(corpus.node24Only === true && NODE_MAJOR < 24)(corpus.name, async () => {
      const frozen = await observeFrozen(corpus)
      vi.restoreAllMocks()
      const intake = await observeIntake(corpus)

      // 観測そのものが空でないこと（何も見ていない比較を通さない）。
      expect(frozen.outcomes).toHaveLength(corpus.evaluations.length)
      expect(frozen.trace.some((event) => event.type === 'batch-begin')).toBe(true)

      expect(intake.trace).toEqual(frozen.trace)
      expect(intake.outcomes).toEqual(frozen.outcomes)
      expect(intake.executeIrs).toHaveLength(frozen.executeIrs.length)
      intake.executeIrs.forEach((ir, index) => expect(ir).toEqual(frozen.executeIrs[index]))

      if (corpus.expected) {
        expect(intake.outcomes).toEqual(corpus.expected.outcomes)
        let irIndex = 0
        const codeExecutions = intake.trace.flatMap((event) => {
          if (event.type !== 'execute') return []
          const ir = intake.executeIrs[irIndex++]!
          return event.source.startsWith('//#documentDirectory')
            ? []
            : [{ source: event.source, ir }]
        })
        expect(codeExecutions.map(({ source }) => source)).toEqual(
          corpus.expected.codeExecuteSources,
        )
        expect(codeExecutions.map(({ ir }) => irIsEmpty(ir))).toEqual(corpus.expected.codeIrEmpty)
      }
    })
  }

  it('the normalization drops only the injected DSL command and keeps meta-line executes', async () => {
    // 落とす規則が空振りしていないこと: 基準ありの評価は注入とメタ行の空の評価を、
    // 凍結版の生の観測に必ず含む。差分観測には後者を残す。
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
    for (const line of await toReplLines(chunks)) session.pushLine(line)
    await session.idle()

    expect(raw.filter((source) => source.startsWith('//#documentDirectory'))).toHaveLength(2)
    expect(raw.filter((source) => source === injectedSetDocumentDirectory(WS))).toHaveLength(2)

    vi.restoreAllMocks()
    const frozen = await observeFrozen(corpus)
    expect(
      frozen.trace.filter(
        (event) => event.type === 'execute' && event.source.startsWith('//#documentDirectory'),
      ),
    ).toHaveLength(2)
    expect(
      frozen.trace.filter(
        (event) => event.type === 'execute' && event.source === injectedSetDocumentDirectory(WS),
      ),
    ).toHaveLength(0)
  })

  it('passes an absolute documentDirectory through the intake without trimming it', async () => {
    const observation = await observeIntake({
      name: 'documentDirectory passthrough',
      evaluations: [{ code: '', documentDirectory: '/ws/ piece ' }],
    })
    expect(observation.trace).toContainEqual({
      type: 'execute',
      source: '//#documentDirectory /ws/ piece ',
      documentDirectory: '/ws/ piece ',
      evalSource: 'human',
    })
  })
})
