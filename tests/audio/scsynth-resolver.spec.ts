/**
 * scsynth-resolver tests.
 *
 * `fs` と `child_process` を mock して、resolution 優先順位
 * (explicit / env / bundle / sc-app / spotlight) と全 miss 時の
 * `ScsynthNotFoundError` を検証する。
 *
 * SC.app の有無に依存しないため CI でも実行可能。
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resolveScsynthPath,
  ScsynthNotFoundError,
} from '../../packages/engine/src/audio/supercollider/scsynth-resolver'

vi.mock('fs')
vi.mock('child_process')

const mockedStatSync = vi.mocked(fs.statSync)
const mockedSpawnSync = vi.mocked(spawnSync)

const SC_APP_PATH = '/Applications/SuperCollider.app/Contents/Resources/scsynth'

/** isFile=true + execute bit を持つ stat を返す */
function execFileStat(): fs.Stats {
  return {
    isFile: () => true,
    mode: 0o755,
  } as unknown as fs.Stats
}

/** existsSync ではなく statSync を使うので ENOENT を投げる stat を返す */
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

  it('returns SC.app fallback when bundle missing', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === SC_APP_PATH) return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath()

    expect(result.source).toBe('sc-app')
    expect(result.path).toBe(SC_APP_PATH)
  })

  it('returns spotlight result as last resort', () => {
    const SPOT_PATH = '/Volumes/External/SuperCollider.app/Contents/Resources/scsynth'
    mockedStatSync.mockImplementation((p) => {
      if (p === SPOT_PATH) return execFileStat()
      return notFoundStat()
    })
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: '/Volumes/External/SuperCollider.app\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as any)

    const result = resolveScsynthPath()

    expect(result.source).toBe('spotlight')
    expect(result.path).toBe(SPOT_PATH)
  })

  it('throws ScsynthNotFoundError with searched paths when all candidates miss', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as any)

    let caught: ScsynthNotFoundError | null = null
    try {
      resolveScsynthPath()
    } catch (e) {
      caught = e as ScsynthNotFoundError
    }

    expect(caught).toBeInstanceOf(ScsynthNotFoundError)
    expect(caught?.searched.length).toBeGreaterThanOrEqual(2)
    expect(caught?.searched).toContain(SC_APP_PATH)
  })

  it('treats existing-but-not-executable file as miss', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/explicit/scsynth') {
        return { isFile: () => true, mode: 0o644 } as unknown as fs.Stats
      }
      if (p === SC_APP_PATH) return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath({ explicit: '/explicit/scsynth' })

    expect(result.source).toBe('sc-app')
    expect(result.searched).toContain('/explicit/scsynth')
  })

  it('treats directory as miss (not a regular file)', () => {
    mockedStatSync.mockImplementation((p) => {
      if (p === '/dir/scsynth') {
        return { isFile: () => false, mode: 0o755 } as unknown as fs.Stats
      }
      if (p === SC_APP_PATH) return execFileStat()
      return notFoundStat()
    })

    const result = resolveScsynthPath({ explicit: '/dir/scsynth' })

    expect(result.source).toBe('sc-app')
  })

  it('handles spotlight failure gracefully (non-zero exit)', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'mdfind: error',
      pid: 0,
      output: [],
      signal: null,
    } as any)

    expect(() => resolveScsynthPath()).toThrow(ScsynthNotFoundError)
  })

  it('handles spotlight throwing (e.g. mdfind not found)', () => {
    mockedStatSync.mockImplementation(() => notFoundStat())
    mockedSpawnSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    expect(() => resolveScsynthPath()).toThrow(ScsynthNotFoundError)
  })
})
