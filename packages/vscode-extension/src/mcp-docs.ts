import * as fs from 'fs'
import * as path from 'path'

import type { DevDocSearchMatch } from './mcp-types'

/**
 * Public URL prefix the built dev site is served under. Must equal SITE_BASE in
 * sites/dev/.vitepress/config.ts (minus the trailing slash): the dist's asset and
 * navigation URLs are absolute under that base, so serving at any other prefix
 * breaks every asset request.
 */
export const DOCS_PUBLIC_BASE = '/orbitscore/dev'

/**
 * Public URL prefix for the END-USER learning site (sites/user — VitePress base
 * `/orbitscore/`). The dev base above lives INSIDE this prefix, so routing must
 * check the dev prefix first (longest-prefix wins); asset URLs never collide
 * (`/orbitscore/assets/...` vs `/orbitscore/dev/assets/...`).
 */
export const USER_DOCS_PUBLIC_BASE = '/orbitscore'

/** Resolve the built VitePress site from a repository/workspace base directory. */
export function resolveDocsRoot(baseDir: string): string {
  return path.resolve(baseDir, 'sites/dev/.vitepress/dist')
}

/** Resolve the built end-user site from a repository/workspace base directory. */
export function resolveUserDocsRoot(baseDir: string): string {
  return path.resolve(baseDir, 'sites/user/.vitepress/dist')
}

/**
 * Resolve a docs-relative URL path without allowing it to escape docsRoot.
 * Directory URLs (including the root URL) serve their index.html.
 */
export function resolveDocsFilePath(docsRoot: string, urlPath: string): string | null {
  return resolveSafePath(docsRoot, urlPath, (decodedPath, relativePath) =>
    decodedPath.endsWith('/') || !path.extname(relativePath)
      ? path.join(relativePath, 'index.html')
      : relativePath,
  )
}

/**
 * Shared traversal guard for every docs path lookup: decode → reject `..`/`\` →
 * resolve against root → containment check. This is the security boundary for the
 * locally-bound HTTP server and the MCP doc tools — keep it single-sourced so a
 * future tightening applies everywhere at once. `mapTarget` lets callers layer
 * their own URL→file mapping (e.g. directory → index.html) on the decoded path
 * before resolution; the containment check always runs on the mapped result.
 */
function resolveSafePath(
  root: string,
  rawPath: string,
  mapTarget: (decodedPath: string, relativePath: string) => string = (_, relativePath) =>
    relativePath,
): string | null {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (decodedPath.includes('\\') || decodedPath.includes('..')) {
    return null
  }
  const relativePath = decodedPath.replace(/^\/+/, '')
  const filePath = path.resolve(root, mapTarget(decodedPath, relativePath))
  const normalizedRoot = path.resolve(root)
  if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null
  }
  return filePath
}

function resolvePathWithinRoot(root: string, relativePath: string): string | null {
  if (!relativePath) return null
  const filePath = resolveSafePath(root, relativePath)
  // The bare root is a valid *directory* answer for the docs file server (mapped to
  // index.html) but never a valid document path for readDevDoc/searchDevDocs.
  return filePath !== null && filePath !== path.resolve(root) ? filePath : null
}

export function readDevDoc(sourceRoot: string, relativePath: string): string | null {
  const filePath = resolvePathWithinRoot(sourceRoot, relativePath)
  if (!filePath || path.extname(filePath) !== '.md' || !fs.existsSync(filePath)) {
    return null
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    // TOCTOU: the file could vanish (docs rebuild) between existsSync and read.
    return null
  }
}

export function searchDevDocs(sourceRoot: string, query: string, limit = 10): DevDocSearchMatch[] {
  if (!query) return []
  const matches: DevDocSearchMatch[] = []
  const needle = query.toLowerCase()
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.vitepress' || entry.name === 'node_modules') continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
      } else if (entry.isFile() && path.extname(entry.name) === '.md') {
        let lines: string[]
        try {
          lines = fs.readFileSync(entryPath, 'utf8').split(/\r?\n/)
        } catch {
          // Skip a file that becomes unreadable mid-walk rather than aborting the search.
          continue
        }
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push({
              path: path.relative(sourceRoot, entryPath).split(path.sep).join('/'),
              line: index + 1,
              excerpt: lines[index].trim(),
            })
          }
        }
      }
      if (matches.length >= limit) return
    }
  }
  if (fs.existsSync(sourceRoot)) walk(sourceRoot)
  return matches
}

export function contentTypeForDocsFile(filePath: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  }
  return types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** 配信対象サイト（dev / user）のルーティング候補。 */
interface DocsSite {
  base: string
  root: string
  buildHint: string
}

/** pathname が候補のどのサイトに属すか（配列順 = 優先順・最長プレフィックスを先に置く）。 */
export function matchDocsRequest(pathname: string, sites: DocsSite[]): DocsSite | null {
  for (const site of sites) {
    if (pathname === site.base || pathname.startsWith(`${site.base}/`)) return site
  }
  return null
}

/**
 * dist が「存在するが base 不一致の stale ビルド」でないか検査する（#480）。
 * VitePress は SITE_BASE をアセット URL に焼き込むため、base 変更前の古い dist を
 * 配信すると全アセットが 404 になり素 HTML が出る（実害 2026-07-17）。index.html に
 * `base + '/assets/'` への参照が含まれることを鮮度の代理指標とし、不一致なら
 * 未ビルト時と同じ actionable メッセージ（rebuild 手順）に落とす。結果は
 * index.html の mtime でキャッシュ（リクエスト毎の同期 read を避ける）。
 */
export function isDocsDistStale(root: string, base: string): boolean {
  const indexPath = path.join(root, 'index.html')
  try {
    const mtime = fs.statSync(indexPath).mtimeMs
    const cached = staleCheckCache.get(indexPath)
    if (cached && cached.mtime === mtime) return cached.stale
    const html = fs.readFileSync(indexPath, 'utf8')
    const stale = !html.includes(`${base}/assets/`)
    staleCheckCache.set(indexPath, { mtime, stale })
    return stale
  } catch {
    // index.html が読めない = 未ビルト相当。呼び出し側の existsSync ガードに任せる。
    return false
  }
}
const staleCheckCache = new Map<string, { mtime: number; stale: boolean }>()
