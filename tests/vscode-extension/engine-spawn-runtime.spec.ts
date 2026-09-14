/**
 * engine を起動する Node ランタイムの決め方（#878）。
 *
 * 🔴 **判断の根拠は `extension.ts` の `startEngine()` にある**コメントが正本
 * （なぜ PATH の `node` を引かないか・`ELECTRON_RUN_AS_NODE` がなぜ要るか・実測した
 * Node 版とネイティブアドオンの結果）。**ここに写さない** — 実測値が 2 箇所に増えると、
 * 片方だけ古くなっても誰も気づかない。
 *
 * 本 spec が追加で見るのは「**何を spawn したか**」だけである。ランタイムが実際に動くことは
 * `tests/e2e/vsix-cold-install-gated.spec.ts`（cold install）が見る。
 */
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import * as vscode from 'vscode'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  extensionEngineFileExists,
  resolveDaemonBinaryForExtension,
} from '../../packages/vscode-extension/src/engine-startup-runtime'
import * as ext from '../../packages/vscode-extension/src/extension'
import { resolvePluginWindowHostBundleId } from '../../packages/vscode-extension/src/engine-process'
import {
  fakeSpawnedProcess,
  resetExtensionEngineTestState,
} from '../helpers/extension-engine-mocks'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

vi.mock('../../packages/vscode-extension/src/engine-startup-runtime', () => ({
  extensionEngineFileExists: vi.fn(() => true),
  resolveDaemonBinaryForExtension: vi.fn(() => ({
    path: '/unit-test/orbit-audio-daemon',
    source: 'unit-test',
  })),
}))

describe('engine spawn runtime (#878)', () => {
  const originalExecPath = process.execPath
  let inheritedHostBundleId: string | undefined

  beforeEach(() => {
    inheritedHostBundleId = process.env.ORBIT_HOST_BUNDLE_ID
    vi.mocked(extensionEngineFileExists).mockClear()
    vi.mocked(resolveDaemonBinaryForExtension).mockClear()
    resetExtensionEngineTestState(ext)
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined)
  })

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
    if (inheritedHostBundleId === undefined) delete process.env.ORBIT_HOST_BUNDLE_ID
    else process.env.ORBIT_HOST_BUNDLE_ID = inheritedHostBundleId
    vi.mocked(child_process.spawn).mockReset()
    vi.restoreAllMocks()
    ext.__setEngineProcessForTest(null)
  })

  it('spawns an absolute Node runtime instead of resolving "node" through PATH', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess().proc)

    const result = await ext.startEngineForAgent()
    expect(result).toEqual({ ok: true, message: 'engine starting' })

    expect(child_process.spawn).toHaveBeenCalledTimes(1)
    const [command] = vi.mocked(child_process.spawn).mock.calls[0]

    // 🔴 「絶対パスであること」までしか見ないと、`/usr/local/bin/node` を決め打ちする実装でも
    // 通ってしまう。**VS Code 同梱のランタイムそのもの**であることを見る。
    expect(command).toBe(process.execPath)
    expect(path.isAbsolute(String(command))).toBe(true)
  })

  it('runs that runtime as Node by setting ELECTRON_RUN_AS_NODE in the child env', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess().proc)

    await ext.startEngineForAgent()

    const [, , options] = vi.mocked(child_process.spawn).mock.calls[0]
    const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env
    // 拡張ホストは Electron なので、`process.execPath` はそのままでは Node として動かない
    // （実測: 付けずに起動すると `Unable to find helper app` で落ちる）。
    expect(env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('still passes the engine entry point as the first argument', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess().proc)

    await ext.startEngineForAgent()

    const [, args] = vi.mocked(child_process.spawn).mock.calls[0]
    expect(Array.isArray(args)).toBe(true)
    expect(String((args as string[])[0])).toMatch(/cli-audio\.js$/)
  })

  it('resolves the outer macOS host bundle ID for plugin-window children', () => {
    let plistPath = ''
    const bundleId = resolvePluginWindowHostBundleId(
      '/Applications/OrbitStudio.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
      'darwin',
      (filePath) => {
        plistPath = filePath
        return `<?xml version="1.0"?><plist><dict>
          <key>CFBundleIdentifier</key><string>dev.orbitscore.OrbitStudio</string>
        </dict></plist>`
      },
    )

    expect(plistPath).toBe('/Applications/OrbitStudio.app/Contents/Info.plist')
    expect(bundleId).toBe('dev.orbitscore.OrbitStudio')
    expect(
      resolvePluginWindowHostBundleId('/usr/local/bin/node', 'darwin', () => ''),
    ).toBeUndefined()
    expect(
      resolvePluginWindowHostBundleId(
        '/Applications/OrbitStudio.app/Contents/MacOS/OrbitStudio',
        'linux',
        () => {
          throw new Error('non-macOS must not read a bundle')
        },
      ),
    ).toBeUndefined()
  })

  it('logs both successful and failed macOS host bundle resolution', () => {
    const log = vi.fn()
    expect(
      resolvePluginWindowHostBundleId(
        '/Applications/OrbitStudio.app/Contents/MacOS/OrbitStudio',
        'darwin',
        () => '<key>CFBundleIdentifier</key><string>dev.orbitscore.OrbitStudio</string>',
        log,
      ),
    ).toBe('dev.orbitscore.OrbitStudio')
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('dev.orbitscore.OrbitStudio'))

    resolvePluginWindowHostBundleId('/usr/local/bin/node', 'darwin', () => '', log)
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('not inside a macOS .app'))

    resolvePluginWindowHostBundleId(
      '/Applications/OrbitStudio.app/Contents/MacOS/OrbitStudio',
      'darwin',
      () => {
        throw new Error('permission denied')
      },
      log,
    )
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('permission denied'))

    resolvePluginWindowHostBundleId(
      '/Applications/OrbitStudio.app/Contents/MacOS/OrbitStudio',
      'darwin',
      () => '<plist><dict></dict></plist>',
      log,
    )
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('CFBundleIdentifier'))

    log.mockClear()
    resolvePluginWindowHostBundleId('/usr/local/bin/node', 'linux', () => '', log)
    expect(log).not.toHaveBeenCalled()
  })

  it('passes the resolved host bundle ID into the spawned engine environment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-bundle-'))
    const appPath = path.join(root, 'OrbitStudio.app')
    fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(
      path.join(appPath, 'Contents', 'Info.plist'),
      '<key>CFBundleIdentifier</key><string>dev.orbitscore.OrbitStudio</string>',
    )
    Object.defineProperty(process, 'execPath', {
      value: path.join(appPath, 'Contents', 'MacOS', 'OrbitStudio'),
      configurable: true,
    })
    const appendLine = vi.fn()
    ext.__setOutputChannelForTest({ appendLine, append: () => {} })
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess().proc)

    try {
      await ext.startEngineForAgent()
      const [, , options] = vi.mocked(child_process.spawn).mock.calls[0]
      expect((options as { env?: NodeJS.ProcessEnv }).env?.ORBIT_HOST_BUNDLE_ID).toBe(
        'dev.orbitscore.OrbitStudio',
      )
      expect(appendLine).toHaveBeenCalledWith(
        expect.stringContaining('Plugin window host bundle ID: dev.orbitscore.OrbitStudio'),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes an inherited stale host bundle ID when resolution fails', async () => {
    process.env.ORBIT_HOST_BUNDLE_ID = 'stale.bundle.id'
    Object.defineProperty(process, 'execPath', {
      value: '/usr/local/bin/node',
      configurable: true,
    })
    const appendLine = vi.fn()
    ext.__setOutputChannelForTest({ appendLine, append: () => {} })
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess().proc)

    await ext.startEngineForAgent()

    const [, , options] = vi.mocked(child_process.spawn).mock.calls[0]
    expect((options as { env?: NodeJS.ProcessEnv }).env).not.toHaveProperty('ORBIT_HOST_BUNDLE_ID')
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('not inside a macOS .app'))
  })
})
