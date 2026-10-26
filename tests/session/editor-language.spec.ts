/**
 * 層 2 の言語サービスを本物の RPC サーバで確かめる（設計 848 §5.3.4・§5.5・計画 §7.1 の C-11）:
 * **`editor.diagnostics` の通知と `get_diagnostics` は同じ計算結果**・閉じた文書のマーカーは消える・
 * `editor.complete` は同期済みの写しで答える。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildServer } from '../../packages/session/src/mcp/build-server'
import {
  createRpcDocsSource,
  createRpcToolHandlers,
  type SessionCall,
} from '../../packages/session/src/mcp/rpc-tool-handlers'
import { connectSession } from '../../packages/session/src/rpc/client'

import { flush, startEditorSession, type EditorSession } from './helpers/editor-session'
import { connectMcp } from './helpers/mcp-test-client'

let tmp: string
let session: EditorSession | null

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-edlang-'))
  session = null
})

afterEach(async () => {
  await session?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const BROKEN = 'global.tempo(1200\nglobal.tempo(5)\n'
const uri = 'file:///ws/piece/a.orbs'

/** 通知の到着を待つ（診断の計算は非同期）。 */
async function nextDiagnostics(
  client: Awaited<ReturnType<EditorSession['editorClient']>>,
  forUri: string,
  after: number,
): Promise<{ uri: string; items: unknown[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = client.notifications
      .slice(after)
      .find((n) => n.method === 'editor.diagnostics' && n.params.uri === forUri)
    if (found) return found.params
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no editor.diagnostics for ${forUri}`)
}

describe('diagnostics in layer 2 (design 848 §5.5)', () => {
  it('pushes editor.diagnostics on open, and get_diagnostics answers the same items', async () => {
    session = await startEditorSession(tmp)
    const editor = await session.editorClient()
    const before = editor.notifications.length
    editor.notify('editor.didOpen', {
      uri,
      version: 1,
      text: BROKEN,
      documentDirectory: '/ws/piece',
    })
    const pushed = await nextDiagnostics(editor, uri, before)
    expect(pushed.items).toEqual([
      { line: 1, character: 1, severity: 'error', message: 'Missing closing parenthesis' },
      {
        line: 2,
        character: 14,
        severity: 'warning',
        message: 'Tempo must be between 20 and 999 (got 5)',
      },
      {
        line: 2,
        character: 1,
        severity: 'warning',
        message:
          'Duplicate global.tempo(). Live coding pattern: edit the existing line instead of adding a new one.',
      },
    ])
    const llm = await session.agent()
    expect(await llm.call('editor.getDiagnostics', { path: '/ws/piece/a.orbs' })).toEqual({
      files: [{ path: '/ws/piece/a.orbs', diagnostics: pushed.items }],
    })
    expect(await llm.call('editor.getDiagnostics', {})).toEqual({
      files: [{ path: '/ws/piece/a.orbs', diagnostics: pushed.items }],
    })
  })

  it('re-publishes after a fixing change, and clears the markers of a closed document', async () => {
    session = await startEditorSession(tmp)
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text: BROKEN, documentDirectory: null })
    await nextDiagnostics(editor, uri, 0)
    const beforeFix = editor.notifications.length
    editor.notify('editor.didChange', {
      uri,
      version: 2,
      changes: [{ text: 'global.tempo(120)\n' }],
    })
    expect((await nextDiagnostics(editor, uri, beforeFix)).items).toEqual([])
    const beforeClose = editor.notifications.length
    editor.notify('editor.didClose', { uri })
    expect(await nextDiagnostics(editor, uri, beforeClose)).toEqual({ uri, items: [] })
  })

  it('get_diagnostics names an unknown path with no diagnostics, and lists only files that have some', async () => {
    session = await startEditorSession(tmp)
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', {
      uri: 'file:///ws/clean.orbs',
      version: 1,
      text: 'global.tempo(120)\n',
      documentDirectory: null,
    })
    editor.notify('editor.didOpen', { uri, version: 1, text: BROKEN, documentDirectory: null })
    await flush(editor)
    const llm = await session.agent()
    expect(await llm.call('editor.getDiagnostics', { path: '/ws/other.orbs' })).toEqual({
      files: [{ path: '/ws/other.orbs', diagnostics: [] }],
    })
    const all = (await llm.call('editor.getDiagnostics', {})) as { files: Array<{ path: string }> }
    expect(all.files.map((file) => file.path)).toEqual(['/ws/piece/a.orbs'])
  })

  it('without an editor, get_diagnostics answers empty rather than NO_EDITOR_ATTACHED (frozen tool contract)', async () => {
    session = await startEditorSession(tmp)
    const llm = await session.agent()
    expect(await llm.call('editor.getDiagnostics', {})).toEqual({ files: [] })
  })

  it('the MCP get_diagnostics tool through the relay returns the pushed items', async () => {
    session = await startEditorSession(tmp)
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text: BROKEN, documentDirectory: null })
    const pushed = await nextDiagnostics(editor, uri, 0)
    const socketPath = session.socketPath
    const call: SessionCall = async (method, params) => {
      const connection = await connectSession(socketPath, {
        client: { name: 'relay', version: '0' },
      })
      try {
        return await connection.call(method, params)
      } finally {
        connection.close()
      }
    }
    const mcp = await connectMcp(
      buildServer('0', createRpcToolHandlers(call), createRpcDocsSource(call)),
    )
    try {
      const result = await mcp.call('get_diagnostics', { path: '/ws/piece/a.orbs' })
      expect(JSON.parse(result.content[0]!.text)).toEqual([
        { path: '/ws/piece/a.orbs', diagnostics: pushed.items },
      ])
    } finally {
      await mcp.close()
    }
  })
})

describe('completion in layer 2 (design 848 §5.3.4)', () => {
  it('answers editor.complete from the synced copy, and nothing for a document that is not open', async () => {
    session = await startEditorSession(tmp)
    const editor = await session.editorClient()
    editor.notify('editor.didOpen', { uri, version: 1, text: 'global.', documentDirectory: null })
    await flush(editor)
    const result = (
      await editor.request('editor.complete', {
        uri,
        position: { line: 0, character: 7 },
      })
    ).result as { items: Array<{ label: string; kind?: string }> }
    expect(result.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(['tempo', 'start']),
    )
    expect(result.items.find((item) => item.label === 'tempo')?.kind).toBe('method')
    expect(
      (
        await editor.request('editor.complete', {
          uri: 'file:///ws/none.orbs',
          position: { line: 0, character: 0 },
        })
      ).result,
    ).toEqual({ items: [] })
  })
})
