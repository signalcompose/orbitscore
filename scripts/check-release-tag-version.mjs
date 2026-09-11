#!/usr/bin/env node
// Verify a release tag agrees with the version `vsce package` will stamp on the .vsix.
//
// 🔴 Why this exists: `vsce package` names the asset from
// packages/vscode-extension/package.json, NOT from the tag. Pushing `v3.0.0` while
// package.json still says `2.1.0` produces a GitHub Release *titled* v3.0.0 whose only
// asset is `orbitscore-darwin-arm64-2.1.0.vsix`. Nothing errors; the mismatch is visible
// only to whoever downloads it.
//
// Comparison is on the X.Y.Z core only. The convention in this repo is that a prerelease
// suffix lives in the tag and not in package.json — measured on the existing tags:
// v1.1.0-rc1 / -rc2 / -rc3 and v1.0.1-rc1 each sat on a bare package.json version.
// The package side is passed through the same strip so a suffixed package.json still matches
// a tag carrying the same core (see the spec test for that case); nothing in the repo produces
// one today, but silently disagreeing about it would be worse than being explicit.
//
// 🔴 This is the CI half of a check the release design already specifies:
// `docs/design/656-release-design.md` §4.4 puts the same comparison in the LOCAL preflight of
// `scripts/orbitstudio/make-local-release.sh` (#659), i.e. BEFORE the tag is created. That is
// the better place — a pushed tag is semi-public and recovering means deleting the remote tag
// and re-tagging. This module exports `checkTagAgainstVersion` / `versionCore` precisely so
// that preflight can import them instead of writing the rule a second time.
//
// 🔴 §4.4 also settles what does NOT move with the tag: `ENGINE_VERSION` (session-log meta
// header) and `DSL_VERSION` (spec version) are SEPARATE AXES and are deliberately not synced
// to the extension version. Only `packages/vscode-extension/package.json` is the 正本.
//
// Usage:
//   node scripts/check-release-tag-version.mjs v3.0.0
//   node scripts/check-release-tag-version.mjs            # reads $TAG (CI)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Strip a leading `v` and any prerelease/build suffix, leaving the X.Y.Z core. */
export function versionCore(value) {
  return value.replace(/^v/, '').split(/[-+]/, 1)[0]
}

/**
 * Compare a tag against the version that will be packaged.
 * Returns `{ ok: true, core }` or `{ ok: false, message }` — it never throws or exits, so
 * the same function is callable from a test.
 */
export function checkTagAgainstVersion(tag, packageVersion, vsixTarget = 'darwin-arm64') {
  if (!tag) {
    return { ok: false, message: 'No tag given. Pass one as an argument or set $TAG.' }
  }
  if (!/^v\d+\.\d+\.\d+([-+].*)?$/.test(tag)) {
    return {
      ok: false,
      message: `Tag "${tag}" is not of the form vX.Y.Z[-suffix]. release.yml only triggers on v* tags, and only a bare vX.Y.Z is treated as a stable release.`,
    }
  }
  const tagCore = versionCore(tag)
  const packageCore = versionCore(packageVersion)
  if (tagCore !== packageCore) {
    return {
      ok: false,
      message:
        `Tag ${tag} carries version ${tagCore} but packages/vscode-extension/package.json is ${packageVersion}. ` +
        `The .vsix would be named orbitscore-${vsixTarget}-${packageVersion}.vsix while the Release is titled ${tag}. ` +
        `Bump package.json (and re-tag) so the two agree.`,
    }
  }
  return { ok: true, core: tagCore }
}

function main() {
  const tag = process.argv[2] ?? process.env.TAG ?? ''
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = join(here, '..', 'packages', 'vscode-extension', 'package.json')
  const packageVersion = JSON.parse(readFileSync(manifest, 'utf8')).version
  const result = checkTagAgainstVersion(tag, packageVersion, process.env.VSIX_TARGET)
  if (!result.ok) {
    // `::error::` is the GitHub Actions annotation form; harmless noise in a local run.
    console.error(`::error::${result.message}`)
    process.exit(1)
  }
  console.log(`Tag ${tag} matches the packaged version ${packageVersion}`)
}

// Only run when invoked as a script, so importing it from a test does not exit the process.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
