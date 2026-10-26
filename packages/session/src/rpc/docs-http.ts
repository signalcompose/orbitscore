/**
 * TCP のリスナーで docs を配る: `GET /orbitscore/**`（user）・`/orbitscore/dev/**`（dev）・
 * `/docs`（302 → `/orbitscore/dev/`）。凍結版 `mcp-server.ts` の `handleHttp` と同じ経路・同じ応答
 * （設計 848 §5.3 の HTTP 行 L5）。
 *
 * - トークンは要らない（中身は GitHub Pages と同じ公開物）。Host 許可リストは掛ける（§4.7）
 * - 在りかは `--docs-dir`（`host/docs-sites.ts`）。凍結版の `__dirname` 決め打ちを置き換えた
 * - 応答に CSP を付ける（§4.7 の docs の判断の条件 (3)）
 */
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

import type { DocsSites } from '../host/docs-sites'
import {
  contentTypeForDocsFile,
  DEV_DOCS_UNAVAILABLE_MESSAGE,
  DOCS_PUBLIC_BASE,
  isDocsDistStale,
  matchDocsRequest,
  resolveDocsFilePath,
  USER_DOCS_PUBLIC_BASE,
} from '../mcp/mcp-docs'

import { allowedHosts, requestPath } from './http-guard'

/**
 * 他のページの iframe に載せず、プラグインや `<base>` の差し替えを許さない。
 */
// PROVISIONAL(P-21): スクリプトを絞る指定（VitePress のインラインスクリプトの hash）は N2 で決める。
export const DOCS_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"

const NOT_BUILT_HINT = {
  dev: 'Development docs are not built. Run npm run docs:build -w @orbitscore/dev-site',
  user: 'User docs are not built. Run npm run docs:build -w @orbitscore/user-site',
} as const

function text(response: http.ServerResponse, status: number, body: string, extra = {}): true {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra })
  response.end(body)
  return true
}

/** docs の経路なら応答して true。そうでなければ false（呼び出し側が次の経路へ回す）。 */
export function serveDocs(
  docs: DocsSites,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number,
  log: (level: 'error' | 'warn' | 'info', text: string) => void,
): boolean {
  const pathname = requestPath(request.url)
  const isAlias = pathname === '/docs' || pathname === '/docs/'
  // dev が無い（`.app`）時も、経路は dev のもの — 凍結版の cold install と同じく 503 + 案内を返す。
  const site = matchDocsRequest(pathname, [
    {
      base: DOCS_PUBLIC_BASE,
      root: docs.dev?.distRoot ?? '',
      buildHint: docs.dev ? NOT_BUILT_HINT.dev : DEV_DOCS_UNAVAILABLE_MESSAGE,
    },
    {
      base: USER_DOCS_PUBLIC_BASE,
      root: docs.user?.distRoot ?? '',
      buildHint: NOT_BUILT_HINT.user,
    },
  ])
  if (!isAlias && !site) return false
  if (!request.headers.host || !allowedHosts(port).includes(request.headers.host)) {
    log('warn', `docs request rejected — invalid Host header: ${request.headers.host ?? '(none)'}`)
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'forbidden: invalid Host header' }))
    return true
  }
  if (isAlias) {
    response.writeHead(302, { Location: `${DOCS_PUBLIC_BASE}/` })
    response.end()
    return true
  }
  const match = site!
  if (request.method !== 'GET') return text(response, 405, 'Method Not Allowed', { Allow: 'GET' })
  if (!match.root || !fs.existsSync(match.root)) {
    log('warn', `docs not built — root missing: ${match.root || '(no --docs-dir for this site)'}`)
    return text(response, 503, match.buildHint)
  }
  if (isDocsDistStale(match.root, match.base)) {
    log('warn', `docs dist is stale (base mismatch) — ${match.root}`)
    return text(
      response,
      503,
      `Docs build is stale (built with a different base path). ${match.buildHint}`,
    )
  }
  const filePath = resolveDocsFilePath(match.root, pathname.slice(match.base.length))
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    log('info', `docs file not found for pathname: ${pathname}`)
    return text(response, 404, 'Not Found')
  }
  const contentType = contentTypeForDocsFile(filePath)
  if (contentType === 'application/octet-stream') {
    log(
      'info',
      `docs file served with fallback content-type (unknown extension ${path.extname(filePath)}): ${filePath}`,
    )
  }
  response.writeHead(200, { 'content-type': contentType, 'Content-Security-Policy': DOCS_CSP })
  const stream = fs.createReadStream(filePath)
  stream.on('error', (error) => {
    log('error', `docs file stream error for ${filePath}: ${error}`)
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    }
    response.end('Internal Server Error')
  })
  stream.pipe(response)
  return true
}
