/**
 * document 同期（設計 848 §5.4・§5.5）を本物の RPC サーバで確かめる: エディタのクライアントが
 * `editor.did*` を送り、別のクライアント（LLM 側）が同期済みの写しを読む。
 *
 * IM.6 の第 2 候補（アクティブな `.orbs`）が `editor.didChangeActive` に従うことも、中継と同じ
 * RPC ハンドラ + `buildServer` を通して確かめる（計画 §7.1 の C-11 の完了条件）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildServer } from '../../packages/session/src/mcp/build-server'
import {
  createRpcDocsSource,
  createRpcToolHandlers,
  type SessionCall,
} from '../../packages/session/src/mcp/rpc-tool-handlers'
import { connectSession } from '../../packages/session/src/rpc/client'

import { flush, startEditorSession, type EditorSession } from './helpers/editor-session'
import { connectMcp, type McpTestClient } from './helpers/mcp-test-client'
import { RpcTestClient } from './helpers/rpc-test-client'

let tmp: string
let session: EditorSession | null
let core: EditorSession['core'] | null
let socketPath: string

async function startSession(workspaceRoot: string | null = null): Promise<void> {
  session = await startEditorSession(tmp, workspaceRoot)
  core = session.core
  socketPath = session.socketPath
}

const editorClient = () => session!.editorClient()
const agent = () => session!.agent()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-edsync-'))
  session = null
  core = null
})

afterEach(async () => {
  await session?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('document sync (design 848 §5.5)', () => {
  it('answers editor.getState / getDocumentText from the synced copy, with 1-based positions', async () => {
    await startSession()
    const editor = await editorClient()
    const uri = 'file:///ws/piece/a.orbs'
    editor.notify('editor.didOpen', {
      uri,
      version: 1,
      text: 'global.tempo(120)\n',
      documentDirectory: '/ws/piece',
    })
    editor.notify('editor.didChange', {
      uri,
      version: 2,
      changes: [
        {
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
          text: '90',
        },
      ],
    })
    editor.notify('editor.didChangeSelection', {
      uri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
    })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)

    const llm = await agent()
    expect(await llm.call('editor.getState')).toEqual({
      path: '/ws/piece/a.orbs',
      languageId: 'orbitscore',
      cursor: { line: 1, character: 7 },
      selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 7 } },
      lineCount: 2,
      isDirty: true,
    })
    expect(await llm.call('editor.getDocumentText')).toEqual({
      path: '/ws/piece/a.orbs',
      text: 'global.tempo(90)\n',
    })
    expect(await llm.call('session.getState')).toMatchObject({
      documents: [{ uri, version: 2 }],
      activeUri: uri,
      editorAttached: true,
    })
  })

  it('answers all-null fields when the editor has no active document (frozen get_editor_state)', async () => {
    await startSession()
    await editorClient()
    const llm = await agent()
    expect(await llm.call('editor.getState')).toEqual({
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    })
    expect(await llm.call('editor.getDocumentText')).toEqual({ path: null, text: null })
  })

  it('is NO_EDITOR_ATTACHED without an editor client (D-3)', async () => {
    await startSession()
    const llm = await agent()
    await expect(llm.call('editor.getState')).rejects.toMatchObject({
      errorName: 'NO_EDITOR_ATTACHED',
      code: -32012,
    })
    await expect(llm.call('editor.getDocumentText')).rejects.toMatchObject({
      errorName: 'NO_EDITOR_ATTACHED',
    })
  })

  it('ignores editor.did* from a client without the editor capability, and says so', async () => {
    await startSession()
    await editorClient()
    const observer = await RpcTestClient.uds(socketPath)
    await observer.attach()
    observer.notify('editor.didOpen', {
      uri: 'file:///ws/x.orbs',
      version: 1,
      text: 'x',
      documentDirectory: null,
    })
    await flush(observer)
    expect(core!.documents.list()).toEqual([])
    const log = (await observer.request('session.getLog', { lines: 5 })).result as {
      lines: string[]
    }
    expect(log.lines.join('\n')).toContain(
      'editor.didOpen from a client without the editor capability',
    )
    observer.close()
  })

  it('forgets the documents when the editor client leaves, and takes them back when it re-sends (F-12)', async () => {
    await startSession()
    const first = await editorClient()
    const uri = 'file:///ws/a.orbs'
    first.notify('editor.didOpen', { uri, version: 4, text: 'kick', documentDirectory: '/ws' })
    first.notify('editor.didChangeActive', { uri })
    await flush(first)
    first.close()
    await first.closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(core!.documents.list()).toEqual([])
    expect(core!.documents.activeUriValue).toBeNull()

    // 再接続したエディタは開いている document をすべて送り直す（§5.5 の F-12 の規則）。
    const second = await editorClient()
    second.notify('editor.didOpen', { uri, version: 4, text: 'kick', documentDirectory: '/ws' })
    second.notify('editor.didChangeActive', { uri })
    await flush(second)
    const llm = await agent()
    expect(await llm.call('session.getState')).toMatchObject({
      documents: [{ uri, version: 4 }],
      activeUri: uri,
    })
  })
})

describe('IM.6 second candidate follows editor.didChangeActive (design 848 §5.3.1)', () => {
  let mcp: McpTestClient | null = null
  afterEach(async () => {
    await mcp?.close()
    mcp = null
  })

  async function relayTools(): Promise<{ mcp: McpTestClient; evaluated: unknown[] }> {
    const evaluated: unknown[] = []
    const call: SessionCall = async (method, params) => {
      const connection = await connectSession(socketPath, {
        client: { name: 'relay', version: '0' },
      })
      try {
        if (method === 'session.evaluate') evaluated.push(params)
        return await connection.call(method, params)
      } finally {
        connection.close()
      }
    }
    mcp = await connectMcp(buildServer('0', createRpcToolHandlers(call), createRpcDocsSource(call)))
    return { mcp, evaluated }
  }

  it('uses the active .orbs file, falls back to the workspace when it changes to an untitled document', async () => {
    const piece = path.join(tmp, 'piece')
    fs.mkdirSync(piece)
    const file = path.join(piece, 'a.orbs')
    fs.writeFileSync(file, '')
    await startSession(tmp)
    const editor = await editorClient()
    const uri = pathToFileURL(file).href
    editor.notify('editor.didOpen', { uri, version: 1, text: '', documentDirectory: piece })
    editor.notify('editor.didChangeActive', { uri })
    await flush(editor)

    const { mcp: client } = await relayTools()
    expect((await client.call('start_engine')).content[0]!.text).toBe('engine started')
    expect(
      (await client.call('evaluate_orbitscore', { code: 'global.tempo(100)' })).content[0]!.text,
    ).toBe(`ok (documentDirectory: ${piece})`)

    editor.notify('editor.didOpen', {
      uri: 'untitled:Untitled-1',
      version: 1,
      text: '',
      documentDirectory: null,
    })
    editor.notify('editor.didChangeActive', { uri: 'untitled:Untitled-1' })
    await flush(editor)
    expect(
      (await client.call('evaluate_orbitscore', { code: 'global.tempo(100)' })).content[0]!.text,
    ).toBe(`ok (documentDirectory: ${tmp})`)

    editor.notify('editor.didChangeActive', { uri: null })
    await flush(editor)
    expect((await client.call('get_editor_state')).content[0]!.text).toBe(
      JSON.stringify({
        path: null,
        languageId: null,
        cursor: null,
        selection: null,
        lineCount: null,
        isDirty: null,
      }),
    )
  })

  it('get_editor_state answers NO_EDITOR_ATTACHED through the relay when no editor is attached', async () => {
    await startSession(tmp)
    const { mcp: client } = await relayTools()
    const result = await client.call('get_editor_state')
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/^error: no editor is attached to this session/)
  })
})
