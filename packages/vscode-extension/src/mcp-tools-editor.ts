import { readDevDoc, searchDevDocs } from './mcp-docs'
import { errorResult, type McpServerLike, toToolResult, z } from './mcp-sdk'
import type { OrbitScoreToolHandlers } from './mcp-types'

export function registerEditorTools(server: McpServerLike, handlers: OrbitScoreToolHandlers): void {
  server.registerTool(
    'open_file',
    {
      title: 'Open File',
      description:
        'Open a file in the editor (vscode.workspace.openTextDocument + ' +
        'showTextDocument). Required before set_selection, run_selection, ' +
        'edit_replace, or get_editor_state can target it.',
      inputSchema: {
        path: z.string().describe('Absolute or workspace-relative path to the file to open'),
      },
    },
    async (args) => {
      const filePath = typeof args.path === 'string' ? args.path : ''
      return toToolResult(await handlers.openFile(filePath))
    },
  )

  server.registerTool(
    'set_selection',
    {
      title: 'Set Selection',
      description:
        "Set the active editor's selection/cursor by line and character (1-based, " +
        'matching the editor gutter). Reveals the range. Omit end_line and end_char ' +
        'to collapse the selection to a cursor at the start position.',
      inputSchema: {
        start_line: z.number().describe('1-based start line'),
        start_char: z.number().describe('1-based start character (column). Default: 1').optional(),
        end_line: z
          .number()
          .describe(
            '1-based end line. Omit together with end_char to collapse to a cursor at start',
          )
          .optional(),
        end_char: z
          .number()
          .describe('1-based end character (column). Default: 1 when end_line is given')
          .optional(),
      },
    },
    async (args) => {
      const startLine = typeof args.start_line === 'number' ? args.start_line : NaN
      if (!Number.isFinite(startLine)) {
        return errorResult('start_line is required')
      }
      return toToolResult(
        handlers.setSelection({
          startLine,
          startChar: typeof args.start_char === 'number' ? args.start_char : undefined,
          endLine: typeof args.end_line === 'number' ? args.end_line : undefined,
          endChar: typeof args.end_char === 'number' ? args.end_char : undefined,
        }),
      )
    },
  )

  server.registerTool(
    'run_selection',
    {
      title: 'Run Selection',
      description:
        "Execute the active editor's current selection (or the subject-block under " +
        'the cursor) against the running engine — the real "Run Selection" command ' +
        '(Cmd+Enter), including subject-block collection, setDocumentDirectory ' +
        'injection, and the flash animation. The engine must already be running ' +
        '(start_engine) and the active editor must be an OrbitScore (.orbs) file.',
    },
    async () => toToolResult(await handlers.runSelection()),
  )

  server.registerTool(
    'edit_replace',
    {
      title: 'Edit Replace',
      description:
        'Literal (non-regex) find/replace in the active document. Replaces the ' +
        'first occurrence by default; pass all: true to replace every occurrence. ' +
        'Returns the number of occurrences replaced.',
      inputSchema: {
        find: z.string().describe('Literal text to search for'),
        replace: z.string().describe('Replacement text'),
        all: z
          .boolean()
          .describe('Replace every occurrence instead of only the first. Default: false')
          .optional(),
      },
    },
    async (args) => {
      const find = typeof args.find === 'string' ? args.find : ''
      const replace = typeof args.replace === 'string' ? args.replace : ''
      const all = args.all === true
      return toToolResult(await handlers.editReplace({ find, replace, all }))
    },
  )

  server.registerTool(
    'get_editor_state',
    {
      title: 'Get Editor State',
      description:
        'Report the active editor: file path, language, cursor position, selection ' +
        'range (all 1-based), line count, and dirty state. Fields are null when no ' +
        'editor is active.',
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(handlers.getEditorState()) }] }),
  )

  server.registerTool(
    'save_file',
    {
      title: 'Save File',
      description:
        'Save the active document to disk (document.save()). edit_replace only ' +
        'rewrites the in-memory editor buffer — it does not persist to disk (auto-save ' +
        'is off) — so use save_file to persist the state played during a live session ' +
        'or the result of an edit. A no-op (returns ok) when the document has no ' +
        'unsaved changes.',
    },
    async () => toToolResult(await handlers.saveFile()),
  )

  server.registerTool(
    'get_document_text',
    {
      title: 'Get Document Text',
      description:
        'Return the full text of the active document. get_editor_state only reports ' +
        'metadata (path, language, cursor, selection, line count, dirty state) — use ' +
        'get_document_text to confirm an edit_replace was applied or to diff the ' +
        'buffer against the file on disk. path and text are both null when no editor ' +
        'is active.',
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(handlers.getDocumentText()) }] }),
  )

  server.registerTool(
    'get_diagnostics',
    {
      title: 'Get Diagnostics',
      description:
        'Report OrbitScore diagnostics (errors/warnings) currently shown by the ' +
        'editor (vscode.languages.getDiagnostics) — computed by the same analyzers ' +
        'that run on open/edit, so no need to trigger an edit first. Pass path to ' +
        'scope to one file; omit to list every file that currently has diagnostics.',
      inputSchema: {
        path: z.string().describe('Absolute path to scope diagnostics to a single file').optional(),
      },
    },
    async (args) => {
      const filePath = typeof args.path === 'string' ? args.path : undefined
      return {
        content: [{ type: 'text', text: JSON.stringify(handlers.getDiagnostics(filePath)) }],
      }
    },
  )

  server.registerTool(
    'get_log',
    {
      title: 'Get Log',
      description:
        'Return the last N lines of the OrbitScore output channel (engine ' +
        'stdout/stderr, MCP session log, etc.) — the same content as "OrbitScore" ' +
        'in the Output panel. Default 50 lines, capped at the ring buffer capacity (1000). ' +
        'If more lines are requested than the buffer holds, the first returned line is an ' +
        'explicit "[get_log] truncated: ..." notice — the request is never silently shortened.',
      inputSchema: {
        lines: z
          .number()
          .describe('Number of trailing lines to return (default 50, capped at 1000)')
          .optional(),
      },
    },
    async (args) => {
      const lines = typeof args.lines === 'number' ? args.lines : undefined
      return { content: [{ type: 'text', text: handlers.getLog(lines).join('\n') }] }
    },
  )
}

/**
 * dev サイトのドキュメントを読む 3 本（#887 束 F・`mcp-server.ts` から移した）。
 *
 * 🔴 **`registerEditorTools` と分けてあるのは順序のためである。** MCP SDK の
 * `tools/list` は `Object.entries(this._registeredTools)` を返す = **登録順がそのまま
 * 一覧の順序**になる（`@modelcontextprotocol/sdk/dist/cjs/server/mcp.js` の
 * `setRequestHandler(ListToolsRequestSchema, ...)`）。分割前の `mcp-server.ts` では
 * この 3 本が **plugin 系 6 本より後ろ**（23-25 番）に登録されていたので、editor 系と
 * 同じ関数に入れたままにすると 17-19 番へ繰り上がり、**クライアントに見える並びが変わる**。
 *
 * `buildServer` は engine → editor → plugins → docs の順で呼ぶこと。
 * この 4 本の呼び出し順が、分割前の 25 本の順序を byte 単位で再現する唯一の並びである。
 */
export function registerDocsTools(
  server: McpServerLike,
  handlers: OrbitScoreToolHandlers,
  docsSourceRoot: string,
): void {
  server.registerTool(
    'get_dev_doc',
    {
      title: 'Get Dev Doc',
      description: 'Read a development-site Markdown document by its site-relative path.',
      inputSchema: {
        path: z.string().describe('Site-relative Markdown path, e.g. pipeline/text-to-ast.md'),
      },
    },
    async (args) => {
      const relativePath = typeof args.path === 'string' ? args.path : ''
      const content = readDevDoc(docsSourceRoot, relativePath)
      return content === null
        ? errorResult('development document not found')
        : { content: [{ type: 'text', text: content }] }
    },
  )

  server.registerTool(
    'search_dev_docs',
    {
      title: 'Search Dev Docs',
      description: 'Search development-site Markdown documents for a case-insensitive substring.',
      inputSchema: {
        query: z.string().describe('Text to search for'),
        limit: z.number().describe('Maximum matches to return (default 10)').optional(),
      },
    },
    async (args) => {
      const query = typeof args.query === 'string' ? args.query : ''
      const requestedLimit = typeof args.limit === 'number' ? args.limit : 10
      const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 10
      return {
        content: [
          { type: 'text', text: JSON.stringify(searchDevDocs(docsSourceRoot, query, limit)) },
        ],
      }
    },
  )

  // Optional handler (see OrbitScoreToolHandlers.registerMcpServer): the tool
  // only exists on hosts that can register themselves into Claude Code.
  const registerMcpServer = handlers.registerMcpServer?.bind(handlers)
  if (registerMcpServer) {
    server.registerTool(
      'register_mcp_server',
      {
        title: 'Register Claude Code MCP Server',
        description:
          'Register this OrbitScore MCP server into Claude Code — equivalent to the ' +
          '"Register Claude Code MCP Server" command. scope "project" merges an ' +
          'orbitscore entry into .mcp.json at the workspace root (shareable, ' +
          'per-repo); scope "user" registers for all projects by running ' +
          '`claude mcp add --transport http --scope user`. Omit port to register ' +
          'the port this server is currently running on.',
        inputSchema: {
          scope: z
            .string()
            .describe(
              'Registration scope: "project" (write .mcp.json in the workspace) or ' +
                '"user" (register for all projects via the claude CLI)',
            ),
          port: z
            .number()
            .describe("MCP server port to register. Default: this server's running port")
            .optional(),
        },
      },
      async (args) => {
        const scope = typeof args.scope === 'string' ? args.scope : ''
        const port = typeof args.port === 'number' ? args.port : undefined
        return toToolResult(await registerMcpServer({ scope, port }))
      },
    )
  }
}
