#!/usr/bin/env node
// Verify that runtime dependencies resolve from the same files that load them in an
// unpacked .vsix. This deliberately checks the shipped tree, not the source checkout.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPT_DIR, '..')

/** The two runtime roots shipped in the .vsix and the specifiers loaded from each. */
export function bundleSpecs() {
  return [
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
  ]
}

/**
 * Read a package's declared production dependencies.
 * A missing or malformed table is an invalid checklist, while an explicit `{}` is valid.
 */
export function declaredDependencyNames(pkgJsonPath) {
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const dependencies = manifest.dependencies
  if (
    dependencies === null ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    throw new Error(
      `${pkgJsonPath}: dependencies must exist and be a JSON object (use {} for none)`,
    )
  }
  return Object.keys(dependencies).sort()
}

function packageManifestForResolvedFile(resolvedFile) {
  let current = dirname(resolvedFile)
  const root = parse(current).root
  while (current !== root) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      // Packages may contain nested manifests that only switch module type (the
      // MCP SDK has dist/cjs/package.json). A named manifest is the package root.
      if (typeof parsed.name === 'string' && parsed.name) return manifest
    }
    current = dirname(current)
  }
  throw new Error(`could not locate package.json above ${resolvedFile}`)
}

function dependencyManifestFrom(packageManifest, dependency) {
  let current = dirname(packageManifest)
  const root = parse(current).root
  while (current !== root) {
    const manifest = join(current, 'node_modules', dependency, 'package.json')
    if (existsSync(manifest)) return manifest
    current = dirname(current)
  }
  throw new Error(`${dependency} cannot be resolved from ${packageManifest}`)
}

/**
 * Resolve every required edge below a root specifier. `resolve()` alone proves the root
 * entry exists; walking each package's dependency table also catches a missing transitive
 * package without executing extension code or dependency install hooks.
 *
 * 🔴 The guarantee is not uniform with depth, and saying so is the point:
 *   depth 1  — real `require.resolve()`, so a broken `exports` map or a missing entry
 *              point fails here.
 *   depth >1 — the package directory is located the way Node would (walking up
 *              `node_modules`), but its entry point is NOT resolved. A transitive
 *              package that is present yet unrequirable — ESM-only, or an `exports`
 *              map with no `require` condition — still passes.
 * Resolving every edge for real was tried and rejected: it fails on ESM-only
 * transitive packages that the CJS code never actually requires, which would redden
 * the release for a non-problem. #875 (bundling with esbuild) removes the question
 * by walking the real import graph instead of dependency tables.
 */
function assertPackageDependencyGraphResolves(manifestPath, visited) {
  if (visited.has(manifestPath)) return
  visited.add(manifestPath)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencies = manifest.dependencies
  if (dependencies === undefined) return
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error(`${manifestPath}: dependencies is not a JSON object`)
  }

  for (const dependency of Object.keys(dependencies)) {
    const childManifest = dependencyManifestFrom(manifestPath, dependency)
    assertPackageDependencyGraphResolves(childManifest, visited)
  }
}

function assertDependencyGraphResolves(resolvedFile, visited) {
  assertPackageDependencyGraphResolves(packageManifestForResolvedFile(resolvedFile), visited)
}

/**
 * Return declared top-level directories that are absent and specifiers whose complete
 * required dependency graph cannot be resolved from the unpacked .vsix.
 * This function reports data only; it never logs, writes, or exits.
 */
export function findMissingBundledDeps(vsixRoot, spec) {
  const packageJsonPath = isAbsolute(spec.packageJsonPath)
    ? spec.packageJsonPath
    : join(REPO_ROOT, spec.packageJsonPath)
  const dependencyNames = declaredDependencyNames(packageJsonPath)
  const nodeModulesRoot = join(vsixRoot, spec.nodeModulesPath)
  const missingDependencies = dependencyNames.filter(
    (name) => !existsSync(join(nodeModulesRoot, name)),
  )

  const resolveSpecifiers =
    spec.resolveSpecifiers === 'declared-dependencies'
      ? dependencyNames
      : [...spec.resolveSpecifiers]
  const requireFromRuntimeFile = createRequire(join(vsixRoot, spec.resolveFromPath))
  const unresolvedSpecifiers = []

  for (const specifier of resolveSpecifiers) {
    try {
      const resolvedFile = requireFromRuntimeFile.resolve(specifier)
      assertDependencyGraphResolves(resolvedFile, new Set())
    } catch (error) {
      // Keep the inner reason. A failure several edges down names a transitive
      // package the caller has never heard of, and without it the CI log would
      // only say the top-level specifier failed — leaving the next incident to
      // be diagnosed by local reproduction instead of by reading the log.
      unresolvedSpecifiers.push({ specifier, reason: error.message })
    }
  }

  return { missingDependencies, unresolvedSpecifiers }
}

function main() {
  const vsixRoot = process.argv[2]
  if (!vsixRoot) {
    console.error('::error::Usage: node scripts/check-vsix-bundled-deps.mjs <unpacked-vsix-root>')
    process.exitCode = 1
    return
  }

  let failed = false
  for (const spec of bundleSpecs()) {
    try {
      const dependencyNames = declaredDependencyNames(join(REPO_ROOT, spec.packageJsonPath))
      const result = findMissingBundledDeps(vsixRoot, spec)
      for (const dependency of result.missingDependencies) {
        failed = true
        console.error(
          `::error::${spec.label} runtime dependency '${dependency}' missing from packaged .vsix at ${spec.nodeModulesPath}`,
        )
      }
      for (const { specifier, reason } of result.unresolvedSpecifiers) {
        failed = true
        console.error(
          `::error::${spec.label} runtime specifier '${specifier}' cannot be resolved from ${spec.resolveFromPath} in the packaged .vsix — ${reason}`,
        )
      }
      if (result.missingDependencies.length === 0 && result.unresolvedSpecifiers.length === 0) {
        const resolvedCount =
          spec.resolveSpecifiers === 'declared-dependencies'
            ? dependencyNames.length
            : spec.resolveSpecifiers.length
        console.log(
          `${spec.label} bundled dependencies OK: ${dependencyNames.length} declared, ${resolvedCount} runtime specifiers resolved`,
        )
      }
    } catch (error) {
      failed = true
      console.error(`::error::${spec.label} dependency gate failed: ${error.message}`)
    }
  }

  if (failed) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
