/**
 * Claude Code MCP registration helpers (Register Claude Code MCP Server).
 *
 * Pure module: no vscode dependency, unit-testable. The palette command
 * `orbitscore.registerMcpServer` and the MCP `register_mcp_server` tool
 * (extension.ts) call these to compute the `.mcp.json` content (project scope)
 * and the server URL registered via the `claude` CLI (user scope).
 */

/** URL where the extension's MCP server listens (see startOrbitScoreMcpServer). */
export function buildMcpServerUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * Merge the orbitscore MCP server entry into `.mcp.json` content.
 *
 * @param existingContent Current file content, or null when the file does not
 *   exist (whitespace-only content is treated as absent).
 * @param port MCP server port to register.
 * @returns The new file content: `mcpServers.orbitscore` set to the HTTP
 *   entry, every other top-level key and server preserved, 2-space indent,
 *   trailing newline.
 * @throws Error (descriptive, no write-side effects) when the existing content
 *   is invalid JSON or structurally not an object — a corrupt config must
 *   never be silently overwritten.
 */
export function mergeMcpJson(existingContent: string | null, port: number): string {
  let config: Record<string, unknown> = {}
  if (existingContent !== null && existingContent.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingContent)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `.mcp.json contains invalid JSON (${reason}) — fix or remove the file, then retry`,
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        '.mcp.json must contain a JSON object at the top level — fix or remove the file, then retry',
      )
    }
    config = parsed as Record<string, unknown>
  }

  const servers = config.mcpServers
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    throw new Error(
      '.mcp.json has a non-object "mcpServers" value — fix or remove the file, then retry',
    )
  }
  const mcpServers = (servers as Record<string, unknown> | undefined) ?? {}
  mcpServers.orbitscore = { type: 'http', url: buildMcpServerUrl(port) }
  config.mcpServers = mcpServers

  return JSON.stringify(config, null, 2) + '\n'
}
