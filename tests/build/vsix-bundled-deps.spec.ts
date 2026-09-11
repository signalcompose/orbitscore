import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain .mjs script with no type declarations; this spec is its only consumer.
import {
  bundleSpecs,
  declaredDependencyNames,
  findMissingBundledDeps,
} from '../../scripts/check-vsix-bundled-deps.mjs'

const REPO_ROOT = path.resolve(__dirname, '../..')
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts/check-vsix-bundled-deps.mjs')

type BundleSpec = ReturnType<typeof bundleSpecs>[number]

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function makeFixture(): {
  root: string
  packageJson: string
  spec: BundleSpec
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-vsix-deps-'))
  const packageJson = path.join(root, 'source-package.json')
  const resolveFromPath = 'extension/dist/entry.js'
  const nodeModulesPath = 'extension/dist/node_modules'

  writeJson(packageJson, { dependencies: { direct: '^1.0.0' } })
  fs.mkdirSync(path.join(root, path.dirname(resolveFromPath)), { recursive: true })
  fs.writeFileSync(path.join(root, resolveFromPath), '// resolution anchor\n')
  writeJson(path.join(root, nodeModulesPath, 'direct/package.json'), {
    name: 'direct',
    version: '1.0.0',
    main: 'dist/index.js',
    dependencies: { transitive: '^1.0.0' },
  })
  // Real packages such as @modelcontextprotocol/sdk put a type-only package.json below
  // their package root. The graph walk must not mistake that for the dependency manifest.
  writeJson(path.join(root, nodeModulesPath, 'direct/dist/package.json'), { type: 'commonjs' })
  fs.writeFileSync(
    path.join(root, nodeModulesPath, 'direct/dist/index.js'),
    'module.exports = {}\n',
  )
  writeJson(path.join(root, nodeModulesPath, 'transitive/package.json'), {
    name: 'transitive',
    version: '1.0.0',
    main: 'index.js',
  })
  fs.writeFileSync(path.join(root, nodeModulesPath, 'transitive/index.js'), 'module.exports = {}\n')

  return {
    root,
    packageJson,
    spec: {
      label: 'fixture',
      packageJsonPath: packageJson,
      nodeModulesPath,
      resolveFromPath,
      resolveSpecifiers: ['direct'],
    },
  }
}

function makeCliFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-vsix-gate-'))
  for (const spec of bundleSpecs()) {
    const fromFile = path.join(root, spec.resolveFromPath)
    fs.mkdirSync(path.dirname(fromFile), { recursive: true })
    fs.writeFileSync(fromFile, '// resolution anchor\n')

    const dependencyNames = declaredDependencyNames(path.join(REPO_ROOT, spec.packageJsonPath))
    for (const name of dependencyNames) {
      const packageDir = path.dirname(path.join(REPO_ROOT, spec.packageJsonPath))
      const candidates = [
        path.join(packageDir, 'node_modules', name),
        path.join(REPO_ROOT, 'node_modules', name),
      ]
      const source = candidates.find((candidate) => fs.existsSync(candidate))
      if (!source) throw new Error(`installed package not found for fixture: ${name}`)
      const destination = path.join(root, spec.nodeModulesPath, name)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.symlinkSync(source, destination, 'dir')
    }
  }
  return root
}

describe('packaged .vsix runtime dependency gate (#874)', () => {
  it('defines both shipped runtime roots and their real resolution anchors', () => {
    expect(bundleSpecs()).toEqual([
      {
        label: 'engine',
        packageJsonPath: 'packages/engine/package.json',
        nodeModulesPath: 'extension/engine/node_modules',
        resolveFromPath: 'extension/engine/dist/cli-audio.js',
        resolveSpecifiers: 'declared-dependencies',
      },
      {
        label: 'extension',
        packageJsonPath: 'packages/vscode-extension/package.json',
        nodeModulesPath: 'extension/dist/node_modules',
        resolveFromPath: 'extension/dist/mcp-server.js',
        resolveSpecifiers: [
          '@modelcontextprotocol/sdk/server/mcp.js',
          '@modelcontextprotocol/sdk/server/streamableHttp.js',
          'zod',
        ],
      },
    ])
  })

  it('returns no missing dependency or unresolved specifier when the tree is complete', () => {
    const fixture = makeFixture()
    try {
      expect(findMissingBundledDeps(fixture.root, fixture.spec)).toEqual({
        missingDependencies: [],
        unresolvedSpecifiers: [],
      })
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('names a declared dependency whose directory is missing', () => {
    const fixture = makeFixture()
    try {
      fs.rmSync(path.join(fixture.root, fixture.spec.nodeModulesPath, 'direct'), {
        recursive: true,
      })
      expect(findMissingBundledDeps(fixture.root, fixture.spec).missingDependencies).toEqual([
        'direct',
      ])
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('names the requested specifier when one of its transitive dependencies is missing', () => {
    const fixture = makeFixture()
    try {
      fs.rmSync(path.join(fixture.root, fixture.spec.nodeModulesPath, 'transitive'), {
        recursive: true,
      })
      const result = findMissingBundledDeps(fixture.root, fixture.spec)
      expect(result.missingDependencies).toEqual([])
      expect(result.unresolvedSpecifiers.map((entry) => entry.specifier)).toEqual(['direct'])
      // The reported reason must name the transitive package that actually went
      // missing, not just the top-level specifier the caller asked about.
      expect(result.unresolvedSpecifiers[0]!.reason).toContain('transitive')
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing', {}],
    ['array', { dependencies: [] }],
    ['string', { dependencies: 'zod' }],
  ])('rejects a %s dependencies table', (_label, manifest) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-deps-json-'))
    const packageJson = path.join(root, 'package.json')
    try {
      writeJson(packageJson, manifest)
      expect(() => declaredDependencyNames(packageJson)).toThrow(/dependencies/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts an explicitly empty dependencies object', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-deps-json-'))
    const packageJson = path.join(root, 'package.json')
    try {
      writeJson(packageJson, { dependencies: {} })
      expect(declaredDependencyNames(packageJson)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('CLI exits 0 for a complete tree and nonzero with the specifier for a broken tree', () => {
    const root = makeCliFixture()
    try {
      expect(() => execFileSync('node', [GATE_SCRIPT, root], { stdio: 'pipe' })).not.toThrow()

      fs.rmSync(path.join(root, 'extension/dist/node_modules/zod'), {
        recursive: true,
      })
      try {
        execFileSync('node', [GATE_SCRIPT, root], { stdio: 'pipe' })
        throw new Error('dependency gate unexpectedly exited 0')
      } catch (error) {
        const result = error as { status?: number; stderr?: Buffer }
        expect(result.status).not.toBe(0)
        expect(result.stderr?.toString()).toContain('zod')
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
