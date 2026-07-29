import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, afterEach } from 'vitest'

import {
  clearPluginCatalogCache,
  loadPluginCatalog,
  resolveCatalogPath,
  resolvePluginScanBinaryPath,
  runPluginScan,
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

  it('preserves catalog v2 probe-pending as distinct from failure', () => {
    const catalog = {
      version: 2,
      scannedAt: '2026-07-29T00:00:00Z',
      plugins: [],
      artifacts: [
        {
          format: 'vst3',
          path: '/vst3/Kontakt.vst3',
          status: 'probePending',
          reason: 'moduleinfoMissing',
        },
      ],
    }
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))
    const loaded = loadPluginCatalog(catalogPath)
    expect(loaded?.artifacts?.[0]).toMatchObject({
      status: 'probePending',
      reason: 'moduleinfoMissing',
    })
    expect(loaded?.artifacts?.[0].failure).toBeUndefined()
  })

  it('preserves architecture details from a catalog v2 probe failure', () => {
    const catalog = {
      version: 2,
      scannedAt: '2026-07-29T00:00:00Z',
      plugins: [],
      artifacts: [
        {
          format: 'vst3',
          path: '/vst3/Legacy.vst3',
          status: 'probeFailed',
          durationMs: 0,
          failure: {
            code: 'unsupportedArch',
            message: 'host architecture arm64 is not present in Mach-O slices [x86_64]',
            hostArch: 'arm64',
            slices: ['x86_64'],
          },
        },
      ],
    }
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))

    const failure = loadPluginCatalog(catalogPath)?.artifacts?.[0].failure
    expect(failure?.hostArch).toBe('arm64')
    expect(failure?.slices).toEqual(['x86_64'])
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

describe('runPluginScan', () => {
  it('enables child probes only through the explicit rescan flag and returns diagnostics', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-scan-explicit-'))
    const binPath = path.join(tmpDir, 'orbit-plugin-scan')
    fs.writeFileSync(
      binPath,
      `#!/bin/sh
if [ "$1" != "--probe-artifacts" ]; then
  echo "missing explicit probe flag: $*" >&2
  exit 2
fi
echo '{"count":5,"artifactCount":5,"cachePath":"/tmp/catalog.json","skipped":[],"failures":[{"path":"/tmp/Broken.vst3","code":"timeout","message":"too slow"}],"summary":{"success":4,"pending":0,"failure":1,"failureReasons":{"timeout":1},"durationMs":{"p50":5,"p95":20000,"max":20000},"timeouts":1,"crashes":0,"factoryVersions":{"factory3":4},"cacheHits":3,"probeAttempts":2}}'
`,
      { mode: 0o755 },
    )

    const result = await runPluginScan(binPath)
    expect(result).toEqual({
      ok: true,
      count: 5,
      artifactCount: 5,
      cachePath: '/tmp/catalog.json',
      skipped: [],
      failures: [{ path: '/tmp/Broken.vst3', code: 'timeout', message: 'too slow' }],
      summary: {
        success: 4,
        pending: 0,
        failure: 1,
        failureReasons: { timeout: 1 },
        durationMs: { p50: 5, p95: 20_000, max: 20_000 },
        timeouts: 1,
        crashes: 0,
        factoryVersions: { factory3: 4 },
        cacheHits: 3,
        probeAttempts: 2,
      },
    })
  })

  it('kills the scanner process group on timeout so descendants cannot become orphans', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-scan-group-timeout-'))
    const pidFile = path.join(tmpDir, 'descendant.pid')
    const fixture = path.resolve(__dirname, '../fixtures/plugin-catalog/scan-hang.sh')
    const originalPidFile = process.env.ORBIT_SCAN_TEST_PID_FILE
    process.env.ORBIT_SCAN_TEST_PID_FILE = pidFile
    let descendantPid = 0
    try {
      const scan = runPluginScan(fixture, 500)
      const completion = await Promise.race([
        scan.then((result) => ({ kind: 'completed' as const, result })),
        new Promise<{ kind: 'blocked' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'blocked' }), 1_500),
        ),
      ])
      descendantPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (completion.kind === 'blocked') {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // The process may have exited in the race after the watchdog fired.
        }
        await scan
      }
      expect(
        completion.kind,
        `scanner close remained blocked because descendant pid ${descendantPid} kept its pipes open`,
      ).toBe('completed')
      if (completion.kind !== 'completed') return
      const result = completion.result
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('timed out')

      const deadline = Date.now() + 2_000
      let alive = true
      while (Date.now() < deadline) {
        try {
          process.kill(descendantPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 20))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            alive = false
            break
          }
          throw error
        }
      }
      expect(
        alive,
        `scanner timeout killed only the parent; descendant pid ${descendantPid} survived`,
      ).toBe(false)
    } finally {
      if (originalPidFile === undefined) delete process.env.ORBIT_SCAN_TEST_PID_FILE
      else process.env.ORBIT_SCAN_TEST_PID_FILE = originalPidFile
      if (descendantPid !== 0) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Expected after the process-group kill; cleanup is only mutation-test hygiene.
        }
      }
    }
  })
})
