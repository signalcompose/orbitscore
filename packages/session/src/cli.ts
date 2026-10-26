/**
 * `packages/session` の入口（設計 848 §8）。
 *
 *   node dist/cli.js session …   層 2 のプロセス（`session-main.ts`）
 *
 * 中継（`relay`）は束 S-mcp で足す。`packages/engine` の CLI（`cli-audio.js`）に `session` を足さないのは、
 * 凍結版の拡張がそのファイルを同梱・実行していて、足すと凍結版のビルド成果物が変わるため（§4.5）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { defaultSessionIo, startSession } from './session-main'

const SESSION_VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string
  }
).version

const USAGE = 'usage: cli.js session [--runtime-dir <dir>] [--port <N|0>] [--token-file <path>] …\n'

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'session') {
    const started = await startSession(rest, defaultSessionIo(SESSION_VERSION))
    if (!started.ok) return started.exitCode
    return started.session.exited
  }
  process.stderr.write(USAGE)
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(
      `${JSON.stringify({ ready: false, error: { code: 'UNEXPECTED', message: String(error?.message ?? error) } })}\n`,
    )
    process.exit(1)
  },
)
