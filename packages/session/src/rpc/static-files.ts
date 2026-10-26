/**
 * TCP のリスナーで WebView の bundle を `/app/` から配る（設計 848 §7.3・§4.7）。
 *
 * - トークンは要らない（秘密を含まない UI の bundle）。Host 許可リストは掛ける
 * - `Content-Security-Policy: frame-ancestors 'none'`（他のページの iframe に載せない）
 * - `--web-dir` の外のファイルは返さない（`..`・シンボリックリンクで外へ出ない）
 */
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

import { allowedHosts, requestPath } from './http-guard'

export const APP_PREFIX = '/app/'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

function reply(response: http.ServerResponse, status: number, text: string): true {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(`${text}\n`)
  return true
}

/** `/app/**` を `webDir` から返す。`/app/` でなければ false（呼び出し側が 404 にする）。 */
export function serveApp(
  webDir: string | undefined,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number,
): boolean {
  const urlPath = requestPath(request.url)
  if (urlPath !== '/app' && !urlPath.startsWith(APP_PREFIX)) return false
  if (!request.headers.host || !allowedHosts(port).includes(request.headers.host)) {
    return reply(response, 403, 'host not allowed')
  }
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return reply(response, 405, 'method not allowed')
  if (!webDir) return reply(response, 404, 'no web bundle (--web-dir is not set)')
  if (urlPath === '/app') {
    response.writeHead(301, { Location: APP_PREFIX })
    response.end()
    return true
  }
  let relative: string
  try {
    relative = decodeURIComponent(urlPath.slice(APP_PREFIX.length)) || 'index.html'
  } catch {
    return reply(response, 400, 'bad path')
  }
  const root = fs.realpathSync(webDir)
  let file: string
  try {
    file = fs.realpathSync(path.resolve(root, relative))
  } catch {
    return reply(response, 404, 'not found')
  }
  if (file !== root && !file.startsWith(root + path.sep)) return reply(response, 404, 'not found')
  if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!fs.existsSync(file)) return reply(response, 404, 'not found')
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  })
  if (request.method === 'HEAD') response.end()
  else fs.createReadStream(file).pipe(response)
  return true
}
