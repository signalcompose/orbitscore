import { describe, expect, it, vi } from 'vitest'

import type { McpServerLike, ToolResult } from '../../packages/vscode-extension/src/mcp-sdk'
import { registerPluginTools } from '../../packages/vscode-extension/src/mcp-tools-plugins'
import type { OrbitScoreToolHandlers } from '../../packages/vscode-extension/src/mcp-types'

interface RegisteredTool {
  name: string
  config: { inputSchema?: Record<string, unknown> }
  callback: (args: Record<string, unknown>) => Promise<ToolResult>
}

function fakeServer(): { server: McpServerLike; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = []
  return {
    tools,
    server: {
      registerTool: (name, config, callback) => tools.push({ name, config, callback }),
      connect: async () => {},
      close: async () => {},
    },
  }
}

function pluginHandlers(overrides: Partial<OrbitScoreToolHandlers>): OrbitScoreToolHandlers {
  return {
    analyzeAudio: () => ({ ok: false, error: 'unused' }),
    listPlugins: () => ({ ok: true, plugins: [] }),
    rescanPlugins: () => ({ ok: false, error: 'unused' }),
    ...overrides,
  } as OrbitScoreToolHandlers
}

describe('registerPluginTools cursor UI registration', () => {
  it('places the argument-free cursor tool directly after open/close and forwards its result', async () => {
    const { server, tools } = fakeServer()
    const cursorResult = {
      ok: true as const,
      receiver: 'drums',
      index: 3,
      chain_path: [2],
      normalizedName: 'Echo',
      site: { line: 1, startCol: 17, endCol: 23 },
    }
    const openPluginUiAtCursor = vi.fn().mockResolvedValue(cursorResult)
    registerPluginTools(
      server,
      pluginHandlers({
        openPluginUi: vi.fn(),
        closePluginUi: vi.fn(),
        openPluginUiAtCursor,
      }),
    )

    expect(tools.slice(0, 3).map((tool) => tool.name)).toEqual([
      'open_plugin_ui',
      'close_plugin_ui',
      'open_plugin_ui_at_cursor',
    ])
    const cursorTool = tools[2]!
    expect(cursorTool.config.inputSchema).toEqual({})
    const response = await cursorTool.callback({})
    expect(response.isError).toBeFalsy()
    expect(JSON.parse(response.content[0]!.text)).toEqual(cursorResult)
    expect(openPluginUiAtCursor).toHaveBeenCalledOnce()
  })

  it('registers none of the UI trio when the cursor handler is missing', () => {
    const { server, tools } = fakeServer()
    registerPluginTools(server, pluginHandlers({ openPluginUi: vi.fn(), closePluginUi: vi.fn() }))

    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['open_plugin_ui', 'close_plugin_ui', 'open_plugin_ui_at_cursor']),
    )
  })

  it('uses the shared loud MCP error envelope', async () => {
    const { server, tools } = fakeServer()
    registerPluginTools(
      server,
      pluginHandlers({
        openPluginUi: vi.fn(),
        closePluginUi: vi.fn(),
        openPluginUiAtCursor: () => ({ ok: false, error: 'not on a plugin name' }),
      }),
    )

    const response = await tools[2]!.callback({})
    expect(response).toEqual({
      content: [{ type: 'text', text: 'error: not on a plugin name' }],
      isError: true,
    })
  })
})
