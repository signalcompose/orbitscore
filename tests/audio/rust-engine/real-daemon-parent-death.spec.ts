/**
 * engine を SIGKILL した後に daemon が残らないことを、実 engine のコード（`DaemonClient`）と
 * 実 daemon で、PID により確かめる（#996・設計 848 §4.4 F-1・台帳 P-05）。
 *
 * daemon 単体の振る舞い（stdin の EOF / 親 PID / 古い engine の起動の形では終わらない）は
 * `rust/crates/orbit-audio-daemon/tests/parent_watch.rs` が CI で見る。ここが見るのは
 * **engine 側の配線**: engine の spawn が stdin をパイプで渡し、生きている間は閉じず、引数で
 * 監視を有効にしていること。
 *
 * `ORBIT_REAL_DAEMON=1` のときだけ走る（`real-daemon-recovery.spec.ts` と同じ gate。実プロセスの
 * kill を伴うため既定 skip）。事前に `cd rust && cargo build -p orbit-audio-daemon --release` 済みで
 * あること。Linux（音声デバイスの無い cloud / CI）では、ALSA の既定 PCM を null に向けた HOME で
 * 起動する（Rust 側の `parent_watch.rs` と同じ）。
 */

import { ChildProcess, execFileSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createInterface } from 'readline'

import { afterEach, describe, expect, it, vi } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../')
const DAEMON_BIN = path.join(REPO_ROOT, 'rust/target/release/orbit-audio-daemon')
const STAND_IN = path.join(__dirname, 'engine-stand-in.ts')
const RUN = process.env.ORBIT_REAL_DAEMON === '1'

/** daemon の PID 監視は 250ms 周期・stdin の EOF は即時。十分な余裕を持たせる。 */
const DAEMON_EXIT_TIMEOUT_MS = 5_000

/**
 * pid のプロセスがまだ動いているか。孤児の daemon は init / subreaper に引き取られ、刈り取られる
 * までゾンビとして残りうる（`process.kill(pid, 0)` はゾンビにも成功する）ので、状態まで見る。
 */
function isRunning(pid: number): boolean {
  let stat = ''
  try {
    stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    // ps は該当プロセスが無いと非ゼロで終わる
  }
  return stat !== '' && !stat.startsWith('Z')
}

function nullAudioEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {}
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-engine-stand-in-'))
  fs.writeFileSync(path.join(home, '.asoundrc'), 'pcm.!default { type null }\n')
  return { HOME: home }
}

function readDaemonPid(engine: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: engine.stdout! })
    const to = setTimeout(
      () => reject(new Error('engine stand-in did not report the daemon pid')),
      30_000,
    )
    lines.on('line', (line) => {
      if (!line.startsWith('{"daemonPid":')) return
      clearTimeout(to)
      resolve((JSON.parse(line) as { daemonPid: number }).daemonPid)
    })
    engine.once('exit', (code) => {
      clearTimeout(to)
      reject(new Error(`engine stand-in exited before reporting the daemon pid (code=${code})`))
    })
  })
}

describe.runIf(RUN)('engine の SIGKILL の後に daemon が残らない (#996)', () => {
  let engine: ChildProcess | null = null
  let daemonPid: number | null = null

  afterEach(() => {
    // 失敗時に実プロセスを残さない（daemon が残ると次のテストが音声デバイスを奪い合う・#624）。
    for (const pid of [engine?.pid, daemonPid]) {
      if (pid === undefined || pid === null) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 既に居ない
      }
    }
    engine = null
    daemonPid = null
  })

  it('engine（DaemonClient を持つ Node プロセス）を SIGKILL すると daemon も自分で終わる', async () => {
    expect(fs.existsSync(DAEMON_BIN), `${DAEMON_BIN} を先に build する`).toBe(true)
    const proc = spawn(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', STAND_IN, DAEMON_BIN],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...nullAudioEnv(),
          TS_NODE_PROJECT: path.join(REPO_ROOT, 'packages/engine/tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    engine = proc
    const pid = await readDaemonPid(proc)
    daemonPid = pid

    // engine が生きている間は daemon も生きている（= engine が stdin を開けたまま保っている）。
    await new Promise((r) => setTimeout(r, 1_000))
    expect(isRunning(pid)).toBe(true)

    const exited = new Promise((r) => proc.once('exit', r))
    proc.kill('SIGKILL')
    await exited
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), {
      timeout: DAEMON_EXIT_TIMEOUT_MS,
      interval: 50,
    })
  }, 60_000)
})
