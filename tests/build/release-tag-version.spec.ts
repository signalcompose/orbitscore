import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script with no type declarations; this spec is its only consumer.
import { checkTagAgainstVersion, versionCore } from '../../scripts/check-release-tag-version.mjs'

const REPO_ROOT = join(__dirname, '..', '..')

describe('release tag / packaged version guard (#843)', () => {
  it('accepts a tag whose X.Y.Z core matches package.json', () => {
    expect(checkTagAgainstVersion('v3.0.0', '3.0.0')).toEqual({ ok: true, core: '3.0.0' })
  })

  it('rejects the exact failure this guard exists for: a bumped tag on a stale package.json', () => {
    const result = checkTagAgainstVersion('v3.0.0', '2.1.0')
    expect(result.ok).toBe(false)
    // The message must name BOTH versions and the asset filename — that filename is the
    // only place the mismatch would otherwise have surfaced.
    expect(result.message).toContain('v3.0.0')
    expect(result.message).toContain('2.1.0')
    expect(result.message).toContain('orbitscore-darwin-arm64-2.1.0.vsix')
  })

  it('accepts a prerelease tag against a bare package.json version', () => {
    // Established convention, measured on the existing tags: v1.1.0-rc1 / -rc2 / -rc3 and
    // v1.0.1-rc1 all sat on a package.json carrying no suffix.
    expect(checkTagAgainstVersion('v1.1.0-rc1', '1.1.0').ok).toBe(true)
    expect(checkTagAgainstVersion('v1.0.1-rc1', '1.0.1').ok).toBe(true)
  })

  it('accepts a suffixed package.json when the tag carries the same core', () => {
    // Nothing in the repo produces a suffixed package.json today (the convention keeps the
    // suffix on the tag). The strip is applied to both sides anyway, so make that explicit
    // rather than leaving an untested branch — `/simplify` flagged exactly this gap.
    expect(checkTagAgainstVersion('v1.1.0-rc1', '1.1.0-rc1').ok).toBe(true)
    expect(checkTagAgainstVersion('v1.1.0', '1.1.0-rc1').ok).toBe(true)
  })

  it('still rejects a prerelease tag whose core disagrees', () => {
    // Suffix-stripping must not become a way to smuggle a wrong core past the guard.
    expect(checkTagAgainstVersion('v3.0.0-rc1', '2.1.0').ok).toBe(false)
  })

  it('rejects a tag that is not vX.Y.Z', () => {
    for (const tag of ['sigmus-2026-08-29', 'v3.0', 'release-3.0.0', '3.0.0', '']) {
      expect(checkTagAgainstVersion(tag, '3.0.0').ok, `tag ${JSON.stringify(tag)}`).toBe(false)
    }
  })

  it('strips both prerelease and build metadata when taking the core', () => {
    expect(versionCore('v1.2.3')).toBe('1.2.3')
    expect(versionCore('v1.2.3-rc1')).toBe('1.2.3')
    expect(versionCore('1.2.3+build7')).toBe('1.2.3')
  })

  it('release.yml runs the script on tag pushes, before npm ci', () => {
    // The guard is worthless if the workflow stops calling it, or calls it after the
    // 25-minute build it is meant to short-circuit.
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
    const guardAt = workflow.indexOf('node scripts/check-release-tag-version.mjs')
    const npmCiAt = workflow.indexOf('run: npm ci')
    expect(guardAt, 'release.yml must call the guard script').toBeGreaterThan(-1)
    expect(npmCiAt).toBeGreaterThan(-1)
    expect(guardAt, 'the guard must run before npm ci').toBeLessThan(npmCiAt)
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')")
  })
})
