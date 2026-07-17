import { describe, it, expect } from 'vitest'

import {
  detectPluginArgContext,
  filterCatalogEntries,
} from '../../packages/vscode-extension/src/plugin-catalog-completion'
import type { PluginCatalogEntry } from '../../packages/vscode-extension/src/plugin-catalog-reader'

const ENTRIES: PluginCatalogEntry[] = [
  {
    name: 'Scaler 2',
    vendor: 'Plugin Boutique',
    format: 'vst3',
    path: '/vst3/Scaler2.vst3',
    pluginId: 'scaler2',
    roles: ['instrument'],
  },
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
    name: 'Surge XT',
    vendor: 'Surge Synth Team',
    format: 'clap',
    path: '/clap/SurgeXT.clap',
    pluginId: 'surge-xt',
    roles: ['instrument', 'effect'],
  },
]

describe('detectPluginArgContext', () => {
  it('matches at the freshly-triggered open quote', () => {
    const line = 'kick.effect("'
    const result = detectPluginArgContext(line, line.length)
    expect(result).toEqual({ verb: 'effect', typed: '', quoteStartChar: line.length })
  })

  it('matches a PARTIAL in-progress string with no closing quote (owner requirement 2026-07-17)', () => {
    const line = 'kick.effect("Sca'
    const result = detectPluginArgContext(line, line.length)
    expect(result).not.toBeNull()
    expect(result?.verb).toBe('effect')
    expect(result?.typed).toBe('Sca')
    expect(result?.quoteStartChar).toBe(line.indexOf('"') + 1)
  })

  it('still matches when a closing quote exists later on the line but cursor is mid-string', () => {
    const line = 'kick.effect("Sca")'
    const cursor = line.indexOf('Sca') + 3 // right after "Sca", before the closing quote
    const result = detectPluginArgContext(line, cursor)
    expect(result?.typed).toBe('Sca')
  })

  it('recognizes instrument(', () => {
    const line = 'lead.instrument("Sur'
    const result = detectPluginArgContext(line, line.length)
    expect(result?.verb).toBe('instrument')
    expect(result?.typed).toBe('Sur')
  })

  it('returns null outside a plugin-name string position', () => {
    expect(detectPluginArgContext('global.tempo(140)', 18)).toBeNull()
    expect(detectPluginArgContext('kick.effect(', 12)).toBeNull() // no opening quote yet
  })
})

describe('filterCatalogEntries', () => {
  it('narrows to Scaler-prefixed candidates as the user types "Sca" for instrument(', () => {
    const result = filterCatalogEntries(ENTRIES, 'instrument', 'Sca')
    expect(result.map((c) => c.label)).toEqual(['Scaler 2'])
  })

  it('effect() includes VST3 entries when completing effects', () => {
    const result = filterCatalogEntries(ENTRIES, 'effect', 'TAL')
    expect(result.map(({ entry }) => entry.format)).toEqual(['clap', 'vst3'])
  })

  it('emits format/name labels and insert text for same-name cross-format effects', () => {
    const result = filterCatalogEntries(ENTRIES, 'effect', 'TAL')
    expect(result.map(({ label, insertText }) => ({ label, insertText }))).toEqual([
      { label: 'clap/TAL Reverb 4', insertText: 'clap/TAL Reverb 4' },
      { label: 'vst3/TAL Reverb 4', insertText: 'vst3/TAL Reverb 4' },
    ])
  })

  it('instrument() has no format restriction', () => {
    const result = filterCatalogEntries(ENTRIES, 'instrument', 'Surge')
    expect(result.map(({ entry }) => entry.name)).toEqual(['Surge XT'])
  })

  it('empty typed prefix returns all role-matching entries', () => {
    const result = filterCatalogEntries(ENTRIES, 'instrument', '')
    expect(result.map(({ entry }) => entry.name).sort()).toEqual(['Scaler 2', 'Surge XT'])
  })

  it('matches vendor-qualified prefix ("TAL Software/")', () => {
    const result = filterCatalogEntries(ENTRIES, 'effect', 'TAL Software/TAL')
    expect(result).toHaveLength(2)
  })

  it('role mismatch excludes an entry', () => {
    const result = filterCatalogEntries(ENTRIES, 'effect', 'Scaler')
    expect(result).toHaveLength(0)
  })
})
