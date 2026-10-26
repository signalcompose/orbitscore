/**
 * MCP サーバを組み立てる（設計 848 §6）。凍結版 `mcp-server.ts` の `buildServer` と同じく
 * engine → editor → plugins → docs の順で登録する — **この順序が `tools/list` の順序**
 * （§6 の 28 本。理由は `mcp-tools-editor.ts` の `registerDocsTools` の doc）。
 *
 * 凍結版との違いは 2 つ:
 * - docs 系は層 2 の `docs.*` を読む（`DocsToolSource`）。凍結版は `__dirname` から在りかを探した
 * - handler が**投げた**失敗（層 2 に届かない・`NO_EDITOR_ATTACHED` など）を、凍結版の `errorResult`
 *   と同じ封筒（`isError: true`・`error: ` で始まる文）で返す。凍結版の handler は投げずに
 *   `{ ok: false, error }` を返していたので、その経路の応答はこの包みで変わらない
 */
import { errorResult, McpServer, type McpServerLike } from './mcp-sdk'
import { type DocsToolSource, registerDocsTools, registerEditorTools } from './mcp-tools-editor'
import { registerEngineTools } from './mcp-tools-engine'
import { registerPluginTools } from './mcp-tools-plugins'
import type { OrbitScoreToolHandlers } from './mcp-types'

export function buildServer(
  version: string,
  handlers: OrbitScoreToolHandlers,
  docs: DocsToolSource,
): McpServerLike {
  const server = new McpServer({ name: 'orbitscore', version })
  const registrar = withErrorEnvelope(server)
  registerEngineTools(registrar, handlers)
  registerEditorTools(registrar, handlers)
  registerPluginTools(registrar, handlers)
  registerDocsTools(registrar, handlers, docs)
  return server
}

function withErrorEnvelope(server: McpServerLike): McpServerLike {
  return {
    registerTool: (name, config, callback) =>
      server.registerTool(name, config, async (args) => {
        try {
          return await callback(args)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      }),
    connect: (transport) => server.connect(transport),
    close: () => server.close(),
  }
}
