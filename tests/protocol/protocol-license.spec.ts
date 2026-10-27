/**
 * `protocol/` の定義は Apache-2.0（owner 裁定 2026-10-26 第 2 回の項目 7・設計 848 §5.8・一方通行 N-14）。
 *
 * 定義が公開されて使われ始めた後にライセンスを変えると使った人に影響するので、スキーマを置く PR と
 * 同じ PR で入れ、全文が書き換わらないことをここで固定する。リポジトリのルートのライセンス
 * （Signal compose Source-Available License v1.0）はそれ以外にかかったまま。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const protocolDir = path.resolve(__dirname, '../../protocol')

describe('protocol/ is licensed under Apache-2.0', () => {
  it('protocol/LICENSE is the full Apache License 2.0 text, unmodified', () => {
    const text = fs.readFileSync(path.join(protocolDir, 'LICENSE'))
    // https://www.apache.org/licenses/LICENSE-2.0.txt（2026-10-26 取得）の sha256
    expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(
      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    )
  })

  it('the protocol package declares Apache-2.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(protocolDir, 'package.json'), 'utf8'))
    expect(pkg.license).toBe('Apache-2.0')
  })

  it('the generated files carry the license line', () => {
    const generated = fs.readFileSync(
      path.join(protocolDir, 'gen/ts/session/v1/session.d.ts'),
      'utf8',
    )
    expect(generated).toContain(
      'Licensed under the Apache License, Version 2.0 (protocol/LICENSE).',
    )
  })
})
