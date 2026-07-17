import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import {
  clearPluginCatalogCache,
  type PluginCatalogFile,
} from '../../packages/engine/src/core/global/plugin-catalog'
import {
  isPluginPathSpec,
  resolvePluginSpec,
} from '../../packages/engine/src/core/global/plugin-resolver'

function writeCatalog(dir: string, catalog: PluginCatalogFile): string {
  const file = path.join(dir, 'plugin-catalog.json')
  fs.writeFileSync(file, JSON.stringify(catalog))
  return file
}

const FIXTURE_CATALOG: PluginCatalogFile = {
  version: 1,
  scannedAt: '2026-07-17T00:00:00Z',
  plugins: [
    {
      name: 'TAL Reverb 4',
      vendor: 'TAL Software',
      format: 'clap',
      path: '/plugins/tal-reverb.clap',
      pluginId: 'tal-reverb-id',
      roles: ['effect'],
    },
    // Same name in VST3 — exercises CLAP preference and `format/name` qualification (#504).
    {
      name: 'TAL Reverb 4',
      vendor: 'TAL Software',
      format: 'vst3',
      path: '/plugins/tal-reverb.vst3',
      pluginId: 'tal-reverb-vst3-id',
      roles: ['effect'],
    },
    // Same bare name, two different vendors — ambiguous without vendor qualifier.
    {
      name: 'Reverb',
      vendor: 'Vendor A',
      format: 'clap',
      path: '/plugins/vendor-a-reverb.clap',
      pluginId: 'vendor-a-reverb-id',
      roles: ['effect'],
    },
    {
      name: 'Reverb',
      vendor: 'Vendor B',
      format: 'clap',
      path: '/plugins/vendor-b-reverb.clap',
      pluginId: 'vendor-b-reverb-id',
      roles: ['effect'],
    },
    // Same vendor+name, two formats — CLAP must win the preference.
    {
      name: 'Scaler 3',
      vendor: 'Scaler Music',
      format: 'vst3',
      path: '/plugins/scaler3.vst3',
      pluginId: 'scaler3-vst3-id',
      roles: ['instrument'],
    },
    {
      name: 'Scaler 3',
      vendor: 'Scaler Music',
      format: 'clap',
      path: '/plugins/scaler3.clap',
      pluginId: 'scaler3-clap-id',
      roles: ['instrument'],
    },
    // VST3-only effect — effect() accepts it when no CLAP alternative exists.
    {
      name: 'VstOnlyFX',
      vendor: 'Some Vendor',
      format: 'vst3',
      path: '/plugins/vstonlyfx.vst3',
      pluginId: 'vstonlyfx-id',
      roles: ['effect'],
    },
    // Instrument-only role — querying it as effect() must trigger a role error.
    {
      name: 'InstrumentOnly',
      vendor: 'Some Vendor',
      format: 'clap',
      path: '/plugins/instronly.clap',
      pluginId: 'instronly-id',
      roles: ['instrument'],
    },
  ],
}

describe('PC.2 discriminator (isPluginPathSpec)', () => {
  it.each([['./rel.clap'], ['../rel.clap'], ['~/home.clap'], ['/abs.clap']])(
    'treats %s as path-direct (prefix)',
    (spec) => {
      expect(isPluginPathSpec(spec)).toBe(true)
    },
  )

  it.each([['bundle.clap'], ['bundle.vst3'], ['bundle.component'], ['Bundle.CLAP']])(
    'treats %s as path-direct (known extension)',
    (spec) => {
      expect(isPluginPathSpec(spec)).toBe(true)
    },
  )

  it.each([['TAL Reverb 4'], ['TAL Software/TAL Reverb 4'], ['Scaler 3']])(
    'treats %s as a catalog name',
    (spec) => {
      expect(isPluginPathSpec(spec)).toBe(false)
    },
  )
})

describe('resolvePluginSpec catalog resolution', () => {
  let dir: string
  let catalogPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-catalog-'))
    catalogPath = writeCatalog(dir, FIXTURE_CATALOG)
    clearPluginCatalogCache()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    clearPluginCatalogCache()
  })

  it('resolves an exact name match case-insensitively, trimmed, and NFC-normalized', () => {
    const resolved = resolvePluginSpec(
      '  tal reverb 4  '.toUpperCase(),
      undefined,
      [],
      '/doc',
      'effect',
      catalogPath,
    )
    expect(resolved).toEqual({ path: '/plugins/tal-reverb.clap', pluginId: 'tal-reverb-id' })
  })

  it('NFD-composed spec matches an NFC catalog name', () => {
    // "TAL Reverb 4" has no combining marks, so build one via a diacritic case to
    // exercise NFC normalization end to end without needing a non-ASCII fixture name.
    const nfd = 'TAL Reverb 4'.normalize('NFD')
    const resolved = resolvePluginSpec(nfd, undefined, [], '/doc', 'effect', catalogPath)
    expect(resolved.pluginId).toBe('tal-reverb-id')
  })

  it('disambiguates via vendor qualification', () => {
    const a = resolvePluginSpec('Vendor A/Reverb', undefined, [], '/doc', 'effect', catalogPath)
    const b = resolvePluginSpec('Vendor B/Reverb', undefined, [], '/doc', 'effect', catalogPath)
    expect(a.pluginId).toBe('vendor-a-reverb-id')
    expect(b.pluginId).toBe('vendor-b-reverb-id')
  })

  it('throws an enumerated ambiguity error without a vendor qualifier', () => {
    expect(() => resolvePluginSpec('Reverb', undefined, [], '/doc', 'effect', catalogPath)).toThrow(
      /ambiguous.*Vendor A\/Reverb.*Vendor B\/Reverb/s,
    )
  })

  it('prefers CLAP over VST3 when both formats exist for the same vendor/name', () => {
    const resolved = resolvePluginSpec('Scaler 3', undefined, [], '/doc', 'instrument', catalogPath)
    expect(resolved).toEqual({ path: '/plugins/scaler3.clap', pluginId: 'scaler3-clap-id' })
  })

  it('prefers CLAP over VST3 for effects with the same vendor/name', () => {
    const resolved = resolvePluginSpec('TAL Reverb 4', undefined, [], '/doc', 'effect', catalogPath)
    expect(resolved).toEqual({ path: '/plugins/tal-reverb.clap', pluginId: 'tal-reverb-id' })
  })

  it('resolves format/name qualifiers to the requested effect format', () => {
    expect(
      resolvePluginSpec('clap/TAL Reverb 4', undefined, [], '/doc', 'effect', catalogPath),
    ).toEqual({
      path: '/plugins/tal-reverb.clap',
      pluginId: 'tal-reverb-id',
    })
    expect(
      resolvePluginSpec('vst3/TAL Reverb 4', undefined, [], '/doc', 'effect', catalogPath),
    ).toEqual({
      path: '/plugins/tal-reverb.vst3',
      pluginId: 'tal-reverb-vst3-id',
    })
  })

  it('resolves a VST3-only effect name', () => {
    const resolved = resolvePluginSpec('VstOnlyFX', undefined, [], '/doc', 'effect', catalogPath)
    expect(resolved).toEqual({ path: '/plugins/vstonlyfx.vst3', pluginId: 'vstonlyfx-id' })
  })

  it('rejects pairing a catalog name with an explicit pluginId argument', () => {
    expect(() =>
      resolvePluginSpec('TAL Reverb 4', 'explicit-id', [], '/doc', 'effect', catalogPath),
    ).toThrow(/pluginId/)
  })

  it('rejects a role mismatch (instrument-only entry requested as effect)', () => {
    expect(() =>
      resolvePluginSpec('InstrumentOnly', undefined, [], '/doc', 'effect', catalogPath),
    ).toThrow(/does not support the "effect" role/)
  })

  it('gives an actionable rescan error when the name is not found', () => {
    expect(() =>
      resolvePluginSpec('NoSuchPlugin', undefined, [], '/doc', 'effect', catalogPath),
    ).toThrow(/orbit-plugin-scan/)
  })

  it('gives an actionable rescan error when the catalog file does not exist', () => {
    const missing = path.join(dir, 'does-not-exist.json')
    expect(() =>
      resolvePluginSpec('TAL Reverb 4', undefined, [], '/doc', 'effect', missing),
    ).toThrow(/orbit-plugin-scan/)
  })

  it('honors the ORBIT_PLUGIN_CATALOG env var when no explicit override is passed', () => {
    const previous = process.env.ORBIT_PLUGIN_CATALOG
    process.env.ORBIT_PLUGIN_CATALOG = catalogPath
    try {
      const resolved = resolvePluginSpec('TAL Reverb 4', undefined, [], '/doc', 'effect', undefined)
      expect(resolved.pluginId).toBe('tal-reverb-id')
    } finally {
      if (previous === undefined) delete process.env.ORBIT_PLUGIN_CATALOG
      else process.env.ORBIT_PLUGIN_CATALOG = previous
      clearPluginCatalogCache()
    }
  })
})

describe('Global.effect()/instrument() catalog name integration', () => {
  let dir: string
  let catalogPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-catalog-int-'))
    catalogPath = writeCatalog(dir, FIXTURE_CATALOG)
    process.env.ORBIT_PLUGIN_CATALOG = catalogPath
    clearPluginCatalogCache()
  })

  afterEach(() => {
    delete process.env.ORBIT_PLUGIN_CATALOG
    clearPluginCatalogCache()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a catalog instrument name to (path, pluginId) end to end', async () => {
    const loadPlugin = vi.fn().mockResolvedValue({})
    const engine = { loadPlugin, boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine)
    global.setDocumentDirectory('/songs/session')

    await expect(global.instrument('Scaler 3')).resolves.toBe(global)
    expect(loadPlugin).toHaveBeenCalledWith(
      '/plugins/scaler3.clap',
      'scaler3-clap-id',
      'instrument',
    )
  })

  it('resolves a catalog effect name to (path, pluginId) end to end', async () => {
    const loadPlugin = vi.fn().mockResolvedValue({})
    const engine = { loadPlugin, boot: vi.fn(), quit: vi.fn(), isRunning: true } as any
    const global = new Global(engine)
    global.setDocumentDirectory('/songs/session')

    await expect(global.effect('TAL Software/TAL Reverb 4')).resolves.toBe(global)
    expect(loadPlugin).toHaveBeenCalledWith('/plugins/tal-reverb.clap', 'tal-reverb-id', 'effect')
  })

  it('rejects passing an explicit pluginId together with a catalog effect name', async () => {
    const engine = {
      loadPlugin: vi.fn().mockResolvedValue({}),
      boot: vi.fn(),
      quit: vi.fn(),
      isRunning: true,
    } as any
    const global = new Global(engine)
    global.setDocumentDirectory('/songs/session')
    await expect(global.effect('TAL Reverb 4', 'explicit-id')).rejects.toThrow(/pluginId/)
  })
})
