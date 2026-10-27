import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { registerProtocolSchemaKeywords } from '@orbitscore/protocol'

import { loadSessionSchema } from './session-schema'

type SchemaObject = Record<string, any>

const schema = loadSessionSchema() as unknown as SchemaObject
const ajv = registerProtocolSchemaKeywords(
  new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }),
)

function definition(name: string): ValidateFunction {
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `#/$defs/${name}`,
    $defs: schema.$defs,
  })
}

function pathsWithKeyword(keyword: string): string[] {
  const found: string[] = []
  const visit = (value: unknown, path: string[]): void => {
    if (value === null || typeof value !== 'object') return
    if (!Array.isArray(value) && keyword in value) found.push(path.join('.'))
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key])
  }
  visit(schema, [])
  return found
}

describe('session protocol v1 schema shapes', () => {
  it('is valid JSON Schema 2020-12 under the a2 Ajv strict settings', () => {
    expect(ajv.validateSchema(schema), ajv.errorsText(ajv.errors)).toBe(true)
    expect(() => ajv.compile(schema)).not.toThrow()
  })

  it('accepts only absolute document directories while preserving spaces and null', () => {
    const validate = definition('EvaluateParams')
    const params = (documentDirectory: string | null) => ({
      code: 'sin 440',
      documentDirectory,
      source: 'human',
    })

    for (const rejected of ['', 'relative/path', 'file:///x']) {
      expect(validate(params(rejected)), rejected).toBe(false)
    }
    expect(validate(params('/ws/ piece '))).toBe(true)
    expect(validate(params(null))).toBe(true)
  })

  it('distinguishes absolute paths from document URIs', () => {
    const absolutePath = definition('AbsolutePath')
    const documentUri = definition('DocumentUri')
    expect(absolutePath('/tmp/a')).toBe(true)
    expect(absolutePath('file:///tmp/a')).toBe(false)
    expect(documentUri('file:///tmp/a')).toBe(true)
    expect(documentUri('/tmp/a')).toBe(false)

    const active = definition('DidChangeActiveParams')
    expect(active({ uri: 'file:///tmp/a' })).toBe(true)
    expect(active({ uri: null })).toBe(true)
    expect(active({ uri: '/tmp/a' })).toBe(false)
  })

  it('validates both ready-line variants and couples port to token', () => {
    const ready = definition('ReadyLine')
    const token = 't'.repeat(32)
    expect(
      ready({
        ready: true,
        socket: '/tmp/session.sock',
        protocol_version: '1.0',
        port: null,
        token: null,
      }),
    ).toBe(true)
    expect(
      ready({
        ready: true,
        socket: '/tmp/session.sock',
        protocol_version: '1.0',
        port: 39123,
        token,
      }),
    ).toBe(true)
    expect(ready({ ready: false, error: { code: 'LISTEN_FAILED', message: 'busy' } })).toBe(true)
    expect(
      ready({
        ready: true,
        socket: '/tmp/session.sock',
        protocol_version: '1.0',
        port: null,
        token,
      }),
    ).toBe(false)
  })

  it('marks exactly the two token fields as secrets', () => {
    expect(pathsWithKeyword('x-secret')).toEqual([
      '$defs.ReadyLineOk.properties.token',
      '$defs.AttachParams.properties.token',
    ])
  })

  it('accepts range-and-version diagnostics and rejects the old point shape', () => {
    const diagnostics = definition('EditorDiagnosticsParams')
    const range = {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 6 },
    }
    expect(
      diagnostics({
        uri: 'file:///tmp/score.orbs',
        version: 7,
        items: [
          {
            range,
            severity: 'warning',
            message: 'deprecated form',
            code: 'old-form',
            source: 'orbitscore',
            tags: ['deprecated'],
          },
        ],
      }),
    ).toBe(true)
    expect(
      diagnostics({
        uri: 'file:///tmp/score.orbs',
        items: [{ line: 1, character: 3, severity: 'warning', message: 'old' }],
      }),
    ).toBe(false)

    expect(
      definition('GetDiagnosticsResult')({
        files: [{ uri: 'file:///tmp/score.orbs', version: 7, items: [] }],
      }),
    ).toBe(true)
  })

  it('rejects null request ids and batch envelopes', () => {
    const request = definition('JsonRpcRequest')
    expect(request({ jsonrpc: '2.0', id: 1, method: 'session.getState', params: {} })).toBe(true)
    expect(request({ jsonrpc: '2.0', id: null, method: 'session.getState', params: {} })).toBe(
      false,
    )
    expect(request([])).toBe(false)
  })
})
