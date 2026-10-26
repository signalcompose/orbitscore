/**
 * 層 2 の言語サービスが凍結版と同じ答えを出すこと（設計 848 §5.3.4・§5.5・計画 §7.1 の C-11）。
 *
 * 凍結版の本体（`packages/vscode-extension/src/diagnostics-provider.ts` の `updateDiagnostics` と
 * `dsl-providers.ts` の 3 つの補完 provider）を vitest の `vscode` の mock で走らせ、層 2
 * （同じコードの写しを `vscode-shim` で走らせる `LanguageServices`）と同じ文書・同じ位置で比べる。
 *
 * mock が持たない `workspace.findFiles` / `workspace.fs` を使う補完（`import` のパスと名前）は比べられない
 * ので、層 2 の側だけを `language-services.spec` 相当の節で確かめる。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vscodeMock from 'vscode'

import { DocumentStore, type SyncedDocument } from '../../packages/session/src/host/document-store'
import { LanguageServices } from '../../packages/session/src/language/language-services'
import { clearPluginCatalogCache as clearSessionCatalog } from '../../packages/session/src/plugin-catalog-reader'
import { updateDiagnostics as frozenUpdateDiagnostics } from '../../packages/vscode-extension/src/diagnostics-provider'
import { registerCompletionProviders as frozenRegisterCompletionProviders } from '../../packages/vscode-extension/src/dsl-providers'
import { clearPluginCatalogCache as clearFrozenCatalog } from '../../packages/vscode-extension/src/plugin-catalog-reader'

const mock = vscodeMock as unknown as typeof import('../mocks/vscode')

// mock の CompletionItemKind は 3 つしか持たない。凍結版が使う Variable を VS Code と同じ番号で足す。
Object.assign(mock.CompletionItemKind, { Variable: 5 })
const KIND_NAMES: Record<number, string> = { 1: 'method', 5: 'variable', 11: 'value', 16: 'file' }

let tmp: string
let previousCatalog: string | undefined

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-langparity-'))
  previousCatalog = process.env.ORBIT_PLUGIN_CATALOG
  const catalog = path.join(tmp, 'plugin-catalog.json')
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      version: 2,
      scannedAt: '2026-10-26T00:00:00Z',
      plugins: [
        {
          name: 'Surge XT',
          vendor: 'Surge Synth Team',
          format: 'clap',
          path: '/p/Surge.clap',
          pluginId: 'surge',
          roles: ['instrument'],
        },
        {
          name: 'Echo',
          vendor: 'Acme',
          format: 'vst3',
          path: '/p/Echo.vst3',
          pluginId: 'echo',
          roles: ['effect'],
        },
        {
          name: 'Glue Comp',
          vendor: 'Acme',
          format: 'clap',
          path: '/p/Glue.clap',
          pluginId: 'glue',
          roles: ['effect'],
        },
      ],
    }),
  )
  process.env.ORBIT_PLUGIN_CATALOG = catalog
  clearFrozenCatalog()
  clearSessionCatalog()
})

afterAll(() => {
  if (previousCatalog === undefined) delete process.env.ORBIT_PLUGIN_CATALOG
  else process.env.ORBIT_PLUGIN_CATALOG = previousCatalog
  clearFrozenCatalog()
  clearSessionCatalog()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function synced(text: string, uri = 'file:///ws/piece/a.orbs'): SyncedDocument {
  const store = new DocumentStore()
  store.open(uri, 1, text, '/ws/piece')
  return store.get(uri)!
}

/** 凍結版の provider が読む文書（mock の型で）。行は `\n` で区切る（コーパスも `\n`）。 */
function frozenDocument(text: string, fsPath = '/ws/piece/a.orbs') {
  const lines = text.split('\n')
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    languageId: 'orbitscore',
    lineCount: lines.length,
    getText: () => text,
    lineAt: (lineOrPosition: number | { line: number }) => {
      const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
      return {
        text: lines[line] ?? '',
        range: new mock.Range(line, 0, line, (lines[line] ?? '').length),
      }
    },
  }
}

const languageServices = () => new LanguageServices({ log: () => {}, workspaceRoot: null })

/** 診断の比べる形（範囲・文言・重さ・code・tags）。 */
function normalizeDiagnostic(diagnostic: {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  message: string
  severity: number
  code?: unknown
  tags?: unknown[]
}) {
  return {
    range: [
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
    ],
    message: diagnostic.message,
    severity: diagnostic.severity,
    code: diagnostic.code ?? null,
    tags: diagnostic.tags ?? null,
  }
}

const DIAGNOSTIC_CORPUS: Array<[string, string]> = [
  [
    'missing paren / tempo range / deprecated',
    'global.tempo(1200\nglobal.tempo(5)\nsequence drum\n',
  ],
  ['global once per file', 'global.tempo(120)\nglobal.tempo(130)\n'],
  [
    'missing output and dry routing',
    'var g = init GLOBAL\nvar drum = init g.seq\ndrum.audio("kick.wav").play(1)\nLOOP(drum)\n',
  ],
  [
    'send-only to an aux leaves the dry signal unrouted (information)',
    'global.aux("verb")\nvar drum = init global.seq\ndrum.audio("k.wav").play(1)\ndrum.send("verb", -6)\n',
  ],
  ['empty output arg', 'var g = init GLOBAL\nvar drum = init g.seq\ndrum.output("")\n'],
  [
    'unknown plugin name against the catalog',
    'var g = init GLOBAL\nvar lead = init g.seq\nlead.instrument("Surge XX").output()\nlead.effect(["Echoo", "Glue Comp"])\n',
  ],
  [
    'multiline statement is not a missing paren',
    'var g = init GLOBAL\nvar drum = init g.seq\ndrum.play(\n  1, 2,\n  3)\n',
  ],
]

describe('diagnostics parity with the frozen extension (design 848 §5.5)', () => {
  it.each(DIAGNOSTIC_CORPUS)('%s', async (_label, text) => {
    let frozen: unknown[] = []
    await frozenUpdateDiagnostics(
      frozenDocument(text) as never,
      {
        set: (_uri: unknown, diagnostics: unknown[]) => {
          frozen = diagnostics
        },
      } as never,
    )
    const ours = await languageServices().rawDiagnostics(synced(text))
    expect(ours.map(normalizeDiagnostic)).toEqual((frozen as never[]).map(normalizeDiagnostic))
    // コーパスが空振りしていないこと（比べる中身がある）。
    if (!_label.startsWith('multiline')) expect(frozen.length).toBeGreaterThan(0)
  })
})

describe('get_diagnostics entries (frozen getDiagnosticsForAgent mapping)', () => {
  it('maps every corpus diagnostic to a 1-based start, a severity name and its code', async () => {
    const names = ['error', 'warning', 'info', 'hint']
    const seen = new Set<string>()
    for (const [, text] of DIAGNOSTIC_CORPUS) {
      const services = languageServices()
      const raw = await services.rawDiagnostics(synced(text))
      const entries = await services.diagnose(synced(text))
      expect(entries).toEqual(
        raw.map((diagnostic) => ({
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          severity: names[diagnostic.severity],
          message: diagnostic.message,
          ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
        })),
      )
      for (const entry of entries) seen.add(entry.severity)
    }
    // コーパスが 3 つの重さ（error / warning / info）を通っていること。
    expect([...seen].sort()).toEqual(['error', 'info', 'warning'])
  })
})

/** 補完の比べる形（label・kind の名前・detail・説明・挿入する文字・並べる順の鍵）。 */
function normalizeFrozenItem(item: {
  label: string
  kind?: number
  detail?: string
  documentation?: unknown
  insertText?: unknown
  sortText?: string
}) {
  const text = (value: unknown) =>
    value === undefined
      ? undefined
      : typeof value === 'string'
        ? value
        : (value as { value?: string }).value
  return {
    label: item.label,
    kind: item.kind === undefined ? undefined : KIND_NAMES[item.kind],
    detail: item.detail,
    documentation: text(item.documentation),
    insertText: text(item.insertText),
    sortText: item.sortText,
  }
}

const COMPLETION_CORPUS: Array<[string, string, { line: number; character: number }]> = [
  ['after global.', 'global.', { line: 0, character: 7 }],
  [
    'after a declared sequence',
    'var g = init GLOBAL\nvar drum = init g.seq\ndrum.',
    { line: 2, character: 5 },
  ],
  [
    'inside a method chain',
    'var drum = init global.seq\ndrum.audio("k.wav").chop(4).',
    { line: 1, character: 28 },
  ],
  [
    'pitch scope inside play()',
    'var lead = init global.seq\nlead.play((1, 2)(3).',
    { line: 1, character: 20 },
  ],
  [
    'output destination string',
    'var g = init GLOBAL\nvar verb = init g.aux\nvar drum = init g.seq\ndrum.output("',
    { line: 3, character: 13 },
  ],
  [
    'effect name in a rack',
    'var lead = init global.seq\nlead.effect(["Ec',
    { line: 1, character: 16 },
  ],
  ['instrument name', 'var lead = init global.seq\nlead.instrument("', { line: 1, character: 17 }],
  ['nothing to complete', 'LOOP', { line: 0, character: 4 }],
]

describe('completion parity with the frozen extension (design 848 §5.3.4)', () => {
  let frozenProviders: Array<{ provideCompletionItems: (...args: never[]) => unknown }>

  beforeAll(() => {
    mock.resetRegisteredCompletionProviders()
    frozenRegisterCompletionProviders({ subscriptions: { push: () => 0 } } as never)
    frozenProviders = mock.registeredCompletionProviders.map((registered) => registered.provider)
    expect(frozenProviders).toHaveLength(3)
  })

  it.each(COMPLETION_CORPUS)('%s', async (_label, text, position) => {
    const frozenItems: unknown[] = []
    for (const provider of frozenProviders) {
      const provided = (await provider.provideCompletionItems(
        frozenDocument(text) as never,
        new mock.Position(position.line, position.character) as never,
      )) as unknown[] | undefined
      frozenItems.push(...(provided ?? []))
    }
    const ours = await languageServices().complete(synced(text), position)
    const expected = (frozenItems as never[])
      .map(normalizeFrozenItem)
      .map((item) =>
        Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)),
      )
    expect(ours).toEqual(expected)
    if (_label !== 'nothing to complete') expect(expected.length).toBeGreaterThan(0)
  })
})

describe('layer-2 only: import completion reads the workspace (the mock cannot)', () => {
  it('offers .orbs paths relative to the document and names declared in the imported file', async () => {
    const ws = path.join(tmp, 'ws')
    fs.mkdirSync(path.join(ws, 'lib'), { recursive: true })
    fs.writeFileSync(
      path.join(ws, 'lib', 'drums.orbs'),
      'var kick = init global.seq\nvar snare = init global.seq\n',
    )
    fs.writeFileSync(path.join(ws, 'main.orbs'), '')
    const services = new LanguageServices({ log: () => {}, workspaceRoot: ws })
    const uri = `file://${path.join(ws, 'main.orbs')}`
    const pathLine = 'import { kick } from "'
    const paths = await services.complete(synced(pathLine, uri), {
      line: 0,
      character: pathLine.length,
    })
    expect(paths.map((item) => item.label)).toEqual(['./lib/drums.orbs'])
    const names = await services.complete(synced('import { k } from "./lib/drums.orbs"', uri), {
      line: 0,
      character: 10,
    })
    expect(names.map((item) => item.label)).toEqual(expect.arrayContaining(['kick']))
  })
})
