/**
 * #638 — edit-time diagnostics for catalog plugin names.
 *
 * The last describe block is the important one: the extension mirrors the
 * engine's resolution rules rather than importing them (it ships standalone),
 * so this file drives BOTH implementations over one corpus and asserts they
 * agree. Without that, the two can drift apart silently and the editor starts
 * flagging code the engine accepts — worse than having no diagnostic at all.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { clearPluginCatalogCache } from '../../packages/engine/src/core/global/plugin-catalog'
import { resolveCatalogSpec } from '../../packages/engine/src/core/global/plugin-resolver'
import {
  analyzeUnknownPluginNames,
  classifyCatalogSpec,
  findCatalogSpecSites,
} from '../../packages/vscode-extension/src/plugin-name-diagnostics'
import type { PluginCatalogEntry } from '../../packages/vscode-extension/src/plugin-catalog-reader'

const ENTRIES: PluginCatalogEntry[] = [
  {
    name: 'TAL Reverb 4',
    vendor: 'TAL Software',
    format: 'clap',
    path: '/clap/TALReverb4.clap',
    pluginId: 'tal-reverb-4',
    roles: ['effect'],
  },
  {
    name: 'TAL Reverb 4',
    vendor: 'TAL Software',
    format: 'vst3',
    path: '/vst3/TALReverb4.vst3',
    pluginId: 'tal-reverb-4-vst3',
    roles: ['effect'],
  },
  {
    name: 'Kontakt 8',
    vendor: 'Native Instruments',
    format: 'vst3',
    path: '/vst3/Kontakt8.vst3',
    pluginId: 'kontakt-8',
    roles: ['instrument'],
  },
  {
    name: 'Surge XT',
    vendor: 'Surge Synth Team',
    format: 'clap',
    path: '/clap/SurgeXT.clap',
    pluginId: 'surge-xt',
    roles: ['instrument', 'effect'],
  },
  // Same bare name from two vendors — bare use must be reported as ambiguous.
  {
    name: 'Glue',
    vendor: 'Vendor A',
    format: 'clap',
    path: '/clap/GlueA.clap',
    pluginId: 'glue-a',
    roles: ['effect'],
  },
  {
    name: 'Glue',
    vendor: 'Vendor B',
    format: 'clap',
    path: '/clap/GlueB.clap',
    pluginId: 'glue-b',
    roles: ['effect'],
  },
]

const messages = (text: string): string[] =>
  analyzeUnknownPluginNames(text, ENTRIES).map((issue) => issue.message)

describe('findCatalogSpecSites', () => {
  it('collects the names in a rack array with the enclosing verb as the role', () => {
    const sites = findCatalogSpecSites('kick.effect(["TAL Reverb 4", "Surge XT"])')
    expect(sites.map((s) => [s.spec, s.role])).toEqual([
      ['TAL Reverb 4', 'effect'],
      ['Surge XT', 'effect'],
    ])
  })

  it('carries the role into layer() and plugin() but not into a standard plugin call', () => {
    const text = [
      'kick.effect([',
      '  layer([["Surge XT"]]),',
      '  plugin("TAL Reverb 4", enabled: false),',
      '  Gain(db: -10, label: "not a plugin name"),',
      '])',
    ].join('\n')
    // The Gain(...) argument must be absent: standard plugins resolve from the
    // language vocabulary and never hit the catalog (SC.10.8 規範 4).
    expect(findCatalogSpecSites(text).map((s) => s.spec)).toEqual(['Surge XT', 'TAL Reverb 4'])
  })

  it('ignores strings outside any catalog verb', () => {
    expect(findCatalogSpecSites('kick.audio("./samples/kick.wav").play("x--x")')).toEqual([])
  })

  it('ignores commented-out code', () => {
    expect(findCatalogSpecSites('// kick.effect("Nope")\nkick.effect("Surge XT")')).toEqual([
      expect.objectContaining({ spec: 'Surge XT', line: 1 }),
    ])
  })

  it('reports the span of the literal including its quotes', () => {
    const [site] = findCatalogSpecSites('kick.effect("Surge XT")')
    expect([site?.line, site?.startCol, site?.endCol]).toEqual([0, 12, 22])
  })
})

describe('analyzeUnknownPluginNames', () => {
  it('flags a name that is not in the catalog', () => {
    expect(messages('kick.effect("TAL Rvereb 4")')).toEqual([
      expect.stringContaining('No plugin named "TAL Rvereb 4"'),
    ])
  })

  it('accepts a name that is in the catalog', () => {
    expect(messages('kick.effect("TAL Reverb 4")')).toEqual([])
  })

  it('accepts format- and vendor-qualified names', () => {
    expect(messages('kick.effect(["vst3/TAL Reverb 4", "TAL Software/TAL Reverb 4"])')).toEqual([])
  })

  it('does not flag path specs — they never reach the catalog', () => {
    expect(messages('kick.effect(["./local.clap", "/abs/x.vst3", "~/y.clap"])')).toEqual([])
  })

  // 🔴 Each spec below is caught by exactly ONE of the three exclusion rules.
  // The combined forms above (`./local.clap`) satisfy two rules at once, so
  // they keep passing when either rule is broken — they cannot tell the rules
  // apart. These can.
  it('does not flag a path that carries no plugin extension', () => {
    // Only the path-prefix rule can catch this one.
    expect(messages('kick.effect("./racks/my-chain")')).toEqual([])
  })

  it('does not flag a bare filename that carries a plugin extension', () => {
    // Only the extension rule can catch this one.
    expect(messages('kick.effect("MyPlugin.clap")')).toEqual([])
  })

  it('does not flag a bare saved-state filename', () => {
    // Only the state-file rule can catch this one.
    expect(messages('cb.instrument("Kontakt 8", "bass.vstpreset")')).toEqual([])
  })

  it('does not flag a saved-state file passed as the second instrument argument', () => {
    expect(messages('cb.instrument("Kontakt 8", "./tones/bass.vstpreset")')).toEqual([])
  })

  it('flags a plugin used in a role the catalog does not give it', () => {
    expect(messages('cb.instrument("TAL Reverb 4")')).toEqual([
      expect.stringContaining('does not support the "instrument" role'),
    ])
  })

  it('flags a bare name that several vendors share', () => {
    expect(messages('kick.effect("Glue")')).toEqual([
      expect.stringContaining('ambiguous across multiple vendors'),
    ])
  })

  it('accepts that same name once it is vendor-qualified', () => {
    expect(messages('kick.effect("Vendor B/Glue")')).toEqual([])
  })

  it('stays quiet when the catalog is unavailable', () => {
    // A catalog that has not been scanned yet is not evidence that a name is
    // wrong; flagging every name in the file would be worse than silence.
    expect(analyzeUnknownPluginNames('kick.effect("Anything")', undefined)).toEqual([])
    expect(analyzeUnknownPluginNames('kick.effect("Anything")', [])).toEqual([])
  })

  it('reports every bad name in a rack, not just the first', () => {
    expect(messages('kick.effect(["Nope One", "Surge XT", "Nope Two"])')).toHaveLength(2)
  })
})

// ──────────────────────────────────────────────────────────────────────
// 🔴 エンジンとの合意テスト（重複のドリフト検出器）
// ──────────────────────────────────────────────────────────────────────

describe('agreement with the engine resolver', () => {
  let catalogPath: string

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-catalog-'))
    catalogPath = join(dir, 'plugins.json')
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 2, scannedAt: new Date(0).toISOString(), plugins: ENTRIES }),
    )
    clearPluginCatalogCache()
  })

  /** What the engine does when asked to resolve `spec` — accept, or throw. */
  const engineAccepts = (spec: string, role: 'effect' | 'instrument'): boolean => {
    try {
      resolveCatalogSpec(spec, role, catalogPath)
      return true
    } catch {
      return false
    }
  }

  const CORPUS: ReadonlyArray<readonly [string, 'effect' | 'instrument']> = [
    ['TAL Reverb 4', 'effect'],
    ['tal reverb 4', 'effect'],
    ['  TAL Reverb 4  ', 'effect'],
    ['TAL Rvereb 4', 'effect'],
    ['vst3/TAL Reverb 4', 'effect'],
    ['clap/TAL Reverb 4', 'effect'],
    ['TAL Software/TAL Reverb 4', 'effect'],
    ['Nobody/TAL Reverb 4', 'effect'],
    ['TAL Reverb 4', 'instrument'],
    ['Kontakt 8', 'instrument'],
    ['Kontakt 8', 'effect'],
    ['Surge XT', 'instrument'],
    ['Surge XT', 'effect'],
    ['Glue', 'effect'],
    ['Vendor A/Glue', 'effect'],
    ['Vendor B/Glue', 'effect'],
    ['Vendor C/Glue', 'effect'],
    ['', 'effect'],
  ]

  it.each(CORPUS)('agrees on %j as %s', (spec, role) => {
    const extensionAccepts = classifyCatalogSpec(ENTRIES, spec, role).kind === 'ok'
    expect(extensionAccepts).toBe(engineAccepts(spec, role))
  })

  it('agrees that path specs are out of scope for both sides', () => {
    // The engine sends these down its path branch instead of the catalog; the
    // extension must not classify them as names at all.
    for (const spec of ['./x.clap', '/abs/y.vst3', '~/z.clap', '../w.component']) {
      expect(classifyCatalogSpec(ENTRIES, spec, 'effect').kind).toBe('not-a-catalog-name')
    }
  })
})
