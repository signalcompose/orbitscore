/**
 * `protocol/gen/` が正本のスキーマから生成し直したものと一致すること（設計 848 §5.8・`npm run protocol:check`）。
 *
 * 生成物をコミットするのは、Xcode / SwiftPM のビルドに Node を要求しないため。生成し忘れた
 * スキーマの変更は、ここで red になる。N0-b までは TS 側だけ（台帳 P-18）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadSessionSchema } from './session-schema'

const repoRoot = path.resolve(__dirname, '../..')

describe('protocol/gen is generated from protocol/session/v1 (protocol:check)', () => {
  it('has no stale generated file', async () => {
    const { staleOutputs } = await import('../../scripts/protocol/generate.mjs')
    expect(await staleOutputs(), 'npm run protocol:generate を回してコミットする').toEqual([])
  }, 30_000)

  it('the generated method tables list every method of the catalog', () => {
    const generated = fs.readFileSync(
      path.join(repoRoot, 'protocol/gen/ts/session/v1/session.d.ts'),
      'utf8',
    )
    for (const name of Object.keys(loadSessionSchema()['x-methods'])) {
      expect(generated, name).toContain(`'${name}':`)
    }
  })

  it('generates the error-name union and readonly numeric ErrorCodes table', () => {
    const generated = fs.readFileSync(
      path.join(repoRoot, 'protocol/gen/ts/session/v1/session.d.ts'),
      'utf8',
    )
    expect(generated).toContain('export type ErrorName =')
    expect(generated).toContain('export declare const ErrorCodes: {')
    for (const [name, code] of Object.entries(loadSessionSchema()['x-errors'])) {
      expect(generated).toContain(`readonly ${name}: ${code}`)
    }
  })

  it('does not invent numbered public type names for inline schema fragments', () => {
    const generated = fs.readFileSync(
      path.join(repoRoot, 'protocol/gen/ts/session/v1/session.d.ts'),
      'utf8',
    )
    expect(generated).not.toMatch(/^export (?:interface|type) \w+\d+\b/m)
  })

  it('has no differently named definitions with the same structure', () => {
    const definitions = loadSessionSchema().$defs
    const byStructure = new Map<string, string[]>()
    const withoutAnnotations = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutAnnotations)
      if (value === null || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'description' && !key.startsWith('x-'))
          .map(([key, child]) => [key, withoutAnnotations(child)]),
      )
    }

    for (const [name, definition] of Object.entries(definitions)) {
      const structure = JSON.stringify(withoutAnnotations(definition))
      const names = byStructure.get(structure) ?? []
      names.push(name)
      byStructure.set(structure, names)
    }

    expect([...byStructure.values()].filter((names) => names.length > 1)).toEqual([])
  })
})
