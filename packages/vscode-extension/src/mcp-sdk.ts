/**
 * MCP SDK と `zod` のトップレベル require と、ツール結果の整形（#887 束 F・`mcp-server.ts` から移した）。
 *
 * 🔴 **ここの require は `activate()` より前に評価される。** 同梱漏れは
 * activation 全体を落とす（#873 で実測・`.vsix` が activate すらできなかった）。
 * `dist/` に出ないモジュールをここへ足してはいけない。
 */
import * as http from 'http'

import type { CommandResult } from './mcp-types'

/**
 * Runtime shims and shared result helpers for the MCP SDK tool registrars.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpServerLike {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): unknown
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

export interface TransportLike {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void>
  close(): Promise<void>
  sessionId?: string
  onclose?: () => void
}

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
export const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as {
  McpServer: new (info: { name: string; version: string }) => McpServerLike
}
export const { StreamableHTTPServerTransport } =
  require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
    StreamableHTTPServerTransport: new (opts: {
      sessionIdGenerator?: (() => string) | undefined
      enableJsonResponse?: boolean
      onsessioninitialized?: (sessionId: string) => void | Promise<void>
      onsessionclosed?: (sessionId: string) => void | Promise<void>
    }) => TransportLike
  }
/**
 * `zod` の最小型スタブ。ランタイムの zod はここに宣言されているより遥かに多くを持つが、
 * この拡張が実際に使う分だけを宣言してある。
 *
 * 🔴 **使う builder を増やしたらここも増やすこと。** 宣言漏れは `npm test` / `npm run lint` /
 * `npm run typecheck:e2e` のどれにも出ず、**`npm run build` だけが落ちる**
 * （#639 で `z.array(z.number().int())` を足した際に実際に踏んだ）。
 */
interface ZodTypeLike {
  describe(description: string): ZodTypeLike
  optional(): unknown
  int(): ZodTypeLike
  nonnegative(): ZodTypeLike
  length(exact: number): ZodTypeLike
}
export const { z } = require('zod') as {
  z: {
    string: () => ZodTypeLike
    number: () => ZodTypeLike
    boolean: () => ZodTypeLike
    array: (element: ZodTypeLike) => ZodTypeLike
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
/** The single error-envelope shape for every tool (change here, not per tool). */
export function errorResult(error: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${error}` }], isError: true }
}

/** Bridge MCP's canonical effect path to the compatibility-only UIH.5 index API. */
export function resolveMcpPluginUiIndex(args: {
  chain_path?: unknown
  index?: unknown
}): { ok: true; index: number } | { ok: false; error: string } {
  if (args.chain_path !== undefined) {
    const chainPath = args.chain_path
    if (
      !Array.isArray(chainPath) ||
      chainPath.length !== 1 ||
      !Number.isSafeInteger(chainPath[0]) ||
      Number(chainPath[0]) < 0 ||
      Number(chainPath[0]) >= Number.MAX_SAFE_INTEGER
    ) {
      return { ok: false, error: 'chain_path must contain exactly one non-negative integer' }
    }
    // Global still accepts UIH.5 indexes and is the sole index -> chainPath mapper.
    // MCP's spec-shaped path addresses effects directly, so bridge [n] to index n + 1.
    const indexFromChainPath = Number(chainPath[0]) + 1
    if (args.index !== undefined && args.index !== indexFromChainPath) {
      return {
        ok: false,
        error:
          `index ${String(args.index)} conflicts with chain_path ${JSON.stringify(chainPath)}; ` +
          `chain_path selects compatibility index ${indexFromChainPath}`,
      }
    }
    return { ok: true, index: indexFromChainPath }
  }
  const index = args.index
  if (!Number.isSafeInteger(index) || Number(index) < 0) {
    return {
      ok: false,
      error: 'a non-negative integer index is required when chain_path is absent',
    }
  }
  return { ok: true, index: Number(index) }
}

export function toToolResult(result: CommandResult): ToolResult {
  if (result.ok) {
    return { content: [{ type: 'text', text: result.message ?? 'ok' }] }
  }
  return errorResult(result.error)
}

export interface McpServerHandle {
  readonly port: number
  dispose(): Promise<void>
}
