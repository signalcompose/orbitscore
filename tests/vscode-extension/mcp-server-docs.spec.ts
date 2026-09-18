import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEV_DOCS_UNAVAILABLE_MESSAGE,
  readDevDoc,
  resolveDevDocsLocation,
  resolveDocsFilePath,
  resolveDocsRoot,
  resolveUserDocsLocation,
  searchDevDocs,
} from '../../packages/vscode-extension/src/mcp-server'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-docs-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('development docs helpers', () => {
  it('resolves the built docs root from a workspace base directory', () => {
    expect(resolveDocsRoot('/workspace/orbitscore')).toBe(
      path.resolve('/workspace/orbitscore/sites/dev/.vitepress/dist'),
    )
  })

  it('maps root and directory URLs to index.html and rejects traversal', () => {
    const root = '/workspace/orbitscore/sites/dev/.vitepress/dist'
    expect(resolveDocsFilePath(root, '/')).toBe(path.join(root, 'index.html'))
    expect(resolveDocsFilePath(root, '/guide/')).toBe(path.join(root, 'guide/index.html'))
    expect(resolveDocsFilePath(root, '/guide/page.html')).toBe(path.join(root, 'guide/page.html'))
    expect(resolveDocsFilePath(root, '/../secret.html')).toBeNull()
    expect(resolveDocsFilePath(root, '/%2e%2e/secret.html')).toBeNull()
  })

  it('reads Markdown and searches it case-insensitively without .vitepress files', () => {
    const root = temporaryDirectory()
    fs.mkdirSync(path.join(root, 'guide'), { recursive: true })
    fs.mkdirSync(path.join(root, '.vitepress'), { recursive: true })
    fs.writeFileSync(path.join(root, 'guide', 'intro.md'), '# Hello\nOrbitScore search target\n')
    fs.writeFileSync(path.join(root, '.vitepress', 'hidden.md'), 'search target')

    expect(readDevDoc(root, 'guide/intro.md')).toContain('OrbitScore')
    expect(readDevDoc(root, '../outside.md')).toBeNull()
    expect(readDevDoc(root, '')).toBeNull()
    expect(searchDevDocs(root, 'SEARCH')).toEqual([
      { path: 'guide/intro.md', line: 2, excerpt: 'OrbitScore search target' },
    ])
  })

  it('readDevDoc returns null when the read fails after existsSync passed (TOCTOU/EACCES)', () => {
    const root = temporaryDirectory()
    const filePath = path.join(root, 'race.md')
    fs.writeFileSync(filePath, '# racy')
    // Simulate the check-then-read race with a real fs error: the file exists
    // (existsSync passes) but the read itself throws EACCES. Without the
    // try/catch inside readDevDoc this call would throw instead of returning null.
    fs.chmodSync(filePath, 0o000)
    try {
      expect(readDevDoc(root, 'race.md')).toBeNull()
    } finally {
      fs.chmodSync(filePath, 0o600)
    }
  })

  it('searchDevDocs skips an unreadable file instead of aborting the walk', () => {
    const root = temporaryDirectory()
    fs.writeFileSync(path.join(root, 'bad.md'), 'search target broken')
    fs.writeFileSync(path.join(root, 'good.md'), 'search target ok')
    fs.chmodSync(path.join(root, 'bad.md'), 0o000)
    try {
      expect(searchDevDocs(root, 'search target')).toEqual([
        { path: 'good.md', line: 1, excerpt: 'search target ok' },
      ])
    } finally {
      fs.chmodSync(path.join(root, 'bad.md'), 0o600)
    }
  })
})

describe('resolveDevDocsLocation (#954 -- cold install has no dev site at all)', () => {
  it('is available when sites/dev exists under the base dir (a monorepo checkout)', () => {
    const base = temporaryDirectory()
    fs.mkdirSync(path.join(base, 'sites/dev'), { recursive: true })

    const location = resolveDevDocsLocation(base)

    expect(location.available).toBe(true)
    expect(location.sourceRoot).toBe(path.resolve(base, 'sites/dev'))
    expect(location.root).toBe(resolveDocsRoot(base))
  })

  it('is unavailable when sites/dev does not exist (cold install -- never bundled)', () => {
    const base = temporaryDirectory() // empty: no sites/dev at all

    const location = resolveDevDocsLocation(base)

    expect(location.available).toBe(false)
  })

  it('DEV_DOCS_UNAVAILABLE_MESSAGE names the published GitHub Pages URL', () => {
    expect(DEV_DOCS_UNAVAILABLE_MESSAGE).toContain(
      'https://signalcompose.github.io/orbitscore/dev/',
    )
  })
})

describe('resolveUserDocsLocation (#954 -- monorepo checkout wins over the bundled copy)', () => {
  it('picks the monorepo candidate when sites/user exists under the monorepo base', () => {
    const monorepoBase = temporaryDirectory()
    const extensionRoot = temporaryDirectory()
    fs.mkdirSync(path.join(monorepoBase, 'sites/user'), { recursive: true })
    // A stale bundled copy left over from a local `vsce package` run must NOT
    // shadow the live monorepo tree -- this is the scenario the doc comment on
    // resolveUserDocsLocation calls out by name.
    fs.mkdirSync(path.join(extensionRoot, 'sites/user'), { recursive: true })
    fs.writeFileSync(path.join(extensionRoot, 'sites/user', 'stale.md'), 'stale bundled copy')

    const location = resolveUserDocsLocation(monorepoBase, extensionRoot)

    expect(location.source).toBe('monorepo')
    expect(location.sourceRoot).toBe(path.resolve(monorepoBase, 'sites/user'))
  })

  it('falls back to the extension-bundled copy when no monorepo sites/user exists', () => {
    const monorepoBase = temporaryDirectory() // no sites/user here (cold install shape)
    const extensionRoot = temporaryDirectory()
    fs.mkdirSync(path.join(extensionRoot, 'sites/user'), { recursive: true })

    const location = resolveUserDocsLocation(monorepoBase, extensionRoot)

    expect(location.source).toBe('extension-bundle')
    expect(location.sourceRoot).toBe(path.resolve(extensionRoot, 'sites/user'))
  })
})
