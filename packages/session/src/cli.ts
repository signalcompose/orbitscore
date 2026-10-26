/**
 * `packages/session` の入口（設計 848 §8）。
 *
 *   node dist/cli.js session …   層 2 のプロセス（`session-main.ts`）
 *   node dist/cli.js relay …     中継 = stdio の MCP サーバ（`relay/relay-main.ts`・§6）
 *
 * `packages/engine` の CLI（`cli-audio.js`）に `session` を足さないのは、
 * 凍結版の拡張がそのファイルを同梱・実行していて、足すと凍結版のビルド成果物が変わるため（§4.5）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { startRelay } from './relay/relay-main'
import { defaultSessionIo, startSession } from './session-main'

const SESSION_VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string
  }
).version

const USAGE =
  'usage: cli.js session [--runtime-dir <dir>] [--port <N|0>] [--token-file <path>] …\n' +
  '       cli.js relay [--runtime-dir <dir>]\n'

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'session') {
    const started = await startSession(rest, defaultSessionIo(SESSION_VERSION))
    if (!started.ok) return started.exitCode
    return started.session.exited
  }
  if (command === 'relay') {
    // RL-1: 上流の失敗で終了しない。取りこぼした失敗も stderr に書いて生き続ける。
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[relay] unhandled rejection: ${String(reason)}\n`)
    })
    const started = await startRelay(
      rest,
      {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        onSignal: (signal, handler) => process.on(signal, handler),
      },
      SESSION_VERSION,
    )
    if (!started.ok) return started.exitCode
    return started.relay.exited
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
