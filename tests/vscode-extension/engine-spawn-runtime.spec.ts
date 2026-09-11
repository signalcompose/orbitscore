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
import * as path from 'path'

import * as vscode from 'vscode'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  extensionEngineFileExists,
  resolveDaemonBinaryForExtension,
} from '../../packages/vscode-extension/src/engine-startup-runtime'
import * as ext from '../../packages/vscode-extension/src/extension'
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
  beforeEach(() => {
    vi.mocked(extensionEngineFileExists).mockClear()
    vi.mocked(resolveDaemonBinaryForExtension).mockClear()
    resetExtensionEngineTestState(ext)
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined)
  })

  afterEach(() => {
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
})
