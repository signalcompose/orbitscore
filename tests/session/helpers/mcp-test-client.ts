/**
 * MCP サーバ（`buildServer` の戻り）に、SDK のクライアントを in-memory の transport で繋ぐ。
 * 中継の stdio と同じ JSON-RPC が流れる（HTTP の `/mcp` は v1 に無い・設計 848 §6）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { McpServerLike } from '../../../packages/session/src/mcp/mcp-sdk'

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpTestClient {
  client: Client
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: any }>>
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>
  close(): Promise<void>
}

export async function connectMcp(server: McpServerLike): Promise<McpTestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'mcp-test-client', version: '0.0.1' })
  await client.connect(clientTransport)
  return {
    client,
    listTools: async () => (await client.listTools()).tools as any,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
