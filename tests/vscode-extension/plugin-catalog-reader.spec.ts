import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, afterEach } from 'vitest'

import {
  clearPluginCatalogCache,
  loadPluginCatalog,
  resolveCatalogPath,
  resolvePluginScanBinaryPath,
} from '../../packages/vscode-extension/src/plugin-catalog-reader'

describe('resolveCatalogPath', () => {
  const originalEnv = process.env.ORBIT_PLUGIN_CATALOG

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ORBIT_PLUGIN_CATALOG
    else process.env.ORBIT_PLUGIN_CATALOG = originalEnv
  })

  it('explicit override wins over env and default', () => {
    process.env.ORBIT_PLUGIN_CATALOG = '/env/catalog.json'
    expect(resolveCatalogPath('/explicit/catalog.json')).toBe('/explicit/catalog.json')
  })

  it('falls back to ORBIT_PLUGIN_CATALOG env when no override given', () => {
    process.env.ORBIT_PLUGIN_CATALOG = '/env/catalog.json'
    expect(resolveCatalogPath()).toBe('/env/catalog.json')
  })

  it('falls back to ~/.orbitscore/plugin-catalog.json when neither is set', () => {
    delete process.env.ORBIT_PLUGIN_CATALOG
    expect(resolveCatalogPath()).toBe(path.join(os.homedir(), '.orbitscore', 'plugin-catalog.json'))
  })
})

describe('loadPluginCatalog', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-catalog-'))
  const catalogPath = path.join(tmpDir, 'plugin-catalog.json')

  afterEach(() => {
    clearPluginCatalogCache()
  })

  it('returns undefined when the catalog file does not exist', () => {
    expect(loadPluginCatalog(path.join(tmpDir, 'missing.json'))).toBeUndefined()
  })

  it('parses an existing catalog file', () => {
    const catalog = {
      version: 1,
      scannedAt: '2026-07-17T00:00:00Z',
      plugins: [
        {
          name: 'Surge XT',
          vendor: 'Surge Synth Team',
          format: 'clap',
          path: '/clap/SurgeXT.clap',
          pluginId: 'surge-xt',
          roles: ['instrument'],
        },
      ],
    }
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
    const loaded = loadPluginCatalog(catalogPath)
    expect(loaded?.plugins).toHaveLength(1)
    expect(loaded?.plugins[0].name).toBe('Surge XT')
  })

  it('re-reads after the file mtime changes (rescan invalidation)', async () => {
    fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, scannedAt: 't1', plugins: [] }))
    const first = loadPluginCatalog(catalogPath)
    expect(first?.plugins).toHaveLength(0)

    // Ensure a distinct mtime (some filesystems have 1s resolution).
    await new Promise((resolve) => setTimeout(resolve, 1100))
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        scannedAt: 't2',
        plugins: [
          {
            name: 'X',
            vendor: 'Y',
            format: 'clap',
            path: '/x.clap',
            pluginId: 'x',
            roles: ['effect'],
          },
        ],
      }),
    )
    const second = loadPluginCatalog(catalogPath)
    expect(second?.plugins).toHaveLength(1)
  }, 5000)
})

describe('resolvePluginScanBinaryPath', () => {
  it('explicit path wins when it is an executable file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-scan-bin-'))
    const binPath = path.join(tmpDir, 'orbit-plugin-scan')
    fs.writeFileSync(binPath, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    expect(resolvePluginScanBinaryPath(binPath)).toBe(binPath)
  })

  it('ORBIT_PLUGIN_SCAN_PATH env override wins when the explicit arg is not viable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-scan-bin-env-'))
    const binPath = path.join(tmpDir, 'orbit-plugin-scan')
    fs.writeFileSync(binPath, '#!/bin/sh\necho hi\n', { mode: 0o755 })
    const originalEnv = process.env.ORBIT_PLUGIN_SCAN_PATH
    process.env.ORBIT_PLUGIN_SCAN_PATH = binPath
    try {
      expect(resolvePluginScanBinaryPath('/definitely/not/a/real/path')).toBe(binPath)
    } finally {
      if (originalEnv === undefined) delete process.env.ORBIT_PLUGIN_SCAN_PATH
      else process.env.ORBIT_PLUGIN_SCAN_PATH = originalEnv
    }
  })
})
