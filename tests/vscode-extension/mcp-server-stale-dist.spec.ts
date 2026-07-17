/**
 * #480: stale dist（base 不一致ビルド）の検出。base 変更前の古い dist を配信すると
 * 全アセット 404 の素 HTML になる実害の再発防止。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { isDocsDistStale } from '../../packages/vscode-extension/src/mcp-server'

describe('isDocsDistStale (#480)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-dist-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns false for a dist built with the expected base', () => {
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<link rel="stylesheet" href="/orbitscore/dev/assets/style.css">',
    )
    expect(isDocsDistStale(dir, '/orbitscore/dev')).toBe(false)
  })

  it('returns true for a dist built with a different base (root-absolute assets)', () => {
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<link rel="stylesheet" href="/assets/style.css">',
    )
    expect(isDocsDistStale(dir, '/orbitscore/dev')).toBe(true)
  })

  it('returns false (defers to the not-built guard) when index.html is missing', () => {
    expect(isDocsDistStale(dir, '/orbitscore/dev')).toBe(false)
  })

  it('re-checks after index.html is rebuilt (mtime cache invalidation)', async () => {
    const idx = path.join(dir, 'index.html')
    fs.writeFileSync(idx, 'href="/assets/style.css"')
    expect(isDocsDistStale(dir, '/orbitscore/dev')).toBe(true)
    // mtime を確実に変える
    await new Promise((r) => setTimeout(r, 10))
    fs.writeFileSync(idx, 'href="/orbitscore/dev/assets/style.css"')
    fs.utimesSync(idx, new Date(), new Date(Date.now() + 1000))
    expect(isDocsDistStale(dir, '/orbitscore/dev')).toBe(false)
  })
})
