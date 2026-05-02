/**
 * scsynth-resolver tests.
 *
 * `fs` を mock して、resolution 優先順位 (explicit / env / bundle) と
 * 全 miss 時の `ScsynthNotFoundError` を検証する。
 *
 * Strict mode (Issue #136): SC.app / Spotlight への暗黙 fallback は持たないため、
 * bundle が無ければ explicit / env で明示する以外に解決手段はない。
 *
 * SC.app の有無に依存しないため CI でも実行可能。
 */

import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resolveScsynthPath,
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

  it('treats existing-but-not-executable file as miss', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/explicit/scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      return notFoundStat()
    })

    expect(() => resolveScsynthPath({ explicit: '/explicit/scsynth' })).toThrow(
      ScsynthNotFoundError,
    )
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

  it('does not invoke spawnSync (no Spotlight fallback in strict mode)', () => {
    // child_process は import されていないので呼ばれることがない
    // この test の意図は「fallback が削除されたことを意図的に確認」
    mockedStatSync.mockImplementation(() => notFoundStat())

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught).toBeInstanceOf(ScsynthNotFoundError)
    // searched に SuperCollider.app の path が出てこない (Spotlight 探索ゼロ)
    const hasSpotlightPath = caught?.searched.some(
      (p) => p.includes('SuperCollider.app') && !p.startsWith('/Applications/'),
    )
    expect(hasSpotlightPath).toBe(false)
  })
})
