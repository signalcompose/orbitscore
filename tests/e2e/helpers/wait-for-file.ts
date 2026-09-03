/**
 * 生成物（`.orbslog` / stem / states）の実在を待つ（#668 設計 §4.3）。`waitUntil`
 * （mcp-client.ts）の薄い包み。
 *
 * `minBytes` が要る理由: 生成物は「作成」と「書き込み」が別イベントなので、存在だけを
 * 見ると 0 バイトを掴む（#694 E2E-S1 / #598 E2E-R1 が両方この位置を踏む）。
 */
import * as fs from 'fs'
import * as path from 'path'

import { waitUntil } from './mcp-client'

/** 絶対パスのファイルが実在する（かつ `minBytes` 以上ある）ことを待つ。 */
export async function waitForFile(
  absPath: string,
  opts?: { timeoutMs?: number; intervalMs?: number; minBytes?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const intervalMs = opts?.intervalMs ?? 200
  const minBytes = opts?.minBytes ?? 0
  await waitUntil(
    () => {
      if (!fs.existsSync(absPath)) return false
      if (minBytes <= 0) return true
      return fs.statSync(absPath).size >= minBytes
    },
    { intervalMs, timeoutMs, label: `file to appear: ${absPath}` },
  )
}

/**
 * ディレクトリ内で `pattern` に一致する最初のファイル（`<name>.<stamp>.orbslog` のように
 * 名前が可変な生成物の待ち合わせに使う）。見つかった絶対パスを返す。
 */
export async function waitForMatchingFile(
  dir: string,
  pattern: RegExp,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const intervalMs = opts?.intervalMs ?? 200
  let found: string | undefined
  await waitUntil(
    () => {
      if (!fs.existsSync(dir)) return false
      const match = fs.readdirSync(dir).find((name) => pattern.test(name))
      if (match === undefined) return false
      found = path.join(dir, match)
      return true
    },
    { intervalMs, timeoutMs, label: `file matching ${pattern} in ${dir}` },
  )
  // waitUntil either resolves with `found` set (the predicate returned true only
  // after assigning it), or throws past this line.
  if (found === undefined) throw new Error(`file matching ${pattern} not found in ${dir}`)
  return found
}
