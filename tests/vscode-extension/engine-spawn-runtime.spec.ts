/**
 * engine を起動する Node ランタイムの決め方（#878）。
 *
 * 🔴 **`node` を PATH から引いてはいけない。** 拡張が Finder / launchd から起動された VS Code の
 * 中で動く時、PATH は `/etc/paths` の最小構成になる。`nodenv` / Homebrew で node を入れている
 * （珍しくない）環境ではそこに node は無く、engine は `spawn node ENOENT` で起動しない。
 * 症状は「エンジンが起動しない」だけで、原因が PATH だと利用者にはまず分からない。
 *
 * VS Code 自身がログインシェルの環境を解決して拡張ホストへ渡すので**運が良ければ通る**が、
 * それは VS Code の実装詳細への暗黙の依存であり、2026-09-12 に実際に通らない条件を特定した
 * （cold install した `.vsix` を CLI ラッパ経由 + 最小 PATH で起動すると確定で `ENOENT`）。
 *
 * 代わりに **VS Code 同梱の Node**（`process.execPath` を `ELECTRON_RUN_AS_NODE=1` で起動）を使う。
 * 実測（2026-09-12・この機械）: Node **24.18.1**（リポジトリの要求は `>=22.0.0`）で、
 * `@julusian/midi` のネイティブアドオン（N-API v7 prebuild）も素の node と同じく読める
 * （port count 14 で一致）。PATH には一切依存しない。
 */
import * as child_process from 'child_process'
import * as path from 'path'

import * as vscode from 'vscode'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  extensionEngineFileExists,
  resolveDaemonBinaryForExtension,
} from '../../packages/vscode-extension/src/engine-startup-runtime'
import * as ext from '../../packages/vscode-extension/src/extension'

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

function fakeSpawnedProcess(): child_process.ChildProcess {
  const proc: Partial<child_process.ChildProcess> = {
    killed: false,
    on: (() => proc) as child_process.ChildProcess['on'],
    stdout: { on: () => {} } as unknown as child_process.ChildProcess['stdout'],
    stderr: { on: () => {} } as unknown as child_process.ChildProcess['stderr'],
    stdin: { on: () => {} } as unknown as child_process.ChildProcess['stdin'],
  }
  return proc as child_process.ChildProcess
}

describe('engine spawn runtime (#878)', () => {
  beforeEach(() => {
    vi.mocked(extensionEngineFileExists).mockClear()
    vi.mocked(resolveDaemonBinaryForExtension).mockClear()
    ext.__setEngineProcessForTest(null)
    ext.__setStatusBarItemForTest({ text: '', tooltip: '' })
    ext.__setOutputChannelForTest({ appendLine: () => {}, append: () => {} })
    ext.__setEngineViewProviderForTest({ refresh: () => {} })
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.mocked(child_process.spawn).mockReset()
    vi.restoreAllMocks()
    ext.__setEngineProcessForTest(null)
  })

  it('spawns an absolute Node runtime instead of resolving "node" through PATH', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess())

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
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess())

    await ext.startEngineForAgent()

    const [, , options] = vi.mocked(child_process.spawn).mock.calls[0]
    const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env
    // 拡張ホストは Electron なので、`process.execPath` はそのままでは Node として動かない
    // （実測: 付けずに起動すると `Unable to find helper app` で落ちる）。
    expect(env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('still passes the engine entry point as the first argument', async () => {
    vi.mocked(child_process.spawn).mockImplementation(() => fakeSpawnedProcess())

    await ext.startEngineForAgent()

    const [, args] = vi.mocked(child_process.spawn).mock.calls[0]
    expect(Array.isArray(args)).toBe(true)
    expect(String((args as string[])[0])).toMatch(/cli-audio\.js$/)
  })
})
