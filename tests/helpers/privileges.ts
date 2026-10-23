import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TestContext } from 'vitest'

/**
 * 実効 UID や capability によっては `chmod 0o000` のファイルを読めてしまうため、
 * 「読めないファイル」を前提にしたテストはその環境では成立しない（#684・設計 668 §13）。
 *
 * `it.skipIf` ではなく `context.skip(条件, 理由)` にしているのは、skip の**理由が
 * レポーターに出る**ようにするため（#684 の受け入れ基準）。
 *
 * 🔴 呼び出し箇所は `tests/repo/privileges-skip-ratchet.spec.ts` がラチェットしている。
 * root で未検証のテストが黙って増えないように。
 */
function chmod000StaysReadable(): boolean {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitscore-dac-probe-'))
  const file = path.join(directory, 'unreadable')
  try {
    fs.writeFileSync(file, 'probe')
    fs.chmodSync(file, 0o000)
    try {
      fs.readFileSync(file)
      return true
    } catch {
      return false
    }
  } finally {
    // Restore permissions so cleanup works for both privileged and unprivileged callers.
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // The probe may have failed before the file was created.
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const DAC_IS_BYPASSED = chmod000StaysReadable()
const SKIP_AS_ROOT_REASON = 'root bypasses DAC: chmod 0o000 stays readable (#684)'

export function skipWhenDacIsBypassed(context: Pick<TestContext, 'skip'>): void {
  context.skip(DAC_IS_BYPASSED, SKIP_AS_ROOT_REASON)
}
