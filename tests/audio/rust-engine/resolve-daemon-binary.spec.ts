/**
 * DaemonClient の daemon binary 解決 (resolveDaemonBinary) の viability filter を検証する。
 *
 * `fs` を mock して、resolution 優先順位 (explicit / env / monorepo release / debug) と
 * explicit/env override が「存在するが実行不可」の場合に silent substitution せず
 * `DaemonNotExecutableError` を fail loud する挙動 (Issue #383, scsynth-resolver.ts と対称) を検証する。
 */

import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'
import {
  DaemonNotExecutableError,
  DaemonNotFoundError,
} from '../../../packages/engine/src/audio/rust-engine/errors'

vi.mock('fs')

const mockedStatSync = vi.mocked(fs.statSync)

interface PrivateResolver {
  resolveDaemonBinary: (explicitPath: string | undefined) => string
}

function resolve(explicitPath?: string): string {
  const client = new DaemonClient()
  return (client as unknown as PrivateResolver).resolveDaemonBinary(explicitPath)
}

/** isFile=true + execute bit を持つ stat を返す */
function execFileStat(): fs.Stats {
  return {
    isFile: () => true,
    mode: 0o755,
  } as unknown as fs.Stats
}

/** isFile=true だが execute bit を持たない stat を返す */
function nonExecFileStat(): fs.Stats {
  return {
    isFile: () => true,
    mode: 0o644,
  } as unknown as fs.Stats
}

/** ENOENT を投げる stat を返す */
function notFoundStat(): never {
  const err = new Error('ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  throw err
}

describe('DaemonClient#resolveDaemonBinary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.ORBIT_AUDIO_DAEMON_PATH
  })

  afterEach(() => {
    delete process.env.ORBIT_AUDIO_DAEMON_PATH
  })

  it('returns explicit path when it is executable', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/custom/daemon') return execFileStat()
      return notFoundStat()
    })

    expect(resolve('/custom/daemon')).toBe('/custom/daemon')
  })

  it('falls through to env when explicit is missing (not present)', () => {
    process.env.ORBIT_AUDIO_DAEMON_PATH = '/env/daemon'
    mockedStatSync.mockImplementation((p) => {
      if (p === '/env/daemon') return execFileStat()
      return notFoundStat()
    })

    expect(resolve(undefined)).toBe('/env/daemon')
  })

  it('falls through explicit/env to monorepo candidates when both are absent', () => {
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('rust/target/release/orbit-audio-daemon')) return execFileStat()
      return notFoundStat()
    })

    expect(resolve(undefined)).toMatch(/rust\/target\/release\/orbit-audio-daemon$/)
  })

  it('falls through release to debug within monorepo auto-discovery', () => {
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('rust/target/debug/orbit-audio-daemon')) return execFileStat()
      return notFoundStat()
    })

    expect(resolve(undefined)).toMatch(/rust\/target\/debug\/orbit-audio-daemon$/)
  })

  it('throws DaemonNotFoundError when every candidate is absent', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())

    expect(() => resolve(undefined)).toThrow(DaemonNotFoundError)
  })

  it('throws DaemonNotExecutableError for broken explicit even when release is viable', () => {
    // silent substitution 防止: explicit override が壊れていても monorepo 候補へ黙って
    // fall-through してはいけない (Issue #383)。
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/broken/daemon') return nonExecFileStat()
      if (s.endsWith('rust/target/release/orbit-audio-daemon')) return execFileStat()
      return notFoundStat()
    })

    let caught: DaemonNotExecutableError | null = null
    try {
      resolve('/broken/daemon')
    } catch (e) {
      caught = e as DaemonNotExecutableError
    }

    expect(caught).toBeInstanceOf(DaemonNotExecutableError)
    expect(caught?.path).toBe('/broken/daemon')
    expect(caught?.source).toBe('explicit')
  })

  it('throws DaemonNotExecutableError for broken env even when monorepo release is viable', () => {
    process.env.ORBIT_AUDIO_DAEMON_PATH = '/broken/env-daemon'
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/broken/env-daemon') return nonExecFileStat()
      if (s.endsWith('rust/target/release/orbit-audio-daemon')) return execFileStat()
      return notFoundStat()
    })

    let caught: DaemonNotExecutableError | null = null
    try {
      resolve(undefined)
    } catch (e) {
      caught = e as DaemonNotExecutableError
    }

    expect(caught).toBeInstanceOf(DaemonNotExecutableError)
    expect(caught?.path).toBe('/broken/env-daemon')
    expect(caught?.source).toBe('env')
  })

  it('does not fall through from broken explicit to a viable env candidate', () => {
    process.env.ORBIT_AUDIO_DAEMON_PATH = '/env/daemon'
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/broken/daemon') return nonExecFileStat()
      if (s === '/env/daemon') return execFileStat()
      return notFoundStat()
    })

    expect(() => resolve('/broken/daemon')).toThrow(DaemonNotExecutableError)
  })

  it('DaemonNotExecutableError message mentions chmod guidance', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/broken/daemon') return nonExecFileStat()
      return notFoundStat()
    })

    let caught: DaemonNotExecutableError | null = null
    try {
      resolve('/broken/daemon')
    } catch (e) {
      caught = e as DaemonNotExecutableError
    }

    expect(caught?.message).toContain('chmod')
    expect(caught?.message).toContain('/broken/daemon')
  })
})
