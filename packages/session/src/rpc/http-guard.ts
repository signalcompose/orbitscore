/**
 * TCP の `/rpc`（アプリの WebView だけが使う）の Host と Origin の検査・トークンの比較（設計 848 §4.7）。
 *
 * 拒否は upgrade の段で 403（Host・Origin）か、attach の段で close 1008（トークン）。🔴 TCP では
 * **Origin が無い接続も拒否する**（非ブラウザのクライアントは UDS へ移った）。`Origin: null` は
 * `file://`・sandbox 付き iframe・`data:` が送る値で、正規のクライアントと区別できないので拒否する。
 * Origin の検査だけに頼らない（MCP Inspector GHSA-vcc9-3xgm-p9v4）— トークンも必須のまま。
 */
import crypto from 'node:crypto'

export const RPC_PATH = '/rpc'

export type UpgradeVerdict = { ok: true } | { ok: false; status: 403 | 404; reason: string }

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
}

/** v1 で許す Origin は `/app/` の配信元だけ（設計 §7.3）。 */
export function allowedOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function requestPath(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').pathname
}

export function checkTcpUpgrade(input: {
  url: string | undefined
  host: string | undefined
  origin: string | undefined
  port: number
}): UpgradeVerdict {
  if (requestPath(input.url) !== RPC_PATH)
    return { ok: false, status: 404, reason: 'no such endpoint' }
  if (!input.host || !allowedHosts(input.port).includes(input.host)) {
    return { ok: false, status: 403, reason: 'host not allowed' }
  }
  if (input.origin === undefined) return { ok: false, status: 403, reason: 'origin missing' }
  if (input.origin === 'null') return { ok: false, status: 403, reason: 'origin null' }
  if (input.origin !== allowedOrigin(input.port)) {
    return { ok: false, status: 403, reason: 'origin not allowed' }
  }
  return { ok: true }
}

export function checkUdsUpgrade(url: string | undefined): UpgradeVerdict {
  return requestPath(url) === RPC_PATH
    ? { ok: true }
    : { ok: false, status: 404, reason: 'no such endpoint' }
}

/** 定数時間の比較（長さが違う時も早く返さない — 両方を同じ長さのハッシュにしてから比べる）。 */
export function tokensMatch(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false
  const a = crypto.createHash('sha256').update(expected).digest()
  const b = crypto.createHash('sha256').update(given).digest()
  return crypto.timingSafeEqual(a, b)
}

/** 起動ごとのトークン（暗号論的乱数・32 バイト）。 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}
