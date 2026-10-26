/**
 * `session.registerMcp`（設計 848 §6.3）の登録の形。`claude` CLI の呼び出しは差し替える
 * （計画 §7.1 の C-7「登録の形（`claude` CLI の呼び出しはテストで差し替え）」）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  mergeMcpServerEntry,
  registerMcp,
  type RegisterMcpDeps,
} from '../../packages/session/src/host/mcp-registration'

type ExecFile = NonNullable<RegisterMcpDeps['execFile']>

/** `which claude` と `claude mcp add` の答えを決める偽の execFile。 */
function fakeExecFile(answers: {
  which?: string | Error
  add?: { error?: Error; stdout?: string; stderr?: string }
}): { execFile: ExecFile; calls: Array<{ file: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = []
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    const options = rest.length === 2 ? (rest[0] as { cwd?: string }) : {}
    calls.push({ file, args, cwd: options.cwd })
    if (file === 'which') {
      const which = answers.which ?? '/usr/local/bin/claude\n'
      if (which instanceof Error) callback(which, '', '')
      else callback(null, which, '')
    } else {
      const add = answers.add ?? { stdout: 'Added stdio MCP server orbitstudio' }
      callback(add.error ?? null, add.stdout ?? '', add.stderr ?? '')
    }
    return undefined as never
  }) as unknown as ExecFile
  return { execFile, calls }
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('session.registerMcp — user scope (default, via the claude CLI)', () => {
  it('runs `claude mcp add --transport stdio --scope user orbitstudio -- <stub>` with no port or key', async () => {
    const { execFile, calls } = fakeExecFile({})
    const result = await registerMcp(
      { scope: 'user' },
      { workspaceRoot: '/ws', platform: 'darwin', homeDir: () => '/Users/me', execFile },
    )
    const stub = '/Users/me/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp'
    expect(calls).toEqual([
      { file: 'which', args: ['claude'], cwd: undefined },
      {
        file: '/usr/local/bin/claude',
        args: ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'orbitstudio', '--', stub],
        cwd: '/ws',
      },
    ])
    expect(result).toEqual({
      ok: true,
      message: `ran \`claude mcp add --transport stdio --scope user orbitstudio -- ${stub}\` → Added stdio MCP server orbitstudio`,
    })
  })

  it('says the port is accepted but not used instead of dropping it silently (§6.1)', async () => {
    const { execFile } = fakeExecFile({})
    const result = await registerMcp(
      { scope: 'user', port: 39123 },
      { workspaceRoot: null, platform: 'linux', homeDir: () => '/home/me', execFile },
    )
    expect(result.ok && result.message).toMatch(
      /\(port 39123 is not used: the relay finds the running session by its socket\)$/,
    )
  })

  it('reports a missing claude CLI with the frozen guidance', async () => {
    const { execFile, calls } = fakeExecFile({ which: new Error('not found') })
    expect(await registerMcp({ scope: 'user' }, { workspaceRoot: null, execFile })).toEqual({
      ok: false,
      error:
        'claude CLI not found on PATH — install the Claude Code CLI, or use Project scope (.mcp.json) instead',
    })
    expect(calls).toHaveLength(1)
  })

  it('turns "already exists" into the remove-then-retry guidance, and other failures into the CLI output', async () => {
    const exists = fakeExecFile({
      add: { error: new Error('exit 1'), stderr: 'MCP server orbitstudio already exists' },
    })
    const duplicate = await registerMcp(
      { scope: 'user' },
      { workspaceRoot: null, execFile: exists.execFile },
    )
    expect(duplicate.ok).toBe(false)
    expect(!duplicate.ok && duplicate.error).toMatch(
      /^an MCP server named "orbitstudio" is already registered — run `claude mcp remove orbitstudio` first/,
    )
    const broken = fakeExecFile({ add: { error: new Error('exit 2'), stderr: 'boom' } })
    expect(
      await registerMcp({ scope: 'user' }, { workspaceRoot: null, execFile: broken.execFile }),
    ).toEqual({ ok: false, error: 'claude mcp add failed: boom' })
  })
})

describe('session.registerMcp — project scope (.mcp.json)', () => {
  it('writes the ${HOME} stub entry and keeps every other server (the frozen orbitscore row stays)', async () => {
    const mcpJson = path.join(tmp, '.mcp.json')
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: { orbitscore: { type: 'http', url: 'http://127.0.0.1:39123/mcp' } },
        other: 1,
      }),
    )
    const result = await registerMcp(
      { scope: 'project' },
      { workspaceRoot: tmp, platform: 'darwin' },
    )
    const command = '${HOME}/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp'
    expect(result).toEqual({
      ok: true,
      message: `registered orbitstudio (stdio: ${command}) in ${mcpJson}`,
    })
    expect(JSON.parse(fs.readFileSync(mcpJson, 'utf8'))).toEqual({
      mcpServers: {
        orbitscore: { type: 'http', url: 'http://127.0.0.1:39123/mcp' },
        orbitstudio: { type: 'stdio', command, args: [] },
      },
      other: 1,
    })
  })

  it('never overwrites a corrupt .mcp.json', async () => {
    const mcpJson = path.join(tmp, '.mcp.json')
    fs.writeFileSync(mcpJson, '{ not json')
    const result = await registerMcp({ scope: 'project' }, { workspaceRoot: tmp })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(/^\.mcp\.json contains invalid JSON/)
    expect(fs.readFileSync(mcpJson, 'utf8')).toBe('{ not json')
  })

  it('needs a workspace, and rejects an unknown scope', async () => {
    expect(await registerMcp({ scope: 'project' }, { workspaceRoot: null })).toEqual({
      ok: false,
      error: 'no workspace folder open — project scope writes .mcp.json into the workspace root',
    })
    expect(await registerMcp({ scope: 'global' }, { workspaceRoot: tmp })).toEqual({
      ok: false,
      error: `scope must be 'project' or 'user' (got "global")`,
    })
  })

  it.each([
    ['[]', '.mcp.json must contain a JSON object at the top level'],
    ['{"mcpServers": []}', '.mcp.json has a non-object "mcpServers" value'],
  ])('mergeMcpServerEntry refuses %s', (content, message) => {
    expect(() => mergeMcpServerEntry(content, 'orbitstudio', {})).toThrow(message)
  })
})
