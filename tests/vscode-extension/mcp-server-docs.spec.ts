import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  readDevDoc,
  resolveDocsFilePath,
  resolveDocsRoot,
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

  it('readDevDoc returns null for a file removed after the existsSync check (TOCTOU)', () => {
    const root = temporaryDirectory()
    const filePath = path.join(root, 'gone.md')
    fs.writeFileSync(filePath, '# will be deleted')
    fs.rmSync(filePath)

    expect(readDevDoc(root, 'gone.md')).toBeNull()
  })
})
