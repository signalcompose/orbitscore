/**
 * 逆方向の `editor.*`（設計 848 §5.3.4・§5.4・計画 §7.1 の C-11 N1-c3）を本物の RPC サーバで確かめる:
 * 中継から届いたメソッドをエディタへ転送する・エディタが無い / 答えない / 切れた / 形の違う答えを
 * 返した時に黙らない・`editor.runSelection` は選択だけを聞いて層 2 が評価する・
 * `plugin.openUiAtCursor` は同期済みの選択から解決する・F-12 の後に document を送り直せば元に戻る。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvaluateParams } from '../../packages/session/src/host/session-core'
import { RpcCallError } from '../../packages/session/src/rpc/client'

import { flush, startEditorSession, type EditorSession } from './helpers/editor-session'
import type { EditorAnswer, RpcTestClient } from './helpers/rpc-test-client'

let tmp: string
let sessions: EditorSession[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-edrev-'))
  sessions = []
})

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function start(
  options: Parameters<typeof startEditorSession>[2] = {},
  dir = tmp,
): Promise<EditorSession> {
  const session = await startEditorSession(dir, null, options)
  sessions.push(session)
  return session
}

/** RPC の失敗を `{ errorName, message }` にする（成功なら投げる）。 */
async function failure(
  promise: Promise<unknown>,
): Promise<{ errorName?: string; message: string }> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RpcCallError) return { errorName: error.errorName, message: error.message }
    throw error
  }
  throw new Error('expected the call to fail')
}

const ok: EditorAnswer = () => ({ result: { ok: true, message: 'done by the editor' } })

describe('forwarding to the editor client (design 848 §5.3.4 · x-editor-request: same)', () => {
  it.each([
    ['editor.openFile', { path: '/ws/a.orbs' }],
    ['editor.setSelection', { startLine: 2, startChar: 1, endLine: 3, endChar: 4 }],
    ['editor.editReplace', { find: 'kick', replace: 'snare', all: true }],
    ['editor.saveFile', {}],
  ] as const)(
    '%s reaches the editor with the same params and returns its answer',
    async (method, params) => {
      const session = await start()
      const editor = await session.editorClient()
      editor.answer = ok
      const llm = await session.agent()
      expect(await llm.call(method, params)).toEqual({ ok: true, message: 'done by the editor' })
      expect(editor.editorRequests).toEqual([{ id: expect.any(String), method, params }])
    },
  )

  it('editor.configureFlash returns the editor config result unchanged', async () => {
    const session = await start()
    const editor = await session.editorClient()
    const config = { count: 2, duration: 100, color: 'custom', customColor: '#ff6b6b' }
    editor.answer = () => ({ result: { ok: true, config } })
    const llm = await session.agent()
    expect(await llm.call('editor.configureFlash', { count: 2 })).toEqual({ ok: true, config })
  })

  it('answers NO_EDITOR_ATTACHED when no editor client is attached (D-3)', async () => {
    const session = await start()
    const llm = await session.agent()
    for (const method of ['editor.openFile', 'editor.runSelection', 'plugin.openUiAtCursor']) {
      expect(
        await failure(llm.call(method, method === 'editor.openFile' ? { path: '/a.orbs' } : {})),
        method,
      ).toEqual({
        errorName: 'NO_EDITOR_ATTACHED',
        message: expect.stringMatching(/^no editor is attached to this session/),
      })
    }
  })

  it('answers EDITOR_TIMEOUT when the editor does not answer in time (§5.4 · not silent)', async () => {
    const session = await start({ editorRequestTimeoutMs: 50 })
    const editor = await session.editorClient()
    const llm = await session.agent()
    expect(await failure(llm.call('editor.saveFile', {}))).toEqual({
      errorName: 'EDITOR_TIMEOUT',
      message: 'the editor did not answer editor.saveFile within 50 ms',
    })
    expect(editor.editorRequests.map((request) => request.method)).toEqual(['editor.saveFile'])
  })

  it('answers NO_EDITOR_ATTACHED when the editor leaves before answering', async () => {
    const session = await start()
    const editor = await session.editorClient()
    const llm = await session.agent()
    const pending = failure(llm.call('editor.openFile', { path: '/ws/a.orbs' }))
    while (editor.editorRequests.length === 0) await new Promise((r) => setTimeout(r, 5))
    editor.close()
    expect(await pending).toEqual({
      errorName: 'NO_EDITOR_ATTACHED',
      message: 'the editor disconnected before answering editor.openFile',
    })
  })

  it('refuses an editor answer outside the schema, and logs why', async () => {
    const session = await start()
    const editor = await session.editorClient()
    editor.answer = () => ({ result: { ok: 'yes' } })
    const llm = await session.agent()
    expect(await failure(llm.call('editor.saveFile', {}))).toEqual({
      errorName: 'INTERNAL_ERROR',
      message: 'the editor answered editor.saveFile with an invalid result',
    })
    expect(
      session.core.logs
        .select(20)
        .some((line) => line.includes('the editor answered editor.saveFile outside the schema')),
    ).toBe(true)
  })

  it('turns an editor error answer into INTERNAL_ERROR that names the method', async () => {
    const session = await start()
    const editor = await session.editorClient()
    editor.answer = () => ({ error: { code: -32603, message: 'disk full' } })
    const llm = await session.agent()
    expect(await failure(llm.call('editor.saveFile', {}))).toEqual({
      errorName: 'INTERNAL_ERROR',
      message: 'the editor failed editor.saveFile: disk full',
    })
  })

  it('a reverse request outside the schema is never put on the wire', async () => {
    const session = await start()
    const editor = await session.editorClient()
    await expect(session.server.requestEditor('editor.openFile', { path: 1 })).rejects.toThrow(
      'refusing to send editor.openFile to the editor outside the schema',
    )
    await expect(session.server.requestEditor('editor.getState', {})).rejects.toThrow(
      'editor.getState has no editor request',
    )
    await flush(editor)
    expect(editor.editorRequests).toEqual([])
  })
})

describe('editor.saveFile marks the synced copy saved (get_editor_state isDirty)', () => {
  const uri = 'file:///ws/a.orbs'

  async function dirtyDocument(session: EditorSession): Promise<RpcTestClient> {
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text: 'kick', documentDirectory: '/ws' })
    editor.notify('editor.didChange', { uri, version: 2, changes: [{ text: 'snare' }] })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)
    return editor
  }

  it('clears isDirty after a successful save, and keeps it after a failed one', async () => {
    const session = await start()
    const editor = await dirtyDocument(session)
    const llm = await session.agent()
    editor.answer = () => ({ result: { ok: false, error: 'no active editor' } })
    await llm.call('editor.saveFile', {})
    expect(await llm.call('editor.getState')).toMatchObject({ isDirty: true })
    editor.answer = ok
    await llm.call('editor.saveFile', {})
    expect(await llm.call('editor.getState')).toMatchObject({ isDirty: false })
  })

  it('marks the version at request time: a change that lands before the answer stays dirty', async () => {
    const session = await start()
    const editor = await dirtyDocument(session)
    editor.answer = () => {
      editor.notify('editor.didChange', { uri, version: 3, changes: [{ text: 'hat' }] })
      return { result: { ok: true, message: 'saved' } }
    }
    const llm = await session.agent()
    await llm.call('editor.saveFile', {})
    expect(await llm.call('editor.getState')).toMatchObject({ isDirty: true })
  })
})

describe('editor.runSelection: the editor gives the selection, layer 2 evaluates (§5.4)', () => {
  const uri = 'file:///ws/piece/a.orbs'
  const TEXT = [
    'var drum = init global.seq',
    'LOOP(drum)',
    'drum.audio("kick.wav")',
    'drum.play(1, 0,',
    '  1, 0)',
    'global.tempo(120)',
  ].join('\n')

  async function prepared(
    options: Parameters<typeof startEditorSession>[2] = {},
  ): Promise<{ session: EditorSession; editor: RpcTestClient; evaluated: EvaluateParams[] }> {
    const session = await start(options)
    const evaluated: EvaluateParams[] = []
    const evaluate = session.core.evaluate.bind(session.core)
    vi.spyOn(session.core, 'evaluate').mockImplementation(async (params, client) => {
      evaluated.push(params)
      return evaluate(params, client)
    })
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 3, text: TEXT, documentDirectory: '/ws/piece' })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)
    return { session, editor, evaluated }
  }

  function snapshotAnswer(range: object, version = 3): EditorAnswer {
    return (method) =>
      method === 'editor.runSelection'
        ? { result: { uri, version, range, documentDirectory: '/ws/piece' } }
        : { result: { ok: true, message: 'selection set' } }
  }

  it('evaluates the subject block under an empty selection, with the target range and the editor directory', async () => {
    const evalSources: Array<string | undefined> = []
    const { session, editor, evaluated } = await prepared({
      onExecute: (_ir, options) => evalSources.push(options.evalSource),
    })
    const llm = await session.agent()
    await llm.call('engine.start', {})
    editor.answer = snapshotAnswer({
      start: { line: 2, character: 3 },
      end: { line: 2, character: 3 },
    })
    expect(await llm.call('editor.runSelection', {})).toEqual({
      ok: true,
      message: 'selection executed',
    })
    expect(evaluated).toEqual([
      {
        code: [
          'var drum = init global.seq',
          'drum.audio("kick.wav")',
          'drum.play(1, 0,',
          '  1, 0)',
        ].join('\n'),
        documentDirectory: '/ws/piece',
        source: 'agent',
        target: {
          uri,
          version: 3,
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 7 } },
        },
      },
    ])
    // interpreter には文ごとに `evalSource: 'agent'` で届く（`.orbslog` の帰属）。
    expect(evalSources.length).toBeGreaterThan(0)
    expect(new Set(evalSources)).toEqual(new Set(['agent']))
    // 空の選択は畳むものが無いので、逆方向は選択を聞いた 1 回だけ。
    expect(editor.editorRequests.map((request) => request.method)).toEqual(['editor.runSelection'])
  })

  it('an agent run with a non-empty selection collapses it to the cursor afterwards (#390)', async () => {
    const { session, editor, evaluated } = await prepared()
    editor.notify('editor.didChangeSelection', {
      uri,
      range: { start: { line: 5, character: 0 }, end: { line: 5, character: 17 } },
      cursor: { line: 5, character: 17 },
    })
    const llm = await session.agent()
    await llm.call('engine.start', {})
    editor.answer = snapshotAnswer({
      start: { line: 5, character: 0 },
      end: { line: 5, character: 17 },
    })
    expect(await llm.call('editor.runSelection', {})).toEqual({
      ok: true,
      message: 'selection executed',
    })
    expect(evaluated.map((params) => params.code)).toEqual(['global.tempo(120)'])
    expect(editor.editorRequests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'editor.runSelection', params: {} },
      { method: 'editor.setSelection', params: { startLine: 6, startChar: 18 } },
    ])
  })

  it('the editor itself pressing ⌘Enter is a human run and keeps its selection', async () => {
    const { session, editor, evaluated } = await prepared()
    const llm = await session.agent()
    await llm.call('engine.start', {})
    editor.answer = snapshotAnswer({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 10 },
    })
    expect((await editor.request('editor.runSelection', {})).result).toEqual({
      ok: true,
      message: 'selection executed',
    })
    expect(evaluated.map(({ code, source }) => ({ code, source }))).toEqual([
      { code: 'LOOP(drum)', source: 'human' },
    ])
    expect(editor.editorRequests.map((request) => request.method)).toEqual(['editor.runSelection'])
  })

  it('checks the editor before the engine, with the frozen wording (runSelectionForAgent)', async () => {
    const session = await start()
    const editor = await session.editorClient()
    editor.answer = snapshotAnswer({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    })
    const llm = await session.agent()
    const noEditor = { ok: false, error: 'no active OrbitScore editor — open an .orbs file first' }
    expect(await llm.call('editor.runSelection', {})).toEqual(noEditor)
    editor.notify('editor.didOpen', {
      uri: 'file:///ws/notes.txt',
      version: 1,
      text: 'x',
      documentDirectory: '/ws',
    })
    editor.notify('editor.didChangeActive', { uri: 'file:///ws/notes.txt' })
    await flush(editor)
    expect(await llm.call('editor.runSelection', {})).toEqual(noEditor)
    editor.notify('editor.didOpen', { uri, version: 1, text: 'LOOP(a)', documentDirectory: '/ws' })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)
    expect(await llm.call('editor.runSelection', {})).toEqual({
      ok: false,
      error: 'engine is not running — start the engine first',
    })
    // どちらの断りでも、エディタには何も聞いていない。
    expect(editor.editorRequests).toEqual([])
  })

  it('refuses to evaluate when the editor selection is on a version layer 2 does not have', async () => {
    const { session, editor, evaluated } = await prepared()
    const llm = await session.agent()
    await llm.call('engine.start', {})
    editor.answer = snapshotAnswer(
      { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      7,
    )
    expect(await llm.call('editor.runSelection', {})).toEqual({
      ok: false,
      error: `the editor selection is on version 7 of ${uri}, but layer 2 has version 3 — the document sync fell behind`,
    })
    expect(evaluated).toEqual([])
  })

  it('a selection snapshot outside the schema is refused before anything is evaluated', async () => {
    const { session, editor, evaluated } = await prepared()
    const llm = await session.agent()
    await llm.call('engine.start', {})
    editor.answer = () => ({ result: { uri, version: 3 } })
    expect(await failure(llm.call('editor.runSelection', {}))).toEqual({
      errorName: 'INTERNAL_ERROR',
      message: 'the editor answered editor.runSelection with an invalid result',
    })
    expect(evaluated).toEqual([])
  })
})

describe('plugin.openUiAtCursor resolves from the synced selection (§5.3.3)', () => {
  const uri = 'file:///ws/a.orbs'
  const TEXT = 'drums.effect(["Echo", "Room"])'

  async function withCursor(
    session: EditorSession,
    character: number,
    text = TEXT,
  ): Promise<RpcTestClient> {
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text, documentDirectory: '/ws' })
    editor.notify('editor.didChangeActive', { uri })
    editor.notify('editor.didChangeSelection', {
      uri,
      range: { start: { line: 0, character }, end: { line: 0, character } },
    })
    await flush(editor)
    return editor
  }

  it('opens the plugin under the cursor through plugin.openUi, with the frozen result shape', async () => {
    const opened: unknown[] = []
    const session = await start({
      openPluginUi: async (...args) => {
        opened.push(args)
        return { window: 'opened' }
      },
    })
    await withCursor(session, TEXT.indexOf('Room') + 1)
    const llm = await session.agent()
    await llm.call('engine.start', {})
    expect(await llm.call('plugin.openUiAtCursor', {})).toEqual({
      ok: true,
      window: 'opened',
      receiver: 'drums',
      index: 2,
      chain_path: [1],
      normalizedName: 'Room',
      site: { line: 1, startCol: 23, endCol: 29 },
    })
    expect(opened).toEqual([['drums', 2, 'Room']])
  })

  it('without an engine, answers the frozen engine wording (plugin.openUi decides)', async () => {
    const session = await start()
    await withCursor(session, TEXT.indexOf('Echo') + 1)
    const llm = await session.agent()
    expect(await llm.call('plugin.openUiAtCursor', {})).toEqual({
      ok: false,
      error: 'engine is not running — start the engine first',
    })
  })

  it('a cursor off any plugin name is refused with the frozen message, and logged', async () => {
    const session = await start()
    await withCursor(session, 2)
    const llm = await session.agent()
    const message =
      'The cursor is not on a plugin name. Place it on a "name" inside effect([...]) or instrument(...).'
    expect(await llm.call('plugin.openUiAtCursor', {})).toEqual({ ok: false, error: message })
    expect(
      session.core.logs.select(5).some((line) => line.includes(`❌ OrbitScore: ${message}`)),
    ).toBe(true)
  })

  it('with no front document, answers the frozen "open an .orbs file" failure', async () => {
    const session = await start()
    await session.editorClient()
    const llm = await session.agent()
    expect(await llm.call('plugin.openUiAtCursor', {})).toEqual({
      ok: false,
      error: 'Open an OrbitScore (.orbs) file and place the cursor on a plugin name.',
    })
  })

  it('two sessions in one process each open on their own engine (withPluginUiOpener)', async () => {
    const calls: string[] = []
    const make = (name: string) =>
      start(
        {
          openPluginUi: async (receiver) => {
            calls.push(`${name}:${receiver}`)
            await new Promise((resolve) => setTimeout(resolve, 10))
            return {}
          },
        },
        fs.mkdtempSync(path.join(tmp, `${name}-`)),
      )
    const a = await make('a')
    const b = await make('b')
    const bass = 'bass.effect(["Echo"])'
    await withCursor(a, TEXT.indexOf('Echo') + 1)
    await withCursor(b, bass.indexOf('Echo') + 1, bass)
    const [llmA, llmB] = [await a.agent(), await b.agent()]
    await llmA.call('engine.start', {})
    await llmB.call('engine.start', {})
    await Promise.all([
      llmA.call('plugin.openUiAtCursor', {}),
      llmB.call('plugin.openUiAtCursor', {}),
    ])
    expect(calls.sort()).toEqual(['a:drums', 'b:bass'])
  })
})

describe('F-12: after layer 2 restarts, the editor re-sends and the session works again (§5.5)', () => {
  it('restores the document list and the active document, and run_selection evaluates', async () => {
    const uri = 'file:///ws/a.orbs'
    const other = 'file:///ws/b.orbs'
    const resend = (editor: RpcTestClient) => {
      editor.notify('editor.didOpen', {
        uri,
        version: 5,
        text: 'LOOP(a)',
        documentDirectory: '/ws',
      })
      editor.notify('editor.didOpen', {
        uri: other,
        version: 2,
        text: 'global.tempo(90)',
        documentDirectory: '/ws',
      })
      editor.notify('editor.didChangeActive', { uri })
    }
    const before = await start()
    const firstEditor = await before.editorClient()
    resend(firstEditor)
    await flush(firstEditor)
    const firstAgent = await before.agent()
    await firstAgent.call('engine.start', {})
    const stateBefore = await firstAgent.call('session.getState')
    const editorStateBefore = await firstAgent.call('editor.getState')
    await before.close()
    sessions.splice(sessions.indexOf(before), 1)

    // 同じ runtime-dir で起動し直した層 2 は何も覚えていない。エディタが送り直すと元に戻る。
    const after = await start()
    const llm = await after.agent()
    await llm.call('engine.start', {})
    expect(await llm.call('session.getState')).toMatchObject({ documents: [], activeUri: null })
    const editor = await after.editorClient()
    resend(editor)
    await flush(editor)
    const { engine: _engine, ...restored } = (await llm.call('session.getState')) as Record<
      string,
      unknown
    >
    const { engine: _before, ...expected } = stateBefore as Record<string, unknown>
    expect(restored).toEqual(expected)
    expect(await llm.call('editor.getState')).toEqual(editorStateBefore)

    editor.answer = () => ({
      result: {
        uri,
        version: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        documentDirectory: '/ws',
      },
    })
    expect(await llm.call('editor.runSelection', {})).toEqual({
      ok: true,
      message: 'selection executed',
    })
  })
})
