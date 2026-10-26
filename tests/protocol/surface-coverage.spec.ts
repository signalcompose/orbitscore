/**
 * D-4 特権経路ゼロ（設計 848 §1.2・§5.8）と、スキーマのメソッド一覧の形の検査。
 *
 * 🔴 D-4: **`gui` を持つメソッドで `mcp` を持たないものが 1 つでもあれば red**。GUI で出来て
 * LLM で出来ないことを構造的に作れないようにする（`NATIVE_MIGRATION_2026-09.md` §3「UI に特権的な
 * 経路を作らない」）。`editor`（文書の同期と、エディタに描く言語サービス）と `infra`（握手・寿命・
 * イベント）は操作ではないので D-4 の対象外 — 語彙の定義はスキーマの `x-surface-vocabulary`。
 */
import { describe, expect, it } from 'vitest'

import { FROZEN_MCP_TOOLS, loadSessionSchema } from './session-schema'

const schema = loadSessionSchema()
const methods = Object.entries(schema['x-methods'])
const vocabulary = Object.keys(schema['x-surface-vocabulary'])

describe('session protocol v1 — method catalog shape', () => {
  it('declares the protocol version 1.0', () => {
    expect(schema['x-protocol-version']).toBe('1.0')
  })

  it('every method names a direction, a kind and only known surfaces', () => {
    for (const [name, method] of methods) {
      expect(['client-to-server', 'server-to-client'], name).toContain(method.direction)
      expect(['request', 'notification'], name).toContain(method.kind)
      expect(method['x-surfaces'].length, `${name} has no x-surfaces`).toBeGreaterThan(0)
      for (const surface of method['x-surfaces']) expect(vocabulary, name).toContain(surface)
    }
  })

  it('every $ref in the catalog resolves to a $defs entry', () => {
    const refs: Array<[string, string]> = []
    for (const [name, method] of methods) {
      for (const ref of [method.params, method.result]) if (ref) refs.push([name, ref.$ref])
      const editor = method['x-editor-request']
      if (editor && editor !== 'same')
        refs.push([name, editor.params.$ref], [name, editor.result.$ref])
    }
    for (const [name, ref] of refs) {
      expect(ref, name).toMatch(/^#\/\$defs\//)
      expect(Object.keys(schema.$defs), `${name}: ${ref}`).toContain(ref.replace('#/$defs/', ''))
    }
  })

  it('requests have params and a result; notifications have params and no result', () => {
    for (const [name, method] of methods) {
      expect(method.params, name).toBeDefined()
      if (method.kind === 'request') expect(method.result, name).toBeDefined()
      else expect(method.result, name).toBeUndefined()
    }
  })

  it('server-to-client methods are notifications (the editor leg is x-editor-request)', () => {
    for (const [name, method] of methods) {
      if (method.direction === 'server-to-client') expect(method.kind, name).toBe('notification')
    }
  })

  it('error codes are unique and the application codes sit in the JSON-RPC server range', () => {
    const codes = Object.values(schema['x-errors'])
    expect(new Set(codes).size).toBe(codes.length)
    for (const [name, code] of Object.entries(schema['x-errors'])) {
      if (code > -32099 && code < -32000) continue
      expect([-32700, -32600, -32601, -32602, -32603], name).toContain(code)
    }
  })
})

describe('D-4 — no GUI-only path (design 848 §1.2)', () => {
  it('every method the GUI calls is also reachable from MCP', () => {
    const guiOnly = methods
      .filter(([, method]) => method['x-surfaces'].includes('gui'))
      .filter(([, method]) => !method['x-surfaces'].includes('mcp'))
      .map(([name]) => name)
    expect(guiOnly, 'GUI だけの近道（MCP から届かない GUI の操作）').toEqual([])
  })

  it('a method marked mcp names the MCP tools that use it, and only those methods do', () => {
    for (const [name, method] of methods) {
      const tools = method['x-mcp-tools'] ?? []
      if (method['x-surfaces'].includes('mcp')) {
        expect(tools.length, `${name} is mcp but lists no tool`).toBeGreaterThan(0)
      } else {
        expect(tools, `${name} lists tools but is not mcp`).toEqual([])
      }
    }
  })

  it('the MCP tools the catalog names are exactly the frozen 28', () => {
    const named = new Set(methods.flatMap(([, method]) => method['x-mcp-tools'] ?? []))
    expect([...named].sort()).toEqual([...FROZEN_MCP_TOOLS].sort())
  })

  it('the check goes red on a GUI-only method (the rule is not vacuous)', () => {
    const forged = [...methods, ['gui.secret', { 'x-surfaces': ['gui'] }] as const]
    const guiOnly = forged.filter(
      ([, method]) => method['x-surfaces'].includes('gui') && !method['x-surfaces'].includes('mcp'),
    )
    expect(guiOnly.map(([name]) => name)).toEqual(['gui.secret'])
  })
})
