import type { ChildProcess } from 'child_process'

import type { ExtensionContext } from 'vscode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluateForAgent } from '../../packages/vscode-extension/src/agent-handlers'
import {
  clearAllPlayheadDecorations,
  clearPlayheadForSequence,
  handleStepLine,
  __resetPlayheadStateForTest,
} from '../../packages/vscode-extension/src/playhead-decorations'
import * as playheadDecorations from '../../packages/vscode-extension/src/playhead-decorations'
import { runSelection } from '../../packages/vscode-extension/src/run-selection'
import {
  bumpEngineGeneration,
  evalMarkBridge,
  __setEngineProcessForTest,
  __setLiveCodingModeForTest,
} from '../../packages/vscode-extension/src/extension-state'
import { activate, deactivate } from '../../packages/vscode-extension/src/extension'
import * as vscodeMock from '../mocks/vscode'

interface DecorationCall {
  type: { options?: { border?: string } }
  ranges: vscodeMock.Range[]
}

class TestDocument {
  readonly languageId = 'orbitscore'
  readonly uri: { fsPath: string; toString(): string }

  constructor(
    readonly name: string,
    private value: string,
  ) {
    const uri = `file:///tmp/${name}`
    this.uri = { fsPath: `/tmp/${name}`, toString: () => uri }
  }

  get lineCount(): number {
    return this.value.split('\n').length
  }

  getText(range?: vscodeMock.Range): string {
    if (!range) return this.value
    return this.value.slice(this.offsetAt(range.start), this.offsetAt(range.end))
  }

  lineAt(line: number): { text: string; range: vscodeMock.Range } {
    const lines = this.value.split('\n')
    const start = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0)
    const text = lines[line] ?? ''
    return {
      text,
      range: new vscodeMock.Range(this.positionAt(start), this.positionAt(start + text.length)),
    }
  }

  positionAt(offset: number): vscodeMock.Position {
    const clamped = Math.max(0, Math.min(offset, this.value.length))
    const before = this.value.slice(0, clamped)
    const lines = before.split('\n')
    return new vscodeMock.Position(lines.length - 1, lines.at(-1)?.length ?? 0)
  }

  offsetAt(position: vscodeMock.Position): number {
    const lines = this.value.split('\n')
    let offset = 0
    for (let line = 0; line < position.line; line++) offset += (lines[line]?.length ?? 0) + 1
    return Math.min(offset + position.character, this.value.length)
  }

  replace(offset: number, length: number, text: string): void {
    this.value = this.value.slice(0, offset) + text + this.value.slice(offset + length)
  }
}

class TestEditor {
  selection: {
    start: vscodeMock.Position
    end: vscodeMock.Position
    active: vscodeMock.Position
    isEmpty: boolean
  }
  readonly decorationCalls: DecorationCall[] = []

  constructor(readonly document: TestDocument) {
    const start = document.positionAt(0)
    this.selection = { start, end: start, active: start, isEmpty: true }
  }

  select(startOffset: number, endOffset = startOffset): void {
    const start = this.document.positionAt(startOffset)
    const end = this.document.positionAt(endOffset)
    this.selection = { start, end, active: end, isEmpty: startOffset === endOffset }
  }

  setDecorations(type: DecorationCall['type'], ranges: vscodeMock.Range[]): void {
    this.decorationCalls.push({ type, ranges: [...ranges] })
  }

  revealRange(): void {}
}

const editors = (...values: TestEditor[]): void => {
  vscodeMock.window.visibleTextEditors.length = 0
  vscodeMock.window.visibleTextEditors.push(...values)
}

const activateEditor = (editor: TestEditor): void => {
  vscodeMock.window.activeTextEditor = editor
}

const playheadRanges = (editor: TestEditor): vscodeMock.Range[] => {
  const call = [...editor.decorationCalls]
    .reverse()
    .find((entry) => typeof entry.type.options?.border === 'string')
  return call?.ranges ?? []
}

const decoratedText = (editor: TestEditor): string[] =>
  playheadRanges(editor).map((range) => editor.document.getText(range))

const lineSelection = (editor: TestEditor, line: number): void => {
  const range = editor.document.lineAt(line).range
  editor.select(editor.document.offsetAt(range.start), editor.document.offsetAt(range.end))
}

const run = async (editor: TestEditor): Promise<void> => {
  activateEditor(editor)
  await runSelection()
}

const step = async (seqName: string, argPath: string): Promise<void> => {
  handleStepLine({ seqName, argPath, atEpochMs: Date.now() })
  await vi.advanceTimersByTimeAsync(0)
}

const edit = (
  document: TestDocument,
  rangeOffset: number,
  rangeLength: number,
  text: string,
): { document: TestDocument; contentChanges: unknown[] } => {
  const range = new vscodeMock.Range(
    document.positionAt(rangeOffset),
    document.positionAt(rangeOffset + rangeLength),
  )
  document.replace(rangeOffset, rangeLength, text)
  const event = {
    document,
    contentChanges: [{ range, rangeOffset, rangeLength, text }],
  }
  playheadDecorations.notePlayheadDocumentChange(event)
  return event
}

let stdinWrites: string[]

const installEngine = (writable = true): void => {
  stdinWrites = []
  const stdin = {
    writable,
    write: (text: string, callback?: (error: Error | null) => void) => {
      stdinWrites.push(text)
      callback?.(null)
      return true
    },
  }
  __setEngineProcessForTest({ killed: false, stdin } as unknown as ChildProcess)
  __setLiveCodingModeForTest(true)
}

const evaluate = async (code: string): Promise<void> => {
  const resultPromise = evaluateForAgent(code)
  await Promise.resolve()
  const marker = [...stdinWrites].reverse().find((line) => line.startsWith('//#evalMark '))
  expect(marker).toBeDefined()
  const requestId = JSON.parse(marker!.slice('//#evalMark '.length)).requestId
  evalMarkBridge.handleLine(JSON.stringify({ evalMark: { requestId, ok: true, diagnostics: [] } }))
  await expect(resultPromise).resolves.toEqual({ ok: true })
}

describe('playhead source integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    __resetPlayheadStateForTest()
    vscodeMock.resetDocumentChangeListeners()
    vscodeMock.resetRegisteredCommandHandlers()
    editors()
    vscodeMock.window.activeTextEditor = undefined
    installEngine()
  })

  afterEach(() => {
    evalMarkBridge.drainAll('test cleanup')
    __resetPlayheadStateForTest()
    __setEngineProcessForTest(null)
    __setLiveCodingModeForTest(false)
    vscodeMock.window.activeTextEditor = undefined
    editors()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('I1: decorates only document A after A runs, even when B is first', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1, 2)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(8, 9)'))
    editors(b, a)
    lineSelection(a, 0)
    await run(a)
    await step('hh', '1')

    expect(decoratedText(a)).toEqual(['2'])
    expect(playheadRanges(b)).toEqual([])
  })

  it('I2: decorates nowhere visible when recorded document A is hidden', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1, 2)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(8, 9)'))
    editors(a, b)
    lineSelection(a, 0)
    await run(a)
    editors(b)
    await step('hh', '0')

    expect(playheadRanges(b)).toEqual([])
  })

  it('I3: follows the selected lower play call in the issue example', async () => {
    const editor = new TestEditor(
      new TestDocument('issue.orbs', 'hh.play(9, 9)\nhh.play(0, 1, 2, 3, 4, 5, 6, 7)'),
    )
    editors(editor)
    lineSelection(editor, 1)
    await run(editor)
    await step('hh', '5')

    expect(decoratedText(editor)).toEqual(['5'])
    expect(playheadRanges(editor)[0].start.line).toBe(1)
  })

  it('I4: uses the later play call when one selection contains two', async () => {
    const document = new TestDocument('two.orbs', 'hh.play(1)\nhh.play(2)')
    const editor = new TestEditor(document)
    editors(editor)
    editor.select(0, document.getText().length)
    await run(editor)
    await step('hh', '0')

    expect(decoratedText(editor)).toEqual(['2'])
    expect(playheadRanges(editor)[0].start.line).toBe(1)
  })

  it('I5: subject-block records contiguous sent lines but not an intervening subject', async () => {
    const a = new TestEditor(
      new TestDocument(
        'a.orbs',
        'var hh = init global.seq\nhh.play(1)\nkick.play(9)\nhh.play(\n  2\n)',
      ),
    )
    const b = new TestEditor(new TestDocument('b.orbs', 'kick.play(3)'))
    editors(a, b)
    lineSelection(b, 0)
    await run(b)
    a.select(a.document.offsetAt(a.document.lineAt(1).range.start))
    await run(a)

    await step('hh', '0')
    expect(decoratedText(a)).toEqual(['2'])
    await step('kick', '0')
    expect(decoratedText(b)).toEqual(['3'])
  })

  it('I6: running a range without play leaves the recorded source unchanged', async () => {
    const editor = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)\nLOOP(hh)\nhh.play(2)'))
    editors(editor)
    lineSelection(editor, 2)
    await run(editor)
    lineSelection(editor, 1)
    await run(editor)
    await step('hh', '0')

    expect(decoratedText(editor)).toEqual(['2'])
  })

  it('I7: does not record a source when the engine write fails', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(b, a)
    installEngine(false)
    lineSelection(a, 0)
    await run(a)
    await step('hh', '0')

    expect(decoratedText(b)).toEqual(['2'])
    expect(playheadRanges(a)).toEqual([])
  })

  it('I8: does not record a play call from a selected comment', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', '// hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(b, a)
    lineSelection(a, 0)
    await run(a)
    await step('hh', '0')

    expect(decoratedText(b)).toEqual(['2'])
  })

  it('I9: without a record, falls back to the first non-comment play call', async () => {
    const editor = new TestEditor(
      new TestDocument('fallback.orbs', '// hh.play(9)\nhh.play(1)\nLOOP(hh)'),
    )
    editors(editor)
    lineSelection(editor, 2)
    await run(editor)
    await step('hh', '0')

    expect(decoratedText(editor)).toEqual(['1'])
  })

  it('I10: MCP evaluate forgets only sequences whose play call it sends', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)\nkick.play(4)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(a, b)
    lineSelection(a, 0)
    await run(a)
    lineSelection(a, 1)
    await run(a)
    await evaluate('hh.play(8)')
    editors(b, a)

    await step('hh', '0')
    expect(decoratedText(b)).toEqual(['2'])
    await step('kick', '0')
    expect(decoratedText(a)).toEqual(['4'])
  })

  it('I11: MCP evaluate without play keeps the recorded source', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(a, b)
    lineSelection(a, 0)
    await run(a)
    await evaluate('LOOP(hh)')
    editors(b, a)
    await step('hh', '0')

    expect(decoratedText(a)).toEqual(['1'])
    expect(playheadRanges(b)).toEqual([])
  })

  it('I12: treats a source from an older engine generation as absent', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(a, b)
    lineSelection(a, 0)
    await run(a)
    bumpEngineGeneration()
    editors(b, a)
    await step('hh', '0')

    expect(decoratedText(b)).toEqual(['2'])
  })

  it('I13: sequence and global stops clear ranges without forgetting sources', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(2)'))
    editors(b, a)
    lineSelection(a, 0)
    await run(a)

    clearPlayheadForSequence('hh')
    await step('hh', '0')
    expect(decoratedText(a)).toEqual(['1'])
    clearAllPlayheadDecorations()
    await step('hh', '0')
    expect(decoratedText(a)).toEqual(['1'])
  })

  it('I19: global stop repaints empty ranges after an edit dropped every active range', async () => {
    const document = new TestDocument('stale.orbs', 'hh.play(1)\nkk.play(2)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 0)
    await run(editor)
    lineSelection(editor, 1)
    await run(editor)
    await step('hh', '0')
    await step('kk', '0')

    edit(document, 0, 0, '// edited before both calls\n')
    const callsBeforeStop = editor.decorationCalls.length
    clearAllPlayheadDecorations()
    const stopCalls = editor.decorationCalls.slice(callsBeforeStop)

    expect(stopCalls.length).toBeGreaterThan(0)
    expect(stopCalls.every((call) => call.ranges.length === 0)).toBe(true)
  })

  it('I20: without a record, out-of-range in one editor continues to the next editor', async () => {
    const a = new TestEditor(new TestDocument('a.orbs', 'hh.play(1)'))
    const b = new TestEditor(new TestDocument('b.orbs', 'hh.play(1, 0, 1)'))
    editors(a, b)

    await step('hh', '2')

    expect(playheadRanges(a)).toEqual([])
    expect(decoratedText(b)).toEqual(['1'])
  })

  it('I14: follows the recorded call after a new play line is inserted above it', async () => {
    const document = new TestDocument('a.orbs', 'hh.play(1, 2)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 0)
    await run(editor)
    edit(document, 0, 0, 'hh.play(7, 7)\n')
    await step('hh', '1')

    expect(decoratedText(editor)).toEqual(['2'])
    expect(playheadRanges(editor)[0].start.line).toBe(1)
  })

  it('I15: re-slices edited arguments and leaves the previous range on out-of-range steps', async () => {
    const document = new TestDocument('a.orbs', 'hh.play(1, 2)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 0)
    await run(editor)
    await step('hh', '0')
    edit(document, document.getText().indexOf('1'), 1, '111')
    await step('hh', '0')
    expect(decoratedText(editor)).toEqual(['111'])

    const comma = document.getText().indexOf(',')
    edit(document, comma, document.getText().length - comma - 1, '')
    await step('hh', '1')
    expect(decoratedText(editor)).toEqual(['111'])
  })

  it('I16: deleting the recorded line invalidates it instead of falling back above', async () => {
    const document = new TestDocument('a.orbs', 'hh.play(7)\nhh.play(2)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 1)
    await run(editor)
    await step('hh', '0')
    const lower = document.getText().lastIndexOf('hh.play')
    edit(document, lower, document.getText().length - lower, '')
    await step('hh', '0')

    expect(playheadRanges(editor)).toEqual([])
  })

  it('I17: comment-out hides the source and removing the comment restores it', async () => {
    const document = new TestDocument('a.orbs', 'hh.play(1)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 0)
    await run(editor)
    edit(document, 0, 0, '// ')
    await step('hh', '0')
    expect(playheadRanges(editor)).toEqual([])

    edit(document, 0, 3, '')
    await step('hh', '0')
    expect(decoratedText(editor)).toEqual(['1'])
  })

  it('I18: does not redraw another sequence at its stale pre-edit range', async () => {
    const document = new TestDocument('a.orbs', 'hh.play(1)\nkick.play(2)')
    const editor = new TestEditor(document)
    editors(editor)
    lineSelection(editor, 0)
    await run(editor)
    lineSelection(editor, 1)
    await run(editor)
    await step('hh', '0')
    await step('kick', '0')
    edit(document, 0, 0, '// moved\n')
    const callsBeforeStep = editor.decorationCalls.length
    await step('hh', '0')

    const redrawn = editor.decorationCalls.slice(callsBeforeStep)
    const nonempty = redrawn.flatMap((call) =>
      call.type.options?.border ? call.ranges.map((range) => document.getText(range)) : [],
    )
    expect(nonempty).toEqual(['1'])
  })

  it('W1: activate registers and wires a dedicated document-change listener', async () => {
    const document = new TestDocument('wired.orbs', 'hh.play(1)')
    const editor = new TestEditor(document)
    editors(editor)
    playheadDecorations.recordPlayheadSources(document, [document.lineAt(0).range])

    await activate({ subscriptions: [] } as unknown as ExtensionContext)
    expect(vscodeMock.documentChangeListeners).toHaveLength(2)
    const range = new vscodeMock.Range(document.positionAt(0), document.positionAt(0))
    document.replace(0, 0, '// ')
    vscodeMock.documentChangeListeners.at(-1)?.({
      document,
      contentChanges: [{ range, rangeOffset: 0, rangeLength: 0, text: '// ' }],
    })
    await step('hh', '0')

    expect(playheadRanges(editor)).toEqual([])
    deactivate()
  })
})
