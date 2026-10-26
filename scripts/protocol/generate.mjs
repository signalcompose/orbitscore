#!/usr/bin/env node
/**
 * protocol/session/v1/*.schema.json（正本）から protocol/gen/ts/ の型を作る（設計 848 §5.8）。
 *
 *   node scripts/protocol/generate.mjs           生成して書き込む（npm run protocol:generate）
 *   node scripts/protocol/generate.mjs --check   生成し直して差分ゼロを検査する（npm run protocol:check）
 *
 * 生成物はコミットする（Xcode / SwiftPM のビルドに Node を要求しないため）。`npm test` の
 * `tests/protocol/generated-types.spec.ts` も同じ `generateAll()` で差分ゼロを確かめる。
 *
 * PROVISIONAL(P-18): 生成して検査するのは TS 側だけ。Swift 側（protocol/gen/swift/）の生成ツールは
 * N0-b（手元の spike）で決める。決まったら同じ `generateAll()` に Swift の出力を足し、ここの印と
 * 台帳の P-18 を閉じる。生成ツールが TS 側も別のものに決まったら、同じ PR で差し替える。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compile } from 'json-schema-to-typescript'
import prettier from 'prettier'

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../..')
const SCHEMA_DIR = path.join(repoRoot, 'protocol/session/v1')
const TS_OUT_DIR = path.join(repoRoot, 'protocol/gen/ts/session/v1')

const BANNER = (source) =>
  [
    '/**',
    ` * Generated from protocol/session/v1/${source} by scripts/protocol/generate.mjs — do not edit.`,
    ' * Regenerate with `npm run protocol:generate`; `npm run protocol:check` verifies it is up to date.',
    ' *',
    ' * Licensed under the Apache License, Version 2.0 (protocol/LICENSE).',
    ' */',
  ].join('\n')

/** スキーマの `x-methods` を、メソッド名 → 型の対応表（型だけ）にする。 */
function methodTables(schema) {
  const typeOf = (ref) => {
    if (!ref || typeof ref.$ref !== 'string') return 'never'
    return ref.$ref.replace('#/$defs/', '')
  }
  const tables = {
    ClientRequests: [],
    ClientNotifications: [],
    ServerNotifications: [],
    EditorRequests: [],
  }
  for (const [name, method] of Object.entries(schema['x-methods'] ?? {})) {
    const key = JSON.stringify(name)
    if (method.direction === 'client-to-server' && method.kind === 'request') {
      tables.ClientRequests.push(
        `  ${key}: { params: ${typeOf(method.params)}; result: ${typeOf(method.result)} }`,
      )
      const editor = method['x-editor-request']
      if (editor === 'same') {
        tables.EditorRequests.push(
          `  ${key}: { params: ${typeOf(method.params)}; result: ${typeOf(method.result)} }`,
        )
      } else if (editor) {
        tables.EditorRequests.push(
          `  ${key}: { params: ${typeOf(editor.params)}; result: ${typeOf(editor.result)} }`,
        )
      }
    } else if (method.direction === 'client-to-server' && method.kind === 'notification') {
      tables.ClientNotifications.push(`  ${key}: ${typeOf(method.params)}`)
    } else if (method.direction === 'server-to-client' && method.kind === 'notification') {
      tables.ServerNotifications.push(`  ${key}: ${typeOf(method.params)}`)
    } else {
      throw new Error(`x-methods.${name}: unsupported direction/kind ${method.direction}/${method.kind}`)
    }
  }
  const doc = {
    ClientRequests: 'Requests any attached client sends to layer 2 (method name → params / result).',
    ClientNotifications: 'Notifications the editor client sends to layer 2.',
    ServerNotifications: 'Notifications layer 2 sends to clients.',
    EditorRequests:
      'Requests layer 2 sends to the attached editor client (the x-editor-request leg of a client request).',
  }
  return Object.entries(tables)
    .map(([table, rows]) => `/** ${doc[table]} */\nexport interface ${table} {\n${rows.join('\n')}\n}`)
    .join('\n\n')
}

/** スキーマ 1 本 → TS の宣言ファイル 1 本。 */
async function generateTs(file) {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'))
  // `x-` で始まる拡張キーは型の生成に渡さない（`x-methods` は下で対応表にする）。
  const forCompile = Object.fromEntries(Object.entries(schema).filter(([key]) => !key.startsWith('x-')))
  const types = await compile(forCompile, schema.title, {
    bannerComment: '',
    unreachableDefinitions: true,
    additionalProperties: false,
    strictIndexSignatures: true,
    format: false,
    declareExternallyReferenced: true,
  })
  const version = schema['x-protocol-version']
  const body = [
    BANNER(file),
    '',
    `/** The protocol version these types describe (x-protocol-version). */`,
    `export type ProtocolVersionLiteral = ${JSON.stringify(version)}`,
    '',
    types,
    '',
    methodTables(schema),
    '',
  ].join('\n')
  const config = (await prettier.resolveConfig(path.join(TS_OUT_DIR, 'x.ts'))) ?? {}
  const formatted = await prettier.format(body, { ...config, parser: 'typescript' })
  return { path: path.join(TS_OUT_DIR, file.replace(/\.schema\.json$/, '.d.ts')), content: formatted }
}

/** 生成物の全部（パスと中身）。書き込まない。 */
export async function generateAll() {
  const files = fs
    .readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
  return Promise.all(files.map(generateTs))
}

/** 生成物と、コミットされている中身の差（無ければ空）。 */
export async function staleOutputs() {
  const outputs = await generateAll()
  const expected = new Set(outputs.map((output) => output.path))
  const stale = outputs
    .filter((output) => !fs.existsSync(output.path) || fs.readFileSync(output.path, 'utf8') !== output.content)
    .map((output) => path.relative(repoRoot, output.path))
  // 正本が消えたのに残っている生成物も差として数える。
  if (fs.existsSync(TS_OUT_DIR)) {
    for (const name of fs.readdirSync(TS_OUT_DIR)) {
      const full = path.join(TS_OUT_DIR, name)
      if (name.endsWith('.d.ts') && !expected.has(full)) stale.push(path.relative(repoRoot, full))
    }
  }
  return stale
}

async function main() {
  if (process.argv.includes('--check')) {
    const stale = await staleOutputs()
    if (stale.length > 0) {
      console.error(
        `protocol:check: generated files are out of date (run npm run protocol:generate):\n  ${stale.join('\n  ')}`,
      )
      process.exit(1)
    }
    console.log('protocol:check: generated files are up to date (TS only until N0-b · ledger P-18)')
    return
  }
  fs.mkdirSync(TS_OUT_DIR, { recursive: true })
  for (const output of await generateAll()) {
    fs.writeFileSync(output.path, output.content)
    console.log(`wrote ${path.relative(repoRoot, output.path)}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
