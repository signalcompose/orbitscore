/**
 * ⌘Enter / `run_selection` と `open_plugin_ui_at_cursor` が凍結版と同じものを選ぶこと（設計 848 §5.4・
 * §5.3.3・計画 §7.1 の C-11 N1-c3）。
 *
 * 凍結版の本体（`run-selection.ts` の `runSelection` と `plugin-ui-at-cursor.ts` の
 * `openPluginUiAtCursor`）を vitest の `vscode` の mock で走らせ、層 2 と同じ文書・同じ選択で比べる。
 * - run selection: 凍結版が engine へ書いたテキストと flash した範囲 ↔ 層 2 の `resolveSelectionBlock`
 * - plugin UI: 凍結版の戻り値 ↔ 層 2 の `plugin.openUiAtCursor`（同期済みの選択から組んだエディタ）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscodeMock from 'vscode'

const frozen = vi.hoisted(() => ({
  written: [] as Array<{ code: string; directory: string }>,
  pluginUiForAgent: vi.fn(),
}))

vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // mock が持たない名前（凍結版の runSelection が flash の前に読む）。
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
}))
vi.mock('../../packages/vscode-extension/src/extension-state', () => ({
  isLiveCodingMode: true,
  engineProcess: { killed: false },
  outputChannel: { appendLine: () => {} },
}))
vi.mock('../../packages/vscode-extension/src/engine-process', () => ({
  writeCodeToEngine: (code: string, directory: string) => {
    frozen.written.push({ code, directory })
    return true
  },
}))
vi.mock('../../packages/vscode-extension/src/agent-handlers', () => ({
  pluginUiForAgent: frozen.pluginUiForAgent,
}))

import type { Range } from '../../packages/session/src/host/document-store'
import { resolveSelectionBlock } from '../../packages/session/src/host/selection-block'
import { openPluginUiAtCursor as frozenOpenPluginUiAtCursor } from '../../packages/vscode-extension/src/plugin-ui-at-cursor'
import { runSelection as frozenRunSelection } from '../../packages/vscode-extension/src/run-selection'

import { flush, startEditorSession, type EditorSession } from './helpers/editor-session'

const mock = vscodeMock as unknown as typeof import('../mocks/vscode')

/** 凍結版に渡す文書（VS Code と同じく行の区切りは \r\n・\r・\n）。層 2 の実装は使わない。 */
function fakeDocument(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  const starts = [0]
  for (const match of text.matchAll(/\r\n|\r|\n/g))
    starts.push((match.index ?? 0) + match[0].length)
  const offset = (position: { line: number; character: number }) =>
    (starts[position.line] ?? text.length) +
    Math.min(position.character, (lines[position.line] ?? '').length)
  return {
    languageId: 'orbitscore',
    uri: { fsPath: '/ws/piece/a.orbs' },
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line]!,
      range: new mock.Range(line, 0, line, lines[line]!.length),
    }),
    getText: (range?: { start: { line: number; character: number }; end: typeof range.start }) =>
      range ? text.slice(offset(range.start), offset(range.end)) : text,
  }
}

const plain = (range: { start: { line: number; character: number }; end: typeof range.start }) => ({
  start: { line: range.start.line, character: range.start.character },
  end: { line: range.end.line, character: range.end.character },
})

/** 凍結版の runSelection が engine へ書いたテキストと flash した範囲。 */
async function frozenBlock(text: string, selection: Range) {
  let flashed: Range | null = null
  const start = new mock.Position(selection.start.line, selection.start.character)
  const end = new mock.Position(selection.end.line, selection.end.character)
  mock.window.activeTextEditor = {
    document: fakeDocument(text),
    selection: {
      start,
      end,
      active: end,
      isEmpty: start.line === end.line && start.character === end.character,
    },
    setDecorations: (_decoration: unknown, ranges: Range[]) => {
      flashed ??= plain(ranges[0]!)
    },
    revealRange: () => {},
  }
  frozen.written.length = 0
  await frozenRunSelection()
  expect(frozen.written).toHaveLength(1)
  expect(frozen.written[0]!.directory).toBe('/ws/piece')
  return { code: frozen.written[0]!.code, range: flashed }
}

const at = (line: number, character: number) => ({ line, character })
const cursorAt = (line: number, character: number): Range => ({
  start: at(line, character),
  end: at(line, character),
})

const SCORE = [
  'var global = init GLOBAL',
  'global.tempo(120)',
  '',
  'var drum = init global.seq',
  'drum.audio("kick.wav")',
  '// drum.play(9)',
  'drum.play(1, 0,',
  '  1, 0,',
  '  (1, 1))',
  'LOOP(drum)',
  'RUN(',
  '  drum,',
  '  bass)',
  'var bass = init global.seq',
  'bass.play(1)   ',
].join('\n')

const CASES: Array<{ name: string; text: string; selection: Range }> = [
  { name: 'subject block from the var line', text: SCORE, selection: cursorAt(3, 4) },
  { name: 'subject block from a method line', text: SCORE, selection: cursorAt(4, 0) },
  { name: 'subject block from inside a multi-line call', text: SCORE, selection: cursorAt(6, 3) },
  { name: 'continuation line is a standalone statement', text: SCORE, selection: cursorAt(7, 2) },
  { name: 'global subject', text: SCORE, selection: cursorAt(1, 5) },
  { name: 'standalone LOOP', text: SCORE, selection: cursorAt(9, 0) },
  { name: 'standalone multi-line RUN', text: SCORE, selection: cursorAt(10, 1) },
  { name: 'a comment line', text: SCORE, selection: cursorAt(5, 4) },
  { name: 'an empty line', text: SCORE, selection: cursorAt(2, 0) },
  { name: 'trailing spaces are trimmed', text: SCORE, selection: cursorAt(14, 0) },
  {
    name: 'a non-empty selection across lines',
    text: SCORE,
    selection: { start: at(9, 2), end: at(11, 4) },
  },
  {
    name: 'a selection with UTF-16 surrogate pairs',
    text: 'drum.audio("🥁 kick.wav")\nglobal.tempo(90)',
    selection: { start: at(0, 11), end: at(0, 24) },
  },
  {
    name: 'CRLF line endings, subject block',
    text: 'var a = init global.seq\r\na.play(1,\r\n  0)\r\nLOOP(a)',
    selection: cursorAt(0, 0),
  },
  {
    name: 'CRLF line endings, standalone multi-line statement',
    text: 'RUN(\r\n  a,\r\n  b)\r\n',
    selection: cursorAt(0, 0),
  },
  {
    name: 'an unclosed parenthesis runs to the end of the document',
    text: 'drum.play(1,\n  0,\n  1',
    selection: cursorAt(0, 0),
  },
  {
    name: 'var without spaces',
    text: 'var x=init global.seq\nx.play(1)',
    selection: cursorAt(1, 0),
  },
]

describe('run selection picks the same code and range as the frozen runSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    mock.window.activeTextEditor = undefined
  })

  it.each(CASES)('$name', async ({ text, selection }) => {
    // `lines`（code → 文書の写し・#1022）は層 2 だけが持つ。凍結版と比べるのは評価するテキストと範囲。
    const { code, range } = resolveSelectionBlock(text, selection)
    expect({ code, range }).toEqual(await frozenBlock(text, selection))
  })
})

describe('plugin.openUiAtCursor answers what the frozen openPluginUiAtCursor answers', () => {
  const uri = 'file:///ws/a.orbs'
  const TEXT = [
    'drums.effect(["Echo", "Room"])',
    'global.effect([Gain(db: -3), "Comp"])',
    'bass.effect([layer([["A"], ["X"]])])',
    'keys.effect("warm.vstpreset")',
  ].join('\n')

  let tmp: string
  let session: EditorSession | null = null

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-edparity-'))
    frozen.pluginUiForAgent.mockReset()
  })
  afterEach(async () => {
    await session?.close()
    session = null
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const col = (line: number, needle: string, offset = 1) =>
    TEXT.split('\n')[line]!.indexOf(needle) + offset

  const CURSOR_CASES: Array<{
    name: string
    range: Range
    cursor: 'start' | 'end'
    engine?: boolean
  }> = [
    { name: 'cursor on the first name', range: cursorAt(0, col(0, 'Echo')), cursor: 'end' },
    { name: 'cursor on the second name', range: cursorAt(0, col(0, 'Room')), cursor: 'end' },
    {
      name: 'a selection inside one name (caret at the end)',
      range: { start: at(0, col(0, 'Room', 0)), end: at(0, col(0, 'Room', 4)) },
      cursor: 'end',
    },
    {
      name: 'a selection inside one name (caret at the start)',
      range: { start: at(0, col(0, 'Room', 0)), end: at(0, col(0, 'Room', 4)) },
      cursor: 'start',
    },
    {
      name: 'a selection spanning two names (caret at the end)',
      range: { start: at(0, col(0, 'Echo')), end: at(0, col(0, 'Room')) },
      cursor: 'end',
    },
    {
      name: 'a selection spanning two names (caret at the start)',
      range: { start: at(0, col(0, 'Echo')), end: at(0, col(0, 'Room')) },
      cursor: 'start',
    },
    { name: 'the master receiver', range: cursorAt(1, col(1, 'Comp')), cursor: 'end' },
    { name: 'a standard plugin word', range: cursorAt(1, col(1, 'Gain')), cursor: 'end' },
    { name: 'a layer() path', range: cursorAt(2, col(2, 'X')), cursor: 'end' },
    { name: 'a saved state file', range: cursorAt(3, col(3, 'warm')), cursor: 'end' },
    { name: 'off any name', range: cursorAt(0, 2), cursor: 'end' },
    {
      name: 'engine not running',
      range: cursorAt(0, col(0, 'Echo')),
      cursor: 'end',
      engine: false,
    },
  ]

  it.each(CURSOR_CASES)('$name', async ({ range, cursor, engine = true }) => {
    const engineAnswer = engine
      ? { ok: true, result: { window: 'opened' } }
      : { ok: false, error: 'engine is not running — start the engine first' }
    frozen.pluginUiForAgent.mockResolvedValue(engineAnswer)
    const caret = cursor === 'end' ? range.end : range.start
    const anchor = cursor === 'end' ? range.start : range.end
    const expected = await frozenOpenPluginUiAtCursor(
      {
        document: { languageId: 'orbitscore', getText: () => TEXT },
        selection: { active: caret, anchor },
      } as never,
      undefined,
    )

    const opened: unknown[][] = []
    session = await startEditorSession(tmp, null, {
      openPluginUi: async (...args) => {
        opened.push(args)
        return { window: 'opened' }
      },
    })
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text: TEXT, documentDirectory: '/ws' })
    editor.notify('editor.didChangeActive', { uri })
    editor.notify('editor.didChangeSelection', { uri, range, cursor: caret })
    await flush(editor)
    const llm = await session.agent()
    if (engine) await llm.call('engine.start', {})

    expect(await llm.call('plugin.openUiAtCursor', {})).toEqual(expected)
    // engine へ渡す (receiver, index, expectedName) も同じ。
    expect(opened).toEqual(
      engine ? frozen.pluginUiForAgent.mock.calls.map((args) => args.slice(1)) : [],
    )
  })
})
