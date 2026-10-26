/**
 * MCP ツールの v1 関門（設計 848 §6.1・台帳 P-03）。
 *
 * 中継が出す `tools/list`（名前・順序・input schema）を、**凍結版の MCP 層をこの中で組み立てた
 * `tools/list`** と比べる（凍結版 `startOrbitScoreMcpServer` に全 handler のスタブを渡す —
 * `tests/vscode-extension/mcp-server.spec.ts` と同じ組み立て。凍結版のコードがリポジトリに在る間は
 * fixture を作らない）。説明文（description）は比べない（LLM 向けの説明は良くしてよい）。
 *
 * 裁定による例外（v1 の間でも凍結版と違ってよい）は `MCP_V1_EXCEPTIONS` だけ。どちらも振る舞いの
 * 違いで、`tools/list` の形は凍結版と同じ。
 *
 * 🔴 関門を自動で外す: `apps/OrbitStudio/VERSION` が `MCP_V1_GATE_UNTIL`（第 1 リリースの版・R-app の
 * N4-a で入れる）を越えたら、比べる相手は凍結版から `tests/protocol/mcp-tools.snapshot.json` に替わる。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildServer } from '../../packages/session/src/mcp/build-server'
import {
  createRpcDocsSource,
  createRpcToolHandlers,
} from '../../packages/session/src/mcp/rpc-tool-handlers'
import {
  startOrbitScoreMcpServer,
  type McpServerHandle,
  type OrbitScoreToolHandlers,
} from '../../packages/vscode-extension/src/mcp-server'
import { connectMcp } from '../session/helpers/mcp-test-client'

/** 第 1 リリースの版。決まるまで null（関門はかかったまま）。 */
export const MCP_V1_GATE_UNTIL: string | null = null

/** 設計 §6.1 の「裁定による例外」の表と同じ一覧。 */
export const MCP_V1_EXCEPTIONS = [
  {
    tool: 'evaluate_orbitscore',
    difference:
      'document_path の改行禁止のエラー（3 文言）を返さず、改行を含む実在のパスを解決する（§5.3.1）',
    ruling: '裁定 1「拡張版の通信方式から来た制約は引き継がない」',
  },
  {
    tool: 'register_mcp_server',
    difference:
      '書くのは中継のスタブの stdio 登録。引数 {scope, port?} は同じ形で受け、port は使わずに応答で伝える（§6.3）',
    ruling: '裁定 4「中継を同梱して繋ぐ」',
  },
] as const

const repoRoot = path.resolve(__dirname, '../..')
const APP_VERSION_FILE = path.join(repoRoot, 'apps/OrbitStudio/VERSION')
const SNAPSHOT_FILE = path.join(__dirname, 'mcp-tools.snapshot.json')

/** `a.b.c` の大小（数値の部分だけを比べる）。 */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** 比べる相手: 凍結版（v1 の間）か、アプリのスナップショット（第 1 リリースの後）。 */
export function mcpGateMode(
  appVersion: string | null,
  gateUntil: string | null,
): 'frozen' | 'snapshot' {
  if (gateUntil === null || appVersion === null) return 'frozen'
  return compareVersions(appVersion.trim(), gateUntil) > 0 ? 'snapshot' : 'frozen'
}

interface ToolShape {
  name: string
  inputSchema: unknown
}

const shape = (tools: Array<{ name: string; inputSchema?: unknown }>): ToolShape[] =>
  tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))

/** 凍結版の拡張と同じく、任意の 5 本を含む全 handler（`extension.ts` は全部を持つ）。 */
function frozenStubHandlers(): OrbitScoreToolHandlers {
  const ok = () => ({ ok: true as const })
  return {
    evaluate: ok,
    startEngine: ok,
    stopEngine: ok,
    getEngineState: () => ({ running: false, liveCoding: false }),
    listAudioDevices: () => ({ ok: true, devices: [] }),
    selectAudioDevice: ok,
    configureFlash: () => ({
      ok: true,
      config: { count: 3, duration: 150, color: 'selection', customColor: '#ff6b6b' },
    }),
    openFile: ok,
    setSelection: ok,
    runSelection: ok,
    editReplace: ok,
    getEditorState: () => ({
      path: null,
      languageId: null,
      cursor: null,
      selection: null,
      lineCount: null,
      isDirty: null,
    }),
    saveFile: ok,
    getDocumentText: () => ({ path: null, text: null }),
    getDiagnostics: () => [],
    getLog: () => [],
    analyzeAudio: () => ({ ok: false, error: 'stub' }),
    listPlugins: () => ({ ok: true, plugins: [] }),
    rescanPlugins: () => ({ ok: false, error: 'stub' }),
    savePluginState: () => ({ ok: true, saved: {} }),
    openPluginUi: () => ({ ok: true, result: {} }),
    closePluginUi: () => ({ ok: true, result: {} }),
    openPluginUiAtCursor: () => ({ ok: false, error: 'stub' }),
    registerMcpServer: ok,
  }
}

function postJson(port: number, body: unknown, sessionId?: string) {
  return new Promise<{ json: any; sessionId?: string }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(payload.length),
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      },
      (response) => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (raw += chunk))
        response.on('end', () =>
          resolve({
            json: raw ? JSON.parse(raw) : undefined,
            sessionId: response.headers['mcp-session-id'] as string | undefined,
          }),
        )
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

async function frozenToolsList(): Promise<{ tools: ToolShape[]; handle: McpServerHandle }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    let handle: McpServerHandle
    try {
      handle = await startOrbitScoreMcpServer({
        port,
        version: '0.0.0-gate',
        handlers: frozenStubHandlers(),
        log: () => {},
      })
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
      throw error
    }
    const init = await postJson(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcp-v1-gate', version: '0' },
      },
    })
    await postJson(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId)
    const list = await postJson(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      init.sessionId,
    )
    return { tools: shape(list.json.result.tools), handle }
  }
  throw new Error(`no free port for the frozen MCP server: ${String(lastError)}`)
}

/** 中継が登録するもの（`relay-main.ts` と同じ `buildServer` + RPC ハンドラ）。上流は要らない（RL-2）。 */
async function relayToolsList(): Promise<ToolShape[]> {
  const unreachable = async () => {
    throw new Error('not connected')
  }
  const client = await connectMcp(
    buildServer('0.0.0-gate', createRpcToolHandlers(unreachable), createRpcDocsSource(unreachable)),
  )
  try {
    return shape(await client.listTools())
  } finally {
    await client.close()
  }
}

const appVersion = fs.existsSync(APP_VERSION_FILE)
  ? fs.readFileSync(APP_VERSION_FILE, 'utf8')
  : null
const mode = mcpGateMode(appVersion, MCP_V1_GATE_UNTIL)

let frozen: ToolShape[] = []
let relay: ToolShape[] = []
let frozenHandle: McpServerHandle | undefined

beforeAll(async () => {
  relay = await relayToolsList()
  if (mode === 'frozen') {
    const listed = await frozenToolsList()
    frozen = listed.tools
    frozenHandle = listed.handle
  }
})

afterAll(async () => {
  await frozenHandle?.dispose()
})

describe('MCP tools v1 gate (design 848 §6.1 / ledger P-03)', () => {
  it('switches from the frozen extension to the app snapshot only after the first release', () => {
    expect(mcpGateMode(null, null)).toBe('frozen')
    expect(mcpGateMode('0.1.0', null)).toBe('frozen')
    expect(mcpGateMode(null, '1.0.0')).toBe('frozen')
    expect(mcpGateMode('1.0.0', '1.0.0')).toBe('frozen')
    expect(mcpGateMode('1.0.1\n', '1.0.0')).toBe('snapshot')
    expect(mcpGateMode('1.1.0-dev', '1.0.0')).toBe('snapshot')
  })

  it.runIf(mode === 'frozen')(
    'lists the same 28 tools in the same order as the frozen extension',
    () => {
      expect(frozen.map((tool) => tool.name)).toHaveLength(28)
      expect(relay.map((tool) => tool.name)).toEqual(frozen.map((tool) => tool.name))
    },
  )

  it.runIf(mode === 'frozen')(
    'gives every tool the same input schema as the frozen extension',
    () => {
      for (const tool of frozen) {
        expect(
          relay.find((candidate) => candidate.name === tool.name)?.inputSchema,
          tool.name,
        ).toEqual(tool.inputSchema)
      }
    },
  )

  it('keeps the exceptions to the ruled two, both behavioural (the tool shape stays frozen)', () => {
    expect(MCP_V1_EXCEPTIONS.map((exception) => exception.tool)).toEqual([
      'evaluate_orbitscore',
      'register_mcp_server',
    ])
    for (const exception of MCP_V1_EXCEPTIONS) {
      expect(relay.map((tool) => tool.name)).toContain(exception.tool)
      expect(exception.difference.trim()).not.toBe('')
      expect(exception.ruling.trim()).not.toBe('')
    }
  })

  it.runIf(mode === 'snapshot')('matches the app snapshot after the first release', () => {
    expect(fs.existsSync(SNAPSHOT_FILE), `${SNAPSHOT_FILE} must exist after the v1 gate`).toBe(true)
    expect(relay).toEqual(JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')))
  })
})
