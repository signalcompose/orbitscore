import { describe, it, expect } from 'vitest'

import { filterCatalogEntries } from '../../packages/vscode-extension/src/plugin-catalog-completion'
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

  it('splits formats only within a vendor and retains a plain label for another vendor', () => {
    const entries: PluginCatalogEntry[] = [
      { ...ENTRIES[1], name: 'Reverb', vendor: 'VendorA', format: 'clap' },
      { ...ENTRIES[2], name: 'Reverb', vendor: 'VendorA', format: 'vst3' },
      { ...ENTRIES[1], name: 'Reverb', vendor: 'VendorB', format: 'clap' },
    ]
    const result = filterCatalogEntries(entries, 'effect', 'Reverb')
    expect(result.map(({ label }) => label)).toEqual(['clap/Reverb', 'vst3/Reverb', 'Reverb'])
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
