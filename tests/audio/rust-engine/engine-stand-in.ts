/**
 * engine の代役（`real-daemon-parent-death.spec.ts` 専用・#996）。
 *
 * 実 engine と同じ `DaemonClient` で daemon を起動し、daemon の PID を stdout に JSON 1 行
 * （`{"daemonPid":N}`）で出して、殺されるまで何もしない。daemon の stderr の転送行
 * （`[daemon] ...`）も同じ stdout に出るので、テストは JSON の行だけを拾う。テストはこの
 * プロセスを SIGKILL し、daemon が残らないことを PID で見る。
 *
 * 使い方: `node -r ts-node/register/transpile-only engine-stand-in.ts <daemon binary>`
 */
import { DaemonClient } from '../../../packages/engine/src/audio/rust-engine/daemon-client'

async function main(): Promise<void> {
  const client = new DaemonClient()
  await client.start({ daemonPath: process.argv[2] })
  process.stdout.write(`${JSON.stringify({ daemonPid: client.childPid })}\n`)
  setInterval(() => {}, 1 << 30)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
