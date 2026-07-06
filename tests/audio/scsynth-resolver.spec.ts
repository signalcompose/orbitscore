/**
 * scsynth-resolver tests.
 *
 * `fs` を mock して、resolution 優先順位 (explicit / env / bundle) と
 * 全 miss 時の `ScsynthNotFoundError` を検証する。
 *
 * Strict mode (Issue #136): SC.app / Spotlight への暗黙 fallback は持たないため、
 * bundle が無ければ explicit / env で明示する以外に解決手段はない。
 *
 * Issue #383: explicit / env が「存在するが実行不可」の場合の `ScsynthNotExecutableError`
 * (silent substitution 防止) も検証する。
 *
 * SC.app の有無に依存しないため CI でも実行可能。
 */

import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resolveScsynthPath,
  ScsynthNotExecutableError,
  ScsynthNotFoundError,
} from '../../packages/engine/src/audio/supercollider/scsynth-resolver'

vi.mock('fs')

const mockedStatSync = vi.mocked(fs.statSync)

/** isFile=true + execute bit を持つ stat を返す */
function execFileStat(): fs.Stats {
  return {
    isFile: () => true,
    mode: 0o755,
  } as unknown as fs.Stats
}

/** ENOENT を投げる stat を返す */
function notFoundStat(): never {
  const err = new Error('ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  throw err
}

describe('resolveScsynthPath', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.ORBIT_SCSYNTH_PATH
  })

  afterEach(() => {
    delete process.env.ORBIT_SCSYNTH_PATH
  })

  it('returns explicit path when caller provides one and it is executable', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/custom/scsynth') return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath({ explicit: '/custom/scsynth' })

    expect(result.path).toBe('/custom/scsynth')
    expect(result.source).toBe('explicit')
    expect(result.searched).toEqual(['/custom/scsynth'])
  })

  it('falls through explicit when file is missing and tries env next', () => {
    process.env.ORBIT_SCSYNTH_PATH = '/env/scsynth'
    mockedStatSync.mockImplementation((p) => {
      if (p === '/env/scsynth') return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath({ explicit: '/missing/scsynth' })

    expect(result.source).toBe('env')
    expect(result.path).toBe('/env/scsynth')
    expect(result.searched).toEqual(['/missing/scsynth', '/env/scsynth'])
  })

  it('returns env path when ORBIT_SCSYNTH_PATH is set and executable', () => {
    process.env.ORBIT_SCSYNTH_PATH = '/env/scsynth'
    mockedStatSync.mockImplementation((p) => {
      if (p === '/env/scsynth') return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath()

    expect(result.source).toBe('env')
    expect(result.path).toBe('/env/scsynth')
  })

  it('returns bundle path when bundled binary exists', () => {
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('/scsynth/Contents/Resources/scsynth')) return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath()

    expect(result.source).toBe('bundle')
    expect(result.path).toMatch(/\/scsynth\/Contents\/Resources\/scsynth$/)
  })

  it('throws ScsynthNotFoundError when bundle is missing and no explicit/env given (strict mode)', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught).toBeInstanceOf(ScsynthNotFoundError)
    // bundle 候補のみ searched に入る (explicit/env なしのため)
    expect(caught?.searched.length).toBe(1)
    expect(caught?.searched[0]).toMatch(/\/scsynth\/Contents\/Resources\/scsynth$/)
    // SC.app への暗黙 fallback がないことを確認
    expect(caught?.searched).not.toContain(
      '/Applications/SuperCollider.app/Contents/Resources/scsynth',
    )
  })

  it('throws ScsynthNotFoundError with all attempted paths when explicit + env + bundle all miss', () => {
    process.env.ORBIT_SCSYNTH_PATH = '/env/missing'
    mockedStatSync.mockImplementation(() => notFoundStat())

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath({ explicit: '/explicit/missing' })
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught).toBeInstanceOf(ScsynthNotFoundError)
    expect(caught?.searched).toContain('/explicit/missing')
    expect(caught?.searched).toContain('/env/missing')
    expect(caught?.searched.length).toBe(3) // explicit + env + bundle
  })

  it('error message guides developers to set ORBIT_SCSYNTH_PATH', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught?.message).toContain('ORBIT_SCSYNTH_PATH')
  })

  it('throws ScsynthNotExecutableError when explicit path exists but is not executable', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/explicit/scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      return notFoundStat()
    })

    expect(() => resolveScsynthPath({ explicit: '/explicit/scsynth' })).toThrow(
      ScsynthNotExecutableError,
    )
  })

  it('does not silently fall through to bundle when explicit exists but is not executable', () => {
    // bundle は viable だが、explicit override が壊れている場合は silent substitution せず
    // fail loud する (Issue #383)。
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/explicit/broken-scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      if (s.endsWith('/scsynth/Contents/Resources/scsynth')) return execFileStat()
      return notFoundStat()
    })

    let caught: ScsynthNotExecutableError | null = null
    try {
      resolveScsynthPath({ explicit: '/explicit/broken-scsynth' })
    } catch (e) {
      caught = e as ScsynthNotExecutableError
    }

    expect(caught).toBeInstanceOf(ScsynthNotExecutableError)
    expect(caught?.path).toBe('/explicit/broken-scsynth')
    expect(caught?.source).toBe('explicit')
  })

  it('does not silently fall through to bundle when env exists but is not executable', () => {
    process.env.ORBIT_SCSYNTH_PATH = '/env/broken-scsynth'
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/env/broken-scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      if (s.endsWith('/scsynth/Contents/Resources/scsynth')) return execFileStat()
      return notFoundStat()
    })

    let caught: ScsynthNotExecutableError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotExecutableError
    }

    expect(caught).toBeInstanceOf(ScsynthNotExecutableError)
    expect(caught?.path).toBe('/env/broken-scsynth')
    expect(caught?.source).toBe('env')
  })

  it('does not fall through from broken explicit to a viable env candidate', () => {
    // override 同士 (explicit → env) でも silent substitution は起きない。
    process.env.ORBIT_SCSYNTH_PATH = '/env/scsynth'
    mockedStatSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/explicit/broken-scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      if (s === '/env/scsynth') return execFileStat()
      return notFoundStat()
    })

    expect(() => resolveScsynthPath({ explicit: '/explicit/broken-scsynth' })).toThrow(
      ScsynthNotExecutableError,
    )
  })

  it('ScsynthNotExecutableError message mentions chmod guidance', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/explicit/scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      return notFoundStat()
    })

    let caught: ScsynthNotExecutableError | null = null
    try {
      resolveScsynthPath({ explicit: '/explicit/scsynth' })
    } catch (e) {
      caught = e as ScsynthNotExecutableError
    }

    expect(caught?.message).toContain('chmod')
    expect(caught?.message).toContain('/explicit/scsynth')
  })

  it('treats directory as miss (not a regular file)', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/dir/scsynth') {
        return { isFile: () => false, mode: 0o755 } as unknown as fs.Stats
      }
      return notFoundStat()
    })

    expect(() => resolveScsynthPath({ explicit: '/dir/scsynth' })).toThrow(ScsynthNotFoundError)
  })

  it('never references SuperCollider.app in any code path (no SC.app/Spotlight fallback)', () => {
    // strict mode の核心: searched に SuperCollider.app の path が一切現れない
    // (SC.app fallback も Spotlight 探索もゼロ)。bundle 候補のみ試される。
    mockedStatSync.mockImplementation(() => notFoundStat())

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught).toBeInstanceOf(ScsynthNotFoundError)
    // SuperCollider.app を含む path がいかなる形でも出てこない
    expect(caught?.searched.some((p) => p.includes('SuperCollider.app'))).toBe(false)
  })
})
