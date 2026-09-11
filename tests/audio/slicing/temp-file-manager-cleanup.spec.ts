import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TempFileManager } from '../../../packages/engine/src/audio/slicing/temp-file-manager'

/**
 * `TempFileManager`'s constructor sweeps `os.tmpdir()` for orphaned `orbitscore_*` directories
 * older than an hour. It lists them with `readdirSync` and then `statSync`s each one — a window
 * in which ANOTHER engine instance's identical sweep can remove the same directory.
 *
 * 🔴 Why this is worth a test rather than a shrug: engine stderr is classified as `ERROR:` by
 * the log reader, so a benign race used to inflate the ERROR count and fail whichever gated
 * test happened to be counting. Measured on PR #840's merge gate (2026-09-11):
 * "expected 9 to be less than or equal to 8", the extra line being
 * `Failed to cleanup old directories: ENOENT ... orbitscore_1789065642138_xx52jsw`.
 */
describe('TempFileManager cleanup race (#855)', () => {
  let root: string
  let warn: ReturnType<typeof vi.spyOn>
  let previousTmpdir: string | undefined

  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600 * 1000)

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-race-'))
    // `os.tmpdir()` is a non-configurable binding, so point it at the sandbox through the env
    // it actually reads (POSIX consults TMPDIR on every call, it is not cached).
    previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = root
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** An orphan old enough for the sweep to want it gone. */
  function makeStaleOrphan(name: string): string {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.utimesSync(dir, TWO_HOURS_AGO, TWO_HOURS_AGO)
    return dir
  }

  it('removes a stale orphan directory', () => {
    const stale = makeStaleOrphan('orbitscore_1_aaaaaaa')

    new TempFileManager()

    expect(fs.existsSync(stale)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a fresh orphan directory', () => {
    // Only directories older than an hour are swept — a live sibling instance must survive.
    const fresh = path.join(root, 'orbitscore_2_bbbbbbb')
    fs.mkdirSync(fresh, { recursive: true })

    new TempFileManager()

    expect(fs.existsSync(fresh)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never touches a stale directory that is not ours', () => {
    // 🔴 This sweep runs on the SHARED `os.tmpdir()`, and it deletes anything older than an
    // hour. The `orbitscore_` prefix is the only thing standing between it and another
    // application's temp directory. Found by mutation: dropping the prefix check left all
    // other tests green.
    const foreign = path.join(root, 'someone-elses-app_cache')
    fs.mkdirSync(foreign, { recursive: true })
    fs.writeFileSync(path.join(foreign, 'their-data.bin'), 'do not delete me')
    fs.utimesSync(foreign, TWO_HOURS_AGO, TWO_HOURS_AGO)
    const ours = makeStaleOrphan('orbitscore_9_fffffff')

    new TempFileManager()

    expect(fs.existsSync(foreign)).toBe(true)
    expect(fs.readFileSync(path.join(foreign, 'their-data.bin'), 'utf8')).toBe('do not delete me')
    // …while still doing its actual job on the same pass.
    expect(fs.existsSync(ours)).toBe(false)
  })

  it('stays silent when a listed entry cannot be stat-ed because it is already gone (the race)', () => {
    // 🔴 Reproduced with a REAL filesystem condition, not a mocked `statSync`: a dangling
    // symlink makes `statSync` throw the genuine ENOENT this guard exists for, with the
    // genuine message. A fabricated mock error could drift from what Node actually raises.
    const vanished = path.join(root, 'orbitscore_3_ccccccc')
    fs.symlinkSync(path.join(root, 'this-target-never-existed'), vanished)
    const stale = makeStaleOrphan('orbitscore_4_ddddddd')

    new TempFileManager()

    // The race is the expected outcome, not a failure: no warning, and the sweep must keep
    // going — one vanished entry must not abandon the entries listed after it.
    expect(warn).not.toHaveBeenCalled()
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('still reports a stat failure that is NOT the race', () => {
    // The guard must stay narrow: silencing every stat failure would hide a real problem.
    // A self-referential symlink makes `statSync` raise a genuine ELOOP while it follows the
    // link — reachable through the public constructor, unlike a permission change on the temp
    // root (that would stop the constructor's own mkdir before the sweep ever runs).
    const loop = path.join(root, 'orbitscore_5_eeeeeee')
    fs.symlinkSync(loop, loop)

    new TempFileManager()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('ELOOP')
  })
})
