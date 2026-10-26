/**
 * 鳴っている `play()` の出どころ（設計 997 §4.4 D-P1 / D-P2・V-7・#987・束 S-eval #1022 の N1-d4）。
 *
 * engine は `play()` のたびに世代を振って `pattern` を出し、鳴った step にスケジュールした時点の世代を
 * 付ける（engine の側は `tests/audio/host-output.spec.ts` ほか）。ここでは偽の interpreter が `play()` の
 * 文を実行する時に `core.onEnginePattern` を呼ぶ（engine の口 → 層 2 の受け手の配線は
 * `session-core.spec.ts` の「層 2 が口に付く」が見ている）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  contiguousCodeLines,
  resolveSelectionBlock,
} from '../../packages/session/src/host/selection-block'
import { StepSources, toDocumentRange } from '../../packages/session/src/host/step-sources'

import { flush, startEditorSession, type EditorSession } from './helpers/editor-session'
import type { RpcTestClient } from './helpers/rpc-test-client'

const pos = (line: number, character: number) => ({ line, character })
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: pos(sl, sc),
  end: pos(el, ec),
})

describe('StepSources remembers which statement set each generation', () => {
  it('answers per sequence and generation, and null for what it never saw', () => {
    const sources = new StepSources()
    const a = { evalId: 'e1', start: pos(0, 0), end: pos(0, 10) }
    const b = { evalId: 'e2', start: pos(1, 0), end: pos(1, 12) }
    sources.remember('kick', 1, a)
    sources.remember('kick', 2, b)
    expect(sources.sourceOf('kick', 1)).toEqual(a)
    expect(sources.sourceOf('kick', 2)).toEqual(b)
    expect(sources.sourceOf('hat', 1)).toBeNull()
    expect(sources.sourceOf('kick', 3)).toBeNull()
    expect(sources.sourceOf('kick', undefined)).toBeNull()
  })

  it('keeps the last 8 generations of a sequence (steps already scheduled still sound)', () => {
    const sources = new StepSources()
    for (let generation = 1; generation <= 9; generation++) {
      sources.remember('kick', generation, {
        evalId: `e${generation}`,
        start: pos(0, 0),
        end: pos(0, 1),
      })
    }
    expect(sources.sourceOf('kick', 1)).toBeNull()
    expect(sources.sourceOf('kick', 2)?.evalId).toBe('e2')
    expect(sources.sourceOf('kick', 9)?.evalId).toBe('e9')
  })
})

describe('code → document positions (design 997 D-P2)', () => {
  const TEXT = [
    '  var kick = init global.seq', // 0（頭に空白）
    'var hat = init global.seq', // 1
    'kick.audio("k.wav")', // 2
    'hat.play(1)', // 3
    'kick.play(1, 0,', // 4
    '  1, 0)', // 5
  ].join('\n')

  it('a subject block joins lines that are apart in the document; each code line keeps its document line', () => {
    const block = resolveSelectionBlock(TEXT, range(2, 3, 2, 3))
    expect(block.code).toBe(
      ['var kick = init global.seq', 'kick.audio("k.wav")', 'kick.play(1, 0,', '  1, 0)'].join(
        '\n',
      ),
    )
    expect(block.lines).toEqual([pos(0, 2), pos(2, 0), pos(4, 0), pos(5, 0)])
    const map = { uri: 'file:///a.orbs', version: 7, lines: block.lines }
    // `kick.play(1, 0,\n  1, 0)` は code の 2〜3 行目、文書の 4〜5 行目。
    expect(toDocumentRange(map, range(2, 0, 3, 7))).toEqual({
      uri: 'file:///a.orbs',
      version: 7,
      range: range(4, 0, 5, 7),
    })
    // code の 1 行目の位置には、trim で落とした頭の空白の分が足される。
    expect(toDocumentRange(map, range(0, 4, 0, 8))?.range).toEqual(range(0, 6, 0, 10))
    expect(toDocumentRange(map, range(9, 0, 9, 1))).toBeUndefined()
  })

  it('a selection that starts on a blank line maps from the first character it keeps', () => {
    const text = 'hat.play(1)\n\n  kick.play(1)\nLOOP(kick)'
    const block = resolveSelectionBlock(text, range(0, 11, 3, 10))
    expect(block.code).toBe('kick.play(1)\nLOOP(kick)')
    expect(block.lines).toEqual([pos(2, 2), pos(3, 0)])
  })

  it('maps a code only when it is the text of the range (or that text trimmed)', () => {
    expect(contiguousCodeLines(TEXT, range(4, 0, 5, 7), 'kick.play(1, 0,\n  1, 0)')).toEqual([
      pos(4, 0),
      pos(5, 0),
    ])
    expect(contiguousCodeLines(TEXT, range(0, 0, 0, 28), 'var kick = init global.seq')).toEqual([
      pos(0, 2),
    ])
    expect(contiguousCodeLines(TEXT, range(3, 0, 3, 11), 'hat.play(2)')).toBeUndefined()
    expect(contiguousCodeLines('a\r\nb', range(0, 0, 1, 1), 'a\r\nb')).toEqual([
      pos(0, 0),
      pos(1, 0),
    ])
  })
})

describe('transport.step.source points at the statement that set the sounding pattern (V-7)', () => {
  const uri = 'file:///ws/piece/v7.orbs'
  const TEXT = [
    'var hh = init global.seq', // 0
    'hh.audio("hh.wav")', // 1
    'hh.play(1, 1, 1, 1)', // 2
    'LOOP(hh)', // 3
    '', // 4
    '// switch', // 5
    'hh.play(1, 0, 0, 1, 0, 1, 0, 0)', // 6
    'LOOP(hh)', // 7
  ].join('\n')

  let tmp: string
  let sessions: EditorSession[]
  let generation: number

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-steps-'))
    sessions = []
    generation = 100
  })

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** 偽の engine: `<seq>.play(` の文と import の文（import 先が `lib` を鳴らす）でパターンを置く。 */
  async function prepared(
    failOn?: string,
  ): Promise<{ session: EditorSession; editor: RpcTestClient }> {
    let core: EditorSession['core'] | null = null
    const session = await startEditorSession(tmp, null, {
      onExecute: (text) => {
        if (failOn && text.startsWith(failOn)) throw new Error(`cannot run ${failOn}`)
        const play = /^(\w+)\.play\(/.exec(text)
        if (play) core!.onEnginePattern({ seq: play[1]!, generation: ++generation })
        if (text.startsWith('import '))
          core!.onEnginePattern({ seq: 'lib', generation: ++generation })
      },
    })
    core = session.core
    sessions.push(session)
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 3, text: TEXT, documentDirectory: '/ws/piece' })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)
    await (await session.agent()).call('engine.start', {})
    return { session, editor }
  }

  async function runSelection(session: EditorSession, editor: RpcTestClient, selected: object) {
    editor.answer = (method) =>
      method === 'editor.runSelection'
        ? { result: { uri, version: 3, range: selected, documentDirectory: '/ws/piece' } }
        : { result: { ok: true, message: 'selection set' } }
    const agent = await session.agent()
    expect(await agent.call('editor.runSelection', {})).toEqual({
      ok: true,
      message: 'selection executed',
    })
  }

  async function sourceOfStep(
    session: EditorSession,
    editor: RpcTestClient,
    seq: string,
    stepGeneration: number | undefined,
  ) {
    editor.notifications.length = 0
    session.core.onEngineStep({ seq, argPath: '0', atEpochMs: 1, generation: stepGeneration })
    await flush(editor)
    const steps = editor.notifications.filter((n) => n.method === 'transport.step')
    expect(steps).toHaveLength(1)
    expect(Object.keys(steps[0]!.params).sort()).toEqual(['argPath', 'atEpochMs', 'seq', 'source'])
    return steps[0]!.params.source
  }

  it('follows the pattern change: the old play() until its steps run out, then the switching block', async () => {
    const { session, editor } = await prepared()
    await runSelection(session, editor, range(0, 0, 3, 8))
    const first = generation
    const before = await sourceOfStep(session, editor, 'hh', first)
    expect(before).toEqual({
      evalId: expect.any(String),
      start: pos(2, 0),
      end: pos(2, 19),
      document: { uri, version: 3, range: range(2, 0, 2, 19) },
    })

    await runSelection(session, editor, range(6, 0, 7, 8))
    const second = generation
    expect(second).toBe(first + 1)
    // play() の前にスケジュール済みの step（前の世代）は、前の play() を指したまま。
    expect(await sourceOfStep(session, editor, 'hh', first)).toEqual(before)
    // 新しい世代の step は切り替えブロックの play() を指す（code の座標は 0 行目・文書の座標は 6 行目）。
    const after = await sourceOfStep(session, editor, 'hh', second)
    expect(after).toEqual({
      evalId: expect.any(String),
      start: pos(0, 0),
      end: pos(0, 31),
      document: { uri, version: 3, range: range(6, 0, 6, 31) },
    })
    expect(after.evalId).not.toBe(before.evalId)
  })

  it('maps a subject block whose statements are apart in the document', async () => {
    const { session, editor } = await prepared()
    await runSelection(session, editor, range(6, 3, 6, 3)) // カーソルだけ → hh の行をすべて集める
    // code = 0, 1, 2, 6 行目を繋いだもの。最後の play() は code の 3 行目、文書の 6 行目。
    expect(await sourceOfStep(session, editor, 'hh', generation)).toEqual({
      evalId: expect.any(String),
      start: pos(3, 0),
      end: pos(3, 31),
      document: { uri, version: 3, range: range(6, 0, 6, 31) },
    })
    expect(await sourceOfStep(session, editor, 'hh', generation - 1)).toMatchObject({
      start: pos(2, 0),
      document: { range: range(2, 0, 2, 19) },
    })
  })

  it('has no source for code outside a document, an imported file, or a step without a generation', async () => {
    const { session, editor } = await prepared()
    const agent = await session.agent()
    await agent.call('session.evaluate', {
      code: 'hh.play(1, 0)',
      documentDirectory: null,
      source: 'agent',
    })
    expect(await sourceOfStep(session, editor, 'hh', generation)).toBeNull()

    await agent.call('session.evaluate', {
      code: 'import { lib } from "./lib.orbs"\nhh.play(1)',
      documentDirectory: '/ws/piece',
      source: 'agent',
      target: { uri, version: 3 },
    })
    // import 先の文が置いたパターン（lib）は null、要求の文が置いたもの（hh）は位置を持つ。
    expect(await sourceOfStep(session, editor, 'lib', generation - 1)).toBeNull()
    expect(await sourceOfStep(session, editor, 'hh', generation)).toMatchObject({
      start: pos(1, 0),
      end: pos(1, 10),
    })
    // `[STEP]` の行（口を通らずに書かれたもの）には世代が無い。
    expect(await sourceOfStep(session, editor, 'hh', undefined)).toBeNull()
    // 文の実行の外で置かれたパターンは、どの文のものとも決まらない。
    session.core.onEnginePattern({ seq: 'hh', generation: 999 })
    expect(await sourceOfStep(session, editor, 'hh', 999)).toBeNull()
  })

  it('session.evaluate maps positions only when code is the synced text of target.range', async () => {
    const { session } = await prepared()
    const agent = await session.agent()
    const evaluated = (await agent.call('session.evaluate', {
      code: 'hh.play(1, 1, 1, 1)\nhh.nope(',
      documentDirectory: '/ws/piece',
      source: 'human',
      target: { uri, version: 3, range: range(2, 0, 3, 8) },
    })) as { diagnostics: unknown[] }
    // code が範囲のテキスト（`LOOP(hh)` の行）と違うので、診断に文書の座標は付けず、ログに 1 行残す。
    expect(evaluated.diagnostics).toHaveLength(1)
    expect(evaluated.diagnostics[0]).not.toHaveProperty('documentRange')
    const logged = await agent.call('session.getLog', { lines: 20 })
    expect(JSON.stringify(logged)).toContain(
      `the evaluated code is not the text of ${uri} (version 3) at the target range`,
    )

    // 範囲のテキストと同じ code でも、写しの版が違えば写さない（同期済みの写しは version 3）。
    const stale = (await agent.call('session.evaluate', {
      code: 'hh.play(1, 1, 1, 1',
      documentDirectory: '/ws/piece',
      source: 'human',
      target: { uri, version: 2, range: range(2, 0, 2, 18) },
    })) as { diagnostics: unknown[] }
    expect(stale.diagnostics).toHaveLength(1)
    expect(stale.diagnostics[0]).not.toHaveProperty('documentRange')
    expect(JSON.stringify(await agent.call('session.getLog', { lines: 20 }))).toContain(
      `the evaluated code is not the text of ${uri} (version 2) at the target range`,
    )

    const mapped = (await agent.call('session.evaluate', {
      code: 'LOOP(hh)\n\n// switch\nhh.play(1, 0, 0, 1, 0, 1, 0, 0',
      documentDirectory: '/ws/piece',
      source: 'human',
      target: { uri, version: 3, range: range(3, 0, 6, 30) },
    })) as { diagnostics: Array<{ range: unknown; documentRange: unknown }> }
    expect(mapped.diagnostics).toHaveLength(1)
    const [diagnostic] = mapped.diagnostics
    expect(diagnostic!.range).toEqual({ start: pos(3, 30), end: pos(3, 30) })
    expect(diagnostic!.documentRange).toEqual({ uri, version: 3, range: range(6, 30, 6, 30) })
  })

  it('editor.runSelection gives a failing statement of a subject block its document position', async () => {
    // code の 3 行目（切り替えの play()）は文書の 6 行目 — 離れた行が写ることを見る。
    const { session, editor } = await prepared('hh.play(1, 0')
    const results: unknown[] = []
    const evaluate = session.core.evaluate.bind(session.core)
    vi.spyOn(session.core, 'evaluate').mockImplementation(async (params, client, codeLines) => {
      const result = await evaluate(params, client, codeLines)
      results.push(result)
      return result
    })
    await runSelection(session, editor, range(6, 3, 6, 3))
    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        diagnostics: [
          {
            kind: 'runtime',
            message: 'cannot run hh.play(1, 0',
            range: range(3, 0, 3, 31),
            documentRange: { uri, version: 3, range: range(6, 0, 6, 31) },
          },
        ],
      }),
    ])
  })
})
