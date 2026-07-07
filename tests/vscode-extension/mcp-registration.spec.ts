import { describe, it, expect } from 'vitest'

import {
  buildMcpServerUrl,
  mergeMcpJson,
} from '../../packages/vscode-extension/src/mcp-registration'

/**
 * Unit tests for the Claude Code MCP registration helpers behind the
 * "Register Claude Code MCP Server" command / register_mcp_server tool.
 * Pure module (no vscode, no fs) — exercised with literal file contents.
 */

describe('buildMcpServerUrl', () => {
  it('formats the loopback MCP URL for the given port', () => {
    expect(buildMcpServerUrl(39123)).toBe('http://127.0.0.1:39123/mcp')
    expect(buildMcpServerUrl(1)).toBe('http://127.0.0.1:1/mcp')
    expect(buildMcpServerUrl(65535)).toBe('http://127.0.0.1:65535/mcp')
  })
})

describe('mergeMcpJson', () => {
  const ORBITSCORE_ENTRY = { type: 'http', url: 'http://127.0.0.1:39123/mcp' }

  it('creates a fresh file with the orbitscore server when no file exists (null)', () => {
    const result = mergeMcpJson(null, 39123)

    expect(JSON.parse(result)).toEqual({ mcpServers: { orbitscore: ORBITSCORE_ENTRY } })
  })

  it('treats whitespace-only content as absent', () => {
    const result = mergeMcpJson('  \n\t\n', 39123)

    expect(JSON.parse(result)).toEqual({ mcpServers: { orbitscore: ORBITSCORE_ENTRY } })
  })

  it('preserves other servers and other top-level keys when adding orbitscore', () => {
    const existing = JSON.stringify({
      mcpServers: {
        serena: { type: 'stdio', command: 'uvx', args: ['serena'] },
      },
      somethingElse: { nested: true },
    })

    const result = mergeMcpJson(existing, 39123)

    expect(JSON.parse(result)).toEqual({
      mcpServers: {
        serena: { type: 'stdio', command: 'uvx', args: ['serena'] },
        orbitscore: ORBITSCORE_ENTRY,
      },
      somethingElse: { nested: true },
    })
  })

  it('updates an existing orbitscore entry in place (URL replaced, siblings kept)', () => {
    const existing = JSON.stringify({
      mcpServers: {
        orbitscore: { type: 'http', url: 'http://127.0.0.1:11111/mcp' },
        other: { type: 'http', url: 'http://example.invalid/mcp' },
      },
    })

    const result = mergeMcpJson(existing, 39123)

    expect(JSON.parse(result)).toEqual({
      mcpServers: {
        orbitscore: ORBITSCORE_ENTRY,
        other: { type: 'http', url: 'http://example.invalid/mcp' },
      },
    })
  })

  it('throws a descriptive error on invalid JSON instead of returning content', () => {
    expect(() => mergeMcpJson('{ not json', 39123)).toThrow(/invalid JSON/)
    expect(() => mergeMcpJson('{ not json', 39123)).toThrow(/\.mcp\.json/)
  })

  it('throws when the top level is not a JSON object', () => {
    expect(() => mergeMcpJson('[1, 2, 3]', 39123)).toThrow(/JSON object at the top level/)
    expect(() => mergeMcpJson('"a string"', 39123)).toThrow(/JSON object at the top level/)
    expect(() => mergeMcpJson('null', 39123)).toThrow(/JSON object at the top level/)
  })

  it('throws when mcpServers exists but is not an object', () => {
    expect(() => mergeMcpJson('{"mcpServers": []}', 39123)).toThrow(/non-object "mcpServers"/)
    expect(() => mergeMcpJson('{"mcpServers": "x"}', 39123)).toThrow(/non-object "mcpServers"/)
  })

  it('emits valid JSON with 2-space indent and a trailing newline', () => {
    const result = mergeMcpJson(null, 39123)

    expect(result.endsWith('\n')).toBe(true)
    expect(result.endsWith('\n\n')).toBe(false)
    // 2-space indent: exactly the canonical JSON.stringify(..., null, 2) form.
    expect(result).toBe(JSON.stringify(JSON.parse(result), null, 2) + '\n')
    expect(result).toContain('\n  "mcpServers": {\n    "orbitscore": {')
  })
})
