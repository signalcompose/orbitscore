/**
 * エディタの同期を確かめる spec の共通の準備: 偽の interpreter の層 2 を、`session-main.ts` と同じ
 * 配線（通知・クライアントが離れた時）で本物の RPC サーバに載せる。
 */
import path from 'node:path'

import { expect } from 'vitest'

import { EngineHost, type EngineInterpreter } from '../../../packages/session/src/host/engine-host'
import { SessionCore } from '../../../packages/session/src/host/session-core'
import { connectSession, type SessionConnection } from '../../../packages/session/src/rpc/client'
import {
  claimSocketPath,
  prepareRuntimeDir,
  resolveSocketPath,
} from '../../../packages/session/src/rpc/runtime-dir'
import { startRpcServer, type RpcServer } from '../../../packages/session/src/rpc/server'

import { fakeExecuteStatements, type FakeExecuteOptions } from './fake-execute-statements'
import { RpcTestClient } from './rpc-test-client'

export interface EditorSession {
  core: SessionCore
  server: RpcServer
  socketPath: string
  editorClient(): Promise<RpcTestClient>
  agent(): Promise<SessionConnection>
  close(): Promise<void>
}

export interface EditorSessionOptions {
  /** 偽の interpreter が文を 1 つ実行する時（文の文字列と options を見る）。 */
  onExecute?(text: string, options: FakeExecuteOptions): void
  /** 偽の interpreter の `openPluginUi`（`plugin.openUi` / `openUiAtCursor` が呼ぶ）。 */
  openPluginUi?(receiver: string, index: number, expectedName?: string): Promise<unknown>
  editorRequestTimeoutMs?: number
}

export async function startEditorSession(
  tmp: string,
  workspaceRoot: string | null = null,
  options: EditorSessionOptions = {},
): Promise<EditorSession> {
  const interpreter = {
    boot: async () => {},
    executeStatements: fakeExecuteStatements((text, executeOptions) =>
      options.onExecute?.(text, executeOptions),
    ),
    openPluginUi: (receiver: string, index: number, expectedName?: string) =>
      (options.openPluginUi ?? (async () => ({})))(receiver, index, expectedName),
    getGlobals: () => [{ stop: () => {}, saveAllPluginStates: async () => ({}) }],
    audioEngine: { quit: async () => {}, getDaemonStatus: async () => ({}) },
  } as unknown as EngineInterpreter
  const dir = path.join(tmp, 'run')
  prepareRuntimeDir(dir)
  const socket = resolveSocketPath(dir)
  if (!socket.ok) throw new Error(socket.reason)
  await claimSocketPath(socket.socketPath)
  const socketPath = socket.socketPath
  let core: SessionCore | null = null
  let rpc: RpcServer | null = null
  const host = new EngineHost({
    createInterpreter: () => interpreter,
    env: {},
    sessionLogCwd: tmp,
    sessionLogEnabled: false,
    log: (level, text) => core?.sessionLog(level, text),
  })
  core = new SessionCore({
    engine: host,
    workspaceRoot,
    broadcast: (method, params) => rpc?.broadcast(method, params),
    editorAttached: () => rpc?.editorClient() != null,
    requestEditor: (method, params) => rpc!.requestEditor(method, params),
    captureConsole: false,
  })
  const session = core
  rpc = await startRpcServer({
    socketPath,
    sessionVersion: 'test',
    handlers: session.handlers,
    notificationHandlers: session.notificationHandlers,
    onDetach: (client) => session.onClientDetached(client),
    log: (level, text) => session.sessionLog(level, text),
    editorRequestTimeoutMs: options.editorRequestTimeoutMs,
  })
  const server = rpc
  const closers: Array<() => unknown> = []
  return {
    core: session,
    server,
    socketPath,
    async editorClient() {
      const client = await RpcTestClient.uds(socketPath)
      expect((await client.attach({ capabilities: ['editor'] })).result).toBeDefined()
      closers.push(() => client.close())
      return client
    },
    async agent() {
      const connection = await connectSession(socketPath, {
        client: { name: 'agent', version: '0' },
      })
      closers.push(() => connection.close())
      return connection
    },
    async close() {
      for (const close of closers.splice(0)) await close()
      session.dispose()
      await server.close()
    },
  }
}

/** 通知は答えが無いので、同じ接続の往復で「届いた後」を作る。 */
export async function flush(client: RpcTestClient): Promise<void> {
  await client.request('session.getLog', { lines: 1 })
}
